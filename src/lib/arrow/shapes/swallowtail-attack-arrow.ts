// ============================================================
// arrow/shapes/swallowtail-attack-arrow.ts — 燕尾攻击箭头(3+ 点),
//                                              Frenet 带状构造 + 燕尾凸点
// 层级：L1
// 职责：在 AttackArrow 的 Frenet 带状骨架(`buildAttackArrowSkeleton`)基础上,
//      在尾部中线方向多挤出一个"燕尾凸点",让原本平直的尾部边缘从一条
//      直线变成 V 形凹口。
//
//      体部 / 头部 / 脊线平滑 / 描边友好性 全部继承自 attack-arrow.ts —
//      本文件不再做任何独立的左右带平滑,**绝不**重新计算 leftBody /
//      rightBody 这种镜像离散偏移点。
//
// 控制点契约:与 createAttackArrow 完全相同。
//
// 几何步骤:
//   1. 调用 buildAttackArrowSkeleton(controlPoints, options) 拿到:
//        leftSide / rightSide / headLeft / headRight / tip / tailLeft /
//        tailRight / midTail / spineSecond
//   2. 计算 swallowtailPnt:从 spineSecond 沿"指向 midTail"的方向多走
//      `len = baseLength × tailWidthFactor × swallowtailFactor` 距离。
//      即燕尾凸点位于 midTail 之后(脊线反方向)的延长线上。
//   3. 单笔周界遍历(CCW):
//        leftSide          (tailLeft → ... → neckLeft)
//        headLeft          (左翼尖)
//        tip               (箭尖)
//        headRight         (右翼尖)
//        reverse rightSide (neckRight → ... → tailRight)
//        swallowtailPnt    (V 形凹口顶点,在 tailLeft 与 tailRight 之间)
//      最后 finalizePolygon 把闭合环交给下游。
//
// 与 AttackArrow 的差异总结:
//   - **唯一**新增几何:swallowtailPnt 一个顶点。
//   - **唯一**新增选项:swallowtailFactor、tailWidthFactor(仅影响燕尾深度)。
//   - 体部、头部、脊线平滑、描边友好的 Frenet 法线偏移路径 完全复用。
//
// 依赖:arrow-geometry.ts(getBaseLength + getThirdPoint),
//      arrow-polygon.ts(finalizePolygon),
//      arrow-types.ts(SwallowtailAttackArrowOptions),
//      shapes/attack-arrow.ts(buildAttackArrowSkeleton),
//      shapes/fine-arrow.ts(2 控制点退化)。
// 被消费:arrow/index.ts。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	getThirdPoint,
} from '../arrow-geometry';
import { finalizePolygon } from '../arrow-polygon';
import type {
	ArrowPolygon,
	LonLatPoint,
	SwallowtailAttackArrowOptions,
} from '../arrow-types';
import { buildAttackArrowSkeleton } from './attack-arrow';
import { createFineArrow } from './fine-arrow';

// ── 燕尾特有默认值 ──
// tailWidthFactor 0.10:燕尾长度的基准比例(基准长度 × 此值 × swallowtailFactor)。
// swallowtailFactor 1.0:燕尾凸出深度倍率,1.0 即标准深度,>1 凸出更深,
//                       0 时凸点与 midTail 重合 → 视觉上等价 AttackArrow。
const DEFAULT_TAIL_WIDTH_FACTOR = 0.08;
const DEFAULT_SWALLOWTAIL_FACTOR = 0.70;

/**
 * 构造燕尾攻击箭头(Frenet 带状 + 尾部 V 形凹口)。
 *
 * @param controlPoints 控制点序列,至少 3 个。少于 3 时:
 *   - 2 个点 → 退化为 createFineArrow(与 attack-arrow 保持一致)
 *   - < 2 → 返回空数组
 * @param options 比例与平滑参数(继承 AttackArrowOptions + 燕尾两项)。
 * @returns 闭合多边形;输入退化时可能返回空数组。
 */
export function createSwallowtailAttackArrow(
	controlPoints: readonly LonLatPoint[],
	options: SwallowtailAttackArrowOptions = {},
): ArrowPolygon {
	return createArrowInLocalMeterPlane(
		controlPoints,
		( localPoints ) => createSwallowtailAttackArrowLocal( localPoints, options ),
	);
}

function createSwallowtailAttackArrowLocal(
	controlPoints: readonly LonLatPoint[],
	options: SwallowtailAttackArrowOptions = {},
): ArrowPolygon {
	// ── 输入校验 + 兼容退化 ──
	if ( controlPoints.length < 2 ) {
		return [];
	}
	if ( controlPoints.length === 2 ) {
		return createFineArrow( controlPoints[ 0 ], controlPoints[ 1 ] );
	}

	// ── 复用 AttackArrow 骨架(Frenet 带状,描边友好)──
	const skeleton = buildAttackArrowSkeleton( controlPoints, options );
	if ( ! skeleton ) {
		return [];
	}

	// ── 燕尾特有参数 ──
	const tailWidthFactor = options.tailWidthFactor ?? DEFAULT_TAIL_WIDTH_FACTOR;
	const swallowtailFactor = options.swallowtailFactor ?? DEFAULT_SWALLOWTAIL_FACTOR;

	// 燕尾深度的尺度来自整条脊线的基准长度(skeleton.spineBaseLen,
	// 与原版 attack-arrow 内部的 baseLen 一致)。这样无论脊线有几个控制点,
	// 燕尾凸出量都按"整体箭头大小"等比例缩放,而不是只跟尾段长度挂钩。
	const swallowtailLen = skeleton.spineBaseLen * tailWidthFactor * swallowtailFactor;

	// 从 spineSecond 沿"反向 spineSecond → midTail"的延长线多走 swallowtailLen,
	// 得到燕尾凸点(位于 midTail 之后的脊线反方向)。
	//
	// getThirdPoint( startPnt = spineSecond, endPnt = midTail, angle = 0,
	//                distance = swallowtailLen, clockwise = true )
	//   含义:从 midTail 看向 spineSecond 反向(= midTail → 远离 spineSecond
	//        方向 = midTail → 燕尾外侧方向)起步,旋转 0,前进 swallowtailLen。
	// 退化:swallowtailFactor = 0 时 swallowtailLen = 0,getThirdPoint 返回
	//      midTail 本身 → 燕尾凸点与尾中点重合,视觉等价 AttackArrow。
	const swallowtailPnt: LonLatPoint = getThirdPoint(
		skeleton.spineSecond,
		skeleton.midTail,
		0.0,
		swallowtailLen,
		true,
	);

	// ── 单笔周界遍历(CCW)──
	// 顺序与 AttackArrow 相同,只是在最后多加一个 swallowtailPnt 顶点,
	// 把"tailRight → tailLeft"的直边切成"tailRight → swallowtailPnt → tailLeft"
	// 两条边,中间形成 V 形凹口(对外为"^"形)。
	const rawRing: LonLatPoint[] = [
		...skeleton.leftSide,                       // tailLeft → ... → neckLeft
		skeleton.headLeft,                          // 左翼尖
		skeleton.tip,                               // 箭尖
		skeleton.headRight,                         // 右翼尖
		...skeleton.rightSide.slice().reverse(),    // neckRight → ... → tailRight
		swallowtailPnt,                             // 燕尾凹口顶点
	];

	return finalizePolygon( rawRing );
}
