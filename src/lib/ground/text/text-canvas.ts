// ============================================================
// text-canvas.ts
// 层级：L2（依赖 text-color / text-layout）
// 职责：把 ResolvedPlotTextOptions 画到 canvas，4 层：框背景 → 框边框 →
//       字描边 → 字主体。该 canvas 作为贴地纹理源（CanvasTexture）。
//       超采样系数固定（非屏幕 DPR），改善贴地纹理斜视锐度。
// 依赖：text-types / text-color / text-layout。
// 被消费：text-primitive（建 / 更新纹理）。
// ============================================================

import { composeRgba } from './text-color';
import { layoutText, type MeasureText } from './text-layout';
import type { ResolvedPlotTextOptions, TextLayoutResult } from './text-types';

// 纹素超采样系数：物理 canvas = 逻辑纹素 × 此系数。
// 贴地纹理会被相机以各种距离 / 角度观察，2× 超采样 + C 层各向异性过滤
// 能显著减少斜视模糊；超过 2× 收益递减而显存翻倍。
const TEXEL_SUPERSAMPLE = 2.0;
// 单张标牌纹理边长上限（物理像素），防止超长内容撑爆显存 / 超过 GL 纹理上限。
const MAX_TEXTURE_DIMENSION = 4096;

/** paint 输出。 */
export interface PaintedTextCanvas {
	/** 已绘制的 canvas（物理像素 = 逻辑纹素 × supersample）。 */
	canvas: HTMLCanvasElement;
	/** 布局结果（box 尺寸单位为逻辑纹素，供足迹换算）。 */
	layout: TextLayoutResult;
	/** 实际超采样系数（可能因 MAX_TEXTURE_DIMENSION 被下调）。 */
	supersample: number;
}

/**
 * 把已解析配置渲染到 canvas。可传 reuseCanvas 复用句柄（setText 时不重建 texture）。
 *
 * 流程：先建 ctx 设字体 → 布局测量 → 定物理尺寸（含超采样、夹纹理上限）→
 * resize → scale → 重设字体 → 4 层绘制。
 *
 * @param options     已解析配置。
 * @param reuseCanvas 可选复用 canvas。
 * @returns           canvas + layout + 实际超采样系数。
 */
export function paintTextToCanvas(
	options: ResolvedPlotTextOptions,
	reuseCanvas?: HTMLCanvasElement | null,
): PaintedTextCanvas {
	if ( typeof document === 'undefined' ) {
		throw new Error( 'PlotText paint requires browser `document`.' );
	}
	const canvas = reuseCanvas ?? document.createElement( 'canvas' );

	// 步骤 A：先拿 ctx 设字体用于测量（measureText 必须在已设 font 的 ctx 上）
	const measureCtx = canvas.getContext( '2d' );
	if ( measureCtx === null ) {
		throw new Error( 'PlotText paint: failed to acquire 2D context.' );
	}
	applyFontToContext( measureCtx, options );
	// 度量须在已设 font + textBaseline='alphabetic' 的 ctx 上，actualBoundingBox*
	// 即相对 alphabetic 基线，与下方绘制的 baseline 设置一致。
	const measure: MeasureText = ( text ) => {
		const m = measureCtx.measureText( text );
		return {
			width: m.width,
			ascent: m.actualBoundingBoxAscent,
			descent: m.actualBoundingBoxDescent,
		};
	};
	const layout = layoutText( options, measure );

	// 步骤 B：物理尺寸 = 逻辑纹素 × 超采样，且不超过纹理上限（必要时下调系数）
	let supersample = TEXEL_SUPERSAMPLE;
	const maxLogicalDim = Math.max( layout.boxWidthCssPx, layout.boxHeightCssPx, 1.0 );
	if ( maxLogicalDim * supersample > MAX_TEXTURE_DIMENSION ) {
		supersample = MAX_TEXTURE_DIMENSION / maxLogicalDim;
	}
	const physicalWidth = Math.max( Math.ceil( layout.boxWidthCssPx * supersample ), 1 );
	const physicalHeight = Math.max( Math.ceil( layout.boxHeightCssPx * supersample ), 1 );
	if ( canvas.width !== physicalWidth ) {
		canvas.width = physicalWidth;
	}
	if ( canvas.height !== physicalHeight ) {
		canvas.height = physicalHeight;
	}

	const ctx = canvas.getContext( '2d' );
	if ( ctx === null ) {
		throw new Error( 'PlotText paint: failed to re-acquire 2D context after resize.' );
	}
	// resize 会清空 ctx 状态；显式复位变换 + 清屏
	ctx.setTransform( 1, 0, 0, 1, 0, 0 );
	ctx.clearRect( 0, 0, canvas.width, canvas.height );
	// 把逻辑纹素坐标映射到物理像素：后续按逻辑纹素绘制，实际写入超采样密度
	ctx.scale( supersample, supersample );
	applyFontToContext( ctx, options );

	// 步骤 C：4 层绘制
	paintBoxBackground( ctx, options, layout );
	paintBoxBorder( ctx, options, layout );
	paintTextStroke( ctx, options, layout );
	paintTextFill( ctx, options, layout );

	return { canvas, layout, supersample };
}

// ────────────────────────────────────────────────────────────
// 4 层
// ────────────────────────────────────────────────────────────

/** 绘制框背景（圆角）。 */
function paintBoxBackground(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
): void {
	if ( options.fillOpacity <= 0.0 ) {
		return;
	}
	ctx.beginPath();
	traceRoundedRect( ctx, 0.0, 0.0, layout.boxWidthCssPx, layout.boxHeightCssPx, options.cornerRadius );
	ctx.fillStyle = composeRgba( options.fillColor, options.fillOpacity );
	ctx.fill();
}

/** 绘制框边框（圆角，内缩 strokeWidth/2 使边框完全在框内）。 */
function paintBoxBorder(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
): void {
	if ( ! options.showBorder || options.strokeWidth <= 0.0 || options.strokeOpacity <= 0.0 ) {
		return;
	}
	// Canvas2D stroke 沿路径中心线，内缩 strokeWidth/2 让边框不溢出框外缘
	const half = options.strokeWidth / 2.0;
	ctx.beginPath();
	traceRoundedRect(
		ctx, half, half,
		layout.boxWidthCssPx - options.strokeWidth,
		layout.boxHeightCssPx - options.strokeWidth,
		Math.max( options.cornerRadius - half, 0.0 ),
	);
	ctx.lineWidth = options.strokeWidth;
	ctx.strokeStyle = composeRgba( options.strokeColor, options.strokeOpacity );
	ctx.stroke();
}

/** 绘制字描边（每字符 strokeText；先描后填使描边在外、字宽不变）。 */
function paintTextStroke(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
): void {
	if ( options.fontStrokeColor === null || options.fontStrokeWidth <= 0.0 || options.fontStrokeOpacity <= 0.0 ) {
		return;
	}
	// strokeText 也是中心线，× 2 得到对外可见的外描边宽度
	ctx.lineWidth = options.fontStrokeWidth * 2.0;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.miterLimit = 2.0;
	ctx.strokeStyle = composeRgba( options.fontStrokeColor, options.fontStrokeOpacity );
	withClipIfNeeded( ctx, options, layout, () => {
		for ( const c of layout.chars ) {
			ctx.strokeText( c.char, c.x, c.baselineY );
		}
	} );
}

/** 绘制字主体（每字符 fillText）。 */
function paintTextFill(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
): void {
	ctx.fillStyle = composeRgba( options.fontColor, 100.0 );
	withClipIfNeeded( ctx, options, layout, () => {
		for ( const c of layout.chars ) {
			ctx.fillText( c.char, c.x, c.baselineY );
		}
	} );
}

/** boxOverflow==='clip' 时把绘制限制在框内（save/restore 包裹避免污染外层）。 */
function withClipIfNeeded(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
	layout: TextLayoutResult,
	paint: () => void,
): void {
	if ( options.boxOverflow === 'visible' ) {
		paint();
		return;
	}
	ctx.save();
	ctx.beginPath();
	traceRoundedRect( ctx, 0.0, 0.0, layout.boxWidthCssPx, layout.boxHeightCssPx, options.cornerRadius );
	ctx.clip();
	paint();
	ctx.restore();
}

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────

/**
 * 在当前路径勾画圆角矩形（不 fill/stroke）。手写 arcTo 兜底老内核无 roundRect。
 *
 * @param ctx    上下文。
 * @param x      左上 x。
 * @param y      左上 y。
 * @param w      宽。
 * @param h      高。
 * @param radius 圆角半径（钳到 min(w,h)/2）。
 */
function traceRoundedRect(
	ctx: CanvasRenderingContext2D,
	x: number, y: number, w: number, h: number, radius: number,
): void {
	if ( w <= 0.0 || h <= 0.0 ) {
		return; // 退化尺寸：空 path，避免 arcTo 异常
	}
	const r = Math.min( Math.max( radius, 0.0 ), Math.min( w, h ) / 2.0 );
	if ( r === 0.0 ) {
		ctx.rect( x, y, w, h );
		return;
	}
	ctx.moveTo( x + r, y );
	ctx.lineTo( x + w - r, y );
	ctx.arcTo( x + w, y, x + w, y + r, r );
	ctx.lineTo( x + w, y + h - r );
	ctx.arcTo( x + w, y + h, x + w - r, y + h, r );
	ctx.lineTo( x + r, y + h );
	ctx.arcTo( x, y + h, x, y + h - r, r );
	ctx.lineTo( x, y + r );
	ctx.arcTo( x, y, x + r, y, r );
	ctx.closePath();
}

/**
 * 设 ctx.font + baseline。baseline 固定 'alphabetic'，与布局按真实墨迹算出的基线配合。
 *
 * @param ctx     上下文。
 * @param options 已解析配置。
 */
function applyFontToContext(
	ctx: CanvasRenderingContext2D,
	options: ResolvedPlotTextOptions,
): void {
	const weight = typeof options.fontWeight === 'number'
		? String( options.fontWeight )
		: options.fontWeight;
	ctx.font = `${ weight } ${ options.fontSize }px ${ options.fontFamily }`;
	ctx.textBaseline = 'alphabetic';
	ctx.textAlign = 'left';
}
