// ============================================================
// arrow/arrow-curves.ts — 通过控制点的平滑曲线插值
// 层级：L0(基于 arrow-geometry.ts)
// 职责：把一组离散控制点插值为一条平滑曲线。本模块用 Centripetal Catmull-Rom
//       样条(α = 0.5),它的两个关键性质恰好解决了 cesium-plot-js 用的
//       Quadric B-Spline 的两个老问题:
//
//         1. 通过所有控制点（interpolating）。
//            QBSpline 是 approximating 样条,曲线只"靠近"控制点而不经过。
//            在箭头体部上,起点 tailLeft 之后立刻跳到 (tailLeft+body1)/2,
//            造成可见的折角;Centripetal CR 严格通过 tailLeft、body1、neckLeft,
//            体部边缘从尾部到颈部连续平滑。
//
//         2. 避免自交与超调。
//            Uniform CR 和 Chordal CR 在控制点间距悬殊或近共线时容易出现
//            cusps 与环路;Centripetal CR(α = 0.5)在数学上证明
//            (Yuksel et al. 2011)无自交、无尖点,正好适合"沿脊线偏移
//            出的体部边缘"——这种边缘点距常常因为脊线段长度不均而悬殊。
//
//       Bonus:此模块也提供 cubic Bézier(对接 cesium-plot-js 原 getCurvePoints
//       的语义,用于 CurvedArrow 的弯曲脊线)与 chaikin 角点圆滑(用于
//       多边形边角光顺)。
//
// 依赖:arrow-geometry.ts 的 mathDistance / azimuthBackward。
// 被消费:arrow/shapes/attack-arrow.ts、arrow/shapes/curved-arrow.ts、
//        arrow/shapes/swallowtail-attack-arrow.ts。
// 算法对应:Catmull-Rom Splines, with Local Control — Yuksel, Schaefer,
//          Keyser, 2011 (https://www.cemyuksel.com/research/catmullrom_param/)。
// ============================================================

import { mathDistance } from './arrow-geometry';
import type { LonLatPoint } from './arrow-types';

/**
 * Centripetal Catmull-Rom 样条采样。
 *
 * 算法步骤:
 *   1. 对原始控制点序列两端各 mirror 一个虚拟点,使两端段也能用 CR 公式。
 *      镜像点 = `2 * P_endpoint - P_neighbor`,效果等价于"端点处切线与
 *      首/末段平行",视觉上箭头不会在端点处突然偏离方向。
 *   2. 对每相邻 4 个点 P0 P1 P2 P3 计算从 P1 到 P2 的 CR 段,共 N 段。
 *   3. 每段内按"中心向参数化"(centripetal,α = 0.5)的 t 间隔均匀采样
 *      `segmentSamples + 1` 个点(含端点,排除下段重复)。
 *   4. 在段间共享端点(不重复),最后追加最后一个原始控制点。
 *
 * 输出长度公式:
 *   `1 + (controlPoints.length - 1) * segmentSamples`
 * 例:5 个控制点 × 12 段采样 = 1 + 4*12 = 49 个输出点。
 *
 * @param controlPoints 控制点序列,至少 2 个;少于 2 时原样返回。
 * @param segmentSamples 每相邻控制点之间额外采样的点数(不含端点),≥ 1。
 * @returns 平滑曲线点序列,严格通过所有原始控制点。
 */
export function centripetalCatmullRomSamples(
	controlPoints: readonly LonLatPoint[],
	segmentSamples: number,
): LonLatPoint[] {
	if ( controlPoints.length < 2 ) {
		// 单点或空:无曲线可言,原样返回浅拷贝。
		return controlPoints.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}
	if ( controlPoints.length === 2 ) {
		// 两个点退化为直线段,按 segmentSamples 均匀采样。
		return linearSegmentSamples( controlPoints[ 0 ], controlPoints[ 1 ], segmentSamples );
	}

	// ── 步骤 1:两端 mirror 虚拟点 ──
	// 端点处的 CR 段需要"前一段"和"后一段"的存在;mirror 提供这两段的
	// 虚拟控制点,使端点切线沿首/末段方向延伸而不是任意翻转。
	const p0First = controlPoints[ 0 ];
	const p1First = controlPoints[ 1 ];
	const mirrorStart: LonLatPoint = [
		2.0 * p0First[ 0 ] - p1First[ 0 ],
		2.0 * p0First[ 1 ] - p1First[ 1 ],
	];
	const pLast = controlPoints[ controlPoints.length - 1 ];
	const pPrev = controlPoints[ controlPoints.length - 2 ];
	const mirrorEnd: LonLatPoint = [
		2.0 * pLast[ 0 ] - pPrev[ 0 ],
		2.0 * pLast[ 1 ] - pPrev[ 1 ],
	];

	const extended: LonLatPoint[] = [ mirrorStart, ...controlPoints, mirrorEnd ];

	// ── 步骤 2/3:遍历每相邻 4 个点 (P0,P1,P2,P3) 采样段 P1→P2 ──
	const output: LonLatPoint[] = [];
	const safeSegmentSamples = Math.max( Math.floor( segmentSamples ), 1 );
	const totalSegments = controlPoints.length - 1;

	for ( let segIdx = 0; segIdx < totalSegments; segIdx++ ) {
		const p0 = extended[ segIdx ];
		const p1 = extended[ segIdx + 1 ];
		const p2 = extended[ segIdx + 2 ];
		const p3 = extended[ segIdx + 3 ];

		// 中心向参数化:t_i = t_{i-1} + |P_i - P_{i-1}|^α,α = 0.5。
		// 一些边长可能为 0(连续重合点),取一个最小 chord 避免除零。
		const MIN_CHORD = 1e-12;
		const t0 = 0.0;
		const t1 = t0 + Math.max( Math.pow( mathDistance( p0, p1 ), 0.5 ), MIN_CHORD );
		const t2 = t1 + Math.max( Math.pow( mathDistance( p1, p2 ), 0.5 ), MIN_CHORD );
		const t3 = t2 + Math.max( Math.pow( mathDistance( p2, p3 ), 0.5 ), MIN_CHORD );

		// 在 [t1, t2] 区间均匀采样。第一段输出包含起点 P1,后续段跳过起点
		// (避免重复)。
		const includeStart = segIdx === 0;
		const startSampleIndex = includeStart ? 0 : 1;
		// 每段输出 segmentSamples + 1 个点(含起点和终点);最终所有段
		// 共有 1 + N * segmentSamples 个采样点,与文档保持一致。
		// 注意:终点 P2 是下段的起点 P1,所以这里只到 segmentSamples(不含),
		// 而最后一段把 P2(原始最后一个控制点)单独 push 进去。
		const isLastSegment = segIdx === totalSegments - 1;
		const endSampleIndex = isLastSegment ? safeSegmentSamples + 1 : safeSegmentSamples;

		for ( let i = startSampleIndex; i < endSampleIndex; i++ ) {
			const t = t1 + ( t2 - t1 ) * ( i / safeSegmentSamples );
			output.push( catmullRomBlend( p0, p1, p2, p3, t0, t1, t2, t3, t ) );
		}
	}

	return output;
}

/**
 * Centripetal Catmull-Rom 的 4 点混合公式(Yuksel et al. 2011)。
 *
 * 给定 4 个控制点 P0..P3 与对应参数 t0..t3,以及当前参数 t (t1 ≤ t ≤ t2),
 * 返回曲线在 t 处的位置。混合用嵌套线性插值:
 *
 *   A1 = lerp(P0, P1, (t-t0)/(t1-t0))
 *   A2 = lerp(P1, P2, (t-t1)/(t2-t1))
 *   A3 = lerp(P2, P3, (t-t2)/(t3-t2))
 *   B1 = lerp(A1, A2, (t-t0)/(t2-t0))
 *   B2 = lerp(A2, A3, (t-t1)/(t3-t1))
 *   C  = lerp(B1, B2, (t-t1)/(t2-t1))
 *
 * 共 6 次 lerp,可证明 C(t1) = P1,C(t2) = P2(经过控制点性质)。
 */
function catmullRomBlend(
	p0: LonLatPoint, p1: LonLatPoint, p2: LonLatPoint, p3: LonLatPoint,
	t0: number, t1: number, t2: number, t3: number,
	t: number,
): LonLatPoint {
	const a1 = lerpPoint( p0, p1, ( t - t0 ) / ( t1 - t0 ) );
	const a2 = lerpPoint( p1, p2, ( t - t1 ) / ( t2 - t1 ) );
	const a3 = lerpPoint( p2, p3, ( t - t2 ) / ( t3 - t2 ) );
	const b1 = lerpPoint( a1, a2, ( t - t0 ) / ( t2 - t0 ) );
	const b2 = lerpPoint( a2, a3, ( t - t1 ) / ( t3 - t1 ) );
	return lerpPoint( b1, b2, ( t - t1 ) / ( t2 - t1 ) );
}

/**
 * 两点的线性插值。`f = 0` 返回 a,`f = 1` 返回 b。
 *
 * 不做 clamp:Catmull-Rom 内部混合需要 f 略大于 1 或略小于 0 也能正确外推
 * (但实际数值上都在 [0, 1] 附近)。
 */
function lerpPoint(
	a: LonLatPoint,
	b: LonLatPoint,
	f: number,
): LonLatPoint {
	return [
		a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * f,
		a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * f,
	];
}

/**
 * 两点之间的均匀线性采样,含两端点。
 *
 * 退化分支:当 Centripetal CR 输入只有 2 个控制点时,曲线退化为直线段,
 * 这里直接均匀采样 segmentSamples + 1 个点。
 *
 * @param a 起点。
 * @param b 终点。
 * @param segmentSamples 段内额外采样数,≥ 1。
 * @returns 长度 segmentSamples + 1 的点序列,首尾分别为 a / b。
 */
function linearSegmentSamples(
	a: LonLatPoint,
	b: LonLatPoint,
	segmentSamples: number,
): LonLatPoint[] {
	const n = Math.max( Math.floor( segmentSamples ), 1 );
	const points: LonLatPoint[] = new Array( n + 1 );
	for ( let i = 0; i <= n; i++ ) {
		const t = i / n;
		points[ i ] = [
			a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t,
			a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t,
		];
	}
	return points;
}

/**
 * 三次 Bézier 曲线段采样(用于 CurvedArrow 的脊线)。
 *
 * 公式 B(t) = (1-t)³·P0 + 3(1-t)²t·C1 + 3(1-t)t²·C2 + t³·P3
 *
 * 与 cesium-plot-js 的 getCubicValue 一致,这里只是单段采样;
 * 整条 Bézier 链需要调用方在每段间用同样的控制点连接(C1 连续由
 * 调用方保证控制点对称即可)。
 *
 * @param p0 起点。
 * @param c1 第一个控制点。
 * @param c2 第二个控制点。
 * @param p3 终点。
 * @param samples 段内采样数(不含两端),≥ 1。
 * @returns 包含两端点的采样点序列,长度 samples + 1。
 */
export function cubicBezierSegmentSamples(
	p0: LonLatPoint,
	c1: LonLatPoint,
	c2: LonLatPoint,
	p3: LonLatPoint,
	samples: number,
): LonLatPoint[] {
	const n = Math.max( Math.floor( samples ), 1 );
	const out: LonLatPoint[] = new Array( n + 1 );
	for ( let i = 0; i <= n; i++ ) {
		const t = i / n;
		const tp = 1.0 - t;
		const t2 = t * t;
		const t3 = t2 * t;
		const tp2 = tp * tp;
		const tp3 = tp2 * tp;
		out[ i ] = [
			tp3 * p0[ 0 ] + 3.0 * tp2 * t * c1[ 0 ] + 3.0 * tp * t2 * c2[ 0 ] + t3 * p3[ 0 ],
			tp3 * p0[ 1 ] + 3.0 * tp2 * t * c1[ 1 ] + 3.0 * tp * t2 * c2[ 1 ] + t3 * p3[ 1 ],
		];
	}
	return out;
}

/**
 * 沿一条折线/曲线计算每点处的切线方向(单位向量)。
 *
 * 用于按 perpendicular offset 生成"等宽线条"的左右两条平行线。
 * 中间点用中央差分(前后邻居距离归一),端点用前向/后向差分。
 *
 * @param points 至少 2 个点。
 * @returns 与输入等长的单位切向量数组,每个元素 [tx, ty]。
 */
export function computeTangents(
	points: readonly LonLatPoint[],
): [ number, number ][] {
	const n = points.length;
	const tangents: [ number, number ][] = new Array( n );

	if ( n === 0 ) {
		return tangents;
	}
	if ( n === 1 ) {
		// 单点:无意义,返回 +x 方向占位。
		tangents[ 0 ] = [ 1.0, 0.0 ];
		return tangents;
	}

	for ( let i = 0; i < n; i++ ) {
		// 中央差分(端点退化为前向/后向差分):
		//   prevIdx = i > 0 ? i - 1 : i
		//   nextIdx = i < n-1 ? i + 1 : i
		const prevIdx = i > 0 ? i - 1 : i;
		const nextIdx = i < n - 1 ? i + 1 : i;
		const dx = points[ nextIdx ][ 0 ] - points[ prevIdx ][ 0 ];
		const dy = points[ nextIdx ][ 1 ] - points[ prevIdx ][ 1 ];
		const len = Math.sqrt( dx * dx + dy * dy );
		if ( len > 0.0 ) {
			tangents[ i ] = [ dx / len, dy / len ];
		} else {
			// 退化:前后邻居完全重合(在去重之后理论上不会发生)。
			// 用 +x 占位,避免下游 perpendicular 算出 NaN。
			tangents[ i ] = [ 1.0, 0.0 ];
		}
	}

	return tangents;
}

/**
 * 沿折线/曲线从末尾回退给定弧长,定位精确截断点。
 *
 * 用于 attack/swallowtail/curved 三类箭头里"把 spine 在 neck 处剪开"的需求:
 *   - body 部分用 spine[0..k] + 截断点
 *   - head 部分由调用方独立构造
 *
 * 算法:从最末样本开始往回累加段长,直到累加值刚好覆盖 distanceFromEnd。
 * 截断点落在最后那个跨越阈值的线段内,用线性插值得到精确坐标。
 *
 * @param samples 至少 2 个点的密采折线/曲线。
 * @param distanceFromEnd 截断点距 samples 末点的弧长。
 *                        ≤ 0 时截断点即末点(localT = 1.0);
 *                        ≥ totalLen 时返回 null(头部比脊线还长)。
 * @returns 截断点 segmentIdx (起点索引)、 localT (∈[0,1])、 point (坐标)
 *          的对象;距离不可达时返回 null。
 */
export interface PolylineCutPoint {
	segmentIdx: number;
	localT: number;
	point: LonLatPoint;
}

export function findPointAlongPolylineFromEnd(
	samples: readonly LonLatPoint[],
	distanceFromEnd: number,
): PolylineCutPoint | null {
	const n = samples.length;
	if ( n < 2 ) {
		return null;
	}

	// distanceFromEnd ≤ 0:截断点就是末点本身;落在最后一段的末端 (localT = 1)。
	if ( distanceFromEnd <= 0.0 ) {
		return {
			segmentIdx: n - 2,
			localT: 1.0,
			point: [ samples[ n - 1 ][ 0 ], samples[ n - 1 ][ 1 ] ],
		};
	}

	let accum = 0.0;
	for ( let i = n - 1; i > 0; i-- ) {
		const segLen = mathDistance( samples[ i ], samples[ i - 1 ] );
		if ( accum + segLen >= distanceFromEnd ) {
			// 截断点落在线段 [i-1, i] 内。
			// remainFromEndPoint = 截断点距 samples[i] 的距离。
			const remainFromEndPoint = distanceFromEnd - accum;
			// 由于我们从 samples[i] 出发往 samples[i-1] 走 remainFromEndPoint,
			// 等价 localT = 1 - remainFromEndPoint / segLen 在 [0,1] 内。
			const localT = segLen > 0.0 ? 1.0 - remainFromEndPoint / segLen : 1.0;
			const ax = samples[ i - 1 ][ 0 ];
			const ay = samples[ i - 1 ][ 1 ];
			const bx = samples[ i ][ 0 ];
			const by = samples[ i ][ 1 ];
			return {
				segmentIdx: i - 1,
				localT,
				point: [
					ax + ( bx - ax ) * localT,
					ay + ( by - ay ) * localT,
				],
			};
		}
		accum += segLen;
	}

	// 走完整条折线都没覆盖 distanceFromEnd → 头部比脊线还长。
	return null;
}
