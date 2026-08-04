import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DataTexture,
	GLSL3,
	KeepStencilOp,
	Mesh,
	NotEqualStencilFunc,
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	SRGBColorSpace,
	Vector3,
	WebGLRenderer,
} from 'three';

import {
	CesiumGlobeDepth,
	CesiumGroundImagePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundRectanglePrimitive,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	createCesiumEllipsoidDepthMeshes,
	initializeApproximateTerrainHeights,
	longitudeLatitudeFromCenterOffsetsMeters,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type CesiumClassificationPrimitive,
	type CesiumGroundFrameState,
	type LonLatPoint,
} from '../../../src/lib/ground';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import {
	createPulsePointMaterial,
	createScalePulseMaterial,
	createTexturedDecalMaterial,
} from '../../../src/lib/ground/material/builtins';

export interface StencilCleanupReport {
	ready: boolean;
	isWebGL2: boolean;
	errors: string[];
	cleanedRedPixels: number;
	controlRedPixels: number;
}

declare global {
	interface Window {
		__C23_STENCIL_CLEANUP__?: StencilCleanupReport;
	}
}

const WIDTH = 640;
const HEIGHT = 480;
const CENTER_LONGITUDE = 116.391;
const CENTER_LATITUDE = 39.907;
const IMAGE_URL = `data:image/svg+xml;charset=utf-8,${ encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="white"/></svg>',
) }`;

function point( eastMeters: number, northMeters: number ): LonLatPoint {
	const value = longitudeLatitudeFromCenterOffsetsMeters(
		CENTER_LONGITUDE,
		CENTER_LATITUDE,
		[ { eastMeters, northMeters } ],
	)[ 0 ];
	return [ value.longitude, value.latitude ];
}

function rectanglePoints( east: number, north: number ): LonLatPoint[] {
	return [
		point( east - 70, north - 55 ), point( east + 70, north - 55 ),
		point( east + 70, north + 55 ), point( east - 70, north + 55 ),
	];
}

function createStencilProbe(): Mesh {
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( [
		- 1, - 1, 0, 1, - 1, 0, 1, 1, 0,
		- 1, - 1, 0, 1, 1, 0, - 1, 1, 0,
	] ), 3 ) );
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position, 1.0); }',
		fragmentShader: 'precision highp float; out vec4 out_FragColor; void main() { out_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }',
		depthTest: false,
		depthWrite: false,
		stencilWrite: true,
		stencilFunc: NotEqualStencilFunc,
		stencilRef: 0,
		stencilFuncMask: 0x0f,
		stencilWriteMask: 0,
		stencilFail: KeepStencilOp,
		stencilZFail: KeepStencilOp,
		stencilZPass: KeepStencilOp,
		toneMapped: false,
	} );
	const probe = new Mesh( geometry, material );
	probe.frustumCulled = false;
	probe.renderOrder = 10000;
	return probe;
}

function countProbePixels( renderer: WebGLRenderer ): number {
	const gl = renderer.getContext();
	const pixels = new Uint8Array( WIDTH * HEIGHT * 4 );
	gl.readPixels( 0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels );
	let count = 0;
	for ( let index = 0; index < pixels.length; index += 4 ) {
		if ( pixels[ index ] > 245 && pixels[ index + 1 ] < 8 && pixels[ index + 2 ] < 8 ) {
			count += 1;
		}
	}
	return count;
}

async function preloadImage(): Promise<void> {
	const image = new Image();
	image.src = IMAGE_URL;
	await image.decode();
}

async function runStencilCleanupProbe(): Promise<StencilCleanupReport> {
	initializeApproximateTerrainHeights();
	await preloadImage();
	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false,
		stencil: true,
		preserveDrawingBuffer: true,
	} );
	renderer.setSize( WIDTH, HEIGHT, false );
	renderer.setPixelRatio( 1 );
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.setClearColor( new Color( '#081018' ), 1 );
	renderer.autoClear = true;
	renderer.autoClearStencil = true;
	renderer.debug.checkShaderErrors = true;
	validateCesiumGroundRenderer( renderer );
	document.body.appendChild( renderer.domElement );
	const errors: string[] = [];
	renderer.debug.onShaderError = ( context, program, vertexShader, fragmentShader ) => {
		errors.push( [
			context.getProgramInfoLog( program ) ?? '',
			context.getShaderInfoLog( vertexShader ) ?? '',
			context.getShaderInfoLog( fragmentShader ) ?? '',
		].join( '\n' ) );
	};

	const scene = new Scene();
	scene.background = new Color( '#081018' );
	const anchor = wgs84PositionFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE );
	const up = wgs84NormalFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE );
	const east = new Vector3( - anchor.y, anchor.x, 0 ).normalize();
	const camera = new PerspectiveCamera( 45, WIDTH / HEIGHT, 1, 40000000 );
	camera.position.copy( anchor ).addScaledVector( up, 750 ).addScaledVector( east, 180 );
	camera.up.set( 0, 0, 1 );
	camera.lookAt( anchor );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );

	const globeDepth = new CesiumGlobeDepth( WIDTH, HEIGHT );
	const { mainDepthMesh, packedDepthMesh } = createCesiumEllipsoidDepthMeshes( 128, 64 );
	scene.add( mainDepthMesh );
	globeDepth.addDepthMesh( packedDepthMesh );

	const alphaSplit = new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			fragmentShader: /* glsl */ `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = vec3(0.1, 0.8, 0.4);
	result.emission = vec3(0.0);
	result.alpha = materialInput.st.x < 0.5 ? 0.0 : materialInput.baseColor.a * 0.5;
	return result;
}
`,
		} ),
	} );
	const transparentTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 0 ] ), 1, 1 );
	transparentTexture.needsUpdate = true;
	const primitives = [
		new CesiumGroundRectanglePrimitive( {
			points: rectanglePoints( - 220, 80 ), strokeColor: '#ffffff', strokeWidth: 0,
			strokeOpacity: 0, fillColor: '#ffffff', fillOpacity: 100, visible: true,
			appearance: alphaSplit,
		} ),
		new CesiumGroundImagePrimitive( {
			position: point( 0, 80 ), imageUrl: IMAGE_URL, imageWidth: 140, imageHeight: 110,
			strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
			fillColor: '#ffffff', fillOpacity: 100, visible: true,
			appearance: new CesiumGroundMaterialAppearance( {
				material: createTexturedDecalMaterial( { texture: transparentTexture } ),
			} ),
		} ),
		new CesiumGroundPointPrimitive( {
			position: point( 220, 80 ), shape: 'circle', size: 140,
			strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
			fillColor: '#ffffff', fillOpacity: 100, visible: true,
			appearance: new CesiumGroundMaterialAppearance( {
				material: createPulsePointMaterial( { minScale: 0.25, maxScale: 0.5 } ),
			} ),
		} ),
		new CesiumGroundPointPrimitive( {
			position: point( 0, - 120 ), shape: 'square', size: 140,
			strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
			fillColor: '#ffffff', fillOpacity: 100, visible: true,
			appearance: new CesiumGroundMaterialAppearance( {
				material: createScalePulseMaterial( { minScale: 0.25, maxScale: 0.5 } ),
			} ),
		} ),
	];
	const classifications: CesiumClassificationPrimitive[] = primitives.map(
		primitive => primitive.classification,
	);
	for ( const primitive of primitives ) scene.add( primitive.classification.group );
	const probe = createStencilProbe();
	scene.add( probe );

	const render = (): void => {
		camera.updateMatrixWorld( true );
		updateTerrainLogDepthUniforms( camera.near, camera.far );
		globeDepth.render( renderer, camera );
		const frameState: CesiumGroundFrameState = {
			depthTexture: globeDepth.target.texture,
			width: WIDTH,
			height: HEIGHT,
			camera,
			timeSeconds: 0,
			deltaSeconds: 1 / 60,
			frameNumber: 0,
		};
		for ( const primitive of primitives ) primitive.update( frameState );
		renderer.render( scene, camera );
	};
	render();
	const cleanedRedPixels = countProbePixels( renderer );
	for ( const classification of classifications ) {
		classification.setCommandVisibility( { color: false } );
	}
	render();
	const controlRedPixels = countProbePixels( renderer );

	for ( const primitive of primitives ) primitive.dispose();
	probe.geometry.dispose();
	( probe.material as RawShaderMaterial ).dispose();
	mainDepthMesh.geometry.dispose();
	mainDepthMesh.material.dispose();
	packedDepthMesh.geometry.dispose();
	packedDepthMesh.material.dispose();
	globeDepth.dispose();
	transparentTexture.dispose();
	renderer.dispose();
	return {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		errors,
		cleanedRedPixels,
		controlRedPixels,
	};
}

runStencilCleanupProbe().then( report => {
	window.__C23_STENCIL_CLEANUP__ = report;
} ).catch( error => {
	console.error( '[stencil-cleanup] failed', error );
	throw error;
} );
