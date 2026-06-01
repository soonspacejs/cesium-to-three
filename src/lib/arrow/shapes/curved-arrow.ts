// ============================================================
// arrow/shapes/curved-arrow.ts — 曲线箭头(2+ 点)
// 层级：L1
// 职责：由 2+ 个控制点定义平滑曲线脊线,沿脊线两侧偏移给定半宽,末端附加
//      三角箭头,闭合成填充多边形。
//
//      与 cesium-plot-js 的 CurvedArrow 不同(后者输出 `line` 类型的折线
//      polyline),本实现输出**闭合多边形**。原因:本项目仅有
//      CesiumGroundPolygonPrimitive,没有 line primitive。把曲线沿法线
//      "增厚"为带状多边形是兼容 polygon-only 管线的标准做法。
//
// 控制点契约:
//   - 2 个点:直线变体,等价于宽度可调、自带三角箭头的窄长 FineArrow。
//   - 3+ 个点:用 Centripetal Catmull-Rom 平滑,严格通过所有控制点;
//             末点为箭头尖端。
//
// 几何步骤(3+ 点):
//   1. spineSamples = 通过控制点的密采曲线
//   2. totalLen = 累积弧长,bodyWidth/headWidth/headLength/neckWidth 全部
//      相对 totalLen 计算
//   3. 沿 spineSamples 从末尾回退 headLength 距离,定位"颈点" exactNeck
//      (精确插值,不是最近样本)。bodySpine = spineSamples[0..k] ⊕ exactNeck。
//   4. 对 bodySpine 计算逐点切线 → 顺时针 90° 法线 perp = (-ty, tx)
//   5. 半宽 w(i):tail 处 = bodyWidth/2,沿曲线按 bodyTaperRatio 线性收窄;
//      末点(neck 处)强制等于 neckWidth/2,保证与头部 neck 共点(无台阶)
//   6. leftSide[i] = spine[i] + perp[i] × w(i),rightSide[i] 同理但 - perp
//   7. 头部 3 点:tip = controlPoints[末]、headLeft/headRight 用 exactNeck
//      处的法线 × headWidth/2(比 neck 更宽 → 翼展)
//   8. 闭合环:leftSide ⊕ [headLeft, tip, headRight] ⊕ reverse(rightSide)
//
// 边界处理:
//   - headLength clamp 到 ≤ totalLen × 0.6,防止 headLength 把 bodyLength
//     压缩到负值。
//   - 任何两个相邻控制点重合时,centripetalCatmullRomSamples 内部已防御除零。
//   - bodySpine 出现退化(< 2 点)时返回空多边形。
//
// 依赖:arrow-geometry.ts、arrow-curves.ts、arrow-polygon.ts、arrow-types.ts。
// 被消费:arrow/index.ts。
// 算法对应:cesium-plot-js src/arrow/curved-arrow.ts(其输出为 polyline,
//          本实现把"折线 + 末端三角"改写为"带状多边形 + 末端三角")。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	wholeDistance,
} from '../arrow-geometry';
import {
	centripetalCatmullRomSamples,
	computeTangents,
	findPointAlongPolylineFromEnd,
} from '../arrow-curves';
import { finalizePolygon } from '../arrow-polygon';
import type {
	ArrowPolygon,
	CurvedArrowOptions,
	LonLatPoint,
} from '../arrow-types';

// ── 默认值 ──
// 体宽 / 头宽 / 头长(均相对曲线总弧长)。给出一个「中等饱满体部 + 清晰三角头」
// 的曲线箭头:比早期 0.05 细杆饱满,又不会像 0.14 那样在平缓长弧上显得过粗过大。
// 这套数值对齐 ground-demo 里 S 形 curved 经曲率限宽后的**视觉尺寸**(体宽 ≈ 9%
// 弧长),使 plot 中的平缓曲线(不触发限宽)与 ground-demo 的 S 形曲线(触发限宽)
// 渲染出来粗细一致。
//
// **关键不变量:体宽 ≤ 颈宽 ≤ 头宽(单调变宽)。** 默认值已满足:
//   bodyHalfWidth = 0.09/2       = 0.045 · L
//   neckHalfWidth = 0.16 × 0.60/2 = 0.048 · L
//   headHalfWidth = 0.16/2       = 0.080 · L
//   → 0.045 ≤ 0.048 ≤ 0.080 ✓
// 这个顺序保证体部边缘从尾到颈到翼「只张不收」,不会在颈处先内收一台阶再
// 外张成翼(内凹台阶会渲染成缺口)。即使调用方覆写出违反该顺序的宽度,
// createCurvedArrowLocal 内也会再 clamp 一次兜底(见「步骤 2」)。
const DEFAULT_BODY_WIDTH_FACTOR = 0.09;
const DEFAULT_HEAD_WIDTH_FACTOR = 0.16;
const DEFAULT_HEAD_LENGTH_FACTOR = 0.14;
const DEFAULT_NECK_WIDTH_RELATIVE_TO_HEAD = 0.60;
const DEFAULT_CURVE_SMOOTHING_SEGMENTS = 16;
const DEFAULT_BODY_TAPER_RATIO = 0.0;

// 头部长度上限:不超过曲线总长的 60%,防止 body 被吃光。
const HEAD_LENGTH_MAX_FRACTION = 0.6;

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
	const bodyWidthFactor = options.bodyWidthFactor ?? DEFAULT_BODY_WIDTH_FACTOR;
	const headWidthFactor = options.headWidthFactor ?? DEFAULT_HEAD_WIDTH_FACTOR;
	const headLengthFactor = options.headLengthFactor ?? DEFAULT_HEAD_LENGTH_FACTOR;
	const neckWidthRelativeToHead =
		options.neckWidthRelativeToHead ?? DEFAULT_NECK_WIDTH_RELATIVE_TO_HEAD;
	const curveSmoothingSegments =
		options.curveSmoothingSegments ?? DEFAULT_CURVE_SMOOTHING_SEGMENTS;
	const bodyTaperRatio = options.bodyTaperRatio ?? DEFAULT_BODY_TAPER_RATIO;

	// ── 步骤 1:生成平滑脊线 ──
	// 2 点 → 直线段密采(centripetalCatmullRomSamples 内部已处理 2 点退化);
	// 3+ 点 → 严格通过控制点的 Centripetal Catmull-Rom。
	const spineSamples = centripetalCatmullRomSamples(
		controlPoints, curveSmoothingSegments,
	);
	if ( spineSamples.length < 2 ) {
		return [];
	}

	// ── 步骤 2:总弧长与各种宽度 ──
	const totalLen = wholeDistance( spineSamples );
	if ( totalLen <= 0.0 ) {
		// 所有控制点重合 → 无法构造箭头。
		return [];
	}

	const rawBodyHalfWidth = ( totalLen * bodyWidthFactor ) / 2.0;
	const headHalfWidth = ( totalLen * headWidthFactor ) / 2.0;
	const rawNeckHalfWidth = headHalfWidth * neckWidthRelativeToHead;

	// **单调变宽不变量:体宽 ≤ 颈宽 ≤ 头宽。**
	// 体部用 Frenet 偏移生成等宽带,末点(颈)宽度被强制设为 neckHalfWidth。
	// 若 bodyHalfWidth > neckHalfWidth,体部边缘会在颈处「向内收一台阶」(从
	// 体宽缩到更窄的颈宽),紧接着头部又「向外张成翼」(从颈宽涨到更宽的头宽)
	// —— 这个先内收再外张的单点台阶,在箭头正下方渲染成一个锐利缺口(用户截图
	// 的锯齿)。attack / swallowtail 箭头从不出现该缺口,因为它们的体部是
	// 「尾宽 → 颈宽」线性渐变、颈宽始终 ≥ 体最末宽,体→颈→翼全程只张不收。
	//
	// 这里把曲线箭头对齐到同一不变量:bodyHalfWidth clamp 到 ≤ headHalfWidth、
	// neckHalfWidth clamp 到 [bodyHalfWidth, headHalfWidth]。无论调用方传入什么
	// 宽度组合,体→颈→翼都保持单调变宽,不会再出现内凹缺口。
	const bodyHalfWidth = Math.min( rawBodyHalfWidth, headHalfWidth );
	const neckHalfWidth = Math.min(
		Math.max( rawNeckHalfWidth, bodyHalfWidth ),
		headHalfWidth,
	);
	// 头长(从尖端沿脊线回退的距离),clamp ≤ totalLen × HEAD_LENGTH_MAX_FRACTION,
	// 防止 body 长度变负。
	const rawHeadLength = Math.min(
		totalLen * headLengthFactor,
		totalLen * HEAD_LENGTH_MAX_FRACTION,
	);

	// ── 步骤 2b:全局曲率限宽(必须在 neck 之前算,这样头长也能随同缩放)──
	//
	// Frenet 法线偏移在 halfWidth > 局部曲率半径 R 时,弯曲内侧会自交。扫一遍
	// 整条脊线找最紧曲率半径 minR,把 bodyHalfWidth 全局 cap 到 minR×SAFETY
	// 之内,所有宽度按同一 widthScale 同步缩放,保持比例、整条 body 均匀。
	//
	// **关键:headLength 也乘 widthScale。** 若只缩头宽而头长不变,曲率触发缩放
	// 时头部会被拉成「又细又长的尖刺」(用户截图里 curved 那根瘦长箭头)。头长
	// 同步缩放后,头部三角在任何曲率下都保持「长 ≈ 宽」的紧凑比例,只是随整支
	// 箭头一起按比例缩小 —— 等价于 attack 把「头大小绑定到体宽」的效果。
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
			continue; // 直线段,半径无穷
		}
		const ds = ( len1 + len2 ) * 0.5;
		const r = ds / dtheta; // 局部曲率半径
		if ( r < tightestRadius ) {
			tightestRadius = r;
		}
	}

	let widthScale = 1.0;
	if ( Number.isFinite( tightestRadius ) ) {
		const safeMax = tightestRadius * CURVATURE_SAFETY;
		if ( bodyHalfWidth > safeMax && bodyHalfWidth > 0.0 ) {
			widthScale = safeMax / bodyHalfWidth;
		}
	}

	const cappedBodyHalfWidth = bodyHalfWidth * widthScale;
	const cappedNeckHalfWidth = neckHalfWidth * widthScale;
	const cappedHeadHalfWidth = headHalfWidth * widthScale;
	const cappedHeadLength = rawHeadLength * widthScale;

	// ── 步骤 3:定位精确颈点(沿脊线从末尾回退 cappedHeadLength) ──
	const neck = findPointAlongPolylineFromEnd( spineSamples, cappedHeadLength );
	if ( neck === null ) {
		// headLength 大于整条脊线 → 不可能(已 clamp),理论不可达;返回空保安。
		return [];
	}

	// bodySpine:从脊线起点到 exactNeck 的所有点(含 exactNeck)。
	// 之所以重新构造数组而不是直接 slice(...,neckSegIdx+1).push(exactNeck),
	// 是为了显式让 exactNeck 成为最后一个元素,使 computeTangents 在末点
	// 处用"前向差分"得到与 exactNeck 之前样本的切线方向(自然与脊线末段
	// 切线方向一致)。
	const bodySpine: LonLatPoint[] = spineSamples
		.slice( 0, neck.segmentIdx + 1 )
		.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	bodySpine.push( neck.point );

	if ( bodySpine.length < 2 ) {
		// 退化:headLength 接近 totalLen,body 几乎被吃光。
		// 仍可绘制(给最小 2 点 body),否则返回空多边形。
		return [];
	}

	// ── 步骤 4:逐点切线 + 90° 法线 ──
	// perpendicular = ( -ty, tx ) 是切线左手 90°(在 +y 朝上坐标系下指向"逻辑左")。
	// 经纬度坐标系也是 +y 朝北的右手系,perp 朝"曲线行进方向的左侧"。
	const tangents = computeTangents( bodySpine );

	// ── 步骤 5:逐点半宽(尾→颈线性插值;宽度已在步骤 2b 完成曲率限宽)──
	const lastBodyIdx = bodySpine.length - 1;

	const leftSide: LonLatPoint[] = new Array( bodySpine.length );
	const rightSide: LonLatPoint[] = new Array( bodySpine.length );

	for ( let i = 0; i < bodySpine.length; i++ ) {
		const t = lastBodyIdx > 0 ? i / lastBodyIdx : 0.0;
		let widthHalf: number;
		if ( i === lastBodyIdx ) {
			widthHalf = cappedNeckHalfWidth;
		} else {
			const interpolant = t * bodyTaperRatio;
			widthHalf = cappedBodyHalfWidth * ( 1.0 - interpolant )
				+ cappedNeckHalfWidth * interpolant;
		}

		const tx = tangents[ i ][ 0 ];
		const ty = tangents[ i ][ 1 ];
		const px = -ty;
		const py = tx;
		const sx = bodySpine[ i ][ 0 ];
		const sy = bodySpine[ i ][ 1 ];

		leftSide[ i ] = [ sx + px * widthHalf, sy + py * widthHalf ];
		rightSide[ i ] = [ sx - px * widthHalf, sy - py * widthHalf ];
	}

	// ── 步骤 6:头部 3 个新点(neckLeft/Right 已由 leftSide/rightSide 末点表示)──
	// 头部翼展用 exactNeck 处的法线 × cappedHeadHalfWidth(经曲率 scale 后,
	// 与 body / neck 保持相同比例,避免「窄腰宽翼」变形)。
	const neckTx = tangents[ lastBodyIdx ][ 0 ];
	const neckTy = tangents[ lastBodyIdx ][ 1 ];
	const neckPx = -neckTy;
	const neckPy = neckTx;
	const neckX = neck.point[ 0 ];
	const neckY = neck.point[ 1 ];

	const headLeft: LonLatPoint = [
		neckX + neckPx * cappedHeadHalfWidth,
		neckY + neckPy * cappedHeadHalfWidth,
	];
	const headRight: LonLatPoint = [
		neckX - neckPx * cappedHeadHalfWidth,
		neckY - neckPy * cappedHeadHalfWidth,
	];
	// 尖端 = 用户控制点的最末点(确保箭尖严格在用户指定位置)。
	const tip: LonLatPoint = [
		controlPoints[ controlPoints.length - 1 ][ 0 ],
		controlPoints[ controlPoints.length - 1 ][ 1 ],
	];

	// ── 步骤 7:拼接最终多边形 ──
	// 顺序(CCW):
	//   leftSide(尾→颈) → headLeft → tip → headRight → rightSide 反向(颈→尾)
	// leftSide[last] = neckLeft,rightSide[last] = neckRight,它们与 headLeft/
	// headRight 在同一垂直于切线的射线上,只是 headLeft/Right 更外侧,
	// 形成自然的翼展张开。
	//
	// 注意:leftSide / rightSide 的末点本身就是 neckLeft/neckRight,不能
	// 在这里 slice(0, -1),因为它们与 headLeft/headRight 是不同的点
	// (一个 neckHalfWidth、一个 headHalfWidth),不会产生重复顶点。
	const rawRing: LonLatPoint[] = [
		...leftSide,                            // tailLeft → neckLeft
		headLeft,                               // 翼尖
		tip,                                    // 箭尖
		headRight,                              // 翼尖
		...rightSide.slice().reverse(),         // neckRight → tailRight
	];

	return finalizePolygon( rawRing );
}

// 内部颈点搜索由 arrow-curves.ts 的 `findPointAlongPolylineFromEnd` 统一提供
// (attack-arrow / swallowtail-attack-arrow / curved-arrow 三个箭头共享)。
