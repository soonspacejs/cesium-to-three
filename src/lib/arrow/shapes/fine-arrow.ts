// ============================================================
// arrow/shapes/fine-arrow.ts — 细箭头(2 点),单笔周界遍历
// 层级：L1(基于 arrow-geometry + arrow-polygon)
// 职责:由两个端点 p1(尾) 和 p2(头) 构造一个 8 顶点的填充箭头多边形:
//
//        tailLeft ─── neckLeft ── headLeft
//            │                       ╲
//           p1                       p2(尖端)
//            │                       ╱
//        tailRight ── neckRight ── headRight
//
//      尺寸由"基准长度"= |p1 p2|^0.99 派生,所有比例(尾宽、颈宽、翼展)
//      通过 FineArrowOptions 暴露给上层覆盖。
//
//      与早期"成对调用 getThirdPoint(clockwise=true/false) 计算镜像点"的
//      写法相比,本文件采用**单笔周界遍历**:先在 p1/p2 处确定脊线基(
//      spineDir + perp),然后**按 CCW 顺序逐顶点**计算位置,每个顶点都
//      是"以 p1 或 p2 为锚点 ± 沿脊线/法线的明确偏移"。
//
//      这样写的两个好处:
//        1. 不再有"左右两次调用同一个函数",代码读起来就是 CCW 走一圈,
//           视觉与执行顺序一致;
//        2. 每个 body 顶点之间的边天然位于"沿脊线 / 沿法线"两个轴向上,
//           下游 polygon-helpers.ts 的 centroid-径向外扩与"边垂直方向"
//           近似一致 → 描边带均匀,而不会沿体部抖动。
//
//      与原 cesium-plot-js 数学上等价(纯重组,顶点坐标完全相同),但更
//      贴合本项目的描边管线。
//
// 依赖:arrow-geometry.ts(mathDistance + getBaseLength),
//      arrow-polygon.ts(finalizePolygon),
//      arrow-types.ts(FineArrowOptions)。
// 被消费:arrow/index.ts、
//          arrow/shapes/attack-arrow.ts(2 控制点退化)、
//          arrow/shapes/swallowtail-attack-arrow.ts(2 控制点退化)。
// ============================================================

import {
	createArrowInLocalMeterPlane,
	getBaseLength,
	mathDistance,
} from '../arrow-geometry';
import { finalizePolygon } from '../arrow-polygon';
import type { ArrowPolygon, FineArrowOptions, LonLatPoint } from '../arrow-types';

// ── 默认值常量 ──
// 与 cesium-plot-js 完全一致,任何修改请同步更新 arrow-types.ts JSDoc。
const DEFAULT_TAIL_WIDTH_FACTOR = 0.10;
const DEFAULT_NECK_WIDTH_FACTOR = 0.20;
const DEFAULT_HEAD_WIDTH_FACTOR = 0.25;
// 翼展夹角 ≈ 21.18°,颈部夹角 ≈ 13.85°,视觉上呈"尖锐三角箭头"。
const DEFAULT_HEAD_ANGLE_RADIANS = Math.PI / 8.5;
const DEFAULT_NECK_ANGLE_RADIANS = Math.PI / 13.0;

/**
 * 生成细箭头多边形(单笔 CCW 周界遍历)。
 *
 * 几何步骤:
 *   1. 计算 spineDir = (p2 - p1) / |p2 - p1|;
 *      perp_CCW = ( -spineDir.y, spineDir.x )(在 +y 朝北的右手系下指向"逻辑左")。
 *   2. 基准长度 L = |p1 p2|^0.99,派生 tailHalfWidth / neckHalfWidth / headHalfWidth。
 *      每个 *HalfWidth 就是该处脊线到对应顶点的**垂直距离**(原版用 tailWidth/
 *      neckWidth/headWidth 命名,实际上都是 half-width)。
 *   3. 颈/翼的纵向位置(从 p2 向 p1 方向回退多少)= cos(angle) × halfWidth;
 *      横向位置(垂直脊线偏离多少)= sin(angle) × halfWidth。
 *   4. 按 CCW 顺序逐顶点排列 8 个点:
 *        p1 → tailRight → neckRight → headRight → p2 → headLeft → neckLeft → tailLeft
 *   5. 交给 finalizePolygon 去重 + CCW 校正 + 顶点上限 clamp。
 *
 * @param p1 尾部端点 [lon°, lat°]。
 * @param p2 头部端点(尖端)[lon°, lat°]。
 * @param options 可选比例覆盖。
 * @returns 8(去重后可能更少)顶点的闭合多边形;p1 与 p2 重合时返回空数组。
 */
export function createFineArrow(
	p1: LonLatPoint,
	p2: LonLatPoint,
	options: FineArrowOptions = {},
): ArrowPolygon {
	return createArrowInLocalMeterPlane(
		[ p1, p2 ],
		( localPoints ) => createFineArrowLocal(
			localPoints[ 0 ],
			localPoints[ 1 ],
			options,
		),
	);
}

function createFineArrowLocal(
	p1: LonLatPoint,
	p2: LonLatPoint,
	options: FineArrowOptions = {},
): ArrowPolygon {
	// widthScale:整体宽度倍率(调整箭头大小),clamp 到正数。
	const widthScale = Math.max( options.widthScale ?? 1.0, 1e-3 );
	const tailWidthFactor = ( options.tailWidthFactor ?? DEFAULT_TAIL_WIDTH_FACTOR ) * widthScale;
	const neckWidthFactor = ( options.neckWidthFactor ?? DEFAULT_NECK_WIDTH_FACTOR ) * widthScale;
	const headWidthFactor = ( options.headWidthFactor ?? DEFAULT_HEAD_WIDTH_FACTOR ) * widthScale;
	const headAngleRadians = options.headAngleRadians ?? DEFAULT_HEAD_ANGLE_RADIANS;
	const neckAngleRadians = options.neckAngleRadians ?? DEFAULT_NECK_ANGLE_RADIANS;

	const spineLen = mathDistance( p1, p2 );
	if ( spineLen <= 0.0 ) {
		// 两点重合:无方向可言,返回空让上层决定回退策略。
		return [];
	}

	const baseLen = getBaseLength( [ p1, p2 ] );
	if ( baseLen <= 0.0 ) {
		return [];
	}

	const tailHalfWidth = baseLen * tailWidthFactor;
	const neckHalfWidth = baseLen * neckWidthFactor;
	const headHalfWidth = baseLen * headWidthFactor;

	// ── 脊线基:spineDir + perp_CCW ──
	const spineDirX = ( p2[ 0 ] - p1[ 0 ] ) / spineLen;
	const spineDirY = ( p2[ 1 ] - p1[ 1 ] ) / spineLen;
	// perp_CCW = ( -spineDir.y, spineDir.x ) 是切线左手 90° 旋转,
	// 在经纬度 +y 朝北的右手系下指向"沿脊线行进方向的左侧"。
	const perpX = - spineDirY;
	const perpY = spineDirX;

	// ── 颈 / 翼的"轴 + 法向"偏移 ──
	// 颈点 = p2 + (-spineDir × cos × halfWidth) + (±perp × sin × halfWidth)
	// 即:从尖端 p2 沿脊线向尾部回退 cos(neckAngle)*neckHalfWidth,
	//     然后沿 perp 偏离 sin(neckAngle)*neckHalfWidth(左右取符号)。
	const neckBack = Math.cos( neckAngleRadians ) * neckHalfWidth;
	const neckSide = Math.sin( neckAngleRadians ) * neckHalfWidth;
	const headBack = Math.cos( headAngleRadians ) * headHalfWidth;
	const headSide = Math.sin( headAngleRadians ) * headHalfWidth;

	// ── 8 个 CCW 顶点:沿周界一笔走完,不再分左右两次镜像 ──
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
		[ p1[ 0 ], p1[ 1 ] ],     // 尾中(下方衔接 tailRight,上方衔接 tailLeft)
		tailRight,
		neckRight,
		headRight,
		[ p2[ 0 ], p2[ 1 ] ],     // 箭尖
		headLeft,
		neckLeft,
		tailLeft,
	];

	return finalizePolygon( rawRing );
}
