// ============================================================
// polygon/polygon-extents.ts — Polygon PlanarExtents 计算
// 层级:L3(基于 math/* + rectangle/rectangle-radians + polygon-hierarchy)
// 职责:从 polygon hierarchy(Vector3 ECEF)+ outer ring 外接矩形 + maxHeight,
//      产 6 个 PlanarExtents uniform(供 classification.ts 的
//      ShadowVolumeAppearanceVS 用):
//        - southWestHigh / southWestLow(RTE 编码的 SW 角点 ECEF)
//        - eastward / northward(SW→SE 与 SW→NW 米向量)
//        - uvMinAndExtents / uMaxVmax(2D 标准化坐标占位 4-vec)
//        - innerMetersRect(填充区域米矩形)
//      算法与原 geometry.ts:233-298 字节级一致,只把 Cesium API 全部替换为 math/*。
// 依赖:Three.js Matrix4 / Vector3 / Vector4,
//      math/cartographic.ts、math/ellipsoid.ts、math/enu-frame.ts、
//      math/matrix4-helpers.ts、math/rte-encoding.ts,
//      rectangle/rectangle-radians.ts(rectangleCenter 复用),
//      polygon-hierarchy.ts(PolygonHierarchy 类型),
//      types.ts(PlanarBounds / PlanarExtents / RectangleRadians)
// 被消费:primitives.ts(CesiumGroundPolygonPrimitive 类构造器)
// 算法对应:迁移自 src/lib/ground/geometry.ts:180-298,逻辑零改动。
// ============================================================

import { Matrix4, Vector3, Vector4 } from 'three';

import { createCartographic } from '../math/cartographic';
import {
	cartesianToCartographic,
	cartographicToCartesian,
} from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import { encodeVec3RTE } from '../math/rte-encoding';
import { rectangleCenter } from '../rectangle/rectangle-radians';
import type {
	PlanarBounds,
	PlanarExtents,
	RectangleRadians,
} from '../types';
import type { PolygonHierarchy } from './polygon-hierarchy';

// ── 模块级 scratch ──
const _extentsCenterCarto = createCartographic( 0.0, 0.0, 0.0 );
const _extentsCenterCartesian = new Vector3();
const _extentsEnuMatrix = new Matrix4();
const _extentsInverseEnu = new Matrix4();
const _boundsPointCarto = createCartographic( 0.0, 0.0, 0.0 );
const _boundsPointCartesian = new Vector3();
const _extentsSWCartesian = new Vector3();
const _extentsSECartesian = new Vector3();
const _extentsNWCartesian = new Vector3();
const _extentsHigh = new Vector3();
const _extentsLow = new Vector3();

/**
 * 计算 polygon hierarchy 在指定高度的 ENU 平面外接 AABB(米)。
 *
 * 对外环 + 每个 hole 的每个顶点:
 *   1. ECEF → cartographic(取出 lon/lat)
 *   2. 把 height 改为 input `height`(典型 maxHeight)
 *   3. cartographic → ECEF(在 `height` 上的 ECEF 位置)
 *   4. inverseEnu × ECEF → ENU 局部 (e, n, u)
 *   5. 累计 (e, n) 的 min/max
 *
 * 注:第 5 步丢弃 z(U 分量),因为我们只关心 ENU 平面的 AABB。
 *
 * @param hierarchy   Polygon hierarchy(Vector3 ECEF,已在椭球面)。
 * @param height      参考高度(米),典型为 maximumHeight。
 * @param inverseEnu  ECEF → ENU 局部坐标系的变换矩阵(已由 caller 算好)。
 * @returns           ENU 平面的 AABB { minX, maxX, minY, maxY }(米)。
 */
function computePolygonPlanarBounds(
	hierarchy: PolygonHierarchy,
	height: number,
	inverseEnu: Matrix4,
): PlanarBounds {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	const includeRing = ( ringPositions: readonly Vector3[] ): void => {
		for ( let i = 0; i < ringPositions.length; i++ ) {
			// ECEF → cartographic(取 lon/lat)
			const cartoResult = cartesianToCartographic(
				ringPositions[ i ],
				_boundsPointCarto,
			);
			if ( cartoResult === undefined ) {
				throw new Error(
					`computePolygonPlanarBounds: ring vertex #${ i } cannot reverse-project to cartographic.`,
				);
			}

			// 改高度,转回 ECEF
			_boundsPointCarto.height = height;
			cartographicToCartesian( _boundsPointCarto, _boundsPointCartesian );

			// ECEF → ENU 局部坐标(原地 cartesian → ENU)
			matrix4MultiplyByPoint(
				inverseEnu,
				_boundsPointCartesian,
				_boundsPointCartesian,
			);

			// 累计 (x, y) min/max(丢弃 z)
			const ex = _boundsPointCartesian.x;
			const ey = _boundsPointCartesian.y;
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
 * 产 6 个 PlanarExtents uniform。
 *
 * 算法 5 步(与原 geometry.ts:233-298 字节级一致):
 *   Step 1 · 中心点:rectangleCenter(polygonRectangle) → 改 height = maxHeight → ECEF
 *   Step 2 · ENU 矩阵:eastNorthUpToFixedFrame(centerCartesian)
 *            + ecefToEnu = enuMatrix.invert()
 *   Step 3 · ENU 平面 AABB:computePolygonPlanarBounds(hierarchy, maxHeight, ecefToEnu)
 *   Step 4 · 三个角点(SW, SE, NW)在 ENU 平面坐标(米),
 *            通过 enuMatrix × (x, y, 0) 变回 ECEF
 *            → eastward = SE - SW,northward = NW - SW
 *   Step 5 · RTE 编码 SW(把 ECEF Float64 拆为 Float32 high/low),
 *            装配 PlanarExtents 6 字段
 *
 * 注:本函数不修改输入 hierarchy 与 polygonRectangle。
 *
 * @param polygonRectangle Outer ring 外接 lon/lat 矩形(弧度,由 computePolygonRectangle 产)。
 * @param hierarchy        Polygon hierarchy(Vector3 ECEF,已校验)。
 * @param maximumHeight    顶面高度(米),作为 ENU 平面参考高度。
 * @returns                PlanarExtents(6 个 uniform 字段)。
 */
export function computePolygonPlanarExtents(
	polygonRectangle: RectangleRadians,
	hierarchy: PolygonHierarchy,
	maximumHeight: number,
): PlanarExtents {
	// Step 1 · center cartographic(矩形几何中心)→ at maxHeight → ECEF
	rectangleCenter( polygonRectangle, _extentsCenterCarto );
	_extentsCenterCarto.height = maximumHeight;
	cartographicToCartesian( _extentsCenterCarto, _extentsCenterCartesian );

	// Step 2 · ENU 矩阵 + 逆矩阵
	eastNorthUpToFixedFrame( _extentsCenterCartesian, _extentsEnuMatrix );
	_extentsInverseEnu.copy( _extentsEnuMatrix ).invert();

	// Step 3 · ENU 平面 AABB
	const bounds = computePolygonPlanarBounds(
		hierarchy,
		maximumHeight,
		_extentsInverseEnu,
	);
	const eastExtentMeters = Math.max( bounds.maxX - bounds.minX, 1.0 );
	const northExtentMeters = Math.max( bounds.maxY - bounds.minY, 1.0 );

	// Step 4 · SW / SE / NW 三个角点
	// (在 ENU 平面 z=0 处取角点,然后 enuMatrix 变回 ECEF)
	_extentsSWCartesian.set( bounds.minX, bounds.minY, 0.0 );
	matrix4MultiplyByPoint( _extentsEnuMatrix, _extentsSWCartesian, _extentsSWCartesian );

	_extentsSECartesian.set( bounds.maxX, bounds.minY, 0.0 );
	matrix4MultiplyByPoint( _extentsEnuMatrix, _extentsSECartesian, _extentsSECartesian );

	_extentsNWCartesian.set( bounds.minX, bounds.maxY, 0.0 );
	matrix4MultiplyByPoint( _extentsEnuMatrix, _extentsNWCartesian, _extentsNWCartesian );

	// eastward = SE - SW(SW → SE 的米向量)
	// northward = NW - SW(SW → NW 的米向量)
	// 注:**新建** Vector3 返回(下游 uniform 持有引用),不能用 scratch。
	const eastward = new Vector3(
		_extentsSECartesian.x - _extentsSWCartesian.x,
		_extentsSECartesian.y - _extentsSWCartesian.y,
		_extentsSECartesian.z - _extentsSWCartesian.z,
	);
	const northward = new Vector3(
		_extentsNWCartesian.x - _extentsSWCartesian.x,
		_extentsNWCartesian.y - _extentsSWCartesian.y,
		_extentsNWCartesian.z - _extentsSWCartesian.z,
	);

	// Step 5 · RTE 编码 SW 角点
	encodeVec3RTE( _extentsSWCartesian, _extentsHigh, _extentsLow );
	const southWestHigh = new Vector3( _extentsHigh.x, _extentsHigh.y, _extentsHigh.z );
	const southWestLow = new Vector3( _extentsLow.x, _extentsLow.y, _extentsLow.z );

	return {
		southWestHigh,
		southWestLow,
		eastward,
		northward,
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		innerMetersRect: new Vector4( 0.0, 0.0, eastExtentMeters, northExtentMeters ),
	};
}
