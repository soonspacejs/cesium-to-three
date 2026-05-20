// ============================================================
// rectangle/rectangle-options.ts — 矩形 shadow volume 几何选项
// 层级:L1(基于 rectangle-radians + math/constants)
// 职责:声明 L4 几何构造层(buildRectangleShadowVolumeGeometry)的
//      输入选项类型 `RectangleShadowVolumeOptions`,并 re-export 默认值
//      常量,便于上层(primitives.ts)在不依赖 math/constants 的情况下
//      引用默认 granularity。
// 依赖:rectangle-radians.ts、math/constants.ts
// 被消费:rectangle-shadow-volume.ts、primitives.ts(CesiumGroundRectanglePrimitive)
// ============================================================

import { RECTANGLE_DEFAULT_GRANULARITY } from '../math/constants';
import type { RectangleRadians } from './rectangle-radians';

export { RECTANGLE_DEFAULT_GRANULARITY } from '../math/constants';

/**
 * L4 几何构造层选项,送给 `buildRectangleShadowVolumeGeometry`。
 *
 * - `rectangle`:必填,矩形(弧度)。由 caller(primitives.ts)用
 *   `rectangleRadiansFromDegrees` 把 degree 矩形转换得到。
 * - `granularity`:可选,网格精度(弧度)。默认 RECTANGLE_DEFAULT_GRANULARITY
 *   (= π/180/32 ≈ 0.000982 rad)。
 * - `minimumHeight` / `maximumHeight`:可选,shadow volume 底面 / 顶面高度
 *   (米)。默认 ±CESIUM_GLOBE_MINIMUM_ALTITUDE(±55000 m,常量定义在
 *   `constants.ts`,本期保留)。
 */
export interface RectangleShadowVolumeOptions {
	rectangle: RectangleRadians;
	granularity?: number;
	minimumHeight?: number;
	maximumHeight?: number;
}

// 重新导出默认值常量,便于 caller 直接引用而无需深入 math/ 内部模块。
// 实际默认 minimumHeight / maximumHeight 在 rectangle-shadow-volume.ts 内部
// 通过 CESIUM_GLOBE_MINIMUM_ALTITUDE 解析(由 ground/constants.ts 提供)。
export const DEFAULT_RECTANGLE_GRANULARITY = RECTANGLE_DEFAULT_GRANULARITY;
