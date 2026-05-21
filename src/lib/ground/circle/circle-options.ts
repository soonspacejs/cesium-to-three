// ============================================================
// circle/circle-options.ts — Circle 几何构造选项类型 + 默认值常量
// 层级:L0(零依赖,仅 import 类型)
// 职责:定义 buildCircleShadowVolumeGeometry 与
//      constructExtrudedCircleShadowVolume 的入参类型,并集中维护本期
//      circle 路径全部默认值常量。命名与矩形阶段
//      RectangleShadowVolumeOptions / 多边形阶段 PolygonShadowVolumeOptions
//      同形,保证三条几何路径风格一致。
// 依赖:无运行时依赖。
// 被消费:circle-shadow-volume.ts、primitives.ts(若直接使用 options 类型)。
// 算法对应:类比 rectangle/rectangle-options.ts 与 polygon/polygon-options.ts。
// ============================================================

/**
 * Circle shadow volume 几何构造选项。
 *
 * 与矩形 / 多边形对应类型同形:核心字段(centerLongitudeDegrees、
 * centerLatitudeDegrees、radiusMeters)必填,其它字段可选(由 caller 留空
 * 时使用本文件下方的默认值常量)。
 *
 * 注意:plot-spec 层(primitives.ts:CesiumGroundCirclePrimitiveOptions)
 * 已对 `granularityRadians` 做 MIN/MAX 范围 clamp、对 radius 做下限 1.0 处理;
 * 本几何模块只做防御性"> 0 / 有限性"校验,不重复 clamp 逻辑。
 */
export interface CircleShadowVolumeOptions {
	/** Circle 中心经度(度,范围 [-180, 180]) */
	centerLongitudeDegrees: number;

	/** Circle 中心纬度(度,范围 [-90, 90]) */
	centerLatitudeDegrees: number;

	/** 圆半径,米(必须 > 0;含 stroke 外扩部分由 caller 在传入前算好) */
	radiusMeters: number;

	/**
	 * 网格精度,弧度。决定 numPts(第一象限内的"环"数)。
	 * 默认 CIRCLE_DEFAULT_GRANULARITY = π/180(1°)。
	 *
	 * 重要:Cesium 在 EllipseGeometryLibrary.computeEllipsePositions 内部
	 * 对此值 × 8(R4 缩放因子,见 refactor-plan/circle/05-quadrant-traversal.md)。
	 * 本期严格保留 ×8 行为,所以 caller 传入"原始"granularity,内部自动放大。
	 */
	granularityRadians?: number;

	/**
	 * Cesium 的 stRotation(弧度)。在 POSITION_ONLY 路径下不影响纹理输出,
	 * 但**影响 pointOnEllipsoid 的 azimuth = theta + rotation 计算**,
	 * 顶点 ECEF 位置因此随 rotation 旋转(R3)。默认 0。
	 */
	stRotationRadians?: number;

	/**
	 * Shadow volume 底面高度,米。默认 -CESIUM_GLOBE_MINIMUM_ALTITUDE = -55000。
	 * 选择 ±55km 是为了让 shadow volume 完整包围地形(Cesium 同名常量)。
	 */
	minimumHeight?: number;

	/**
	 * Shadow volume 顶面高度,米。默认 +CESIUM_GLOBE_MINIMUM_ALTITUDE = +55000。
	 */
	maximumHeight?: number;
}

/**
 * Circle 默认网格精度,弧度。
 *
 * 数值 = π/180 ≈ 0.01745329 rad(1°)。
 *
 * 这是 caller 传入的"原始值",Cesium / 本期复刻路径在
 * `computeCircleFillPositions` 内部对它 × 8.0(R4 因子)以匹配椭圆弧长
 * 而非球面弧长 — 因此实际生效粒度约 8°,默认 demo 在赤道半径下
 * `numPts = 1 + ceil(π/2 / 8°) = 12`,fill 网格 ≈ 336 顶点。
 *
 * 与矩形 / 多边形默认值(π/180/32 ≈ 0.0312°)不同 — circle 默认值故意
 * 偏粗,匹配 Cesium CircleGeometry 历史默认行为。caller 若需要更细网格,
 * 应在 plot-spec 层显式传入 granularityRadians = π/180/8 之类。
 */
export const CIRCLE_DEFAULT_GRANULARITY = Math.PI / 180.0;
