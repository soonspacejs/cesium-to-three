import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DoubleSide,
	GLSL3,
	Group,
	Matrix4,
	Mesh,
	RawShaderMaterial,
	Vector2,
	Vector3,
	Vector4,
} from 'three';
import { encodeScalarRTE } from '../../ground/math/rte-encoding';
import { geodeticToEcef } from '../document/geodesy';
import type { PlotFeatureId, Position3D } from '../document/types';

export interface ScreenSpaceMarkerDescription {
	readonly id: string;
	readonly entityId?: PlotFeatureId;
	readonly handleId?: string;
	readonly position: Position3D;
	readonly screenOffsetCssPixels?: readonly [ number, number ];
	readonly shape:
		| 'circle'
		| 'square'
		| 'diamond'
		| 'ring'
		| 'axis-east'
		| 'axis-north'
		| 'axis-up'
		| 'scale-east'
		| 'scale-north'
		| 'scale-up';
	readonly fillColor: string;
	readonly borderColor: string;
	readonly sizeCssPixels: number;
	readonly pickRadiusCssPixels: number;
	readonly priority: number;
	readonly visible: boolean;
	readonly active?: boolean;
	readonly occluded?: boolean;
}

export interface MarkerViewportState {
	readonly widthDevicePixels: number;
	readonly heightDevicePixels: number;
	readonly devicePixelRatio: number;
	readonly cameraPositionEcef: readonly [ number, number, number ];
	readonly viewProjectionRotation: readonly number[];
	readonly projectionMatrix: readonly number[];
}

interface MarkerEntry {
	readonly mesh: Mesh<BufferGeometry, RawShaderMaterial>;
	description: ScreenSpaceMarkerDescription;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 corner;
uniform vec3 u_cameraHigh;
uniform vec3 u_cameraLow;
uniform mat4 u_viewProjectionRte;
uniform vec2 u_viewportDevice;
uniform float u_devicePixelRatio;
uniform float u_sizeCss;
uniform vec2 u_offsetCss;
out vec2 v_corner;
void main() {
	vec3 relative = (position3DHigh - u_cameraHigh) + (position3DLow - u_cameraLow);
	vec4 center = u_viewProjectionRte * vec4(relative, 1.0);
	vec2 deviceOffset = vec2(
		corner.x * u_sizeCss + u_offsetCss.x,
		corner.y * u_sizeCss - u_offsetCss.y
	) * u_devicePixelRatio;
	center.xy += deviceOffset * 2.0 / u_viewportDevice * center.w;
	gl_Position = center;
	v_corner = corner;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform vec4 u_fill;
uniform vec4 u_border;
uniform int u_shape;
out vec4 outColor;
in vec2 v_corner;
void main() {
	vec2 point = v_corner * 2.0;
	float metric;
	if (u_shape == 0 || u_shape == 3) metric = length(point);
	else if (u_shape == 2) metric = abs(point.x) + abs(point.y);
	else if (u_shape == 1) metric = max(abs(point.x), abs(point.y));
	else {
		// 轴杆 quad 从 pivot 向端点延伸；平移端是箭头，缩放端是方块。
		bool vertical = u_shape == 5 || u_shape == 8;
		bool diagonal = u_shape == 6 || u_shape == 9;
		vec2 axisPoint = vertical ? vec2(point.y, -point.x)
			: diagonal ? vec2((point.x - point.y) * 0.70710678, (point.x + point.y) * 0.70710678)
			: point;
		bool shaft = axisPoint.x > -1.0 && axisPoint.x < 0.62 && abs(axisPoint.y) < 0.075;
		bool scaleHead = u_shape >= 7 && axisPoint.x > 0.50
			&& max(abs(axisPoint.x - 0.72), abs(axisPoint.y)) < 0.22;
		bool arrowHead = u_shape >= 4 && u_shape <= 6 && axisPoint.x > 0.42
			&& axisPoint.x < 0.92 && abs(axisPoint.y) < (0.92 - axisPoint.x) * 0.72;
		if (!shaft && !scaleHead && !arrowHead) discard;
		outColor = abs(axisPoint.y) > 0.04 ? u_border : u_fill;
		return;
	}
	if (u_shape == 3) {
		if (metric > 1.0 || metric < 0.82) discard;
		float ringEdge = max(smoothstep(0.82, 0.87, metric), smoothstep(0.94, 1.0, metric));
		outColor = mix(u_fill, u_border, ringEdge);
		return;
	}
	if (metric > 1.0) discard;
	float edge = smoothstep(0.72, 0.94, metric);
	outColor = mix(u_fill, u_border, edge);
}
`;

/** RTE anchor + clip-space quad，保证视觉尺寸和命中半径都以 CSS 像素定义。 */
export class ScreenSpaceMarkerLayer {
	public readonly root: Group;
	private readonly _layer: number;
	private readonly _entries = new Map<string, MarkerEntry>();
	private _disposed = false;

	public constructor( name: string, layer: number ) {
		this.root = new Group();
		this.root.name = name;
		this._layer = validateLayer( layer );
		this.root.layers.set( this._layer );
	}

	public get size(): number {
		return this._entries.size;
	}

	public sync( descriptions: readonly ScreenSpaceMarkerDescription[] ): void {
		this._assertOpen();
		const ids = new Set<string>();
		// 先全量校验，重复 id/非法参数不得造成半批 marker 已替换。
		for ( const description of descriptions ) {
			if ( ids.has( description.id ) ) throw new Error( `MARKER_ID_CONFLICT：${ description.id }。` );
			ids.add( description.id );
			validateDescription( description );
		}
		for ( const description of descriptions ) {
			const previous = this._entries.get( description.id );
			if ( previous !== undefined && markerDescriptionsEqual( previous.description, description ) ) {
				previous.mesh.visible = description.visible;
				continue;
			}
			if ( previous !== undefined && tupleEqual( previous.description.position, description.position ) ) {
				updateMarkerState( previous, description );
				continue;
			}
			const candidate = createMarker( description, this._layer );
			this.root.add( candidate.mesh );
			if ( previous !== undefined ) {
				this.root.remove( previous.mesh );
				disposeMarker( previous );
			}
			this._entries.set( description.id, candidate );
		}
		for ( const [ id, entry ] of this._entries ) {
			if ( ids.has( id ) ) continue;
			this._entries.delete( id );
			this.root.remove( entry.mesh );
			disposeMarker( entry );
		}
	}

	public update( viewport: MarkerViewportState ): void {
		if ( this._disposed ) return;
		validateViewport( viewport );
		const cameraHigh = new Vector3();
		const cameraLow = new Vector3();
		encodeVector(
			viewport.cameraPositionEcef,
			cameraHigh,
			cameraLow,
		);
		for ( const entry of this._entries.values() ) {
			const uniforms = entry.mesh.material.uniforms;
			uniforms.u_cameraHigh.value.copy( cameraHigh );
			uniforms.u_cameraLow.value.copy( cameraLow );
			uniforms.u_viewportDevice.value.set(
				viewport.widthDevicePixels,
				viewport.heightDevicePixels,
			);
			uniforms.u_devicePixelRatio.value = viewport.devicePixelRatio;
			const matrix = uniforms.u_viewProjectionRte.value.elements as number[];
			multiplyMatrices(
				viewport.projectionMatrix,
				viewport.viewProjectionRotation,
				matrix,
			);
		}
	}

	public getDescription( id: string ): ScreenSpaceMarkerDescription | undefined {
		return this._entries.get( id )?.description;
	}

	public getDescriptions(): readonly ScreenSpaceMarkerDescription[] {
		return Object.freeze( [ ...this._entries.values() ].map( ( entry ) => entry.description ) );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		for ( const entry of this._entries.values() ) disposeMarker( entry );
		this._entries.clear();
		this.root.clear();
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'ScreenSpaceMarkerLayer 已销毁。' );
	}
}

/** hover/active/occluded/style 只是 uniform/状态热更新，不重建 geometry/material。 */
function updateMarkerState(
	entry: MarkerEntry,
	description: ScreenSpaceMarkerDescription,
): void {
	const material = entry.mesh.material;
	const uniforms = material.uniforms;
	const fill = safeColor( description.fillColor, '#ffffff' );
	const border = safeColor( description.borderColor, '#111111' );
	const opacity = description.occluded && ! description.active ? 0.35 : 1;
	const offset = description.screenOffsetCssPixels ?? [ 0, 0 ];
	uniforms.u_sizeCss.value = description.sizeCssPixels;
	uniforms.u_offsetCss.value.set( offset[ 0 ], offset[ 1 ] );
	uniforms.u_fill.value.set( fill.r, fill.g, fill.b, opacity );
	uniforms.u_border.value.set( border.r, border.g, border.b, opacity );
	uniforms.u_shape.value = markerShapeId( description.shape );
	material.transparent = opacity < 1;
	material.depthTest = description.active !== true;
	material.needsUpdate = true;
	entry.mesh.visible = description.visible;
	entry.mesh.renderOrder = description.priority;
	entry.mesh.userData.editorPickProxy = markerPickProxy( description, offset );
	entry.description = Object.freeze( { ...description } );
}

function createMarker(
	description: ScreenSpaceMarkerDescription,
	layer: number,
): MarkerEntry {
	const geometry = markerGeometry( description.position );
	const fill = safeColor( description.fillColor, '#ffffff' );
	const border = safeColor( description.borderColor, '#111111' );
	const opacity = description.occluded && ! description.active ? 0.35 : 1;
	const offset = description.screenOffsetCssPixels ?? [ 0, 0 ];
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: {
			u_cameraHigh: { value: new Vector3() },
			u_cameraLow: { value: new Vector3() },
			u_viewProjectionRte: { value: new Matrix4() },
			u_viewportDevice: { value: new Vector2( 1, 1 ) },
			u_devicePixelRatio: { value: 1 },
			u_sizeCss: { value: description.sizeCssPixels },
			u_offsetCss: { value: new Vector2( offset[ 0 ], offset[ 1 ] ) },
			u_fill: { value: new Vector4( fill.r, fill.g, fill.b, opacity ) },
			u_border: { value: new Vector4( border.r, border.g, border.b, opacity ) },
			u_shape: { value: markerShapeId( description.shape ) },
		},
		vertexShader: VERTEX_SHADER,
		fragmentShader: FRAGMENT_SHADER,
		transparent: opacity < 1,
		depthTest: description.active !== true,
		depthWrite: false,
		side: DoubleSide,
		toneMapped: false,
	} );
	const mesh = new Mesh( geometry, material );
	mesh.name = `EditorMarker:${ description.id }`;
	mesh.frustumCulled = false;
	mesh.visible = description.visible;
	mesh.renderOrder = description.priority;
	mesh.layers.set( layer );
	mesh.userData.editorPickProxy = markerPickProxy( description, offset );
	return { mesh, description: Object.freeze( { ...description } ) };
}

function markerPickProxy(
	description: ScreenSpaceMarkerDescription,
	offset: readonly [ number, number ],
): Readonly<Record<string, unknown>> {
	return Object.freeze( {
		entityId: description.entityId,
		handleId: description.handleId,
		priority: description.priority,
		pickRadiusCssPixels: description.pickRadiusCssPixels,
		screenOffsetCssPixels: Object.freeze( [ ...offset ] ),
		shape: description.shape,
		sizeCssPixels: description.sizeCssPixels,
	} );
}

function markerGeometry( position: Position3D ): BufferGeometry {
	const world = geodeticToEcef( position );
	const high = new Float32Array( 12 );
	const low = new Float32Array( 12 );
	for ( let index = 0; index < 4; index++ ) {
		const offset = index * 3;
		for ( let component = 0; component < 3; component++ ) {
			const encoded = encodeScalarRTE( world[ component ] );
			high[ offset + component ] = encoded.high;
			low[ offset + component ] = encoded.low;
		}
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	geometry.setAttribute( 'corner', new BufferAttribute( new Float32Array( [
		-0.5, -0.5,
		0.5, -0.5,
		0.5, 0.5,
		-0.5, 0.5,
	] ), 2 ) );
	geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
	return geometry;
}

function disposeMarker( entry: MarkerEntry ): void {
	entry.mesh.geometry.dispose();
	entry.mesh.material.dispose();
}

function validateDescription( value: ScreenSpaceMarkerDescription ): void {
	if ( value.id.trim().length === 0 ) throw new TypeError( 'marker id 不能为空。' );
	if ( value.position.length !== 3
		|| value.position.some( ( component ) => ! Number.isFinite( component ) )
		|| value.position[ 1 ] < -90
		|| value.position[ 1 ] > 90 ) {
		throw new RangeError( 'marker position 必须是纬度有效的有限 [longitude, latitude, height]。' );
	}
	if ( ! Number.isFinite( value.sizeCssPixels ) || value.sizeCssPixels <= 0 ) {
		throw new RangeError( 'marker sizeCssPixels 必须为正有限数。' );
	}
	if ( ! Number.isFinite( value.pickRadiusCssPixels ) || value.pickRadiusCssPixels <= 0 ) {
		throw new RangeError( 'marker pickRadiusCssPixels 必须为正有限数。' );
	}
}

function validateViewport( viewport: MarkerViewportState ): void {
	if ( ! Number.isFinite( viewport.widthDevicePixels ) || viewport.widthDevicePixels <= 0
		|| ! Number.isFinite( viewport.heightDevicePixels ) || viewport.heightDevicePixels <= 0
		|| ! Number.isFinite( viewport.devicePixelRatio ) || viewport.devicePixelRatio <= 0
		|| viewport.cameraPositionEcef.some( ( component ) => ! Number.isFinite( component ) )
		|| ! isFiniteMatrix4( viewport.projectionMatrix )
		|| ! isFiniteMatrix4( viewport.viewProjectionRotation ) ) {
		throw new Error( 'MARKER_VIEWPORT_INVALID：viewport/camera matrix 非法。' );
	}
}

function markerDescriptionsEqual(
	left: ScreenSpaceMarkerDescription,
	right: ScreenSpaceMarkerDescription,
): boolean {
	return left.id === right.id
		&& left.entityId === right.entityId
		&& left.handleId === right.handleId
		&& left.shape === right.shape
		&& left.fillColor === right.fillColor
		&& left.borderColor === right.borderColor
		&& left.sizeCssPixels === right.sizeCssPixels
		&& left.pickRadiusCssPixels === right.pickRadiusCssPixels
		&& left.priority === right.priority
		&& left.visible === right.visible
		&& left.active === right.active
		&& left.occluded === right.occluded
		&& tupleEqual( left.position, right.position )
		&& tupleEqual( left.screenOffsetCssPixels, right.screenOffsetCssPixels );
}

function tupleEqual( left?: readonly number[], right?: readonly number[] ): boolean {
	return left === right || ( left !== undefined && right !== undefined
		&& left.length === right.length
		&& left.every( ( value, index ) => value === right[ index ] ) );
}

function safeColor( value: string, fallback: string ): Color {
	const color = new Color();
	try { color.set( value ); } catch { color.set( fallback ); }
	return color;
}

function markerShapeId( shape: ScreenSpaceMarkerDescription[ 'shape' ] ): number {
	switch ( shape ) {
		case 'circle': return 0;
		case 'square': return 1;
		case 'diamond': return 2;
		case 'ring': return 3;
		case 'axis-east': return 4;
		case 'axis-north': return 5;
		case 'axis-up': return 6;
		case 'scale-east': return 7;
		case 'scale-north': return 8;
		case 'scale-up': return 9;
	}
}

function encodeVector(
	value: readonly [ number, number, number ],
	high: Vector3,
	low: Vector3,
): void {
	const x = encodeScalarRTE( value[ 0 ] );
	const y = encodeScalarRTE( value[ 1 ] );
	const z = encodeScalarRTE( value[ 2 ] );
	high.set( x.high, y.high, z.high );
	low.set( x.low, y.low, z.low );
}

function multiplyMatrices(
	left: readonly number[],
	right: readonly number[],
	out: number[],
): void {
	for ( let row = 0; row < 4; row++ ) {
		for ( let column = 0; column < 4; column++ ) {
			let sum = 0;
			for ( let index = 0; index < 4; index++ ) {
				// Three Matrix4 使用 column-major。
				sum += left[ index * 4 + row ] * right[ column * 4 + index ];
			}
			out[ column * 4 + row ] = sum;
		}
	}
}

function isFiniteMatrix4( value: readonly number[] ): boolean {
	return value.length === 16 && value.every( Number.isFinite );
}

function validateLayer( value: number ): number {
	if ( ! Number.isInteger( value ) || value < 0 || value > 31 ) {
		throw new RangeError( 'Three layer 必须是 0..31 的整数。' );
	}
	return value;
}
