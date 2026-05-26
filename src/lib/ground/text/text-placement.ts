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

import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
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

// 模块级 scratch：每次 compute 复用，避免堆分配（高频 setText 友好）。
const _anchorCarto = createCartographic();
const _anchorEcef = new Vector3();
const _enuToEcef = new Matrix4();
const _scratchEnu = new Vector3();

const DEG_TO_RAD = Math.PI / 180.0;

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

	// ── §5 锚点 → ECEF → ENU 矩阵 ──
	_anchorCarto.longitude = options.anchorLonDegrees * DEG_TO_RAD;
	_anchorCarto.latitude = options.anchorLatDegrees * DEG_TO_RAD;
	_anchorCarto.height = 0.0;
	cartographicToCartesian( _anchorCarto, _anchorEcef );
	eastNorthUpToFixedFrame( _anchorEcef, _enuToEcef );

	// ── §4 旋转角(弧度) ──
	const alpha = options.rotationRadians; // 已是弧度，北向顺时针
	const cosA = Math.cos( alpha );
	const sinA = Math.sin( alpha );

	// ── §2 + §4 + §5 逐角点:box-local 角点 → 旋转 → +ENU 偏移 → ECEF ──
	// 4 角的 box-local（相对盒子中心）符号表，顺序固定 SW/SE/NW/NE。
	const swEcef = cornerToEcef( cx - hw, cy - hh, cosA, sinA, options );
	const seEcef = cornerToEcef( cx + hw, cy - hh, cosA, sinA, options );
	const nwEcef = cornerToEcef( cx - hw, cy + hh, cosA, sinA, options );
	const neEcef = cornerToEcef( cx + hw, cy + hh, cosA, sinA, options );

	return {
		swEcef,
		seEcef,
		nwEcef,
		neEcef,
		footprintWidthMeters: footprintWidth,
		footprintHeightMeters: footprintHeight,
		enuToEcef: _enuToEcef.clone(),
	};
}

/**
 * 单个 box-local 角点 → ECEF。
 *
 * 步骤：俯视顺时针旋转 rotateCW → 叠加 ENU 全局米偏移 → enuToEcef 变换。
 * 使用模块级 _enuToEcef 与 _scratchEnu，但返回**新建** Vector3（下游持有）。
 *
 * @param localX   box-local x（相对锚点，含对齐偏移），单位米。
 * @param localY   box-local y，单位米。
 * @param cosA     cos(rotation)。
 * @param sinA     sin(rotation)。
 * @param options  提供 ENU 全局米偏移。
 * @returns        新建 ECEF Vector3。
 */
function cornerToEcef(
	localX: number,
	localY: number,
	cosA: number,
	sinA: number,
	options: ResolvedPlotTextOptions,
): Vector3 {
	// rotateCW(vx,vy,α) = ( vx·cosα + vy·sinα, −vx·sinα + vy·cosα )
	const rotatedEast = localX * cosA + localY * sinA;
	const rotatedNorth = -localX * sinA + localY * cosA;

	// 全局米偏移在 ENU 系（不随旋转），z=0 落在切平面
	_scratchEnu.set(
		rotatedEast + options.offsetEastMeters,
		rotatedNorth + options.offsetNorthMeters,
		0.0,
	);

	const out = new Vector3();
	matrix4MultiplyByPoint( _enuToEcef, _scratchEnu, out );
	return out;
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
