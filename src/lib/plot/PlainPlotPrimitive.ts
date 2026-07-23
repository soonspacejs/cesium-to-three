// ============================================================
// PlainPlotPrimitive.ts - non-ground-clamped plot renderer.
// Layer: plot rendering bridge support.
// Responsibility: build ordinary Three.js primitives for plot items when
// clampToGround=false, while using Cesium-style RTE coordinates so the
// visual precision matches the ground-clamped path at height=0.
// Dependencies: Three.js, earcut, ground WGS84 helpers, plot data models.
// Consumed by: PlotPrimitiveBridge.
// ============================================================

import earcut from 'earcut';
import {
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DoubleSide,
	GLSL3,
	Group,
	Matrix4,
	Mesh,
	RawShaderMaterial,
	Sprite,
	SpriteMaterial,
	Vector3,
	Vector4,
	type ColorRepresentation,
	type Material,
	type Texture,
} from 'three';

import type { CesiumGroundFrameState, LonLatPoint } from '../ground';
import {
	LINE_DEFAULT_GRANULARITY,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from '../ground';
import { encodeCesiumVector3 } from '../ground/geometry';
import { buildWallArrays } from '../ground/line/line-geometry-normals';
import { preprocessLine } from '../ground/line/line-preprocess';
import { ArcType, type DensifiedLine } from '../ground/line/line-types';
import { encodeScalarRTE } from '../ground/math/rte-encoding';
import { acquireImageTexture } from '../ground/image';

import type { GisPlotBase } from './plugins/base';
import { resolvePlotPointImageUrl } from './emergency-resource-icons';
import type {
	PlotCircleOptions,
	PlotLineOptions,
	PlotPointOptions,
	PlotSectorOptions,
	PlotTextOptions,
} from './plugins/types';

export const DEFAULT_PLAIN_PLOT_HEIGHT_METERS = 0.0;

const DEG_TO_RAD = Math.PI / 180.0;
const CIRCLE_SEGMENTS = 96;
const MIN_ALPHA = 1.0e-4;

interface PlainFrame {
	origin: Vector3;
	east: Vector3;
	north: Vector3;
	up: Vector3;
}

interface PlainStyle {
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	heightMeters?: number;
}

interface PlainRteFrameUniforms {
	u_encodedCameraPositionHigh: { value: Vector3 };
	u_encodedCameraPositionLow: { value: Vector3 };
	u_modelViewProjectionRelativeToEye: { value: Matrix4 };
}

const PLAIN_RTE_VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;

in vec3 position3DHigh;
in vec3 position3DLow;

uniform vec3 u_encodedCameraPositionHigh;
uniform vec3 u_encodedCameraPositionLow;
uniform mat4 u_modelViewProjectionRelativeToEye;

vec4 c23_translateRelativeToEye(vec3 high, vec3 low) {
	vec3 highDifference = high - u_encodedCameraPositionHigh;
	vec3 lowDifference = low - u_encodedCameraPositionLow;
	return vec4(highDifference + lowDifference, 1.0);
}

void main() {
	gl_Position = u_modelViewProjectionRelativeToEye *
		c23_translateRelativeToEye(position3DHigh, position3DLow);
}
`;

const PLAIN_RTE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;

uniform vec4 u_color;

out vec4 out_FragColor;

void main() {
	out_FragColor = u_color;
}
`;

const PLAIN_RTE_TEXTURE_VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 uv;
uniform vec3 u_encodedCameraPositionHigh;
uniform vec3 u_encodedCameraPositionLow;
uniform mat4 u_modelViewProjectionRelativeToEye;
out vec2 v_uv;
void main() {
	vec3 highDifference = position3DHigh - u_encodedCameraPositionHigh;
	vec3 lowDifference = position3DLow - u_encodedCameraPositionLow;
	v_uv = uv;
	gl_Position = u_modelViewProjectionRelativeToEye *
		vec4(highDifference + lowDifference, 1.0);
}
`;

const PLAIN_RTE_TEXTURE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_decalTexture;
uniform float u_decalOpacity;
in vec2 v_uv;
out vec4 out_FragColor;
void main() {
	vec4 texel = texture(u_decalTexture, vec2(v_uv.x, 1.0 - v_uv.y));
	texel.a *= clamp(u_decalOpacity, 0.0, 1.0);
	if (texel.a <= 0.0) discard;
	texel.rgb *= texel.a;
	out_FragColor = texel;
}
`;

const _plainViewRotation = new Matrix4();

export class PlainPlotPrimitive {

	public readonly group: Group;

	private readonly frameUniforms: PlainRteFrameUniforms;
	private readonly cleanup: (() => void) | null;

	public constructor(
		group: Group,
		frameUniforms: PlainRteFrameUniforms,
		cleanup: (() => void) | null = null,
	) {
		this.group = group;
		this.frameUniforms = frameUniforms;
		this.cleanup = cleanup;
	}

	public update( frameState: CesiumGroundFrameState ): void {
		updatePlainRteFrameUniforms( frameState, this.frameUniforms );
	}

	public setRenderOrder( renderOrder: number ): void {
		this.group.traverse( object => {
			object.renderOrder = renderOrder;
		} );
	}

	public setVisible( visible: boolean ): void {
		this.group.visible = visible;
	}

	public dispose(): void {
		const geometries = new Set<BufferGeometry>();
		const materials = new Set<Material>();
		const textures = new Set<Texture>();

		this.group.traverse( object => {
			const candidate = object as {
				geometry?: BufferGeometry;
				material?: Material | Material[];
			};

			if ( candidate.geometry ) {
				geometries.add( candidate.geometry );
			}

			if ( candidate.material ) {
				const objectMaterials = Array.isArray( candidate.material )
					? candidate.material
					: [ candidate.material ];
				for ( const material of objectMaterials ) {
					materials.add( material );
					const maybeMapped = material as Material & { map?: Texture | null };
					if ( maybeMapped.map ) {
						textures.add( maybeMapped.map );
					}
				}
			}
		} );

		for ( const geometry of geometries ) geometry.dispose();
		for ( const texture of textures ) texture.dispose();
		for ( const material of materials ) material.dispose();
		this.cleanup?.();
		this.group.clear();
	}
}

export function createPlainPlotPrimitive(
	plot: GisPlotBase,
	renderOrder: number,
	globalOpacity: number,
): PlainPlotPrimitive | null {
	const base = plot.options;
	const points = ( base.points ?? [] ) as LonLatPoint[];
	const style = normalizeStyle( base, globalOpacity );
	const frameUniforms = createPlainRteFrameUniforms();
	let group: Group | null = null;
	let cleanup: (() => void) | null = null;

	switch ( plot.category ) {
		case 'point': {
			const options = base as PlotPointOptions;
			if ( options.pointStyle === 'image' ) {
				const image = buildImagePointGroup( options, style, frameUniforms );
				group = image?.group ?? null;
				cleanup = image?.release ?? null;
			} else {
				group = buildPointGroup( options, style, frameUniforms );
			}
			break;
		}

		case 'circle': {
			const options = base as PlotCircleOptions;
			group = points.length > 0
				? buildCircleGroup(
					points[ 0 ],
					options.radius ?? 100.0,
					0.0,
					360.0,
					style,
					frameUniforms,
				)
				: null;
			break;
		}

		case 'sector': {
			const options = base as PlotSectorOptions;
			group = points.length > 0
				? buildCircleGroup(
					points[ 0 ],
					options.radius ?? 100.0,
					options.startAngle ?? 0.0,
					options.sectorAngle ?? 360.0,
					style,
					frameUniforms,
				)
				: null;
			break;
		}

		case 'polygon':
		case 'rectangle':
			group = buildPolygonGroup( points, style, frameUniforms );
			break;

		case 'arrow': {
			const coords = ( plot as unknown as { generateCoords(): LonLatPoint[] } )
				.generateCoords();
			group = buildPolygonGroup( coords, style, frameUniforms );
			break;
		}

		case 'line':
			group = buildLineGroup( base as PlotLineOptions, style, frameUniforms );
			break;

		case 'text':
			group = buildTextGroup( base as PlotTextOptions, style );
			break;

		default:
			group = null;
	}

	if ( group === null ) {
		return null;
	}

	const primitive = new PlainPlotPrimitive( group, frameUniforms, cleanup );
	primitive.setRenderOrder( renderOrder );
	primitive.setVisible( base.visible !== false );
	return primitive;
}

function createPlainRteFrameUniforms(): PlainRteFrameUniforms {
	return {
		u_encodedCameraPositionHigh: { value: new Vector3() },
		u_encodedCameraPositionLow: { value: new Vector3() },
		u_modelViewProjectionRelativeToEye: { value: new Matrix4() },
	};
}

function updatePlainRteFrameUniforms(
	frameState: CesiumGroundFrameState,
	uniforms: PlainRteFrameUniforms,
): void {
	const camera = frameState.camera;
	camera.updateMatrixWorld();
	camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
	encodeCesiumVector3(
		camera.position,
		uniforms.u_encodedCameraPositionHigh.value,
		uniforms.u_encodedCameraPositionLow.value,
	);

	// RTE 顶点已经在 shader 中完成“世界坐标 - 相机坐标”，这里的视图矩阵只保留
	// 相机旋转，避免默认 modelViewMatrix 再次进行百万米级平移抵消。
	_plainViewRotation.copy( camera.matrixWorldInverse );
	_plainViewRotation.elements[ 12 ] = 0.0;
	_plainViewRotation.elements[ 13 ] = 0.0;
	_plainViewRotation.elements[ 14 ] = 0.0;
	uniforms.u_modelViewProjectionRelativeToEye.value.multiplyMatrices(
		camera.projectionMatrix,
		_plainViewRotation,
	);
}

function normalizeStyle(
	options: {
		strokeColor?: string;
		strokeWidth?: number;
		strokeOpacity?: number;
		fillColor?: string;
		fillOpacity?: number;
		heightMeters?: number;
	},
	globalOpacity: number,
): PlainStyle {
	return {
		strokeColor: options.strokeColor ?? '#ffffff',
		strokeWidth: Math.max( options.strokeWidth ?? 0.0, 0.0 ),
		strokeOpacity: clampPercent( ( options.strokeOpacity ?? 100.0 ) * globalOpacity ),
		fillColor: options.fillColor ?? '#ffffff',
		fillOpacity: clampPercent( ( options.fillOpacity ?? 100.0 ) * globalOpacity ),
		heightMeters: resolveHeightMeters( options ),
	};
}

function resolveHeightMeters( options: { heightMeters?: number } ): number {
	const value = options.heightMeters;
	return Number.isFinite( value ) ? value as number : DEFAULT_PLAIN_PLOT_HEIGHT_METERS;
}

function clampPercent( value: number ): number {
	if ( ! Number.isFinite( value ) ) return 100.0;
	return Math.min( Math.max( value, 0.0 ), 100.0 );
}

function alphaFromPercent( value: number ): number {
	return clampPercent( value ) / 100.0;
}

function safeColor(
	value: ColorRepresentation | undefined,
	fallback: ColorRepresentation,
): Color {
	const color = new Color();
	try {
		color.set( value ?? fallback );
	} catch {
		color.set( fallback );
	}
	return color;
}

function createFrame(
	longitudeDegrees: number,
	latitudeDegrees: number,
	heightMeters: number,
): PlainFrame {
	const origin = wgs84PositionFromDegrees(
		longitudeDegrees,
		latitudeDegrees,
		heightMeters,
	);
	const up = wgs84NormalFromDegrees( longitudeDegrees, latitudeDegrees );
	const east = new Vector3( - up.y, up.x, 0.0 );
	if ( east.lengthSq() < 1.0e-12 ) {
		east.set( 1.0, 0.0, 0.0 );
	} else {
		east.normalize();
	}
	const north = new Vector3().crossVectors( up, east ).normalize();
	return { origin, east, north, up };
}

function createFrameForPoints(
	points: readonly LonLatPoint[],
	heightMeters: number,
): PlainFrame {
	let lon = 0.0;
	let lat = 0.0;
	for ( const point of points ) {
		lon += point[ 0 ];
		lat += point[ 1 ];
	}
	const inv = points.length > 0 ? 1.0 / points.length : 1.0;
	return createFrame( lon * inv, lat * inv, heightMeters );
}

function worldDeltaFromLonLat(
	point: LonLatPoint,
	frame: PlainFrame,
	heightMeters: number,
): Vector3 {
	return wgs84PositionFromDegrees( point[ 0 ], point[ 1 ], heightMeters )
		.sub( frame.origin );
}

function tangentOffset(
	frame: PlainFrame,
	eastMeters: number,
	northMeters: number,
): Vector3 {
	return new Vector3()
		.addScaledVector( frame.east, eastMeters )
		.addScaledVector( frame.north, northMeters );
}

function projectedXY( local: Vector3, frame: PlainFrame ): [ number, number ] {
	return [ local.dot( frame.east ), local.dot( frame.north ) ];
}

function removeClosingDuplicate( points: readonly LonLatPoint[] ): LonLatPoint[] {
	if ( points.length < 2 ) {
		return points.map( p => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}
	const first = points[ 0 ];
	const last = points[ points.length - 1 ];
	const closes =
		Math.abs( first[ 0 ] - last[ 0 ] ) < 1.0e-12 &&
		Math.abs( first[ 1 ] - last[ 1 ] ) < 1.0e-12;
	const count = closes ? points.length - 1 : points.length;
	const out: LonLatPoint[] = [];
	for ( let i = 0; i < count; i++ ) {
		out.push( [ points[ i ][ 0 ], points[ i ][ 1 ] ] );
	}
	return out;
}

function createGeometry(
	localPositions: readonly Vector3[],
	frame: PlainFrame,
	indices?: readonly number[],
): BufferGeometry {
	const geometry = new BufferGeometry();
	const high = new Float32Array( localPositions.length * 3 );
	const low = new Float32Array( localPositions.length * 3 );

	for ( let i = 0; i < localPositions.length; i++ ) {
		const base = i * 3;
		const p = localPositions[ i ];
		const x = encodeScalarRTE( frame.origin.x + p.x );
		const y = encodeScalarRTE( frame.origin.y + p.y );
		const z = encodeScalarRTE( frame.origin.z + p.z );
		high[ base + 0 ] = x.high;
		high[ base + 1 ] = y.high;
		high[ base + 2 ] = z.high;
		low[ base + 0 ] = x.low;
		low[ base + 1 ] = y.low;
		low[ base + 2 ] = z.low;
	}

	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	if ( indices && indices.length > 0 ) {
		geometry.setIndex( Array.from( indices ) );
	}
	return geometry;
}

function createRteColorMaterial(
	colorInput: ColorRepresentation | undefined,
	fallback: ColorRepresentation,
	alpha: number,
	frameUniforms: PlainRteFrameUniforms,
): RawShaderMaterial {
	const color = safeColor( colorInput, fallback );
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: {
			u_encodedCameraPositionHigh: frameUniforms.u_encodedCameraPositionHigh,
			u_encodedCameraPositionLow: frameUniforms.u_encodedCameraPositionLow,
			u_modelViewProjectionRelativeToEye:
				frameUniforms.u_modelViewProjectionRelativeToEye,
			u_color: { value: new Vector4( color.r, color.g, color.b, alpha ) },
		},
		vertexShader: PLAIN_RTE_VERTEX_SHADER,
		fragmentShader: PLAIN_RTE_FRAGMENT_SHADER,
		transparent: alpha < 1.0,
		side: DoubleSide,
		// 不贴地图元是覆盖层：关闭深度测试，避免 height=0 时与椭球兜底或地形深度竞争。
		depthTest: false,
		depthWrite: false,
		toneMapped: false,
	} );
	material.name = 'PlainPlotRteColorMaterial';
	return material;
}

function createFillMaterial(
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): RawShaderMaterial {
	return createRteColorMaterial(
		style.fillColor,
		'#ffffff',
		alphaFromPercent( style.fillOpacity ),
		frameUniforms,
	);
}

function createStrokeMaterial(
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): RawShaderMaterial {
	return createRteColorMaterial(
		style.strokeColor,
		'#ffffff',
		alphaFromPercent( style.strokeOpacity ),
		frameUniforms,
	);
}

function createPlainMesh(
	geometry: BufferGeometry,
	material: RawShaderMaterial,
): Mesh {
	const mesh = new Mesh( geometry, material );
	// RTE 几何没有普通 position 包围球，关闭剔除以免视图边缘误裁。
	mesh.frustumCulled = false;
	return mesh;
}

const STROKE_POINT_EPSILON_SQ = 1.0e-12;
const STROKE_PHASE_EPSILON = 1.0e-9;
const STROKE_MITER_LIMIT = 4.0;
const LINE_NORMAL_HEIGHT_OFFSET_METERS = 1000.0;

function pushDistinctPoint( target: Vector3[], point: Vector3 ): void {
	const last = target[ target.length - 1 ];
	if ( last === undefined || last.distanceToSquared( point ) > STROKE_POINT_EPSILON_SQ ) {
		target.push( point.clone() );
	}
}

function sanitizeStrokePoints(
	points: readonly Vector3[],
	closed: boolean,
): Vector3[] {
	const out: Vector3[] = [];
	for ( const point of points ) {
		pushDistinctPoint( out, point );
	}
	if ( closed && out.length > 1 ) {
		const first = out[ 0 ];
		const last = out[ out.length - 1 ];
		if ( first.distanceToSquared( last ) <= STROKE_POINT_EPSILON_SQ ) {
			out.pop();
		}
	}
	return out;
}

function createDashedStrokeRuns(
	points: readonly Vector3[],
	dashLengthMeters: number,
	gapLengthMeters: number,
): Vector3[][] {
	const source = sanitizeStrokePoints( points, false );
	if ( source.length < 2 ) {
		return [];
	}

	const runs: Vector3[][] = [];
	let drawing = true;
	let phaseRemaining = dashLengthMeters;
	let currentRun: Vector3[] = [];

	for ( let i = 0; i < source.length - 1; i++ ) {
		const start = source[ i ];
		const end = source[ i + 1 ];
		const segmentLength = start.distanceTo( end );
		if ( segmentLength <= STROKE_PHASE_EPSILON ) {
			continue;
		}

		if ( drawing && currentRun.length === 0 ) {
			currentRun.push( start.clone() );
		}

		let travelled = 0.0;
		while ( travelled < segmentLength - STROKE_PHASE_EPSILON ) {
			const step = Math.min( phaseRemaining, segmentLength - travelled );
			const t = ( travelled + step ) / segmentLength;
			const point = start.clone().lerp( end, t );

			if ( drawing ) {
				pushDistinctPoint( currentRun, point );
			}

			travelled += step;
			phaseRemaining -= step;

			if ( phaseRemaining <= STROKE_PHASE_EPSILON ) {
				if ( drawing && currentRun.length >= 2 ) {
					runs.push( currentRun );
				}
				drawing = ! drawing;
				phaseRemaining = drawing ? dashLengthMeters : gapLengthMeters;
				currentRun = [];
				if ( drawing && travelled < segmentLength - STROKE_PHASE_EPSILON ) {
					currentRun.push( point.clone() );
				}
			}
		}
	}

	if ( drawing && currentRun.length >= 2 ) {
		runs.push( currentRun );
	}
	return runs;
}

function fallbackStrokeRight( up: Vector3, out: Vector3 ): Vector3 {
	const axis = Math.abs( up.z ) < 0.9
		? new Vector3( 0.0, 0.0, 1.0 )
		: new Vector3( 1.0, 0.0, 0.0 );
	out.crossVectors( axis, up ).normalize();
	return out;
}

function computeStrokeRight(
	start: Vector3,
	end: Vector3,
	up: Vector3,
	out: Vector3,
): Vector3 {
	out.subVectors( end, start );
	if ( out.lengthSq() <= STROKE_POINT_EPSILON_SQ ) {
		return fallbackStrokeRight( up, out );
	}
	out.normalize();
	out.cross( up );
	if ( out.lengthSq() <= STROKE_POINT_EPSILON_SQ ) {
		return fallbackStrokeRight( up, out );
	}
	out.normalize();
	return out;
}

function computeJoinOffset(
	previousRight: Vector3,
	nextRight: Vector3,
	halfWidthMeters: number,
	out: Vector3,
): Vector3 {
	out.copy( previousRight ).add( nextRight );
	if ( out.lengthSq() <= STROKE_POINT_EPSILON_SQ ) {
		out.copy( nextRight ).multiplyScalar( halfWidthMeters );
		return out;
	}

	out.normalize();
	const denominator = out.dot( nextRight );
	if ( Math.abs( denominator ) < 1.0e-4 ) {
		out.copy( nextRight ).multiplyScalar( halfWidthMeters );
		return out;
	}

	const miterLength = halfWidthMeters / denominator;
	if ( Math.abs( miterLength ) > halfWidthMeters * STROKE_MITER_LIMIT ) {
		out.copy( nextRight ).multiplyScalar( halfWidthMeters );
		return out;
	}

	out.multiplyScalar( miterLength );
	return out;
}

function appendStrokeRunGeometry(
	points: readonly Vector3[],
	closed: boolean,
	halfWidthMeters: number,
	up: Vector3,
	vertices: Vector3[],
	indices: number[],
): void {
	const source = sanitizeStrokePoints( points, closed );
	if ( source.length < 2 ) {
		return;
	}

	const segmentCount = closed ? source.length : source.length - 1;
	const segmentRights: Vector3[] = [];
	for ( let i = 0; i < segmentCount; i++ ) {
		const start = source[ i ];
		const end = source[ ( i + 1 ) % source.length ];
		segmentRights.push(
			computeStrokeRight( start, end, up, new Vector3() ),
		);
	}

	const baseVertex = vertices.length;
	for ( let i = 0; i < source.length; i++ ) {
		const offset = new Vector3();
		if ( ! closed && i === 0 ) {
			offset.copy( segmentRights[ 0 ] ).multiplyScalar( halfWidthMeters );
		} else if ( ! closed && i === source.length - 1 ) {
			offset.copy( segmentRights[ segmentRights.length - 1 ] )
				.multiplyScalar( halfWidthMeters );
		} else {
			const previousRight = segmentRights[
				( i - 1 + segmentRights.length ) % segmentRights.length
			];
			const nextRight = segmentRights[ i % segmentRights.length ];
			computeJoinOffset( previousRight, nextRight, halfWidthMeters, offset );
		}

		vertices.push( source[ i ].clone().add( offset ) );
		vertices.push( source[ i ].clone().sub( offset ) );
	}

	for ( let i = 0; i < segmentCount; i++ ) {
		const next = ( i + 1 ) % source.length;
		const left0 = baseVertex + i * 2;
		const right0 = left0 + 1;
		const left1 = baseVertex + next * 2;
		const right1 = left1 + 1;
		indices.push( left0, right0, left1, right0, right1, left1 );
	}
}

function createStrokeGeometry(
	localPositions: readonly Vector3[],
	widthMeters: number,
	up: Vector3,
	frame: PlainFrame,
	closedStroke: boolean,
	dashLengthMeters?: number,
	gapLengthMeters?: number,
): BufferGeometry | null {
	const halfWidthMeters = Math.max( widthMeters, 0.0 ) * 0.5;
	if ( halfWidthMeters <= 0.0 ) {
		return null;
	}

	const dashed = ! closedStroke &&
		dashLengthMeters !== undefined &&
		dashLengthMeters > 0.0 &&
		gapLengthMeters !== undefined &&
		gapLengthMeters > 0.0;
	const runs = dashed
		? createDashedStrokeRuns( localPositions, dashLengthMeters, gapLengthMeters )
		: [ localPositions ];

	const vertices: Vector3[] = [];
	const indices: number[] = [];
	for ( const run of runs ) {
		appendStrokeRunGeometry(
			run,
			dashed ? false : closedStroke,
			halfWidthMeters,
			up,
			vertices,
			indices,
		);
	}

	if ( vertices.length === 0 || indices.length === 0 ) {
		return null;
	}
	return createGeometry( vertices, frame, indices );
}

function readWallVector(
	array: readonly number[],
	index: number,
	out: Vector3,
): Vector3 {
	const base = index * 3;
	out.set( array[ base + 0 ], array[ base + 1 ], array[ base + 2 ] );
	return out;
}

function createDensifiedLineWall(
	points: readonly LonLatPoint[],
	heightMeters: number,
): DensifiedLine | null {
	try {
		const cartographics = preprocessLine(
			points.map( point => [ point[ 0 ], point[ 1 ] ] as LonLatPoint ),
			ArcType.GEODESIC,
		);
		return buildWallArrays(
			cartographics,
			false,
			ArcType.GEODESIC,
			LINE_DEFAULT_GRANULARITY,
			heightMeters,
			heightMeters + LINE_NORMAL_HEIGHT_OFFSET_METERS,
		);
	} catch {
		return null;
	}
}

function localPositionsFromWall(
	wall: DensifiedLine,
	frame: PlainFrame,
): Vector3[] {
	const positions: Vector3[] = [];
	const point = new Vector3();
	for ( let i = 0; i < wall.pointCount; i++ ) {
		readWallVector( wall.bottomPositionsArray, i, point );
		positions.push( point.clone().sub( frame.origin ) );
	}
	return positions;
}

function computeWallSegmentRights( wall: DensifiedLine ): Vector3[] {
	const rights: Vector3[] = [];
	const start = new Vector3();
	const end = new Vector3();
	const top = new Vector3();
	const forward = new Vector3();
	const up = new Vector3();

	for ( let i = 0; i < wall.pointCount - 1; i++ ) {
		readWallVector( wall.bottomPositionsArray, i, start );
		readWallVector( wall.bottomPositionsArray, i + 1, end );
		readWallVector( wall.topPositionsArray, i, top );
		forward.subVectors( end, start );
		up.subVectors( top, start );
		if ( forward.lengthSq() <= STROKE_POINT_EPSILON_SQ ||
			up.lengthSq() <= STROKE_POINT_EPSILON_SQ ) {
			rights.push( new Vector3( 1.0, 0.0, 0.0 ) );
			continue;
		}
		forward.normalize();
		up.normalize();
		rights.push( new Vector3().crossVectors( forward, up ).normalize() );
	}
	return rights;
}

function createGroundMatchedStrokeGeometry(
	wall: DensifiedLine,
	widthMeters: number,
	frame: PlainFrame,
): BufferGeometry | null {
	const halfWidthMeters = Math.max( widthMeters, 0.0 ) * 0.5;
	if ( halfWidthMeters <= 0.0 || wall.pointCount < 2 ) {
		return null;
	}

	const segmentRights = computeWallSegmentRights( wall );
	const vertices: Vector3[] = [];
	const indices: number[] = [];
	const center = new Vector3();
	const normal = new Vector3();
	const offset = new Vector3();

	for ( let i = 0; i < wall.pointCount; i++ ) {
		readWallVector( wall.bottomPositionsArray, i, center );
		readWallVector( wall.normalsArray, i, normal ).normalize();

		if ( i === 0 ) {
			offset.copy( segmentRights[ 0 ] ).multiplyScalar( halfWidthMeters );
		} else if ( i === wall.pointCount - 1 ) {
			offset.copy( segmentRights[ segmentRights.length - 1 ] )
				.multiplyScalar( halfWidthMeters );
		} else {
			const nextRight = segmentRights[ i ];
			const denominator = normal.dot( nextRight );
			const miterLength = Math.abs( denominator ) > 1.0e-4
				? halfWidthMeters / denominator
				: Number.POSITIVE_INFINITY;
			if (
				! Number.isFinite( miterLength ) ||
				Math.abs( miterLength ) > halfWidthMeters * STROKE_MITER_LIMIT
			) {
				offset.copy( nextRight ).multiplyScalar( halfWidthMeters );
			} else {
				offset.copy( normal ).multiplyScalar( miterLength );
			}
		}

		vertices.push( center.clone().add( offset ).sub( frame.origin ) );
		vertices.push( center.clone().sub( offset ).sub( frame.origin ) );
	}

	for ( let i = 0; i < wall.pointCount - 1; i++ ) {
		const left0 = i * 2;
		const right0 = left0 + 1;
		const left1 = ( i + 1 ) * 2;
		const right1 = left1 + 1;
		indices.push( left0, right0, left1, right0, right1, left1 );
	}

	return createGeometry( vertices, frame, indices );
}

function addStrokeMesh(
	group: Group,
	localPositions: readonly Vector3[],
	closedStroke: boolean,
	style: PlainStyle,
	frame: PlainFrame,
	frameUniforms: PlainRteFrameUniforms,
	dashLengthMeters?: number,
	gapLengthMeters?: number,
): void {
	const strokeAlpha = alphaFromPercent( style.strokeOpacity );
	if ( strokeAlpha <= MIN_ALPHA || style.strokeWidth <= 0.0 || localPositions.length < 2 ) {
		return;
	}

	const geometry = createStrokeGeometry(
		localPositions,
		style.strokeWidth,
		frame.up,
		frame,
		closedStroke,
		dashLengthMeters,
		gapLengthMeters,
	);
	if ( geometry === null ) {
		return;
	}

	group.add( createPlainMesh( geometry, createStrokeMaterial( style, frameUniforms ) ) );
}

function addPolygonMeshes(
	group: Group,
	localPositions: readonly Vector3[],
	flatXY: readonly number[],
	closedStroke: boolean,
	style: PlainStyle,
	frame: PlainFrame,
	frameUniforms: PlainRteFrameUniforms,
): void {
	const fillAlpha = alphaFromPercent( style.fillOpacity );
	if ( fillAlpha > MIN_ALPHA && localPositions.length >= 3 ) {
		const indices = earcut( flatXY, null, 2 );
		if ( indices.length >= 3 ) {
			group.add( createPlainMesh(
				createGeometry( localPositions, frame, indices ),
				createFillMaterial( style, frameUniforms ),
			) );
		}
	}

	addStrokeMesh( group, localPositions, closedStroke, style, frame, frameUniforms );
}

function buildPolygonGroup(
	points: readonly LonLatPoint[],
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): Group | null {
	const ring = removeClosingDuplicate( points );
	if ( ring.length < 3 ) {
		return null;
	}

	const heightMeters = resolveHeightMeters( style );
	const frame = createFrameForPoints( ring, heightMeters );
	const localPositions = ring.map( point => worldDeltaFromLonLat( point, frame, heightMeters ) );
	const flatXY: number[] = [];
	for ( const local of localPositions ) {
		const [ x, y ] = projectedXY( local, frame );
		flatXY.push( x, y );
	}

	const group = new Group();
	addPolygonMeshes(
		group,
		localPositions,
		flatXY,
		true,
		style,
		frame,
		frameUniforms,
	);
	return group;
}

function buildCircleGroup(
	center: LonLatPoint,
	radiusMeters: number,
	startAngleDegrees: number,
	sectorAngleDegrees: number,
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): Group | null {
	const radius = Math.max( radiusMeters, 0.01 );
	const heightMeters = resolveHeightMeters( style );
	const frame = createFrame( center[ 0 ], center[ 1 ], heightMeters );
	const absSweep = Math.abs( sectorAngleDegrees );
	const fullCircle = absSweep >= 359.999;
	const segmentCount = Math.max(
		8,
		Math.ceil( CIRCLE_SEGMENTS * Math.min( absSweep, 360.0 ) / 360.0 ),
	);
	const localPositions: Vector3[] = [];
	const flatXY: number[] = [];

	if ( ! fullCircle ) {
		localPositions.push( new Vector3() );
		flatXY.push( 0.0, 0.0 );
	}

	for ( let i = 0; i <= segmentCount; i++ ) {
		const t = i / segmentCount;
		const angle = ( startAngleDegrees + sectorAngleDegrees * t ) * DEG_TO_RAD;
		const eastMeters = Math.sin( angle ) * radius;
		const northMeters = Math.cos( angle ) * radius;
		localPositions.push( tangentOffset( frame, eastMeters, northMeters ) );
		flatXY.push( eastMeters, northMeters );
	}

	if ( fullCircle ) {
		localPositions.pop();
		flatXY.splice( flatXY.length - 2, 2 );
	}

	const group = new Group();
	addPolygonMeshes(
		group,
		localPositions,
		flatXY,
		true,
		style,
		frame,
		frameUniforms,
	);
	return group;
}

function buildPointGroup(
	options: Extract<PlotPointOptions, { pointStyle: 'circle' | 'square' }>,
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): Group | null {
	if ( options.points.length === 0 ) {
		return null;
	}
	if ( options.pointStyle === 'square' ) {
		const size = Math.max( options.size ?? 100.0, 0.01 );
		const half = size * 0.5;
		const heightMeters = resolveHeightMeters( style );
		const frame = createFrame( options.points[ 0 ][ 0 ], options.points[ 0 ][ 1 ], heightMeters );
		const localPositions = [
			tangentOffset( frame, - half, - half ),
			tangentOffset( frame, half, - half ),
			tangentOffset( frame, half, half ),
			tangentOffset( frame, - half, half ),
		];
		const group = new Group();
		addPolygonMeshes(
			group,
			localPositions,
			[ - half, - half, half, - half, half, half, - half, half ],
			true,
			style,
			frame,
			frameUniforms,
		);
		return group;
	}
	return buildCircleGroup(
		options.points[ 0 ],
		Math.max( options.size ?? 100.0, 0.01 ) * 0.5,
		0.0,
		360.0,
		style,
		frameUniforms,
	);
}

function buildImagePointGroup(
	options: Extract<PlotPointOptions, { pointStyle: 'image' }>,
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): { group: Group; release: () => void } | null {
	if ( options.points.length === 0 ) return null;
	if ( ! Number.isFinite( options.imageWidth ) || options.imageWidth <= 0.0 ||
		! Number.isFinite( options.imageHeight ) || options.imageHeight <= 0.0 ) {
		return null;
	}
	const imageUrl = resolvePlotPointImageUrl( options );
	if ( ! imageUrl ) return null;

	const frame = createFrame(
		options.points[ 0 ][ 0 ],
		options.points[ 0 ][ 1 ],
		resolveHeightMeters( style ),
	);
	const halfWidth = options.imageWidth * 0.5;
	const rotation = ( Number.isFinite( options.rotation ) ? options.rotation ?? 0.0 : 0.0 ) * DEG_TO_RAD;
	const cos = Math.cos( rotation );
	const sin = Math.sin( rotation );
	const offset = ( x: number, y: number ): Vector3 => tangentOffset(
		frame,
		x * cos + y * sin,
		- x * sin + y * cos,
	);
	const geometry = createGeometry(
		[
			offset( - halfWidth, 0.0 ),
			offset( halfWidth, 0.0 ),
			offset( halfWidth, options.imageHeight ),
			offset( - halfWidth, options.imageHeight ),
		],
		frame,
		[ 0, 1, 2, 0, 2, 3 ],
	);
	geometry.setAttribute(
		'uv',
		new BufferAttribute( new Float32Array( [ 0, 0, 1, 0, 1, 1, 0, 1 ] ), 2 ),
	);

	const textureHandle = acquireImageTexture( imageUrl );
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: {
			u_encodedCameraPositionHigh: frameUniforms.u_encodedCameraPositionHigh,
			u_encodedCameraPositionLow: frameUniforms.u_encodedCameraPositionLow,
			u_modelViewProjectionRelativeToEye: frameUniforms.u_modelViewProjectionRelativeToEye,
			u_decalTexture: { value: textureHandle.texture },
			u_decalOpacity: { value: alphaFromPercent( style.fillOpacity ) },
		},
		vertexShader: PLAIN_RTE_TEXTURE_VERTEX_SHADER,
		fragmentShader: PLAIN_RTE_TEXTURE_FRAGMENT_SHADER,
		transparent: true,
		premultipliedAlpha: true,
		side: DoubleSide,
		depthTest: false,
		depthWrite: false,
		toneMapped: false,
	} );
	material.name = 'PlainPlotRteImageMaterial';
	const mesh = createPlainMesh( geometry, material );
	const group = new Group();
	group.name = 'PlainPlotImagePoint';
	group.add( mesh );
	return { group, release: textureHandle.release };
}

function buildLineGroup(
	options: PlotLineOptions,
	style: PlainStyle,
	frameUniforms: PlainRteFrameUniforms,
): Group | null {
	const points = options.points ?? [];
	if ( points.length < 2 ) {
		return null;
	}

	const heightMeters = resolveHeightMeters( style );
	const frame = createFrameForPoints( points, heightMeters );
	const wall = createDensifiedLineWall( points, heightMeters );
	const localPositions = wall !== null
		? localPositionsFromWall( wall, frame )
		: points.map( point => worldDeltaFromLonLat( point, frame, heightMeters ) );
	const group = new Group();

	const isDash = options.strokeStyle === 'dashed';
	if ( wall !== null && ! isDash ) {
		const geometry = createGroundMatchedStrokeGeometry( wall, style.strokeWidth, frame );
		if ( geometry !== null ) {
			group.add( createPlainMesh(
				geometry,
				createStrokeMaterial( style, frameUniforms ),
			) );
		}
	} else {
		addStrokeMesh(
			group,
			localPositions,
			false,
			style,
			frame,
			frameUniforms,
			isDash ? 60.0 : undefined,
			isDash ? 40.0 : undefined,
		);
	}

	const start = options.startArrowStyle ?? null;
	const end = options.endArrowStyle ?? null;
	if ( start !== null ) {
		addLineArrowHead(
			group,
			localPositions[ 0 ],
			localPositions[ 1 ],
			start,
			style,
			frame,
			frameUniforms,
		);
	}
	if ( end !== null ) {
		const n = localPositions.length;
		addLineArrowHead(
			group,
			localPositions[ n - 1 ],
			localPositions[ n - 2 ],
			end,
			style,
			frame,
			frameUniforms,
		);
	}
	return group;
}

function addLineArrowHead(
	group: Group,
	tip: Vector3,
	tail: Vector3,
	arrowStyle: 'filledArrow' | 'unfilledArrow',
	style: PlainStyle,
	frame: PlainFrame,
	frameUniforms: PlainRteFrameUniforms,
): void {
	const direction = new Vector3().subVectors( tip, tail );
	if ( direction.lengthSq() < 1.0e-12 ) {
		return;
	}
	direction.normalize();
	let right = new Vector3().crossVectors( direction, frame.up );
	if ( right.lengthSq() < 1.0e-12 ) {
		right = frame.east.clone();
	} else {
		right.normalize();
	}

	const lengthMeters = Math.max( style.strokeWidth * 4.0, 1.0 );
	const widthMeters = Math.max( style.strokeWidth * 3.0, 0.8 );
	const base = tip.clone().addScaledVector( direction, - lengthMeters );
	const left = base.clone().addScaledVector( right, widthMeters * 0.5 );
	const rightPoint = base.clone().addScaledVector( right, - widthMeters * 0.5 );
	const positions = [ tip.clone(), left, rightPoint ];
	const flatXY = positions.flatMap( p => projectedXY( p, frame ) );

	if ( arrowStyle === 'filledArrow' ) {
		const fillStyle = {
			...style,
			fillColor: style.strokeColor,
			fillOpacity: style.strokeOpacity,
		};
		addPolygonMeshes( group, positions, flatXY, true, fillStyle, frame, frameUniforms );
		return;
	}

	addStrokeMesh( group, positions, true, style, frame, frameUniforms );
}

function buildTextGroup(
	options: PlotTextOptions,
	style: PlainStyle,
): Group | null {
	if ( options.points.length === 0 || typeof document === 'undefined' ) {
		return null;
	}

	const heightMeters = resolveHeightMeters( style );
	const anchor = options.points[ 0 ];
	const frame = createFrame( anchor[ 0 ], anchor[ 1 ], heightMeters );
	const canvas = createTextCanvas( options, style );
	const texture = new CanvasTexture( canvas );
	texture.needsUpdate = true;

	const material = new SpriteMaterial( {
		map: texture,
		transparent: true,
		// Text still uses a billboard sprite; line/fill precision is handled by RTE mesh paths.
		depthTest: false,
		depthWrite: false,
	} );
	const sprite = new Sprite( material );
	const metersPerPixel = Number.isFinite( options.scale ) && ( options.scale ?? 0 ) > 0
		? options.scale as number
		: 1.0;
	const widthMeters = canvas.width * metersPerPixel;
	const heightMetersBox = canvas.height * metersPerPixel;
	sprite.scale.set( widthMeters, heightMetersBox, 1.0 );

	const anchorShiftX =
		options.anchorX === 'left' ? widthMeters * 0.5
			: options.anchorX === 'right' ? - widthMeters * 0.5
				: 0.0;
	const anchorShiftY =
		options.anchorY === 'top' ? - heightMetersBox * 0.5
			: options.anchorY === 'bottom' ? heightMetersBox * 0.5
				: 0.0;
	sprite.position.copy( tangentOffset(
		frame,
		( options.offsetX ?? 0.0 ) + anchorShiftX,
		( options.offsetY ?? 0.0 ) + anchorShiftY,
	) );

	const group = new Group();
	group.position.copy( frame.origin );
	group.add( sprite );
	return group;
}

function createTextCanvas(
	options: PlotTextOptions,
	style: PlainStyle,
): HTMLCanvasElement {
	const padding = normalizePadding( options.padding );
	const fontSize = Math.max( options.fontSize ?? 16, 1 );
	const lines = String( options.content ?? '' ).split( /\r\n?|\n/g );
	const canvas = document.createElement( 'canvas' );
	const ctx = canvas.getContext( '2d' );
	if ( ! ctx ) {
		canvas.width = 1;
		canvas.height = 1;
		return canvas;
	}

	ctx.font = `${ fontSize }px sans-serif`;
	const measuredWidth = Math.max( 1.0, ...lines.map( line => ctx.measureText( line ).width ) );
	const lineHeight = fontSize * 1.2;
	const autoWidth = Math.ceil( measuredWidth + padding.left + padding.right );
	const autoHeight = Math.ceil( lineHeight * Math.max( lines.length, 1 ) + padding.top + padding.bottom );
	canvas.width = Math.max( 1, Math.ceil( options.boxWidth && options.boxWidth > 0 ? options.boxWidth : autoWidth ) );
	canvas.height = Math.max( 1, Math.ceil( options.boxHeight && options.boxHeight > 0 ? options.boxHeight : autoHeight ) );

	ctx.clearRect( 0, 0, canvas.width, canvas.height );
	ctx.font = `${ fontSize }px sans-serif`;
	ctx.textBaseline = 'alphabetic';

	const fillAlpha = alphaFromPercent( style.fillOpacity );
	if ( fillAlpha > MIN_ALPHA ) {
		ctx.globalAlpha = fillAlpha;
		ctx.fillStyle = safeColor( style.fillColor, '#000000' ).getStyle();
		ctx.fillRect( 0, 0, canvas.width, canvas.height );
	}

	if ( options.showBorder !== false && style.strokeWidth > 0.0 ) {
		const strokeAlpha = alphaFromPercent( style.strokeOpacity );
		if ( strokeAlpha > MIN_ALPHA ) {
			ctx.globalAlpha = strokeAlpha;
			ctx.strokeStyle = safeColor( style.strokeColor, '#ffffff' ).getStyle();
			ctx.lineWidth = Math.max( style.strokeWidth, 1.0 );
			ctx.strokeRect(
				ctx.lineWidth * 0.5,
				ctx.lineWidth * 0.5,
				canvas.width - ctx.lineWidth,
				canvas.height - ctx.lineWidth,
			);
		}
	}

	ctx.globalAlpha = 1.0;
	ctx.fillStyle = safeColor( options.fontColor ?? '#ffffff', '#ffffff' ).getStyle();
	ctx.textAlign =
		options.textAlign === 'center' ? 'center'
			: options.textAlign === 'right' ? 'right'
				: 'left';
	const textX =
		ctx.textAlign === 'center' ? canvas.width * 0.5
			: ctx.textAlign === 'right' ? canvas.width - padding.right
				: padding.left;
	const contentHeight = lineHeight * lines.length;
	const startY =
		options.verticalAlign === 'top' ? padding.top + fontSize
			: options.verticalAlign === 'bottom'
				? canvas.height - padding.bottom - contentHeight + fontSize
				: ( canvas.height - contentHeight ) * 0.5 + fontSize;
	for ( let i = 0; i < lines.length; i++ ) {
		ctx.fillText( lines[ i ], textX, startY + i * lineHeight );
	}
	ctx.globalAlpha = 1.0;
	return canvas;
}

function normalizePadding(
	padding: number | [ number, number, number, number ] | undefined,
): { top: number; right: number; bottom: number; left: number } {
	if ( Array.isArray( padding ) ) {
		return {
			top: Math.max( padding[ 0 ] ?? 0, 0 ),
			right: Math.max( padding[ 1 ] ?? 0, 0 ),
			bottom: Math.max( padding[ 2 ] ?? 0, 0 ),
			left: Math.max( padding[ 3 ] ?? 0, 0 ),
		};
	}
	const value = Math.max( padding ?? 4, 0 );
	return { top: value, right: value, bottom: value, left: value };
}
