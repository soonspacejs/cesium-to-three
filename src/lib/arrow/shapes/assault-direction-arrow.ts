// ============================================================
// arrow/shapes/assault-direction-arrow.ts — 突击方向箭头(2 点),
//                                            单笔周界遍历
// 层级：L1
// 职责：与 FineArrow 同形(8 顶点闭合多边形,p1 尾 + p2 头)但更"窄长":
//        - 默认尾宽 8% / 颈宽 10% / 翼展 13%(FineArrow 是 10/20/25)
//        - 翼展夹角 45°(FineArrow 是 ~21°),颈部夹角 ~32°(FineArrow 是 ~14°)
//        - 内部把基准长度放大 1.5 倍(配置项 lengthScale),让箭头看起来更修长。
//      视觉效果:相比 FineArrow,AssaultDirectionArrow 更像"匕首"——尾部
//      非常细,头部翼展角度大但翼展短,适合表示局部突击/侦察方向。
//
//      构造方式与 fine-arrow.ts 完全相同:**先取脊线基(spineDir+perp),
//      再单笔走完 8 个 CCW 顶点**。没有"成对调用 getThirdPoint 计算镜像点"
//      这种左右拆分,体部边天然沿脊线 / 法线方向排列,描边友好。
//
//      与原 cesium-plot-js 数学等价(纯重组),但更适合本项目的描边管线。
//
// 依赖:arrow-geometry.ts(mathDistance + getBaseLength),
//      arrow-polygon.ts(finalizePolygon),
//      arrow-types.ts(AssaultDirectionArrowOptions)。
// 被消费:arrow/index.ts。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	getBaseLength,
	mathDistance,
} from '../arrow-geometry';
import { finalizePolygon } from '../arrow-polygon';
import type {
	ArrowPolygon,
	AssaultDirectionArrowOptions,
	LonLatPoint,
} from '../arrow-types';

// ── 默认值(与 cesium-plot-js AssaultDirection 完全一致)──
const DEFAULT_LENGTH_SCALE = 1.5;
const DEFAULT_TAIL_WIDTH_FACTOR = 0.08;
const DEFAULT_NECK_WIDTH_FACTOR = 0.10;
const DEFAULT_HEAD_WIDTH_FACTOR = 0.13;
const DEFAULT_HEAD_ANGLE_RADIANS = Math.PI / 4.0;
// 0.17741π ≈ 0.5575 rad ≈ 31.94°
const DEFAULT_NECK_ANGLE_RADIANS = Math.PI * 0.17741;

/**
 * 生成突击方向箭头多边形(单笔 CCW 周界遍历)。
 *
 * 与 createFineArrow 的差异仅在默认比例与 lengthScale,几何步骤完全相同:
 *   1. spineDir = (p2 - p1) / |p2 - p1|;perp_CCW = ( -spineDir.y, spineDir.x )
 *   2. baseLen = |p1 p2|^0.99 × lengthScale,派生 tail/neck/head 三个 halfWidth
 *   3. 颈 / 翼的"轴 + 法向"偏移由 cos(angle) × halfWidth 和 sin(angle) × halfWidth
 *      给出
 *   4. 按 CCW 顺序逐顶点排列 8 个点:
 *        p1 → tailRight → neckRight → headRight → p2 → headLeft → neckLeft → tailLeft
 *   5. 交给 finalizePolygon 去重 + CCW 校正 + 顶点上限 clamp。
 *
 * @param p1 尾部端点。
 * @param p2 头部端点。
 * @param options 可选比例覆盖。
 * @returns 8 顶点闭合多边形;p1 与 p2 重合时返回空数组。
 */
export function createAssaultDirectionArrow(
	p1: LonLatPoint,
	p2: LonLatPoint,
	options: AssaultDirectionArrowOptions = {},
): ArrowPolygon {
	return createArrowInLocalMeterPlane(
		[ p1, p2 ],
		( localPoints ) => createAssaultDirectionArrowLocal(
			localPoints[ 0 ],
			localPoints[ 1 ],
			options,
		),
	);
}

function createAssaultDirectionArrowLocal(
	p1: LonLatPoint,
	p2: LonLatPoint,
	options: AssaultDirectionArrowOptions = {},
): ArrowPolygon {
	const lengthScale = options.lengthScale ?? DEFAULT_LENGTH_SCALE;
	const tailWidthFactor = options.tailWidthFactor ?? DEFAULT_TAIL_WIDTH_FACTOR;
	const neckWidthFactor = options.neckWidthFactor ?? DEFAULT_NECK_WIDTH_FACTOR;
	const headWidthFactor = options.headWidthFactor ?? DEFAULT_HEAD_WIDTH_FACTOR;
	const headAngleRadians = options.headAngleRadians ?? DEFAULT_HEAD_ANGLE_RADIANS;
	const neckAngleRadians = options.neckAngleRadians ?? DEFAULT_NECK_ANGLE_RADIANS;

	const spineLen = mathDistance( p1, p2 );
	if ( spineLen <= 0.0 ) {
		return [];
	}

	// 基准长度放大 lengthScale 倍——只缩放所有宽度,不改变 p1 / p2 之间的距离。
	// 视觉上等效于"箭头看起来更修长",因为 head/neck/tail 同步变粗,而长度不变,
	// "宽 vs 长"比例下降。
	const baseLen = getBaseLength( [ p1, p2 ] ) * lengthScale;
	if ( baseLen <= 0.0 ) {
		return [];
	}

	const tailHalfWidth = baseLen * tailWidthFactor;
	const neckHalfWidth = baseLen * neckWidthFactor;
	const headHalfWidth = baseLen * headWidthFactor;

	// ── 脊线基:spineDir + perp_CCW ──
	const spineDirX = ( p2[ 0 ] - p1[ 0 ] ) / spineLen;
	const spineDirY = ( p2[ 1 ] - p1[ 1 ] ) / spineLen;
	const perpX = - spineDirY;
	const perpY = spineDirX;

	// ── 颈 / 翼的"轴 + 法向"偏移 ──
	const neckBack = Math.cos( neckAngleRadians ) * neckHalfWidth;
	const neckSide = Math.sin( neckAngleRadians ) * neckHalfWidth;
	const headBack = Math.cos( headAngleRadians ) * headHalfWidth;
	const headSide = Math.sin( headAngleRadians ) * headHalfWidth;

	// ── 8 个 CCW 顶点:沿周界一笔走完 ──
	const tailRight: LonLatPoint = [
		p1[ 0 ] - perpX * tailHalfWidth,
		p1[ 1 ] - perpY * tailHalfWidth,
	];
	const neckRight: LonLatPoint = [
		p2[ 0 ] - spineDirX * neckBack - perpX * neckSide,
		p2[ 1 ] - spineDirY * neckBack - perpY * neckSide,
	];
	const headRight: LonLatPoint = [
		p2[ 0 ] - spineDirX * headBack - perpX * headSide,
		p2[ 1 ] - spineDirY * headBack - perpY * headSide,
	];
	const headLeft: LonLatPoint = [
		p2[ 0 ] - spineDirX * headBack + perpX * headSide,
		p2[ 1 ] - spineDirY * headBack + perpY * headSide,
	];
	const neckLeft: LonLatPoint = [
		p2[ 0 ] - spineDirX * neckBack + perpX * neckSide,
		p2[ 1 ] - spineDirY * neckBack + perpY * neckSide,
	];
	const tailLeft: LonLatPoint = [
		p1[ 0 ] + perpX * tailHalfWidth,
		p1[ 1 ] + perpY * tailHalfWidth,
	];

	const rawRing: LonLatPoint[] = [
		[ p1[ 0 ], p1[ 1 ] ],
		tailRight,
		neckRight,
		headRight,
		[ p2[ 0 ], p2[ 1 ] ],
		headLeft,
		neckLeft,
		tailLeft,
	];

	return finalizePolygon( rawRing );
}
