// ============================================================
// math/matrix4-helpers.ts — Three.js Matrix4 之外的辅助函数
// 层级:L0(零依赖数学基础,基于 Three.js Matrix4 + Vector3)
// 职责:封装 Cesium `Matrix4.multiplyByPoint(m, p, out)` 的语义:
//        out = m · [p.x, p.y, p.z, 1]^T(齐次扩展为点变换)
//      Three 的 `Vector3.applyMatrix4(m)` 等价但调用方向相反
//      (p.applyMatrix4(m) 而非 multiplyByPoint(m, p, out)),且
//      不支持 out 参数。封装以匹配 Cesium 调用风格 + 零分配。
// 依赖:Three.js Matrix4 + Vector3
// 被消费:rectangle/rectangle-helpers.ts、rectangle/rectangle-extents.ts、
//        rectangle/rectangle-debug.ts(未直接使用,但保留接口预留)
// 算法对应:Cesium Source/Core/Matrix4.js#multiplyByPoint(L1593-1620)
// ============================================================

import type { Matrix4, Vector3 } from 'three';

/**
 * 4×4 矩阵乘以 3D 点(齐次坐标 w = 1)。
 *
 * 公式(列主序矩阵):
 *   out.x = e[0]·p.x + e[4]·p.y + e[8]·p.z  + e[12]
 *   out.y = e[1]·p.x + e[5]·p.y + e[9]·p.z  + e[13]
 *   out.z = e[2]·p.x + e[6]·p.y + e[10]·p.z + e[14]
 *
 * 等价 Cesium `Matrix4.multiplyByPoint(matrix, cartesian, result)`,
 * 同样支持 result === cartesian(原地变换),因为先把 p.x/y/z 读到
 * 局部变量再写回 out。
 *
 * @param matrix 4×4 列主序变换矩阵(Three Matrix4)。
 * @param point  输入点(可与 out 同实例)。
 * @param out    输出向量(原地写入)。
 * @returns      out(链式调用)。
 */
export function matrix4MultiplyByPoint(
	matrix: Matrix4,
	point: Vector3,
	out: Vector3,
): Vector3 {
	const e = matrix.elements;
	// 读到局部变量,允许 point === out(原地变换)。
	const x = point.x;
	const y = point.y;
	const z = point.z;

	out.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
	out.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
	out.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];
	return out;
}
