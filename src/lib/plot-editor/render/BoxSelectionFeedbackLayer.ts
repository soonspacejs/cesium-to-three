import {
	BufferAttribute,
	BufferGeometry,
	Color,
	GLSL3,
	Group,
	Mesh,
	RawShaderMaterial,
	Vector4,
} from 'three';
import type { ScreenPoint } from '../state/types';
import { EditorOverlayLayer } from './layers';

export interface BoxSelectionFeedback {
	readonly start: ScreenPoint;
	readonly current: ScreenPoint;
	readonly additive: boolean;
	readonly valid: boolean;
	readonly visible?: boolean;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }
`;

/** CSS 屏幕坐标下的框选填充/边框；完全绕过 camera 矩阵和业务拾取。 */
export class BoxSelectionFeedbackLayer {
	public readonly root = new Group();
	private readonly _fillGeometry = geometryWithVertexCount( 6 );
	private readonly _borderGeometry = geometryWithVertexCount( 24 );
	private readonly _fillMaterial = feedbackMaterial();
	private readonly _borderMaterial = feedbackMaterial();
	private readonly _fill = new Mesh( this._fillGeometry, this._fillMaterial );
	private readonly _border = new Mesh( this._borderGeometry, this._borderMaterial );
	private _description: BoxSelectionFeedback | null = null;
	private _viewportCss: readonly [ number, number ] | null = null;
	private _disposed = false;

	public constructor() {
		this.root.name = 'boxSelectionFeedbackRoot';
		this.root.layers.set( EditorOverlayLayer.PLOT_FEEDBACK );
		for ( const mesh of [ this._fill, this._border ] ) {
			mesh.layers.set( EditorOverlayLayer.PLOT_FEEDBACK );
			mesh.frustumCulled = false;
			mesh.renderOrder = 20_000;
			mesh.visible = false;
		}
		this.root.add( this._fill, this._border );
	}

	public get visible(): boolean {
		return this._fill.visible || this._border.visible;
	}

	public sync( description: BoxSelectionFeedback | null ): void {
		this._assertOpen();
		if ( description !== null ) validateDescription( description );
		this._description = description === null ? null : Object.freeze( {
			...description,
			start: Object.freeze( { ...description.start } ),
			current: Object.freeze( { ...description.current } ),
		} );
		const visible = description !== null && description.visible !== false;
		this._fill.visible = visible;
		this._border.visible = visible;
		if ( ! visible ) return;
		this._updateColors( description );
		this._updateGeometry();
	}

	public updateViewport(
		widthDevicePixels: number,
		heightDevicePixels: number,
		devicePixelRatio: number,
	): void {
		if ( this._disposed ) return;
		if ( ! Number.isFinite( widthDevicePixels ) || widthDevicePixels <= 0
			|| ! Number.isFinite( heightDevicePixels ) || heightDevicePixels <= 0
			|| ! Number.isFinite( devicePixelRatio ) || devicePixelRatio <= 0 ) {
			throw new Error( 'BOX_SELECTION_VIEWPORT_INVALID：viewport/DPR 非法。' );
		}
		this._viewportCss = Object.freeze( [
			widthDevicePixels / devicePixelRatio,
			heightDevicePixels / devicePixelRatio,
		] );
		this._updateGeometry();
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this.root.clear();
		this._fillGeometry.dispose();
		this._borderGeometry.dispose();
		this._fillMaterial.dispose();
		this._borderMaterial.dispose();
		this._description = null;
		this._viewportCss = null;
	}

	private _updateColors( description: BoxSelectionFeedback ): void {
		const color = safeColor(
			description.valid ? ( description.additive ? '#22c55e' : '#27c2ff' ) : '#ff3344',
		);
		this._fillMaterial.uniforms.u_color.value.set( color.r, color.g, color.b, 0.14 );
		this._borderMaterial.uniforms.u_color.value.set( color.r, color.g, color.b, 0.95 );
	}

	private _updateGeometry(): void {
		if ( this._description === null || this._viewportCss === null ) return;
		const [ width, height ] = this._viewportCss;
		const left = Math.min( this._description.start.x, this._description.current.x );
		const right = Math.max( this._description.start.x, this._description.current.x );
		const top = Math.min( this._description.start.y, this._description.current.y );
		const bottom = Math.max( this._description.start.y, this._description.current.y );
		setAttribute( this._fillGeometry, quadTriangles(
			toClipX( left, width ), toClipY( top, height ),
			toClipX( right, width ), toClipY( bottom, height ),
		) );
		const thicknessX = 1.5 * 2 / width;
		const thicknessY = 1.5 * 2 / height;
		const clipLeft = toClipX( left, width );
		const clipRight = toClipX( right, width );
		const clipTop = toClipY( top, height );
		const clipBottom = toClipY( bottom, height );
		setAttribute( this._borderGeometry, new Float32Array( [
			...quadTriangles( clipLeft, clipTop, clipRight, clipTop - thicknessY ),
			...quadTriangles( clipLeft, clipBottom + thicknessY, clipRight, clipBottom ),
			...quadTriangles( clipLeft, clipTop - thicknessY, clipLeft + thicknessX, clipBottom + thicknessY ),
			...quadTriangles( clipRight - thicknessX, clipTop - thicknessY, clipRight, clipBottom + thicknessY ),
		] ) );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'BoxSelectionFeedbackLayer 已销毁。' );
	}
}

function geometryWithVertexCount( count: number ): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( count * 2 ), 2 ) );
	return geometry;
}

function feedbackMaterial(): RawShaderMaterial {
	return new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: { u_color: { value: new Vector4() } },
		vertexShader: VERTEX_SHADER,
		fragmentShader: FRAGMENT_SHADER,
		transparent: true,
		depthTest: false,
		depthWrite: false,
		toneMapped: false,
	} );
}

function quadTriangles(
	left: number,
	top: number,
	right: number,
	bottom: number,
): Float32Array {
	return new Float32Array( [
		left, top, right, top, right, bottom,
		left, top, right, bottom, left, bottom,
	] );
}

function setAttribute( geometry: BufferGeometry, values: Float32Array ): void {
	const attribute = geometry.getAttribute( 'position' ) as BufferAttribute;
	( attribute.array as Float32Array ).set( values );
	attribute.needsUpdate = true;
}

function toClipX( cssX: number, widthCss: number ): number {
	return cssX * 2 / widthCss - 1;
}

function toClipY( cssY: number, heightCss: number ): number {
	return 1 - cssY * 2 / heightCss;
}

function validateDescription( value: BoxSelectionFeedback ): void {
	for ( const point of [ value.start, value.current ] ) {
		if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) ) {
			throw new Error( 'BOX_SELECTION_RECT_INVALID：框选坐标必须为有限数。' );
		}
	}
}

function safeColor( value: string ): Color {
	const color = new Color();
	try { color.set( value ); } catch { color.set( '#27c2ff' ); }
	return color;
}
