// ============================================================
// math/constants.ts — WGS84 椭球与数值容差常量
// 层级:L0(零依赖数学基础)
// 职责:集中维护矩形/多边形几何路径需要的全部 WGS84 椭球参数与
//      Newton 迭代/网格化用的数值容差常量。所有常量精确到 IEEE-754
//      Float64 全位数,以保证与 Cesium 字节级一致的下游运算。
// 依赖:无
// 被消费:math/ellipsoid.ts、math/enu-frame.ts、rectangle/rectangle-grid.ts、
//        rectangle/rectangle-options.ts、rectangle/rectangle-shadow-volume.ts
// 算法对应:Cesium Source/Core/Ellipsoid.js#WGS84(L762-764)+ Source/Core/Math.js#EPSILON*
// ============================================================

// WGS84 半长轴(米),沿 ECEF x 轴。Cesium Ellipsoid.WGS84 第一项参数。
export const WGS84_RADII_X = 6378137.0;

// WGS84 半长轴(米),沿 ECEF y 轴。与 x 轴相同(椭球绕 z 轴旋转对称)。
export const WGS84_RADII_Y = 6378137.0;

// WGS84 半短轴(米),沿 ECEF z 轴。a · (1 − f) = 6378137 · (1 − 1/298.257223563)。
export const WGS84_RADII_Z = 6356752.3142451793;

// 半长轴平方,常用于法向 / Newton 迭代展开。预算避免热路径上重复乘法。
export const WGS84_RADII_X_SQ = WGS84_RADII_X * WGS84_RADII_X;
export const WGS84_RADII_Y_SQ = WGS84_RADII_Y * WGS84_RADII_Y;
export const WGS84_RADII_Z_SQ = WGS84_RADII_Z * WGS84_RADII_Z;

// 半轴倒数,用于把 ECEF 坐标除以椭球半轴(等价于规一化到单位球空间)。
export const WGS84_ONE_OVER_RADII_X = 1.0 / WGS84_RADII_X;
export const WGS84_ONE_OVER_RADII_Y = 1.0 / WGS84_RADII_Y;
export const WGS84_ONE_OVER_RADII_Z = 1.0 / WGS84_RADII_Z;

// 半轴平方倒数,scaleToGeodeticSurface 和 geodeticSurfaceNormal 高频使用。
export const WGS84_ONE_OVER_RADII_X_SQ = 1.0 / WGS84_RADII_X_SQ;
export const WGS84_ONE_OVER_RADII_Y_SQ = 1.0 / WGS84_RADII_Y_SQ;
export const WGS84_ONE_OVER_RADII_Z_SQ = 1.0 / WGS84_RADII_Z_SQ;

// Cesium 数值容差:
//   EPSILON1  用于 scaleToGeodeticSurface 的退化判定(squaredNorm 阈值 0.1)
//   EPSILON10 用于墙循环中角点重复判定(ECEF 量级 1e7 上等价 ~1e-3 m)
//   EPSILON12 用于 Newton 迭代收敛终止条件
//   EPSILON14 用于 ENU 极点 / 中心退化判定
export const EPSILON1 = 0.1;
export const EPSILON10 = 1.0e-10;
export const EPSILON12 = 1.0e-12;
export const EPSILON14 = 1.0e-14;

// scaleToGeodeticSurface 中:squaredNorm < CENTER_TOLERANCE_SQUARED 时走径向投影
// 兜底分支(避免 Newton 在椭球中心附近发散)。Cesium 同名常量值为 EPSILON1。
export const CENTER_TOLERANCE_SQUARED = EPSILON1;

// 矩形默认网格精度(弧度),≈ 1° / 32 ≈ 0.0009817477 rad。
// Cesium RectangleGeometry 默认值,本期 demo 使用此值产生 3×3 网格。
export const RECTANGLE_DEFAULT_GRANULARITY = Math.PI / 180.0 / 32.0;

// scaleToGeodeticSurface 防御性迭代上限:理论 2-3 次收敛,100 次足够覆盖
// 任何病态输入并避免浏览器卡死。超出抛 Error,由上层捕获。
export const NEWTON_MAX_ITERATIONS = 100;
