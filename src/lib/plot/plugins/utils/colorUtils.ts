// ============================================================
// colorUtils.ts — 颜色与不透明度解析工具
// 层级：L1（utils 工具层，零依赖）
// 职责：把 CSS 颜色字符串解析为归一化 RGBA；把 0..100 百分比不透明度
//       与旧版 0..1 opacity 兼容地解析为 0..1。
// 依赖：无。
// 被消费：参考项目 RTT/SDF 着色器；在 c2t 路径上保留导出供业务使用，
//       桥接器渲染热路径不调用这两个函数（直接透传 0..100 给 c2t 图元）。
// ============================================================

/**
 * 归一化 RGBA：各分量 ∈ [0, 1]。
 */
export type NormalizedRGBA = readonly [ number, number, number, number ];

/**
 * resolveOpacity 的输入对象，描述一个样式所携带的不透明度字段。
 *   - fillOpacity / strokeOpacity：0..100 整数百分比（推荐）。
 *   - opacity：0..1 浮点（旧版，同时作用于 fill 与 stroke）。
 */
export interface StyleOpacityInput {
	fillOpacity?: number;
	strokeOpacity?: number;
	opacity?: number;
}

/**
 * 把 CSS 颜色字符串解析为归一化 RGBA `[r, g, b, a]`（各 ∈ [0, 1]）。
 *
 * 支持格式：
 *   - `#hex`（3 位或 6 位）
 *   - `rgb(r, g, b)`（分量 0–255）
 *   - `rgba(r, g, b, a)`（a ∈ [0, 1]）
 *   - `'transparent'` / `null` / `undefined` / 空串 → `[0, 0, 0, 0]`
 *   - 无法识别 → 回退不透明白 `[1, 1, 1, 1]`
 *
 * 解析顺序：先匹配 rgb/rgba 正则，再判断 `#` 前缀。
 *
 * @param color CSS 颜色字符串。
 * @returns 归一化 RGBA 四元数组。
 */
export function parseColorToRGBA( color: string | null | undefined ): number[] {
	if ( color === null || color === undefined ) {
		return [ 0, 0, 0, 0 ];
	}
	const trimmed = String( color ).trim().toLowerCase();
	if ( trimmed === '' || trimmed === 'transparent' ) {
		return [ 0, 0, 0, 0 ];
	}

	// rgba(r, g, b, a)
	const rgbaMatch = /^rgba\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/.exec( trimmed );
	if ( rgbaMatch !== null ) {
		const r = Number( rgbaMatch[ 1 ] ) / 255;
		const g = Number( rgbaMatch[ 2 ] ) / 255;
		const b = Number( rgbaMatch[ 3 ] ) / 255;
		const a = Number( rgbaMatch[ 4 ] );
		return [ clamp01( r ), clamp01( g ), clamp01( b ), clamp01( a ) ];
	}

	// rgb(r, g, b)
	const rgbMatch = /^rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)$/.exec( trimmed );
	if ( rgbMatch !== null ) {
		const r = Number( rgbMatch[ 1 ] ) / 255;
		const g = Number( rgbMatch[ 2 ] ) / 255;
		const b = Number( rgbMatch[ 3 ] ) / 255;
		return [ clamp01( r ), clamp01( g ), clamp01( b ), 1 ];
	}

	// #hex
	if ( trimmed.startsWith( '#' ) ) {
		const hex = trimmed.slice( 1 );
		if ( hex.length === 3 ) {
			const r = parseInt( hex[ 0 ] + hex[ 0 ], 16 ) / 255;
			const g = parseInt( hex[ 1 ] + hex[ 1 ], 16 ) / 255;
			const b = parseInt( hex[ 2 ] + hex[ 2 ], 16 ) / 255;
			if ( Number.isFinite( r ) && Number.isFinite( g ) && Number.isFinite( b ) ) {
				return [ r, g, b, 1 ];
			}
		} else if ( hex.length === 6 ) {
			const r = parseInt( hex.slice( 0, 2 ), 16 ) / 255;
			const g = parseInt( hex.slice( 2, 4 ), 16 ) / 255;
			const b = parseInt( hex.slice( 4, 6 ), 16 ) / 255;
			if ( Number.isFinite( r ) && Number.isFinite( g ) && Number.isFinite( b ) ) {
				return [ r, g, b, 1 ];
			}
		} else if ( hex.length === 8 ) {
			const r = parseInt( hex.slice( 0, 2 ), 16 ) / 255;
			const g = parseInt( hex.slice( 2, 4 ), 16 ) / 255;
			const b = parseInt( hex.slice( 4, 6 ), 16 ) / 255;
			const a = parseInt( hex.slice( 6, 8 ), 16 ) / 255;
			if (
				Number.isFinite( r ) && Number.isFinite( g ) &&
				Number.isFinite( b ) && Number.isFinite( a )
			) {
				return [ r, g, b, a ];
			}
		}
	}

	// 回退：不透明白
	return [ 1, 1, 1, 1 ];
}

/**
 * 把不透明度写进长度为 2 的输出数组：
 *   - base[0] = 填充不透明度（0..1）
 *   - base[1] = 描边不透明度（0..1）
 *
 * 兼容规则（逐通道独立判定）：
 *   1. 有 fillOpacity（0..100）  → base[0] = fillOpacity / 100
 *   2. 否则有 opacity（0..1）    → base[0] = opacity
 *   3. 否则                       → base[0] = 1
 *
 *   strokeOpacity 同理写 base[1]。
 *
 * @param style 携带不透明度字段的样式对象。
 * @param base  长度为 2 的输出数组（[fillAlpha, strokeAlpha]，单位 0..1）。
 */
export function resolveOpacity(
	style: StyleOpacityInput,
	base: [ number, number ],
): void {
	if ( typeof style.fillOpacity === 'number' && Number.isFinite( style.fillOpacity ) ) {
		base[ 0 ] = clamp01( style.fillOpacity / 100 );
	} else if ( typeof style.opacity === 'number' && Number.isFinite( style.opacity ) ) {
		base[ 0 ] = clamp01( style.opacity );
	} else {
		base[ 0 ] = 1;
	}

	if ( typeof style.strokeOpacity === 'number' && Number.isFinite( style.strokeOpacity ) ) {
		base[ 1 ] = clamp01( style.strokeOpacity / 100 );
	} else if ( typeof style.opacity === 'number' && Number.isFinite( style.opacity ) ) {
		base[ 1 ] = clamp01( style.opacity );
	} else {
		base[ 1 ] = 1;
	}
}

/**
 * 将数值钳位到 [0, 1] 闭区间。
 *
 * @param value 待钳位的浮点数。
 * @returns [0, 1] 范围内的值。
 */
function clamp01( value: number ): number {
	if ( ! Number.isFinite( value ) ) {
		return 0;
	}
	if ( value < 0 ) return 0;
	if ( value > 1 ) return 1;
	return value;
}
