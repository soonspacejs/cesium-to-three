// ============================================================
// polygon/polygon-rings.ts — Polygon ring 处理(scale + 去重 + 投影 + winding)
// 层级:L2(基于 polygon-hierarchy + ellipsoid-tangent-plane + math/)
// 职责:把 PolygonHierarchy(Vector3 ECEF)转换为给 earcut 用的:
//      - 合并位置数组(外环 + 每个 hole 顺序追加,顺序与 positions2D 1:1)
//      - 切平面 2D 坐标(同上)
//      - holeStartIndices(每个 hole 在合并数组中的起始顶点索引,直接喂 earcut)
//      - tangentPlane(切平面;同时返回供 wall 构造复用,避免重复构造)
//      - rings(原始 ring 边界 [startIndex, length],供下游 wall 遍历)
//      处理步骤(按 ring 逐个执行):
//        1. scale-to-geodetic-surface(每个顶点投到椭球面;若已在面上 Newton 无操作)
//        2. arrayRemoveDuplicates(EPSILON10,wrap-around;Cesium 同名行为)
//        3. projectPointsOntoPlane(投到切平面 2D)
//        4. winding 校正(外环 CCW、hole CW;不符则反转 positions + positions2D)
// 依赖:polygon-hierarchy.ts、ellipsoid-tangent-plane.ts、
//      math/ellipsoid.ts、math/vec3-helpers.ts、math/constants.ts(EPSILON10)、
//      Three.js Vector2 / Vector3
// 被消费:polygon-cap-construction.ts、polygon-construct-extruded.ts
// 算法对应:Cesium Source/Core/PolygonGeometryLibrary.js#polygonsFromHierarchy(L774-913)
//          的"单外环 + 平铺 holes"简化版(不递归 hole-in-hole 嵌套,因为
//          plot-spec 的 holes 已经是平铺数组)。
// ============================================================

import { Vector3, type Vector2 } from 'three';

import { EPSILON10 } from '../math/constants';
import { scaleToGeodeticSurface } from '../math/ellipsoid';
import { vec3EqualsEpsilon } from '../math/vec3-helpers';
import {
	type EllipsoidTangentPlane,
	projectPointsOntoPlane,
	tangentPlaneFromPoints,
} from './ellipsoid-tangent-plane';
import type { PolygonHierarchy } from './polygon-hierarchy';

/**
 * processPolygonRings 输出。
 *
 * 排列约定(所有数组的顺序严格 1:1,且与 earcut 输入约定一致):
 *   positions / positions2D = [
 *     <outer ring 顶点 0..length-1>,
 *     <hole_0 顶点 0..length-1>,
 *     <hole_1 顶点 0..length-1>,
 *     ...
 *   ]
 *   holeStartIndices = [ outer.length, outer.length + hole_0.length, ... ]
 *   rings = [
 *     { startIndex: 0, length: outer.length },
 *     { startIndex: outer.length, length: hole_0.length },
 *     ...
 *   ]
 */
export interface ProcessedPolygonRings {
	/** 合并后的 ECEF 位置数组(外环 + 每个 hole),winding 已校正 */
	positions: Vector3[];

	/** 合并后的切平面 2D 位置(顺序与 positions 严格 1:1) */
	positions2D: Vector2[];

	/**
	 * 每个 hole 在合并数组中的起始顶点索引(顶点 ID,非浮点偏移)。
	 * 无 hole 时为空数组(`[]`)。直接传给 earcut 第 2 参。
	 */
	holeStartIndices: number[];

	/** 切平面(给 wall 构造复用,避免重复构造) */
	tangentPlane: EllipsoidTangentPlane;

	/**
	 * 每个 ring 在合并数组中的 [startIndex, length]:
	 *   rings[0] = 外环信息
	 *   rings[1..N] = 每个有效 hole 信息(已通过 length ≥ 3 校验)
	 */
	rings: { startIndex: number; length: number }[];
}

// 模块级 scratch:scaleToGeodeticSurface 输入临时复用。每个新顶点 Vector3
// 仍需单独分配(下游会持有),但避免每次都新建中间 scratch。
const _scaleInputScratch = new Vector3();

/**
 * 计算 2D 多边形的有向面积(shoelace 公式 × 0.5),用于判定 winding 方向。
 *
 * Cesium 对应:`PolygonPipeline.computeArea2D`(L26-48)→ `computeWindingOrder2D`(L55-58)
 * 用 `area > 0` 判 CCW。本函数返回带符号的 0.5 倍面积,> 0 即 CCW,< 0 即 CW,
 * == 0 即退化(共线)。
 *
 * 实现细节(逐字匹配 Cesium):
 *   for (let i0 = length - 1, i1 = 0; i1 < length; i0 = i1++) { ... }
 *   累加 v0.x * v1.y - v1.x * v0.y
 *   最后 * 0.5
 *
 * 数学说明:shoelace 公式给出 2A_signed,乘 0.5 得到带符号面积。
 * 0.5 不影响判 sign(0.5 * 0 = 0),但保留以与 Cesium 字节级对齐。
 *
 * @param positions2D 2D 顶点序列(已闭合,首尾不重复)。
 * @returns           带符号面积 × 0.5(米²);> 0 → CCW,< 0 → CW。
 */
function computeArea2D( positions2D: readonly Vector2[] ): number {
	const length = positions2D.length;
	let area = 0.0;

	for ( let i0 = length - 1, i1 = 0; i1 < length; i0 = i1++ ) {
		const v0 = positions2D[ i0 ];
		const v1 = positions2D[ i1 ];
		area += v0.x * v1.y - v1.x * v0.y;
	}

	return area * 0.5;
}

/**
 * 相邻去重 + 首尾去重(wrap-around),Cesium `arrayRemoveDuplicates` 在
 * `equalsEpsilon = Cartesian3.equalsEpsilon, wrapAround = true` 模式下的复刻。
 *
 * 算法(逐字匹配 Cesium arrayRemoveDuplicates.js L49-127):
 *   1. length < 2:直接返回原数组(无去重必要)
 *   2. 第一遍:从 i=1 到 length-1,比较 v0 (= 上一个 cleaned 元素) 与 v1 (= values[i])
 *      - 若相等:跳过 v1(不放进 cleanedValues)
 *      - 若不等:把 v1 放进 cleanedValues,v0 = v1
 *   3. wrap-around:若 values[0] 等于 values[length-1] → 去掉最后一个 cleaned 元素
 *
 * **EPSILON 取值**:Cesium `arrayRemoveDuplicates.js:5` 用 `CesiumMath.EPSILON10`
 * (= 1e-10),**非** doc 05 提到的 EPSILON7。本函数用 EPSILON10 与 Cesium 字节级一致。
 *
 * @param values    输入数组(不修改)。
 * @returns         无相邻 / 首尾重复的新数组(可能是 values 浅拷贝,也可能是过滤后的新数组)。
 */
function arrayRemoveDuplicatesVec3( values: readonly Vector3[] ): Vector3[] {
	const length = values.length;
	if ( length < 2 ) {
		// Cesium 在此返回原数组引用;我们 slice 一份方便上层不持有 caller 输入。
		return values.slice();
	}

	// 第一遍:相邻去重
	let v0 = values[ 0 ];
	// 优化:Cesium 在首次发现重复时才创建 cleanedValues;此处简化为始终新建。
	// 数据一致 — 浮点数值 / 顺序与 Cesium 一致。
	const cleanedValues: Vector3[] = [ v0 ];

	for ( let i = 1; i < length; i++ ) {
		const v1 = values[ i ];
		if ( vec3EqualsEpsilon( v0, v1, EPSILON10 ) ) {
			// 重复,跳过 v1
			continue;
		}
		cleanedValues.push( v1 );
		v0 = v1;
	}

	// 第二遍:wrap-around — 若 values[0] === values[length-1],去掉最后一个 cleaned 元素
	// 注意:比较的是 values 的首尾(原始数组),非 cleanedValues 的首尾,与 Cesium L107-109 一致。
	if (
		cleanedValues.length > 0 &&
		vec3EqualsEpsilon( values[ 0 ], values[ length - 1 ], EPSILON10 )
	) {
		cleanedValues.length -= 1;
	}

	return cleanedValues;
}

/**
 * 处理单个 ring(外环或单个 hole):scale-to-surface + 去重 + 投影 + winding 校正。
 *
 * @param ringPositions 输入 ring 的 ECEF 顶点。
 * @param tangentPlane  外环构造好的切平面(holes 复用同一个切平面投影 2D)。
 * @param isHole        true → 校正为 CW;false → 校正为 CCW(外环)。
 * @returns             { positions: 处理后顶点, positions2D: 切平面 2D }。
 *                      若 ring 退化(去重后 < 3 顶点 / 投影后 < 3 顶点)返回空数组,
 *                      调用方应丢弃此 ring。
 */
function processRing(
	ringPositions: readonly Vector3[],
	tangentPlane: EllipsoidTangentPlane,
	isHole: boolean,
): { positions: Vector3[]; positions2D: Vector2[] } {
	// 步骤 1 · 克隆 + scaleToGeodeticSurface(每点都是新 Vector3,不污染 caller)
	const surfacePositions: Vector3[] = new Array( ringPositions.length );
	for ( let i = 0; i < ringPositions.length; i++ ) {
		_scaleInputScratch.copy( ringPositions[ i ] );
		const cloned = new Vector3();
		const projected = scaleToGeodeticSurface( _scaleInputScratch, cloned );
		if ( projected === undefined ) {
			throw new Error(
				`processRing: vertex #${ i } is at or near ellipsoid center, cannot project to surface.`,
			);
		}
		surfacePositions[ i ] = cloned;
	}

	// 步骤 2 · 相邻去重(EPSILON10 + wrap-around)
	const deduped = arrayRemoveDuplicatesVec3( surfacePositions );
	if ( deduped.length < 3 ) {
		return { positions: [], positions2D: [] };
	}

	// 步骤 3 · 投影到切平面 2D
	const positions2D = projectPointsOntoPlane( tangentPlane, deduped );
	if ( positions2D.length < 3 ) {
		return { positions: [], positions2D: [] };
	}

	// 步骤 4 · winding 校正
	// computeArea2D > 0 → CCW(逆时针);< 0 → CW(顺时针)
	// 外环要 CCW,hole 要 CW
	const area = computeArea2D( positions2D );
	const isCCW = area > 0.0;
	const needsCCW = ! isHole;

	if ( isCCW !== needsCCW ) {
		// 反转两者(Cesium 行为:positions2D.reverse() 原地;outerRing.slice().reverse() 新数组)
		// 我们已经持有新数组,直接原地 reverse 即可,与 Cesium 数值结果一致。
		deduped.reverse();
		positions2D.reverse();
	}

	return { positions: deduped, positions2D };
}

/**
 * 把整个 PolygonHierarchy 处理为 earcut 可消费的"一锅炖"数据。
 *
 * 数据结构变化:
 *   输入:{ positions: 外环顶点[], holes?: [{ positions: 洞环顶点[] }, ...] }
 *   输出:{
 *     positions: 外环顶点拼接每个 hole 顶点(扁平),
 *     positions2D: 同上但是切平面 2D,
 *     holeStartIndices: [ 每个 hole 在 positions 中的起始下标 ],
 *     tangentPlane: ...,
 *     rings: [ { startIndex, length } × (1 + 有效 hole 数) ],
 *   }
 *
 * 退化处理:
 *   - 外环去重 + 投影后 < 3 顶点 → 抛 Error(无法构成 polygon)
 *   - hole 去重 + 投影后 < 3 顶点 → 丢弃此 hole(Cesium 同名行为,L866-868)
 *
 * @param hierarchy 内部 PolygonHierarchy(Vector3 ECEF)。
 * @returns         处理后 ring 数据,可直接喂给 triangulation.ts + polygon-wall-construction.ts。
 */
export function processPolygonRings(
	hierarchy: PolygonHierarchy,
): ProcessedPolygonRings {
	// 步骤 1 · 构造切平面(以外环顶点为依据)
	// Cesium PolygonGeometry.createGeometry 在调用 polygonsFromHierarchy 之前
	// 用 outer ring 调用 EllipsoidTangentPlane.fromPoints。我们这里直接复用
	// hierarchy.positions(它已是 polygon-hierarchy 产出的椭球面 ECEF Vector3)。
	const tangentPlane = tangentPlaneFromPoints( hierarchy.positions );

	// 步骤 2 · 外环处理
	const outerProcessed = processRing( hierarchy.positions, tangentPlane, false );
	if ( outerProcessed.positions.length < 3 ) {
		throw new Error(
			'processPolygonRings: outer ring degenerated to <3 vertices after dedup/projection.',
		);
	}

	// 步骤 3 · 处理每个 hole(无效 hole 跳过)
	const validHoles: { positions: Vector3[]; positions2D: Vector2[] }[] = [];
	if ( hierarchy.holes ) {
		for ( let i = 0; i < hierarchy.holes.length; i++ ) {
			const hole = hierarchy.holes[ i ];
			const holeProcessed = processRing( hole.positions, tangentPlane, true );
			if ( holeProcessed.positions.length >= 3 ) {
				validHoles.push( holeProcessed );
			}
			// length < 3 → 静默丢弃此 hole(Cesium 行为)
		}
	}

	// 步骤 4 · 合并到一个扁平数组
	const mergedPositions: Vector3[] = outerProcessed.positions.slice();
	const mergedPositions2D: Vector2[] = outerProcessed.positions2D.slice();
	const holeStartIndices: number[] = [];
	const rings: { startIndex: number; length: number }[] = [
		{ startIndex: 0, length: outerProcessed.positions.length },
	];

	for ( const hole of validHoles ) {
		const startIndex = mergedPositions.length;
		holeStartIndices.push( startIndex );
		rings.push( { startIndex, length: hole.positions.length } );

		// 扩展(避免 push(...spread) 在大型 ring 上的栈深问题)
		for ( let i = 0; i < hole.positions.length; i++ ) {
			mergedPositions.push( hole.positions[ i ] );
			mergedPositions2D.push( hole.positions2D[ i ] );
		}
	}

	return {
		positions: mergedPositions,
		positions2D: mergedPositions2D,
		holeStartIndices,
		tangentPlane,
		rings,
	};
}
