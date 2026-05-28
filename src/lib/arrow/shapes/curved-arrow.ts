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
// 这些默认值经过手工调校,使在 3 控制点、曲线长度 ~0.01 弧度尺度(WGS84
// 约 1 km)时的箭头视觉与 cesium-plot-js 同名箭头风格一致(略修长,
// 头部不喧宾夺主)。
const DEFAULT_BODY_WIDTH_FACTOR = 0.05;
const DEFAULT_HEAD_WIDTH_FACTOR = 0.16;
const DEFAULT_HEAD_LENGTH_FACTOR = 0.18;
const DEFAULT_NECK_WIDTH_RELATIVE_TO_HEAD = 0.40;
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

	const bodyHalfWidth = ( totalLen * bodyWidthFactor ) / 2.0;
	const headHalfWidth = ( totalLen * headWidthFactor ) / 2.0;
	const neckHalfWidth = headHalfWidth * neckWidthRelativeToHead;
	// 头长 clamp 到 ≤ totalLen × HEAD_LENGTH_MAX_FRACTION,防止 body 长度负值。
	const headLength = Math.min(
		totalLen * headLengthFactor,
		totalLen * HEAD_LENGTH_MAX_FRACTION,
	);

	// ── 步骤 3:定位精确颈点(沿脊线从末尾回退 headLength) ──
	const neck = findPointAlongPolylineFromEnd( spineSamples, headLength );
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

	// ── 步骤 5:全局曲率体宽兜底 + 逐点半宽(尾→颈线性插值)──
	//
	// 关键问题:Frenet 法线偏移在 halfW > 局部曲率半径 R=1/κ 时,弯曲内侧
	// 会自交,polygon 渲染成镂空三角(用户在 plot demo 大比例尺 curved
	// 拐角处看到的)。
	//
	// 早期实现做过「逐 sample 按本地 κ clamp halfW」,但这让 body 在急弯
	// 处突然变窄、其他位置正常 → 整体宽度不均、视觉变形。
	//
	// **新策略**:扫一遍全脊线,找出最紧曲率半径 minR,把 bodyHalfWidth /
	// neckHalfWidth 全局 cap 到 (minR × CURVATURE_SAFETY) 之内。整条 body
	// 保持均匀宽度——只是急弯输入下会整体偏窄一些,但形态平滑无变形。
	const lastBodyIdx = bodySpine.length - 1;
	const CURVATURE_SAFETY = 0.5;

	let tightestRadius = Infinity;
	for ( let i = 1; i < lastBodyIdx; i++ ) {
		const prev = bodySpine[ i - 1 ];
		const curr = bodySpine[ i ];
		const next = bodySpine[ i + 1 ];
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
		const ds = ( len1 + len2 ) * 0.5;
		if ( dtheta < 1e-9 ) {
			continue; // 直线段,半径无穷
		}
		const r = ds / dtheta; // 局部曲率半径
		if ( r < tightestRadius ) {
			tightestRadius = r;
		}
	}

	let safeMax = Infinity;
	if ( Number.isFinite( tightestRadius ) ) {
		safeMax = tightestRadius * CURVATURE_SAFETY;
	}
	// **关键**:所有宽度按相同 scale 同步缩放,保持原比例关系。只 cap body
	// 而 head 用原始 headHalfWidth 时,head 翼会比窄缩的 body 宽很多倍,polygon
	// 在 neck 处形成「窄腰宽翼」的视觉变形(用户截图的三角凹口就是这种比例
	// 突变)。这里以 bodyHalfWidth 是否超 safeMax 触发缩放,所有 width 同步乘
	// scale,head / body / neck 三者保持原 width factor 决定的比例。
	let widthScale = 1.0;
	if ( bodyHalfWidth > safeMax && bodyHalfWidth > 0.0 ) {
		widthScale = safeMax / bodyHalfWidth;
	}
	const cappedBodyHalfWidth = bodyHalfWidth * widthScale;
	const cappedNeckHalfWidth = neckHalfWidth * widthScale;
	const cappedHeadHalfWidth = headHalfWidth * widthScale;

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
