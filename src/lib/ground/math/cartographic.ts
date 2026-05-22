// ============================================================
// math/cartographic.ts — Cartographic 数据结构(经度/纬度/高度)
// 层级:L0(零依赖数学基础)
// 职责:替代 Cesium Core/Cartographic 在矩形路径上的所有使用点。
//      提供轻量 plain-object 结构(无类、无原型链)以便:
//        - 模块级 scratch 反复复用而不分配
//        - V8 隐藏类稳定,代码热路径上零隐式 megamorphic 调用
// 依赖:无
// 被消费:math/ellipsoid.ts、rectangle/rectangle-radians.ts、
//        rectangle/rectangle-grid.ts、rectangle/rectangle-extents.ts、
//        rectangle/rectangle-helpers.ts、rectangle/rectangle-debug.ts
// 算法对应:Cesium Source/Core/Cartographic.js(构造器 L25-50)
// ============================================================

/**
 * WGS84 地理坐标三元组,经纬度以弧度表示,高度以米表示。
 *
 * 与 Cesium `Cartographic` 字段名 / 字段顺序完全一致,以便外部代码
 * 1:1 迁移。本类型故意不带 prototype 方法,所有操作放在自由函数中,
 * 便于 scratch 复用与 tree-shaking。
 */
export interface Cartographic {
	/** 经度,弧度(范围 [-π, π],跨 IDL 时需调用方自行规整) */
	longitude: number;

	/** 纬度,弧度(范围 [-π/2, π/2]) */
	latitude: number;

	/** 椭球面以上高度,米(可以为负,表示椭球面以下) */
	height: number;
}

/**
 * 创建一个 Cartographic 实例(plain object)。
 *
 * 三个参数都有默认值 0,便于模块级 scratch 在顶部声明时初始化。
 *
 * @param longitude 经度,弧度。默认 0。
 * @param latitude  纬度,弧度。默认 0。
 * @param height    高度,米。默认 0(椭球表面)。
 * @returns Cartographic 实例(独立对象,无共享引用)。
 */
export function createCartographic(
	longitude = 0.0,
	latitude = 0.0,
	height = 0.0,
): Cartographic {
	return { longitude, latitude, height };
}
