// ============================================================
// arrow/arrow-polygon.ts — 箭头输出多边形的清理与正规化
// 层级：L0(基于 arrow-geometry.ts)
// 职责：把箭头生成器拼接出来的"原始环"清理为可以安全交给
//       CesiumGroundPolygonPrimitive 的"干净环",包括三步:
//
//         1. dedupeConsecutivePoints —— 去除连续重复顶点。
//            箭头流程中 leftPnts 的最后一个点是 neckLeft,headPnts 的第一个
//            点也是 neckLeft,直接拼接会产生连续重复;某些三角剖分器对
//            零面积边敏感,需要先 collapse。
//
//         2. ensureCounterClockwise —— 强制 CCW 绕向。
//            CesiumGroundPolygonPrimitive 的 shadow volume / SDF 着色器
//            隐含约定外环 CCW,反向会让填充与描边方向错乱。本函数通过
//            Shoelace 公式计算有向面积,< 0 则反转。
//
//         3. clampVertexCount —— 必要时降采样到上限以内。
//            CesiumGroundPolygonPrimitive 的 MAX_POLYGON_STYLE_VERTICES
//            = 128,本模块默认上限 = 120,留 8 个余量。降采样均匀步进保留
//            首尾点,确保闭合形状不变。
//
// 依赖:arrow-geometry.ts 的 mathDistance / COINCIDENT_TOLERANCE 同等阈值。
// 被消费:arrow/shapes/*.ts(所有箭头生成器在 return 前调用 finalizePolygon)。
// ============================================================

import { mathDistance } from './arrow-geometry';
import type { LonLatPoint } from './arrow-types';

/**
 * 顶点上限——给 MAX_POLYGON_STYLE_VERTICES(128) 留出 8 个 buffer。
 *
 * 留 buffer 的原因:渲染管线可能在内部 stroke / 闭合时追加 1-2 个顶点,
 * 严格压到 128 容易在边界 case 触发"polygon supports at most 128 points"
 * 异常。
 */
export const ARROW_OUTPUT_MAX_VERTICES = 120;

/**
 * 两顶点被视为"连续重复"的距离阈值(度)。
 *
 * 取 1e-10 度 ≈ 0.011 mm @ 赤道,远小于实际绘图可分辨距离。任何小于此阈值
 * 的连续顶点都会被 collapse 为一个。
 */
const DEDUPE_TOLERANCE = 1e-10;

/**
 * 去除连续重复顶点(同时检查首尾闭合重复)。
 *
 * 注:不去重"非连续"的重复——多边形中段如果出现两个同坐标顶点,通常意味着
 * 形状自交,简单去重会改变拓扑;此情况留给 ensurePolygonValid(可选)处理。
 *
 * @param ring 原始环。
 * @returns 新数组,连续重复点已合并。
 */
export function dedupeConsecutivePoints( ring: readonly LonLatPoint[] ): LonLatPoint[] {
	if ( ring.length === 0 ) {
		return [];
	}

	const out: LonLatPoint[] = [ [ ring[ 0 ][ 0 ], ring[ 0 ][ 1 ] ] ];

	for ( let i = 1; i < ring.length; i++ ) {
		const current = ring[ i ];
		const previous = out[ out.length - 1 ];
		if ( mathDistance( current, previous ) > DEDUPE_TOLERANCE ) {
			out.push( [ current[ 0 ], current[ 1 ] ] );
		}
	}

	// 检查首尾闭合重复:箭头多边形是闭合环,首尾点不应重复,否则
	// CesiumGroundPolygonPrimitive 的 normalizePolygonPoints 会按"独立顶点"
	// 处理而产生零长度边。
	if ( out.length >= 2 ) {
		const first = out[ 0 ];
		const last = out[ out.length - 1 ];
		if ( mathDistance( first, last ) <= DEDUPE_TOLERANCE ) {
			out.pop();
		}
	}

	return out;
}

/**
 * 用 Shoelace 公式计算多边形的有向面积(度的平方)。
 *
 * 公式:`A = 0.5 * Σ (x_i * y_{i+1} - x_{i+1} * y_i)`,索引模 n。
 * `A > 0` 时顶点 CCW(逆时针),`A < 0` 时 CW(顺时针)。
 *
 * @param ring 至少 3 个点,首尾不重复。
 * @returns 有向面积;ring.length < 3 时返回 0。
 */
export function signedAreaShoelace( ring: readonly LonLatPoint[] ): number {
	const n = ring.length;
	if ( n < 3 ) {
		return 0.0;
	}
	let sum = 0.0;
	for ( let i = 0; i < n; i++ ) {
		const a = ring[ i ];
		const b = ring[ ( i + 1 ) % n ];
		sum += a[ 0 ] * b[ 1 ] - b[ 0 ] * a[ 1 ];
	}
	return sum * 0.5;
}

/**
 * 强制把环调整为 CCW(逆时针)绕向。
 *
 * CesiumGroundPolygonPrimitive 的着色器与 polygon-rings.ts 的 winding 处理
 * 默认外环 CCW,若输入是 CW 会导致填充方向错(以洞当外、或翻面)。
 *
 * @param ring 已经去重的环。
 * @returns 新数组,保证 CCW;若输入已经 CCW 则只是浅拷贝。
 */
export function ensureCounterClockwise( ring: readonly LonLatPoint[] ): LonLatPoint[] {
	const area = signedAreaShoelace( ring );
	if ( area < 0.0 ) {
		// CW → 反转。新数组每点都新建,避免 caller 持有的内部数组被改。
		const reversed: LonLatPoint[] = new Array( ring.length );
		for ( let i = 0; i < ring.length; i++ ) {
			const src = ring[ ring.length - 1 - i ];
			reversed[ i ] = [ src[ 0 ], src[ 1 ] ];
		}
		return reversed;
	}
	// 已经 CCW 或共线(area = 0),浅拷贝即可。
	return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
}

/**
 * 均匀降采样到指定上限,严格保留首尾点。
 *
 * 算法:从 [0, n-1] 区间按 (maxCount-1) 段均匀步进取整数索引。这样
 * 首点 (i=0) 与末点 (i=maxCount-1 对应 ring.length-1) 永远入选,中间
 * 视形状均匀分布。
 *
 * 注:严格的"保形降采样"应该用 Visvalingam–Whyatt 之类的算法,根据三角形
 * 面积优先级删除冗余点。但本模块的箭头由 Catmull-Rom 平滑生成,任意位置
 * 的曲率分布都比较均匀,简单步进足够保形 + 实现简单。
 *
 * @param ring 输入环。
 * @param maxCount 目标点数上限,≥ 4。
 * @returns 长度 ≤ maxCount 的新数组;输入已满足上限时浅拷贝返回。
 */
export function clampVertexCount(
	ring: readonly LonLatPoint[],
	maxCount: number,
): LonLatPoint[] {
	const cap = Math.max( Math.floor( maxCount ), 4 );
	if ( ring.length <= cap ) {
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	const sampled: LonLatPoint[] = new Array( cap );
	const step = ( ring.length - 1 ) / ( cap - 1 );
	for ( let i = 0; i < cap; i++ ) {
		const srcIdx = Math.round( i * step );
		const safeIdx = Math.min( srcIdx, ring.length - 1 );
		const src = ring[ safeIdx ];
		sampled[ i ] = [ src[ 0 ], src[ 1 ] ];
	}
	return sampled;
}

/**
 * 移除 hairpin 顶点(转角 > 阈值的近 180° U-turn)。
 *
 * 箭头脊线在急转弯处经 Catmull-Rom 平滑后会出现 sample 聚集 + perp 方向
 * 急速旋转,Frenet 偏移产生的 leftSide / rightSide 在 cluster 内部出现
 * 「短退一步 → 反向冲出」的 cusp(转角接近 180°)。多边形拓扑上虽然不
 * 自交,但视觉上是一根「针尖」 — fragment shader 的 point-in-polygon 测试
 * 在 cusp 附近边密集 + 浮点边界判断,容易把 cusp 周围一小片像素误判成外部
 * (用户截图的三角凹口正是这种 cusp 产生的视觉物)。
 *
 * 算法:每轮扫描,凡 |turn| > π − threshold(默认 30°,即 turn > 150°)
 * 的顶点直接删除。继续迭代直到没有更多 hairpin 或剩余顶点 < 4。
 *
 * @param ring 已去重的多边形环。
 * @param thresholdRad hairpin 阈值(弧度),默认 30° = π/6。turn 接近 π
 *                    (180°)说明前后两条边几乎反向。
 * @returns 移除 hairpin 后的环。
 */
export function removeHairpinVertices(
	ring: readonly LonLatPoint[],
	thresholdRad: number = Math.PI / 6,
): LonLatPoint[] {
	let cleaned: LonLatPoint[] = ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	const halfTurnMinusThreshold = Math.PI - thresholdRad;

	let changed = true;
	let safety = 0;
	while ( changed && cleaned.length >= 4 && safety < 1000 ) {
		safety++;
		changed = false;
		const next: LonLatPoint[] = [];
		const n = cleaned.length;
		for ( let i = 0; i < n; i++ ) {
			const prev = cleaned[ ( i - 1 + n ) % n ];
			const curr = cleaned[ i ];
			const nxt = cleaned[ ( i + 1 ) % n ];
			const v1x = curr[ 0 ] - prev[ 0 ];
			const v1y = curr[ 1 ] - prev[ 1 ];
			const v2x = nxt[ 0 ] - curr[ 0 ];
			const v2y = nxt[ 1 ] - curr[ 1 ];
			const cross = v1x * v2y - v1y * v2x;
			const dot = v1x * v2x + v1y * v2y;
			const turn = Math.abs( Math.atan2( cross, dot ) );
			if ( turn > halfTurnMinusThreshold ) {
				// hairpin → 跳过这个顶点
				changed = true;
				continue;
			}
			next.push( [ curr[ 0 ], curr[ 1 ] ] );
		}
		cleaned = next;
	}
	return cleaned;
}

/**
 * 一站式正规化:**去重 → 移除 hairpin → 强制 CCW → 降采样 ≤ maxCount**。
 *
 * 所有箭头生成器最后一步都应调用此函数,确保输出符合
 * CesiumGroundPolygonPrimitive 的契约(3-128 顶点、闭合、CCW、无重复)。
 *
 * @param rawRing 拼接出来的原始环(可能含重复、CW、超长)。
 * @param maxCount 顶点上限,默认 ARROW_OUTPUT_MAX_VERTICES = 120。
 * @returns 干净的多边形环;若输入太退化(去重后 < 3 点)返回空数组。
 * @throws  从不抛错;非法输入返回空数组,由调用方决定如何反馈。
 */
export function finalizePolygon(
	rawRing: readonly LonLatPoint[],
	maxCount: number = ARROW_OUTPUT_MAX_VERTICES,
): LonLatPoint[] {
	// 1. 去除连续重复 + 首尾闭合重复
	const dedup = dedupeConsecutivePoints( rawRing );
	if ( dedup.length < 3 ) {
		// 退化形状(整条线/单点),无法构成多边形,返回空数组。
		// 调用方需要检查长度 < 3 然后决定是否回退到更简单的箭头。
		return [];
	}

	// 2. 移除 hairpin(近 180° U-turn 的顶点)。
	const noHairpin = removeHairpinVertices( dedup );
	if ( noHairpin.length < 3 ) {
		return [];
	}

	// 3. 强制 CCW(外环约定)
	const ccw = ensureCounterClockwise( noHairpin );

	// 4. 降采样到上限
	return clampVertexCount( ccw, maxCount );
}
