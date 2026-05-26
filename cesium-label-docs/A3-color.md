# A3 · `text-color.ts` —— 颜色解析与不透明度合成

> [← A2-defaults](./A2-defaults.md) | [A4-layout →](./A4-layout.md)

## 职责

把 `(CSS 颜色字符串, opacity 0..100)` 合成 Canvas2D 可直接消费的 `rgba(r,g,b,a)`。借浏览器原生颜色解析（1×1 scratch canvas）支持所有 CSS 颜色格式，并把字符串自带 alpha 与外部 opacity 相乘。本文件只服务 canvas 绘制（A 层），与贴地无关。

## 完整源码

```typescript
// ============================================================
// text-color.ts
// 层级：L1（无模块内依赖，首次调用时懒建 1×1 canvas）
// 职责：把 (CSS 颜色字符串, opacity 0..100) 合成 `rgba(r,g,b,a)`。借浏览器
//       Canvas2D 原生解析任意颜色格式，再把源 alpha 与外部 opacity 相乘。
// 依赖：浏览器 document（仅 canvas 绘制环境可用）。
// 被消费：text-canvas。
// ============================================================

/** 解析结果：0..255 RGB + 0..1 alpha。 */
export interface Rgba255 {
	r: number;
	g: number;
	b: number;
	/** 0..1，来自颜色字符串自带 alpha 通道。 */
	a: number;
}

// 模块级 1×1 scratch canvas：借 Canvas2D 把任意颜色字符串解析为像素读回。
let _scratchCanvas: HTMLCanvasElement | null = null;
let _scratchCtx: CanvasRenderingContext2D | null = null;

/**
 * 把 CSS 颜色字符串解析为 0..255 RGB + 0..1 alpha。
 *
 * 实现：在共享 1×1 canvas 上 fillStyle=color → fillRect → getImageData 读回。
 * 这是浏览器原生解析路径，支持 #hex / rgb() / rgba() / hsl() / 命名色。
 * 非法字符串浏览器会保留旧 fillStyle，用 sentinel 对比识别，fallback 黑色不透明。
 *
 * @param colorString CSS 颜色字符串。
 * @returns           RGBA（每次新建对象）。
 */
export function parseCssColor( colorString: string ): Rgba255 {
	const ctx = getScratchCtx();
	ctx.clearRect( 0, 0, 1, 1 );

	// sentinel 检测非法输入：先设已知色读回标准化串，再设目标色；
	// 若目标被拒，fillStyle 不变（仍是 sentinel）。
	ctx.fillStyle = '#000';
	const sentinelFill = ctx.fillStyle;
	ctx.fillStyle = colorString;
	const acceptedFill = ctx.fillStyle;
	if ( acceptedFill === sentinelFill && colorString !== sentinelFill ) {
		// eslint-disable-next-line no-console
		console.warn( `[PlotText] Invalid CSS color string: ${ colorString }` );
		return { r: 0, g: 0, b: 0, a: 1.0 };
	}

	ctx.fillRect( 0, 0, 1, 1 );
	const data = ctx.getImageData( 0, 0, 1, 1 ).data;
	return { r: data[ 0 ], g: data[ 1 ], b: data[ 2 ], a: data[ 3 ] / 255.0 };
}

/**
 * 合成 `rgba(r,g,b,a)`：源 alpha × (opacity/100)，避免双重半透明语义丢失。
 *
 * @param colorString    CSS 颜色字符串。
 * @param opacityPercent 0..100。
 * @returns              `rgba(r, g, b, a)`，alpha 已是 0..1。
 */
export function composeRgba( colorString: string, opacityPercent: number ): string {
	const rgba = parseCssColor( colorString );
	const opacity = clamp01( opacityPercent / 100.0 );
	const finalAlpha = rgba.a * opacity;
	return `rgba(${ Math.round( rgba.r ) }, ${ Math.round( rgba.g ) }, ${ Math.round( rgba.b ) }, ${ finalAlpha.toFixed( 4 ) })`;
}

/** 钳到 [0,1]，NaN → 0。 */
function clamp01( value: number ): number {
	if ( ! Number.isFinite( value ) ) {
		return 0.0;
	}
	return Math.min( Math.max( value, 0.0 ), 1.0 );
}

/**
 * 懒建模块级 1×1 解析画板。无 document 环境抛错（颜色解析强依赖 Canvas2D）。
 *
 * @returns 共享 2D context。
 */
function getScratchCtx(): CanvasRenderingContext2D {
	if ( _scratchCtx !== null ) {
		return _scratchCtx;
	}
	if ( typeof document === 'undefined' ) {
		throw new Error( 'PlotText color parsing requires browser `document`.' );
	}
	_scratchCanvas = document.createElement( 'canvas' );
	_scratchCanvas.width = 1;
	_scratchCanvas.height = 1;
	// willReadFrequently：提示浏览器分配 readback 友好后端，多次 getImageData 不掉速
	const ctx = _scratchCanvas.getContext( '2d', { willReadFrequently: true } );
	if ( ctx === null ) {
		throw new Error( 'PlotText color parsing: failed to acquire 2D context.' );
	}
	_scratchCtx = ctx;
	return ctx;
}
```

## 单元测试建议

`parseCssColor('#ff0000')` → `{255,0,0,1}`；`'rgba(0,128,255,0.5)'` → `{0,128,255,0.5}`；`'red'` → `{255,0,0,1}`；`'bad'` → `{0,0,0,1}` + warn。`composeRgba('#000',50)` → `'rgba(0, 0, 0, 0.5000)'`；`composeRgba('rgba(0,0,0,0.5)',80)` → `'...0.4000)'`（相乘）。

---

[← A2-defaults](./A2-defaults.md) | [A4-layout →](./A4-layout.md)
