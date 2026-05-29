// ============================================================
// ArrowUtils.ts — 箭头几何工具（纯 2D 经纬度）
// 层级：L1（utils 工具层）
// 职责：暴露辅助几何函数（MathDistance / Mid / getThirdPoint / getNormal /
//       getBisectorNormals / getCurvePoints / getQBSplinePoints 等）和顶层
//       箭头生成函数（createFineArrow / createAssaultDirectionArrow /
//       createAttackArrow / createSwallowtailAttackArrow / createCurvedArrow）。
//       辅助几何函数为纯 2D 度平面计算；顶层 create* 委托给 c2t arrow SDK
//       （src/lib/arrow），由后者按 ENU 米平面构造、已 CCW 规范化、
//       去重并 clamp ≤120 顶点。
// 依赖：../../../arrow（c2t arrow SDK）。
// 被消费：plugins/arrow.ts（GisPlotArrow.generateCoords）—— 现已直接调用
//       c2t arrow SDK；ArrowUtils.ts 的 create* 仅作为对外契约兼容入口保留。
//
// 算法常量：
//   FITTING_COUNT  = 100      每段三次 Bézier 采样段数（getCurvePoints 用）。
//   ZERO_TOLERANCE = 0.0001   角平分线法向量长度阈值，小于视为共线。
// ============================================================

import {
	createAssaultDirectionArrow as c2tCreateAssaultDirectionArrow,
	createAttackArrow as c2tCreateAttackArrow,
	createCurvedArrow as c2tCreateCurvedArrow,
	createFineArrow as c2tCreateFineArrow,
	createSwallowtailAttackArrow as c2tCreateSwallowtailAttackArrow,
} from '../../../arrow';

/** 经纬度顶点：[lon°, lat°]。 */
export type LonLat = [ number, number ];

/** 每段三次 Bézier 采样段数（getCurvePoints 用）。 */
export const FITTING_COUNT = 100;
/** 角平分线法向量长度阈值，小于视为共线。 */
export const ZERO_TOLERANCE = 0.0001;

// ────────────────────────────────────────────────────────────
// 基础几何工具
// ────────────────────────────────────────────────────────────

/**
 * 经纬度平面欧氏距离（把度当作平面坐标，仅用于参考项目原算法保持等价；
 * 在小范围内足够近似）。
 *
 * @param p1 顶点 1。
 * @param p2 顶点 2。
 * @returns  欧氏距离（度）。
 */
export function MathDistance( p1: LonLat, p2: LonLat ): number {
	const dx = p1[ 0 ] - p2[ 0 ];
	const dy = p1[ 1 ] - p2[ 1 ];
	return Math.sqrt( dx * dx + dy * dy );
}

/**
 * 折线总长（顺序累加段长度）。
 *
 * @param points 折线顶点序列。
 * @returns      累计长度（度）。
 */
export function wholeDistance( points: LonLat[] ): number {
	let total = 0;
	for ( let i = 0; i < points.length - 1; i++ ) {
		total += MathDistance( points[ i ], points[ i + 1 ] );
	}
	return total;
}

/**
 * 总长的 0.99 次幂（作为箭头宽度尺度），使长箭头宽度增长略慢于线性。
 *
 * @param points 折线顶点序列。
 * @returns      宽度尺度（度）。
 */
export function getBaseLength( points: LonLat[] ): number {
	return Math.pow( wholeDistance( points ), 0.99 );
}

/**
 * 两点中点。
 *
 * @param p1 顶点 1。
 * @param p2 顶点 2。
 * @returns  中点。
 */
export function Mid( p1: LonLat, p2: LonLat ): LonLat {
	return [ ( p1[ 0 ] + p2[ 0 ] ) / 2, ( p1[ 1 ] + p2[ 1 ] ) / 2 ];
}

/**
 * 求由 startPnt 指向 endPnt 的方位角（与 +x 轴夹角，逆时针为正，单位弧度，
 * 范围 [0, 2π) ）。
 *
 * @param startPnt 起点。
 * @param endPnt   终点。
 * @returns        方位角（弧度）。
 */
export function getAzimuth( startPnt: LonLat, endPnt: LonLat ): number {
	let azimuth: number;
	const angle = Math.asin(
		Math.abs( endPnt[ 1 ] - startPnt[ 1 ] ) / MathDistance( startPnt, endPnt ),
	);
	if ( endPnt[ 1 ] >= startPnt[ 1 ] && endPnt[ 0 ] >= startPnt[ 0 ] ) {
		azimuth = angle + Math.PI;
	} else if ( endPnt[ 1 ] >= startPnt[ 1 ] && endPnt[ 0 ] < startPnt[ 0 ] ) {
		azimuth = Math.PI * 2 - angle;
	} else if ( endPnt[ 1 ] < startPnt[ 1 ] && endPnt[ 0 ] < startPnt[ 0 ] ) {
		azimuth = angle;
	} else {
		azimuth = Math.PI - angle;
	}
	return azimuth;
}

/**
 * 三点夹角（pntB 为顶点），返回 [0, π] 内的弧度。
 *
 * @param a 点 A。
 * @param b 顶点 B。
 * @param c 点 C。
 * @returns 夹角弧度。
 */
export function getAngleOfThreePoints( a: LonLat, b: LonLat, c: LonLat ): number {
	const angle = getAzimuth( b, a ) - getAzimuth( b, c );
	return angle < 0 ? angle + Math.PI * 2 : angle;
}

/**
 * 判断 p1 → p2 → p3 是否顺时针。
 *
 * @param p1 顶点 1。
 * @param p2 顶点 2。
 * @param p3 顶点 3。
 * @returns  顺时针返回 true。
 */
export function isClockWise( p1: LonLat, p2: LonLat, p3: LonLat ): boolean {
	return (
		( p3[ 1 ] - p1[ 1 ] ) * ( p2[ 0 ] - p1[ 0 ] ) >
		( p2[ 1 ] - p1[ 1 ] ) * ( p3[ 0 ] - p1[ 0 ] )
	);
}

/**
 * 以 endPnt 为基，根据相对 startPnt 的方位角 ± angle、距离 distance 求第三点。
 * 箭翼 / 颈的构造核心。
 *
 * @param startPnt  起点。
 * @param endPnt    基准点（作为第三点的起点）。
 * @param angle     相对原方位的偏角（弧度）。
 * @param distance  距离（度，与平面距离一致）。
 * @param clockwise true=顺时针偏角，false=逆时针偏角。
 * @returns         第三点经纬度。
 */
export function getThirdPoint(
	startPnt: LonLat,
	endPnt: LonLat,
	angle: number,
	distance: number,
	clockwise: boolean,
): LonLat {
	const azimuth = getAzimuth( startPnt, endPnt );
	const alpha = clockwise ? azimuth + angle : azimuth - angle;
	const dx = distance * Math.cos( alpha );
	const dy = distance * Math.sin( alpha );
	return [ endPnt[ 0 ] + dx, endPnt[ 1 ] + dy ];
}

/**
 * 取 (p2 - p1) 与 (p3 - p2) 的角平分线方向向量。
 *
 * @param p1 顶点 1。
 * @param p2 顶点 2。
 * @param p3 顶点 3。
 * @returns  法向（未归一化）。
 */
export function getNormal( p1: LonLat, p2: LonLat, p3: LonLat ): LonLat {
	let dX1 = p1[ 0 ] - p2[ 0 ];
	let dY1 = p1[ 1 ] - p2[ 1 ];
	const d1 = Math.sqrt( dX1 * dX1 + dY1 * dY1 );
	dX1 /= d1;
	dY1 /= d1;
	let dX2 = p3[ 0 ] - p2[ 0 ];
	let dY2 = p3[ 1 ] - p2[ 1 ];
	const d2 = Math.sqrt( dX2 * dX2 + dY2 * dY2 );
	dX2 /= d2;
	dY2 /= d2;
	const uX = dX1 + dX2;
	const uY = dY1 + dY2;
	return [ uX, uY ];
}

/**
 * 角平分线法向量对（曲线控制）。返回 [leftPnt, rightPnt]。
 *
 * @param t   控制点偏移系数。
 * @param p1  顶点 1。
 * @param p2  顶点 2。
 * @param p3  顶点 3。
 * @returns   左右两个 Bézier 控制点。
 */
export function getBisectorNormals(
	t: number,
	p1: LonLat,
	p2: LonLat,
	p3: LonLat,
): [ LonLat, LonLat ] {
	const normal = getNormal( p1, p2, p3 );
	let bisectorNormalRight: LonLat;
	let bisectorNormalLeft: LonLat;
	let dt: number;
	let x: number;
	let y: number;
	const dist = Math.sqrt( normal[ 0 ] * normal[ 0 ] + normal[ 1 ] * normal[ 1 ] );
	const uX = normal[ 0 ] / dist;
	const uY = normal[ 1 ] / dist;
	const d1 = MathDistance( p1, p2 );
	const d2 = MathDistance( p2, p3 );
	if ( dist > ZERO_TOLERANCE ) {
		if ( isClockWise( p1, p2, p3 ) ) {
			dt = t * d1;
			x = p2[ 0 ] - dt * uY;
			y = p2[ 1 ] + dt * uX;
			bisectorNormalRight = [ x, y ];
			dt = t * d2;
			x = p2[ 0 ] + dt * uY;
			y = p2[ 1 ] - dt * uX;
			bisectorNormalLeft = [ x, y ];
		} else {
			dt = t * d1;
			x = p2[ 0 ] + dt * uY;
			y = p2[ 1 ] - dt * uX;
			bisectorNormalRight = [ x, y ];
			dt = t * d2;
			x = p2[ 0 ] - dt * uY;
			y = p2[ 1 ] + dt * uX;
			bisectorNormalLeft = [ x, y ];
		}
	} else {
		x = p2[ 0 ] + t * ( p1[ 0 ] - p2[ 0 ] );
		y = p2[ 1 ] + t * ( p1[ 1 ] - p2[ 1 ] );
		bisectorNormalRight = [ x, y ];
		x = p2[ 0 ] + t * ( p3[ 0 ] - p2[ 0 ] );
		y = p2[ 1 ] + t * ( p3[ 1 ] - p2[ 1 ] );
		bisectorNormalLeft = [ x, y ];
	}
	return [ bisectorNormalRight, bisectorNormalLeft ];
}

/**
 * 取折线最左控制点（与 getRightMostControlPoint 对称使用）。
 *
 * @param controlPoints 控制点序列。
 * @returns 最左侧 Bézier 控制点。
 */
function getLeftMostControlPoint( controlPoints: LonLat[] ): LonLat {
	const pnt1 = controlPoints[ 0 ];
	const pnt2 = controlPoints[ 1 ];
	const pnt3 = controlPoints[ 2 ];
	const pnts = getBisectorNormals( 0, pnt1, pnt2, pnt3 );
	const normalRight = pnts[ 0 ];
	const normal = getNormal( pnt1, pnt2, pnt3 );
	const dist = Math.sqrt( normal[ 0 ] * normal[ 0 ] + normal[ 1 ] * normal[ 1 ] );
	let controlPoint: LonLat;
	if ( dist > ZERO_TOLERANCE ) {
		const mid = Mid( pnt1, pnt2 );
		const pX = pnt1[ 0 ] - mid[ 0 ];
		const pY = pnt1[ 1 ] - mid[ 1 ];
		const d1 = MathDistance( pnt1, pnt2 );
		// normal 一定旋转 90°
		const n = 2.0 / d1;
		const nX = - n * pY;
		const nY = n * pX;
		const a11 = nX * nX - nY * nY;
		const a12 = 2 * nX * nY;
		const a22 = nY * nY - nX * nX;
		const dX = normalRight[ 0 ] - mid[ 0 ];
		const dY = normalRight[ 1 ] - mid[ 1 ];
		controlPoint = [
			mid[ 0 ] + a11 * dX + a12 * dY,
			mid[ 1 ] + a12 * dX + a22 * dY,
		];
	} else {
		controlPoint = [ pnt1[ 0 ] + t( 1 ) * ( pnt2[ 0 ] - pnt1[ 0 ] ), pnt1[ 1 ] + t( 1 ) * ( pnt2[ 1 ] - pnt1[ 1 ] ) ];
	}
	return controlPoint;
}

function t( v: number ): number {
	return 0.3 * v;
}

/**
 * 取折线最右控制点（与 getLeftMostControlPoint 对称使用）。
 *
 * @param controlPoints 控制点序列。
 * @returns 最右侧 Bézier 控制点。
 */
function getRightMostControlPoint( controlPoints: LonLat[] ): LonLat {
	const count = controlPoints.length;
	const pnt1 = controlPoints[ count - 3 ];
	const pnt2 = controlPoints[ count - 2 ];
	const pnt3 = controlPoints[ count - 1 ];
	const pnts = getBisectorNormals( 0, pnt1, pnt2, pnt3 );
	const normalLeft = pnts[ 1 ];
	const normal = getNormal( pnt1, pnt2, pnt3 );
	const dist = Math.sqrt( normal[ 0 ] * normal[ 0 ] + normal[ 1 ] * normal[ 1 ] );
	let controlPoint: LonLat;
	if ( dist > ZERO_TOLERANCE ) {
		const mid = Mid( pnt2, pnt3 );
		const pX = pnt3[ 0 ] - mid[ 0 ];
		const pY = pnt3[ 1 ] - mid[ 1 ];
		const d1 = MathDistance( pnt2, pnt3 );
		const n = 2.0 / d1;
		const nX = - n * pY;
		const nY = n * pX;
		const a11 = nX * nX - nY * nY;
		const a12 = 2 * nX * nY;
		const a22 = nY * nY - nX * nX;
		const dX = normalLeft[ 0 ] - mid[ 0 ];
		const dY = normalLeft[ 1 ] - mid[ 1 ];
		controlPoint = [
			mid[ 0 ] + a11 * dX + a12 * dY,
			mid[ 1 ] + a12 * dX + a22 * dY,
		];
	} else {
		controlPoint = [ pnt3[ 0 ] + t( 1 ) * ( pnt2[ 0 ] - pnt3[ 0 ] ), pnt3[ 1 ] + t( 1 ) * ( pnt2[ 1 ] - pnt3[ 1 ] ) ];
	}
	return controlPoint;
}

/**
 * 用三次 Bézier 沿 controlPoints 拟合曲线并采样 FITTING_COUNT 段，
 * 返回采样顶点序列（首尾包含）。
 *
 * @param t              控制点偏移系数（影响曲线"丰满度"）。
 * @param controlPoints  控制点序列（≥3 点）。
 * @returns              采样顶点序列。
 */
export function getCurvePoints( t: number, controlPoints: LonLat[] ): LonLat[] {
	const leftControl = getLeftMostControlPoint( controlPoints );
	const normals: LonLat[] = [ leftControl ];
	for ( let i = 0; i < controlPoints.length - 2; i++ ) {
		const pnt1 = controlPoints[ i ];
		const pnt2 = controlPoints[ i + 1 ];
		const pnt3 = controlPoints[ i + 2 ];
		const normalPoints = getBisectorNormals( t, pnt1, pnt2, pnt3 );
		normals.push( normalPoints[ 0 ], normalPoints[ 1 ] );
	}
	const rightControl = getRightMostControlPoint( controlPoints );
	normals.push( rightControl );

	const points: LonLat[] = [];
	for ( let i = 0; i < controlPoints.length - 1; i++ ) {
		const pnt1 = controlPoints[ i ];
		const pnt2 = controlPoints[ i + 1 ];
		points.push( pnt1 );
		for ( let j = 0; j < FITTING_COUNT; j++ ) {
			const tt = j / FITTING_COUNT;
			const x =
				Math.pow( 1 - tt, 3 ) * pnt1[ 0 ] +
				3 * tt * Math.pow( 1 - tt, 2 ) * normals[ i * 2 ][ 0 ] +
				3 * tt * tt * ( 1 - tt ) * normals[ i * 2 + 1 ][ 0 ] +
				Math.pow( tt, 3 ) * pnt2[ 0 ];
			const y =
				Math.pow( 1 - tt, 3 ) * pnt1[ 1 ] +
				3 * tt * Math.pow( 1 - tt, 2 ) * normals[ i * 2 ][ 1 ] +
				3 * tt * tt * ( 1 - tt ) * normals[ i * 2 + 1 ][ 1 ] +
				Math.pow( tt, 3 ) * pnt2[ 1 ];
			points.push( [ x, y ] as LonLat );
		}
		points.push( pnt2 );
	}
	return points;
}

/**
 * 二次 B 样条平滑（attack 箭身侧边用）。
 *
 * @param points 控制点序列。
 * @returns      平滑后的采样顶点序列。
 */
export function getQBSplinePoints( points: LonLat[] ): LonLat[] {
	if ( points.length <= 2 ) {
		return points;
	}
	const n = 2;
	const bSplinePoints: LonLat[] = [];
	const m = points.length - n - 1;
	bSplinePoints.push( points[ 0 ] );
	for ( let i = 0; i <= m; i++ ) {
		for ( let t = 0; t <= 1; t += 0.05 ) {
			let x = 0;
			let y = 0;
			for ( let k = 0; k <= n; k++ ) {
				const factor = getQuadricBSplineFactor( k, t );
				x += factor * points[ i + k ][ 0 ];
				y += factor * points[ i + k ][ 1 ];
			}
			bSplinePoints.push( [ x, y ] );
		}
	}
	bSplinePoints.push( points[ points.length - 1 ] );
	return bSplinePoints;
}

/**
 * 二次 B 样条基函数。
 *
 * @param k 索引 0..2。
 * @param t 参数 [0, 1]。
 * @returns 基函数值。
 */
function getQuadricBSplineFactor( k: number, t: number ): number {
	if ( k === 0 ) {
		return Math.pow( t - 1, 2 ) / 2;
	}
	if ( k === 1 ) {
		return ( - 2 * Math.pow( t, 2 ) + 2 * t + 1 ) / 2;
	}
	if ( k === 2 ) {
		return Math.pow( t, 2 ) / 2;
	}
	return 0;
}

// ────────────────────────────────────────────────────────────
// 顶层箭头生成函数（委托给 c2t arrow 库；签名保持与参考项目一致）
// ────────────────────────────────────────────────────────────

/**
 * 细箭头：委托给 c2t arrow SDK 的 createFineArrow。结果为闭合多边形
 * （CCW、去重、≤120 顶点）。可直接喂给 CesiumGroundPolygonPrimitive。
 *
 * @param p1 起点。
 * @param p2 终点（尖端）。
 * @returns  闭合多边形顶点。
 */
export function createFineArrow( p1: LonLat, p2: LonLat ): LonLat[] {
	return c2tCreateFineArrow( p1, p2 ) as LonLat[];
}

/**
 * 突击方向箭头：委托给 c2t arrow SDK 的 createAssaultDirectionArrow。与
 * 细箭头同样由 2 点定义，但更窄长（适合表示局部突击方向）。
 *
 * @param p1 起点。
 * @param p2 终点（尖端）。
 * @returns  闭合多边形顶点。
 */
export function createAssaultDirectionArrow( p1: LonLat, p2: LonLat ): LonLat[] {
	return c2tCreateAssaultDirectionArrow( p1, p2 ) as LonLat[];
}

/**
 * 攻击箭头：委托给 c2t arrow SDK 的 createAttackArrow。
 * 首 2 点定义尾宽、其余点定义脊线（最后一个为 tip）；体宽渐变 +
 * 鲁棒性参数已在 SDK 中处理。
 *
 * @param lnglatPoints 控制点序列（≥3 推荐；< 3 时返回空）。
 * @returns            闭合多边形顶点。
 */
export function createAttackArrow( lnglatPoints: LonLat[] ): LonLat[] {
	if ( ! lnglatPoints || lnglatPoints.length < 3 ) {
		return [];
	}
	return c2tCreateAttackArrow( lnglatPoints ) as LonLat[];
}

/**
 * 燕尾攻击箭头：委托给 c2t arrow SDK 的 createSwallowtailAttackArrow。
 * 控制点约定与攻击箭头一致；尾部多一个燕尾凹口。
 *
 * @param lnglatPoints 控制点序列（≥3 推荐；< 3 时返回空）。
 * @returns            闭合多边形顶点。
 */
export function createSwallowtailAttackArrow( lnglatPoints: LonLat[] ): LonLat[] {
	if ( ! lnglatPoints || lnglatPoints.length < 3 ) {
		return [];
	}
	return c2tCreateSwallowtailAttackArrow( lnglatPoints ) as LonLat[];
}

/**
 * 曲线箭头：委托给 c2t arrow SDK 的 createCurvedArrow。
 * 2 点时退化为细箭头；≥3 点按 Catmull-Rom 平滑后两侧偏移构造箭身，
 * 末端生成颈 / 翼 / tip。
 *
 * @param lnglatPoints 控制点序列（≥2）。
 * @returns            闭合多边形顶点。
 */
export function createCurvedArrow( lnglatPoints: LonLat[] ): LonLat[] {
	if ( ! lnglatPoints || lnglatPoints.length < 2 ) {
		return [];
	}
	return c2tCreateCurvedArrow( lnglatPoints ) as LonLat[];
}
