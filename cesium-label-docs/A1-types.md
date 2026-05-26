# A1 · `text-types.ts` —— 类型定义

> [← README](./README.md) | [A2-defaults →](./A2-defaults.md)

## 职责

文字标绘全模块的类型底座。定义对外 `PlotTextOptions`、解析后不可变的 `ResolvedPlotTextOptions`，以及布局产物 `PlacedChar` / `TextLayoutResult`。纯类型，不引入 Three.js，可被任意环境 import。

贴地语义下与 Sprite 版的差别：尺寸字段分两类——**纹素像素**（`fontSize / boxWidth / boxHeight / padding`，决定纹理内部）与**地面米**（`metersPerPixel / offsetEastMeters / offsetNorthMeters`，决定足迹）。`rotation` 是地平面内角度。删除了 Sprite 专属的 `scale / depthTest / renderOrder` 中与屏幕相关的语义（renderOrder 保留，含义是 classification 命令块顺序）。

## 完整源码

```typescript
// ============================================================
// text-types.ts
// 层级：L0（零依赖类型底座）
// 职责：定义贴地文本标绘的公开选项 PlotTextOptions、解析后不可变配置
//       ResolvedPlotTextOptions、布局产物 PlacedChar / TextLayoutResult。
//       区分「纹素像素」与「地面米」两套单位，下游模块只消费 Resolved 形态。
// 依赖：ground/types 的 LonLatPoint（re-export 给文字子模块用）。
// 被消费：text-defaults / text-layout / text-canvas / text-placement /
//        text-extents / text-primitive。
// ============================================================

import type { LonLatPoint } from '../types';

export type { LonLatPoint };

export type PlotTextAlign = 'left' | 'center' | 'right';
export type PlotTextVerticalAlign = 'top' | 'middle' | 'bottom';
export type PlotTextAnchorX = 'left' | 'center' | 'right';
export type PlotTextAnchorY = 'top' | 'middle' | 'bottom';
export type PlotTextLayoutDirection = 'horizontal' | 'vertical-rl' | 'vertical-lr';
export type PlotTextBoxOverflow = 'clip' | 'visible';

/**
 * 贴地文本标绘外部传入选项。
 *
 * 单位约定：
 *   - 「纹素像素」：content 排版用，决定纹理内部清晰度（fontSize / boxWidth /
 *      boxHeight / padding / strokeWidth / fontStrokeWidth / cornerRadius /
 *      lineHeight 系数 / letterSpacing）。
 *   - 「地面米」：决定贴地足迹（metersPerPixel / offsetEastMeters /
 *      offsetNorthMeters）。
 *   - 地面足迹宽 = 纹理 CSS 像素宽 × metersPerPixel（高同理）。
 *   - rotation：地平面内旋转，度，北向顺时针为正。
 */
export interface PlotTextOptions {
	/** lon/lat 度锚点；文本只用 points[ 0 ]。 */
	points: LonLatPoint[];

	/** 文本内容，`\n` 在横排是换行、竖排是换列。 */
	content: string;

	// ── 文字外观（纹理内部） ──

	/** 字色，CSS 颜色字符串。 */
	fontColor: string;
	/** 字号，纹素像素，> 0。 */
	fontSize: number;
	/** 字体族，默认 'sans-serif'。 */
	fontFamily?: string;
	/** 字重，默认 'normal'。 */
	fontWeight?: 'normal' | 'bold' | number;
	/** 字描边颜色；不传则不描边。 */
	fontStrokeColor?: string;
	/** 字描边宽度，纹素像素，默认 0。 */
	fontStrokeWidth?: number;
	/** 字描边不透明度 0..100，默认 100。 */
	fontStrokeOpacity?: number;
	/** 行高倍率（CSS line-height 语义），默认 1.2。 */
	lineHeight?: number;
	/** 字间距，纹素像素，默认 0。 */
	letterSpacing?: number;

	// ── 输入框（纹理内部） ──

	/** 框背景色，CSS 颜色字符串。 */
	fillColor: string;
	/** 框背景不透明度 0..100。 */
	fillOpacity: number;
	/** 是否显示框边框，默认 true。 */
	showBorder?: boolean;
	/** 框边框色。 */
	strokeColor: string;
	/** 框边框宽度，纹素像素。 */
	strokeWidth: number;
	/** 框边框不透明度 0..100。 */
	strokeOpacity: number;
	/** 框圆角，纹素像素，默认 0。 */
	cornerRadius?: number;
	/** 内边距：单值或 [top, right, bottom, left]，纹素像素。 */
	padding?: number | [ number, number, number, number ];

	// ── 排版（纹理内部） ──

	/** 文字相对框水平对齐，默认 'left'。 */
	textAlign?: PlotTextAlign;
	/** 文字相对框垂直对齐，默认 'middle'。 */
	verticalAlign?: PlotTextVerticalAlign;
	/** 固定框宽（纹素像素）；不给则按内容自适应。 */
	boxWidth?: number;
	/** 固定框高（纹素像素）；不给则按内容自适应。 */
	boxHeight?: number;
	/** 溢出处理，默认 'clip'。 */
	boxOverflow?: PlotTextBoxOverflow;
	/** 排版方向，默认 'horizontal'。 */
	layoutDirection?: PlotTextLayoutDirection;

	// ── 贴地摆放（地面米 / 地平面角度） ──

	/** 每纹素对应地面米数，默认 1.0（即 1 纹素 = 1 米足迹）。 */
	metersPerPixel?: number;
	/** 足迹相对锚点水平对齐，默认 'center'。 */
	anchorX?: PlotTextAnchorX;
	/** 足迹相对锚点垂直对齐，默认 'middle'。 */
	anchorY?: PlotTextAnchorY;
	/** ENU 东向米偏移，默认 0（向东为正）。 */
	offsetEastMeters?: number;
	/** ENU 北向米偏移，默认 0（向北为正）。 */
	offsetNorthMeters?: number;
	/** 地平面内旋转，度，北向顺时针为正，默认 0。 */
	rotation?: number;

	// ── 渲染 ──

	/** 是否参与渲染，默认 true。 */
	visible?: boolean;
	/** classification 命令块基序，默认 10。 */
	renderOrder?: number;
	/** shadow volume 顶/底高度（米），可选。 */
	minimumHeight?: number;
	maximumHeight?: number;
}

/**
 * 解析后的不可变配置。所有可选项已填默认值；
 * 不透明度统一保留 0..100；rotation 转弧度；padding 拆四元组。
 */
export interface ResolvedPlotTextOptions {
	anchorLonDegrees: number;
	anchorLatDegrees: number;

	content: string;
	visible: boolean;

	// 文字
	fontColor: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: 'normal' | 'bold' | number;
	fontStrokeColor: string | null;
	fontStrokeWidth: number;
	fontStrokeOpacity: number;
	lineHeight: number;
	letterSpacing: number;

	// 框
	fillColor: string;
	fillOpacity: number;
	showBorder: boolean;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	cornerRadius: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;

	// 排版
	textAlign: PlotTextAlign;
	verticalAlign: PlotTextVerticalAlign;
	boxWidthCssPx: number | null;
	boxHeightCssPx: number | null;
	boxOverflow: PlotTextBoxOverflow;
	layoutDirection: PlotTextLayoutDirection;

	// 贴地摆放
	metersPerPixel: number;
	anchorX: PlotTextAnchorX;
	anchorY: PlotTextAnchorY;
	offsetEastMeters: number;
	offsetNorthMeters: number;
	/** 地平面内旋转，弧度，北向顺时针为正（数学用时按需取负，见 placement）。 */
	rotationRadians: number;

	// 渲染
	renderOrder: number;
	minimumHeight: number | null;
	maximumHeight: number | null;
}

/** 单个字符在 canvas 局部坐标系（纹素像素，原点左上、Y 向下）的放置。 */
export interface PlacedChar {
	/** 字符（可能是 surrogate pair，对应一个 code point）。 */
	char: string;
	/** 字符绘制起点 x（纹素像素，左缘）。 */
	x: number;
	/** 字符基线 y（纹素像素）。 */
	baselineY: number;
}

/** 布局结果。box 尺寸单位为纹素像素，下游乘 metersPerPixel 得地面足迹。 */
export interface TextLayoutResult {
	/** 框宽（纹素像素）。 */
	boxWidthCssPx: number;
	/** 框高（纹素像素）。 */
	boxHeightCssPx: number;
	/** 字符放置数组（按绘制顺序）。 */
	chars: PlacedChar[];
}
```

## 设计记录

- **两套单位拆开**：贴地文本最易混淆处。「框多大字多大」在纹理里用纹素；「贴到地面多大」用米。`metersPerPixel` 是唯一桥梁。这样调字号（清晰度）和调地面尺寸（缩放）互不干扰。
- **`rotation` 北向顺时针**：GIS 习惯（方位角），与 ENU 数学（逆时针、东为 0）差一个取负 + 90° 关系，统一在 `text-placement` 处理。
- **`renderOrder` 保留**：贴地文本仍是 classification 命令块，需要和别的贴地图元排序；语义同 rectangle。

---

[← README](./README.md) | [A2-defaults →](./A2-defaults.md)
