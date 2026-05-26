// ============================================================
// line/line-segment-attributes.ts — 每段 8 顶点 box + 5 vec4 描述符打包
// 层级：L4（贴地线几何子模块）。
// 职责：把 doc 03 的 `DensifiedLine` 拆成「每段 8 顶点 + 36 索引」box，
//        并打包 5 个 Float32 vec4（startHi/Lo/startNormal + endNormal + rightNormal
//        + texcoord 归一化）。这是 doc 04 的全部产物。
// 依赖：Three.js Vector3、math/rte-encoding.ts、line/line-types.ts、constants.ts、
//        line/line-geometry-normals.ts（breakMiter）。
// 被消费：line-shadow-volume.ts facade、单测。
// 算法对应：Cesium `GroundPolylineGeometry.generateGeometryAttributes`。
// ============================================================

import { Vector3 } from 'three';

import {
	LINE_NORMAL_NUDGE,
	LINE_NUDGE_XZ,
	WALL_INITIAL_MAX_HEIGHT,
	WALL_INITIAL_MIN_HEIGHT,
} from '../constants';
import { encodeScalarRTE } from '../math/rte-encoding';
import {
	getTerrainMinMaxHeightsForRectangle,
	isApproximateTerrainHeightsReady,
} from '../terrain-heights';

import { breakMiter } from './line-geometry-normals';
import type { DensifiedLine, SegmentBoxAttributes } from './line-types';

/**
 * 每段 8 顶点 + 36 索引。绕序与 doc 04 §2 的位置顺序绑定，反绕，
 * 配合 BackSide 的材质（doc 07 §1）画背面。
 */
const REFERENCE_INDICES: readonly number[] = [
	0, 2, 1,   0, 3, 2,   // right
	0, 7, 3,   0, 4, 7,   // start
	0, 5, 4,   0, 1, 5,   // bottom
	5, 7, 4,   5, 6, 7,   // left
	5, 2, 6,   5, 1, 2,   // end
	3, 6, 2,   3, 7, 6,   // top
];

// 模块级 scratch。所有计算都在 Float64（Vector3 内部是 number）里做，
// 仅最终 RTE 拆分 + 装配时才进 Float32 数组。
const _startBottom = new Vector3();
const _startTop = new Vector3();
const _endBottom = new Vector3();
const _endTop = new Vector3();
const _forwardOffset = new Vector3();
const _forward = new Vector3();
const _startUp = new Vector3();
const _rightNormal = new Vector3();
const _startGeometryNormal = new Vector3();
const _endGeometryNormal = new Vector3();
const _startPlaneNormal = new Vector3();
const _endUp = new Vector3();
const _endPlaneNormal = new Vector3();
const _adjustStartBottom = new Vector3();
const _adjustStartTop = new Vector3();
const _adjustEndBottom = new Vector3();
const _adjustEndTop = new Vector3();
const _normalNudge = new Vector3();
const _nudgeOffset = new Vector3();
const _scratchNormalSlot = new Vector3();

/**
 * 把扁平数组的某点位置读入 Vector3。
 */
function readVec3( source: number[], pointIndex: number, out: Vector3 ): Vector3 {
	const base = pointIndex * 3;
	out.set( source[ base ], source[ base + 1 ], source[ base + 2 ] );
	return out;
}

/**
 * `adjustHeights`：把标准墙 [WALL_INITIAL_MIN_HEIGHT=0, WALL_INITIAL_MAX_HEIGHT=1000]
 * 推到用户请求的 [minHeight, maxHeight]。沿「标准墙竖直方向 n = normalize(top - bottom)」
 * 平移，逐字对应 Cesium。
 *
 * @param bottom     原 bottom（不修改）。
 * @param top        原 top（不修改）。
 * @param minHeight  目标下沿高度。
 * @param maxHeight  目标上沿高度。
 * @param outBottom  接收推到目标的 bottom。
 * @param outTop     接收推到目标的 top。
 */
function adjustHeights(
	bottom: Vector3,
	top: Vector3,
	minHeight: number,
	maxHeight: number,
	outBottom: Vector3,
	outTop: Vector3,
): void {
	_scratchNormalSlot.copy( top ).sub( bottom ).normalize();
	outBottom.copy( bottom ).addScaledVector(
		_scratchNormalSlot,
		minHeight - WALL_INITIAL_MIN_HEIGHT,
	);
	outTop.copy( top ).addScaledVector(
		_scratchNormalSlot,
		maxHeight - WALL_INITIAL_MAX_HEIGHT,
	);
}

/**
 * 若 ECEF 顶点恰落在 XZ 平面（y ≈ 0）附近，沿线方向微推 LINE_NUDGE_XZ。
 *
 * @param start 段起点（可被修改）。
 * @param end   段终点（可被修改）。
 */
function nudgeXZ( start: Vector3, end: Vector3 ): void {
	const dS = start.y;
	const dE = end.y;
	if ( Math.abs( dS ) <= LINE_NUDGE_XZ ) {
		_nudgeOffset.subVectors( end, start ).normalize().multiplyScalar( LINE_NUDGE_XZ );
		start.add( _nudgeOffset );
	} else if ( Math.abs( dE ) <= LINE_NUDGE_XZ ) {
		_nudgeOffset.subVectors( start, end ).normalize().multiplyScalar( LINE_NUDGE_XZ );
		end.add( _nudgeOffset );
	}
}

/**
 * 把 4 个 ECEF 角点（startBottom / endBottom / endTop / startTop）写入到
 * `positions` 的连续 12 个 Float64 槽位（按 doc 04 §2 的顺序）。
 */
function packCornersToPositions(
	positions: Float64Array,
	offset: number,
	startBottom: Vector3,
	endBottom: Vector3,
	endTop: Vector3,
	startTop: Vector3,
): void {
	positions[ offset + 0 ] = startBottom.x;
	positions[ offset + 1 ] = startBottom.y;
	positions[ offset + 2 ] = startBottom.z;
	positions[ offset + 3 ] = endBottom.x;
	positions[ offset + 4 ] = endBottom.y;
	positions[ offset + 5 ] = endBottom.z;
	positions[ offset + 6 ] = endTop.x;
	positions[ offset + 7 ] = endTop.y;
	positions[ offset + 8 ] = endTop.z;
	positions[ offset + 9 ] = startTop.x;
	positions[ offset + 10 ] = startTop.y;
	positions[ offset + 11 ] = startTop.z;
}

/**
 * 把 vec3 的 xyz + 一个标量 w 写入 vec4 Float32Array 的 4 个连续槽位。
 */
function writeVec4(
	target: Float32Array,
	vec4Index: number,
	xyz: Vector3,
	w: number,
): void {
	target[ vec4Index + 0 ] = xyz.x;
	target[ vec4Index + 1 ] = xyz.y;
	target[ vec4Index + 2 ] = xyz.z;
	target[ vec4Index + 3 ] = w;
}

/**
 * 主装配函数：把密集线 + 法线打包成 8 顶点 box 几何属性。
 *
 * 高度窗口逐字对齐 Cesium `generateGeometryAttributes`：每段查
 * `ApproximateTerrainHeights.getMinimumMaximumHeights( segment 的 lat/lon
 * 外接矩形 )` 得 terrain-tight 的 minHeight / maxHeight，再传 `adjustHeights`。
 *
 * 这是替代 doc 04 §7 的固定 ±55km 方案的关键修复——固定 ±55km 会让 box 顶
 * 远在相机之上（altitude > camera altitude），在透视投影下变成 w<0 顶点，
 * 光栅器对 w<0 三角形按 near plane clipping，盒子的侧面被切碎，FS 不在
 * 那些被切掉的像素跑——线就出现「随相机缩放而闪烁的断线」。terrain-tight
 * 让 box 顶贴近实际地形（典型 100m～5km altitude），任何在地面之上的相机
 * 视角下整盒子都在视锥内，FS 在每像素完整运行，断线消失。
 *
 * @param wall          doc 03 buildWallArrays 的产出（含 cartographicsArray，
 *                      用于查 ApproximateTerrainHeights）。
 * @param minHeightHint 调用方建议的下限（米）。用作 `min(terrainMin, hint)`
 *                      的兜底，防止 terrain table 未初始化时 box 退化。
 * @param maxHeightHint 调用方建议的上限（米）。用作 `max(terrainMax, hint)`。
 * @returns             9 个 Buffer 数据，可直接装入 Three BufferGeometry。
 */
export function buildSegmentBoxAttributes(
	wall: DensifiedLine,
	minHeightHint: number,
	maxHeightHint: number,
): SegmentBoxAttributes {
	const pointCount = wall.pointCount;
	const segmentCount = pointCount - 1;

	if ( segmentCount <= 0 ) {
		throw new Error(
			'CesiumGroundPolyline: at least one segment (two points) is required.',
		);
	}

	// length3D：全线长度（米），= 所有段 top 端点距离之和。FS 虚线 / 渐变需要。
	let length3D = 0.0;
	for ( let i = 0; i < segmentCount; i++ ) {
		const baseA = i * 3;
		const baseB = ( i + 1 ) * 3;
		const dx = wall.topPositionsArray[ baseB + 0 ] - wall.topPositionsArray[ baseA + 0 ];
		const dy = wall.topPositionsArray[ baseB + 1 ] - wall.topPositionsArray[ baseA + 1 ];
		const dz = wall.topPositionsArray[ baseB + 2 ] - wall.topPositionsArray[ baseA + 2 ];
		length3D += Math.sqrt( dx * dx + dy * dy + dz * dz );
	}

	const vertexCount = segmentCount * 8;
	const indexCount = segmentCount * 36;

	const positions = new Float64Array( vertexCount * 3 );
	const startHiFwdX = new Float32Array( vertexCount * 4 );
	const startLoFwdY = new Float32Array( vertexCount * 4 );
	const startNormFwdZ = new Float32Array( vertexCount * 4 );
	const endNormTexX = new Float32Array( vertexCount * 4 );
	const rightNormTexY = new Float32Array( vertexCount * 4 );

	const useUint32 = vertexCount > 65535;
	const indices = useUint32
		? new Uint32Array( indexCount )
		: new Uint16Array( indexCount );

	// miterBroken 状态机初始化（doc 04 §3.1）。loop 首点预取反由 buildWallArrays
	// 在末尾把首点复制到尾时已让 normals[0] 与 normals[last] 等价，再加上 §3.1
	// 的 if (loop) breakMiter(normals[0], pre-end, start, top0) → negate 即可。
	readVec3( wall.normalsArray, 0, _endGeometryNormal );
	if ( wall.loop ) {
		readVec3( wall.bottomPositionsArray, pointCount - 2, _scratchNormalSlot );
		const startBottom0 = _adjustStartBottom;
		const startTop0 = _adjustStartTop;
		readVec3( wall.bottomPositionsArray, 0, startBottom0 );
		readVec3( wall.topPositionsArray, 0, startTop0 );
		if ( breakMiter( _endGeometryNormal, _scratchNormalSlot, startBottom0, startTop0 ) ) {
			_endGeometryNormal.negate();
		}
	}

	let miterBroken = false;
	let lengthSoFar3D = 0.0;

	for ( let i = 0; i < segmentCount; i++ ) {
		// 起点 = 上一轮终点（首次直接读 i）。
		readVec3( wall.bottomPositionsArray, i, _startBottom );
		readVec3( wall.topPositionsArray, i, _startTop );
		_startGeometryNormal.copy( _endGeometryNormal );
		if ( miterBroken ) {
			_startGeometryNormal.negate();
		}

		readVec3( wall.bottomPositionsArray, i + 1, _endBottom );
		readVec3( wall.topPositionsArray, i + 1, _endTop );
		readVec3( wall.normalsArray, i + 1, _endGeometryNormal );

		miterBroken = breakMiter(
			_endGeometryNormal, _startBottom, _endBottom, _endTop,
		);

		// 段几何描述
		const segmentLength3D = _endTop.distanceTo( _startTop );
		_forwardOffset.subVectors( _endBottom, _startBottom );
		_forward.copy( _forwardOffset ).normalize();
		_startUp.copy( _startTop ).sub( _startBottom ).normalize();
		_rightNormal.copy( _forward ).cross( _startUp ).normalize();

		_startPlaneNormal.copy( _startUp ).cross( _startGeometryNormal ).normalize();
		_endUp.copy( _endTop ).sub( _endBottom ).normalize();
		_endPlaneNormal.copy( _endGeometryNormal ).cross( _endUp ).normalize();

		const texNormX = length3D > 0.0 ? segmentLength3D / length3D : 1.0;
		const texNormY = length3D > 0.0 ? lengthSoFar3D / length3D : 0.0;

		// RTE 拆 startBottom（x/y/z 各拆 high/low）。
		const startHiX = encodeScalarRTE( _startBottom.x );
		const startHiY = encodeScalarRTE( _startBottom.y );
		const startHiZ = encodeScalarRTE( _startBottom.z );

		// ── 5 vec4 ×8 顶点 + 位置写入（j = 0..7）──
		const vec4WriteBase = i * 8 * 4;
		for ( let j = 0; j < 8; j++ ) {
			const rightPlaneSide = j < 4 ? 1.0 : - 1.0;
			const topBottomSide = ( j === 2 || j === 3 || j === 6 || j === 7 ) ? 1.0 : - 1.0;
			const vec4Index = vec4WriteBase + j * 4;

			// startHi / startLo / startNormal + forwardOffset xyz
			writeVec4(
				startHiFwdX, vec4Index,
				_scratchNormalSlot.set( startHiX.high, startHiY.high, startHiZ.high ),
				_forwardOffset.x,
			);
			writeVec4(
				startLoFwdY, vec4Index,
				_scratchNormalSlot.set( startHiX.low, startHiY.low, startHiZ.low ),
				_forwardOffset.y,
			);
			writeVec4(
				startNormFwdZ, vec4Index, _startPlaneNormal, _forwardOffset.z,
			);

			// endPlane + texNorm.x · rightPlaneSide
			writeVec4(
				endNormTexX, vec4Index, _endPlaneNormal,
				texNormX * rightPlaneSide,
			);

			// rightNormal + texNorm.y · topBottomSide（含 9.0 哨兵）
			let texcoordNormalization = texNormY * topBottomSide;
			if ( texcoordNormalization === 0.0 && topBottomSide < 0.0 ) {
				texcoordNormalization = 9.0;
			}
			writeVec4(
				rightNormTexY, vec4Index, _rightNormal, texcoordNormalization,
			);
		}

		// ── 位置：adjustHeights → +rightNormal·ε（右 4 角）→ -2·rightNormal·ε（左 4 角）──
		// 段外接矩形的 terrain min/max（与 Cesium 一致）。cartographicsArray 顺序
		// 是 [lat0, lon0, lat1, lon1, ...]，单位弧度。
		const lat0Rad = wall.cartographicsArray[ i * 2 + 0 ];
		const lon0Rad = wall.cartographicsArray[ i * 2 + 1 ];
		const lat1Rad = wall.cartographicsArray[ i * 2 + 2 ];
		const lon1Rad = wall.cartographicsArray[ i * 2 + 3 ];
		const RAD2DEG = 180.0 / Math.PI;
		const rect = {
			west: Math.min( lon0Rad, lon1Rad ) * RAD2DEG,
			east: Math.max( lon0Rad, lon1Rad ) * RAD2DEG,
			south: Math.min( lat0Rad, lat1Rad ) * RAD2DEG,
			north: Math.max( lat0Rad, lat1Rad ) * RAD2DEG,
		};
		// terrain-tight 窗口是关键修复：与 Cesium `GroundPolylineGeometry.
		// generateGeometryAttributes` 一致，每段查 ApproximateTerrainHeights：
		//   const minHeight = minMaxHeights.minimumTerrainHeight;
		//   const maxHeight = minMaxHeights.maximumTerrainHeight;
		// 仅当 table 未初始化时回退到调用方 hint（line-options 默认 ±1000m）。
		let minHeight: number;
		let maxHeight: number;
		if ( isApproximateTerrainHeightsReady() ) {
			const terrain = getTerrainMinMaxHeightsForRectangle( rect );
			minHeight = terrain.minimumTerrainHeight;
			maxHeight = terrain.maximumTerrainHeight;
		} else {
			minHeight = Number.isFinite( minHeightHint ) ? minHeightHint : - 1000.0;
			maxHeight = Number.isFinite( maxHeightHint ) ? maxHeightHint : 1000.0;
		}

		adjustHeights(
			_startBottom, _startTop, minHeight, maxHeight,
			_adjustStartBottom, _adjustStartTop,
		);
		adjustHeights(
			_endBottom, _endTop, minHeight, maxHeight,
			_adjustEndBottom, _adjustEndTop,
		);

		// 右侧 4 角：沿 +rightNormal · EPSILON5 微推
		_normalNudge.copy( _rightNormal ).multiplyScalar( LINE_NORMAL_NUDGE );
		_adjustStartBottom.add( _normalNudge );
		_adjustEndBottom.add( _normalNudge );
		_adjustStartTop.add( _normalNudge );
		_adjustEndTop.add( _normalNudge );
		nudgeXZ( _adjustStartBottom, _adjustEndBottom );
		nudgeXZ( _adjustStartTop, _adjustEndTop );

		const posBase = i * 8 * 3;
		packCornersToPositions(
			positions, posBase,
			_adjustStartBottom, _adjustEndBottom, _adjustEndTop, _adjustStartTop,
		);

		// 左侧 4 角：再沿 -2·rightNormal · EPSILON5（净 -EPSILON5）
		_normalNudge.copy( _rightNormal ).multiplyScalar( - 2.0 * LINE_NORMAL_NUDGE );
		_adjustStartBottom.add( _normalNudge );
		_adjustEndBottom.add( _normalNudge );
		_adjustStartTop.add( _normalNudge );
		_adjustEndTop.add( _normalNudge );
		nudgeXZ( _adjustStartBottom, _adjustEndBottom );
		nudgeXZ( _adjustStartTop, _adjustEndTop );

		packCornersToPositions(
			positions, posBase + 12,
			_adjustStartBottom, _adjustEndBottom, _adjustEndTop, _adjustStartTop,
		);

		// ── 索引：REFERENCE_INDICES + 8·i ──
		const indexBase = i * 36;
		const vertexBase = i * 8;
		for ( let k = 0; k < 36; k++ ) {
			indices[ indexBase + k ] = REFERENCE_INDICES[ k ] + vertexBase;
		}

		lengthSoFar3D += segmentLength3D;
	}

	return {
		vertexCount,
		positions,
		startHiFwdX,
		startLoFwdY,
		startNormFwdZ,
		endNormTexX,
		rightNormTexY,
		indices,
		length3D,
	};
}
