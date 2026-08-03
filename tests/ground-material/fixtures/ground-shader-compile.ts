// ============================================================
// ground-shader-compile.ts
// Purpose: compile every Stage 3 assembler/compiler output with a real WebGL2
//          driver. Each pass uses its complete documented attribute layout and
//          canonical system wrappers; no shader compiler or Three class is mocked.
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
	DataTexture,
	Matrix3,
	Matrix4,
	Mesh,
	NearestFilter,
	OrthographicCamera,
	RGBAFormat,
	Scene,
	UnsignedByteType,
	Vector2,
	Vector3,
	Vector4,
	WebGLRenderer,
	type RawShaderMaterial,
} from 'three';

import { MAX_POLYGON_STYLE_VERTICES } from '../../../src/lib/ground/constants';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import { compileGroundPass } from '../../../src/lib/ground/material/compiler';
import type {
	GroundPrimitiveKind,
	GroundRenderPass,
	GroundSystemUniforms,
} from '../../../src/lib/ground/material/types';

export interface GroundShaderCompileError {
	pass: string;
	programLog: string;
	vertexLog: string;
	fragmentLog: string;
}

export interface GroundShaderCompileReport {
	ready: boolean;
	isWebGL2: boolean;
	compiledPasses: string[];
	programCount: number;
	errors: GroundShaderCompileError[];
}

declare global {
	interface Window {
		/** Installed only after all six real WebGL2 link operations complete. */
		__C23_GROUND_SHADER_COMPILE__?: GroundShaderCompileReport;
	}
}

const TEST_MATERIAL = new CesiumGroundMaterial( {
	type: 'WebGL2CompileFixture',
	uniforms: { u_gain: { value: 1.0 } },
	defines: { FIXTURE_GAIN_ENABLED: true },
	fragmentShader: /* glsl */ `
uniform float u_gain;

c23_material c23_getMaterial(c23_materialInput input) {
	c23_material result;
	result.diffuse = input.baseColor.rgb * u_gain;
	result.emission = vec3(0.0);
	result.alpha = input.baseColor.a;
	return result;
}
`,
} );

const TEST_APPEARANCE = new CesiumGroundMaterialAppearance( { material: TEST_MATERIAL } );

/** Creates a one-pixel packed-depth texture with valid nonempty data. */
function createDepthTexture(): DataTexture {
	const texture = new DataTexture(
		new Uint8Array( [ 128, 0, 0, 0 ] ),
		1,
		1,
		RGBAFormat,
		UnsignedByteType,
	);
	texture.minFilter = NearestFilter;
	texture.magFilter = NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}

/**
 * Provides concrete values for every canonical wrapper used by Stage 3 source.
 * Values need not describe a visible Earth scene because this fixture tests
 * compile/link; their Three-side types must still match the GLSL declarations.
 */
function createSystemUniforms( depthTexture: DataTexture ): GroundSystemUniforms {
	const polygonPoints = Array.from(
		{ length: MAX_POLYGON_STYLE_VERTICES },
		() => new Vector2(),
	);
	return Object.freeze( {
		czm_modelViewRelativeToEye: { value: new Matrix4() },
		czm_modelViewProjectionRelativeToEye: { value: new Matrix4() },
		czm_projection: { value: new Matrix4() },
		czm_normal: { value: new Matrix3() },
		czm_encodedCameraPositionMCHigh: { value: new Vector3( 7_000_000, 0, 0 ) },
		czm_encodedCameraPositionMCLow: { value: new Vector3() },
		czm_geometricToleranceOverMeter: { value: 0.001 },
		czm_sceneMode: { value: 3 },
		czm_currentFrustum: { value: new Vector3( 1, 10_000_000, 0 ) },
		czm_farDepthFromNearPlusOne: { value: 10_000_000 },
		czm_log2FarDepthFromNearPlusOne: { value: Math.log2( 10_000_000 ) },
		czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1 / Math.log2( 10_000_000 ) },
		czm_globeDepthTexture: { value: depthTexture },
		czm_viewport: { value: new Vector4( 0, 0, 64, 64 ) },
		czm_inverseProjection: { value: new Matrix4() },
		czm_frustumPlanes: { value: new Vector4( 1, -1, -1, 1 ) },
		czm_pixelRatio: { value: 1 },
		c23_globeMinimumAltitude: { value: 55_000 },
		c23_eastward: { value: new Vector3( 100, 0, 0 ) },
		c23_northward: { value: new Vector3( 0, 100, 0 ) },
		c23_fillColor: { value: new Vector4( 0.2, 0.7, 0.4, 1 ) },
		c23_strokeColor: { value: new Vector4( 1, 1, 1, 1 ) },
		c23_borderEnabled: { value: 1 },
		c23_borderWidthMeters: { value: 2 },
		c23_innerMetersRect: { value: new Vector4( 2, 2, 98, 98 ) },
		c23_cpuWestPlane: { value: new Vector4( 1, 0, 0, 0 ) },
		c23_cpuSouthPlane: { value: new Vector4( 0, 1, 0, 0 ) },
		c23_polygonBorderMode: { value: 0 },
		c23_polygonMiterStrokeMode: { value: 0 },
		c23_polygonPointCount: { value: 0 },
		c23_polygonPoints: { value: polygonPoints },
		c23_circleBorderMode: { value: 0 },
		c23_circleCenterMeters: { value: new Vector2( 50, 50 ) },
		c23_circleFillRadiusMeters: { value: 45 },
		c23_circleRenderRadiusMeters: { value: 50 },
		c23_circleRingCount: { value: 1 },
		c23_circleRingGapMeters: { value: 0 },
		c23_circleSectorStartRadians: { value: 0 },
		c23_circleSectorAngleRadians: { value: Math.PI * 2 },
		c23_lineColor: { value: new Vector4( 0.2, 0.8, 1, 1 ) },
		c23_lineWidthPixels: { value: 6 },
		c23_lineWidthMode: { value: 0 },
		c23_lineWidthMeters: { value: 8 },
		c23_lineTotalMeters: { value: 100 },
		c23_arrowWidthMode: { value: 0 },
		c23_arrowLengthPixels: { value: 24 },
		c23_arrowHalfWidthPixels: { value: 12 },
		c23_arrowLengthMeters: { value: 30 },
		c23_arrowHalfWidthMeters: { value: 15 },
		c23_arrowColor: { value: new Vector4( 1, 0.4, 0.2, 1 ) },
		c23_arrowStrokeHalfPixels: { value: 2 },
		c23_lineArrowClipEndEnabled: { value: 0 },
		c23_lineArrowClipStartEnabled: { value: 0 },
		c23_lineArrowStyleStart: { value: 0 },
		c23_lineArrowStyleEnd: { value: 0 },
		c23_time: { value: 0 },
		c23_deltaTime: { value: 0 },
		c23_frameNumber: { value: 0 },
	} );
}

/** Repeats one scalar/vector tuple for all three compile-only triangle vertices. */
function repeatedAttribute( tuple: readonly number[], itemSize: number ): BufferAttribute {
	return new BufferAttribute( new Float32Array( [ ...tuple, ...tuple, ...tuple ] ), itemSize );
}

function createSurfaceGeometry(): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( new Float32Array( [
		-0.5, -0.5, 0,
		0.5, -0.5, 0,
		0, 0.5, 0,
	] ), 3 ) );
	geometry.setAttribute( 'position3DLow', repeatedAttribute( [ 0, 0, 0 ], 3 ) );
	geometry.setAttribute( 'extrudeDirection', repeatedAttribute( [ 0, 0, 0 ], 3 ) );
	geometry.setAttribute( 'batchId', repeatedAttribute( [ 0 ], 1 ) );
	return geometry;
}

function createPolylineGeometry(): BufferGeometry {
	const geometry = createSurfaceGeometry();
	geometry.setAttribute( 'startHiAndForwardOffsetX', repeatedAttribute( [ 0, 0, 0, 1 ], 4 ) );
	geometry.setAttribute( 'startLoAndForwardOffsetY', repeatedAttribute( [ 0, 0, 0, 0 ], 4 ) );
	geometry.setAttribute( 'startNormalAndForwardOffsetZ', repeatedAttribute( [ 1, 0, 0, 0 ], 4 ) );
	geometry.setAttribute(
		'endNormalAndTextureCoordinateNormalizationX',
		repeatedAttribute( [ -1, 0, 0, 1 ], 4 ),
	);
	geometry.setAttribute(
		'rightNormalAndTextureCoordinateNormalizationY',
		repeatedAttribute( [ 0, 1, 0, 0 ], 4 ),
	);
	return geometry;
}

function createArrowGeometry(): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'arrowTipHigh', repeatedAttribute( [ 0, 0, 0 ], 3 ) );
	geometry.setAttribute( 'arrowTipLow', repeatedAttribute( [ 0, 0, 0 ], 3 ) );
	geometry.setAttribute( 'arrowBackDir', repeatedAttribute( [ 1, 0, 0 ], 3 ) );
	geometry.setAttribute( 'arrowRightDir', repeatedAttribute( [ 0, 1, 0 ], 3 ) );
	geometry.setAttribute( 'arrowUpDir', repeatedAttribute( [ 0, 0, 1 ], 3 ) );
	geometry.setAttribute( 'arrowCorner', repeatedAttribute( [ 1, 1, 1 ], 3 ) );
	geometry.setAttribute( 'arrowTerrainHeights', repeatedAttribute( [ 0, 100 ], 2 ) );
	geometry.setAttribute( 'arrowStyleId', repeatedAttribute( [ 0 ], 1 ) );
	return geometry;
}

interface CompileEntry {
	kind: GroundPrimitiveKind;
	pass: GroundRenderPass;
	geometry: BufferGeometry;
}

/** Compiles passes serially so a driver error can be attributed exactly. */
function compileAllGroundPasses(): GroundShaderCompileReport {
	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false,
		stencil: true,
		powerPreference: 'high-performance',
	} );
	renderer.setSize( 64, 64, false );
	renderer.debug.checkShaderErrors = true;
	document.body.appendChild( renderer.domElement );

	const gl = renderer.getContext();
	const errors: GroundShaderCompileError[] = [];
	let activePass = 'unassigned';
	renderer.debug.onShaderError = ( context, program, vertexShader, fragmentShader ) => {
		errors.push( {
			pass: activePass,
			programLog: context.getProgramInfoLog( program ) ?? '',
			vertexLog: context.getShaderInfoLog( vertexShader ) ?? '',
			fragmentLog: context.getShaderInfoLog( fragmentShader ) ?? '',
		} );
	};

	const depthTexture = createDepthTexture();
	const systemUniforms = createSystemUniforms( depthTexture );
	const entries: CompileEntry[] = [
		{ kind: 'surface', pass: 'frontStencil', geometry: createSurfaceGeometry() },
		{ kind: 'surface', pass: 'backStencil', geometry: createSurfaceGeometry() },
		{ kind: 'surface', pass: 'color', geometry: createSurfaceGeometry() },
		{ kind: 'decal', pass: 'color', geometry: createSurfaceGeometry() },
		{ kind: 'polyline', pass: 'polyline', geometry: createPolylineGeometry() },
		{ kind: 'arrow', pass: 'arrow', geometry: createArrowGeometry() },
	];
	const compiledMaterials: RawShaderMaterial[] = [];
	const compiledPasses: string[] = [];
	const camera = new OrthographicCamera( -1, 1, 1, -1, 0.1, 10 );
	camera.position.z = 2;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );

	for ( const entry of entries ) {
		activePass = `${ entry.kind }/${ entry.pass }`;
		const compiled = compileGroundPass( {
			primitiveKind: entry.kind,
			pass: entry.pass,
			appearance: TEST_APPEARANCE,
			systemUniforms,
			defaultMaterial: TEST_MATERIAL,
			pipelineState: {
				fragmentCull: true,
				debugVolume: false,
				attributeLayoutKey: `${ entry.kind }-fixture-v1`,
				primitiveId: activePass,
			},
		} );
		compiledMaterials.push( compiled.material );

		const scene = new Scene();
		scene.add( new Mesh( entry.geometry, compiled.material ) );
		renderer.compile( scene, camera );
		compiledPasses.push( activePass );
	}

	const report: GroundShaderCompileReport = {
		ready: true,
		isWebGL2: gl instanceof WebGL2RenderingContext,
		compiledPasses,
		programCount: renderer.info.programs?.length ?? 0,
		errors,
	};

	for ( const material of compiledMaterials ) material.dispose();
	for ( const entry of entries ) entry.geometry.dispose();
	depthTexture.dispose();
	renderer.dispose();
	return report;
}

try {
	window.__C23_GROUND_SHADER_COMPILE__ = compileAllGroundPasses();
} catch ( error ) {
	console.error( '[ground-shader-compile fixture] failed', error );
	throw error;
}
