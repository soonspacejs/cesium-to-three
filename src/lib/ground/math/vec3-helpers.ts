// ============================================================
// math/vec3-helpers.ts — Three.js Vector3 之外的辅助函数
// 层级:L0(零依赖数学基础,基于 Three.js Vector3)
// 职责:复刻 Cesium Cartesian3 在矩形路径上用到的 4 个 ops。
//      Three 的 Vector3 已经覆盖加 / 减 / 乘 / 归一化 / 模长平方,
//      此处只补 Cesium 风格特有的 fromArray / equalsEpsilon /
//      multiplyComponents / magnitudeSquared。
// 依赖:Three.js Vector3
// 被消费:math/ellipsoid.ts、math/enu-frame.ts、rectangle/*
// 算法对应:Cesium Source/Core/Cartesian3.js#fromArray + equalsEpsilon
//          + multiplyComponents + magnitudeSquared
// ============================================================

import { Vector3 } from 'three';

/**
 * 从 Float64Array / Float32Array / number[] 的 (offset, offset+1, offset+2)
 * 三个分量读入一个 Vector3,等价 Cesium `Cartesian3.fromArray(arr, offset, out)`。
 *
 * 调用方负责保证 array 与 offset 范围有效,本函数不做边界检查
 * (热路径上由调用上下文 invariant 保证)。
 *
 * @param array  数据源(支持 TypedArray / 普通数组)。
 * @param offset 起始下标(读取 array[offset..offset+2])。
 * @param out    输出 Vector3(原地修改),便于 scratch 复用。
 * @returns      out(链式调用)。
 */
export function vec3FromArrayInto(
	array: ArrayLike<number>,
	offset: number,
	out: Vector3,
): Vector3 {
	out.x = array[ offset ];
	out.y = array[ offset + 1 ];
	out.z = array[ offset + 2 ];
	return out;
}

/**
 * 两个 Vector3 在 EPSILON 容差内是否相等。
 *
 * 用绝对差(component-wise abs ≤ epsilon),等价 Cesium 的 absolute 模式。
 * Cesium 同名 API 还支持 relative epsilon,但矩形路径只需 absolute。
 *
 * @param a       第一个向量。
 * @param b       第二个向量。
 * @param epsilon 各分量绝对差上限(含等号)。
 * @returns       三个分量都在容差内为 true。
 */
export function vec3EqualsEpsilon( a: Vector3, b: Vector3, epsilon: number ): boolean {
	return (
		Math.abs( a.x - b.x ) <= epsilon &&
		Math.abs( a.y - b.y ) <= epsilon &&
		Math.abs( a.z - b.z ) <= epsilon
	);
}

/**
 * 分量乘法,等价 Cesium `Cartesian3.multiplyComponents(a, b, out)`:
 * out = (a.x · b.x, a.y · b.y, a.z · b.z)。
 *
 * Three 的 `Vector3.multiply(other)` 也是分量乘,但语义 = self.multiply(other),
 * 不支持 out 参数 / 不允许 a 与 b 同向 out。封装一遍以匹配 Cesium 调用方式。
 *
 * @param a   左乘向量。
 * @param b   右乘向量。
 * @param out 输出向量(可与 a 或 b 同实例)。
 * @returns   out(链式调用)。
 */
export function vec3MultiplyComponents( a: Vector3, b: Vector3, out: Vector3 ): Vector3 {
	out.x = a.x * b.x;
	out.y = a.y * b.y;
	out.z = a.z * b.z;
	return out;
}

/**
 * 向量模长平方(x² + y² + z²)。
 *
 * 与 Three `Vector3.lengthSq()` 等价,提供同名函数仅为对照
 * Cesium `Cartesian3.magnitudeSquared` 调用风格,避免上下文切换。
 *
 * @param v 输入向量(不修改)。
 * @returns 模长的平方(米²)。
 */
export function vec3MagnitudeSquared( v: Vector3 ): number {
	return v.x * v.x + v.y * v.y + v.z * v.z;
}
