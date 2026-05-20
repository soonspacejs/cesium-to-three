// ============================================================
// polygon/polygon-rectangle.ts — Polygon 外接经纬度矩形(简化版)
// 层级:L1(基于 math/ellipsoid 反向投影 ECEF → cartographic)
// 职责:从 polygon outer ring 的 ECEF Vector3 顶点序列,计算外接的
//      lon/lat min/max,作为 RectangleRadians(types.ts)返回。
//      下游 polygon-extents / polygon-style-points 把它当作 ENU 中心
//      与采样原点使用。
// 依赖:Three.js Vector3,math/cartographic.ts,math/ellipsoid.ts,types.ts
// 被消费:polygon-construct-extruded.ts、polygon-shadow-volume.ts
// 算法对应:Cesium PolygonGeometry.computeRectangleFromPositions(L1047-1145)
//          的简化版 — 本期 normalizePolygonPoints 已禁止跨 IDL / 极地,
//          所以可以直接取 lon/lat min/max,无需 Stereographic 投影或
//          expandRectangle 的复杂分支。
// ============================================================

import type { Vector3 } from 'three';

import { createCartographic } from '../math/cartographic';
import { cartesianToCartographic } from '../math/ellipsoid';
import type { RectangleRadians } from '../types';

// 模块级 scratch:cartesianToCartographic 的输出 cartographic 复用,
// 避免在每个顶点循环中分配新对象(典型 polygon 顶点 5-50 个,
// 累计避免 ~50 次 GC 分配)。
const _polygonRectCarto = createCartographic( 0.0, 0.0, 0.0 );

/**
 * 计算 polygon 外环顶点的轴对齐 lon/lat 外接矩形(弧度)。
 *
 * 算法(本期简化版,7 步):
 *   1. 初始化 west/east/south/north 为 ±Infinity 哨兵
 *   2. 遍历每个 outer ring 顶点(ECEF Vector3)
 *   3. 对每个顶点调用 cartesianToCartographic 算其 lon/lat(弧度)
 *      —— scaleToGeodeticSurface + Newton 投影,精度 < EPSILON12
 *   4. 累计 lon/lat 极值
 *   5. 若任意顶点反投影返回 undefined(椭球中心退化)抛错
 *   6. 返回 { west, south, east, north }(单位:弧度)
 *
 * 数值示例(珠峰 5 顶点 polygon):
 *   west  ≈ 86.8975° × π/180 = 1.51679 rad
 *   east  ≈ 86.9525° × π/180 = 1.51775 rad
 *   south ≈ 27.9713° × π/180 = 0.48820 rad
 *   north ≈ 28.0076° × π/180 = 0.48884 rad
 *
 * Cesium 对比:Cesium 用 `Stereographic.fromCartesian` 投影 + `expandRectangle`
 * 处理跨 IDL 与极地。本期 caller(normalizePolygonPoints)已禁止这两种情况,
 * 直接取 lon/lat min/max 数值等价,代码更简洁。
 *
 * @param outerPositions Polygon outer ring 的 ECEF 顶点(已经过 normalize)。
 * @returns              外接矩形(弧度)。
 * @throws               任意顶点反投影失败(理论不可能,防御性)。
 */
export function computePolygonRectangle( outerPositions: readonly Vector3[] ): RectangleRadians {
	if ( outerPositions.length === 0 ) {
		throw new Error(
			'computePolygonRectangle: outerPositions must contain at least one point.',
		);
	}

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( let i = 0; i < outerPositions.length; i++ ) {
		const result = cartesianToCartographic( outerPositions[ i ], _polygonRectCarto );
		if ( result === undefined ) {
			// 理论上不可能:输入 ECEF 来自 polygon-hierarchy.ts 的 cartographicToCartesian,
			// 顶点都在椭球面附近,scaleToGeodeticSurface 必定收敛。但保留兜底以
			// 满足 TS strictNullChecks 并提供清晰的错误诊断。
			throw new Error(
				`computePolygonRectangle: vertex #${ i } is at ellipsoid center, cannot reverse-project to cartographic.`,
			);
		}

		const longitude = result.longitude;
		const latitude = result.latitude;

		if ( longitude < west ) { west = longitude; }
		if ( longitude > east ) { east = longitude; }
		if ( latitude < south ) { south = latitude; }
		if ( latitude > north ) { north = latitude; }
	}

	return { west, south, east, north };
}
