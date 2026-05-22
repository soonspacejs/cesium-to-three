// ============================================================
// rectangle/rectangle-shadow-volume.ts — 矩形 ShadowVolume 公共入口
// 层级:L5(矩形子系统的顶层入口)
// 职责:接受 RectangleShadowVolumeOptions,产出 Three.js BufferGeometry。
//      内部:applyDefaults → constructExtrudedRectangleShadowVolume →
//           encodePositionsToHighLowArrays → assemble BufferGeometry。
//      输出的 BufferGeometry 与 Cesium RectangleGeometry.createShadowVolume +
//      createGeometry + GeometryPipeline.encodeAttribute 后的产物在 attribute
//      字节级一致(V5 验收)。
// 依赖:rectangle-construct-extruded.ts、rectangle-options.ts、
//      math/rte-encoding.ts、math/constants.ts、Three.js BufferGeometry/BufferAttribute/Vector3
// 被消费:primitives.ts(CesiumGroundRectanglePrimitive 类)
// 算法对应:Cesium Source/Core/RectangleGeometry.js#createShadowVolume(L1342-1364)
//          + createGeometry(L1223-1337) + GeometryPipeline.encodeAttribute(L727-788)
// ============================================================

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from '../constants';
import {
	RECTANGLE_DEFAULT_GRANULARITY,
	WGS84_RADII_X_SQ,
	WGS84_RADII_Y_SQ,
	WGS84_RADII_Z_SQ,
} from '../math/constants';
import { encodePositionsToHighLowArrays } from '../math/rte-encoding';
import { constructExtrudedRectangleShadowVolume } from './rectangle-construct-extruded';
import type { RectangleShadowVolumeOptions } from './rectangle-options';

/**
 * 构建矩形 shadow volume Three BufferGeometry,作为 L4 几何构造层的唯一入口。
 *
 * 输出的 BufferGeometry 包含 5 个数据通道(都是 ShadowVolumeAppearanceVS
 * shader 必需的 attribute 名,不可改名):
 *   - `position3DHigh` (Float32, 3)   — RTE 高分量
 *   - `position3DLow`  (Float32, 3)   — RTE 低分量
 *   - `extrudeDirection` (Float32, 3) — top=0,bottom=-normal
 *   - `batchId` (Float32, 1)          — 单矩形固定全 0
 *   - index (Uint16/32)               — 合并 top+bottom+wall 三角形索引
 *
 * 完整 7 步算法:
 *   1. 应用默认值(granularity / minHeight / maxHeight)
 *   2. 校验输入(必填字段 / 数值有限性 / 大小关系)
 *   3. 构造 WGS84 半轴平方 Vector3(传给 grid 采样)
 *   4. 调用 prism 构造(rectangle-construct-extruded)
 *   5. RTE 编码 positions(Float64 ECEF → Float32 high/low)
 *   6. 装配 BufferGeometry 并 computeBoundingSphere
 *   7. 返回
 *
 * @param options 矩形几何选项;rectangle 字段必填,其它字段可选。
 * @returns       Three BufferGeometry 实例,可直接喂给 classification.ts。
 * @throws        rectangle 缺失 / granularity ≤ 0 / minH > maxH 等校验错误。
 */
export function buildRectangleShadowVolumeGeometry(
	options: RectangleShadowVolumeOptions,
): BufferGeometry {
	// ── 步骤 1 · 应用默认值 ──
	const rectangle = options.rectangle;
	const granularity = options.granularity ?? RECTANGLE_DEFAULT_GRANULARITY;
	const minimumHeight = options.minimumHeight ?? -CESIUM_GLOBE_MINIMUM_ALTITUDE;
	const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;

	// ── 步骤 2 · 校验 ──
	if ( rectangle === undefined || rectangle === null ) {
		throw new Error( 'rectangle is required' );
	}
	if ( ! Number.isFinite( granularity ) || granularity <= 0.0 ) {
		throw new Error(
			`granularity must be a positive finite number, got ${ granularity }`,
		);
	}
	if (
		! Number.isFinite( minimumHeight ) ||
		! Number.isFinite( maximumHeight )
	) {
		throw new Error( 'minimumHeight and maximumHeight must be finite numbers' );
	}
	if ( maximumHeight <= minimumHeight ) {
		throw new Error(
			`maximumHeight (${ maximumHeight }) must be greater than minimumHeight (${ minimumHeight })`,
		);
	}

	// ── 步骤 3 · 椭球半轴平方 Vector3 ──
	// 矩形几何路径只用 radiiSquared 做 gamma 投影(rectangle-grid.ts),
	// 不需要 radii / oneOverRadii / oneOverRadiiSquared(由 ellipsoid.ts 自身静态常量提供)。
	const radiiSquared = new Vector3(
		WGS84_RADII_X_SQ,
		WGS84_RADII_Y_SQ,
		WGS84_RADII_Z_SQ,
	);

	// ── 步骤 4 · 调用 prism 构造 ──
	const result = constructExtrudedRectangleShadowVolume(
		rectangle,
		granularity,
		minimumHeight,
		maximumHeight,
		radiiSquared,
	);

	// ── 步骤 5 · RTE 编码 positions(Float64 ECEF → Float32 high/low)──
	const { high, low } = encodePositionsToHighLowArrays( result.positions );

	// ── 步骤 6 · 装配 BufferGeometry ──
	const vertexCount = result.positions.length / 3;
	const geometry = new BufferGeometry();

	// 三个核心 attribute:position3DHigh / position3DLow / extrudeDirection。
	// 这些命名是 ShadowVolumeAppearanceVS.glsl 消费的 `attribute vec3` 名,
	// 不可改名。
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	geometry.setAttribute(
		'extrudeDirection',
		new BufferAttribute( result.extrudeDirection, 3 ),
	);

	// batchId:单矩形作为一个 batch,固定全 0,与 Cesium 默认一致
	const batchId = new Float32Array( vertexCount );
	geometry.setAttribute( 'batchId', new BufferAttribute( batchId, 1 ) );

	// 索引(已合并 top + bottom + wall)
	geometry.setIndex( new BufferAttribute( result.indices, 1 ) );

	// boundingSphere:Three.computeBoundingSphere() 读 attributes.position,
	// 我们的 attribute 名是 position3DHigh 故该调用对 boundingSphere 是 no-op,
	// 但 classification.ts 把所有 mesh frustumCulled=false,无影响。
	// 保留调用以与旧 cesiumGeometryToThree 字节级一致(V3 验收)。
	geometry.computeBoundingSphere();

	// ── 步骤 7 · 返回 ──
	return geometry;
}
