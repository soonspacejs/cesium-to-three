// ============================================================
// text-placement.ts
// 层级：L2（依赖 L0 math 助手 + L0 类型）
// 职责：把纹理逻辑尺寸 + anchor/offset/rotation/metersPerPixel 翻译成地面上
//       带旋转的矩形足迹 4 个 ECEF 角点(文字空间 SW/SE/NW/NE)。这是贴地文本
//       独有层。下游 text-construct-extruded 建几何、text-extents 算 uv 基。
// 依赖：Three.js Matrix4/Vector3、math/cartographic、math/ellipsoid、
//      math/enu-frame、math/matrix4-helpers、text-types。
// 被消费：text-primitive(构造 / setText 时算足迹) → 传给 C 层。
// ============================================================

import { Matrix4, Vector3 } from 'three';

import { computeTexturedDecalFootprint } from '../textured-decal';
import type { ResolvedPlotTextOptions, TextLayoutResult } from './text-types';

/** 足迹结果：4 个 ECEF 角点(文字空间) + 米尺寸 + ENU 矩阵(供复用)。 */
export interface TextFootprint {
	/** 文字左下角 ECEF（uv 原点，uv=(0,0)）。 */
	swEcef: Vector3;
	/** 文字右下角 ECEF（uv=(1,0)）。 */
	seEcef: Vector3;
	/** 文字左上角 ECEF（uv=(0,1)）。 */
	nwEcef: Vector3;
	/** 文字右上角 ECEF（uv=(1,1)）。 */
	neEcef: Vector3;
	/** 足迹宽（米，= eastward 模长）。 */
	footprintWidthMeters: number;
	/** 足迹高（米，= northward 模长）。 */
	footprintHeightMeters: number;
	/** 锚点 ENU→ECEF 4×4（下游若需可复用）。 */
	enuToEcef: Matrix4;
}

/**
 * 计算贴地文本的地面足迹 4 角点（ECEF）。
 *
 * 算法见 cesium-label-docs/B1-placement.md。角点取在锚点 ENU 切平面 z=0，
 * 经 anchor 对齐偏移(box-local) → 地平面旋转(俯视顺时针) → 全局米偏移(ENU) →
 * enuToEcef 变换。
 *
 * @param options 已解析配置（提供 anchor / anchorX/Y / offset / rotation /
 *                metersPerPixel）。
 * @param layout  A 层布局结果（提供逻辑纹素 box 尺寸）。
 * @returns       4 个 ECEF 角点 + 米尺寸 + enuToEcef（角点均为新建 Vector3，
 *                可安全长期持有）。
 */
export function computeTextFootprint(
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
): TextFootprint {
	// ── §1 足迹米尺寸 ──
	const footprintWidth = layout.boxWidthCssPx * options.metersPerPixel;
	const footprintHeight = layout.boxHeightCssPx * options.metersPerPixel;
	const hw = footprintWidth / 2.0;
	const hh = footprintHeight / 2.0;

	// ── §3 anchor 对齐:盒子中心相对锚点的 box-local 偏移 ──
	const cx = anchorXToCenterOffset( options.anchorX, hw );
	const cy = anchorYToCenterOffset( options.anchorY, hh );

	// ── §2 + §4 + §5 ──
	// 通用贴花能力按 SW/SE/NW/NE 顺序执行：box-local 角点 → 俯视顺时针旋转
	// → 叠加 ENU 全局米偏移 → ECEF。文字只保留布局和 anchor 对齐职责。
	return computeTexturedDecalFootprint( {
		anchorLonDegrees: options.anchorLonDegrees,
		anchorLatDegrees: options.anchorLatDegrees,
		widthMeters: footprintWidth,
		heightMeters: footprintHeight,
		rotationRadians: options.rotationRadians,
		centerLocalEastMeters: cx,
		centerLocalNorthMeters: cy,
		offsetEastMeters: options.offsetEastMeters,
		offsetNorthMeters: options.offsetNorthMeters,
	} );
}

/**
 * anchorX → 盒子中心相对锚点的 box-local x 偏移（米）。
 * 'left' 锚点在框左缘 → 中心在 +hw；'right' → −hw；'center' → 0。
 *
 * @param anchorX 水平锚点对齐。
 * @param hw      半宽（米）。
 * @returns       box-local x 偏移。
 */
function anchorXToCenterOffset(
	anchorX: ResolvedPlotTextOptions[ 'anchorX' ],
	hw: number,
): number {
	if ( anchorX === 'left' ) {
		return hw;
	}
	if ( anchorX === 'right' ) {
		return -hw;
	}
	return 0.0;
}

/**
 * anchorY → 盒子中心相对锚点的 box-local y 偏移（米）。
 * 'top' 锚点在框顶缘 → 中心在 −hh（下）；'bottom' → +hh（上）；'middle' → 0。
 *
 * @param anchorY 垂直锚点对齐。
 * @param hh      半高（米）。
 * @returns       box-local y 偏移。
 */
function anchorYToCenterOffset(
	anchorY: ResolvedPlotTextOptions[ 'anchorY' ],
	hh: number,
): number {
	if ( anchorY === 'top' ) {
		return -hh;
	}
	if ( anchorY === 'bottom' ) {
		return hh;
	}
	return 0.0;
}
