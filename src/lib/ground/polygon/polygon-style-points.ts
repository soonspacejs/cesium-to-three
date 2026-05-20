// ============================================================
// polygon/polygon-style-points.ts — Polygon fill 顶点的"渲染米平面"坐标
// 层级:L3(基于 math/* + rectangle/rectangle-radians + polygon-extents 同套依赖)
// 职责:把 polygon fill 顶点(原始 lon/lat 度坐标)投到与 PlanarExtents 同一个
//      ENU 米平面,以 render polygon AABB 的 SW 角为原点,产出 Vector2[]
//      (单位:米)。
//      该数组喂给 classification.ts 的 `setPolygonBorderPoints`,Shader 侧用作
//      point-in-polygon 测试以剔除 stroke 外的 fragment。
// 依赖:Three.js Matrix4 / Vector2 / Vector3,
//      math/cartographic.ts、math/ellipsoid.ts、math/enu-frame.ts、
//      math/matrix4-helpers.ts,
//      rectangle/rectangle-radians.ts(rectangleCenter 复用),
//      polygon-hierarchy.ts(PolygonHierarchy 类型),
//      types.ts(LonLatPoint / PlanarBounds / RectangleRadians)
// 被消费:primitives.ts(CesiumGroundPolygonPrimitive 类构造器)
// 算法对应:迁移自 src/lib/ground/geometry.ts:300-341,逻辑零改动。
// ============================================================

import { Matrix4, Vector2, Vector3 } from 'three';

import { createCartographic } from '../math/cartographic';
import {
	cartesianToCartographic,
	cartographicToCartesian,
} from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import { rectangleCenter } from '../rectangle/rectangle-radians';
import type { LonLatPoint, RectangleRadians } from '../types';
import type { PolygonHierarchy } from './polygon-hierarchy';

// ── 模块级 scratch ──
const _styleCenterCarto = createCartographic( 0.0, 0.0, 0.0 );
const _styleCenterCartesian = new Vector3();
const _styleEnuMatrix = new Matrix4();
const _styleInverseEnu = new Matrix4();
const _styleBoundsPointCarto = createCartographic( 0.0, 0.0, 0.0 );
const _styleBoundsPointCartesian = new Vector3();
const _stylePointCarto = createCartographic( 0.0, 0.0, 0.0 );
const _stylePointCartesian = new Vector3();

/**
 * 计算 render hierarchy 在 ENU 平面的 AABB(米),内部 helper。
 *
 * 与 polygon-extents.ts 的 computePolygonPlanarBounds 同形式,但本函数在
 * 本文件内独立维护一份以保持模块独立性 — caller 一次性传入 inverseEnu,
 * 函数返回 (minX, maxX, minY, maxY)。
 *
 * @param hierarchy   Render polygon hierarchy(Vector3 ECEF)。
 * @param height      参考高度(米),典型为 maximumHeight。
 * @param inverseEnu  ECEF → ENU 局部坐标系的变换矩阵。
 * @returns           { minX, maxX, minY, maxY }(米)。
 */
function computeRenderPlanarBounds(
	hierarchy: PolygonHierarchy,
	height: number,
	inverseEnu: Matrix4,
): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	const includeRing = ( ringPositions: readonly Vector3[] ): void => {
		for ( let i = 0; i < ringPositions.length; i++ ) {
			const cartoResult = cartesianToCartographic(
				ringPositions[ i ],
				_styleBoundsPointCarto,
			);
			if ( cartoResult === undefined ) {
				throw new Error(
					`computeRenderPlanarBounds: ring vertex #${ i } cannot reverse-project.`,
				);
			}
			_styleBoundsPointCarto.height = height;
			cartographicToCartesian(
				_styleBoundsPointCarto,
				_styleBoundsPointCartesian,
			);
			matrix4MultiplyByPoint(
				inverseEnu,
				_styleBoundsPointCartesian,
				_styleBoundsPointCartesian,
			);
			const ex = _styleBoundsPointCartesian.x;
			const ey = _styleBoundsPointCartesian.y;
			if ( ex < minX ) { minX = ex; }
			if ( ex > maxX ) { maxX = ex; }
			if ( ey < minY ) { minY = ey; }
			if ( ey > maxY ) { maxY = ey; }
		}
	};

	includeRing( hierarchy.positions );
	if ( hierarchy.holes ) {
		for ( const hole of hierarchy.holes ) {
			includeRing( hole.positions );
		}
	}

	return { minX, maxX, minY, maxY };
}

/**
 * 把 polygon fill 顶点(lon/lat 度)投到 PlanarExtents ENU 米平面,以
 * render polygon AABB 的 SW 角为原点,返回每点 (x, y) 米坐标的 Vector2 数组。
 *
 * 算法 4 步(逐字匹配原 geometry.ts:300-341):
 *   1. 中心点(用 polygonRectangle):rectangleCenter → 改 height = maxHeight → ECEF
 *      ENU 矩阵 + 逆矩阵
 *   2. render hierarchy 的 ENU 平面 AABB → renderBounds
 *   3. 对每个 fill 顶点 (lon°, lat°):
 *      a. 度 → 弧度 cartographic,height = maxHeight
 *      b. cartographic → ECEF
 *      c. 用 inverseEnu 把 ECEF 拉到 ENU 局部
 *      d. (e - renderBounds.minX, n - renderBounds.minY) 作为 Vector2 返回(米)
 *
 * 注:渲染 Shader 端用 `MAX_POLYGON_STYLE_VERTICES` 个 Vector2 槽位(classification.ts
 * 初始化时已 MAX_POLYGON_STYLE_VERTICES 个 Vector2()),`setPolygonBorderPoints` 只
 * 拷贝前 `min(points.length, MAX_POLYGON_STYLE_VERTICES)` 个;本函数返回的数组长度
 * = fillPoints.length(不做 padding,与原 geometry.ts 行为一致)。
 *
 * @param polygonRectangle Render(或 fill,任意都行)polygon 的外接 lon/lat 矩形。
 * @param renderHierarchy  Render polygon hierarchy(Vector3 ECEF;包括 stroke 外扩)。
 * @param fillPoints       Fill polygon 顶点(lon/lat 度,原始 plot-spec 输入)。
 * @param maximumHeight    顶面高度(米)。
 * @returns                Fill 顶点的米平面坐标数组(长度 = fillPoints.length)。
 */
export function computePolygonPlanarStylePoints(
	polygonRectangle: RectangleRadians,
	renderHierarchy: PolygonHierarchy,
	fillPoints: readonly LonLatPoint[],
	maximumHeight: number,
): Vector2[] {
	// Step 1 · center → ENU 矩阵 + 逆矩阵
	rectangleCenter( polygonRectangle, _styleCenterCarto );
	_styleCenterCarto.height = maximumHeight;
	cartographicToCartesian( _styleCenterCarto, _styleCenterCartesian );
	eastNorthUpToFixedFrame( _styleCenterCartesian, _styleEnuMatrix );
	_styleInverseEnu.copy( _styleEnuMatrix ).invert();

	// Step 2 · render hierarchy 的 ENU 平面 AABB
	const renderBounds = computeRenderPlanarBounds(
		renderHierarchy,
		maximumHeight,
		_styleInverseEnu,
	);

	// Step 3 · 对每个 fill 顶点:lon/lat → ECEF → ENU → 相对 SW 偏移
	const result: Vector2[] = new Array( fillPoints.length );
	for ( let i = 0; i < fillPoints.length; i++ ) {
		const point = fillPoints[ i ];

		_stylePointCarto.longitude = point[ 0 ] * Math.PI / 180.0;
		_stylePointCarto.latitude = point[ 1 ] * Math.PI / 180.0;
		_stylePointCarto.height = maximumHeight;
		cartographicToCartesian( _stylePointCarto, _stylePointCartesian );

		matrix4MultiplyByPoint(
			_styleInverseEnu,
			_stylePointCartesian,
			_stylePointCartesian,
		);

		// 相对 renderBounds.minX / minY 的偏移 = 在"SW 米原点"坐标系下的 (x, y)。
		// 注:**新建** Vector2(下游 classification 把它复制到 uniform Vector2[] 槽,
		// 但本数组短期会被 caller 持有,所以 scratch 不能复用)。
		result[ i ] = new Vector2(
			_stylePointCartesian.x - renderBounds.minX,
			_stylePointCartesian.y - renderBounds.minY,
		);
	}

	return result;
}
