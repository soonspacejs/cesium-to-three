import earcut from 'earcut';
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
	Vector3,
	Vector4,
	type Camera,
} from 'three';
import type { CesiumGroundFrameState } from '../../ground';
import { encodeCesiumVector3 } from '../../ground/geometry';
import { encodeScalarRTE } from '../../ground/math/rte-encoding';
import {
	createEnuFrame,
	ecefToEnu,
	geodeticToEcef,
} from '../document/geodesy';
import type { RenderFeature, RenderVertex } from './RenderProjection';

const MIN_ALPHA = 1e-4;
const DEFAULT_DASH_METERS = 60;
const DEFAULT_GAP_METERS = 40;

interface RteUniforms {
	readonly cameraHigh: { value: Vector3 };
	readonly cameraLow: { value: Vector3 };
	readonly viewProjection: { value: Matrix4 };
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position3DHigh;
in vec3 position3DLow;
uniform vec3 u_cameraHigh;
uniform vec3 u_cameraLow;
uniform mat4 u_viewProjectionRte;
void main() {
	vec3 highDifference = position3DHigh - u_cameraHigh;
	vec3 lowDifference = position3DLow - u_cameraLow;
	gl_Position = u_viewProjectionRte * vec4(highDifference + lowDifference, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform vec4 u_color;
out vec4 outColor;
void main() {
	if (u_color.a <= 0.0) discard;
	outColor = u_color;
}
`;

/** 旧 heightMeters 无法表达逐顶点高度时使用的精确 RTE 图元。 */
export class VariableHeightRtePrimitive {
	public readonly group: Group;
	private readonly _uniforms: RteUniforms;
	private _disposed = false;

	public constructor( group: Group, uniforms: RteUniforms ) {
		this.group = group;
		this._uniforms = uniforms;
	}

	public update( frameState: CesiumGroundFrameState ): void {
		if ( this._disposed ) return;
		updateRteUniforms( frameState.camera, this._uniforms );
	}

	public setRenderOrder( value: number ): void {
		this.group.traverse( ( object ) => { object.renderOrder = value; } );
	}

	public setVisible( visible: boolean ): void {
		this.group.visible = visible;
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this.group.traverse( ( object ) => {
			const renderable = object as { geometry?: BufferGeometry; material?: RawShaderMaterial };
			renderable.geometry?.dispose();
			renderable.material?.dispose();
		} );
		this.group.clear();
	}
}

export function createVariableHeightRtePrimitive(
	render: RenderFeature,
	renderOrder: number,
): VariableHeightRtePrimitive | null {
	if ( render.vertices.length === 0
		|| render.primitive === 'point'
		|| render.primitive === 'text' ) return null;
	const uniforms = createRteUniforms();
	const group = new Group();
	group.name = `PlotVariableHeight:${ render.id }`;
	const world = render.vertices.map( vertexToWorld );

	if ( render.primitive === 'polygon' && world.length >= 3 ) {
		const fillAlpha = percentToAlpha( render.style.fillOpacity );
		if ( fillAlpha > MIN_ALPHA ) {
			const indices = triangulate( render.vertices );
			if ( indices.length >= 3 ) {
				group.add( createMesh(
					createRteGeometry( world, indices ),
					createMaterial( render.style.fillColor, fillAlpha, uniforms ),
				) );
			}
		}
	}

	const strokeAlpha = percentToAlpha( render.style.strokeOpacity );
	if ( strokeAlpha > MIN_ALPHA && render.style.strokeWidth > 0 ) {
		const dashed = render.type === 'line'
			&& ( render.style as Record<string, unknown> ).strokeStyle === 'dashed';
		const strokeWorld = dashed
			? createDashedPath( world, DEFAULT_DASH_METERS, DEFAULT_GAP_METERS )
			: [ world ];
		for ( const run of strokeWorld ) {
			const triangles = buildStrokeTriangles(
				run,
				render.closed && ! dashed,
				render.style.strokeWidth,
			);
			if ( triangles.length > 0 ) {
				group.add( createMesh(
					createRteGeometry( triangles ),
					createMaterial( render.style.strokeColor, strokeAlpha, uniforms ),
				) );
			}
		}
		if ( render.type === 'line' ) {
			addLineArrowHeads( group, world, render, uniforms, strokeAlpha );
		}
	}

	if ( group.children.length === 0 ) return null;
	const primitive = new VariableHeightRtePrimitive( group, uniforms );
	primitive.setRenderOrder( renderOrder );
	primitive.setVisible( render.visible );
	return primitive;
}

function triangulate( vertices: readonly RenderVertex[] ): number[] {
	const first = vertices[ 0 ];
	const frame = createEnuFrame( [
		first.longitude, first.latitude, first.resolvedWorldHeight,
	] );
	const flat: number[] = [];
	for ( const vertex of vertices ) {
		const local = ecefToEnu( geodeticToEcef( [
			vertex.longitude, vertex.latitude, vertex.resolvedWorldHeight,
		] ), frame );
		flat.push( local[ 0 ], local[ 1 ] );
	}
	return earcut( flat, null, 2 );
}

function buildStrokeTriangles(
	points: readonly Vector3[],
	closed: boolean,
	widthMeters: number,
): Vector3[] {
	const triangles: Vector3[] = [];
	const count = closed ? points.length : points.length - 1;
	for ( let index = 0; index < count; index++ ) {
		const start = points[ index ];
		const end = points[ ( index + 1 ) % points.length ];
		const direction = end.clone().sub( start );
		if ( direction.lengthSq() <= 1e-12 ) continue;
		direction.normalize();
		const up = start.clone().normalize().add( end.clone().normalize() ).normalize();
		const right = direction.clone().cross( up );
		if ( right.lengthSq() <= 1e-12 ) right.set( 1, 0, 0 );
		right.normalize().multiplyScalar( widthMeters / 2 );
		const a = start.clone().sub( right );
		const b = start.clone().add( right );
		const c = end.clone().add( right );
		const d = end.clone().sub( right );
		triangles.push( a, b, c, a.clone(), c.clone(), d );
	}
	return triangles;
}

function createDashedPath(
	points: readonly Vector3[],
	dashMeters: number,
	gapMeters: number,
): Vector3[][] {
	const runs: Vector3[][] = [];
	let drawing = true;
	let remaining = dashMeters;
	let run: Vector3[] = [];
	for ( let index = 0; index < points.length - 1; index++ ) {
		const start = points[ index ];
		const end = points[ index + 1 ];
		const length = start.distanceTo( end );
		if ( length <= 1e-9 ) continue;
		let travelled = 0;
		let cursor = start.clone();
		if ( drawing && run.length === 0 ) run.push( cursor.clone() );
		while ( travelled < length - 1e-9 ) {
			const step = Math.min( remaining, length - travelled );
			travelled += step;
			cursor = start.clone().lerp( end, travelled / length );
			if ( drawing ) run.push( cursor.clone() );
			remaining -= step;
			if ( remaining <= 1e-9 ) {
				if ( drawing && run.length >= 2 ) runs.push( run );
				drawing = ! drawing;
				remaining = drawing ? dashMeters : gapMeters;
				run = drawing ? [ cursor.clone() ] : [];
			}
		}
	}
	if ( drawing && run.length >= 2 ) runs.push( run );
	return runs;
}

function addLineArrowHeads(
	group: Group,
	world: readonly Vector3[],
	render: RenderFeature,
	uniforms: RteUniforms,
	alpha: number,
): void {
	if ( world.length < 2 ) return;
	const style = render.style as Record<string, unknown>;
	const startStyle = style.startArrowStyle;
	const endStyle = style.endArrowStyle;
	if ( startStyle === 'filledArrow' || startStyle === 'unfilledArrow' ) {
		addArrowHead( group, world[ 0 ], world[ 1 ], startStyle, render, uniforms, alpha );
	}
	if ( endStyle === 'filledArrow' || endStyle === 'unfilledArrow' ) {
		addArrowHead(
			group,
			world.at( -1 ) as Vector3,
			world.at( -2 ) as Vector3,
			endStyle,
			render,
			uniforms,
			alpha,
		);
	}
}

function addArrowHead(
	group: Group,
	tip: Vector3,
	toward: Vector3,
	style: 'filledArrow' | 'unfilledArrow',
	render: RenderFeature,
	uniforms: RteUniforms,
	alpha: number,
): void {
	const backwards = toward.clone().sub( tip ).normalize();
	const up = tip.clone().normalize();
	const right = backwards.clone().cross( up ).normalize();
	const length = Math.max( render.style.strokeWidth * 6, 12 );
	const halfWidth = length * 0.45;
	const base = tip.clone().addScaledVector( backwards, length );
	const left = base.clone().addScaledVector( right, halfWidth );
	const rightPoint = base.clone().addScaledVector( right, -halfWidth );
	const positions = style === 'filledArrow'
		? [ tip, left, rightPoint ]
		: buildStrokeTriangles( [ left, tip, rightPoint ], false, render.style.strokeWidth );
	group.add( createMesh(
		createRteGeometry( positions ),
		createMaterial( render.style.strokeColor, alpha, uniforms ),
	) );
}

function vertexToWorld( vertex: RenderVertex ): Vector3 {
	const ecef = geodeticToEcef( [
		vertex.longitude, vertex.latitude, vertex.resolvedWorldHeight,
	] );
	return new Vector3( ecef[ 0 ], ecef[ 1 ], ecef[ 2 ] );
}

function createRteGeometry(
	points: readonly Vector3[],
	indices?: readonly number[],
): BufferGeometry {
	const geometry = new BufferGeometry();
	const high = new Float32Array( points.length * 3 );
	const low = new Float32Array( points.length * 3 );
	for ( let index = 0; index < points.length; index++ ) {
		const point = points[ index ];
		const x = encodeScalarRTE( point.x );
		const y = encodeScalarRTE( point.y );
		const z = encodeScalarRTE( point.z );
		const offset = index * 3;
		high.set( [ x.high, y.high, z.high ], offset );
		low.set( [ x.low, y.low, z.low ], offset );
	}
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	if ( indices !== undefined && indices.length > 0 ) geometry.setIndex( [ ...indices ] );
	return geometry;
}

function createMaterial(
	colorValue: string,
	alpha: number,
	uniforms: RteUniforms,
): RawShaderMaterial {
	const color = new Color();
	try { color.set( colorValue ); } catch { color.set( '#ffffff' ); }
	return new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: {
			u_cameraHigh: uniforms.cameraHigh,
			u_cameraLow: uniforms.cameraLow,
			u_viewProjectionRte: uniforms.viewProjection,
			u_color: { value: new Vector4( color.r, color.g, color.b, alpha ) },
		},
		vertexShader: VERTEX_SHADER,
		fragmentShader: FRAGMENT_SHADER,
		transparent: alpha < 1,
		depthTest: false,
		depthWrite: false,
		side: DoubleSide,
		toneMapped: false,
	} );
}

function createMesh( geometry: BufferGeometry, material: RawShaderMaterial ): Mesh {
	const mesh = new Mesh( geometry, material );
	mesh.frustumCulled = false;
	return mesh;
}

function createRteUniforms(): RteUniforms {
	return {
		cameraHigh: { value: new Vector3() },
		cameraLow: { value: new Vector3() },
		viewProjection: { value: new Matrix4() },
	};
}

const viewRotation = new Matrix4();

function updateRteUniforms( camera: Camera, uniforms: RteUniforms ): void {
	camera.updateMatrixWorld();
	camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
	encodeCesiumVector3( camera.position, uniforms.cameraHigh.value, uniforms.cameraLow.value );
	viewRotation.copy( camera.matrixWorldInverse );
	viewRotation.elements[ 12 ] = 0;
	viewRotation.elements[ 13 ] = 0;
	viewRotation.elements[ 14 ] = 0;
	uniforms.viewProjection.value.multiplyMatrices( camera.projectionMatrix, viewRotation );
}

function percentToAlpha( value: number ): number {
	return Math.min( 100, Math.max( 0, Number.isFinite( value ) ? value : 100 ) ) / 100;
}
