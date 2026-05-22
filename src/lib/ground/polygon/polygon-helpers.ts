// ============================================================
// polygon/polygon-helpers.ts — Polygon plot-spec 适配 helper(centroid + 米外扩)
// 层级:L2(基于 math/ellipsoid + math/enu-frame + math/matrix4-helpers + math/cartographic)
// 职责:把 plot-spec 层面的 lon/lat 度坐标外扩 strokeWidth 米,产 render 多边形顶点。
//      逻辑零改动地迁移自 primitives.ts:154-231:
//        - computePolygonCentroidDegrees:算术平均 lon/lat
//        - expandPolygonPointsThroughMeters:在 centroid 切平面(ENU)上沿径向外扩
//      唯一变化是把 Cesium Cartographic / Cartesian3 / Matrix4 / Transforms
//      全部替换为 math/* 中的等价 API,polygon 路径从此不再 import cesium-ground-source。
// 依赖:Three.js Matrix4 / Vector3,
//      math/cartographic.ts、math/ellipsoid.ts、math/enu-frame.ts、
//      math/matrix4-helpers.ts、constants.ts(BORDER_GEOMETRY_EXPANSION_SCALE)、
//      types.ts(LonLatPoint)
// 被消费:primitives.ts(CesiumGroundPolygonPrimitive 构造器)
// 算法对应:迁移自 src/lib/ground/primitives.ts:154-231(本期完成后,原函数删除)
// ============================================================

import { Matrix4, Vector3 } from 'three';

import { BORDER_GEOMETRY_EXPANSION_SCALE } from '../constants';
import { createCartographic } from '../math/cartographic';
import { cartesianToCartographic, cartographicToCartesian } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import type { LonLatPoint } from '../types';

/**
 * 计算 polygon lon/lat 顶点的算术中心(度)。
 *
 * 简单的算术平均;不投影到椭球面、不做 winding 校正。仅用于
 * `expandPolygonPointsThroughMeters` 的 ENU 切平面原点。
 *
 * @param points 已通过 normalizePolygonPoints 校验的 [lon, lat] 数组。
 * @returns      算术中心 [lonAvg, latAvg](度)。
 */
export function computePolygonCentroidDegrees(
	points: readonly LonLatPoint[],
): LonLatPoint {
	let longitudeSum = 0.0;
	let latitudeSum = 0.0;

	for ( let i = 0; i < points.length; i++ ) {
		longitudeSum += points[ i ][ 0 ];
		latitudeSum += points[ i ][ 1 ];
	}

	const inverseCount = 1.0 / points.length;
	return [
		longitudeSum * inverseCount,
		latitudeSum * inverseCount,
	];
}

// ── 模块级 scratch:expandPolygonPointsThroughMeters 复用 ──
// 每次调用此函数都会重置 scratch,不需要跨调用持久化。
const _expandCenterCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _expandCenterCartesian = new Vector3();
const _expandEnuMatrix = new Matrix4();
const _expandInverseEnu = new Matrix4();
const _expandPointCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _expandPointCartesian = new Vector3();
const _expandPointEnu = new Vector3();
const _shapeCenterCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _shapeCenterCartesian = new Vector3();
const _shapeEnuMatrix = new Matrix4();
const _shapeInverseEnu = new Matrix4();
const _shapePointCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _shapePointCartesian = new Vector3();
const _shapePointEnu = new Vector3();
const _shapeResultEnu = new Vector3();

function cloneLonLatPoints( points: readonly LonLatPoint[] ): LonLatPoint[] {
	const cloned: LonLatPoint[] = new Array( points.length );
	for ( let i = 0; i < points.length; i++ ) {
		cloned[ i ] = [ points[ i ][ 0 ], points[ i ][ 1 ] ];
	}
	return cloned;
}

/**
 * Applies local ENU rotation to polygon points.
 *
 * @param points Normalized polygon lon/lat points.
 * @param rotationDegrees Counter-clockwise rotation in degrees.
 * @returns Transformed polygon lon/lat points.
 */
export function transformPolygonPoints(
	points: readonly LonLatPoint[],
	rotationDegrees: number,
	centerDegrees = computePolygonCentroidDegrees( points ),
): LonLatPoint[] {
	const safeRotationDegrees = Number.isFinite( rotationDegrees ) ? rotationDegrees : 0.0;

	if ( safeRotationDegrees === 0.0 ) {
		return cloneLonLatPoints( points );
	}

	_shapeCenterCartographic.longitude = centerDegrees[ 0 ] * Math.PI / 180.0;
	_shapeCenterCartographic.latitude = centerDegrees[ 1 ] * Math.PI / 180.0;
	_shapeCenterCartographic.height = 0.0;
	cartographicToCartesian( _shapeCenterCartographic, _shapeCenterCartesian );
	eastNorthUpToFixedFrame( _shapeCenterCartesian, _shapeEnuMatrix );
	_shapeInverseEnu.copy( _shapeEnuMatrix ).invert();

	const rotationRadians = safeRotationDegrees * Math.PI / 180.0;
	const cosRotation = Math.cos( rotationRadians );
	const sinRotation = Math.sin( rotationRadians );
	const result: LonLatPoint[] = new Array( points.length );

	for ( let i = 0; i < points.length; i++ ) {
		const point = points[ i ];
		_shapePointCartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		_shapePointCartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		_shapePointCartographic.height = 0.0;
		cartographicToCartesian( _shapePointCartographic, _shapePointCartesian );
		matrix4MultiplyByPoint( _shapeInverseEnu, _shapePointCartesian, _shapePointEnu );

		const localEast = _shapePointEnu.x;
		const localNorth = _shapePointEnu.y;
		_shapeResultEnu.set(
			localEast * cosRotation - localNorth * sinRotation,
			localEast * sinRotation + localNorth * cosRotation,
			0.0,
		);

		matrix4MultiplyByPoint( _shapeEnuMatrix, _shapeResultEnu, _shapePointCartesian );
		const carto = cartesianToCartographic( _shapePointCartesian, _shapePointCartographic );
		if ( carto === undefined ) {
			throw new Error(
				`transformPolygonPoints: vertex #${ i } transformed to ellipsoid center, cannot reverse-project.`,
			);
		}

		result[ i ] = [
			carto.longitude * 180.0 / Math.PI,
			carto.latitude * 180.0 / Math.PI,
		];
	}

	return result;
}

/**
 * 把 polygon lon/lat 顶点沿"远离 centroid 的方向"外扩 strokeWidth 米。
 *
 * 用途:render(描边覆盖)多边形需要比 fill(填充)多边形外扩 strokeWidth 米,
 * 使描边带完整可见。
 *
 * 算法(与 primitives.ts:180-231 字节级一致):
 *   1. centroid = 算术平均 lon/lat(度)
 *   2. 在 centroid 上构造 ENU → ECEF 矩阵 M(用 math/enu-frame.ts)
 *   3. inverseM = M.invert()
 *   4. 对每个输入顶点 (lon°, lat°):
 *      a. lonLat → ECEF (cartographicToCartesian,高度 = 0)
 *      b. 用 inverseM 把 ECEF 拉到 ENU 局部坐标系 (e, n, u)
 *      c. 在 ENU 平面上计算"远离 ENU 原点"的方向(基于 atan2 → 单位向量),
 *         沿此方向把 (e, n) 拉远 strokeWidth × BORDER_GEOMETRY_EXPANSION_SCALE 米
 *      d. 用 M 把扩张后的 ENU 点变换回 ECEF
 *      e. ECEF → cartographic(cartesianToCartographic)
 *      f. 把弧度 lon/lat 转回度,放入结果数组
 *
 * 注:BORDER_GEOMETRY_EXPANSION_SCALE 当前值为 1.0(constants.ts),即没有额外缩放。
 *
 * @param points            原始 polygon lon/lat 度坐标(已 normalize)。
 * @param borderWidthMeters 外扩距离,米(典型 0~500)。
 * @returns                 外扩后的 lon/lat 度坐标(与输入同长度)。
 *                          borderWidthMeters ≤ 0 时返回输入的浅拷贝(不外扩)。
 */
export function expandPolygonPointsThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
): LonLatPoint[] {
	const safeWidthMeters = Math.max( borderWidthMeters, 0.0 ) * BORDER_GEOMETRY_EXPANSION_SCALE;
	if ( safeWidthMeters === 0.0 ) {
		// 0 外扩:返回浅拷贝(每个 LonLatPoint 是新数组)。
		// 保持与原 primitives.ts:185-187 同行为。
		const result: LonLatPoint[] = new Array( points.length );
		for ( let i = 0; i < points.length; i++ ) {
			result[ i ] = [ points[ i ][ 0 ], points[ i ][ 1 ] ];
		}
		return result;
	}

	// Step 1 · centroid(度)
	const centroid = computePolygonCentroidDegrees( points );

	// Step 2 · centroid 度 → 弧度 cartographic → ECEF
	_expandCenterCartographic.longitude = centroid[ 0 ] * Math.PI / 180.0;
	_expandCenterCartographic.latitude = centroid[ 1 ] * Math.PI / 180.0;
	_expandCenterCartographic.height = 0.0;
	cartographicToCartesian( _expandCenterCartographic, _expandCenterCartesian );

	// Step 3 · 在 centroid ECEF 上构造 ENU → ECEF 矩阵 + 其逆矩阵
	eastNorthUpToFixedFrame( _expandCenterCartesian, _expandEnuMatrix );
	_expandInverseEnu.copy( _expandEnuMatrix ).invert();

	// Step 4 · 逐顶点外扩
	const result: LonLatPoint[] = new Array( points.length );
	for ( let i = 0; i < points.length; i++ ) {
		const point = points[ i ];

		// 4a · 度 → 弧度 cartographic → ECEF
		_expandPointCartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		_expandPointCartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		_expandPointCartographic.height = 0.0;
		cartographicToCartesian( _expandPointCartographic, _expandPointCartesian );

		// 4b · ECEF → ENU 局部 (e, n, u)
		matrix4MultiplyByPoint(
			_expandInverseEnu,
			_expandPointCartesian,
			_expandPointEnu,
		);

		// 4c · 在 ENU 平面上沿径向外扩
		// 与原 primitives.ts:216-221 完全一致:
		//   length = √(e² + n²);若 > 1e-6,沿 (e/length, n/length) 方向加 safeWidthMeters
		//   等价 pointEnu *= (1 + safeWidthMeters / length)
		const length = Math.hypot( _expandPointEnu.x, _expandPointEnu.y );
		if ( length > 1e-6 ) {
			const expansion = safeWidthMeters / length;
			_expandPointEnu.x += _expandPointEnu.x * expansion;
			_expandPointEnu.y += _expandPointEnu.y * expansion;
		}
		// 若 length ≤ 1e-6(顶点几乎在 centroid 上),不外扩(避免除零)。

		// 4d · 扩张后 ENU → ECEF
		matrix4MultiplyByPoint(
			_expandEnuMatrix,
			_expandPointEnu,
			_expandPointCartesian,
		);

		// 4e · ECEF → cartographic(弧度)
		const carto = cartesianToCartographic( _expandPointCartesian, _expandPointCartographic );
		if ( carto === undefined ) {
			throw new Error(
				`expandPolygonPointsThroughMeters: vertex #${ i } expanded to ellipsoid center, cannot reverse-project.`,
			);
		}

		// 4f · 弧度 → 度,放入结果
		result[ i ] = [
			carto.longitude * 180.0 / Math.PI,
			carto.latitude * 180.0 / Math.PI,
		];
	}

	return result;
}
