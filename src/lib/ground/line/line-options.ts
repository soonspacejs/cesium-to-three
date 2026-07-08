// ============================================================
// line/line-options.ts — 贴地线选项校验与默认值
// 层级：L4（贴地线几何子模块）。
// 职责：把公开 `CesiumGroundPolylineOptions` 转成 `LineShadowVolumeOptions`，
//        填默认值并做严格校验（不静默纠正）。也提供把外部 `arcType` 字符串
//        映射成内部枚举的 `parseArcType`。
// 依赖：constants.ts、line-types.ts、types.ts。
// 被消费：primitives.ts CesiumGroundPolylinePrimitive 构造期、单测。
// 算法对应：Cesium `GroundPolylineGeometry` 构造期校验 + Defaults。
// ============================================================

import {
	LINE_DEFAULT_GRANULARITY,
	LINE_DEFAULT_RENDER_ORDER,
	LINE_DEFAULT_WIDTH_PIXELS,
} from '../constants';
import type {
	CesiumGroundArcType,
	CesiumGroundArrowMode,
	CesiumGroundArrowStyle,
	CesiumGroundLineWidthMode,
	CesiumGroundPolylineOptions,
	LonLatPoint,
} from '../types';

import { ARROW_MODE, ARROW_STYLE_ID, type ArrowMode, type ArrowStyle } from './line-arrowhead';
import { ArcType, LineWidthMode, type LineShadowVolumeOptions } from './line-types';

/** 解析后的公开选项（含全部已填默认值与字符串→枚举映射）。 */
export interface ResolvedLineOptions {
	points: LonLatPoint[];
	loop: boolean;
	arcType: ArcType;
	granularityRadians: number;
	minimumHeight: number;
	maximumHeight: number;
	widthMode: LineWidthMode;
	widthPixels: number;
	widthMeters: number;
	renderOrder: number;
	visible: boolean;
	strokeColor: string;
	strokeOpacity: number;
	dashLengthMeters: number;
	gapLengthMeters: number;
	dashEnabled: boolean;
	debugVolume: boolean;
	arrowMode: ArrowMode;
	/** 起点端箭头样式（已把缺省回退到 `arrowStyle` 解析完毕）。 */
	arrowStartStyle: ArrowStyle;
	/** 终点端箭头样式（已把缺省回退到 `arrowStyle` 解析完毕）。 */
	arrowEndStyle: ArrowStyle;
	arrowWidthMode: LineWidthMode;
	arrowLengthPixels: number;
	arrowWidthPixels: number;
	arrowLengthMeters: number;
	arrowWidthMeters: number;
	arrowColor: string | undefined;
	arrowOpacity: number | undefined;
	arrowStrokeWidthPixels: number;
}

/** 字符串 arcType → 内部枚举。未识别值抛错（绝不静默回退到 geodesic）。 */
export function parseArcType( value: CesiumGroundArcType | undefined ): ArcType {
	if ( value === undefined || value === 'geodesic' ) {
		return ArcType.GEODESIC;
	}
	if ( value === 'none' ) {
		return ArcType.NONE;
	}
	if ( value === 'rhumb' ) {
		return ArcType.RHUMB;
	}
	throw new Error( `Unknown CesiumGroundPolyline arcType: "${ String( value ) }".` );
}

/** 字符串 widthMode → 内部枚举。 */
export function parseWidthMode(
	value: CesiumGroundLineWidthMode | undefined,
): LineWidthMode {
	if ( value === undefined || value === 'screen' ) {
		return LineWidthMode.SCREEN;
	}
	if ( value === 'world' ) {
		return LineWidthMode.WORLD;
	}
	throw new Error( `Unknown CesiumGroundPolyline widthMode: "${ String( value ) }".` );
}

/** 字符串 arrowMode → 内部枚举。 */
export function parseArrowMode(
	value: CesiumGroundArrowMode | undefined,
): ArrowMode {
	if ( value === undefined || value === 'none' ) {
		return ARROW_MODE.NONE;
	}
	if ( value === 'left' ) {
		return ARROW_MODE.LEFT;
	}
	if ( value === 'right' ) {
		return ARROW_MODE.RIGHT;
	}
	if ( value === 'both' ) {
		return ARROW_MODE.BOTH;
	}
	throw new Error( `Unknown CesiumGroundPolyline arrowMode: "${ String( value ) }".` );
}

/**
 * 字符串 arrowStyle → 内部联合。缺省回退 'solid'。
 *
 * 按 `ARROW_STYLE_ID` 成员判定，而非逐个硬编码 'solid'/'open'——否则这里会成为
 * 「静默拦住新样式」的硬门：新增样式时只改 `CesiumGroundArrowStyle` + `ARROW_STYLE_ID`
 * 即自动放行，不必再回头改本函数。用 hasOwnProperty 避免命中原型链上的键
 * （如 'toString'）。
 */
export function parseArrowStyle(
	value: CesiumGroundArrowStyle | undefined,
): ArrowStyle {
	if ( value === undefined ) {
		return 'solid';
	}
	if ( Object.prototype.hasOwnProperty.call( ARROW_STYLE_ID, value ) ) {
		return value;
	}
	throw new Error( `Unknown CesiumGroundPolyline arrowStyle: "${ String( value ) }".` );
}

/**
 * 校验 + 默认值。逐字对应 doc 09 §1.1 / §6 与 doc 10 §3。
 *
 * @param options 公开选项。
 * @returns       已解析的内部选项（字段全部填齐，可直接给几何 facade）。
 * @throws        Error：违规字段会一次性抛出（详细原因）。
 */
export function resolvePublicLineOptions(
	options: CesiumGroundPolylineOptions,
): ResolvedLineOptions {
	if ( ! options || ! Array.isArray( options.points ) || options.points.length < 2 ) {
		throw new Error(
			'CesiumGroundPolylineOptions.points must contain ≥ 2 [lon, lat] entries.',
		);
	}

	// 校验每个点都是 [lon∈[-180,180], lat∈[-90,90]]（度），并复制成新数组防止
	// 调用方在我们持有过程中改它。
	const points: LonLatPoint[] = [];
	for ( let i = 0; i < options.points.length; i++ ) {
		const p = options.points[ i ];
		if (
			! Array.isArray( p ) ||
			p.length < 2 ||
			! Number.isFinite( p[ 0 ] ) ||
			! Number.isFinite( p[ 1 ] ) ||
			p[ 0 ] < - 180.0 ||
			p[ 0 ] > 180.0 ||
			p[ 1 ] < - 90.0 ||
			p[ 1 ] > 90.0
		) {
			throw new Error(
				`CesiumGroundPolylineOptions.points[${ i }] must be [lon∈[-180,180], lat∈[-90,90]].`,
			);
		}
		points.push( [ p[ 0 ], p[ 1 ] ] );
	}

	const arcType = parseArcType( options.arcType );

	const granularityRadiansRaw = options.granularityRadians ?? LINE_DEFAULT_GRANULARITY;
	if ( ! Number.isFinite( granularityRadiansRaw ) || granularityRadiansRaw <= 0.0 ) {
		throw new Error(
			'CesiumGroundPolylineOptions.granularityRadians must be > 0.',
		);
	}

	// 高度兜底：仅当 ApproximateTerrainHeights 未初始化时生效（line-segment-
	// attributes.ts 优先使用 terrain table 的 tight 范围）。默认 ±1000 m 足以
	// 覆盖典型 demo terrain；mountainous demo 调用方可覆盖。**与 polygon /
	// rectangle / circle 用 ±55 km 的硬编码方案不同**——线走 depth-reconstruction
	// 单 pass，box 顶高过相机会触发 near-plane clipping → 断线，所以这里不能
	// 沿用面图元的 ±55 km。
	let minimumHeight = options.minimumHeight ?? - 1000.0;
	let maximumHeight = options.maximumHeight ?? 1000.0;
	if ( ! Number.isFinite( minimumHeight ) || ! Number.isFinite( maximumHeight ) ) {
		throw new Error(
			'CesiumGroundPolylineOptions.minimum/maximumHeight must be finite.',
		);
	}
	if ( maximumHeight <= minimumHeight ) {
		// 复用其它图元的兜底（doc 04 §10）：max <= min → max = min + 1，避免
		// 标准墙 adjustHeights 推到反方向的退化。
		maximumHeight = minimumHeight + 1.0;
	}

	const widthMode = parseWidthMode( options.widthMode );

	const widthPixels = options.widthPixels ?? LINE_DEFAULT_WIDTH_PIXELS;
	if ( widthMode === LineWidthMode.SCREEN ) {
		if ( ! Number.isFinite( widthPixels ) || widthPixels <= 0.0 ) {
			throw new Error(
				'CesiumGroundPolylineOptions.widthPixels must be > 0 in widthMode="screen".',
			);
		}
	}

	const widthMeters = options.widthMeters ?? 5.0;
	if ( widthMode === LineWidthMode.WORLD ) {
		if ( ! Number.isFinite( widthMeters ) || widthMeters <= 0.0 ) {
			throw new Error(
				'CesiumGroundPolylineOptions.widthMeters must be > 0 in widthMode="world".',
			);
		}
	}

	let loop = options.loop === true;
	// 2 点强制 false——首末点重合的「环」是退化输入，与 Cesium 行为一致。
	if ( loop && points.length === 2 ) {
		loop = false;
	}

	if (
		! Number.isFinite( options.strokeOpacity ) ||
		options.strokeOpacity < 0.0 ||
		options.strokeOpacity > 100.0
	) {
		throw new Error(
			'CesiumGroundPolylineOptions.strokeOpacity must be a number in [0, 100].',
		);
	}

	const dashLengthMeters = options.dashLengthMeters ?? 0.0;
	const gapLengthMeters = options.gapLengthMeters ?? 0.0;
	const dashEnabled = dashLengthMeters > 0.0 && gapLengthMeters > 0.0;

	// ── 箭头选项 ──
	const arrowMode = parseArrowMode( options.arrowMode );
	// `arrowStyle` 是两端统一默认；`startArrowStyle` / `endArrowStyle` 各自覆盖。
	// 缺省的那端回退到 `arrowStyle`（再缺省即 'solid'），从而两端可独立设样式。
	const arrowStyleDefault = parseArrowStyle( options.arrowStyle );
	const arrowStartStyle = options.startArrowStyle !== undefined
		? parseArrowStyle( options.startArrowStyle )
		: arrowStyleDefault;
	const arrowEndStyle = options.endArrowStyle !== undefined
		? parseArrowStyle( options.endArrowStyle )
		: arrowStyleDefault;
	// 箭头尺寸模式：默认 'world'（世界米恒定，与线/面 world 模式视觉一致——
	// 远小近大跟相机透视）。要像素恒定（Cesium Billboard sizeInMeters=false
	// 同义）显式传 'screen'。与线 widthMode 独立可设。
	const arrowWidthMode = parseWidthMode( options.arrowWidthMode ?? 'world' );
	// 箭头尺寸默认硬编码（screen 18×16 px / world 30×24 m）。**业务层**自己根据
	// 线宽决定合适比例（大宽线要大箭头、细线要小箭头）——库层不假设业务比例。
	const arrowLengthPixels = options.arrowLengthPixels ?? 18.0;
	const arrowWidthPixels = options.arrowWidthPixels ?? 16.0;
	const arrowLengthMeters = options.arrowLengthMeters ?? 30.0;
	const arrowWidthMeters = options.arrowWidthMeters ?? 24.0;
	const arrowStrokeWidthPixels = options.arrowStrokeWidthPixels ?? 3.0;
	if ( arrowMode !== ARROW_MODE.NONE ) {
		const checks: Array<[ string, number ]> = [
			[ 'arrowLengthPixels', arrowLengthPixels ],
			[ 'arrowWidthPixels', arrowWidthPixels ],
			[ 'arrowLengthMeters', arrowLengthMeters ],
			[ 'arrowWidthMeters', arrowWidthMeters ],
		];
		for ( const [ name, v ] of checks ) {
			if ( ! Number.isFinite( v ) || v <= 0.0 ) {
				throw new Error(
					`CesiumGroundPolylineOptions.${ name } must be > 0 when arrowMode is set.`,
				);
			}
		}
		if (
			options.arrowOpacity !== undefined && (
				! Number.isFinite( options.arrowOpacity ) ||
				options.arrowOpacity < 0.0 ||
				options.arrowOpacity > 100.0
			)
		) {
			throw new Error(
				'CesiumGroundPolylineOptions.arrowOpacity must be in [0, 100].',
			);
		}
		if (
			( arrowStartStyle === 'open' || arrowEndStyle === 'open' ) && (
				! Number.isFinite( arrowStrokeWidthPixels ) ||
				arrowStrokeWidthPixels <= 0.0
			)
		) {
			throw new Error(
				'CesiumGroundPolylineOptions.arrowStrokeWidthPixels must be > 0 when any arrow end is "open".',
			);
		}
	}

	return {
		points,
		loop,
		arcType,
		granularityRadians: granularityRadiansRaw,
		minimumHeight,
		maximumHeight,
		widthMode,
		widthPixels,
		widthMeters,
		renderOrder: Number.isFinite( options.renderOrder )
			? ( options.renderOrder as number )
			: LINE_DEFAULT_RENDER_ORDER,
		visible: options.visible !== false,
		strokeColor: options.strokeColor,
		strokeOpacity: options.strokeOpacity,
		dashLengthMeters,
		gapLengthMeters,
		dashEnabled,
		debugVolume: options.debugVolume === true,
		arrowMode,
		arrowStartStyle,
		arrowEndStyle,
		arrowWidthMode,
		arrowLengthPixels,
		arrowWidthPixels,
		arrowLengthMeters,
		arrowWidthMeters,
		arrowColor: options.arrowColor,
		arrowOpacity: options.arrowOpacity,
		arrowStrokeWidthPixels,
	};
}

/**
 * 取出几何 facade 需要的 sub-set，避免传递与几何无关的颜色 / dash 字段。
 */
export function toLineShadowVolumeOptions(
	resolved: ResolvedLineOptions,
): LineShadowVolumeOptions {
	return {
		points: resolved.points,
		loop: resolved.loop,
		arcType: resolved.arcType,
		granularity: resolved.granularityRadians,
		minimumHeight: resolved.minimumHeight,
		maximumHeight: resolved.maximumHeight,
	};
}
