// ============================================================
// arrow/shapes/curved-arrow.ts — 曲线箭头(2+ 点)
// 层级：L1
// 职责：由 2+ 个控制点定义平滑曲线脊线,沿脊线两侧偏移给定半宽形成带状体,
//      末端附加一个**五点头部五边形**(neck 左 / 翼尖左 / 尖端 / 翼尖右 /
//      neck 右),闭合成填充多边形。
//
//      与 cesium-plot-js 的 CurvedArrow 不同(后者输出 `line` 类型折线),
//      本实现输出**闭合多边形**:本项目仅有 CesiumGroundPolygonPrimitive,
//      没有 line primitive,把曲线沿法线"增厚"为带状多边形是兼容
//      polygon-only 管线的标准做法。
//
// 头部构造对齐 cesium-plot-js AttackArrow.getArrowHeadPoints 的**五点五边形**
// 经过验证的画法(这是修复"头-体衔接处凹口 / 描边突起"的关键):
//   - neck 点(neckLeft / neckRight):位于尖端沿"末端弦方向"回退 neckHeight
//     (= headHeight × neckHeightFactor,默认 0.85)处,半宽 = **体半宽**。
//     体部以同样的体半宽收束到此 → 体与头在 neck 处**等宽**衔接,无台阶、无凹口。
//   - 翼尖点(headLeft / headRight):位于回退 headHeight 处(比 neck 更深),
//     半宽 = headHalfWidth(明显大于体半宽)→ 形成"向后掠出"的箭翼倒刺。
//   - 尖端(tip):严格等于用户最末控制点。
//   头部整体沿"末端近直段的弦方向"对称展开,因此永远正对尖端、不会扭向侧面。
//
// 几何步骤(3+ 点):
//   1. spineSamples = 通过控制点的 Centripetal Catmull-Rom 密采曲线;
//      超出 SPINE_SAMPLE_BUDGET 时按弧长均匀重采样收口(在偏移**之前**锁定
//      顶点预算,并滤掉手抖聚点稳定切线/曲率估计)。
//   2. totalLen = 累积弧长;体半宽 / 翼半宽 / 头长全部相对 totalLen。
//   3. 全局曲率限宽:halfWidth > 局部曲率半径会使弯曲内侧自交,扫描整条脊线
//      找最紧曲率半径,把所有宽度 + 头长按同一比例缩小到安全范围。
//   4. 头长按"末端累计转角 ≤ HEAD_MAX_TURN"二次 clamp,使头部落在末端近直段内
//      (弦向 ≈ 切向 → 头部正对尖端且与体颈干净衔接)。
//   5. 沿"尖端 → 末端弦方向"构造五点头部(见上)。
//   6. 体部:脊线截断到 neck 深度,Frenet 法线偏移出等宽带,末点对齐到
//      neckLeft / neckRight;偏移边裁掉局部自交微环。
//   7. 闭合环 = leftSide(尾→neckLeft) ⊕ [headLeft, tip, headRight] ⊕
//      reverse(rightSide)(neckRight→尾) → finalizePolygon(去重 / 自交并集 /
//      去 hairpin / CCW / 降采样)。
//
// 边界处理:
//   - 2 个控制点:直线变体(脊线退化为直线段密采)。
//   - headLength clamp 到 ≤ totalLen × HEAD_LENGTH_MAX_FRACTION,防止体长变负。
//   - 相邻控制点重合:centripetalCatmullRomSamples 内部已防御除零。
//   - bodySpine 退化(< 2 点)时返回空多边形。
//   - 钩形 / 回环导致带状体全局自重叠:由 finalizePolygon 的多边形自并集兜底。
//
// 依赖:arrow-geometry.ts、arrow-curves.ts、arrow-polygon.ts、arrow-types.ts。
// 被消费:arrow/index.ts。
// 算法对应:cesium-plot-js src/arrow/curved-arrow.ts(折线)+ attack-arrow.ts
//          getArrowHeadPoints(五点头部);本实现把"折线 + 五点头部"改写为
//          "带状多边形 + 五点头部"。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	mathDistance,
	wholeDistance,
} from '../arrow-geometry';
import {
	centripetalCatmullRomSamples,
	computeTangents,
	findPointAlongPolylineFromEnd,
	resamplePolylineByArcLength,
	trimLocalPolylineLoops,
} from '../arrow-curves';
import { finalizePolygon } from '../arrow-polygon';
import type {
	ArrowPolygon,
	CurvedArrowOptions,
	LonLatPoint,
} from '../arrow-types';

// ── 默认值 ──
// 体宽 / 头宽 / 头长(均相对曲线总弧长)。给出一个「中等饱满体部 + 清晰掠翼箭头」
// 的曲线箭头。
//
// **单调变宽不变量:体半宽 = 颈半宽 ≤ 翼半宽。** 默认值:
//   bodyHalfWidth = 0.09/2 = 0.045 · L  (= neckHalfWidth,体颈等宽,无台阶)
//   headHalfWidth = 0.16/2 = 0.080 · L  (翼尖明显更宽 → 掠翼倒刺清晰可见)
// 头部用五点五边形(neck 等于体宽、翼尖更宽更深),因此体→颈→翼全程「只张不收」,
// 衔接处不会出现内凹台阶(早期 3 点头部在颈处宽度突变 + 弦/切法线不一致导致的
// 凹口 + 描边突起,已被五点画法消除)。
// 体宽相对总弧长。0.06 ≈ 体半宽 0.03·L,在常见绘制尺度下是一条「清晰但不臃肿」
// 的带子。曾用 0.09 在长曲线(弧长大)上显得过粗(用户反馈"curved 这么大"),
// 下调到 0.06。仍可通过 options.bodyWidthFactor 覆盖(GUI 已暴露)。
const DEFAULT_BODY_WIDTH_FACTOR = 0.06;
// 翼展相对总弧长(箭翼明显宽于体 → 清晰箭头)。随体宽同比下调。
const DEFAULT_HEAD_WIDTH_FACTOR = 0.12;
const DEFAULT_HEAD_LENGTH_FACTOR = 0.14;
const DEFAULT_CURVE_SMOOTHING_SEGMENTS = 16;

// 头部长度上限:不超过曲线总长的 60%,防止 body 被吃光。
const HEAD_LENGTH_MAX_FRACTION = 0.6;

// ── 脊线样本预算 ──
// 输出环 ≈ 2 × bodySpine + 头部 5 点(其中 neckL/neckR 由体部末点表示,头部净增
// headLeft/tip/headRight 3 点)。预算 58 ⟹ 环 ≤ 2×58+3 = 119 ≤
// ARROW_OUTPUT_MAX_VERTICES(120),即在偏移之前锁定顶点数,finalizePolygon 的
// 降采样在常规曲线箭头上不触发(避免降采样在密集输入上引入新自交)。
const SPINE_SAMPLE_BUDGET = 58;

// ── 头部"末端累计转角"上限 ──
// 头部沿"末端弦方向"对称展开。从尖端沿脊线回退累计绝对转角,到达本上限处即
// 头部允许伸入的最远弧长。钩形 / 回环末端急弯时,这把头部锁在末端近直段内
// (弦向 ≈ 切向),头部正对尖端、与体颈干净衔接;残余的体部全局自重叠(大弯
// 绕回)由 finalizePolygon 的多边形自并集兜底,与头部定向解耦。
const HEAD_MAX_TURN_RADIANS = Math.PI / 4; // 45°

// 转角 clamp 后的头长下限(相对曲率限宽后的头长):极端卷曲(第一段就超限)时
// 仍保留 30% 头长,保证箭头永远"有头可见"。
const HEAD_MIN_LENGTH_FRACTION = 0.30;

/**
 * 生成曲线箭头(沿曲线的填充多边形)。
 *
 * @param controlPoints 控制点序列,至少 2 个;最末点为箭头尖端。
 * @param options 体型与平滑参数。
 * @returns 闭合多边形;输入退化(< 2 点或所有点重合)时返回空数组。
 */
export function createCurvedArrow(
	controlPoints: readonly LonLatPoint[],
	options: CurvedArrowOptions = {},
): ArrowPolygon {
	return createArrowInLocalMeterPlane(
		controlPoints,
		( localPoints ) => createCurvedArrowLocal( localPoints, options ),
	);
}

function createCurvedArrowLocal(
	controlPoints: readonly LonLatPoint[],
	options: CurvedArrowOptions = {},
): ArrowPolygon {
	// ── 输入校验 ──
	if ( controlPoints.length < 2 ) {
		return [];
	}

	// ── 解析选项 ──
	// userWidthScale:整体宽度倍率(调整箭头大小),同乘体宽与翼宽 → 一个旋钮调
	// 粗细。命名带 user 前缀以区别于下方步骤 3 的曲率限宽 widthScale。
	const userWidthScale = Math.max( options.widthScale ?? 1.0, 1e-3 );
	const bodyWidthFactor = ( options.bodyWidthFactor ?? DEFAULT_BODY_WIDTH_FACTOR ) * userWidthScale;
	const headWidthFactor = ( options.headWidthFactor ?? DEFAULT_HEAD_WIDTH_FACTOR ) * userWidthScale;
	const headLengthFactor = options.headLengthFactor ?? DEFAULT_HEAD_LENGTH_FACTOR;
	const curveSmoothingSegments =
		options.curveSmoothingSegments ?? DEFAULT_CURVE_SMOOTHING_SEGMENTS;

	// ── 步骤 1:平滑脊线 + 弧长预算收口 ──
	const rawSpineSamples = centripetalCatmullRomSamples(
		controlPoints, curveSmoothingSegments,
	);
	if ( rawSpineSamples.length < 2 ) {
		return [];
	}
	// 超预算才收口;预算内(少量控制点)保留原始采样密度,行为与历史一致。
	const spineSamples = rawSpineSamples.length > SPINE_SAMPLE_BUDGET
		? resamplePolylineByArcLength( rawSpineSamples, SPINE_SAMPLE_BUDGET )
		: rawSpineSamples;
	if ( spineSamples.length < 2 ) {
		return [];
	}

	// ── 步骤 2:总弧长与各种宽度 ──
	const totalLen = wholeDistance( spineSamples );
	if ( totalLen <= 0.0 ) {
		return []; // 所有控制点重合。
	}

	const rawBodyHalfWidth = ( totalLen * bodyWidthFactor ) / 2.0;
	const rawHeadHalfWidth = ( totalLen * headWidthFactor ) / 2.0;
	// 翼半宽必须 ≥ 体半宽(否则"翼"比体还窄,倒刺反向 → 凹口)。
	const headHalfWidthUncapped = Math.max( rawHeadHalfWidth, rawBodyHalfWidth * 1.2 );
	// 头长(翼深,从尖端回退),clamp ≤ totalLen × HEAD_LENGTH_MAX_FRACTION。
	const rawHeadLength = Math.min(
		totalLen * headLengthFactor,
		totalLen * HEAD_LENGTH_MAX_FRACTION,
	);

	// ── 步骤 3:全局曲率限宽(必须在 neck 之前,使头长随同缩放)──
	// Frenet 法线偏移在 halfWidth > 局部曲率半径 R 时弯曲内侧自交。扫一遍脊线找
	// 最紧曲率半径 minR,把体半宽 cap 到 minR × SAFETY 之内,所有宽度 + 头长按
	// 同一 widthScale 同步缩放,保持比例。
	const CURVATURE_SAFETY = 0.5;
	let tightestRadius = Infinity;
	for ( let i = 1; i < spineSamples.length - 1; i++ ) {
		const prev = spineSamples[ i - 1 ];
		const curr = spineSamples[ i ];
		const next = spineSamples[ i + 1 ];
		const v1x = curr[ 0 ] - prev[ 0 ];
		const v1y = curr[ 1 ] - prev[ 1 ];
		const v2x = next[ 0 ] - curr[ 0 ];
		const v2y = next[ 1 ] - curr[ 1 ];
		const len1 = Math.hypot( v1x, v1y );
		const len2 = Math.hypot( v2x, v2y );
		if ( len1 < 1e-9 || len2 < 1e-9 ) {
			continue;
		}
		const cross = v1x * v2y - v1y * v2x;
		const dot = v1x * v2x + v1y * v2y;
		const dtheta = Math.abs( Math.atan2( cross, dot ) );
		if ( dtheta < 1e-9 ) {
			continue; // 直线段,半径无穷。
		}
		const ds = ( len1 + len2 ) * 0.5;
		const r = ds / dtheta;
		if ( r < tightestRadius ) {
			tightestRadius = r;
		}
	}

	let widthScale = 1.0;
	if ( Number.isFinite( tightestRadius ) ) {
		const safeMax = tightestRadius * CURVATURE_SAFETY;
		if ( rawBodyHalfWidth > safeMax && rawBodyHalfWidth > 0.0 ) {
			widthScale = safeMax / rawBodyHalfWidth;
		}
	}

	// 体半宽(neck 处体↔头等宽,neck 直接由体部 Frenet 末点充当)。
	const bodyHalfWidth = rawBodyHalfWidth * widthScale;
	const headHalfWidth = headHalfWidthUncapped * widthScale;
	const cappedHeadLength = rawHeadLength * widthScale;

	// ── 步骤 4:头长按"末端累计转角"二次 clamp ──
	// 从尖端(末样本)沿脊线向回累计绝对转角;首次超过 HEAD_MAX_TURN_RADIANS 的
	// 顶点处记录"尖端到该顶点的弧长"作为头部允许伸入的最远距离。
	let arcLimitByTurn = Infinity;
	{
		let cumulativeTurn = 0.0;
		let arcFromTip = 0.0;
		for ( let j = spineSamples.length - 2; j >= 1; j-- ) {
			arcFromTip += mathDistance( spineSamples[ j + 1 ], spineSamples[ j ] );
			const v1x = spineSamples[ j ][ 0 ] - spineSamples[ j - 1 ][ 0 ];
			const v1y = spineSamples[ j ][ 1 ] - spineSamples[ j - 1 ][ 1 ];
			const v2x = spineSamples[ j + 1 ][ 0 ] - spineSamples[ j ][ 0 ];
			const v2y = spineSamples[ j + 1 ][ 1 ] - spineSamples[ j ][ 1 ];
			const cross = v1x * v2y - v1y * v2x;
			const dot = v1x * v2x + v1y * v2y;
			cumulativeTurn += Math.abs( Math.atan2( cross, dot ) );
			if ( cumulativeTurn > HEAD_MAX_TURN_RADIANS ) {
				arcLimitByTurn = arcFromTip;
				break;
			}
		}
	}
	// 翼深(head depth):取 clamp 后的头长。
	const headDepth = Math.min(
		cappedHeadLength,
		Math.max( arcLimitByTurn, cappedHeadLength * HEAD_MIN_LENGTH_FRACTION ),
	);
	if ( headDepth <= 0.0 ) {
		return [];
	}

	// ── 步骤 5:体部(脊线截断到 neck = headDepth 深度,Frenet 偏移)──
	// 体部沿脊线延伸到"尖端回退 headDepth"处的真实脊线点。头部与体部在此**精确
	// 分界、不重叠**:体部覆盖 [headDepth, 尾],头三角覆盖 [0, headDepth]。
	const neckCut = findPointAlongPolylineFromEnd( spineSamples, headDepth );
	if ( neckCut === null ) {
		return [];
	}
	const bodySpine: LonLatPoint[] = spineSamples
		.slice( 0, neckCut.segmentIdx + 1 )
		.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	// neckCut.point 与 slice 末点几乎重合时不重复追加,避免零长边。
	const lastSliceX = bodySpine[ bodySpine.length - 1 ][ 0 ];
	const lastSliceY = bodySpine[ bodySpine.length - 1 ][ 1 ];
	const ndx = neckCut.point[ 0 ] - lastSliceX;
	const ndy = neckCut.point[ 1 ] - lastSliceY;
	if ( ndx * ndx + ndy * ndy > 1e-24 ) {
		bodySpine.push( [ neckCut.point[ 0 ], neckCut.point[ 1 ] ] );
	}
	if ( bodySpine.length < 2 ) {
		return [];
	}

	// 尖端 = 用户最末控制点(箭尖严格落在用户指定位置)。
	const tip: LonLatPoint = [
		controlPoints[ controlPoints.length - 1 ][ 0 ],
		controlPoints[ controlPoints.length - 1 ][ 1 ],
	];

	// ── 步骤 6:头部轴 = neck 中心 → tip 的弦方向 ──
	// **左右箭翼等长的关键:** 头部严格关于"neck 中心 → tip"这条轴对称构造。
	// barbLeft / barbRight 在该轴两侧、等深、等宽 → 等腰三角 → 两翼天然等长
	// (早期用 neck 处脊线切线定向时,tip 不在切线轴上 → 一翼长一翼短)。
	const neckX = neckCut.point[ 0 ];
	const neckY = neckCut.point[ 1 ];
	let axisX = tip[ 0 ] - neckX;
	let axisY = tip[ 1 ] - neckY;
	const axisLen = Math.hypot( axisX, axisY );
	if ( axisLen < 1e-12 ) {
		return []; // neck 与 tip 重合,无法定向。
	}
	axisX /= axisLen;
	axisY /= axisLen;
	// 弦轴的左手 90° 法线。
	const axisPerpX = -axisY;
	const axisPerpY = axisX;

	// ── 步骤 7:体部 Frenet 偏移,末端 K 点平滑旋转到弦法线 ──
	// 体部沿脊线切线法线偏移;但在靠近 neck 的最后 K 个截面,把法线方向从"切线
	// 法线"平滑插值到"弦法线 axisPerp",使体部末点 neckLeft/neckRight 恰好落在
	// 弦法线上(= barb 同一条射线)。这样:
	//   - neckLeft 与 barbLeft 沿弦法线共线 → 衔接处纯径向外扩,零凹口;
	//   - neckLeft / neckRight 关于弦轴对称 → 配合等腰头三角,整段头部完全对称。
	// K 越大旋转越平缓;取末端 ~6 个点(或更短脊线的全部内部点)。
	const tangents = computeTangents( bodySpine );
	const lastBodyIdx = bodySpine.length - 1;
	const blendCount = Math.min( 6, lastBodyIdx );
	const leftSide: LonLatPoint[] = new Array( bodySpine.length );
	const rightSide: LonLatPoint[] = new Array( bodySpine.length );
	for ( let i = 0; i < bodySpine.length; i++ ) {
		// 切线法线(左手 90°)。
		let px = -tangents[ i ][ 1 ];
		let py = tangents[ i ][ 0 ];
		// 末端 blendCount 个点:权重从 0(切线法线)线性升到 1(弦法线)。
		if ( blendCount > 0 && i > lastBodyIdx - blendCount ) {
			const w = ( i - ( lastBodyIdx - blendCount ) ) / blendCount;
			let bx = px * ( 1.0 - w ) + axisPerpX * w;
			let by = py * ( 1.0 - w ) + axisPerpY * w;
			const bl = Math.hypot( bx, by );
			if ( bl > 1e-12 ) {
				bx /= bl;
				by /= bl;
				px = bx;
				py = by;
			}
		}
		const sx = bodySpine[ i ][ 0 ];
		const sy = bodySpine[ i ][ 1 ];
		leftSide[ i ] = [ sx + px * bodyHalfWidth, sy + py * bodyHalfWidth ];
		rightSide[ i ] = [ sx - px * bodyHalfWidth, sy - py * bodyHalfWidth ];
	}
	// 末点强制落在弦法线上(消除浮点残差,保证与 barb 严格共线 + 左右对称)。
	leftSide[ lastBodyIdx ] = [ neckX + axisPerpX * bodyHalfWidth, neckY + axisPerpY * bodyHalfWidth ];
	rightSide[ lastBodyIdx ] = [ neckX - axisPerpX * bodyHalfWidth, neckY - axisPerpY * bodyHalfWidth ];

	// 裁掉偏移边上的局部自交微环(曲率突变点残留的小折叠)。
	const trimmedLeft = trimLocalPolylineLoops( leftSide );
	const trimmedRight = trimLocalPolylineLoops( rightSide );

	// ── 步骤 8:头部箭翼(弦法线上,比体宽更宽 → 等腰箭翼)──
	const barbLeft: LonLatPoint = [
		neckX + axisPerpX * headHalfWidth,
		neckY + axisPerpY * headHalfWidth,
	];
	const barbRight: LonLatPoint = [
		neckX - axisPerpX * headHalfWidth,
		neckY - axisPerpY * headHalfWidth,
	];

	// ── 步骤 9:拼接最终多边形(CCW)──
	//   leftSide(尾→neckLeft) → barbLeft(左翼) → tip(尖端) → barbRight(右翼)
	//   → reverse(rightSide)(neckRight→尾)
	// neckLeft(=trimmedLeft 末点)与 barbLeft 沿弦法线共线 → 干净外扩;
	// 头三角关于"neck→tip"轴对称 → 左右翼等长。无重复顶点。
	const rawRing: LonLatPoint[] = [
		...trimmedLeft,                         // 尾 → neckLeft
		barbLeft,                               // 左翼
		tip,                                    // 尖端
		barbRight,                              // 右翼
		...trimmedRight.slice().reverse(),      // neckRight → 尾
	];

	return finalizePolygon( rawRing );
}

// 内部颈点搜索由 arrow-curves.ts 的 `findPointAlongPolylineFromEnd` 统一提供
// (attack-arrow / swallowtail-attack-arrow / curved-arrow 三个箭头共享)。
