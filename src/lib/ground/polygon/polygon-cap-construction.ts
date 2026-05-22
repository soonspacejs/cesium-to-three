// ============================================================
// polygon/polygon-cap-construction.ts — Polygon 顶面三角网格构造
// 层级:L3(组合 polygon-rings + triangulation + polygon-subdivide-triangle)
// 职责:把 PolygonHierarchy 转换为顶面网格:
//        1. processPolygonRings → 切平面 + 合并 2D 顶点 + holeStartIndices
//        2. triangulate(positions2D, holeStartIndices) → earcut 三角索引
//        3. computeSubdivision(positions3D, rawIndices, granularity) → 细分到 chord
//      返回 PolygonCapResult,顶点 = 原 ring + 新增 subdivision 中点(扁平 Float64),
//      三角形索引按 vertexCount 选 Uint16 / Uint32。
// 依赖:polygon-rings.ts、triangulation.ts、polygon-subdivide-triangle.ts、
//      rectangle/rectangle-attributes.ts(createIndexTypedArray)、
//      ellipsoid-tangent-plane.ts(类型) 、polygon-hierarchy.ts(类型)
// 被消费:polygon-construct-extruded.ts
// 算法对应:Cesium Source/Core/PolygonGeometryLibrary.js#createGeometryFromPositions(L965-1042)
//          注:Cesium 同名函数还产 textureCoordinates,本期 shadow volume 不消费 st,
//          故本函数不输出 st 数组,只产 positions + indices。
// ============================================================

import { createIndexTypedArray } from '../rectangle/rectangle-attributes';
import type { EllipsoidTangentPlane } from './ellipsoid-tangent-plane';
import type { PolygonHierarchy } from './polygon-hierarchy';
import { computeSubdivision } from './polygon-subdivide-triangle';
import { processPolygonRings } from './polygon-rings';
import { triangulate } from './triangulation';

/**
 * Polygon cap(顶面)构造结果。
 *
 * - `positions`:Float64 ECEF 顶点(在椭球面上),长度 = 3 × vertexCount。
 *   vertexCount = 原 ring 顶点总数(外环 + holes 合并)+ subdivision 新增中点数。
 *   subdivision 中点在 ring 顶点之后追加(由 computeSubdivision 实现保证)。
 *   ⚠️ 注意:cap.positions 是 Float64Array,**下游 scaleToGeodeticHeight 会原地修改它**
 *   — 调用方若需要保留原始 cap.positions,自行 slice() 一份。
 *
 * - `indices`:顶面三角形索引,vertexCount ≤ 65535 时为 Uint16Array,否则 Uint32Array。
 *
 * - `tangentPlane`:切平面(从 processPolygonRings 透传);
 *   polygon-extents.ts / polygon-style-points.ts 在更上层可能用得到。
 *
 * - `rings`:原始 ring 边界数组(**不含 subdivision 新中点**)。
 *   排列:[ 外环信息, hole_0 信息, hole_1 信息, ... ]。
 *   `startIndex` 与 `length` 在 `positions[0..originalRingTotal × 3)` 子区间内有效。
 *   polygon-wall-construction.ts 用它遍历每个 ring 的边界顶点产 wall。
 */
export interface PolygonCapResult {
	positions: Float64Array;
	indices: Uint16Array | Uint32Array;
	tangentPlane: EllipsoidTangentPlane;
	rings: { startIndex: number; length: number }[];
}

/**
 * 从 PolygonHierarchy 构造顶面三角网格(在椭球面上的 cap)。
 *
 * 算法(5 步):
 *   1. processPolygonRings(hierarchy):
 *      → { positions: Vector3[], positions2D: Vector2[],
 *          holeStartIndices: number[], tangentPlane, rings }
 *
 *   2. triangulate(positions2D, holeStartIndices):
 *      → number[],每 3 个一组 = 一个三角形;顶点 ID 在 positions 数组的索引空间。
 *
 *   3. computeSubdivision(positions, rawIndices, granularity):
 *      → { positions: Float64Array, indices: Uint32Array }
 *      ECEF 顶点扩充为(原 + 中点)的 Float64 数组;索引指向扩充后顶点。
 *
 *   4. 索引类型选择:
 *      vertexCount = positions.length / 3
 *      若 ≤ 65535 → 拷一份到 Uint16Array(GPU 上传更省 buffer,WebGL 1 默认即支持)
 *      否则保持 Uint32Array
 *
 *   5. 返回 PolygonCapResult。`rings` 字段从 processPolygonRings 透传,
 *      **仍指向 ring 边界顶点 ID**(不包含 subdivision 中点 — 中点 ID ≥ ring 总长度)。
 *
 * @param hierarchy   Polygon hierarchy(已被 polygon-hierarchy.ts 转为 Vector3 ECEF)。
 * @param granularity 角分辨率(弧度),控制 subdivision 阈值。
 * @returns           PolygonCapResult。
 */
export function constructPolygonCap(
	hierarchy: PolygonHierarchy,
	granularity: number,
): PolygonCapResult {
	// 步骤 1 · Ring 处理(scale + dedup + project + winding 校正)
	const processed = processPolygonRings( hierarchy );

	// 步骤 2 · earcut 三角剖分(基于切平面 2D 坐标 + 洞起始下标)
	// `holeStartIndices` 在无 hole 时为空数组 — earcut 接受 [] 与 undefined 行为一致,
	// 但为了与 Cesium PolygonPipeline.triangulate 调用风格一致,无 hole 时传 undefined。
	const rawCapIndices = triangulate(
		processed.positions2D,
		processed.holeStartIndices.length > 0 ? processed.holeStartIndices : undefined,
	);

	// 步骤 3 · 三角形递归细分(切边切到所有边 ≤ chord 距离)
	// computeSubdivision 内部:
	//   - 把 processed.positions(Vector3[])扁平化到 number[] (= 原始 N 顶点)
	//   - 用 LIFO 栈处理三角形,共享边只切一次(edges 字典)
	//   - 新中点追加到 subdividedPositions(中点 ID 从 N 开始递增)
	//   - 接受的三角形 push 到 subdividedIndices
	const subdivision = computeSubdivision(
		processed.positions,
		rawCapIndices,
		granularity,
	);

	// 步骤 4 · 索引类型选择
	const vertexCount = subdivision.positions.length / 3;
	const indexCount = subdivision.indices.length;
	const finalIndices = createIndexTypedArray( vertexCount, indexCount );
	// createIndexTypedArray 返回 Uint16Array 或 Uint32Array — set 兼容 Uint32Array
	// 输入(JS TypedArray.set 内部做 number 拷贝,自动截断)。
	// 注:若 vertexCount > 65535 但 indices 值 ≤ 65535(罕见),Uint32Array 仍然正确。
	finalIndices.set( subdivision.indices );

	// 步骤 5 · 返回
	return {
		positions: subdivision.positions,
		indices: finalIndices,
		tangentPlane: processed.tangentPlane,
		rings: processed.rings,
	};
}
