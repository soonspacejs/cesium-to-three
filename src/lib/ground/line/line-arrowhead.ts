// ============================================================
// line/line-arrowhead.ts — 贴地线端箭头几何 + 端点标架
// 层级：L4（贴地线几何子模块）
// 职责：
//   1) `EndpointFrame`：端点处的「尖端 + 三向单位向量」标架（ECEF）。
//   2) `computeEndpointFrames`：从 `DensifiedLine` 算出 start / end 两端的标架。
//   3) `buildArrowHeadGeometry`：把模式（NONE/LEFT/RIGHT/BOTH）转成 8 顶点
//      薄盒 BufferGeometry，每端一个；盒子尺寸只存「单位标架 + 角点系数」，
//      真正的米尺寸在 VS 里按 `czm_metersPerPixel(tip)` 动态挤出。
// 依赖：Three.js、math/cartographic.ts、math/ellipsoid.ts、math/rte-encoding.ts、
//        line/line-types.ts。
// 被消费：CesiumGroundPolylinePrimitive、单测、line-shadow-volume facade。
// 算法对应：见 ../../../docs/线端箭头-独立方案.md（自包含设计）。
// ============================================================

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

import {
	APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
} from '../constants';
import { createCartographic } from '../math/cartographic';
import {
	cartographicToCartesian,
	geodeticSurfaceNormal,
} from '../math/ellipsoid';
import { encodeVec3RTE } from '../math/rte-encoding';
import {
	getTerrainMinMaxHeightsForRectangle,
	isApproximateTerrainHeightsReady,
} from '../terrain-heights';

import type { DensifiedLine } from './line-types';

/** 箭头放置模式枚举（内部使用，公开 API 用字符串）。 */
export const ARROW_MODE = {
	/** 不画箭头（默认）。 */
	NONE: 0,
	/** 仅起点端（折线 `points[0]`）画箭头。 */
	LEFT: 1,
	/** 仅终点端（折线 `points[N-1]`）画箭头。 */
	RIGHT: 2,
	/** 两端都画。 */
	BOTH: 3,
} as const;
/* eslint-disable-next-line @typescript-eslint/no-redeclare */
export type ArrowMode = typeof ARROW_MODE[ keyof typeof ARROW_MODE ];

/** 箭头样式：实心三角 / 开口雪佛龙。 */
export type ArrowStyle = 'solid' | 'open';

/**
 * 端点局部标架（ECEF 三向单位向量 + 尖端 ECEF 位置 + 端点处地形高度窗口）。
 *
 * - `tip` 是端点在椭球面（h=0）的 ECEF 位置。FS 把地形点 `P` 投到这个标架。
 * - `back` 指向线内部（首段正方向 / 末段反方向），构成「沿线长」轴。
 * - `right` 端点处的右法线，构成「横向」轴。
 * - `up` 椭球面法线，配合 VS 把盒子竖直挤成「穿过地表的薄墙」。
 * - `terrainMinHeight` / `terrainMaxHeight` 端点附近的地形高度范围（米）。
 *   箭头盒子在 VS 里 顶 / 底 沿 `up` 推到这两个高度——**必须覆盖实际地形高度**，
 *   否则盒子在 alt=0 的投影与「FS 重建地形点」的屏幕位置错位，箭头表现为
 *   「随缩放变形」「顶部冒出线段」等 alignment 伪影（尼泊尔 5 km 地形是典型场景）。
 *
 * 三个方向向量应正交（`back ⟂ right ⟂ up`），由调用方保证。
 */
export interface EndpointFrame {
	tip: [ number, number, number ];
	back: [ number, number, number ];
	right: [ number, number, number ];
	up: [ number, number, number ];
	terrainMinHeight: number;
	terrainMaxHeight: number;
}

// 8 顶点角点系数 (aCoef ∈ {0,1}, bSign ∈ {-1,+1}, topBottomSide ∈ {-1,+1})。
// 下 4 角 (tb=-1)：(0,-1), (0,+1), (1,+1), (1,-1)
// 上 4 角 (tb=+1)：(0,-1), (0,+1), (1,+1), (1,-1)
const ARROW_CORNERS: readonly ( readonly number[] )[] = [
	[ 0, - 1, - 1 ], [ 0, 1, - 1 ], [ 1, 1, - 1 ], [ 1, - 1, - 1 ],
	[ 0, - 1, 1 ], [ 0, 1, 1 ], [ 1, 1, 1 ], [ 1, - 1, 1 ],
];

// 盒子 12 三角形（材质 DoubleSide，绕序不敏感）。
const ARROW_BOX_INDICES: readonly number[] = [
	0, 1, 2,   0, 2, 3,    // 底
	4, 6, 5,   4, 7, 6,    // 顶
	0, 4, 5,   0, 5, 1,    // a=0 面
	3, 2, 6,   3, 6, 7,    // a=L 面
	0, 3, 7,   0, 7, 4,    // b=-W 面
	1, 5, 6,   1, 6, 2,    // b=+W 面
];

// 模块级 scratch（与项目其它几何模块同模式：零热路径 GC）。
const _scratchVecA = new Vector3();
const _scratchVecB = new Vector3();
const _scratchVecC = new Vector3();
const _scratchUp = new Vector3();
const _scratchCarto = createCartographic();
const _tip = new Vector3();
const _tipHi = new Vector3();
const _tipLo = new Vector3();

/**
 * 把扁平数组里的一点读到 Vector3。
 *
 * @param array      扁平 [x0,y0,z0, x1,y1,z1, ...] 数组。
 * @param pointIndex 第几点（0-based）。
 * @param out        接收向量。
 * @returns          out。
 */
function readVec3FromFlat(
	array: number[],
	pointIndex: number,
	out: Vector3,
): Vector3 {
	const base = pointIndex * 3;
	out.set( array[ base ], array[ base + 1 ], array[ base + 2 ] );
	return out;
}

/**
 * 端点处查 `ApproximateTerrainHeights` 得到地形高度窗口。小范围 ~5e-7 度
 * 的微 rectangle，落到 level-6 单 tile，与线 segment 用的同套查询。table 没
 * 初始化时回退到 [-1000, 9000]（覆盖地球绝大多数地形）。
 *
 * @param longitudeDegrees 端点经度（度）。
 * @param latitudeDegrees  端点纬度（度）。
 * @returns                terrain min / max（米）。
 */
function queryEndpointTerrainHeights(
	longitudeDegrees: number,
	latitudeDegrees: number,
): { minHeight: number; maxHeight: number } {
	if ( ! isApproximateTerrainHeightsReady() ) {
		// table 未加载时回退到 Cesium 同款默认窗口：
		//   min = -100 km（覆盖马里亚纳海沟 ~-11 km 并留余量）
		//   max =  +9 km（覆盖珠峰 ~8.85 km）
		// 这两个值就是 `terrain-heights.ts` 里 `ApproximateTerrainHeights._defaultMin/MaxTerrainHeight`
		// 的项目常量。调用方 demo 一般先 `initializeApproximateTerrainHeights`。
		return {
			minHeight: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
			maxHeight: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
		};
	}
	const halfSize = 5.0e-7;
	const rect = {
		west: longitudeDegrees - halfSize,
		east: longitudeDegrees + halfSize,
		south: latitudeDegrees - halfSize,
		north: latitudeDegrees + halfSize,
	};
	const terrain = getTerrainMinMaxHeightsForRectangle( rect );
	return {
		minHeight: terrain.minimumTerrainHeight,
		maxHeight: terrain.maximumTerrainHeight,
	};
}

/**
 * 从密集线数据算出 start / end 两端的标架。每端：
 *
 * - `tip = cartographic(lon, lat, h=0)` 反投影到 ECEF（与线 ecStart 同源）。
 * - `back` = 指向相邻内点的方向（首段正方向 / 末段反方向）。
 * - `right` = 端点处密集线给出的几何法线（首末点的 `normals[]`）。
 * - `up` = `geodeticSurfaceNormal(tip)`，与端点切平面正交。
 * - `terrainMinHeight` / `terrainMaxHeight` 端点附近的地形高度窗口。
 *
 * @param wall 加密后的密集线数据（来自 buildWallArrays）。
 * @returns    起 / 终两端的标架。
 * @throws     `wall.pointCount < 2` 时抛错（首尾两端没有意义）。
 */
export function computeEndpointFrames(
	wall: DensifiedLine,
): { startFrame: EndpointFrame; endFrame: EndpointFrame } {
	const N = wall.pointCount;
	if ( N < 2 ) {
		throw new Error( 'CesiumGroundPolyline: cannot derive endpoint frames from < 2 wall points.' );
	}

	// cartographicsArray 顺序：[lat0, lon0, lat1, lon1, ...]（与 Cesium 一致）。
	const cartos = wall.cartographicsArray;

	// ── 起点端：tip = cartographic(lon0, lat0, 0)；先算 up，再把 chord
	//    (bottom[1] - bottom[0]) 投影到 tip 的切平面得到 back（消除「弦相对
	//    切线下沉」造成的 frame 非正交，详见下方注释）。 ──
	_scratchCarto.longitude = cartos[ 1 ];
	_scratchCarto.latitude = cartos[ 0 ];
	_scratchCarto.height = 0.0;
	cartographicToCartesian( _scratchCarto, _scratchVecA );

	const startTipArr: [ number, number, number ] = [
		_scratchVecA.x, _scratchVecA.y, _scratchVecA.z,
	];

	const startUp = geodeticSurfaceNormal( _scratchVecA, _scratchUp );
	if ( startUp === undefined ) {
		throw new Error( 'CesiumGroundPolyline: failed to derive geodetic up at start tip.' );
	}
	const startUpArr: [ number, number, number ] = [ startUp.x, startUp.y, startUp.z ];

	readVec3FromFlat( wall.bottomPositionsArray, 0, _scratchVecB ); // bottom[0]
	readVec3FromFlat( wall.bottomPositionsArray, 1, _scratchVecC ); // bottom[1]
	_scratchVecC.sub( _scratchVecB ).normalize();
	// 把 chord 投影到 tip 的切平面（消除「弦相对切线的下沉」，幅度 ≈ 段长 / 2R）。
	// 不投影时 chord 在 tip 处带一个沿 -up 的微小分量；FS 在 terrain 端点像素算
	//   a = dot(P - tip, back) = dot(H·up + horizontal, back)
	//     = H·dot(up, back) + dot(horizontal, back)
	// 中的 H·dot(up, back) 会变成 -H·(L/2R)（H = 端点 terrain 高度，L = 段长，
	// R ≈ 6.4e6 m）。10 km 段 + 5 km 地形 → a ≈ -3.9 m，让端点像素 a 偏负、
	// 被 `a < 0` discard。后果有两个：
	//   1) 端点像素 / 箭头 a=0 边界错位 → 「线段冒过箭头顶部」的几像素小尾巴
	//      （用户报的「大比例尺下顶部冒线段」）。
	//   2) 这个 3D 偏移在屏幕上的投影随相机位置变化 → 箭头看起来「随相机远近
	//      移位 / 缩放」（用户报的「跟随相机远近变化而不是固定」）。
	// 投影后 back ⟂ up（与 rightDir 一致，computeRightNormal 也是切平面内的
	// 单位向量），三向量正交，箭头顶端的 a=0 边界精确落在端点 lon/lat 上空。
	_scratchVecC.addScaledVector( startUp, - _scratchVecC.dot( startUp ) ).normalize();
	const startBackArr: [ number, number, number ] = [
		_scratchVecC.x, _scratchVecC.y, _scratchVecC.z,
	];

	readVec3FromFlat( wall.normalsArray, 0, _scratchVecB ); // normals[0]
	const startRightArr: [ number, number, number ] = [
		_scratchVecB.x, _scratchVecB.y, _scratchVecB.z,
	];

	// 端点处地形高度窗口（用与线 segment 同样的 ApproximateTerrainHeights 路径）。
	// cartos 顺序是 [lat, lon, ...] 弧度，要转度数才能查 rectangle。
	const RAD2DEG = 180.0 / Math.PI;
	const startTerrain = queryEndpointTerrainHeights(
		cartos[ 1 ] * RAD2DEG,
		cartos[ 0 ] * RAD2DEG,
	);

	const startFrame: EndpointFrame = {
		tip: startTipArr,
		back: startBackArr,
		right: startRightArr,
		up: startUpArr,
		terrainMinHeight: startTerrain.minHeight,
		terrainMaxHeight: startTerrain.maxHeight,
	};

	// ── 终点端：tip = cartographic(lon_{N-1}, lat_{N-1}, 0)；同起点端，
	//    chord (bottom[N-2] - bottom[N-1]) 投影到切平面后作为 back（指向
	//    线内部）。同样的「弦下沉」问题在末端也存在，必须做投影。 ──
	_scratchCarto.longitude = cartos[ ( N - 1 ) * 2 + 1 ];
	_scratchCarto.latitude = cartos[ ( N - 1 ) * 2 ];
	_scratchCarto.height = 0.0;
	cartographicToCartesian( _scratchCarto, _scratchVecA );

	const endTipArr: [ number, number, number ] = [
		_scratchVecA.x, _scratchVecA.y, _scratchVecA.z,
	];

	const endUp = geodeticSurfaceNormal( _scratchVecA, _scratchUp );
	if ( endUp === undefined ) {
		throw new Error( 'CesiumGroundPolyline: failed to derive geodetic up at end tip.' );
	}
	const endUpArr: [ number, number, number ] = [ endUp.x, endUp.y, endUp.z ];

	readVec3FromFlat( wall.bottomPositionsArray, N - 1, _scratchVecB ); // bottom[N-1]
	readVec3FromFlat( wall.bottomPositionsArray, N - 2, _scratchVecC ); // bottom[N-2]
	_scratchVecC.sub( _scratchVecB ).normalize();
	_scratchVecC.addScaledVector( endUp, - _scratchVecC.dot( endUp ) ).normalize();
	const endBackArr: [ number, number, number ] = [
		_scratchVecC.x, _scratchVecC.y, _scratchVecC.z,
	];

	readVec3FromFlat( wall.normalsArray, N - 1, _scratchVecB );
	const endRightArr: [ number, number, number ] = [
		_scratchVecB.x, _scratchVecB.y, _scratchVecB.z,
	];

	const endTerrain = queryEndpointTerrainHeights(
		cartos[ ( N - 1 ) * 2 + 1 ] * RAD2DEG,
		cartos[ ( N - 1 ) * 2 ] * RAD2DEG,
	);

	const endFrame: EndpointFrame = {
		tip: endTipArr,
		back: endBackArr,
		right: endRightArr,
		up: endUpArr,
		terrainMinHeight: endTerrain.minHeight,
		terrainMaxHeight: endTerrain.maxHeight,
	};

	return { startFrame, endFrame };
}

/**
 * 构造箭头几何。每个启用的端 = 一个 8 顶点薄盒（盒尺寸在 VS 里按 metersPerPixel
 * 动态挤出，CPU 端只存「单位标架 + 角点系数」）。
 *
 * @param startFrame 起点端标架（mode === LEFT 或 BOTH 时使用）。
 * @param endFrame   终点端标架（mode === RIGHT 或 BOTH 时使用）。
 * @param mode       箭头模式枚举。
 * @returns          已装好属性 + 索引的 BufferGeometry。无 `position` 属性，
 *                   调用方应设 `mesh.frustumCulled = false`。NONE 模式返回空几何。
 */
export function buildArrowHeadGeometry(
	startFrame: EndpointFrame,
	endFrame: EndpointFrame,
	mode: ArrowMode,
): BufferGeometry {
	const frames: EndpointFrame[] = [];
	if ( mode === ARROW_MODE.LEFT || mode === ARROW_MODE.BOTH ) {
		frames.push( startFrame );
	}
	if ( mode === ARROW_MODE.RIGHT || mode === ARROW_MODE.BOTH ) {
		frames.push( endFrame );
	}

	const boxes = frames.length;
	const vertexCount = boxes * 8;
	const tipHigh = new Float32Array( vertexCount * 3 );
	const tipLow = new Float32Array( vertexCount * 3 );
	const backDir = new Float32Array( vertexCount * 3 );
	const rightDir = new Float32Array( vertexCount * 3 );
	const upDir = new Float32Array( vertexCount * 3 );
	const corner = new Float32Array( vertexCount * 3 );
	const terrainHeights = new Float32Array( vertexCount * 2 );  // (minHeight, maxHeight)
	const indices = new Uint16Array( boxes * 36 );

	for ( let f = 0; f < boxes; f++ ) {
		const fr = frames[ f ];
		_tip.set( fr.tip[ 0 ], fr.tip[ 1 ], fr.tip[ 2 ] );
		encodeVec3RTE( _tip, _tipHi, _tipLo );

		for ( let j = 0; j < 8; j++ ) {
			const vi = ( f * 8 + j ) * 3;
			const ti = ( f * 8 + j ) * 2;
			tipHigh[ vi ] = _tipHi.x; tipHigh[ vi + 1 ] = _tipHi.y; tipHigh[ vi + 2 ] = _tipHi.z;
			tipLow[ vi ] = _tipLo.x; tipLow[ vi + 1 ] = _tipLo.y; tipLow[ vi + 2 ] = _tipLo.z;
			backDir[ vi ] = fr.back[ 0 ];
			backDir[ vi + 1 ] = fr.back[ 1 ];
			backDir[ vi + 2 ] = fr.back[ 2 ];
			rightDir[ vi ] = fr.right[ 0 ];
			rightDir[ vi + 1 ] = fr.right[ 1 ];
			rightDir[ vi + 2 ] = fr.right[ 2 ];
			upDir[ vi ] = fr.up[ 0 ];
			upDir[ vi + 1 ] = fr.up[ 1 ];
			upDir[ vi + 2 ] = fr.up[ 2 ];
			const c = ARROW_CORNERS[ j ];
			corner[ vi ] = c[ 0 ];
			corner[ vi + 1 ] = c[ 1 ];
			corner[ vi + 2 ] = c[ 2 ];
			terrainHeights[ ti ] = fr.terrainMinHeight;
			terrainHeights[ ti + 1 ] = fr.terrainMaxHeight;
		}
		for ( let k = 0; k < 36; k++ ) {
			indices[ f * 36 + k ] = ARROW_BOX_INDICES[ k ] + f * 8;
		}
	}

	const g = new BufferGeometry();
	g.setAttribute( 'arrowTipHigh', new BufferAttribute( tipHigh, 3 ) );
	g.setAttribute( 'arrowTipLow', new BufferAttribute( tipLow, 3 ) );
	g.setAttribute( 'arrowBackDir', new BufferAttribute( backDir, 3 ) );
	g.setAttribute( 'arrowRightDir', new BufferAttribute( rightDir, 3 ) );
	g.setAttribute( 'arrowUpDir', new BufferAttribute( upDir, 3 ) );
	g.setAttribute( 'arrowCorner', new BufferAttribute( corner, 3 ) );
	g.setAttribute( 'arrowTerrainHeights', new BufferAttribute( terrainHeights, 2 ) );
	g.setIndex( new BufferAttribute( indices, 1 ) );
	return g;
}
