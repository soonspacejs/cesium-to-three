// ============================================================
// circle/circle-shadow-volume.ts — Circle ShadowVolume 几何公共入口
// 层级:L4(顶层 facade — primitives.ts 直接调用)
// 职责:接受 CircleShadowVolumeOptions(度坐标 + 米半径 + 高度),产 Three.js
//      BufferGeometry,其 attribute / index 直接可被 classification.ts 中
//      的 stencil shadow-volume mesh 消费:
//        - position3DHigh / position3DLow:RTE 拆分的 Float32 高/低分量
//        - extrudeDirection:Float32,top 半 (0,0,0) / bot 半 -surfaceNormal
//        - batchId:Float32,全 0(classification 用作 batch 标识占位)
//        - index:Uint16 / Uint32(根据顶点数自动选择)
//      整体流程合并了 Cesium 的 6 步:
//        Cartesian3.fromDegrees(centerLon, centerLat) → new CircleGeometry →
//        CircleGeometry.createShadowVolume → CircleGeometry.createGeometry →
//        GeometryPipeline.encodeAttribute → cesiumGeometryToThree
// 依赖:Three.js BufferGeometry / BufferAttribute / Vector3、
//      circle-construct-extruded、circle-options、
//      math/ellipsoid(scaleToGeodeticSurface)、math/cartographic、
//      math/rte-encoding、ground/constants。
// 被消费:primitives.ts(CesiumGroundCirclePrimitive 类构造器)。
// 算法对应:Cesium CircleGeometry.createShadowVolume + createGeometry +
//          GeometryPipeline.encodeAttribute + cesiumGeometryToThree 的合并版本。
// ============================================================

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from '../constants';
import { createCartographic } from '../math/cartographic';
import {
	cartographicToCartesian,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';
import { encodePositionsToHighLowArrays } from '../math/rte-encoding';

import { constructExtrudedCircleShadowVolume } from './circle-construct-extruded';
import {
	CIRCLE_DEFAULT_GRANULARITY,
	type CircleShadowVolumeOptions,
} from './circle-options';

// ============================================================
// 模块级 scratch
//   center ECEF 在每次 build 调用时计算并经 scaleToGeodeticSurface
//   投到椭球面;Cartographic scratch 也复用,避免每次新建。
// ============================================================
const _centerCarto = createCartographic();
const _centerEcef = new Vector3();

/**
 * 从 CircleShadowVolumeOptions 构造 Three.js BufferGeometry。
 *
 * 7 步流程(逐字匹配 doc 11 节算法):
 *   1. 应用默认值(granularity、stRotation、min/maxHeight)
 *   2. 参数校验(center / radius / granularity / rotation / heights)
 *   3. center degrees → cartographic → ECEF → scaleToGeodeticSurface
 *   4. 调用 constructExtrudedCircleShadowVolume 构 prism:
 *        Float64 positions / Float32 extrudeDirection / Uint16-32 indices
 *   5. RTE 编码:Float64 ECEF → 两个 Float32 (high, low) 数组
 *   6. 装配 BufferGeometry:
 *        position3DHigh / position3DLow / extrudeDirection / batchId / index
 *   7. computeBoundingSphere(no-op — 没有 'position' attribute,与
 *      矩形 / polygon 阶段行为一致;classification.ts 自己处理 frustum culling)
 *
 * @param options CircleShadowVolumeOptions(center + radius + 可选 granularity/rotation/heights)。
 * @returns       BufferGeometry,可直接喂给 classification 或 Three.js Mesh。
 * @throws        center 非有限 / radius ≤ 0 / granularity ≤ 0 /
 *                maximumHeight ≤ minimumHeight 等参数校验失败。
 */
export function buildCircleShadowVolumeGeometry(
	options: CircleShadowVolumeOptions,
): BufferGeometry {
	// ============================================================
	// 步骤 1 · 默认值
	// ============================================================
	const granularity =
		options.granularityRadians !== undefined
			? options.granularityRadians
			: CIRCLE_DEFAULT_GRANULARITY;
	const rotation =
		options.stRotationRadians !== undefined
			? options.stRotationRadians
			: 0.0;
	const minimumHeight =
		options.minimumHeight !== undefined
			? options.minimumHeight
			: -CESIUM_GLOBE_MINIMUM_ALTITUDE;
	const maximumHeight =
		options.maximumHeight !== undefined
			? options.maximumHeight
			: CESIUM_GLOBE_MINIMUM_ALTITUDE;
	const radius = options.radiusMeters;

	// ============================================================
	// 步骤 2 · 校验(第二层防御 — primitives.ts 已做 plot-spec 层校验,
	//   这里防御未经 primitives.ts 的 caller)
	// ============================================================
	if (
		! Number.isFinite( options.centerLongitudeDegrees ) ||
		! Number.isFinite( options.centerLatitudeDegrees )
	) {
		throw new Error(
			'buildCircleShadowVolumeGeometry: center longitude/latitude must be finite degrees.',
		);
	}
	if ( ! Number.isFinite( radius ) || radius <= 0.0 ) {
		throw new Error(
			`buildCircleShadowVolumeGeometry: radius must be a positive finite number, got ${ radius }.`,
		);
	}
	if ( ! Number.isFinite( granularity ) || granularity <= 0.0 ) {
		throw new Error(
			`buildCircleShadowVolumeGeometry: granularity must be a positive finite number, got ${ granularity }.`,
		);
	}
	if ( ! Number.isFinite( rotation ) ) {
		throw new Error(
			`buildCircleShadowVolumeGeometry: stRotation must be a finite number, got ${ rotation }.`,
		);
	}
	if (
		! Number.isFinite( minimumHeight ) ||
		! Number.isFinite( maximumHeight )
	) {
		throw new Error(
			'buildCircleShadowVolumeGeometry: minimumHeight and maximumHeight must be finite numbers.',
		);
	}
	if ( maximumHeight <= minimumHeight ) {
		throw new Error(
			`buildCircleShadowVolumeGeometry: maximumHeight (${ maximumHeight }) must be greater than minimumHeight (${ minimumHeight }).`,
		);
	}

	// ============================================================
	// 步骤 3 · center degrees → ECEF → scaleToGeodeticSurface
	//
	// Cesium 路径(原 primitives.ts):
	//   centerCartesian = Cartesian3.fromDegrees(lon, lat, 0, WGS84)
	// 然后 EllipseGeometry.createGeometry 内部对 center 调一次 scaleToGeodeticSurface
	//(EllipseGeometry.js L1174-1177)。
	//
	// 这里手动调用 scaleToGeodeticSurface,与 Cesium 行为完全一致。
	// 注意 wgs84-helpers.ts 的 wgs84PositionFromDegrees 每次 new Vector3,
	// 这里改用 cartographicToCartesian 直接写到 _centerEcef scratch 以减少分配。
	// ============================================================
	_centerCarto.longitude = options.centerLongitudeDegrees * Math.PI / 180.0;
	_centerCarto.latitude = options.centerLatitudeDegrees * Math.PI / 180.0;
	_centerCarto.height = 0.0;
	cartographicToCartesian( _centerCarto, _centerEcef );

	// Newton 投到椭球面(h = 0 的 cartographicToCartesian 输出已在椭球面附近,
	// Newton 1 次迭代即收敛 — 与 Cesium EllipseGeometry.createGeometry L1174 行为一致)。
	const surfaceCenter = scaleToGeodeticSurface( _centerEcef, _centerEcef );
	if ( surfaceCenter === undefined ) {
		// 极罕见:cartographicToCartesian 输出在椭球中心(几何上不可能)。
		throw new Error(
			'buildCircleShadowVolumeGeometry: circle center projects to ellipsoid center.',
		);
	}

	// ============================================================
	// 步骤 4 · 构造 prism(组合 06/07/08/09 的输出)
	// ============================================================
	const extruded = constructExtrudedCircleShadowVolume(
		_centerEcef,
		radius,
		granularity,
		rotation,
		minimumHeight,
		maximumHeight,
	);
	// extruded.positions:Float64Array,长度 = totalVertexCount × 3
	// extruded.extrudeDirection:Float32Array,同长
	// extruded.indices:Uint16Array / Uint32Array

	// ============================================================
	// 步骤 5 · RTE 编码(Float64 ECEF → 两个 Float32 high/low 数组)
	//
	// 复用矩形阶段建好的 math/rte-encoding,与 Cesium GeometryPipeline.encodeAttribute
	// 字节级一致(EncodedCartesian3.encode 的 65536 fixed-point 拆分)。
	// ============================================================
	const totalVertexCount = extruded.positions.length / 3;
	const { high, low } = encodePositionsToHighLowArrays( extruded.positions );
	// high / low:Float32Array,长度 = extruded.positions.length

	// ============================================================
	// 步骤 6 · 装配 BufferGeometry
	//
	// 5 个 attribute + 1 个 index,完全对齐 classification.ts 期望的格式
	//(与矩形 / polygon 阶段同形)。
	// ============================================================
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
	// Float32Array 默认初始化为 0,无需显式 fill。
	geometry.setAttribute(
		'batchId',
		new BufferAttribute( new Float32Array( totalVertexCount ), 1 ),
	);
	geometry.setIndex( new BufferAttribute( extruded.indices, 1 ) );

	// ============================================================
	// 步骤 7 · computeBoundingSphere(no-op)
	//
	// Three.js 默认从 `position` attribute 算 boundingSphere,但本几何只有
	// position3DHigh / position3DLow,没有 position — 调用是 no-op。
	// classification.ts 的 frustum culling 基于椭球与相机距离手动判定,
	// 不依赖此值。保留调用以与矩形 / polygon 入口形态一致。
	// ============================================================
	geometry.computeBoundingSphere();

	return geometry;
}
