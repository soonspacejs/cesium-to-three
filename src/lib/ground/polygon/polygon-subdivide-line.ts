// ============================================================
// polygon/polygon-subdivide-line.ts — 沿"弦方向"的线段细分
// 层级:L1(基于 math/constants 的几何工具,无椭球面 Newton 投影)
// 职责:提供两个 helper:
//        1. chordLength(angle, radius) — 给定角分辨率在半径上对应的弦长(米)
//        2. subdivideLineCount(p0, p1, minDistance) — 把 p0→p1 按 minDistance
//           等分需要几段(2 的幂,与 Cesium 字节对齐)
//        3. subdivideLine(p0, p1, minDistance, out) — 输出每段起点(不含 p1
//           终点;不做 scaleToGeodeticSurface 投影,留给下游 wall 构造的
//           scaleToGeodeticHeight 一次性批处理 — 与 Cesium 字节级路径一致)
//
//      注意:本节"线段"的中间点在 chord 上(直线上),并不在椭球面上;
//      这是有意为之 — Cesium 的 wall 构造在 scaleToGeodeticHeightExtruded
//      统一把这些 chord 点投到椭球面并加高度,避免重复投影。
// 依赖:Three.js Vector3,math/constants.ts(WGS84_RADII_X 等)
// 被消费:polygon-wall-construction.ts、polygon-subdivide-triangle.ts(共享 chordLength)
// 算法对应:Cesium Source/Core/PolygonGeometryLibrary.js#subdivideLineCount(L164-174)
//          + subdivideLine(L236-275)
//          + Source/Core/Math.js#chordLength
// ============================================================

import type { Vector3 } from 'three';

/**
 * 给定弧度角分辨率与半径,算对应的弦长(米)。
 *
 * 几何意义:在以原点为中心、半径 `radius` 的球上,圆心角为 `angle`(弧度)
 * 时所对应弧段的弦长。等于 `2 · radius · sin(angle / 2)`。
 *
 * 物理意义:此值是 wall / cap 细分的"距离阈值"。任何长度超过 chord 的线段
 * 都会被细分,以让最终几何贴合椭球曲率而不是直线穿过椭球内部。
 *
 * 数值速查(radius = WGS84_MAXIMUM_RADIUS = 6378137 米):
 *   angle = π/180/64  ≈ 0.000273 rad   → chord ≈ 1740 m
 *   angle = π/180/32  ≈ 0.000546 rad   → chord ≈ 3479 m   (demo 默认 granularity)
 *   angle = π/180/16  ≈ 0.001091 rad   → chord ≈ 6957 m
 *   angle = π/180     ≈ 0.017453 rad   → chord ≈ 111312 m
 *
 * Cesium 对应:Source/Core/Math.js#chordLength
 *
 * @param angle  圆心角,弧度。
 * @param radius 球半径,米。
 * @returns      弦长,米。
 */
export function chordLength( angle: number, radius: number ): number {
	return 2.0 * radius * Math.sin( angle * 0.5 );
}

/**
 * 计算把 p0→p1 按 `minDistance` 等分需要的"等分顶点数"。
 *
 * Cesium 用 `2^ceil(log2(distance / minDistance))` 而不是 `ceil(distance / minDistance)`,
 * 是为了让 wall 顶点数始终是 2 的幂 — 与 `computeSubdivision` 三角形二分细分
 * 的递归深度兼容(每次二分对应一层 log2)。这样 cap 的 ring 边界点 ID 与 wall
 * 的 ring 边界点 ID 之间保持稳定对应关系。
 *
 * **必须复刻 Cesium 的"2 的幂"版本**,否则 V5 字节级一致测试会失败。
 *
 * Cesium 源码(逐字对应):
 *   ```js
 *   const distance = Cartesian3.distance(p0, p1);
 *   const n = distance / minDistance;
 *   const countDivide = Math.ceil(Math.log2(n));
 *   return Math.pow(2, countDivide);
 *   ```
 *
 * 边界情形:
 *   - distance ≤ minDistance:n ≤ 1 → log2(n) ≤ 0 → ceil → 0 → 2^0 = 1(不细分)
 *   - distance == 0:n = 0 → log2(0) = -∞ → ceil → -∞ → 2^-∞ = 0
 *     (零长度边贡献 0 个顶点 — 与 Cesium 一致,无需特判)
 *
 * @param p0          线段起点 ECEF。
 * @param p1          线段终点 ECEF。
 * @param minDistance 单段允许的最大弦长,米。
 * @returns           顶点数(典型为 2 的幂,零长度边返回 0)。
 */
export function subdivideLineCount(
	p0: Vector3,
	p1: Vector3,
	minDistance: number,
): number {
	// distance = |p1 - p0|;用 Three.js Vector3.distanceTo 等价 Cesium Cartesian3.distance。
	const dx = p1.x - p0.x;
	const dy = p1.y - p0.y;
	const dz = p1.z - p0.z;
	const distance = Math.sqrt( dx * dx + dy * dy + dz * dz );

	// 早退 1:零长度边(典型为 dedup 后理论不应到达,但防御性处理)。
	if ( distance === 0.0 ) {
		return 0;
	}

	// 早退 2:distance ≤ minDistance 不需要细分,直接返回 1。
	// 这同时修复了 Cesium 原始公式的一个边界问题:当 n = distance/minDistance ∈ (0, 0.5]
	// (即 distance 不到 minDistance 一半)时,`ceil(log2(n))` 取到负整数,
	// `Math.pow(2, -k)` 给出 0.5 / 0.25 / 0.125 等小数,会让下游 `(numVertices + length) × 3`
	// 变成非整数 array length → "Invalid array length" 抛错。
	// Cesium 在典型 GIS 数据下从未遇到这种小边,但 demo polygon 含 ~1km 的 hole 时会触发。
	// 该早退在 distance > minDistance/2 时与 Cesium 原公式逐字等价(`ceil(log2(<1))` 都是 0,
	// 都返回 1),仅在小边时表现得更鲁棒。
	if ( distance <= minDistance ) {
		return 1;
	}

	const n = distance / minDistance;
	const countDivide = Math.ceil( Math.log2( n ) );
	return Math.pow( 2.0, countDivide );
}

/**
 * 在 p0→p1 上等距生成 `numVertices` 个顶点(每段一个起点,**不含** p1 终点),
 * 把它们的 (x, y, z) 平铺写入 `out` 数组。
 *
 * 关键约定(必须与 Cesium 字节级一致):
 *   1. **不调用** `scaleToGeodeticSurface`。中间点在 chord 直线上,可能位于椭球面之下;
 *      下游 wall 构造的 `scaleToGeodeticHeight` 会一次性把所有点投到指定高度。
 *   2. **不写 p1 终点**。下一条边(p1 → p2)的 `subdivideLine` 输出会从 p1 开始,
 *      自然衔接,环上每个顶点只出现一次。
 *   3. 输出 `out` 长度被设为 `numVertices × 3`,**原数据被覆盖**(数组复用)。
 *
 * 输出排布(numVertices = N):
 *   out = [
 *     p0.x, p0.y, p0.z,                          // t = 0
 *     p0.x + 1/N·dx, p0.y + 1/N·dy, p0.z + 1/N·dz,   // t = 1/N
 *     p0.x + 2/N·dx, p0.y + 2/N·dy, p0.z + 2/N·dz,
 *     ...,
 *     p0.x + (N-1)/N·dx, ..., p0.z + (N-1)/N·dz,     // t = (N-1)/N
 *   ]
 *
 * Cesium 对应(逐字翻译):
 *   ```js
 *   const numVertices = PolygonGeometryLibrary.subdivideLineCount(p0, p1, minDistance);
 *   indices.length = numVertices * 3;
 *   for (let i = 0; i < numVertices; i++) {
 *     const p = pScratch;
 *     Cartesian3.subtract(p1, p0, p);                      // p = p1 - p0
 *     Cartesian3.multiplyByScalar(p, i / numVertices, p);  // p = (p1 - p0) * (i/N)
 *     Cartesian3.add(p, p0, p);                            // p = p0 + (p1 - p0) * (i/N)
 *     indices[index++] = p.x; indices[index++] = p.y; indices[index++] = p.z;
 *   }
 *   ```
 *
 * @param p0          线段起点 ECEF。
 * @param p1          线段终点 ECEF。
 * @param minDistance 单段允许的最大弦长,米。
 * @param out         输出扁平数组(原数据被覆盖;长度被重设为 numVertices × 3)。
 * @returns           out(链式调用);当零长度边时 out.length = 0,无写入。
 */
export function subdivideLine(
	p0: Vector3,
	p1: Vector3,
	minDistance: number,
	out: number[],
): number[] {
	const numVertices = subdivideLineCount( p0, p1, minDistance );

	// 零长度边:numVertices = 0,直接清空输出并返回。
	if ( numVertices === 0 ) {
		out.length = 0;
		return out;
	}

	out.length = numVertices * 3;

	const dx = p1.x - p0.x;
	const dy = p1.y - p0.y;
	const dz = p1.z - p0.z;

	let writeIndex = 0;
	for ( let i = 0; i < numVertices; i++ ) {
		const t = i / numVertices;
		out[ writeIndex++ ] = p0.x + t * dx;
		out[ writeIndex++ ] = p0.y + t * dy;
		out[ writeIndex++ ] = p0.z + t * dz;
	}

	return out;
}
