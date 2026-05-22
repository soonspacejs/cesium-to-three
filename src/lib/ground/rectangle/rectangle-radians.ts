// ============================================================
// rectangle/rectangle-radians.ts — 矩形(弧度)的基础数据结构与 ops
// 层级:L1(基于 math/cartographic)
// 职责:替代 Cesium Core/Rectangle 在矩形几何路径上的所有使用点。
//      提供:
//        - 接口 RectangleRadians(从 types.ts re-export 已有定义)
//        - rectangleRadiansFromDegrees(度→弧度构造)
//        - cloneRectangleRadians(克隆,供下游修改前备份)
//        - rectangleCenter(矩形中心 cartographic;非跨 IDL 算术平均)
//        - rectangleNorthwest(NW 角点 cartographic,网格起点)
//      本期不支持跨 IDL 矩形(west > east),由下游 grid 层校验拒绝。
// 依赖:math/cartographic.ts、types.ts(re-export RectangleRadians)
// 被消费:rectangle-grid.ts、rectangle-construct-cap.ts、
//        rectangle-construct-extruded.ts、rectangle-shadow-volume.ts、
//        rectangle-extents.ts、primitives.ts(CesiumGroundRectanglePrimitive)
// 算法对应:Cesium Source/Core/Rectangle.js#fromDegrees(L184-203)
//          + clone(L97-117) + center(L425-454) + northwest(L336-356)
// ============================================================

import type { Cartographic } from '../math/cartographic';
import type { RectangleRadians } from '../types';

export type { RectangleRadians } from '../types';

/**
 * 由度数构造 RectangleRadians(弧度)。
 *
 * 注意:本函数**不做 IDL 规范化**(Cesium 会把 west=170, east=-170 视为
 * 跨 IDL 矩形并保留 west > east 状态),本期下游严格要求 west < east,
 * 跨 IDL 路径在 rectangle-grid.ts 校验阶段抛错。
 *
 * @param westDegrees  西边经度,度(范围典型 [-180, 180])。
 * @param southDegrees 南边纬度,度(范围 [-90, 90])。
 * @param eastDegrees  东边经度,度。
 * @param northDegrees 北边纬度,度。
 * @returns            RectangleRadians 新对象。
 */
export function rectangleRadiansFromDegrees(
	westDegrees: number,
	southDegrees: number,
	eastDegrees: number,
	northDegrees: number,
): RectangleRadians {
	const DEG_TO_RAD = Math.PI / 180.0;
	return {
		west: westDegrees * DEG_TO_RAD,
		south: southDegrees * DEG_TO_RAD,
		east: eastDegrees * DEG_TO_RAD,
		north: northDegrees * DEG_TO_RAD,
	};
}

/**
 * 克隆一个 RectangleRadians。
 *
 * 用于在下游算法准备修改原矩形之前先备份;也用于把外部传入的矩形
 * (可能是 Cesium Rectangle 实例,带额外原型方法)规整为纯字段对象。
 *
 * @param rect 源矩形(只读)。
 * @param out  可选输出对象,若提供则原地写入;否则新建。
 * @returns    输出矩形。
 */
export function cloneRectangleRadians(
	rect: RectangleRadians,
	out?: RectangleRadians,
): RectangleRadians {
	if ( out !== undefined ) {
		out.west = rect.west;
		out.south = rect.south;
		out.east = rect.east;
		out.north = rect.north;
		return out;
	}
	return { west: rect.west, south: rect.south, east: rect.east, north: rect.north };
}

/**
 * 矩形中心 cartographic。
 *
 * 非跨 IDL 路径:`lon = (west + east) / 2`,`lat = (south + north) / 2`。
 * 跨 IDL(west > east)路径由 Cesium 处理为 `lon = (west + east + 2π) / 2 mod 2π`,
 * 本期不支持,故只算术平均。
 *
 * @param rect            输入矩形。
 * @param outCartographic 输出 cartographic(原地写入,height 设为 0)。
 * @returns               outCartographic。
 */
export function rectangleCenter(
	rect: RectangleRadians,
	outCartographic: Cartographic,
): Cartographic {
	outCartographic.longitude = ( rect.west + rect.east ) * 0.5;
	outCartographic.latitude = ( rect.south + rect.north ) * 0.5;
	outCartographic.height = 0.0;
	return outCartographic;
}

/**
 * 矩形 NW 角点 cartographic(网格起点)。
 *
 * NW = (west, north),height = 0。Cesium `Rectangle.northwest` 行为一致。
 *
 * @param rect            输入矩形。
 * @param outCartographic 输出 cartographic(原地写入)。
 * @returns               outCartographic。
 */
export function rectangleNorthwest(
	rect: RectangleRadians,
	outCartographic: Cartographic,
): Cartographic {
	outCartographic.longitude = rect.west;
	outCartographic.latitude = rect.north;
	outCartographic.height = 0.0;
	return outCartographic;
}
