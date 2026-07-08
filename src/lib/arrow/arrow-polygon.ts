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
//         1.5 resolveSelfIntersections —— 消除自交(钩形/回环/hairpin 脊线)。
//            轨迹卷曲到带状体自身重叠时单环会全局自交,earcut 渲染未定义
//            (大面积错误填充)。仅在检测到自交时用 polygon-clipping 自并集
//            解析为干净外环;非自交环原样通过,常规箭头零回归。
//
//         2. ensureCounterClockwise —— 强制 CCW 绕向。
//            CesiumGroundPolygonPrimitive 的 shadow volume / SDF 着色器
//            隐含约定外环 CCW,反向会让填充与描边方向错乱。本函数通过
//            Shoelace 公式计算有向面积,< 0 则反转。
//
//         3. clampVertexCount —— 必要时降采样到上限以内。
//            CesiumGroundPolygonPrimitive 的 MAX_POLYGON_STYLE_VERTICES
//            = 128,本模块默认上限 = 120,留 8 个余量。降采样是**特征保留式**
//            的:尖端/翼尖/尾角等大转角顶点无条件保留,只在平滑段内按比例
//            抽稀(朴素均匀步进曾把箭头头部 3 个连续特征顶点抽掉,见函数
//            注释里的修复历史)。
//
// 依赖:arrow-geometry.ts 的 mathDistance / COINCIDENT_TOLERANCE 同等阈值。
// 被消费:arrow/shapes/*.ts(所有箭头生成器在 return 前调用 finalizePolygon)。
// ============================================================

import polygonClipping from 'polygon-clipping';

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
 * 顶点被视为"特征顶点"的最小转角(弧度)。
 *
 * 箭头环上的语义顶点 —— 尖端(~120° 转角)、左右翼尖(~90°+)、尾角(~90°)、
 * 燕尾凹口(~90°+)—— 全部远大于 20°;而 Catmull-Rom 平滑体部相邻样本间的
 * 转角通常只有几度。20° 在两个群体之间留有数倍余量。
 */
const FEATURE_TURN_THRESHOLD_RAD = Math.PI / 9;

/**
 * 特征保留式降采样到指定上限。
 *
 * **修复历史:本函数曾是"均匀步进取索引"的朴素降采样 —— 它是"钩形手绘
 * 曲线箭头无头"bug 的直接根因。** 手绘几十~上百控制点时箭头环顶点数
 * 上千,均匀步进的间隔 > 10,头部 3 个**连续**特征顶点(headLeft / tip /
 * headRight)恰好整组落在步进间隔之间被抽掉,带状体末端渲染成平头。
 *
 * 新算法分两步:
 *   1. **标记特征顶点**:环上转角 ≥ FEATURE_TURN_THRESHOLD_RAD(20°)的顶点
 *      (尖端 / 翼尖 / 尾角 / 燕尾凹口)无条件全部保留。箭头形状的特征顶点
 *      不超过 ~8 个,远小于预算。
 *   2. **按比例分配剩余预算**:相邻特征顶点之间的"平滑段"按各自顶点数
 *      占比分得配额(最大余数法,配额总和精确等于剩余预算),段内均匀
 *      取点。平滑段都是 Catmull-Rom 体部边缘,均匀抽稀不损失视觉形状。
 *
 * 输出从第一个特征顶点开始(整环的旋转),对闭合多边形语义无影响
 * (绕向、闭合性、面积均不变)。
 *
 * 退化保护:
 *   - 无特征顶点(纯平滑环)→ 回退为均匀步进降采样。
 *   - 特征顶点数超过 cap - 4(噪声环,每个顶点都是尖角)→ 同样回退为
 *     均匀步进:此时"特征"已无语义,保哪个都一样。
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
	const n = ring.length;
	if ( n <= cap ) {
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	// ── 步骤 1:逐顶点转角(闭合环,索引模 n)──
	// turn = |atan2(cross, dot)| ∈ [0, π],入边 (prev→curr) 与出边 (curr→next)
	// 的夹角偏离直线的程度;0 = 共线,π = 完全折返。
	const featureIndices: number[] = [];
	for ( let i = 0; i < n; i++ ) {
		const prev = ring[ ( i - 1 + n ) % n ];
		const curr = ring[ i ];
		const next = ring[ ( i + 1 ) % n ];
		const v1x = curr[ 0 ] - prev[ 0 ];
		const v1y = curr[ 1 ] - prev[ 1 ];
		const v2x = next[ 0 ] - curr[ 0 ];
		const v2y = next[ 1 ] - curr[ 1 ];
		const cross = v1x * v2y - v1y * v2x;
		const dot = v1x * v2x + v1y * v2y;
		const turn = Math.abs( Math.atan2( cross, dot ) );
		if ( turn >= FEATURE_TURN_THRESHOLD_RAD ) {
			featureIndices.push( i );
		}
	}

	// ── 退化回退:无特征或特征本身挤爆预算 → 均匀步进(旧行为)──
	const featureCount = featureIndices.length;
	if ( featureCount === 0 || featureCount > cap - 4 ) {
		const sampled: LonLatPoint[] = new Array( cap );
		const step = ( n - 1 ) / ( cap - 1 );
		for ( let i = 0; i < cap; i++ ) {
			const srcIdx = Math.min( Math.round( i * step ), n - 1 );
			const src = ring[ srcIdx ];
			sampled[ i ] = [ src[ 0 ], src[ 1 ] ];
		}
		return sampled;
	}

	// ── 步骤 2:剩余预算按平滑段顶点数比例分配(最大余数法)──
	// 平滑段 j = 特征 j 与特征 j+1(循环)之间的内部顶点,数量 interiorCount[j]。
	const remainingBudget = cap - featureCount;
	const interiorCounts: number[] = new Array( featureCount );
	let totalInterior = 0;
	for ( let j = 0; j < featureCount; j++ ) {
		const start = featureIndices[ j ];
		const end = featureIndices[ ( j + 1 ) % featureCount ];
		const count = ( end - start - 1 + n ) % n;
		interiorCounts[ j ] = count;
		totalInterior += count;
	}

	// totalInterior = n - featureCount > cap - featureCount = remainingBudget,
	// 所以每段配额必然 ≤ 段内顶点数,不会"超采"。
	const quotas: number[] = new Array( featureCount );
	const remainders: { j: number; frac: number }[] = [];
	let allocated = 0;
	for ( let j = 0; j < featureCount; j++ ) {
		const exact = totalInterior > 0
			? ( remainingBudget * interiorCounts[ j ] ) / totalInterior
			: 0;
		const base = Math.floor( exact );
		quotas[ j ] = base;
		allocated += base;
		remainders.push( { j, frac: exact - base } );
	}
	// 把向下取整丢掉的名额按小数部分从大到小补齐,且不超过段内顶点数。
	remainders.sort( ( a, b ) => b.frac - a.frac );
	let leftover = remainingBudget - allocated;
	for ( const r of remainders ) {
		if ( leftover <= 0 ) {
			break;
		}
		if ( quotas[ r.j ] < interiorCounts[ r.j ] ) {
			quotas[ r.j ]++;
			leftover--;
		}
	}

	// ── 步骤 3:重建环:特征顶点 + 各平滑段内均匀取 quota 个内部顶点 ──
	const sampled: LonLatPoint[] = [];
	for ( let j = 0; j < featureCount; j++ ) {
		const start = featureIndices[ j ];
		const src = ring[ start ];
		sampled.push( [ src[ 0 ], src[ 1 ] ] );

		const interior = interiorCounts[ j ];
		const quota = quotas[ j ];
		// 段内偏移 1..interior 上均匀取 quota 个:offset = round(q*(interior+1)/(quota+1))。
		// 步长 (interior+1)/(quota+1) ≥ 1(quota ≤ interior),取整后单调不减、
		// quota = interior 时恰好取满 1..interior,无重复。
		for ( let q = 1; q <= quota; q++ ) {
			const offset = Math.round( ( q * ( interior + 1 ) ) / ( quota + 1 ) );
			const pick = ring[ ( start + offset ) % n ];
			sampled.push( [ pick[ 0 ], pick[ 1 ] ] );
		}
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
 * 算法:每轮扫描,凡 |turn| > π − threshold(默认 5°,即 turn > 175°)
 * 的顶点直接删除。继续迭代直到没有更多 hairpin 或剩余顶点 < 4。
 *
 * **阈值为何收紧到 5°:** 合法的箭头尖端 / 翼尖(fine、curved 的 head)本身
 * 就是 ~130°–155° 的尖锐转角。早期默认 30°(删除 turn > 150°)会把这些**真实
 * 箭头顶点**一并删掉,使 fine / curved 箭头「有体无头」(尖头退化成梯形)。
 * 真正要删的是 Frenet 偏移自交产生的近 180° 退化尖刺(零面积 cusp)。收紧到
 * 5° 后只删 turn > 175° 的退化尖刺,保留所有真实箭头头部;曲线箭头的自交 cusp
 * 另由 curved-arrow.ts 的全局曲率限宽(widthScale ≤ 0.5×曲率半径)从源头预防。
 *
 * @param ring 已去重的多边形环。
 * @param thresholdRad hairpin 阈值(弧度),默认 5° = π/36。turn 越接近 π
 *                    (180°)说明前后两条边越接近完全反向(退化尖刺)。
 * @returns 移除 hairpin 后的环。
 */
export function removeHairpinVertices(
	ring: readonly LonLatPoint[],
	thresholdRad: number = Math.PI / 36,
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
 * 两条线段是否"严格相交"(排除共享端点的相触)。
 *
 * 用于 {@link ringSelfIntersects} 的自交检测。参数式 t/s 都落在开区间内才算真交。
 */
function segmentsStrictlyCross(
	a: LonLatPoint, b: LonLatPoint,
	c: LonLatPoint, d: LonLatPoint,
): boolean {
	const rX = b[ 0 ] - a[ 0 ];
	const rY = b[ 1 ] - a[ 1 ];
	const sX = d[ 0 ] - c[ 0 ];
	const sY = d[ 1 ] - c[ 1 ];
	const denom = rX * sY - rY * sX;
	if ( Math.abs( denom ) < 1e-20 ) {
		return false; // 平行 / 共线:不算严格相交。
	}
	const acX = c[ 0 ] - a[ 0 ];
	const acY = c[ 1 ] - a[ 1 ];
	const t = ( acX * sY - acY * sX ) / denom;
	const u = ( acX * rY - acY * rX ) / denom;
	const EPS = 1e-9;
	return t > EPS && t < 1.0 - EPS && u > EPS && u < 1.0 - EPS;
}

/**
 * 闭合环是否存在自交(任意一对**非相邻**边严格相交)。
 *
 * O(n²) 暴力检测。箭头环 ≤ 120 顶点 ⟹ ≤ ~7000 对,微秒级,发现首个交点即
 * 提前返回。
 *
 * @param ring 闭合多边形环(首尾不重复)。
 * @returns 存在自交返回 true。
 */
function ringSelfIntersects( ring: readonly LonLatPoint[] ): boolean {
	const n = ring.length;
	if ( n < 4 ) {
		return false;
	}
	for ( let i = 0; i < n; i++ ) {
		const a = ring[ i ];
		const b = ring[ ( i + 1 ) % n ];
		// j 从 i+2 起跳过相邻边;(i===0,j===n-1) 是首尾相邻边,排除。
		for ( let j = i + 2; j < n; j++ ) {
			if ( i === 0 && j === n - 1 ) {
				continue;
			}
			if ( segmentsStrictlyCross( a, b, ring[ j ], ring[ ( j + 1 ) % n ] ) ) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 用多边形布尔自并集消除环的自交,返回**最大面积外环**。
 *
 * 钩形 / 回环 / 螺旋等"轨迹卷曲到带状体自身重叠"的输入,沿脊线偏移得到的
 * 单环会全局自交(两段带状体物理重叠)。earcut 对自交多边形行为未定义 →
 * 渲染出大面积错误填充(用户反馈的现象)。
 *
 * 业界标准做法(Clipper / polygon-clipping)是把自交环做一次**自并集**
 * (union of the ring with itself,nonzero / positive fill rule):重叠区按
 * 非零环绕数判定为实心,自交被解析为干净的非自交边界。本函数取并集结果中
 * **面积最大的外环**作为箭头轮廓。
 *
 * 单环输出契约下的取舍:
 *   - 并集可能产出**洞**(轨迹几乎闭合成圈时,圈内中空)。单环契约下丢弃洞 →
 *     完全闭合的回环其圈内会被填实。这只影响"末端卷曲 > ~220°"的极端螺旋
 *     (常规钩形 / 攻击箭头不受影响);完整的洞支持留作后续增强。
 *   - 并集可能产出多个不相连多边形(箭头某处掐断成零宽)。取最大面积外环,
 *     丢弃碎片。常规箭头不会发生。
 *
 * **仅在 ringSelfIntersects 为真时调用**,因此非自交的常规箭头(直箭头、
 * S 形曲线、平缓钩形)走原路径,几何与历史版本逐位一致,零回归。
 *
 * @param ring 已去重的闭合环。
 * @returns 干净的非自交外环;并集失败 / 退化时回退原环(不抛错)。
 */
function resolveSelfIntersections( ring: readonly LonLatPoint[] ): LonLatPoint[] {
	if ( ! ringSelfIntersects( ring ) ) {
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	// polygon-clipping 需要闭合环(首尾点重复)。
	const closed: [ number, number ][] = ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] );
	closed.push( [ ring[ 0 ][ 0 ], ring[ 0 ][ 1 ] ] );

	let result: ReturnType<typeof polygonClipping.union>;
	try {
		// 单多边形自并集:解析自身重叠为 nonzero 实心区域。
		result = polygonClipping.union( [ closed ] );
	} catch {
		// 数值退化(极端共线 / 重合)时 polygon-clipping 可能抛错;回退原环,
		// 由下游 CCW + clamp 尽力处理,绝不让箭头整体消失。
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}
	if ( ! result || result.length === 0 ) {
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	// 取面积最大的外环(每个 polygon 的 [0] 是外环,[1..] 是洞)。
	let bestOuter: [ number, number ][] | null = null;
	let bestArea = -1.0;
	for ( const poly of result ) {
		const outer = poly[ 0 ];
		if ( ! outer || outer.length < 4 ) {
			continue;
		}
		let twiceArea = 0.0;
		for ( let i = 0; i < outer.length - 1; i++ ) {
			twiceArea += outer[ i ][ 0 ] * outer[ i + 1 ][ 1 ]
				- outer[ i + 1 ][ 0 ] * outer[ i ][ 1 ];
		}
		const a = Math.abs( twiceArea );
		if ( a > bestArea ) {
			bestArea = a;
			bestOuter = outer;
		}
	}
	if ( bestOuter === null ) {
		return ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	// 去掉 polygon-clipping 闭合环结尾的重复首点。
	const out: LonLatPoint[] = [];
	for ( let i = 0; i < bestOuter.length - 1; i++ ) {
		out.push( [ bestOuter[ i ][ 0 ], bestOuter[ i ][ 1 ] ] );
	}
	return out;
}

/**
 * 一站式正规化:**去重 → 消除自交 → 移除 hairpin → 强制 CCW → 降采样 ≤ maxCount**。
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

	// 2. 消除自交(钩形 / 回环 / hairpin 脊线导致带状体自身重叠)。
	// 仅在检测到自交时做多边形自并集;非自交环原样返回 → 常规箭头零回归。
	// 必须在 hairpin / clamp 之前:union 后的环才是最终拓扑,后续清理基于它。
	const simple = resolveSelfIntersections( dedup );
	if ( simple.length < 3 ) {
		return [];
	}

	// 3. 移除 hairpin(近 180° U-turn 的顶点)。
	const noHairpin = removeHairpinVertices( simple );
	if ( noHairpin.length < 3 ) {
		return [];
	}

	// 4. 强制 CCW(外环约定)
	const ccw = ensureCounterClockwise( noHairpin );

	// 5. 降采样到上限
	const clamped = clampVertexCount( ccw, maxCount );

	// 6. 末端二次自交防线(**无条件检测**)。
	// hairpin 移除与 clamp 降采样都可能在近退化(极小尺度、高密度抖动、大量
	// 重合点)输入上新引入交叉。绝大多数箭头此处 ringSelfIntersects 为 false,
	// 仅一次 O(n²)(n ≤ 120,微秒级)即返回;真有交叉时再做一次 union 兜底。
	// union 可能微增顶点,但仍远低于下游 MAX_POLYGON_STYLE_VERTICES = 128。
	if ( ! ringSelfIntersects( clamped ) ) {
		return clamped;
	}
	const reSimplified = resolveSelfIntersections( clamped );
	return reSimplified.length > maxCount
		? clampVertexCount( reSimplified, maxCount )
		: reSimplified;
}
