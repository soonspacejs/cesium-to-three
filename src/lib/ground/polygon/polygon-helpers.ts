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
 * 把 polygon lon/lat 顶点**沿每条相邻边的外法线角平分线**外扩 N 米
 *(per-edge perpendicular offset,即 polyline miter join 的扩展)。
 *
 * 用途:render(描边覆盖)多边形需要比 fill(填充)多边形外扩 strokeWidth 米,
 * 使描边带宽度沿周界均匀。
 *
 * **为什么放弃 centroid-径向外扩**:
 *   早期实现把每个顶点沿"centroid → 顶点"径向推 N 米。这种方法只适合星形
 *   多边形(每个顶点都从 centroid 看得到、且该方向接近边的外法线方向):
 *   方/圆/凸五边形等正多边形描边均匀。但对于:
 *     - 细长形(箭头体部)
 *     - 弯曲形(curved arrow 的曲线脊线偏移带)
 *     - 大宽高比 / 拐弯多的多边形
 *   centroid 落在多边形的几何中心,曲线**内侧**顶点的径向方向几乎**平行于
 *   局部边**,N 米径向外推几乎没产生"垂直边距" → 描边带在那一侧崩成零宽。
 *
 *   per-edge 角平分线方法在每个顶点处:
 *     1. 计算入射边与出射边的单位方向向量。
 *     2. 计算各自的"外法线"(CCW 多边形 → 右手 90° 旋转;通过有向面积判定
 *        winding,CW 自动取反方向)。
 *     3. 在两条"外法线方向各偏 N 米的平行边线"的交点处放置新顶点。
 *        等价公式:沿外法线角平分线方向位移 N / sin(θ/2),其中 θ 是内角。
 *     4. 锐角(θ → 0)时 1/sin(θ/2) → ∞,用 MITER_LIMIT_RATIO clamp,
 *        避免箭头尖端等位置出现荒谬的几何延伸。
 *
 *   下游的 fragment shader(materials.ts 的 `c23_pointInsidePolygon` 路径)
 *   用偶奇规则测试 fragment 是否在 fill 多边形内,在 fill 外但在 render 内
 *   就画描边色。只要 render 多边形是 fill 多边形的均匀外扩,描边宽度就均匀。
 *
 * 算法步骤:
 *   1. centroid(度) → ENU 切平面矩阵 M + 逆矩阵(同原版,平面近似)。
 *   2. 把所有 fill 顶点投到 ENU 平面 (e, n) 坐标。
 *   3. 用 shoelace 计算 ENU 平面的有向面积,判定 winding(> 0 → CCW)。
 *   4. 对每个顶点 Vi:
 *      a. 单位入射边 e_prev、单位出射边 e_next
 *      b. 外法线 p_prev = sign × (e_prev.y, -e_prev.x)、p_next 同理
 *         (sign = +1 for CCW,-1 for CW;保证 p 总是指向多边形外侧)
 *      c. 角平分线 b = p_prev + p_next,bisector_unit = b / |b|
 *      d. miterLength = N / dot(bisector_unit, p_next)
 *         (= N / sin(θ/2),θ = 多边形在 Vi 的内角)
 *      e. clamp:|miterLength| ≤ MITER_LIMIT_RATIO × N
 *      f. Vi' = Vi + miterLength × bisector_unit
 *   5. 把所有 Vi' 反向投到 lon/lat。
 *
 * 数值兜底:
 *   - 相邻边退化(零长度):跳过该顶点的法线计算,保留原位置。
 *   - 角平分线退化(两边 180° 反向 = 折回点):用单边法线方向偏移 N 米。
 *   - cos(θ/2) → 0(180° 折回):用 N 兜底而不是 N/0。
 *
 * @param points            原始 polygon lon/lat 度坐标(已 normalize)。
 * @param borderWidthMeters 外扩距离,米(典型 0~500)。
 * @returns                 外扩后的 lon/lat 度坐标(与输入等长 — miter 不增减顶点)。
 *                          borderWidthMeters ≤ 0 时返回输入的浅拷贝(不外扩)。
 */
export function expandPolygonPointsThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
): LonLatPoint[] {
	const safeWidthMeters = Math.max( borderWidthMeters, 0.0 ) * BORDER_GEOMETRY_EXPANSION_SCALE;
	if ( safeWidthMeters === 0.0 ) {
		// 0 外扩:返回浅拷贝(每个 LonLatPoint 是新数组),与原版同行为。
		const result: LonLatPoint[] = new Array( points.length );
		for ( let i = 0; i < points.length; i++ ) {
			result[ i ] = [ points[ i ][ 0 ], points[ i ][ 1 ] ];
		}
		return result;
	}

	const n = points.length;
	if ( n < 3 ) {
		// 顶点不足以构成多边形,无法定义"外法线",直接浅拷贝返回。
		const result: LonLatPoint[] = new Array( n );
		for ( let i = 0; i < n; i++ ) {
			result[ i ] = [ points[ i ][ 0 ], points[ i ][ 1 ] ];
		}
		return result;
	}

	// 步骤 1 · centroid(度) → ENU 矩阵 + 逆矩阵
	const centroid = computePolygonCentroidDegrees( points );
	_expandCenterCartographic.longitude = centroid[ 0 ] * Math.PI / 180.0;
	_expandCenterCartographic.latitude = centroid[ 1 ] * Math.PI / 180.0;
	_expandCenterCartographic.height = 0.0;
	cartographicToCartesian( _expandCenterCartographic, _expandCenterCartesian );

	eastNorthUpToFixedFrame( _expandCenterCartesian, _expandEnuMatrix );
	_expandInverseEnu.copy( _expandEnuMatrix ).invert();

	// 步骤 2 · 全部顶点投到 ENU 平面 (e, n)。本地数组,后续算法只关心 x/y。
	const enuVerts: number[] = new Array( n * 2 );
	for ( let i = 0; i < n; i++ ) {
		const point = points[ i ];
		_expandPointCartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		_expandPointCartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		_expandPointCartographic.height = 0.0;
		cartographicToCartesian( _expandPointCartographic, _expandPointCartesian );
		matrix4MultiplyByPoint( _expandInverseEnu, _expandPointCartesian, _expandPointEnu );
		enuVerts[ 2 * i ] = _expandPointEnu.x;
		enuVerts[ 2 * i + 1 ] = _expandPointEnu.y;
	}

	// 步骤 3 · winding 检测(shoelace),决定外法线的"右手 90°"是 +1 还是 -1
	let signedArea2 = 0.0;
	for ( let i = 0; i < n; i++ ) {
		const ax = enuVerts[ 2 * i ];
		const ay = enuVerts[ 2 * i + 1 ];
		const bx = enuVerts[ 2 * ( ( i + 1 ) % n ) ];
		const by = enuVerts[ 2 * ( ( i + 1 ) % n ) + 1 ];
		signedArea2 += ax * by - bx * ay;
	}
	const windingSign = signedArea2 >= 0.0 ? 1.0 : -1.0;

	// 步骤 4 · 逐顶点 miter 偏移
	const N = safeWidthMeters;
	const offsetX: number[] = new Array( n );
	const offsetY: number[] = new Array( n );

	for ( let i = 0; i < n; i++ ) {
		const prevI = ( i - 1 + n ) % n;
		const nextI = ( i + 1 ) % n;

		const px = enuVerts[ 2 * prevI ];
		const py = enuVerts[ 2 * prevI + 1 ];
		const cx = enuVerts[ 2 * i ];
		const cy = enuVerts[ 2 * i + 1 ];
		const nx = enuVerts[ 2 * nextI ];
		const ny = enuVerts[ 2 * nextI + 1 ];

		// 入射边 e_prev = curr - prev,出射边 e_next = next - curr
		let ePrevX = cx - px;
		let ePrevY = cy - py;
		const ePrevLen = Math.hypot( ePrevX, ePrevY );
		let eNextX = nx - cx;
		let eNextY = ny - cy;
		const eNextLen = Math.hypot( eNextX, eNextY );

		if ( ePrevLen < 1e-9 && eNextLen < 1e-9 ) {
			// 两条相邻边都退化:无法定义法线,顶点保持原位。
			offsetX[ i ] = cx;
			offsetY[ i ] = cy;
			continue;
		}
		if ( ePrevLen >= 1e-9 ) {
			ePrevX /= ePrevLen;
			ePrevY /= ePrevLen;
		} else {
			// 入射边退化:用出射边方向兜底(后续 bisector 仍可计算)
			ePrevX = eNextX / eNextLen;
			ePrevY = eNextY / eNextLen;
		}
		if ( eNextLen >= 1e-9 ) {
			eNextX /= eNextLen;
			eNextY /= eNextLen;
		} else {
			eNextX = ePrevX;
			eNextY = ePrevY;
		}

		// 外法线 = winding × (edge.y, -edge.x)
		// (右手 90° 顺时针旋转:对 CCW 多边形指向外侧;CW 多边形 sign 取负,
		//  方向自动反转。)
		const pPrevNX = windingSign * ePrevY;
		const pPrevNY = - windingSign * ePrevX;
		const pNextNX = windingSign * eNextY;
		const pNextNY = - windingSign * eNextX;

		// 角平分线 = 两外法线之和
		const bisX = pPrevNX + pNextNX;
		const bisY = pPrevNY + pNextNY;
		const bisLen = Math.hypot( bisX, bisY );

		if ( bisLen < 1e-9 ) {
			// 两外法线反向(= 入射出射边 180° 折回点)。这种顶点在多边形上
			// 是一个"针尖",此处无明确外侧方向。退化为沿入射边外法线偏移 N。
			offsetX[ i ] = cx + N * pPrevNX;
			offsetY[ i ] = cy + N * pPrevNY;
			continue;
		}

		const bisUnitX = bisX / bisLen;
		const bisUnitY = bisY / bisLen;

		// cos(θ/2) = bisUnit · p_next(也等于 bisUnit · p_prev,因为是角平分线)
		// θ 是多边形在该顶点的内角;为了让 sin(θ/2) > 0(凸顶点)我们用 cos(θ/2)
		// 等价表达 miterLength = N / cos(夹角的 1/2)。
		const cosHalf = bisUnitX * pNextNX + bisUnitY * pNextNY;

		let miterLength: number;
		if ( Math.abs( cosHalf ) < 1e-9 ) {
			// θ/2 → 90° (= θ → 180°,即两边几乎平行同向):miter 退化为 N。
			miterLength = N;
		} else {
			miterLength = N / cosHalf;
		}

		// MITER LIMIT:锐角(小 θ)处 miterLength 会爆炸。clamp 到 N × ratio,
		// 视觉上把"尖锐尖端"变成"截断尖端",避免荒谬几何延伸。比值 4.0 对应
		// θ ≈ 28.96°(2 arcsin(1/4))之下才会触发 clamp,比箭头头部典型角度
		// (~30°)略松,默认箭头形态下基本不会被钳。
		const MITER_LIMIT_RATIO = 4.0;
		const miterCap = N * MITER_LIMIT_RATIO;
		if ( miterLength > miterCap ) {
			miterLength = miterCap;
		} else if ( miterLength < - miterCap ) {
			// 理论上 miterLength 不应为负(cosHalf > 0 当顶点在多边形外侧),
			// 但数值噪声或退化输入可能引发,这里对称保护。
			miterLength = - miterCap;
		}

		offsetX[ i ] = cx + miterLength * bisUnitX;
		offsetY[ i ] = cy + miterLength * bisUnitY;
	}

	// 步骤 5 · 反向投影 ENU → ECEF → cartographic → 度
	const result: LonLatPoint[] = new Array( n );
	for ( let i = 0; i < n; i++ ) {
		_expandPointEnu.set( offsetX[ i ], offsetY[ i ], 0.0 );
		matrix4MultiplyByPoint(
			_expandEnuMatrix,
			_expandPointEnu,
			_expandPointCartesian,
		);
		const carto = cartesianToCartographic( _expandPointCartesian, _expandPointCartographic );
		if ( carto === undefined ) {
			throw new Error(
				`expandPolygonPointsThroughMeters: vertex #${ i } expanded to ellipsoid center, cannot reverse-project.`,
			);
		}
		result[ i ] = [
			carto.longitude * 180.0 / Math.PI,
			carto.latitude * 180.0 / Math.PI,
		];
	}

	return result;
}
