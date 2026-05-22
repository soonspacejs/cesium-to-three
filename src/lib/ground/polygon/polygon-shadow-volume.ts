// ============================================================
// polygon/polygon-shadow-volume.ts — Polygon shadow volume 几何公共入口
// 层级:L5(顶层 facade — primitives.ts 直接调用)
// 职责:接受 PolygonShadowVolumeOptions(plot-spec 翻译过的 hierarchy + 高度
//      + granularity),产 Three.js BufferGeometry,其 attribute / index 直接
//      可被 classification.ts 中的 stencil shadow-volume mesh 消费:
//        - position3DHigh / position3DLow:RTE 拆分的 Float32 高/低分量
//        - extrudeDirection:Float32,top 半 (0,0,0) / bot 半 -surfaceNormal
//        - batchId:Float32,全 0(classification 用作 batch 标识占位)
//        - index:Uint16 / Uint32(根据顶点数自动选择)
//      额外把 outer ring 的外接矩形挂在 `geometry.userData.polygonRectangle`,
//      供 caller 后续 computePolygonPlanarExtents / computePolygonPlanarStylePoints
//      复用,避免重复计算。
// 依赖:Three.js BufferGeometry / BufferAttribute,
//      polygon-construct-extruded.ts、polygon-options.ts、polygon-hierarchy.ts、
//      math/rte-encoding.ts(矩形阶段已建,polygon 零改动复用)、constants.ts
// 被消费:primitives.ts(CesiumGroundPolygonPrimitive 类构造器)
// 算法对应:Cesium 流程 createShadowVolume + createGeometry + GeometryPipeline.encodeAttribute
//          + cesiumGeometryToThree 的合并版本(本期一次性完成)
// ============================================================

import { BufferAttribute, BufferGeometry } from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from '../constants';
import { encodePositionsToHighLowArrays } from '../math/rte-encoding';
import type { RectangleRadians } from '../types';
import { constructExtrudedPolygonShadowVolume } from './polygon-construct-extruded';
import {
	POLYGON_DEFAULT_GRANULARITY,
	type PolygonShadowVolumeOptions,
} from './polygon-options';

/**
 * Polygon shadow volume BufferGeometry 在 `userData` 上挂载的元数据。
 *
 * 下游 `primitives.ts` 把这个对象 cast 为 `PolygonGeometryUserData`,
 * 取 `polygonRectangle` 喂给 `computePolygonPlanarExtents` /
 * `computePolygonPlanarStylePoints`。
 *
 * Three.js `userData` 是约定俗成的"自定义元数据"挂载点,不参与渲染。
 */
export interface PolygonGeometryUserData {
	/** Outer ring 外接 lon/lat 矩形(弧度) */
	polygonRectangle: RectangleRadians;
}

/**
 * 从 PolygonShadowVolumeOptions 构造 Three.js BufferGeometry。
 *
 * 完成的工作(7 步,逐字匹配 doc 11 节算法):
 *   1. 应用默认值(granularity、minimumHeight、maximumHeight)
 *   2. 参数校验(hierarchy / granularity / height 范围)
 *   3. 调用 constructExtrudedPolygonShadowVolume 构 prism:
 *        Float64 positions(top + bot + walls)
 *        Float32 extrudeDirection
 *        Uint16/32 indices
 *        polygonRectangle
 *   4. RTE 编码:Float64 ECEF → 两个 Float32 (high, low) 数组
 *   5. 装配 BufferGeometry:
 *        position3DHigh / position3DLow / extrudeDirection / batchId / index
 *   6. computeBoundingSphere(no-op — 没有 'position' attribute,与矩形阶段一致)
 *   7. 把 polygonRectangle 挂到 userData
 *
 * @param options PolygonShadowVolumeOptions(hierarchy 必填,其它可选)。
 * @returns       BufferGeometry,可直接 add 到 Three.js Mesh / classification 用。
 * @throws        hierarchy 不合法 / 几何退化 / 参数越界。
 */
export function buildPolygonShadowVolumeGeometry(
	options: PolygonShadowVolumeOptions,
): BufferGeometry {
	// ── Step 1 · 默认值 ──
	const hierarchy = options.hierarchy;
	const granularity =
		options.granularity !== undefined
			? options.granularity
			: POLYGON_DEFAULT_GRANULARITY;
	const minimumHeight =
		options.minimumHeight !== undefined
			? options.minimumHeight
			: -CESIUM_GLOBE_MINIMUM_ALTITUDE;
	const maximumHeight =
		options.maximumHeight !== undefined
			? options.maximumHeight
			: CESIUM_GLOBE_MINIMUM_ALTITUDE;

	// ── Step 2 · 校验 ──
	if ( hierarchy === undefined || hierarchy === null ) {
		throw new Error( 'buildPolygonShadowVolumeGeometry: hierarchy is required.' );
	}
	if ( hierarchy.positions === undefined || hierarchy.positions.length < 3 ) {
		throw new Error(
			'buildPolygonShadowVolumeGeometry: hierarchy.positions must contain at least 3 points.',
		);
	}
	if ( ! Number.isFinite( granularity ) || granularity <= 0 ) {
		throw new Error(
			`buildPolygonShadowVolumeGeometry: granularity must be a positive finite number, got ${ granularity }.`,
		);
	}
	if ( ! Number.isFinite( minimumHeight ) || ! Number.isFinite( maximumHeight ) ) {
		throw new Error(
			'buildPolygonShadowVolumeGeometry: minimumHeight and maximumHeight must be finite numbers.',
		);
	}
	if ( maximumHeight <= minimumHeight ) {
		throw new Error(
			`buildPolygonShadowVolumeGeometry: maximumHeight (${ maximumHeight }) must be greater than minimumHeight (${ minimumHeight }).`,
		);
	}

	// ── Step 3 · 构造 prism ──
	const extruded = constructExtrudedPolygonShadowVolume(
		hierarchy,
		granularity,
		minimumHeight,
		maximumHeight,
	);

	// ── Step 4 · RTE 编码(Float64 → high/low Float32)──
	// 与矩形阶段共用 math/rte-encoding.ts:encodePositionsToHighLowArrays。
	// 每点 (px, py, pz) 拆为 (highX, highY, highZ) + (lowX, lowY, lowZ),
	// GPU 端 `(p.high − eye.high) + (p.low − eye.low)` 算 RTE 偏移获得亚米精度。
	const totalVertexCount = extruded.positions.length / 3;
	const { high, low } = encodePositionsToHighLowArrays( extruded.positions );

	// ── Step 5 · 装配 BufferGeometry ──
	const geometry = new BufferGeometry();
	geometry.setAttribute(
		'position3DHigh',
		new BufferAttribute( high, 3 ),
	);
	geometry.setAttribute(
		'position3DLow',
		new BufferAttribute( low, 3 ),
	);
	geometry.setAttribute(
		'extrudeDirection',
		new BufferAttribute( extruded.extrudeDirection, 3 ),
	);
	// batchId:Float32Array,全 0(classification 运行时复用此 attribute 占位)。
	// 长度 = vertexCount(每顶点 1 个 batchId)。Float32Array 默认初始化为 0,无需显式写。
	geometry.setAttribute(
		'batchId',
		new BufferAttribute( new Float32Array( totalVertexCount ), 1 ),
	);
	geometry.setIndex( new BufferAttribute( extruded.indices, 1 ) );

	// ── Step 6 · computeBoundingSphere(no-op) ──
	// Three.js 默认从 `position` attribute 算 boundingSphere,但本几何只有
	// `position3DHigh` / `position3DLow`,没有 `position` — 调用是 no-op。
	// classification.ts 的 frustum culling 基于椭球与相机距离手动判定,不依赖此值。
	geometry.computeBoundingSphere();

	// ── Step 7 · userData 挂 polygonRectangle ──
	const userData: PolygonGeometryUserData = {
		polygonRectangle: extruded.polygonRectangle,
	};
	geometry.userData = userData;

	return geometry;
}
