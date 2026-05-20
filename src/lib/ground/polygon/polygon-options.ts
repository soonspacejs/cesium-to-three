// ============================================================
// polygon/polygon-options.ts — Polygon 几何构造选项类型 + 默认值常量
// 层级:L0(零依赖,仅 import 类型与 hierarchy 接口)
// 职责:定义 buildPolygonShadowVolumeGeometry 与 constructExtrudedPolygonShadowVolume
//      接受的选项类型,并集中维护本期 polygon 路径全部默认值常量。
//      命名与矩形阶段 RectangleShadowVolumeOptions / RECTANGLE_DEFAULT_GRANULARITY
//      同形,确保两条路径风格一致。
// 依赖:polygon-hierarchy.ts(PolygonHierarchy 接口),无运行时依赖。
// 被消费:polygon-shadow-volume.ts、polygon-construct-extruded.ts、primitives.ts
// 算法对应:类比 rectangle/rectangle-options.ts,本期 polygon 独立常量空间。
// ============================================================

import type { PolygonHierarchy } from './polygon-hierarchy';

/**
 * Polygon shadow volume 几何构造选项。
 *
 * 与矩形 `RectangleShadowVolumeOptions` 同形:`hierarchy` 必填,其它三个为
 * 可选(由 caller 留空时使用本文件下方的默认值常量)。
 */
export interface PolygonShadowVolumeOptions {
	/**
	 * Polygon hierarchy:外环 + 0..M 个洞,均为椭球面 ECEF Vector3。
	 * 调用前应已通过 `polygonHierarchyFromLonLatPoints` 校验与转换。
	 */
	hierarchy: PolygonHierarchy;

	/**
	 * 网格精度,弧度。控制墙边 chord 距离阈值与顶面三角形细分粒度。
	 * 默认 POLYGON_DEFAULT_GRANULARITY = π/180/32 ≈ 0.000982 rad
	 * → 对应 chord ≈ 3479 m @ WGS84 赤道半径。
	 */
	granularity?: number;

	/**
	 * Shadow volume 底面高度,米。默认 -CESIUM_GLOBE_MINIMUM_ALTITUDE = -55000。
	 * 选择 ±55km 是为了使 shadow volume 完整包围地形(Cesium 同名常量)。
	 */
	minimumHeight?: number;

	/**
	 * Shadow volume 顶面高度,米。默认 +CESIUM_GLOBE_MINIMUM_ALTITUDE = +55000。
	 */
	maximumHeight?: number;
}

/**
 * Polygon 默认网格精度,弧度。
 *
 * 数值 = π/180/32 ≈ 0.0009817477 rad ≈ 0.03125°。
 * 与矩形 `RECTANGLE_DEFAULT_GRANULARITY` 同值但分别定义 — 让两个几何路径
 * 在未来可以独立调整默认值而不互相影响(本期 demo 都用相同 granularity)。
 *
 * 对应 chord 距离:`2 · 6378137 · sin(granularity / 2) ≈ 3479 m`,
 * 即任何长度超过 ~3.5km 的多边形边都会被进一步细分。
 */
export const POLYGON_DEFAULT_GRANULARITY = Math.PI / 180.0 / 32.0;
