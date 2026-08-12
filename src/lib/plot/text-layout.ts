export interface PlotTextLayoutInput {
	readonly content: string;
	readonly fontSize: number;
	readonly boxWidth?: number;
	readonly boxHeight?: number;
	readonly padding?: number | readonly [ number, number, number, number ];
	readonly layoutDirection?: 'horizontal' | 'vertical-rl' | 'vertical-lr';
}

export interface PlotTextPadding {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export interface PlotTextLayout {
	readonly width: number;
	readonly height: number;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly lines: readonly string[];
	readonly columns: readonly ( readonly string[] )[];
	readonly direction: NonNullable<PlotTextLayoutInput[ 'layoutDirection' ]>;
	readonly padding: PlotTextPadding;
}

export type PlotTextMeasure = ( text: string, fontSize: number ) => number;

/** 显示纹理与拾取平面共用的唯一文本框排版计算。 */
export function measurePlotTextLayout(
	input: PlotTextLayoutInput,
	measure: PlotTextMeasure,
): PlotTextLayout {
	const padding = normalizePlotTextPadding( input.padding );
	const fontSize = Math.max( input.fontSize, 1 );
	const lines = Object.freeze( String( input.content ).split( /\r\n?|\n/g ) );
	const lineHeight = fontSize * 1.2;
	const direction = input.layoutDirection ?? 'horizontal';
	const columns = Object.freeze( lines.map( ( line ) => Object.freeze( Array.from( line ) ) ) );
	const vertical = direction !== 'horizontal';
	// 贴地文本逐字符绘制，因此宽度也必须逐字符累计；整行 measureText 会引入
	// kerning，令拾取框与真实纹理在 AV 等组合处产生尺寸差异。
	const measuredWidth = Math.max( 1, ...columns.map( ( characters ) =>
		characters.reduce( ( width, character ) => width + measure( character, fontSize ), 0 ),
	) );
	const autoWidth = vertical
		? Math.ceil( lineHeight * Math.max( columns.length, 1 ) + padding.left + padding.right )
		: Math.ceil( measuredWidth + padding.left + padding.right );
	const autoHeight = vertical
		? Math.ceil( fontSize * Math.max( 1, ...columns.map( ( column ) => column.length ) )
			+ padding.top + padding.bottom )
		: Math.ceil( lineHeight * Math.max( lines.length, 1 ) + padding.top + padding.bottom );
	return Object.freeze( {
		width: Math.max( 1, Math.ceil( input.boxWidth && input.boxWidth > 0
			? input.boxWidth : autoWidth ) ),
		height: Math.max( 1, Math.ceil( input.boxHeight && input.boxHeight > 0
			? input.boxHeight : autoHeight ) ),
		fontSize,
		lineHeight,
		lines,
		columns,
		direction,
		padding,
	} );
}

export function normalizePlotTextPadding(
	padding: PlotTextLayoutInput[ 'padding' ],
): PlotTextPadding {
	if ( Array.isArray( padding ) ) return Object.freeze( {
		top: Math.max( padding[ 0 ] ?? 0, 0 ),
		right: Math.max( padding[ 1 ] ?? 0, 0 ),
		bottom: Math.max( padding[ 2 ] ?? 0, 0 ),
		left: Math.max( padding[ 3 ] ?? 0, 0 ),
	} );
	const value = Math.max( typeof padding === 'number' ? padding : 4, 0 );
	return Object.freeze( { top: value, right: value, bottom: value, left: value } );
}
