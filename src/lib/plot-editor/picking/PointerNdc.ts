import { Vector2 } from 'three';

export interface CssViewportRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/**
 * 把浏览器 client 坐标转换为 Three NDC。
 * 这里只使用 CSS 边界；drawing buffer 与 devicePixelRatio 不参与该换算。
 */
export function clientPointToNdc(
	clientX: number,
	clientY: number,
	viewport: CssViewportRect,
	out = new Vector2(),
): Vector2 | null {
	if ( ! Number.isFinite( clientX ) || ! Number.isFinite( clientY )
		|| ! Number.isFinite( viewport.left ) || ! Number.isFinite( viewport.top )
		|| ! Number.isFinite( viewport.width ) || ! Number.isFinite( viewport.height )
		|| viewport.width <= 0 || viewport.height <= 0 ) return null;
	const x = ( clientX - viewport.left ) / viewport.width;
	const y = ( clientY - viewport.top ) / viewport.height;
	if ( x < 0 || x > 1 || y < 0 || y > 1 ) return null;
	return out.set( x * 2 - 1, - y * 2 + 1 );
}
