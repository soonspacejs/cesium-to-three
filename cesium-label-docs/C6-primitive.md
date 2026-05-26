# C6 · `text-primitive.ts` + `index.ts` —— 公开类与桶导出

> [← C5-classification](./C5-classification.md) | [integration →](./integration.md)

## 职责

公开类 `CesiumGroundTextPrimitive`，把 A（纹理）→ B（足迹）→ C（贴地）串成一个对象，接口对齐 `CesiumGroundRectanglePrimitive` / `CesiumGroundCirclePrimitive`：`group` 加进场景、`update(frameState)` 每帧转发、`setRenderOrder` / `setVisible` / `dispose`。贴地特性决定 `update` **只转发** frameState（无 Sprite 的屏幕缩放）。额外提供 `setText` 局部更新（重排版、重画纹理、重建几何/extents）。

## 完整源码 · `text-primitive.ts`

```typescript
// ============================================================
// text-primitive.ts
// 层级：L4（顶层公开类，串联 A/B/C 全层 + 复用共享 classification）
// 职责：CesiumGroundTextPrimitive —— 贴地文本标绘对外入口。
//       构造：resolve 选项 → 画 canvas → CanvasTexture → 算足迹 → 建几何 →
//       算 extents → new CesiumClassificationPrimitive(注入文字 color 材质 +
//       u_textTexture)。update 只转发 frameState。setText 局部重建。
// 依赖：Three.CanvasTexture 等、classification（注入扩展）、materials
//      (createTextColorMaterial)、text-defaults/-canvas/-placement/
//      -shadow-volume/-extents/-options。
// 被消费：业务渲染代码 / demo。
// ============================================================

import {
	CanvasTexture,
	Color,
	Group,
	LinearFilter,
	LinearMipmapLinearFilter,
	SRGBColorSpace,
	type Texture,
} from 'three';

import { CesiumClassificationPrimitive } from '../classification';
import { createTextColorMaterial } from '../materials';
import type { CesiumGroundFrameState } from '../types';

import { paintTextToCanvas, type PaintedTextCanvas } from './text-canvas';
import { resolvePlotTextOptions } from './text-defaults';
import { computeTextPlanarExtents } from './text-extents';
import { computeTextFootprint, type TextFootprint } from './text-placement';
import { buildTextShadowVolumeGeometry } from './text-shadow-volume';
import type { PlotTextOptions, ResolvedPlotTextOptions } from './text-types';

// 各向异性过滤上限：贴地纹理常被斜视，提高斜向锐度。Three 会按 GPU 能力 clamp，
// 16 是绝大多数桌面 GPU 的实际上限，传大值安全。
const TEXT_TEXTURE_ANISOTROPY = 16;

/**
 * 贴地文本标绘公开类。一个实例 = 地面上一块可旋转、随地形起伏的文字标牌。
 */
export class CesiumGroundTextPrimitive {
	/** 加进场景的容器（含三个 shadow-volume 命令 mesh）。 */
	public readonly group: Group;

	private readonly classification: CesiumClassificationPrimitive;
	private resolved: ResolvedPlotTextOptions;
	private painted: PaintedTextCanvas;
	private texture: CanvasTexture;
	private footprint: TextFootprint;
	private renderOrder: number;
	private disposed: boolean;

	/**
	 * @param options 外部选项（lon/lat 锚点 + 内容 + 外观 + 贴地摆放）。
	 */
	public constructor( options: PlotTextOptions ) {
		this.disposed = false;

		// A 层：解析 → 画 canvas → 纹理
		this.resolved = resolvePlotTextOptions( options );
		this.painted = paintTextToCanvas( this.resolved, null );
		this.texture = createTextTexture( this.painted.canvas );

		// B 层：足迹 4 角点
		this.footprint = computeTextFootprint( this.resolved, this.painted.layout );

		// C 层：几何 + extents
		const geometry = buildTextShadowVolumeGeometry( {
			swEcef: this.footprint.swEcef,
			seEcef: this.footprint.seEcef,
			neEcef: this.footprint.neEcef,
			nwEcef: this.footprint.nwEcef,
			minimumHeight: this.resolved.minimumHeight ?? undefined,
			maximumHeight: this.resolved.maximumHeight ?? undefined,
		} );
		const extents = computeTextPlanarExtents( this.footprint );

		this.renderOrder = this.resolved.renderOrder;

		// 复用共享 classification，注入文字 color 材质 + 纹理 uniform。
		// 白色 + alpha 1 是占位（文字 color 走纹理；u_color 仅作 VS 的 v_color 来源）。
		this.classification = new CesiumClassificationPrimitive(
			geometry,
			extents,
			new Color( 1.0, 1.0, 1.0 ),
			1.0,
			this.renderOrder,
			true, // fragmentCull：裁足迹 + 丢弃无地形 fragment
			{
				colorMaterialFactory: createTextColorMaterial,
				extraUniforms: { u_textTexture: { value: this.texture } },
			},
		);
		this.classification.group.visible = this.resolved.visible;

		this.group = this.classification.group;
		this.group.name = 'CesiumGroundTextPrimitive';
	}

	/**
	 * 每帧转发 frameState 给共享 classification（Float64 MVP / cpu planes /
	 * log depth / 相机 high-low 全在那里更新）。贴地文本无屏幕缩放，纯转发。
	 *
	 * @param frameState 当前帧状态。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.ensureNotDisposed();
		this.classification.update( frameState );
	}

	/**
	 * 局部更新文本/样式/摆放：重 resolve → 重画纹理 → 重算足迹 → 重建几何 + extents。
	 * 几何/extents 变化需重建 classification（uniforms 持有 extents 引用），
	 * 故 dispose 旧 classification 再建新的，纹理可复用 canvas 句柄。
	 *
	 * @param partial 要覆盖的字段（与 PlotTextOptions 同形，points 用原锚点若不传）。
	 */
	public setText( partial: Partial<PlotTextOptions> ): void {
		this.ensureNotDisposed();

		// 合并：用原 resolved 反推一个完整 options 再覆盖。points 缺省用原锚点。
		const merged: PlotTextOptions = {
			...this.toPlotTextOptions(),
			...partial,
			points: partial.points ?? [
				[ this.resolved.anchorLonDegrees, this.resolved.anchorLatDegrees ],
			],
		};

		this.resolved = resolvePlotTextOptions( merged );

		// 重画纹理（复用 canvas 句柄；尺寸变了 paint 内部会 resize）
		this.painted = paintTextToCanvas( this.resolved, this.painted.canvas );
		this.texture.needsUpdate = true;

		// 重算足迹 + 几何 + extents
		this.footprint = computeTextFootprint( this.resolved, this.painted.layout );
		const geometry = buildTextShadowVolumeGeometry( {
			swEcef: this.footprint.swEcef,
			seEcef: this.footprint.seEcef,
			neEcef: this.footprint.neEcef,
			nwEcef: this.footprint.nwEcef,
			minimumHeight: this.resolved.minimumHeight ?? undefined,
			maximumHeight: this.resolved.maximumHeight ?? undefined,
		} );
		const extents = computeTextPlanarExtents( this.footprint );

		// classification 的 uniforms 持有旧 extents 引用，几何也变了 → 重建。
		const parent = this.group.parent;
		this.classification.dispose();
		parent?.remove( this.classification.group );

		this.classification = new CesiumClassificationPrimitive(
			geometry, extents, new Color( 1.0, 1.0, 1.0 ), 1.0,
			this.renderOrder, true,
			{
				colorMaterialFactory: createTextColorMaterial,
				extraUniforms: { u_textTexture: { value: this.texture } },
			},
		);
		this.classification.group.visible = this.resolved.visible;
		// 复用同一 group 引用：把新 group 接回原 parent，并更新本对象的 group 字段。
		( this as { group: Group } ).group = this.classification.group;
		this.group.name = 'CesiumGroundTextPrimitive';
		parent?.add( this.group );
	}

	/**
	 * 设置 classification 命令块基序（stencil / stencil+1 / color+2）。
	 *
	 * @param renderOrder 基序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.ensureNotDisposed();
		this.renderOrder = renderOrder;
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * 显隐（不从场景图分离，仅切 group.visible）。
	 *
	 * @param visible 是否可见。
	 */
	public setVisible( visible: boolean ): void {
		this.ensureNotDisposed();
		this.resolved.visible = visible;
		this.classification.group.visible = visible;
	}

	/** 释放几何、材质、纹理。调用后实例不可再用。 */
	public dispose(): void {
		if ( this.disposed ) {
			return;
		}
		this.disposed = true;
		this.classification.dispose();
		// 纹理由本类创建，由本类释放（classification 不越权）
		this.texture.dispose();
	}

	/** 已 dispose 后再调用 → 抛错（防御 use-after-free）。 */
	private ensureNotDisposed(): void {
		if ( this.disposed ) {
			throw new Error( 'CesiumGroundTextPrimitive: instance already disposed.' );
		}
	}

	/**
	 * 把当前 resolved 反推回一个 PlotTextOptions，供 setText 合并基底。
	 * 仅还原 PlotTextOptions 支持的字段（rotation 弧度→度、padding 还原四元组）。
	 *
	 * @returns 与当前状态等价的 PlotTextOptions。
	 */
	private toPlotTextOptions(): PlotTextOptions {
		const r = this.resolved;
		return {
			points: [ [ r.anchorLonDegrees, r.anchorLatDegrees ] ],
			content: r.content,
			fontColor: r.fontColor,
			fontSize: r.fontSize,
			fontFamily: r.fontFamily,
			fontWeight: r.fontWeight,
			fontStrokeColor: r.fontStrokeColor ?? undefined,
			fontStrokeWidth: r.fontStrokeWidth,
			fontStrokeOpacity: r.fontStrokeOpacity,
			lineHeight: r.lineHeight,
			letterSpacing: r.letterSpacing,
			fillColor: r.fillColor,
			fillOpacity: r.fillOpacity,
			showBorder: r.showBorder,
			strokeColor: r.strokeColor,
			strokeWidth: r.strokeWidth,
			strokeOpacity: r.strokeOpacity,
			cornerRadius: r.cornerRadius,
			padding: [ r.paddingTop, r.paddingRight, r.paddingBottom, r.paddingLeft ],
			textAlign: r.textAlign,
			verticalAlign: r.verticalAlign,
			boxWidth: r.boxWidthCssPx ?? undefined,
			boxHeight: r.boxHeightCssPx ?? undefined,
			boxOverflow: r.boxOverflow,
			layoutDirection: r.layoutDirection,
			metersPerPixel: r.metersPerPixel,
			anchorX: r.anchorX,
			anchorY: r.anchorY,
			offsetEastMeters: r.offsetEastMeters,
			offsetNorthMeters: r.offsetNorthMeters,
			rotation: r.rotationRadians * 180.0 / Math.PI,
			visible: r.visible,
			renderOrder: r.renderOrder,
			minimumHeight: r.minimumHeight ?? undefined,
			maximumHeight: r.maximumHeight ?? undefined,
		};
	}
}

/**
 * 从已绘制 canvas 建 CanvasTexture。
 * - mipmap + 三线性/各向异性：贴地纹理斜视/远观时抗锯齿。
 * - premultiplyAlpha=false：canvas 是直 alpha，shader 里手动预乘（见 C4），
 *   两边只乘一次，避免双重预乘发暗边。
 * - SRGBColorSpace：标注源色彩空间（RawShaderMaterial 不自动转，仅信息性，
 *   配合 C4 注释里的 gamma 取舍）。
 *
 * @param canvas 已绘制 canvas。
 * @returns      配置好的 CanvasTexture。
 */
function createTextTexture( canvas: HTMLCanvasElement ): CanvasTexture {
	const texture = new CanvasTexture( canvas );
	texture.minFilter = LinearMipmapLinearFilter;
	texture.magFilter = LinearFilter;
	texture.generateMipmaps = true;
	texture.anisotropy = TEXT_TEXTURE_ANISOTROPY;
	texture.premultiplyAlpha = false;
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}
```

## 完整源码 · `index.ts`

```typescript
// ============================================================
// text/index.ts — 贴地文本标绘模块公共 API
// 层级：L4（模块出口）
// 职责：集中导出公开类与类型，作为模块唯一入口。上层只 import 自此，
//      不深入子文件。
// 依赖：本目录各文件。
// 被消费：src/lib/ground/index.ts、demo、业务渲染代码。
// ============================================================

export { CesiumGroundTextPrimitive } from './text-primitive';

export type {
	PlotTextOptions,
	PlotTextAlign,
	PlotTextVerticalAlign,
	PlotTextAnchorX,
	PlotTextAnchorY,
	PlotTextLayoutDirection,
	PlotTextBoxOverflow,
	LonLatPoint,
} from './text-types';

// 进阶导出：供需要单独算足迹 / 几何 / extents 的高级用法。
export { computeTextFootprint, type TextFootprint } from './text-placement';
export { buildTextShadowVolumeGeometry } from './text-shadow-volume';
export { computeTextPlanarExtents } from './text-extents';
export {
	type TextShadowVolumeOptions,
	TEXT_DEFAULT_MAX_HEIGHT,
	TEXT_DEFAULT_MIN_HEIGHT,
} from './text-options';
```

## 接口对齐表（与 rectangle/circle 一致）

| 成员 | rectangle/circle | text |
|---|---|---|
| `group: Group` | ✓ | ✓ |
| `update(frameState)` | ✓ | ✓（纯转发，无缩放） |
| `setRenderOrder(n)` | ✓ | ✓ |
| `dispose()` | ✓ | ✓（+ 纹理） |
| 显隐 | `group.visible` | `setVisible()` / `group.visible` |
| 内容更新 | 重建 | `setText(partial)` |

## setText 重建说明

几何与 extents 变化必须重建 classification（其 uniforms 持有 extents 引用、几何也换）。重建时先记住 `group.parent`，dispose 旧的、从 parent 移除，建新的再挂回，保证场景图连续。纯样式（颜色/字号）若不改足迹尺寸理论上可只重画纹理 + `texture.needsUpdate`，但 box 自适应尺寸通常随内容变，稳妥起见统一走重建路径。高频动态文本建议在业务层按 content 去重，避免每帧重建。

---

[← C5-classification](./C5-classification.md) | [integration →](./integration.md)
