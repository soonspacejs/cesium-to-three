// ============================================================
// polygon/polygon-subdivide-triangle.ts — 顶面三角形递归边切分
// 层级:L2(基于 polygon-subdivide-line 共享的 chordLength + math/constants)
// 职责:把一组三角形(以 positions + indices 表达)的每条边按 chord 距离判定,
//      若超长则切中点(取 v0 / v1 的算术中点,与 Cesium 完全一致 — **不做**
//      scaleToGeodeticSurface 投影),把原三角形拆成 2 个子三角形继续递归,
//      共享边只切一次(edges 字典)。
//      最终顶点 = 原 ring 顶点 + 所有 subdivision 新中点(按生成顺序追加),
//      最终三角形 = 所有边都 ≤ minDistance 的三角形集合。
// 依赖:Three.js Vector3,math/constants.ts(WGS84_RADII_X)
//      polygon-subdivide-line.ts(chordLength,共享 helper)
// 被消费:polygon-cap-construction.ts
// 算法对应:Cesium Source/Core/PolygonPipeline.js#computeSubdivision(L101-316)
//          严格逐行复刻 — 这是 V5 字节级一致的关键模块(R3)。
// ============================================================

import { Vector3 } from 'three';

import { WGS84_RADII_X } from '../math/constants';
import { chordLength } from './polygon-subdivide-line';

// 模块级 scratch:v0/v1/v2 读取临时存放,scaleToSphereRadius 中间向量
// 与 mid 中点。Cesium 的命名也是 V0Scratch / S0Scratch / MidScratch,逐字对齐。
const _subdivisionV0Scratch = new Vector3();
const _subdivisionV1Scratch = new Vector3();
const _subdivisionV2Scratch = new Vector3();
const _subdivisionS0Scratch = new Vector3();
const _subdivisionS1Scratch = new Vector3();
const _subdivisionS2Scratch = new Vector3();
const _subdivisionMidScratch = new Vector3();

/**
 * computeSubdivision 输出。
 *
 * - `positions`:Float64Array,长度 = 3 × (原顶点数 + 新中点数)。
 *   ECEF 量级 1e7 需要 Float64 精度;下游 scaleToGeodeticHeight 会原地修改此数组。
 * - `indices`:Uint32Array,长度 = 3 × 最终三角形数。
 *   细分后顶点数可能 > 65535,统一用 Uint32 以匹配 Cesium 同名 API 的最坏情况;
 *   下游可在装配 BufferGeometry 时再降级为 Uint16Array(若 vertexCount ≤ 65535)。
 */
export interface PolygonSubdivisionResult {
	positions: Float64Array;
	indices: Uint32Array;
}

/**
 * 把一组三角形按 granularity 对应的 chord 距离递归切分。
 *
 * 算法概览(LIFO 栈 + edges 字典):
 *   1. 初始 triangles = indices.slice()(每 3 个一组,每次 pop 取 i2/i1/i0)
 *   2. 主循环 while (triangles.length > 0):
 *      a. pop 三个索引 → 三角形 (i0, i1, i2)
 *      b. 从 subdividedPositions 读 v0/v1/v2(原始 ECEF)
 *      c. 把 v0/v1/v2 各自归一化后乘以 maximumRadius,得到 s0/s1/s2
 *         (即把椭球面顶点"映射"到半径 = maximumRadius 的球面上)
 *      d. 计算 s0/s1/s2 两两之间距离平方:g0 = |s0-s1|², g1 = |s1-s2|², g2 = |s2-s0|²
 *      e. max = max(g0, g1, g2)
 *      f. 若 max > minDistanceSqrd:切 max 对应的最长边
 *         · edge key = `${min(i,j)} ${max(i,j)}`(单空格分隔,Cesium 严格格式)
 *         · 若 edges[key] 未定义:mid = (v0 + v1) * 0.5 → 追加到 subdividedPositions
 *           → midId = positions.length / 3 - 1 → 缓存 edges[key] = midId
 *         · 拆三角形并 push 回栈(顺序严格匹配 Cesium):
 *           g0:push(i0, mid, i2); push(mid, i1, i2)
 *           g1:push(i1, mid, i0); push(mid, i2, i0)
 *           g2:push(i2, mid, i1); push(mid, i0, i1)
 *      g. 否则(max ≤ minDistanceSqrd):接受三角形 → subdividedIndices.push(i0, i1, i2)
 *   3. 把 number[] 转 Float64Array / Uint32Array 返回。
 *
 * 关键约定(必须与 Cesium 字节级一致 — R3):
 *   - **不做** scaleToGeodeticSurface 投影。mid = 算术中点,**在椭球内部**,
 *     下游 scaleToGeodeticHeight 会一次性把所有点投到指定高度。
 *   - **不使用** Float64Array 在中间步骤(用 plain number[],push 追加);最后才转。
 *     这避免 ensureCapacity 复杂度,且匹配 Cesium 的 `subdividedPositions.push(...)` 路径。
 *   - **三角形 push 顺序** 严格匹配 Cesium L245-246 / L265-266 / L285-286。任何调换
 *     会改变后续 pop 顺序,从而改变新 midpoint 的顶点 ID。
 *   - **距离判定基于球面投影点 s0/s1/s2**(非原始 v0/v1/v2),Cesium 该路径就是这样。
 *
 * @param positions    顶点 ECEF 数组(由 polygon-rings 产出,顶点已在椭球面上)。
 * @param indices      三角形索引(由 earcut 产出),长度必须 ≥ 3 且为 3 的倍数。
 * @param granularity  角分辨率(弧度),控制 minDistance 阈值。
 * @returns            { positions: Float64Array, indices: Uint32Array }
 */
export function computeSubdivision(
	positions: readonly Vector3[],
	indices: readonly number[],
	granularity: number,
): PolygonSubdivisionResult {
	if ( indices.length < 3 || indices.length % 3 !== 0 ) {
		throw new Error(
			`computeSubdivision: indices.length must be ≥ 3 and divisible by 3, got ${ indices.length }.`,
		);
	}
	if ( ! ( granularity > 0.0 ) ) {
		throw new Error(
			`computeSubdivision: granularity must be > 0, got ${ granularity }.`,
		);
	}

	// ── triangles 栈:LIFO,初始 = indices 的浅拷贝 ──
	// 用 Array.prototype.slice 等价 Cesium `indices.slice(0)`。
	const triangles: number[] = indices.slice();

	// ── subdividedPositions:扁平 [x, y, z, x, y, z, ...] 数组 ──
	// 初始填入原始顶点,之后追加 subdivision 新中点。匹配 Cesium 的
	// `new Array(length * 3)` + 后续 push 行为。
	const length = positions.length;
	const subdividedPositions: number[] = new Array( length * 3 );
	let writeIdx = 0;
	for ( let i = 0; i < length; i++ ) {
		const item = positions[ i ];
		subdividedPositions[ writeIdx++ ] = item.x;
		subdividedPositions[ writeIdx++ ] = item.y;
		subdividedPositions[ writeIdx++ ] = item.z;
	}

	// ── 输出索引数组(plain number[],最后转 Uint32Array)──
	const subdividedIndices: number[] = [];

	// ── 共享边字典:key = `"${min(i,j)} ${max(i,j)}"`,value = 中点顶点 ID ──
	// 用 Object.create(null) 避免与 Object.prototype 上原有属性冲突。
	const edges: Record<string, number> = Object.create( null );

	// ── 距离阈值 ──
	// Cesium `ellipsoid.maximumRadius` 对 WGS84 = max(a, b, c) = 6378137 = WGS84_RADII_X。
	// 把所有顶点先投到这个半径的球面,然后比较两两距离 — 等价于在统一球面上比较弧长。
	const radius = WGS84_RADII_X;
	const minDistance = chordLength( granularity, radius );
	const minDistanceSqrd = minDistance * minDistance;

	// ── 主循环 ──
	while ( triangles.length > 0 ) {
		// pop 顺序 i2 → i1 → i0(必须严格按 Cesium L154-156)
		const i2 = triangles.pop() as number;
		const i1 = triangles.pop() as number;
		const i0 = triangles.pop() as number;

		// 读取三个顶点(scratch 复用)
		_subdivisionV0Scratch.set(
			subdividedPositions[ i0 * 3 ],
			subdividedPositions[ i0 * 3 + 1 ],
			subdividedPositions[ i0 * 3 + 2 ],
		);
		_subdivisionV1Scratch.set(
			subdividedPositions[ i1 * 3 ],
			subdividedPositions[ i1 * 3 + 1 ],
			subdividedPositions[ i1 * 3 + 2 ],
		);
		_subdivisionV2Scratch.set(
			subdividedPositions[ i2 * 3 ],
			subdividedPositions[ i2 * 3 + 1 ],
			subdividedPositions[ i2 * 3 + 2 ],
		);

		// ── 关键步骤:把 v0/v1/v2 各自归一化后乘以 radius,得到 s0/s1/s2 ──
		// 这一步 Cesium L193-207 的语义:把椭球面上的顶点"重新映射"到半径 = radius
		// 的球面上,然后用 s0/s1/s2 的两两欧氏距离来比较边长。
		// 等价于在"统一半径球面"上比较弧长,避免椭球扁率(a ≠ c)引入的不对称。
		_subdivisionS0Scratch.copy( _subdivisionV0Scratch ).normalize().multiplyScalar( radius );
		_subdivisionS1Scratch.copy( _subdivisionV1Scratch ).normalize().multiplyScalar( radius );
		_subdivisionS2Scratch.copy( _subdivisionV2Scratch ).normalize().multiplyScalar( radius );

		// g0 = |s0 - s1|²,g1 = |s1 - s2|²,g2 = |s2 - s0|²
		// 用 mid scratch 临时存差向量,然后取 lengthSq。
		_subdivisionMidScratch.subVectors( _subdivisionS0Scratch, _subdivisionS1Scratch );
		const g0 = _subdivisionMidScratch.lengthSq();
		_subdivisionMidScratch.subVectors( _subdivisionS1Scratch, _subdivisionS2Scratch );
		const g1 = _subdivisionMidScratch.lengthSq();
		_subdivisionMidScratch.subVectors( _subdivisionS2Scratch, _subdivisionS0Scratch );
		const g2 = _subdivisionMidScratch.lengthSq();

		const max = Math.max( g0, g1, g2 );

		if ( max > minDistanceSqrd ) {
			// ── 切最长边 ──
			// `===` 浮点比较:max 是 Math.max(g0, g1, g2) 之一的"赋值",
			// 这里比较的是 max 与原 g0/g1/g2 的引用值(同一个 number),严格相等
			// (与 Cesium L227 / 247 / 267 风险等价 — 在数学上唯一最大值的情况下安全)。

			let mid: Vector3;
			let edgeKey: string;
			let midId: number;

			if ( g0 === max ) {
				// 最长边 = (i0, i1)
				edgeKey = `${ Math.min( i0, i1 ) } ${ Math.max( i0, i1 ) }`;

				const cached = edges[ edgeKey ];
				if ( cached === undefined ) {
					// 新中点 = (v0 + v1) * 0.5(算术中点,**不做** scaleToGeodeticSurface)
					mid = _subdivisionMidScratch
						.addVectors( _subdivisionV0Scratch, _subdivisionV1Scratch )
						.multiplyScalar( 0.5 );
					subdividedPositions.push( mid.x, mid.y, mid.z );
					midId = subdividedPositions.length / 3 - 1;
					edges[ edgeKey ] = midId;
				} else {
					midId = cached;
				}

				// 拆三角形并 push 回栈(顺序匹配 Cesium L245-246)
				triangles.push( i0, midId, i2 );
				triangles.push( midId, i1, i2 );

			} else if ( g1 === max ) {
				// 最长边 = (i1, i2)
				edgeKey = `${ Math.min( i1, i2 ) } ${ Math.max( i1, i2 ) }`;

				const cached = edges[ edgeKey ];
				if ( cached === undefined ) {
					mid = _subdivisionMidScratch
						.addVectors( _subdivisionV1Scratch, _subdivisionV2Scratch )
						.multiplyScalar( 0.5 );
					subdividedPositions.push( mid.x, mid.y, mid.z );
					midId = subdividedPositions.length / 3 - 1;
					edges[ edgeKey ] = midId;
				} else {
					midId = cached;
				}

				// Cesium L265-266
				triangles.push( i1, midId, i0 );
				triangles.push( midId, i2, i0 );

			} else {
				// g2 === max,最长边 = (i2, i0)
				edgeKey = `${ Math.min( i2, i0 ) } ${ Math.max( i2, i0 ) }`;

				const cached = edges[ edgeKey ];
				if ( cached === undefined ) {
					mid = _subdivisionMidScratch
						.addVectors( _subdivisionV2Scratch, _subdivisionV0Scratch )
						.multiplyScalar( 0.5 );
					subdividedPositions.push( mid.x, mid.y, mid.z );
					midId = subdividedPositions.length / 3 - 1;
					edges[ edgeKey ] = midId;
				} else {
					midId = cached;
				}

				// Cesium L285-286
				triangles.push( i2, midId, i1 );
				triangles.push( midId, i0, i1 );
			}
		} else {
			// 所有边都 ≤ minDistance,接受三角形
			subdividedIndices.push( i0, i1, i2 );
		}
	}

	// ── 输出:number[] → Float64Array / Uint32Array ──
	// `Float64Array.from(numberArray)` 保留 Float64 精度(JS Number 本就是 Float64,
	// 此处只换底层存储 / TypedArray 接口)。
	// `Uint32Array.from(numberArray)` 处理顶点数 > 65535 的极端 polygon。
	return {
		positions: Float64Array.from( subdividedPositions ),
		indices: Uint32Array.from( subdividedIndices ),
	};
}
