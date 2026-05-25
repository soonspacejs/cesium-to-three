// ============================================================
// arrow/arrow-geometry.ts — 箭头标绘的 2D 几何基础工具
// 层级：L0(零依赖纯函数,经纬度看作平面坐标)
// 职责：提供距离/中点/方位角/旋转步进等纯函数。所有函数都是无副作用的,
//       接收 [lon, lat] 数组,输出新数组或标量。
//
//       与 cesium-plot-js v0.x 的 utils.ts 接口基本一致,但做了三处
//       重要修正:
//         1. azimuthBackward 用 Math.atan2 取代原 asin + 四象限分支,
//            消除轴对齐输入(dx=0 或 dy=0)与零距离时的不确定性。
//         2. mathDistance 与 wholeDistance 加入零长度检测,返回数值零而非
//            NaN(原项目在两端重合时 distance=0 → 后续除法产生 NaN)。
//         3. getThirdPoint 接受 finite 检查,保证返回值始终为有限数。
//
// 依赖：无(纯 JS Math)。
// 被消费：arrow/shapes/*.ts、arrow/arrow-curves.ts、arrow/arrow-polygon.ts。
// 算法对应:cesium-plot-js utils.ts(MathDistance / Mid / getAzimuth /
//          getThirdPoint / isClockWise / getAngleOfThreePoints / getNormal)。
// ============================================================

import type { LonLatPoint } from './arrow-types';

const WGS84_SEMI_MAJOR_AXIS_METERS = 6378137.0;
const WGS84_INVERSE_FLATTENING = 298.257223563;
const WGS84_FLATTENING = 1.0 / WGS84_INVERSE_FLATTENING;
const WGS84_FIRST_ECCENTRICITY_SQUARED =
	2.0 * WGS84_FLATTENING - WGS84_FLATTENING * WGS84_FLATTENING;
const DEGREES_TO_RADIANS = Math.PI / 180.0;
const RADIANS_TO_DEGREES = 180.0 / Math.PI;

/**
 * 两个浮点数被视为相等的容差(度坐标空间)。
 *
 * 1e-9 度 ≈ 0.11 mm @ 赤道,远低于任何实际绘图精度,所以视作"同点"。
 * 主要用于零距离检测与角度退化判断,避免后续除以 0。
 */
const COINCIDENT_TOLERANCE = 1e-9;

/**
 * Runs an arrow generator in a local WGS84 east/north meter plane.
 *
 * Arrow formulas are Euclidean: widths, lengths, and angles must share the
 * same unit. Public callers provide WGS84 degrees, so this helper projects
 * the controls to a local meter frame before shape construction and converts
 * the resulting ring back to lon/lat degrees.
 *
 * @param controlPoints Public WGS84 [lon, lat] control points in degrees.
 * @param createLocalRing Factory that consumes local [east, north] meters.
 * @returns The factory output converted back to WGS84 degrees.
 */
export function createArrowInLocalMeterPlane(
	controlPoints: readonly LonLatPoint[],
	createLocalRing: ( localPoints: readonly LonLatPoint[] ) => readonly LonLatPoint[],
): LonLatPoint[] {
	if ( controlPoints.length === 0 ) {
		return [];
	}

	let longitudeSum = 0.0;
	let latitudeSum = 0.0;
	for ( const point of controlPoints ) {
		if (
			! Number.isFinite( point[ 0 ] ) ||
			! Number.isFinite( point[ 1 ] )
		) {
			return [];
		}
		longitudeSum += point[ 0 ];
		latitudeSum += point[ 1 ];
	}

	const inverseCount = 1.0 / controlPoints.length;
	const originLongitudeDegrees = longitudeSum * inverseCount;
	const originLatitudeDegrees = latitudeSum * inverseCount;
	const latitudeRadians = originLatitudeDegrees * DEGREES_TO_RADIANS;
	const sinLatitude = Math.sin( latitudeRadians );
	const cosLatitude = Math.cos( latitudeRadians );
	const oneMinusESin2 =
		1.0 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude;
	const primeVerticalRadius =
		WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt( oneMinusESin2 );
	const meridianRadius =
		WGS84_SEMI_MAJOR_AXIS_METERS *
		( 1.0 - WGS84_FIRST_ECCENTRICITY_SQUARED ) /
		( oneMinusESin2 * Math.sqrt( oneMinusESin2 ) );
	const longitudeMetersPerRadian = primeVerticalRadius * cosLatitude;
	const latitudeMetersPerRadian = meridianRadius;

	if (
		Math.abs( longitudeMetersPerRadian ) < 1e-6 ||
		! Number.isFinite( longitudeMetersPerRadian ) ||
		! Number.isFinite( latitudeMetersPerRadian )
	) {
		return [];
	}

	const localPoints: LonLatPoint[] = controlPoints.map( ( point ) => [
		( point[ 0 ] - originLongitudeDegrees ) *
			DEGREES_TO_RADIANS *
			longitudeMetersPerRadian,
		( point[ 1 ] - originLatitudeDegrees ) *
			DEGREES_TO_RADIANS *
			latitudeMetersPerRadian,
	] as LonLatPoint );

	const localRing = createLocalRing( localPoints );
	return localRing.map( ( point ) => [
		originLongitudeDegrees +
			( point[ 0 ] / longitudeMetersPerRadian ) * RADIANS_TO_DEGREES,
		originLatitudeDegrees +
			( point[ 1 ] / latitudeMetersPerRadian ) * RADIANS_TO_DEGREES,
	] as LonLatPoint );
}

/**
 * 两点的欧氏距离(度坐标空间)。
 *
 * 注:经纬度被当成平面坐标,**不是**地球表面真实距离。本模块的箭头默认
 * 跨度较小(< 数十公里),平面近似带来的形变可以忽略。如需长距离贴地
 * 绘图,应改用大地线插值后再调用本函数。
 *
 * @param p1 第一个点 [lon°, lat°]。
 * @param p2 第二个点 [lon°, lat°]。
 * @returns  距离,度;两点重合时返回 0,不返回 NaN。
 */
export function mathDistance( p1: LonLatPoint, p2: LonLatPoint ): number {
	const dx = p1[ 0 ] - p2[ 0 ];
	const dy = p1[ 1 ] - p2[ 1 ];
	const d2 = dx * dx + dy * dy;
	return d2 > 0.0 ? Math.sqrt( d2 ) : 0.0;
}

/**
 * 点序列的总折线长度(相邻点距离之和)。
 *
 * @param points 至少 1 个点。
 * @returns      累积距离,度;单点序列返回 0。
 */
export function wholeDistance( points: readonly LonLatPoint[] ): number {
	let total = 0.0;
	for ( let i = 1; i < points.length; i++ ) {
		total += mathDistance( points[ i - 1 ], points[ i ] );
	}
	return total;
}

/**
 * 基准长度 = 总折线长 ** 0.99。
 *
 * 与 cesium-plot-js 完全一致——指数 0.99 让长箭头的宽度增长稍慢于线性,
 * 即"大的箭头不至于按比例同样粗"。指数 1.0 也能用,但视觉上长箭头会
 * 显得"过粗"。
 *
 * @param points 控制点序列。
 * @returns      基准长度(度的 0.99 次幂);空/单点返回 0。
 */
export function getBaseLength( points: readonly LonLatPoint[] ): number {
	const total = wholeDistance( points );
	return total > 0.0 ? Math.pow( total, 0.99 ) : 0.0;
}

/**
 * 两点的中点。
 *
 * @param p1 第一个点。
 * @param p2 第二个点。
 * @returns  新数组,两点坐标的算术平均。
 */
export function mid( p1: LonLatPoint, p2: LonLatPoint ): LonLatPoint {
	return [ ( p1[ 0 ] + p2[ 0 ] ) / 2.0, ( p1[ 1 ] + p2[ 1 ] ) / 2.0 ];
}

/**
 * 沿 startPnt → endPnt 反方向(即从 endPnt 看向 startPnt)的极角,弧度。
 *
 * 这是 cesium-plot-js 原 getAzimuth 的语义:`(cos α, sin α)` 是从 endPnt
 * **指向** startPnt 的单位向量,而不是 start 到 end 的方向。
 *
 * 内部实现用 `Math.atan2(start.y - end.y, start.x - end.x)`,自然处理所有
 * 四个象限以及轴对齐输入,返回范围 [-π, π]。
 *
 * 这与原项目用 asin + 四个 if 分支的实现等价但更稳健 —— 原实现在
 *   dx = 0 且 dy = 0 时 distance = 0 → asin(0/0) = NaN,
 *   或 dx = 0 时四个分支没有覆盖到边界值,
 * 都会让下游 getThirdPoint 返回 NaN,导致整个箭头消失或自交。
 *
 * @param startPnt 起点(在公式语义中代表"目标方向")。
 * @param endPnt   终点(下游 getThirdPoint 会以此为锚点)。
 * @returns        极角,弧度,范围 [-π, π];两点重合时返回 0(任意方向)。
 */
export function azimuthBackward(
	startPnt: LonLatPoint,
	endPnt: LonLatPoint,
): number {
	const dx = startPnt[ 0 ] - endPnt[ 0 ];
	const dy = startPnt[ 1 ] - endPnt[ 1 ];
	// 两点重合时,任意角度都"合法",约定返回 0 以让下游 getThirdPoint
	// 返回 endPnt 沿 +x 方向偏 distance 的点(而非 NaN)。
	if ( Math.abs( dx ) < COINCIDENT_TOLERANCE && Math.abs( dy ) < COINCIDENT_TOLERANCE ) {
		return 0.0;
	}
	return Math.atan2( dy, dx );
}

/**
 * 三点共线判定:p1 → p2 → p3 是否顺时针。
 *
 * 用叉积符号判定:`(p2 - p1) × (p3 - p1) < 0` 时为顺时针(右手系)。
 * 共线(叉积 = 0)时返回 false,与原 cesium-plot-js 行为一致。
 *
 * @param p1 第一个点。
 * @param p2 第二个点。
 * @param p3 第三个点。
 * @returns  true 表示顺时针,false 表示逆时针或共线。
 */
export function isClockWise(
	p1: LonLatPoint,
	p2: LonLatPoint,
	p3: LonLatPoint,
): boolean {
	const ax = p2[ 0 ] - p1[ 0 ];
	const ay = p2[ 1 ] - p1[ 1 ];
	const bx = p3[ 0 ] - p1[ 0 ];
	const by = p3[ 1 ] - p1[ 1 ];
	// 与 cesium-plot-js 原始公式严格等价:
	//   (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x)
	//   = by * ax > ay * bx
	//   = ax * by - ay * bx > 0
	//
	// 注:cesium-plot-js 的 `isClockWise` 函数名其实是 misnomer——其判别式
	// `cross > 0` 在标准右手系下是 CCW。但本算法下游(attack-arrow 的
	// "if isClockWise then swap tailLeft/tailRight")依赖的恰是这个语义,
	// 因此本实现严格保持与原项目一致,不修正函数名。
	//
	// 修复历史:早期版本曾写作 `ay*bx - ax*by > 0`(符号反转),导致
	// 3 点直线情况下 tailLeft 被错误地放到 spine 的"另一侧",体部边线
	// 跨越脊线产生自交。
	return ax * by - ay * bx > 0.0;
}

/**
 * 在 endPnt 处,沿 endPnt → startPnt 方向旋转 ±angle 弧度,前进 distance 距离。
 *
 * 这是箭头几何中最核心的工具——尾翼、颈部、翼尖等所有特殊位置都靠它从
 * 一对参考点出发计算出来。
 *
 * 几何含义:
 *   1. 取从 endPnt 看向 startPnt 的方向作为基准方向(azimuthBackward)。
 *   2. clockwise = true 时顺时针(+angle)旋转,false 时逆时针(-angle)旋转。
 *   3. 沿旋转后的方向从 endPnt 走 distance 度,返回到达的点。
 *
 * @param startPnt  起点(决定基准方向)。
 * @param endPnt    终点(也是输出点的几何锚点)。
 * @param angle     从基准方向偏转的角度,弧度,非负。
 * @param distance  从 endPnt 出发的距离,度。
 * @param clockwise 旋转方向:true = 顺时针,false = 逆时针。
 * @returns         新数组,目标点 [lon°, lat°];输入含 NaN/无穷时返回 endPnt 副本。
 */
export function getThirdPoint(
	startPnt: LonLatPoint,
	endPnt: LonLatPoint,
	angle: number,
	distance: number,
	clockwise: boolean,
): LonLatPoint {
	// 极端输入保护:任何参数为 NaN/Infinity 时退化为 endPnt 副本,而不是污染输出。
	if (
		! Number.isFinite( startPnt[ 0 ] ) || ! Number.isFinite( startPnt[ 1 ] ) ||
		! Number.isFinite( endPnt[ 0 ] ) || ! Number.isFinite( endPnt[ 1 ] ) ||
		! Number.isFinite( angle ) || ! Number.isFinite( distance )
	) {
		return [ endPnt[ 0 ], endPnt[ 1 ] ];
	}

	const baseAngle = azimuthBackward( startPnt, endPnt );
	// 顺/逆时针约定与原项目一致:clockwise = true 时角度 + ,false 时 - 。
	const alpha = clockwise ? baseAngle + angle : baseAngle - angle;
	return [
		endPnt[ 0 ] + distance * Math.cos( alpha ),
		endPnt[ 1 ] + distance * Math.sin( alpha ),
	];
}

/**
 * 三点形成的内角(B 顶点处)。
 *
 * 用 azimuthBackward 而不是 atan2 的差,确保和原 cesium-plot-js 的
 * `getAngleOfThreePoints` 在所有合法输入上数值一致。
 *
 * 返回的角度归一化到 [0, 2π) ——这一点对体部宽度计算的 sin(angle/2)
 * 至关重要,如果返回负值会导致 sin 为负 → 宽度方向反转。
 *
 * @param a 第一个端点。
 * @param b 中间顶点。
 * @param c 第二个端点。
 * @returns 角 ABC 的大小,弧度,范围 [0, 2π);任意点退化时返回 π(直线)。
 */
export function getAngleOfThreePoints(
	a: LonLatPoint,
	b: LonLatPoint,
	c: LonLatPoint,
): number {
	// b → a 与 b → c 的"反向方位角"(即 azimuthBackward 语义)。
	// 差值即为从 (b→c) 方向旋转到 (b→a) 方向需要的角度。
	const angle = azimuthBackward( a, b ) - azimuthBackward( c, b );
	if ( ! Number.isFinite( angle ) ) {
		return Math.PI;
	}
	// 归一化到 [0, 2π)。
	let normalized = angle;
	while ( normalized < 0.0 ) {
		normalized += Math.PI * 2.0;
	}
	while ( normalized >= Math.PI * 2.0 ) {
		normalized -= Math.PI * 2.0;
	}
	return normalized;
}

/**
 * p2 处的"内向角平分线"方向向量(未归一化)。
 *
 * 几何含义:p1→p2 和 p3→p2 各自单位向量之和,指向 p2 内角的平分线方向。
 * 共线时长度趋近于 0,调用方需检查长度判断退化。
 *
 * 主要用于曲线插值中确定 Bézier 控制点的偏移方向。
 *
 * @param p1 前一个点。
 * @param p2 中间点(法向量从此处发出)。
 * @param p3 后一个点。
 * @returns  [dx, dy] 法向量分量;p1 或 p3 与 p2 重合时返回 [0, 0]。
 */
export function getNormalVector(
	p1: LonLatPoint,
	p2: LonLatPoint,
	p3: LonLatPoint,
): [ number, number ] {
	const d1 = mathDistance( p1, p2 );
	const d2 = mathDistance( p3, p2 );
	if ( d1 < COINCIDENT_TOLERANCE || d2 < COINCIDENT_TOLERANCE ) {
		// 任一段退化:返回零向量,调用方走"共线兜底"分支。
		return [ 0.0, 0.0 ];
	}
	const ux1 = ( p1[ 0 ] - p2[ 0 ] ) / d1;
	const uy1 = ( p1[ 1 ] - p2[ 1 ] ) / d1;
	const ux2 = ( p3[ 0 ] - p2[ 0 ] ) / d2;
	const uy2 = ( p3[ 1 ] - p2[ 1 ] ) / d2;
	return [ ux1 + ux2, uy1 + uy2 ];
}

/**
 * 把一个角度归一化到 [0, 2π)。
 *
 * 用于角度差运算后保证范围一致,避免后续 sin/cos 因周期性导致符号错误。
 *
 * @param angle 任意实数角度,弧度。
 * @returns     归一化后角度,[0, 2π);输入 NaN 时返回 0。
 */
export function normalizeAngle( angle: number ): number {
	if ( ! Number.isFinite( angle ) ) {
		return 0.0;
	}
	let normalized = angle % ( Math.PI * 2.0 );
	if ( normalized < 0.0 ) {
		normalized += Math.PI * 2.0;
	}
	return normalized;
}
