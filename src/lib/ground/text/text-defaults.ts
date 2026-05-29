// ============================================================
// text-defaults.ts
// 层级：L1（依赖 L0 类型）
// 职责：把外部 PlotTextOptions 解析为 ResolvedPlotTextOptions；锚点经纬度、
//       字号、必填颜色非空在此校验抛错；枚举非法落 fallback；数值填默认值；
//       rotation 度→弧度；padding 拆四元组；opacity 钳 [0,100]。
// 依赖：text-types。
// 被消费：text-primitive 构造 / setText。
// ============================================================

import type {
	PlotTextAlign,
	PlotTextAnchorX,
	PlotTextAnchorY,
	PlotTextBoxOverflow,
	PlotTextLayoutDirection,
	PlotTextOptions,
	PlotTextVerticalAlign,
	ResolvedPlotTextOptions,
} from './text-types';

const DEFAULT_FONT_FAMILY = 'sans-serif';
const DEFAULT_LINE_HEIGHT = 1.2;          // CSS line-height 经验默认
const DEFAULT_FONT_WEIGHT: 'normal' = 'normal';
const DEFAULT_METERS_PER_PIXEL = 1.0;      // 1 纹素 = 1 米足迹
const DEFAULT_RENDER_ORDER = 10;           // 与 rectangle 默认一致
const DEG_TO_RAD = Math.PI / 180.0;        // 度→弧度

const ALLOWED_TEXT_ALIGN: ReadonlyArray<PlotTextAlign> = [ 'left', 'center', 'right' ];
const ALLOWED_VERTICAL_ALIGN: ReadonlyArray<PlotTextVerticalAlign> = [ 'top', 'middle', 'bottom' ];
const ALLOWED_ANCHOR_X: ReadonlyArray<PlotTextAnchorX> = [ 'left', 'center', 'right' ];
const ALLOWED_ANCHOR_Y: ReadonlyArray<PlotTextAnchorY> = [ 'top', 'middle', 'bottom' ];
const ALLOWED_LAYOUT: ReadonlyArray<PlotTextLayoutDirection> = [
	'horizontal', 'vertical-rl', 'vertical-lr',
];
const ALLOWED_OVERFLOW: ReadonlyArray<PlotTextBoxOverflow> = [ 'clip', 'visible' ];

/**
 * 把 PlotTextOptions 解析为 ResolvedPlotTextOptions。
 *
 * 校验顺序：先锚点（缺则下游全废）→ 必填内容 / 字号 / 颜色 → 枚举 fallback →
 * 数值默认值。任何硬错误 throw new Error。
 *
 * @param options 外部选项。
 * @returns       解析后不可变配置（每次新建对象）。
 */
export function resolvePlotTextOptions(
	options: PlotTextOptions,
): ResolvedPlotTextOptions {
	// ── 锚点 ──
	if ( ! options.points || options.points.length < 1 || ! options.points[ 0 ] ) {
		throw new Error( 'PlotText requires points[ 0 ] as anchor lon/lat point.' );
	}
	const longitude = options.points[ 0 ][ 0 ];
	const latitude = options.points[ 0 ][ 1 ];
	if (
		! Number.isFinite( longitude ) ||
		! Number.isFinite( latitude ) ||
		longitude < -180.0 ||
		longitude > 180.0 ||
		latitude < -90.0 ||
		latitude > 90.0
	) {
		throw new Error( 'PlotText anchor must be a valid WGS84 [lon, lat] in degrees.' );
	}

	// ── 必填 ──
	if ( typeof options.content !== 'string' || options.content.length === 0 ) {
		throw new Error( 'PlotText.content must be a non-empty string.' );
	}
	if ( ! Number.isFinite( options.fontSize ) || options.fontSize <= 0 ) {
		throw new Error( 'PlotText.fontSize must be a positive finite number (texel px).' );
	}
	if ( typeof options.fontColor !== 'string' || options.fontColor.length === 0 ) {
		throw new Error( 'PlotText.fontColor must be a non-empty CSS color string.' );
	}
	if ( typeof options.strokeColor !== 'string' || options.strokeColor.length === 0 ) {
		throw new Error( 'PlotText.strokeColor must be a non-empty CSS color string.' );
	}
	if ( typeof options.fillColor !== 'string' || options.fillColor.length === 0 ) {
		throw new Error( 'PlotText.fillColor must be a non-empty CSS color string.' );
	}

	// ── 枚举 fallback ──
	const textAlign = enumOr( options.textAlign, ALLOWED_TEXT_ALIGN, 'left' );
	const verticalAlign = enumOr( options.verticalAlign, ALLOWED_VERTICAL_ALIGN, 'middle' );
	const anchorX = enumOr( options.anchorX, ALLOWED_ANCHOR_X, 'center' );
	const anchorY = enumOr( options.anchorY, ALLOWED_ANCHOR_Y, 'middle' );
	const layoutDirection = enumOr( options.layoutDirection, ALLOWED_LAYOUT, 'horizontal' );
	const boxOverflow = enumOr( options.boxOverflow, ALLOWED_OVERFLOW, 'clip' );

	// ── padding 四元组 ──
	const padding = resolvePadding( options.padding );

	return {
		anchorLonDegrees: longitude,
		anchorLatDegrees: latitude,
		content: options.content,
		visible: options.visible !== false,

		fontColor: options.fontColor,
		fontSize: options.fontSize,
		fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
		fontWeight: options.fontWeight ?? DEFAULT_FONT_WEIGHT,
		fontStrokeColor: options.fontStrokeColor ?? null,
		fontStrokeWidth: nonNegativeOr( options.fontStrokeWidth, 0.0 ),
		fontStrokeOpacity: clamp0to100( options.fontStrokeOpacity ?? 100.0 ),
		lineHeight: positiveOr( options.lineHeight, DEFAULT_LINE_HEIGHT ),
		letterSpacing: numberOr( options.letterSpacing, 0.0 ),

		fillColor: options.fillColor,
		fillOpacity: clamp0to100( options.fillOpacity ),
		showBorder: options.showBorder !== false,
		strokeColor: options.strokeColor,
		strokeWidth: nonNegativeOr( options.strokeWidth, 0.0 ),
		strokeOpacity: clamp0to100( options.strokeOpacity ),
		cornerRadius: nonNegativeOr( options.cornerRadius, 0.0 ),
		paddingTop: padding[ 0 ],
		paddingRight: padding[ 1 ],
		paddingBottom: padding[ 2 ],
		paddingLeft: padding[ 3 ],

		textAlign,
		verticalAlign,
		boxWidthCssPx: positiveOrNull( options.boxWidth ),
		boxHeightCssPx: positiveOrNull( options.boxHeight ),
		boxOverflow,
		layoutDirection,

		metersPerPixel: positiveOr( options.metersPerPixel, DEFAULT_METERS_PER_PIXEL ),
		anchorX,
		anchorY,
		offsetEastMeters: numberOr( options.offsetEastMeters, 0.0 ),
		offsetNorthMeters: numberOr( options.offsetNorthMeters, 0.0 ),
		// 度→弧度，保留北向顺时针方向；ENU 数学的方向转换留给 text-placement
		rotationRadians: numberOr( options.rotation, 0.0 ) * DEG_TO_RAD,

		renderOrder: Number.isFinite( options.renderOrder )
			? Math.max( Math.round( options.renderOrder as number ), 0 )
			: DEFAULT_RENDER_ORDER,
		minimumHeight: Number.isFinite( options.minimumHeight )
			? ( options.minimumHeight as number )
			: null,
		maximumHeight: Number.isFinite( options.maximumHeight )
			? ( options.maximumHeight as number )
			: null,
	};
}

/**
 * 把 padding 标准化为非负 [top, right, bottom, left]。
 *
 * @param padding 单值 / 四元组 / undefined。
 * @returns       非负四元组。
 */
function resolvePadding(
	padding: PlotTextOptions[ 'padding' ],
): [ number, number, number, number ] {
	if ( padding == null ) {
		return [ 0.0, 0.0, 0.0, 0.0 ];
	}
	if ( typeof padding === 'number' ) {
		const v = Math.max( padding, 0.0 );
		return [ v, v, v, v ];
	}
	return [
		Math.max( padding[ 0 ], 0.0 ),
		Math.max( padding[ 1 ], 0.0 ),
		Math.max( padding[ 2 ], 0.0 ),
		Math.max( padding[ 3 ], 0.0 ),
	];
}

/** 枚举兜底：非法或缺省落 fallback。 */
function enumOr<T extends string>(
	value: T | undefined,
	allowed: ReadonlyArray<T>,
	fallback: T,
): T {
	return value != null && allowed.indexOf( value ) >= 0 ? value : fallback;
}

/** 有限数兜底（NaN/Infinity/undefined → fallback）。 */
function numberOr( value: number | undefined, fallback: number ): number {
	return value != null && Number.isFinite( value ) ? value : fallback;
}

/** 正数兜底（仅 > 0 采用）。 */
function positiveOr( value: number | undefined, fallback: number ): number {
	return value != null && Number.isFinite( value ) && value > 0.0 ? value : fallback;
}

/** 正数或 null（boxWidth/boxHeight：区分自适应与非法）。 */
function positiveOrNull( value: number | undefined ): number | null {
	return value != null && Number.isFinite( value ) && value > 0.0 ? value : null;
}

/** 非负数兜底（>= 0 采用）。 */
function nonNegativeOr( value: number | undefined, fallback: number ): number {
	return value != null && Number.isFinite( value ) && value >= 0.0 ? value : fallback;
}

/** 钳到 [0,100]；NaN → 100（与 normalizePercentOpacity 一致）。 */
function clamp0to100( value: number ): number {
	if ( ! Number.isFinite( value ) ) {
		return 100.0;
	}
	return Math.min( Math.max( value, 0.0 ), 100.0 );
}
