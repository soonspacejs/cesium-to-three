// ============================================================
// arrow/shapes/attack-arrow.ts — 攻击箭头(3+ 点),Frenet 带状构造
// 层级：L1
// 职责：由 3 个以上控制点定义"宽体渐变"攻击箭头。本文件用 **Frenet 法线
//      偏移**构造箭头体,而不是先在脊线两侧各算一组离散偏移点然后分别
//      Catmull-Rom 平滑(见"为什么放弃左右各自平滑"一节)。
//
//      输出多边形仍然是一个 CCW 闭合环,几何形态与原 cesium-plot-js
//      AttackArrow 相同:尾部直边 + 渐变体部 + 5 点三角头。
//
// 控制点契约:
//   points[0], points[1] —— 两点决定尾部位置与宽度(连线为尾边)
//   points[2..n]         —— 从第 3 点开始定义脊线(箭头体走向),
//                           最末点 points[n-1] 即箭头尖端
//
// 几何步骤(单笔周界遍历):
//   1. tailLeft / tailRight (用 isClockWise 判定方向),midTail = mid(L,R)
//   2. spineControlPoints = [ midTail, points[2..n-1] ]
//   3. spineSamples = Centripetal Catmull-Rom(spineControlPoints) —— 这是
//      整条脊线唯一的一次平滑,左右两侧共享同一组样本。
//   4. headHeight clamp(同原版):受 tailWidth*headTailFactor 与最末段长约束
//   5. neckPoint = findPointAlongPolylineFromEnd(spineSamples, neckHeight)
//      把 spineSamples 在 neck 处剪开:bodySpine = samples[0..k] ⊕ neckPoint
//   6. tangents = computeTangents(bodySpine) —— 每个 body 样本的单位切向
//   7. 沿 bodySpine 一笔走完左侧 (tailLeft → neckLeft),再走头部 3 点
//      (headLeft → tip → headRight),再反向走完右侧 (neckRight → tailRight)。
//      每个 body 顶点 = sample + ±perp × halfWidth(i),其中 halfWidth(i)
//      在 [tailHalfWidth, neckHalfWidth] 之间线性插值(taper 由控制点契约
//      隐含,无需额外参数)。
//   8. 收尾:把 leftSide[0] / rightSide[0] 强制对齐 tailLeft / tailRight,
//      保证用户指定的尾角严格出现在多边形上(避免 Catmull-Rom 微小漂移)。
//
// 为什么放弃"左右各自平滑":
//   原 cesium-plot-js AttackArrow 在脊线每个内部顶点处计算 leftBody[i] /
//   rightBody[i] 两个互为镜像的离散偏移点,然后**各自**做一次 Catmull-Rom
//   平滑。问题:
//     a. 左右各做一次 CR,导致同一脊线段两侧的密采点 **轴向上**不一致
//        (左侧的第 k 个样本与右侧的第 k 个样本不在同一脊线弧长位置上),
//        多边形相邻 body 顶点之间的边并不严格沿脊线切线方向。
//     b. 这些 body 顶点交给 polygon-helpers.ts 的
//        `expandPolygonPointsThroughMeters` 做描边外扩时,后者沿
//        **多边形 centroid → 顶点** 径向方向推每个顶点 N 米。body 侧顶点的
//        径向方向 ≈ 脊线垂直方向(理想),但只有"边沿脊线切向排列"时,
//        逐顶点的径向 ≈ 边垂直,描边才会均匀。
//        左右各自 CR 给出的边方向偏离脊线切向,导致描边宽度沿体部抖动。
//
//   本实现改为**对脊线只做一次 CR**,然后逐样本沿切向 perp 偏移生成
//   left/right 两条平行带 —— 同一 i 的 leftSide[i] 与 rightSide[i] 严格位于
//   同一脊线弧长位置的两侧,相邻 body 顶点之间的边天然沿脊线切线方向,描边
//   外扩与"边垂直方向"近似一致 → 描边带均匀。
//
//   注:本实现的输出多边形仍然关于脊线对称。差别在内部构造路径——"两次
//   各自 CR 漂移"vs"一次 CR 共享样本"。对下游描边管线的友好度天差地别。
//
// 依赖:arrow-geometry.ts、arrow-curves.ts、arrow-polygon.ts、arrow-types.ts、
//      shapes/fine-arrow.ts(2 控制点退化)。
// 被消费:arrow/index.ts、arrow/shapes/swallowtail-attack-arrow.ts(复用本文件
//        的 `buildAttackArrowSkeleton` 内部 helper)。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	getBaseLength,
	mathDistance,
	mid,
} from '../arrow-geometry';
import {
	centripetalCatmullRomSamples,
	computeTangents,
	findPointAlongPolylineFromEnd,
} from '../arrow-curves';
import { finalizePolygon } from '../arrow-polygon';
import type {
	ArrowPolygon,
	AttackArrowOptions,
	LonLatPoint,
} from '../arrow-types';
import { createFineArrow } from './fine-arrow';

// ── 默认值(与 cesium-plot-js AttackArrow 同名字段保持一致)──
const DEFAULT_HEAD_HEIGHT_FACTOR = 0.18;
const DEFAULT_HEAD_WIDTH_FACTOR = 0.30;
const DEFAULT_NECK_HEIGHT_FACTOR = 0.85;
const DEFAULT_NECK_WIDTH_FACTOR = 0.15;
const DEFAULT_HEAD_TAIL_FACTOR = 0.80;
// 12:Catmull-Rom 每段采样 12 点。多控制点脊线下采样总数 = (n-1)*12 + 1,
// 远低于 ARROW_OUTPUT_MAX_VERTICES = 120 的上限。
const DEFAULT_BODY_SMOOTHING_SEGMENTS = 12;
// 注:`minBodyHalfAngleRadians` / `bodyWidthMargin` 在原实现里用来反算
// w = (tailWidth/2 - dropoff) / sin(halfAngle) 时做 clamp。Frenet 构造下,
// 体宽由 tailHalfWidth 与 neckHalfWidth 之间的线性插值决定,完全不进入
// sin(α) 这条分母路径,因此两个鲁棒性字段保留在 API 表面只是为了让 GUI
// 上层不必为"老选项是否仍存在"做条件渲染。Frenet 构造内部已无相关计算。

/**
 * 攻击箭头骨架。
 *
 * 暴露给 swallowtail-attack-arrow.ts 复用,后者只需要在尾部多加一个燕尾
 * 凸点,体部 / 头部几何与本文件 100% 一致。
 */
export interface AttackArrowSkeleton {
	/** 脊线左侧带,leftSide[0] = tailLeft、leftSide[last] = neckLeft。 */
	leftSide: LonLatPoint[];
	/** 脊线右侧带,rightSide[0] = tailRight、rightSide[last] = neckRight。 */
	rightSide: LonLatPoint[];
	/** 左翼尖(在 neck 处沿法线外扩 headHalfWidth)。 */
	headLeft: LonLatPoint;
	/** 右翼尖。 */
	headRight: LonLatPoint;
	/** 箭尖(与用户控制点 controlPoints[n-1] 严格一致)。 */
	tip: LonLatPoint;
	/** 尾左角(与 leftSide[0] 严格一致)。 */
	tailLeft: LonLatPoint;
	/** 尾右角(与 rightSide[0] 严格一致)。 */
	tailRight: LonLatPoint;
	/** 尾中点(燕尾箭头里用作"燕尾凸出方向"的参考)。 */
	midTail: LonLatPoint;
	/** 脊线第二个控制点(燕尾箭头里用作"燕尾凸出方向"的参考)。 */
	spineSecond: LonLatPoint;
	/**
	 * 整条脊线(含 midTail + 全部 controlPoints[2..n-1])的基准长度
	 * = wholeDistance(spineControlPoints) ** 0.99。
	 * 燕尾箭头里"燕尾凸出深度"的尺度来自这个值,与原版一致。
	 */
	spineBaseLen: number;
}

/**
 * 构造攻击箭头(Frenet 带状)。
 *
 * @param controlPoints 控制点序列,至少 3 个。少于 3 时:
 *   - controlPoints.length === 2 → 退化为 createFineArrow(与原版兼容)
 *   - controlPoints.length < 2 → 返回空数组
 * @param options 可选比例与平滑参数。
 * @returns 闭合多边形;输入退化时可能返回空数组。
 */
export function createAttackArrow(
	controlPoints: readonly LonLatPoint[],
	options: AttackArrowOptions = {},
): ArrowPolygon {
	return createArrowInLocalMeterPlane(
		controlPoints,
		( localPoints ) => createAttackArrowLocal( localPoints, options ),
	);
}

function createAttackArrowLocal(
	controlPoints: readonly LonLatPoint[],
	options: AttackArrowOptions = {},
): ArrowPolygon {
	// ── 输入校验 + 兼容退化 ──
	if ( controlPoints.length < 2 ) {
		return [];
	}
	if ( controlPoints.length === 2 ) {
		return createFineArrow( controlPoints[ 0 ], controlPoints[ 1 ] );
	}

	const skeleton = buildAttackArrowSkeleton( controlPoints, options );
	if ( ! skeleton ) {
		return [];
	}

	// ── 单笔周界遍历(CCW)──
	// 顺序:
	//   leftSide[0..lastBodyIdx]  (tailLeft → neckLeft,沿脊线左侧前进)
	//   headLeft                  (左翼尖,在 neck 处法线外扩 headWidth)
	//   tip                       (脊线最末点,严格采用用户控制点)
	//   headRight                 (右翼尖)
	//   reverse rightSide[..0]    (neckRight → tailRight,沿脊线右侧回退)
	//
	// leftSide[last] = neckLeft、rightSide[last] = neckRight 已经是颈侧顶点。
	// headLeft / headRight 与 neckLeft / neckRight 在同一垂直于切线的射线上,
	// 只是 headLeft / Right 半宽更大 → 形成自然翼展张开,不产生重复顶点。
	const rawRing: LonLatPoint[] = [
		...skeleton.leftSide,                       // tailLeft → ... → neckLeft
		skeleton.headLeft,                          // 左翼尖
		skeleton.tip,                               // 箭尖
		skeleton.headRight,                         // 右翼尖
		...skeleton.rightSide.slice().reverse(),    // neckRight → ... → tailRight
	];

	return finalizePolygon( rawRing );
}

/**
 * 构造攻击箭头骨架(脊线 + 左右带 + 头部 3 点)。
 *
 * 把 spine、左右带、头部 3 点暴露给 swallowtail-attack-arrow.ts 复用,
 * 详细几何步骤见文件顶部的"几何步骤"注释。
 * 任何输入退化(脊线少于 2 点、长度为 0 等)时返回 null。
 *
 * @param controlPoints 控制点序列,至少 3 个(由调用方校验)。
 * @param options       AttackArrow 选项;未传字段使用本文件默认值。
 * @returns 骨架对象;输入退化时返回 null。
 */
export function buildAttackArrowSkeleton(
	controlPoints: readonly LonLatPoint[],
	options: AttackArrowOptions,
): AttackArrowSkeleton | null {
	// ── 解析选项 ──
	const headHeightFactor = options.headHeightFactor ?? DEFAULT_HEAD_HEIGHT_FACTOR;
	const headWidthFactor = options.headWidthFactor ?? DEFAULT_HEAD_WIDTH_FACTOR;
	const neckHeightFactor = options.neckHeightFactor ?? DEFAULT_NECK_HEIGHT_FACTOR;
	const neckWidthFactor = options.neckWidthFactor ?? DEFAULT_NECK_WIDTH_FACTOR;
	const headTailFactor = options.headTailFactor ?? DEFAULT_HEAD_TAIL_FACTOR;
	const bodySmoothingSegments =
		options.bodySmoothingSegments ?? DEFAULT_BODY_SMOOTHING_SEGMENTS;

	// ── Step 1:tailLeft / tailRight + midTail ──
	// 体部走 Frenet 法线偏移:perp_CCW = ( -spineDirY, spineDirX ) 指向脊线的
	// 左侧(在 +y 朝北的右手系下)。要求 leftSide[0] = tailLeft 也位于这一侧,
	// 否则 leftSide[0] → leftSide[1] 这条边会穿过脊线,整个多边形自交,
	// 下游 polygon-helpers.ts 描边路径(centroid-径向外扩 + 偶奇规则
	// point-in-polygon)在自交多边形上结果不定 → 描边只画一半、燕尾退化成
	// 三角形等明显异常。
	//
	// 判定:用 spineDir × (controlPoints[0] - midTail) 的 2D 叉积符号判定
	// controlPoints[0] 落在脊线的 CCW(左)还是 CW(右)侧。叉积 > 0 → 左侧,
	// 维持 tailLeft = controlPoints[0];叉积 < 0 → 右侧,交换。
	//
	// 注:原 cesium-plot-js 的 `isClockWise(p0, p1, p2)` 判定**也**做了一次交换,
	// 但那是为它自己的"两次镜像偏移点 + 各自 Catmull-Rom"构造路径量身定做的;
	// Frenet 构造下需要的"侧"语义不同,必须独立判定,**不能**沿用
	// `isClockWise` 那一行。
	const tentativeMidTail = mid( controlPoints[ 0 ], controlPoints[ 1 ] );
	const tentativeSpineDirX = controlPoints[ 2 ][ 0 ] - tentativeMidTail[ 0 ];
	const tentativeSpineDirY = controlPoints[ 2 ][ 1 ] - tentativeMidTail[ 1 ];
	const tailVecX = controlPoints[ 0 ][ 0 ] - tentativeMidTail[ 0 ];
	const tailVecY = controlPoints[ 0 ][ 1 ] - tentativeMidTail[ 1 ];
	const sideTest =
		tentativeSpineDirX * tailVecY - tentativeSpineDirY * tailVecX;

	let tailLeft = controlPoints[ 0 ];
	let tailRight = controlPoints[ 1 ];
	if ( sideTest < 0.0 ) {
		tailLeft = controlPoints[ 1 ];
		tailRight = controlPoints[ 0 ];
	}
	const midTail = mid( tailLeft, tailRight );

	// ── Step 2:脊线控制点 ──
	const spineControlPoints: LonLatPoint[] = [ midTail ];
	for ( let i = 2; i < controlPoints.length; i++ ) {
		spineControlPoints.push( controlPoints[ i ] );
	}
	if ( spineControlPoints.length < 2 ) {
		return null;
	}

	// ── Step 3:**唯一一次** Catmull-Rom 平滑脊线 ──
	const spineSamples = centripetalCatmullRomSamples(
		spineControlPoints,
		bodySmoothingSegments,
	);
	if ( spineSamples.length < 2 ) {
		return null;
	}

	// ── Step 4:头部尺寸 clamp ──
	const tailWidth = mathDistance( tailLeft, tailRight );
	const baseLen = getBaseLength( spineControlPoints );
	const tip: LonLatPoint = [
		spineControlPoints[ spineControlPoints.length - 1 ][ 0 ],
		spineControlPoints[ spineControlPoints.length - 1 ][ 1 ],
	];
	const beforeTip = spineControlPoints[ spineControlPoints.length - 2 ];
	const lastSegLen = mathDistance( tip, beforeTip );

	let headHeight = baseLen * headHeightFactor;
	// 防止箭头头大于身(原版 headTailFactor)。
	if ( headHeight > tailWidth * headTailFactor ) {
		headHeight = tailWidth * headTailFactor;
	}
	// 防止头部伸出脊线之外。
	if ( headHeight > lastSegLen ) {
		headHeight = lastSegLen;
	}
	if ( headHeight <= 0.0 ) {
		// 整条脊线退化为单点 → 无法构造头部。
		return null;
	}

	// neckHeight = 颈与尖之间沿脊线的弧长(< headHeight)。
	// 体部止于 neckHeight 位置,头部在 neckHeight..0 之间张开成 5 点三角。
	const neckHeight = headHeight * neckHeightFactor;

	// 修复 4(沿用原版):headHalfWidth / neckHalfWidth 在 headHeight 最终
	// clamp 之后计算,避免头被压缩时翼宽相对过宽。
	const headHalfWidth = headHeight * headWidthFactor;
	const neckHalfWidth = headHeight * neckWidthFactor;

	// ── Step 5:把 spineSamples 在 neck 处剪开 ──
	const neckCut = findPointAlongPolylineFromEnd( spineSamples, neckHeight );
	if ( neckCut === null ) {
		// 头部比整条脊线还长 — 上面 clamp 之后不应进入此分支。
		return null;
	}

	// bodySpine = [ spineSamples[0..neckCut.segmentIdx], neckCut.point ]
	// 让 neckCut.point 作为 bodySpine 最后一个元素,使 computeTangents 在末点
	// 用"前向差分"得到与脊线 neck 处切线一致的方向。
	const bodySpine: LonLatPoint[] = [];
	for ( let i = 0; i <= neckCut.segmentIdx; i++ ) {
		bodySpine.push( [ spineSamples[ i ][ 0 ], spineSamples[ i ][ 1 ] ] );
	}
	// 当 neckCut.localT 几乎为 0 时,neckCut.point 与 spineSamples[segmentIdx]
	// 几乎重合 → 不再 push,以免后续 computeTangents 出现零长边。
	const lastSpineX = spineSamples[ neckCut.segmentIdx ][ 0 ];
	const lastSpineY = spineSamples[ neckCut.segmentIdx ][ 1 ];
	const dx = neckCut.point[ 0 ] - lastSpineX;
	const dy = neckCut.point[ 1 ] - lastSpineY;
	if ( ( dx * dx + dy * dy ) > 1e-24 ) {
		bodySpine.push( [ neckCut.point[ 0 ], neckCut.point[ 1 ] ] );
	}
	if ( bodySpine.length < 2 ) {
		return null;
	}

	// ── Step 6:逐 body 样本切向 + 法线 ──
	const tangents = computeTangents( bodySpine );

	// ── Step 7:沿脊线一笔走完左侧,再走右侧(同一组样本,严格对齐)──
	const tailHalfWidth = tailWidth / 2.0;
	const lastBodyIdx = bodySpine.length - 1;

	const leftSide: LonLatPoint[] = new Array( bodySpine.length );
	const rightSide: LonLatPoint[] = new Array( bodySpine.length );

	for ( let i = 0; i <= lastBodyIdx; i++ ) {
		const t = lastBodyIdx > 0 ? i / lastBodyIdx : 0.0;
		// halfWidth(i) 线性插值:tail → neck。
		let halfW: number;
		if ( i === lastBodyIdx ) {
			// 末点强制对齐 neck,与头部 5 点共点,无台阶。
			halfW = neckHalfWidth;
		} else {
			halfW = tailHalfWidth * ( 1.0 - t ) + neckHalfWidth * t;
		}

		// perp = ( -ty, tx ) 是切线的左手 90°(+y 朝北的右手系下指向"逻辑左")。
		const tx = tangents[ i ][ 0 ];
		const ty = tangents[ i ][ 1 ];
		const px = -ty;
		const py = tx;

		const sx = bodySpine[ i ][ 0 ];
		const sy = bodySpine[ i ][ 1 ];

		leftSide[ i ] = [ sx + px * halfW, sy + py * halfW ];
		rightSide[ i ] = [ sx - px * halfW, sy - py * halfW ];
	}

	// ── Step 8:把用户指定的 tail 严格钉在多边形上 ──
	// midTail = mid(tailLeft, tailRight) 经过 Centripetal CR 后端点严格通过,
	// 但是 CR 的 mirror 端点策略可能让 spineSamples[0] 与 midTail 有微小漂移。
	// 这里把 leftSide[0] / rightSide[0] 强制覆盖为用户指定的 tailLeft / tailRight,
	// 保证视觉上"用户点击的尾角"严格出现在最终多边形上。
	leftSide[ 0 ] = [ tailLeft[ 0 ], tailLeft[ 1 ] ];
	rightSide[ 0 ] = [ tailRight[ 0 ], tailRight[ 1 ] ];

	// ── Step 9:头部 3 个新点(headLeft / tip / headRight)──
	// 翼尖在 neck 处沿法线外扩 headHalfWidth(比 neckHalfWidth 大 → 翼展张开)。
	const neckTx = tangents[ lastBodyIdx ][ 0 ];
	const neckTy = tangents[ lastBodyIdx ][ 1 ];
	const neckPx = -neckTy;
	const neckPy = neckTx;
	const neckX = bodySpine[ lastBodyIdx ][ 0 ];
	const neckY = bodySpine[ lastBodyIdx ][ 1 ];

	const headLeft: LonLatPoint = [
		neckX + neckPx * headHalfWidth,
		neckY + neckPy * headHalfWidth,
	];
	const headRight: LonLatPoint = [
		neckX - neckPx * headHalfWidth,
		neckY - neckPy * headHalfWidth,
	];

	return {
		leftSide,
		rightSide,
		headLeft,
		headRight,
		tip,
		tailLeft: [ tailLeft[ 0 ], tailLeft[ 1 ] ],
		tailRight: [ tailRight[ 0 ], tailRight[ 1 ] ],
		midTail: [ midTail[ 0 ], midTail[ 1 ] ],
		spineSecond: [ spineControlPoints[ 1 ][ 0 ], spineControlPoints[ 1 ][ 1 ] ],
		spineBaseLen: baseLen,
	};
}
