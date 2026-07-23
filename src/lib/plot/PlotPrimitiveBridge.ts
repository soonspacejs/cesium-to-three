// ============================================================
// PlotPrimitiveBridge.ts — 标绘数据模型 → Three/Cesium 风格图元桥接器
// 层级：plot 渲染桥接层，由 GroundDecalManager 持有。
// 职责：把 Map<id, GisPlotBase> 同步为场景图元；几何变化时重建，样式变化时
//       尽量热更新；每帧把 frameState 转发给全部图元。
// 依赖：ground 图元、text 图元、plot 数据模型、plot-order。
// 被消费：GroundDecalManager 与宿主渲染循环。
//
// 与 PlotSdfPlugin 对齐的协议：
//   - set/get shapes( Map<string, GisPlotBase> )
//   - get/set opacity（钳制到 0..1）
//   - redraw(): void
//   - dispose(): void
//
// c2t 扩展：update(frameState) 每帧刷新深度、视口和相机 uniform。
// redraw 同步策略：删除消失项；对签名未变项热更新；其余项释放旧图元后重建。
// ============================================================

import type { Group, Scene } from 'three';

import {
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
} from '../ground';
import { CesiumGroundTextPrimitive } from '../ground/text';
import type {
	CesiumGroundArrowMode,
	CesiumGroundArrowStyle,
	CesiumGroundFrameState,
	ClassificationType,
	LonLatPoint,
} from '../ground';

import type { GisPlotBase } from './plugins/base';
import type { GisPlotArrow } from './plugins/arrow';
import type { GisPlotText } from './plugins/text';
import type {
	PlotArrowOptions,
	PlotCircleOptions,
	PlotLineOptions,
	PlotPointOptions,
	PlotSectorOptions,
	PlotTextOptions,
} from './plugins/types';

import { plotOrderToRenderOrder } from './plot-order';
import { createPlainPlotPrimitive, PlainPlotPrimitive } from './PlainPlotPrimitive';
import { resolvePlotPointImageUrl } from './emergency-resource-icons';

/**
 * 桥接器构造选项。
 */
export interface PlotPrimitiveBridgeOptions {
	/** 标绘图元挂载的目标场景。 */
	scene: Scene;
}

/** 桥接器支持的全部贴地渲染图元联合。 */
type AnyGroundPrimitive =
	| CesiumGroundPointPrimitive
	| CesiumGroundPolylinePrimitive
	| CesiumGroundPolygonPrimitive
	| CesiumGroundCirclePrimitive
	| CesiumGroundTextPrimitive;

/**
 * 桥接器可持有的全部渲染图元：贴地路径的 CesiumGround*（classification / 折线 / 文字）
 * 与不贴地路径的 PlainPlotPrimitive。两条路径共享同一套 PlotEntry 生命周期管理
 * （resolveGroup / update / dispose / setRenderOrder / 可见性），按 clampToGround 分流。
 */
type AnyPlotPrimitive = AnyGroundPrimitive | PlainPlotPrimitive;

/**
 * 单条标绘在桥接器中的渲染记录。
 * signature 判断几何是否需要重建；styleSignature 判断样式能否保持原图元。
 * 折线、文字和图片点支持部分样式热更新，其余面图元在样式变化时重建。
 */
interface PlotEntry {
	plot: GisPlotBase;
	primitive: AnyPlotPrimitive;
	group: Group;
	signature: string;
	styleSignature: string;
}

/**
 * 解析应挂载到场景的 Group。折线、文字和普通图元直接暴露 group；
 * 其它贴地图元通过 classification.group 挂载。
 *
 * @param primitive 任意桥接器支持的图元。
 * @returns 应传给 scene.add 的 THREE.Group。
 */
function resolveGroup( primitive: AnyPlotPrimitive ): Group {
	// 不贴地图元自身就是一个 Group 持有者，直接取其 group。
	if ( primitive instanceof PlainPlotPrimitive ) {
		return primitive.group;
	}
	if ( primitive instanceof CesiumGroundPolylinePrimitive ) {
		return primitive.group;
	}
	if ( primitive instanceof CesiumGroundTextPrimitive ) {
		return primitive.group;
	}
	return ( primitive as CesiumGroundPolygonPrimitive ).classification.group;
}

/**
 * 计算几何签名。只纳入影响几何或纹理足迹的字段，不包含纯颜色、透明度和顺序。
 *
 * @param plot 标绘数据模型。
 * @returns 稳定的字符串签名。
 */
function geometrySignature( plot: GisPlotBase ): string {
	const o = plot.options as Record<string, unknown>;
	const pts = JSON.stringify( o.points ?? [] );
	switch ( plot.category ) {

		case 'circle':
			return `circle|${ pts }|${ o.radius }`;

		case 'sector':
			return `sector|${ pts }|${ o.radius }|${ o.startAngle }|${ o.sectorAngle }`;

		case 'point':
			return `point|${ pts }|${ o.pointStyle }|${ o.size }|${ o.imageUrl }|${ o.ontologyId }`
				+ `|${ o.imageWidth }|${ o.imageHeight }|${ o.rotation }`;

		case 'arrow':
			// 箭头体型(sizeScale 对全类型生效 + 曲线专属体型字段)影响几何 →
			// 必须进签名,否则 GUI 改大小时 geomSig 不变 → 桥接器只做轻量样式刷新、
			// 不重算 generateCoords → 改了没反应(踩过的坑)。
			return `arrow|${ pts }|${ o.arrowType }|${ o.sizeScale }`
				+ `|${ o.curvedBodyWidthFactor }|${ o.curvedHeadWidthFactor }`
				+ `|${ o.curvedHeadLengthFactor }`;

		case 'line':
			return `line|${ pts }|${ o.strokeStyle }|${ o.startArrowStyle }|${ o.endArrowStyle }`;

		case 'text':
			return `text|${ pts }|${ o.content }|${ o.fontSize }|${ o.textAlign }|${ o.verticalAlign }|${ o.anchorX }|${ o.anchorY }|${ o.layoutDirection }|${ o.rotation }|${ o.boxWidth }|${ o.boxHeight }|${ JSON.stringify( o.padding ) }|${ o.offsetX }|${ o.offsetY }|${ o.scale }`;

		default:
			return `${ plot.category }|${ pts }`;
	}
}

/**
 * 计算"贴地模式签名"，并入几何签名前缀，使切换 clampToGround / 修改不贴地高度时
 * 必然触发整图元重建（两条渲染路径产出的图元类型不同，不能走轻量刷新）。
 *   - 贴地（clampToGround !== false）：返回固定 'ground'，与 heightMeters 无关
 *     （贴地路径忽略高度，故移动高度滑杆不会让贴地图元做无谓重建）。
 *   - 不贴地（clampToGround === false）：返回 'plain|<heightMeters>'，高度变化即重建。
 *
 * @param plot 数据模型。
 * @returns    稳定的模式签名前缀。
 */
function clampModeSignature( plot: GisPlotBase ): string {
	const o = plot.options as { clampToGround?: boolean; heightMeters?: number };
	if ( o.clampToGround === false ) {
		return `plain|${ o.heightMeters ?? '' }`;
	}
	return 'ground';
}

/**
 * 按折线米制宽度计算端点箭头尺寸。箭头长为线宽的 4 倍、底宽为 3 倍，
 * 并设置最小值，避免极细线下箭头完全消失。
 *
 * @param strokeWidthMeters 折线宽度，单位米。
 * @returns 箭头长度与宽度，单位米。
 */
function arrowSizeFromStrokeMeters( strokeWidthMeters: number ): {
	lengthMeters: number;
	widthMetersArrow: number;
} {
	const lengthMeters = Math.max( strokeWidthMeters * 4, 1 );
	const widthMetersArrow = Math.max( strokeWidthMeters * 3, 0.8 );
	return { lengthMeters, widthMetersArrow };
}

/**
 * 计算样式签名，包含颜色、透明度、描边宽度及全局透明度。
 *
 * @param plot 标绘数据模型。
 * @param globalOpacity 全局透明度，范围 0..1。
 * @returns 稳定的字符串签名。
 */
function styleSignature( plot: GisPlotBase, globalOpacity: number ): string {
	const o = plot.options as Record<string, unknown>;
	return (
		`${ o.strokeColor }|${ o.strokeWidth }|${ o.strokeOpacity }|` +
		`${ o.fillColor }|${ o.fillOpacity }|${ globalOpacity }|` +
		`${ ( o as { fontColor?: string } ).fontColor ?? '' }|` +
		`${ ( o as { fontSize?: number } ).fontSize ?? '' }`
	);
}

/**
 * 标绘图元桥接器：把 Map<id, GisPlotBase> 同步为场景图元集合。
 */
export class PlotPrimitiveBridge {

	/** 标绘 id → 渲染记录。 */
	private readonly _entries = new Map<string, PlotEntry>();

	/** GroundDecalManager 写入的标绘集合，保持引用共享。 */
	private _shapes: Map<string, GisPlotBase> = new Map();

	/** 全局透明度 0..1；写入后在下一次 redraw 生效。 */
	private _opacity = 1;

	/** 图元挂载的 Three 场景。 */
	private readonly _scene: Scene;

	/** 是否已经释放。 */
	private _disposed = false;

	/** 标绘图元是否挂载在目标 scene 上；关闭时保留数据与 primitive，但从 scene 移除。 */
	private _sceneAttached = true;

	/**
	 * @param options 桥接器构造选项。
	 */
	public constructor( options: PlotPrimitiveBridgeOptions ) {
		this._scene = options.scene;
	}

	// ── 与 PlotSdfPlugin 对齐的协议 ──

	/** 接收 GroundDecalManager 交付的共享 Map。 */
	public set shapes( value: Map<string, GisPlotBase> ) {
		this._shapes = value;
	}

	/** 当前持有的标绘集合引用。 */
	public get shapes(): Map<string, GisPlotBase> {
		return this._shapes;
	}

	/** 全局透明度；赋值时钳制到 [0, 1]。 */
	public set opacity( value: number ) {
		if ( ! Number.isFinite( value ) ) {
			this._opacity = 1;
			return;
		}
		this._opacity = Math.min( Math.max( value, 0 ), 1 );
	}

	public get opacity(): number {
		return this._opacity;
	}

	/** 控制所有已构建标绘图元是否直接挂载到 Three scene。 */
	public setSceneAttached( attached: boolean ): void {
		if ( this._disposed || this._sceneAttached === attached ) {
			return;
		}
		this._sceneAttached = attached;
		for ( const entry of this._entries.values() ) {
			if ( attached ) {
				if ( entry.group.parent !== this._scene ) {
					this._scene.add( entry.group );
				}
			} else {
				this._scene.remove( entry.group );
			}
		}
	}

	public get sceneAttached(): boolean {
		return this._sceneAttached;
	}

	/**
	 * 把 _shapes 同步为图元集合：删除已消失项，创建新增项，按签名决定热更新或重建。
	 * 仅显隐、顺序或受支持的样式变化走轻量刷新。
	 */
	public redraw(): void {
		if ( this._disposed ) {
			return;
		}

		for ( const [ id, entry ] of this._entries ) {
			if ( ! this._shapes.has( id ) ) {
				this._scene.remove( entry.group );
				entry.primitive.dispose();
				this._entries.delete( id );
			}
		}

		let plotOrder = 0;
		for ( const [ id, plot ] of this._shapes ) {
			const renderOrder = plotOrderToRenderOrder( plotOrder );
			plotOrder += 1;

			const existing = this._entries.get( id );
			const geomSig = `${ clampModeSignature( plot ) }|${ geometrySignature( plot ) }`;
			const styleSig = styleSignature( plot, this._opacity );

			if (
				existing !== undefined &&
				existing.signature === geomSig &&
				( this._supportsStyleHotUpdate( existing.primitive ) ||
					existing.styleSignature === styleSig )
			) {
				this._refreshLightweight( existing, renderOrder );
				existing.styleSignature = styleSig;
				continue;
			}

			if ( existing !== undefined ) {
				this._scene.remove( existing.group );
				existing.primitive.dispose();
				this._entries.delete( id );
			}

			const primitive = this._buildPrimitive( plot, renderOrder );
			if ( primitive === null ) {
				continue;
			}
			const group = resolveGroup( primitive );
			group.visible = plot.options.visible !== false;
			if ( this._sceneAttached ) {
				this._scene.add( group );
			}
			const entry: PlotEntry = {
				plot,
				primitive,
				group,
				signature: geomSig,
				styleSignature: styleSig,
			};
			this._entries.set( id, entry );

			if ( primitive instanceof CesiumGroundTextPrimitive ) {
				this._refreshLightweight( entry, renderOrder );
			}
		}
	}

	/**
	 * 宿主每帧调用，把深度、视口、相机和像素比传给全部图元。
	 *
	 * @param frameState 当前帧状态。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		if ( this._disposed || ! this._sceneAttached ) {
			return;
		}
		for ( const entry of this._entries.values() ) {
			entry.primitive.update( frameState );
		}
	}

	/** 释放全部图元并从场景移除。 */
	public dispose(): void {
		if ( this._disposed ) {
			return;
		}
		for ( const entry of this._entries.values() ) {
			this._scene.remove( entry.group );
			entry.primitive.dispose();
		}
		this._entries.clear();
		this._disposed = true;
	}

	// ── 内部：轻量刷新与样式热更新判定 ──

	/**
	 * 判断图元是否支持样式热更新。折线、文字和图片点支持；其它面图元需要重建。
	 *
	 * @param primitive 渲染图元。
	 * @returns 样式变化是否可走轻量刷新。
	 */
	private _supportsStyleHotUpdate( primitive: AnyPlotPrimitive ): boolean {
		return (
			primitive instanceof CesiumGroundPolylinePrimitive ||
			primitive instanceof CesiumGroundTextPrimitive ||
			( primitive instanceof CesiumGroundPointPrimitive && primitive.shape === 'image' )
		);
	}

	/**
	 * 几何未变时进行轻量刷新：统一更新显隐和顺序，并按图元能力更新样式。
	 * 图片点只改透明度 uniform，不重新请求图片或重建足迹。
	 *
	 * @param entry 现有渲染记录。
	 * @param renderOrder 由插入顺序换算的渲染顺序。
	 */
	private _refreshLightweight( entry: PlotEntry, renderOrder: number ): void {
		entry.group.visible = entry.plot.options.visible !== false;

		// 分类目标（贴地形 / 贴模型 / 二者）热更新。classificationType 不进几何 / 样式
		// 签名，所以 GUI 切「分类目标」时只触发本轻量刷新——必须把新目标同步到贴地图元，
		// 否则图元内部仍按旧目标采样：该目标的 packed 深度纹理已不再被宿主逐帧渲染，
		// 标绘便读到一张定格在旧相机位姿的深度，表现为「随相机移动到处漂浮」（仅初始
		// BOTH 正常，切 TERRAIN / CESIUM_3D_TILE 后异常）。不贴地的 PlainPlotPrimitive
		// 无此方法 → 守卫自动跳过。
		( entry.primitive as { setClassificationType?( t?: ClassificationType ): void } )
			.setClassificationType?.( entry.plot.options.classificationType );

		( entry.primitive as { setRenderOrder?( n: number ): void } )
			.setRenderOrder?.( renderOrder );

		if ( entry.primitive instanceof CesiumGroundPolylinePrimitive ) {
			const o = entry.plot.options as PlotLineOptions;
			entry.primitive.setColor(
				o.strokeColor,
				( o.strokeOpacity ?? 100 ) * this._opacity,
			);
			const widthMeters = typeof o.strokeWidth === 'number' && o.strokeWidth > 0
				? o.strokeWidth
				: 5;
			entry.primitive.setWidth( widthMeters );
			const { lengthMeters, widthMetersArrow } = arrowSizeFromStrokeMeters( widthMeters );
			entry.primitive.setArrowSizeMeters( lengthMeters, widthMetersArrow );
			entry.primitive.setVisible( o.visible !== false );
		}

		if ( entry.primitive instanceof CesiumGroundTextPrimitive ) {
			const t = ( entry.plot as GisPlotText ).options;
			entry.primitive.setText( {
				content: t.content,
				fontColor: t.fontColor,
				fontSize: t.fontSize,
				fillColor: t.fillColor,
				fillOpacity: ( t.fillOpacity ?? 100 ) * this._opacity,
				strokeColor: t.strokeColor,
				strokeOpacity: ( t.strokeOpacity ?? 100 ) * this._opacity,
				strokeWidth: t.strokeWidth,
				textAlign: t.textAlign,
				verticalAlign: t.verticalAlign,
				anchorX: t.anchorX,
				anchorY: t.anchorY,
				layoutDirection: t.layoutDirection,
				rotation: t.rotation,
				boxWidth: t.boxWidth,
				boxHeight: t.boxHeight,
				padding: t.padding,
				showBorder: t.showBorder,
				offsetEastMeters: t.offsetX,
				offsetNorthMeters: t.offsetY,
				metersPerPixel: t.scale,
			} );
			entry.primitive.setVisible( t.visible !== false );
			entry.group = resolveGroup( entry.primitive );
			entry.group.visible = t.visible !== false;
		}

		if ( entry.primitive instanceof CesiumGroundPointPrimitive &&
			entry.primitive.shape === 'image' ) {
			const point = entry.plot.options as PlotPointOptions;
			entry.primitive.setImageOpacity( ( point.fillOpacity ?? 100 ) * this._opacity );
		}
	}

	// ── 内部：按 category 构建图元 ──

	/**
	 * 按 category 实例化对应图元，统一把 0..100 样式透明度与全局透明度相乘。
	 *
	 * @param plot 标绘数据模型。
	 * @param renderOrder 由插入顺序换算的渲染顺序。
	 * @returns 渲染图元；未知或退化数据返回 null。
	 */
	private _buildPrimitive(
		plot: GisPlotBase,
		renderOrder: number,
	): AnyPlotPrimitive | null {
		// 不贴地分流：clampToGround === false 时走普通 Three 图元路径
		// （PlainPlotPrimitive），在 options.heightMeters 高度成面 / 线 / 字，完全不依赖
		// 贴地深度纹理与 stencil。默认（undefined / true）仍走下方 CesiumGround* 贴地路径，
		// 既有行为零变化。
		if ( ( plot.options as { clampToGround?: boolean } ).clampToGround === false ) {
			return createPlainPlotPrimitive( plot, renderOrder, this._opacity );
		}

		const base = plot.options;
		const pts = ( base.points ?? [] ) as LonLatPoint[];
		const g = this._opacity;
		const strokeOpacity = ( base.strokeOpacity ?? 100 ) * g;
		const fillOpacity = ( base.fillOpacity ?? 100 ) * g;
		const visible = base.visible !== false;

		switch ( plot.category ) {

			case 'point': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotPointOptions;
				if ( o.pointStyle === 'image' ) {
					const imageUrl = resolvePlotPointImageUrl( o );
					if ( ! imageUrl ) {
						console.warn(
							`[cesium-to-three] Unknown point image ontology id: ${ o.ontologyId ?? '' }`,
						);
						return null;
					}
					return new CesiumGroundPointPrimitive( {
						classificationType: base.classificationType,
						position: pts[ 0 ],
						shape: 'image',
						imageUrl,
						imageWidth: o.imageWidth,
						imageHeight: o.imageHeight,
						rotation: o.rotation,
						strokeColor: o.strokeColor,
						strokeWidth: o.strokeWidth ?? 0,
						strokeOpacity,
						fillColor: o.fillColor,
						fillOpacity,
						visible,
						renderOrder,
					} );
				}
				return new CesiumGroundPointPrimitive( {
					classificationType: base.classificationType,
					position: pts[ 0 ],
					shape: o.pointStyle,
					size: o.size,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'circle': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotCircleOptions;
				return new CesiumGroundCirclePrimitive( {
					classificationType: base.classificationType,
					center: pts[ 0 ],
					radius: o.radius ?? 100,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'sector': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotSectorOptions;
				return new CesiumGroundCirclePrimitive( {
					classificationType: base.classificationType,
					center: pts[ 0 ],
					radius: o.radius ?? 100,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					sectorStartDegrees: o.startAngle ?? 0,
					sectorAngleDegrees: o.sectorAngle ?? 360,
					renderOrder,
				} );
			}

			case 'polygon':
			case 'rectangle': {
				if ( pts.length < 3 ) return null;
				return new CesiumGroundPolygonPrimitive( {
					classificationType: base.classificationType,
					points: pts,
					strokeColor: base.strokeColor,
					strokeWidth: base.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: base.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'arrow': {
				const coords = ( plot as GisPlotArrow ).generateCoords() as LonLatPoint[];
				if ( coords.length < 3 ) {
					return null;
				}
				const o = base as PlotArrowOptions;
				return new CesiumGroundPolygonPrimitive( {
					classificationType: base.classificationType,
					points: coords,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'line': {
				if ( pts.length < 2 ) return null;
				const o = base as PlotLineOptions;
				const start = o.startArrowStyle ?? null;
				const end = o.endArrowStyle ?? null;
				const arrowMode: CesiumGroundArrowMode =
					( start !== null && end !== null ) ? 'both'
						: ( end !== null ) ? 'right'
							: ( start !== null ) ? 'left'
								: 'none';
				// 起 / 终端各自映射样式——**不再用 `start ?? end` 折叠成一个样式**
				// （那会让 filledArrow + unfilledArrow 两端渲染成同一种箭头）。
				// 未启用的那端样式无所谓（arrowMode 不含该端就不渲染），给 'solid' 占位。
				const startArrowStyle: CesiumGroundArrowStyle =
					start === 'unfilledArrow' ? 'open' : 'solid';
				const endArrowStyle: CesiumGroundArrowStyle =
					end === 'unfilledArrow' ? 'open' : 'solid';
				const isDash = o.strokeStyle === 'dashed';
				const dashLengthMeters = isDash ? 60 : undefined;
				const gapLengthMeters = isDash ? 40 : undefined;
				const widthMeters = typeof o.strokeWidth === 'number' && o.strokeWidth > 0
					? o.strokeWidth
					: 5;
				const { lengthMeters, widthMetersArrow } = arrowSizeFromStrokeMeters( widthMeters );
				return new CesiumGroundPolylinePrimitive( {
					classificationType: base.classificationType,
					points: pts,
					strokeColor: o.strokeColor,
					strokeOpacity,
					widthMode: 'world',
					widthMeters,
					visible,
					arrowMode,
					startArrowStyle,
					endArrowStyle,
					arrowWidthMode: 'world',
					arrowLengthMeters: lengthMeters,
					arrowWidthMeters: widthMetersArrow,
					dashLengthMeters,
					gapLengthMeters,
					renderOrder,
				} );
			}

			case 'text': {
				if ( pts.length === 0 ) return null;
				const t = base as PlotTextOptions;
				return new CesiumGroundTextPrimitive( {
					classificationType: base.classificationType,
					points: [ pts[ 0 ] ],
					content: t.content,
					fontColor: t.fontColor,
					fontSize: t.fontSize,
					fillColor: t.fillColor,
					fillOpacity,
					strokeColor: t.strokeColor,
					strokeOpacity,
					strokeWidth: t.strokeWidth ?? 0,
					textAlign: t.textAlign,
					verticalAlign: t.verticalAlign,
					anchorX: t.anchorX,
					anchorY: t.anchorY,
					layoutDirection: t.layoutDirection,
					rotation: t.rotation,
					boxWidth: t.boxWidth,
					boxHeight: t.boxHeight,
					padding: t.padding,
					showBorder: t.showBorder,
					visible,
					renderOrder,
					// 参考侧 offsetX / offsetY 映射为 c2t ENU 米制偏移。
					offsetEastMeters: t.offsetX,
					offsetNorthMeters: t.offsetY,
					// 参考侧 scale 映射为 c2t metersPerPixel；缺省时由文字图元使用 1.0。
					metersPerPixel: t.scale,
				} );
			}

			default:
				return null;
		}
	}
}
