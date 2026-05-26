// ============================================================
// line/line-geometry-normals.ts — 逐顶点几何法线 + 墙构建主循环
// 层级：L4（贴地线几何子模块）。
// 职责：
//   1) 提供原子法线函数（tangentDirection / computeRightNormal /
//      computeVertexMiterNormal / breakMiter），逐字对齐 Cesium。
//   2) 把 doc 02 的加密原子函数与本篇法线函数编排进 `buildWallArrays`，
//      产出完整 `DensifiedLine`（含 normalsArray）。
// 依赖：Three.js Vector3 / Quaternion、math/ellipsoid.ts、math/cartographic.ts、
//        line/line-densify.ts、constants.ts。
// 被消费：line-shadow-volume.ts、单测。
// 算法对应：Cesium `computeVertexMiterNormal` / `computeRightNormal` /
//          `tangentDirection` / `breakMiter` + `createGeometry` 第二半段。
// ============================================================

import { Quaternion, Vector3 } from 'three';

import {
	MITER_BREAK_LARGE,
	MITER_BREAK_SMALL,
	WALL_INITIAL_MAX_HEIGHT,
	WALL_INITIAL_MIN_HEIGHT,
} from '../constants';
import type { Cartographic } from '../math/cartographic';
import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';

import { interpolateSegment, pushVertex } from './line-densify';
import type { ArcType, DensifiedLine } from './line-types';

const COSINE90 = 0.0;
const COSINE180 = - 1.0;
const EPSILON5 = 1.0e-5;

// 模块级 scratch（reuse 风格与项目其它几何模块一致）。
const _scratchPrevB = new Vector3();
const _scratchVB = new Vector3();
const _scratchVT = new Vector3();
const _scratchNextB = new Vector3();
const _scratchTopOnly = new Vector3();
const _scratchUp = new Vector3();
const _scratchForward = new Vector3();
const _scratchToPrev = new Vector3();
const _scratchToNext = new Vector3();
const _scratchRotateAxis = new Vector3();
const _scratchQuaternion = new Quaternion();
const _scratchTangent = new Vector3();
const _scratchTangentCross = new Vector3();
const _scratchCartoStart = createCartographic();
const _scratchCartoEnd = createCartographic();

/**
 * out = normalize(target - origin)。
 */
function direction( target: Vector3, origin: Vector3, out: Vector3 ): Vector3 {
	out.subVectors( target, origin );
	out.normalize();
	return out;
}

/**
 * 把 origin → target 方向正交化到「以 up 为法线的切平面」内，得到指向
 * target 投影的单位向量。逐字对应 Cesium 的两步叉乘：
 *     tmp = normalize(direction × up)
 *     out = normalize(up × tmp)
 *
 * @param target target 端 ECEF。
 * @param origin origin 端 ECEF。
 * @param up     当前顶点 up 单位向量（normalize(top - bottom)）。
 * @param out    接收单位切向。
 * @returns      out。
 */
function tangentDirection(
	target: Vector3,
	origin: Vector3,
	up: Vector3,
	out: Vector3,
): Vector3 {
	direction( target, origin, out );
	// out = out × up（顺序 1：与 up 正交的「侧向」）
	_scratchTangentCross.copy( out ).cross( up ).normalize();
	// out = up × side（顺序 2：切平面内、指向 target 投影方向）
	_scratchTangent.copy( up ).cross( _scratchTangentCross ).normalize();
	out.copy( _scratchTangent );
	return out;
}

/**
 * 端点（非 loop 首 / 末点）法线：沿该段方向、指向右侧、与 up 正交的单位向量。
 *
 * @param start     段起点 carto。
 * @param end       段终点 carto。
 * @param maxHeight 标准墙上沿高度（用于算 up）。
 * @param out       接收单位法线。
 * @returns         out。
 */
export function computeRightNormal(
	start: Cartographic,
	end: Cartographic,
	maxHeight: number,
	out: Vector3,
): Vector3 {
	const startB = _scratchPrevB;
	const startT = _scratchVT;
	const endB = _scratchNextB;

	const savedStartH = start.height;
	const savedEndH = end.height;
	start.height = 0.0;
	cartographicToCartesian( start, startB );
	start.height = maxHeight;
	cartographicToCartesian( start, startT );
	end.height = 0.0;
	cartographicToCartesian( end, endB );
	start.height = savedStartH;
	end.height = savedEndH;

	direction( startT, startB, _scratchUp );        // up = normalize(top - bottom)
	direction( endB, startB, _scratchForward );     // forward = normalize(end - start)
	out.copy( _scratchForward ).cross( _scratchUp ).normalize();
	return out;
}

/**
 * 内部顶点的 miter 法线：相邻两段方向的角平分线方向（切平面内）对应的
 * 右法线。dot(toPrev, toNext) ≈ -1（直线穿过）时走特例分支。
 *
 * @param previousBottom 前点 @minHeight。
 * @param vertexBottom   当前点 @minHeight。
 * @param vertexTop      当前点 @maxHeight（用以定义 up）。
 * @param nextBottom     后点 @minHeight。
 * @param out            接收单位法线。
 * @returns              out。
 */
export function computeVertexMiterNormal(
	previousBottom: Vector3,
	vertexBottom: Vector3,
	vertexTop: Vector3,
	nextBottom: Vector3,
	out: Vector3,
): Vector3 {
	direction( vertexTop, vertexBottom, _scratchUp );
	tangentDirection( previousBottom, vertexBottom, _scratchUp, _scratchToPrev );
	tangentDirection( nextBottom, vertexBottom, _scratchUp, _scratchToNext );

	const dotPrevNext = _scratchToPrev.dot( _scratchToNext );

	// 直线穿过特例（dot≈-1，前后切向几乎反向）→ 法线 = normalize(up × toPrevious)。
	if ( Math.abs( dotPrevNext - COSINE180 ) <= EPSILON5 ) {
		out.copy( _scratchUp ).cross( _scratchToPrev ).normalize();
		return out;
	}

	// 一般情形：角平分线方向 = normalize(toNext + toPrev)。
	out.copy( _scratchToNext ).add( _scratchToPrev ).normalize();

	// 翻转校正：若 forward = up × out 与 toNext 反向（点积 < cosine90），
	// 说明法线指错半边，取反。
	const forward = _scratchForward.copy( _scratchUp ).cross( out );
	if ( _scratchToNext.dot( forward ) < COSINE90 ) {
		out.negate();
	}
	return out;
}

/**
 * 若当前 endGeometryNormal 与本段方向夹角过小 / 过大（拐角过尖），把它绕
 * vertexUp 旋 ±90° 打断斜接，防止 box 退化或暴长。
 *
 * @param endGeometryNormal 输入并被原地修改。
 * @param startBottom       段起点 @minHeight。
 * @param endBottom         段终点 @minHeight。
 * @param endTop            段终点 @maxHeight。
 * @returns                 是否触发打断（供主循环的 miterBroken 状态机用）。
 */
export function breakMiter(
	endGeometryNormal: Vector3,
	startBottom: Vector3,
	endBottom: Vector3,
	endTop: Vector3,
): boolean {
	const lineDirection = direction( endBottom, startBottom, _scratchForward );
	const dot = lineDirection.dot( endGeometryNormal );
	if ( dot > MITER_BREAK_SMALL || dot < MITER_BREAK_LARGE ) {
		const vertexUp = direction( endTop, endBottom, _scratchUp );
		const angle = dot < MITER_BREAK_LARGE ? Math.PI / 2.0 : - Math.PI / 2.0;
		_scratchRotateAxis.copy( vertexUp );
		_scratchQuaternion.setFromAxisAngle( _scratchRotateAxis, angle );
		endGeometryNormal.applyQuaternion( _scratchQuaternion );
		return true;
	}
	return false;
}

/**
 * 把一组 cartographic 折点构造成「加密 + 法线」后的墙数据。
 *
 * @param cartographics 预处理后的 cartographic 列表（≥ 2 点）。
 * @param loop          是否闭合。
 * @param arcType       连线方式。
 * @param granularity   加密阈值。
 * @param minHeight     标准墙下沿高度（默认 WALL_INITIAL_MIN_HEIGHT=0）。
 * @param maxHeight     标准墙上沿高度（默认 WALL_INITIAL_MAX_HEIGHT=1000）。
 * @returns             加密 + 法线后的密集线数据。
 */
export function buildWallArrays(
	cartographics: Cartographic[],
	loop: boolean,
	arcType: ArcType,
	granularity: number,
	minHeight: number = WALL_INITIAL_MIN_HEIGHT,
	maxHeight: number = WALL_INITIAL_MAX_HEIGHT,
): DensifiedLine {
	const N = cartographics.length;
	const normalsArray: number[] = [];
	const bottomPositionsArray: number[] = [];
	const topPositionsArray: number[] = [];
	const cartographicsArray: number[] = [];

	// 三槽 scratch 轮转，避免每点 new。
	const prevB = _scratchPrevB;
	const vB = _scratchVB;
	const vT = _scratchVT;
	const nextB = _scratchNextB;
	const vertexNormal = new Vector3();

	// ── 首点 ──
	const start = cartographics[ 0 ];
	const next = cartographics[ 1 ];

	if ( loop ) {
		const preStart = cartographics[ N - 1 ];
		// loop 时首点也按内部顶点 miter：previousBottom = 末点 @minHeight。
		preStart.height = minHeight;
		cartographicToCartesian( preStart, prevB );
		next.height = minHeight;
		cartographicToCartesian( next, nextB );
		start.height = minHeight;
		cartographicToCartesian( start, vB );
		start.height = maxHeight;
		cartographicToCartesian( start, vT );
		computeVertexMiterNormal( prevB, vB, vT, nextB, vertexNormal );
		preStart.height = 0.0;
		next.height = 0.0;
		start.height = 0.0;
	} else {
		computeRightNormal( start, next, maxHeight, vertexNormal );
	}

	pushVertex(
		start, vertexNormal, minHeight, maxHeight,
		normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
	);
	interpolateSegment(
		start, next, minHeight, maxHeight, granularity, arcType,
		normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
	);

	// ── 中间点 i = 1 .. N-2 ──
	for ( let i = 1; i < N - 1; i++ ) {
		const previousCarto = cartographics[ i - 1 ];
		const currentCarto = cartographics[ i ];
		const nextCarto = cartographics[ i + 1 ];

		previousCarto.height = minHeight;
		cartographicToCartesian( previousCarto, prevB );
		currentCarto.height = minHeight;
		cartographicToCartesian( currentCarto, vB );
		currentCarto.height = maxHeight;
		cartographicToCartesian( currentCarto, vT );
		nextCarto.height = minHeight;
		cartographicToCartesian( nextCarto, nextB );
		previousCarto.height = 0.0;
		currentCarto.height = 0.0;
		nextCarto.height = 0.0;

		computeVertexMiterNormal( prevB, vB, vT, nextB, vertexNormal );
		pushVertex(
			currentCarto, vertexNormal, minHeight, maxHeight,
			normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
		);
		interpolateSegment(
			currentCarto, nextCarto, minHeight, maxHeight, granularity, arcType,
			normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
		);
	}

	// ── 末点 ──
	const endCarto = cartographics[ N - 1 ];
	const preEndCarto = cartographics[ N - 2 ];

	if ( loop ) {
		// loop 末点：previousBottom = 倒数第 2 点；nextBottom = 首点（环上后继）。
		preEndCarto.height = minHeight;
		cartographicToCartesian( preEndCarto, prevB );
		endCarto.height = minHeight;
		cartographicToCartesian( endCarto, vB );
		endCarto.height = maxHeight;
		cartographicToCartesian( endCarto, vT );
		start.height = minHeight;
		cartographicToCartesian( start, nextB );
		preEndCarto.height = 0.0;
		endCarto.height = 0.0;
		start.height = 0.0;

		computeVertexMiterNormal( prevB, vB, vT, nextB, vertexNormal );
	} else {
		computeRightNormal( preEndCarto, endCarto, maxHeight, vertexNormal );
	}

	pushVertex(
		endCarto, vertexNormal, minHeight, maxHeight,
		normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
	);

	// ── loop 闭合：补末→首段，并把首点三件套复制到尾。──
	if ( loop ) {
		interpolateSegment(
			endCarto, start, minHeight, maxHeight, granularity, arcType,
			normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
		);
		// 把首点的 normal / bottom / top / cartographic 各 3/2 分量复制到尾。
		normalsArray.push(
			normalsArray[ 0 ], normalsArray[ 1 ], normalsArray[ 2 ],
		);
		bottomPositionsArray.push(
			bottomPositionsArray[ 0 ], bottomPositionsArray[ 1 ], bottomPositionsArray[ 2 ],
		);
		topPositionsArray.push(
			topPositionsArray[ 0 ], topPositionsArray[ 1 ], topPositionsArray[ 2 ],
		);
		cartographicsArray.push(
			cartographicsArray[ 0 ], cartographicsArray[ 1 ],
		);
	}

	// 防 stale carto.height 影响后续调用（preprocess 已把 height=0，但 doc 03
	// 主循环里临时改过）。
	void _scratchCartoStart;
	void _scratchCartoEnd;
	void _scratchTopOnly;

	return {
		normalsArray,
		bottomPositionsArray,
		topPositionsArray,
		cartographicsArray,
		loop,
		pointCount: bottomPositionsArray.length / 3,
	};
}
