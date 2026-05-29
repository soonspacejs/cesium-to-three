// ============================================================
// line/line-preprocess.ts — 折线预处理（归一 + 跨 XZ 拆段 + cartographic 化）
// 层级：L4（贴地线几何子模块）。
// 职责：把公开 lon/lat 折点（度）转成「按本初子午线 / IDL 拆段过且 cartographic
//        相邻去重」的 `Cartographic[]`，供 doc 02 §3 densify + doc 03 法线主循环用。
// 依赖：Three.js Vector3、math/ellipsoid.ts、math/cartographic.ts、
//        line/line-types.ts、line/line-options.ts、constants.ts。
// 被消费：line-shadow-volume.ts facade、单测。
// 算法对应：Cesium GroundPolylineGeometry.createGeometry 前半段。
// ============================================================

import { Vector3 } from 'three';

import { LINE_DEDUP_EPSILON, LINE_SPLIT_EPSILON } from '../constants';
import type { Cartographic } from '../math/cartographic';
import { createCartographic } from '../math/cartographic';
import {
	cartesianToCartographic,
	cartographicToCartesian,
} from '../math/ellipsoid';
import { EllipsoidRhumbLine } from '../math/ellipsoid-rhumb-line';
import type { LonLatPoint } from '../types';

import { ArcType } from './line-types';

// 模块级 scratch：所有函数共享，避免每次调用都分配（与既有 math/* 一致）。
const _scratchVecA = new Vector3();
const _scratchVecB = new Vector3();
const _scratchVecC = new Vector3();
const _scratchVecD = new Vector3();
const _scratchVecPlane = new Vector3();
const _scratchCartoA = createCartographic();
const _scratchCartoB = createCartographic();
const _scratchCartoC = createCartographic();

/**
 * XZ 平面（法线 = (0, 1, 0)，过原点）。代表本初子午线 + IDL 平面：
 * 任意点的 ECEF y 分量符号即「东半球 / 西半球」。
 */
const XZ_PLANE_NORMAL_Y = 1.0;  // 仅 y=1，其它为 0
const XZ_PLANE_DISTANCE = 0.0;

/** 平面到点的有符号距离（Hessian, plane = (n, d)）。 */
function planePointDistance( point: Vector3 ): number {
	return point.y * XZ_PLANE_NORMAL_Y + XZ_PLANE_DISTANCE;
}

/**
 * 线段 p0→p1 与 XZ 平面的交点。若线段平行于平面或交点在段外，返回 undefined。
 *
 * @param p0  起点（不修改）。
 * @param p1  终点（不修改）。
 * @param out 接收交点的 Vector3。
 * @returns   out 或 undefined。
 */
function lineSegmentIntersectsXZPlane(
	p0: Vector3,
	p1: Vector3,
	out: Vector3,
): Vector3 | undefined {
	const dirY = p1.y - p0.y;
	if ( Math.abs( dirY ) < 1.0e-30 ) {
		return undefined;
	}
	const t = - p0.y / dirY;
	if ( t < 0.0 || t > 1.0 ) {
		return undefined;
	}
	out.set(
		p0.x + ( p1.x - p0.x ) * t,
		p0.y + dirY * t,
		p0.z + ( p1.z - p0.z ) * t,
	);
	return out;
}

/**
 * 度数 lon/lat → ECEF Vector3，height=0。
 */
function lonLatDegreesToEcef( point: LonLatPoint, out: Vector3 ): Vector3 {
	const carto = _scratchCartoC;
	carto.longitude = point[ 0 ] * Math.PI / 180.0;
	carto.latitude = point[ 1 ] * Math.PI / 180.0;
	carto.height = 0.0;
	return cartographicToCartesian( carto, out );
}

/**
 * 1.1 归一化 + 相邻去重（输入端）。度 → ECEF（h=0），相邻 ECEF 距离
 * < LINE_SPLIT_EPSILON(1e-7) 视为重复，丢弃后者。结果 < 2 点抛错。
 *
 * @param points 公开 lon/lat 点（度）。
 * @returns      去重后的 ECEF 顶点。
 */
function normalizeLinePositions( points: LonLatPoint[] ): Vector3[] {
	const out: Vector3[] = [];
	let prev: Vector3 | undefined;
	for ( let i = 0; i < points.length; i++ ) {
		const ecef = new Vector3();
		lonLatDegreesToEcef( points[ i ], ecef );
		if ( prev !== undefined && prev.distanceTo( ecef ) < LINE_SPLIT_EPSILON ) {
			continue;
		}
		out.push( ecef );
		prev = ecef;
	}
	if ( out.length < 2 ) {
		throw new Error(
			'CesiumGroundPolyline: after dedup, fewer than 2 distinct points remain.',
		);
	}
	return out;
}

/**
 * 1.2 本初子午线 + IDL 拆段。在每段越过 XZ 平面（y==0）处插入交点。
 *
 * @param positions 归一后的 ECEF 顶点。
 * @param arcType   连线类型；RHUMB 用 `findIntersectionWithLongitude` 在恒向线上
 *                  求经度处的精确交点；GEODESIC / NONE 用 ECEF 直线与平面交点。
 * @returns         拆段后的 ECEF 顶点。
 */
function splitAcrossXZPlane(
	positions: Vector3[],
	arcType: ArcType,
): Vector3[] {
	const out: Vector3[] = [ positions[ 0 ] ];
	for ( let i = 0; i < positions.length - 1; i++ ) {
		const p0 = positions[ i ];
		const p1 = positions[ i + 1 ];

		// 只在两点跨 XZ 平面（y 符号相反）时才插入。
		if ( ( planePointDistance( p0 ) >= 0.0 ) === ( planePointDistance( p1 ) >= 0.0 ) ) {
			out.push( p1 );
			continue;
		}

		const inter = lineSegmentIntersectsXZPlane( p0, p1, _scratchVecPlane );
		if ( inter === undefined ) {
			out.push( p1 );
			continue;
		}

		const dToP0 = inter.distanceTo( p0 );
		const dToP1 = inter.distanceTo( p1 );
		if ( dToP0 <= LINE_SPLIT_EPSILON || dToP1 <= LINE_SPLIT_EPSILON ) {
			out.push( p1 );
			continue;
		}

		if ( arcType === ArcType.RHUMB ) {
			// 恒向线模式下，先把交点 ECEF 反投影成经度，再用 RhumbLine 求该经线
			// 上的精确交点。退化时退回 geodesic 直插值（与原 Cesium 一致）。
			const cartoX = cartesianToCartographic( inter, _scratchCartoA );
			if ( cartoX !== undefined ) {
				const cartoP0 = cartesianToCartographic( p0, _scratchCartoB );
				const cartoP1 = cartesianToCartographic( p1, _scratchCartoC );
				if ( cartoP0 !== undefined && cartoP1 !== undefined ) {
					const rhumb = new EllipsoidRhumbLine( cartoP0, cartoP1 );
					const cartoR = rhumb.findIntersectionWithLongitude(
						cartoX.longitude,
						_scratchCartoA,
					);
					if ( cartoR !== undefined ) {
						const ecefR = new Vector3();
						cartographicToCartesian( cartoR, ecefR );
						if (
							ecefR.distanceTo( p0 ) > LINE_SPLIT_EPSILON &&
							ecefR.distanceTo( p1 ) > LINE_SPLIT_EPSILON
						) {
							out.push( ecefR );
						}
					}
				}
			}
		} else {
			// GEODESIC / NONE：直接使用 ECEF 直线与 XZ 平面的交点（已算）。
			out.push( inter.clone() );
		}

		out.push( p1 );
	}
	return out;
}

/**
 * 1.3 cartographic 化 + 相邻去重（输出端，EPSILON12 容差，对 lon / lat 各比）。
 *
 * @param positions 拆段后的 ECEF 顶点。
 * @returns         相邻 carto 不重合的 Cartographic 列表。
 * @throws          去重后 < 2 个点。
 */
function toCartographicsDedup( positions: Vector3[] ): Cartographic[] {
	const out: Cartographic[] = [];
	let prev: Cartographic | undefined;
	for ( let i = 0; i < positions.length; i++ ) {
		const carto = createCartographic();
		const result = cartesianToCartographic( positions[ i ], carto );
		if ( result === undefined ) {
			continue;
		}
		carto.height = 0.0;
		if (
			prev !== undefined &&
			Math.abs( prev.longitude - carto.longitude ) <= LINE_DEDUP_EPSILON &&
			Math.abs( prev.latitude - carto.latitude ) <= LINE_DEDUP_EPSILON
		) {
			continue;
		}
		out.push( carto );
		prev = carto;
	}
	if ( out.length < 2 ) {
		throw new Error(
			'CesiumGroundPolyline: after cartographic dedup, fewer than 2 points remain.',
		);
	}
	return out;
}

/**
 * 完整预处理流水线：归一 → 拆段 → cartographic 去重。
 *
 * @param points  公开 lon/lat 点（度）。
 * @param arcType 连线类型（影响 §2 拆段的交点求解）。
 * @returns       去重后的 Cartographic 序列，>= 2 个点。
 */
export function preprocessLine(
	points: LonLatPoint[],
	arcType: ArcType,
): Cartographic[] {
	void _scratchVecA;
	void _scratchVecB;
	void _scratchVecC;
	void _scratchVecD;
	const normalized = normalizeLinePositions( points );
	const split = splitAcrossXZPlane( normalized, arcType );
	return toCartographicsDedup( split );
}
