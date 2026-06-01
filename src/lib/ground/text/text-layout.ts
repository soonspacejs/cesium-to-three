// ============================================================
// text-layout.ts
// 层级：L1（纯函数，无 DOM / 无 Three.js）
// 职责：content + 度量回调 → 每字符在 canvas 局部坐标（纹素像素，原点左上、
//       Y 向下）的基线位置。纵向按真实墨迹(actualBoundingBox*)视觉居中。
//       横排 / 竖排统一产出 PlacedChar[]。注入 measure 回调便于单测塞虚拟度量。
// 依赖：text-types。
// 被消费：text-canvas。
// ============================================================

import type {
	PlacedChar,
	ResolvedPlotTextOptions,
	TextLayoutResult,
} from './text-types';

/**
 * 文本度量回调。真实实现包一层 `ctx.measureText(s)`，返回 advance 宽与真实墨迹
 * 相对 alphabetic 基线的上 / 下伸量。单测可注入固定度量。
 *
 * @param text 待测文本（单字符或整行；surrogate pair 由 caller 按 code point 切好）。
 * @returns    advance 宽 + 墨迹 ascent/descent（纹素像素，按 caller 的 ctx.font）。
 */
export type MeasureText = ( text: string ) => MeasuredText;

/** measureText 的精简产物：水平 advance + 垂直墨迹边界（相对 alphabetic 基线）。 */
export interface MeasuredText {
	/** advance 宽（纹素像素）。 */
	width: number;
	/** 基线到墨迹顶的距离（actualBoundingBoxAscent，正常 >= 0）。 */
	ascent: number;
	/** 基线到墨迹底的距离（actualBoundingBoxDescent，无下伸部时为 0）。 */
	descent: number;
}

// 墨迹度量缺失时（空行 / 纯空格 / 老内核无 actualBoundingBox*）的回退占比：
// 把 fontSize 视作 ascent+descent，基线放在行内 80% 处。仅兜底，正常走真实墨迹。
const ASCENT_RATIO = 0.8;
const DESCENT_RATIO = 0.2;

/**
 * 把一次度量结果解析为非负墨迹 ascent/descent；无墨迹（空行 / 纯空格）或度量不
 * 可用时回退到字号比例，保证占位与基线稳定。descent 正常可为 0（无下伸部）。
 *
 * @param m        一次 measure 的产物。
 * @param fontSize 字号（回退用）。
 * @returns        非负 ascent/descent（纹素像素）。
 */
function resolveInk(
	m: MeasuredText,
	fontSize: number,
): { ascent: number; descent: number } {
	const a = m.ascent;
	const d = m.descent;
	// 两者皆缺或皆 <= 0（空行 / 纯空格）→ 回退；否则用真实墨迹
	if ( ! Number.isFinite( a ) || ! Number.isFinite( d ) || ( a <= 0.0 && d <= 0.0 ) ) {
		return { ascent: fontSize * ASCENT_RATIO, descent: fontSize * DESCENT_RATIO };
	}
	return { ascent: Math.max( a, 0.0 ), descent: Math.max( d, 0.0 ) };
}

/**
 * 布局主入口：按 layoutDirection 分发。
 *
 * @param options 已解析配置。
 * @param measure 文本度量回调（ctx.font 须已设置好）。
 * @returns       box 尺寸（纹素像素）+ 字符位置数组。
 */
export function layoutText(
	options: ResolvedPlotTextOptions,
	measure: MeasureText,
): TextLayoutResult {
	if ( options.layoutDirection === 'horizontal' ) {
		return layoutHorizontal( options, measure );
	}
	return layoutVertical( options, measure );
}

// ────────────────────────────────────────────────────────────
// 横排
// ────────────────────────────────────────────────────────────

/**
 * 横排：每行（\n 切）从左到右；行距 = fontSize × lineHeight；行内按 textAlign；
 * letterSpacing 加在每字符 advance 后（末字符不加）。
 *
 * 纵向：按真实墨迹视觉居中（而非行盒居中）。框高仍按「行距 × 行数 + padding」
 * 保持尺寸稳定不随内容抖动，但 verticalAlign 定位的是「墨迹块」——首行 ascent
 * 到末行 descent 的真实墨迹范围。这样「Plot @ km scale」这类无下伸部的单行文字
 * 不再因预留的行距 / 下伸空间而显得偏上。
 */
function layoutHorizontal(
	options: ResolvedPlotTextOptions,
	measure: MeasureText,
): TextLayoutResult {
	const lineHeightPx = options.fontSize * options.lineHeight;
	const lines = options.content.split( '\n' );

	// 第 1 步：逐行测量字符行内相对 x（measure(ch).width 取 advance）
	interface MeasuredLine {
		chars: { char: string; xWithinLine: number }[];
		lineWidth: number;
	}
	const measured: MeasuredLine[] = [];
	for ( let li = 0; li < lines.length; li ++ ) {
		// Array.from 按 code point 切，避免拆碎 surrogate pair（如 𠀀）
		const charArr = Array.from( lines[ li ] );
		const lineChars: { char: string; xWithinLine: number }[] = [];
		let cursor = 0.0;
		for ( let i = 0; i < charArr.length; i ++ ) {
			const ch = charArr[ i ];
			lineChars.push( { char: ch, xWithinLine: cursor } );
			cursor += measure( ch ).width;
			if ( i < charArr.length - 1 ) {
				cursor += options.letterSpacing;
			}
		}
		measured.push( { chars: lineChars, lineWidth: cursor } );
	}

	// 第 2 步：box 尺寸（自适应 vs 固定）。高度仍按行盒 × 行数，框尺寸稳定
	const padLR = options.paddingLeft + options.paddingRight;
	const padTB = options.paddingTop + options.paddingBottom;
	const naturalContentWidth = measured.reduce(
		( max, line ) => Math.max( max, line.lineWidth ), 0.0,
	);
	const naturalContentHeight = lineHeightPx * lines.length;
	const boxWidth = options.boxWidthCssPx ?? naturalContentWidth + padLR;
	const boxHeight = options.boxHeightCssPx ?? naturalContentHeight + padTB;
	const innerWidth = Math.max( boxWidth - padLR, 0.0 );
	const innerHeight = Math.max( boxHeight - padTB, 0.0 );

	// 第 3 步：纵向按真实墨迹居中。墨迹块高 = 首行 ascent + 末行 descent +
	// 中间 (n−1) 个行距步进；innerYStartForBlock 在这里定位的是墨迹块上缘。
	const firstInk = resolveInk( measure( lines[ 0 ] ), options.fontSize );
	const lastInk = resolveInk(
		measure( lines[ lines.length - 1 ] ), options.fontSize,
	);
	const inkBlockHeight =
		( lines.length - 1 ) * lineHeightPx + firstInk.ascent + lastInk.descent;
	const inkTopY = innerYStartForBlock(
		options.verticalAlign, innerHeight, inkBlockHeight, options.paddingTop,
	);
	const firstBaselineY = inkTopY + firstInk.ascent;

	// 第 4 步：摊字符（行距仍按行盒步进，保证多行间距一致）
	const chars: PlacedChar[] = [];
	for ( let li = 0; li < measured.length; li ++ ) {
		const line = measured[ li ];
		const lineLeftX = innerXStartForBlock(
			options.textAlign, innerWidth, line.lineWidth, options.paddingLeft,
		);
		const baselineY = firstBaselineY + li * lineHeightPx;
		for ( const c of line.chars ) {
			chars.push( { char: c.char, x: lineLeftX + c.xWithinLine, baselineY } );
		}
	}

	return { boxWidthCssPx: boxWidth, boxHeightCssPx: boxHeight, chars };
}

// ────────────────────────────────────────────────────────────
// 竖排
// ────────────────────────────────────────────────────────────

/**
 * 竖排（vertical-rl / vertical-lr）：\n 换列；列内自上而下，单元高 =
 * fontSize × lineHeight；列宽 = fontSize（CJK 等宽假设，西文居中到列中线）；
 * rl 第 0 列在右、lr 第 0 列在左；textAlign 控整组列水平对齐，verticalAlign
 * 控每列垂直对齐。
 */
function layoutVertical(
	options: ResolvedPlotTextOptions,
	measure: MeasureText,
): TextLayoutResult {
	const cellHeightPx = options.fontSize * options.lineHeight;
	const cellWidthPx = options.fontSize;
	const columns = options.content.split( '\n' );

	// 第 1 步：列字符 + 列高
	interface MeasuredColumn {
		chars: string[];
		columnHeight: number;
	}
	const measured: MeasuredColumn[] = columns.map( ( col ) => {
		const charArr = Array.from( col );
		const n = charArr.length;
		const h = n === 0
			? 0.0
			: n * cellHeightPx + Math.max( n - 1, 0 ) * options.letterSpacing;
		return { chars: charArr, columnHeight: h };
	} );

	// 第 2 步：box 尺寸
	const padLR = options.paddingLeft + options.paddingRight;
	const padTB = options.paddingTop + options.paddingBottom;
	const naturalContentWidth = columns.length * cellWidthPx;
	const naturalContentHeight = measured.reduce(
		( max, col ) => Math.max( max, col.columnHeight ), 0.0,
	);
	const boxWidth = options.boxWidthCssPx ?? naturalContentWidth + padLR;
	const boxHeight = options.boxHeightCssPx ?? naturalContentHeight + padTB;
	const innerWidth = Math.max( boxWidth - padLR, 0.0 );
	const innerHeight = Math.max( boxHeight - padTB, 0.0 );

	// 第 3 步：列方向与整组起点 x
	const rightToLeft = options.layoutDirection === 'vertical-rl';
	const columnsTotalWidth = columns.length * cellWidthPx;
	const groupLeftX = innerXStartForBlock(
		options.textAlign, innerWidth, columnsTotalWidth, options.paddingLeft,
	);

	// 第 4 步：摊每列字符（每字按真实墨迹在 cell 内垂直居中、水平居中到列中线）
	const chars: PlacedChar[] = [];
	for ( let ci = 0; ci < measured.length; ci ++ ) {
		const col = measured[ ci ];
		// rl：第 0 列最右；lr：第 0 列最左
		const columnLeftX = rightToLeft
			? groupLeftX + ( columns.length - 1 - ci ) * cellWidthPx
			: groupLeftX + ci * cellWidthPx;
		const columnTopY = innerYStartForBlock(
			options.verticalAlign, innerHeight, col.columnHeight, options.paddingTop,
		);
		for ( let i = 0; i < col.chars.length; i ++ ) {
			const ch = col.chars[ i ];
			const m = measure( ch );
			const ink = resolveInk( m, options.fontSize );
			// 西文窄字符水平居中到 cellWidth 中线
			const charLeftX = columnLeftX + ( cellWidthPx - m.width ) / 2.0;
			// 墨迹在 cell 高度内垂直居中：cell 顶 + 居中留白 + 该字 ascent = 基线
			const cellTopY = columnTopY + i * ( cellHeightPx + options.letterSpacing );
			const baselineY =
				cellTopY + ( cellHeightPx - ( ink.ascent + ink.descent ) ) / 2.0 + ink.ascent;
			chars.push( { char: ch, x: charLeftX, baselineY } );
		}
	}

	return { boxWidthCssPx: boxWidth, boxHeightCssPx: boxHeight, chars };
}

// ────────────────────────────────────────────────────────────
// 对齐工具（横排竖排共用）
// ────────────────────────────────────────────────────────────

/**
 * 一个块在内边距空间内的水平起点 x（左缘）。横排=一行，竖排=整组列。
 *
 * @param align      水平对齐。
 * @param innerWidth 内容区宽（box − padLR）。
 * @param blockWidth 块自身宽。
 * @param padLeft    左内边距。
 * @returns          纹素像素 x。
 */
function innerXStartForBlock(
	align: 'left' | 'center' | 'right',
	innerWidth: number,
	blockWidth: number,
	padLeft: number,
): number {
	if ( align === 'left' ) {
		return padLeft;
	}
	if ( align === 'right' ) {
		return padLeft + innerWidth - blockWidth;
	}
	return padLeft + ( innerWidth - blockWidth ) / 2.0;
}

/**
 * 一个块在内边距空间内的垂直起点 y（上缘，Y 向下）。
 *
 * @param align       垂直对齐。
 * @param innerHeight 内容区高（box − padTB）。
 * @param blockHeight 块自身高（横排=墨迹块高，竖排=列高）。
 * @param padTop      上内边距。
 * @returns           纹素像素 y。
 */
function innerYStartForBlock(
	align: 'top' | 'middle' | 'bottom',
	innerHeight: number,
	blockHeight: number,
	padTop: number,
): number {
	if ( align === 'top' ) {
		return padTop;
	}
	if ( align === 'bottom' ) {
		return padTop + innerHeight - blockHeight;
	}
	return padTop + ( innerHeight - blockHeight ) / 2.0;
}
