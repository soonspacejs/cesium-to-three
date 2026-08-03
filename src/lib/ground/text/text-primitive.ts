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
} from 'three';

import { CesiumClassificationPrimitive } from '../classification';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
	type CesiumGroundAppearance,
} from '../material/appearances';
import { createTexturedDecalMaterial } from '../material/builtins';
import type { CesiumGroundMaterial } from '../material/CesiumGroundMaterial';
import type { CesiumGroundFrameState, ClassificationType } from '../types';

import { paintTextToCanvas, type PaintedTextCanvas } from './text-canvas';
import { resolvePlotTextOptions } from './text-defaults';
import { computeTextPlanarExtents } from './text-extents';
import { computeTextFootprint, type TextFootprint } from './text-placement';
import { buildTextShadowVolumeGeometry } from './text-shadow-volume';
import type {
	CesiumGroundTextPrimitiveOptions,
	PlotTextOptions,
	ResolvedPlotTextOptions,
} from './text-types';

// 各向异性过滤上限：贴地纹理常被斜视，提高斜向锐度。Three 会按 GPU 能力 clamp，
// 16 是绝大多数桌面 GPU 的实际上限，传大值安全。
const TEXT_TEXTURE_ANISOTROPY = 16;

/**
 * 贴地文本标绘公开类。一个实例 = 地面上一块可旋转、随地形起伏的文字标牌。
 */
export class CesiumGroundTextPrimitive {
	/** 加进场景的容器（含三个 shadow-volume 命令 mesh）。 */
	public group: Group;

	/**
	 * 共享 classification（front / back stencil + color command）。公开以便宿主
	 * 单独切命令显隐（setCommandVisibility）等高级用法，与 rectangle/circle 同形。
	 * setText 会替换为新实例；外部不应缓存其引用。
	 */
	public classification: CesiumClassificationPrimitive;
	private resolved: ResolvedPlotTextOptions;
	private painted: PaintedTextCanvas;
	private texture: CanvasTexture;
	/** One logical decal Material reused across every setText rebuild. */
	private readonly decalMaterial: CesiumGroundMaterial;
	/** Exact logical Appearance retained when classification commands are rebuilt. */
	private appearanceState: CesiumGroundAppearance;
	/** Stable default wrapper restored by `setAppearance(undefined)`. */
	private readonly defaultAppearance: CesiumGroundMaterialAppearance;
	private footprint: TextFootprint;
	private renderOrder: number;
	private disposed: boolean;

	/**
	 * @param options 外部选项（lon/lat 锚点 + 内容 + 外观 + 贴地摆放）。
	 */
	public constructor( options: CesiumGroundTextPrimitiveOptions ) {
		this.disposed = false;

		// A 层：解析 → 画 canvas → 纹理
		this.resolved = resolvePlotTextOptions( options );
		this.painted = paintTextToCanvas( this.resolved, null );
		this.texture = createTextTexture( this.painted.canvas );
		this.decalMaterial = createTexturedDecalMaterial( {
			texture: this.texture,
			flipY: true,
		} );
		this.defaultAppearance = new CesiumGroundMaterialAppearance( {
			material: this.decalMaterial,
		} );
		this.appearanceState = options.appearance ?? this.defaultAppearance;

		// B 层：足迹 4 角点
		this.footprint = computeTextFootprint( this.resolved, this.painted.layout );

		// C 层：几何 + extents
		this.renderOrder = this.resolved.renderOrder;
		this.classification = this.buildClassification();
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
		this.renderOrder = this.resolved.renderOrder;

		// 重画纹理（复用 canvas 句柄；尺寸变了 paint 内部会 resize）
		this.painted = paintTextToCanvas( this.resolved, this.painted.canvas );
		this.texture.needsUpdate = true;

		// 重算足迹（geometry + extents 会用到）
		this.footprint = computeTextFootprint( this.resolved, this.painted.layout );

		// classification 的 uniforms 持有旧 extents 引用，几何也变了 → 重建。
		const parent = this.group.parent;
		this.classification.dispose();
		parent?.remove( this.classification.group );

		this.classification = this.buildClassification();
		this.classification.group.visible = this.resolved.visible;
		// 复用同一引用：把新 group 接回原 parent，并更新本对象的 group 字段。
		this.group = this.classification.group;
		this.group.name = 'CesiumGroundTextPrimitive';
		parent?.add( this.group );
	}

	/** Returns the exact logical Appearance currently bound to the text decal. */
	public get appearance(): CesiumGroundAppearance {
		return this.appearanceState;
	}

	/** Switches only the text color pass; the CanvasTexture remains borrowed and stable. */
	public setAppearance( appearance?: CesiumGroundAppearance ): void {
		this.ensureNotDisposed();
		if (
			appearance !== undefined &&
			! ( appearance instanceof CesiumGroundMaterialAppearance ) &&
			! ( appearance instanceof CesiumGroundRawShaderAppearance )
		) {
			throw new TypeError( 'Ground text appearance is not a supported Ground Appearance.' );
		}
		const nextAppearance = appearance ?? this.defaultAppearance;
		if ( nextAppearance === this.appearanceState ) return;
		this.classification.setAppearance( nextAppearance );
		this.appearanceState = nextAppearance;
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

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。供桥接器在 GUI 改「分类目标」时热更新调用，
	 * 使共享 classification 改采样对应的 packed 深度纹理；不同步会导致采样旧纹理、
	 * 文字随相机漂浮。同步写回 resolved，后续 setText 重建时沿用新目标。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.ensureNotDisposed();
		if ( classificationType !== undefined ) {
			this.resolved.classificationType = classificationType;
		}
		this.classification.setClassificationType( classificationType );
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

	/**
	 * 用当前 resolved + footprint + 纹理构造一个新的 CesiumClassificationPrimitive。
	 * 复用 buildTextShadowVolumeGeometry 与 computeTextPlanarExtents，并注入文字
	 * color 材质工厂与 u_textTexture，保证所有命令共享同一 jitter-fixed 管线。
	 *
	 * @returns 新建的 classification。
	 */
	private buildClassification(): CesiumClassificationPrimitive {
		const geometry = buildTextShadowVolumeGeometry( {
			swEcef: this.footprint.swEcef,
			seEcef: this.footprint.seEcef,
			neEcef: this.footprint.neEcef,
			nwEcef: this.footprint.nwEcef,
			minimumHeight: this.resolved.minimumHeight ?? undefined,
			maximumHeight: this.resolved.maximumHeight ?? undefined,
		} );
		const extents = computeTextPlanarExtents( this.footprint );

		// 白色 + alpha 1 占位：文字 color 走纹理；u_color 仅作 VS 的 v_color 来源
		const classification = new CesiumClassificationPrimitive(
			geometry,
			extents,
			new Color( 1.0, 1.0, 1.0 ),
			1.0,
			this.renderOrder,
			true, // fragmentCull：裁足迹 + 丢弃无地形 fragment
			{
				useMaterialPipeline: true,
				primitiveKind: 'decal',
				defaultMaterial: this.decalMaterial,
				appearance: this.appearanceState,
			},
		);
		// 文字也支持贴地形 / 贴模型 / 二者：把解析出的分类目标传给 classification。
		classification.setClassificationType( this.resolved.classificationType );
		return classification;
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
			classificationType: r.classificationType,
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
 * - flipY=false：贴地材质片元里已经做了 `vec2(uv.x, 1.0 - uv.y)` 的 V 翻转
 *   把「uv 原点 SW、Y 向上」换算回「canvas 原点左上、Y 向下」。Three.js
 *   CanvasTexture 默认 flipY=true 会先做一次 GPU 上传翻转，与 shader 的
 *   1−V 形成双重翻转 → 内容上下颠倒（screenshot 显示「文字反着」即此）。
 *   关掉默认翻转后，shader 的 V 翻转才是唯一一次，文字北上、读序正确。
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
	texture.flipY = false;
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}
