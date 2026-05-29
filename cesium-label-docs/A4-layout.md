# A4 · `text-layout.ts` —— 布局算法

> [← A3-color](./A3-color.md) | [A5-canvas →](./A5-canvas.md)

## 职责

`content` + 字宽测量回调 → 每字符在 canvas 局部坐标（纹素像素，原点左上、Y 向下）的基线位置。横排 + 竖排（vertical-rl / vertical-lr）统一产出 `PlacedChar[]`。纯函数，不直接调 `ctx.measureText`，注入 `measureChar` 便于单测。贴地与否对本层零影响——它只管把字摆进纹理。

## 完整源码

```typescript
// ============================================================
// text-layout.ts
// 层级：L1（纯函数，无 DOM / 无 Three.js）
// 职责：content + 字宽回调 → 每字符在 canvas 局部坐标（纹素像素，原点左上、
//       Y 向下）的基线位置。横排 / 竖排统一产出 PlacedChar[]。
//       注入 measureChar 回调，便于单测时塞虚拟度量。
// 依赖：text-types。
// 被消费：text-canvas。
// ============================================================

import type {
	PlacedChar,
	ResolvedPlotTextOptions,
	TextLayoutResult,
} from './text-types';

/**
 * 字符宽度测量回调。真实实现 `(s) => ctx.measureText(s).width`；
 * 单测可注入固定宽度函数。
 *
 * @param char 单字符（可能 surrogate pair）。
 * @returns    advance 宽（纹素像素，按 caller 的 ctx.font）。
 */
export type MeasureCharWidth = ( char: string ) => number;

// 基线占比：fontSize 视作 ascent+descent 近似和，基线放在行内 80% 处。
// 经验值，匹配 Canvas2D 'alphabetic' baseline 下大多数中英文字体观感。
const ASCENT_RATIO = 0.8;

/**
 * 布局主入口：按 layoutDirection 分发。
 *
 * @param options     已解析配置。
 * @param measureChar 字宽测量回调（ctx.font 须已设置好）。
 * @returns           box 尺寸（纹素像素）+ 字符位置数组。
 */
export function layoutText(
	options: ResolvedPlotTextOptions,
	measureChar: MeasureCharWidth,
): TextLayoutResult {
	if ( options.layoutDirection === 'horizontal' ) {
		return layoutHorizontal( options, measureChar );
	}
	return layoutVertical( options, measureChar );
}

// ────────────────────────────────────────────────────────────
// 横排
// ────────────────────────────────────────────────────────────

/**
 * 横排：每行（\n 切）从左到右；行高 = fontSize × lineHeight；行内按 textAlign；
 * 整体按 verticalAlign；letterSpacing 加在每字符 advance 后（末字符不加）。
 */
function layoutHorizontal(
	options: ResolvedPlotTextOptions,
	measureChar: MeasureCharWidth,
): TextLayoutResult {
	const lineHeightPx = options.fontSize * options.lineHeight;
	const ascentPx = options.fontSize * ASCENT_RATIO;
	const lines = options.content.split( '\n' );

	// 第 1 步：逐行测量字符行内相对 x
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
			cursor += measureChar( ch );
			if ( i < charArr.length - 1 ) {
				cursor += options.letterSpacing;
			}
		}
		measured.push( { chars: lineChars, lineWidth: cursor } );
	}

	// 第 2 步：box 尺寸（自适应 vs 固定）
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

	// 第 3 步：垂直对齐起点（多行块顶 y）
	const blockTopY = innerYStartForBlock(
		options.verticalAlign, innerHeight, naturalContentHeight, options.paddingTop,
	);

	// 第 4 步：摊字符
	const chars: PlacedChar[] = [];
	for ( let li = 0; li < measured.length; li ++ ) {
		const line = measured[ li ];
		const lineLeftX = innerXStartForBlock(
			options.textAlign, innerWidth, line.lineWidth, options.paddingLeft,
		);
		const baselineY = blockTopY + li * lineHeightPx + ascentPx;
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
	measureChar: MeasureCharWidth,
): TextLayoutResult {
	const cellHeightPx = options.fontSize * options.lineHeight;
	const cellWidthPx = options.fontSize;
	const ascentPx = options.fontSize * ASCENT_RATIO;
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

	// 第 4 步：摊每列字符
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
			const charAdvance = measureChar( ch );
			// 西文窄字符水平居中到 cellWidth 中线
			const charLeftX = columnLeftX + ( cellWidthPx - charAdvance ) / 2.0;
			const baselineY =
				columnTopY + i * ( cellHeightPx + options.letterSpacing ) + ascentPx;
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
 * @param blockHeight 块自身高。
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
```

## 单元测试建议

注入 `measureChar = ch => /[\u4e00-\u9fff]/.test(ch) ? 16 : 8`。覆盖：单行/多行横排 box 宽（最长行决定）；三种 textAlign 行起 x；三种 verticalAlign 首行 baselineY；padding 单值/四元组；固定 boxWidth 不自适应；`'A𠀀B'` → `chars.length===3`；letterSpacing 累加；单列/双列竖排 rl/lr 列序；空行占位。

## 边界

自动换行（word-wrap）未实现：固定 boxWidth 超宽由 canvas 层 `ctx.clip` 裁剪。需要时在第 1 步后插入贪心折行。BiDi 未实现。CJK 竖排标点位置（句号偏右下）未实现。

---

[← A3-color](./A3-color.md) | [A5-canvas →](./A5-canvas.md)
