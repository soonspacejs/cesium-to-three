// ============================================================
// Purpose: compile the two time-driven built-ins through real Ground point
//          delegates. The fixture checks both ScalePulse texture branches and
//          verifies that host frame updates mutate wrappers without creating
//          new Three programs.
// ============================================================

import {
	DataTexture,
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	WebGLRenderer,
} from 'three';

import { CesiumGroundPointPrimitive } from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import {
	createPulsePointMaterial,
	createScalePulseMaterial,
} from '../../../src/lib/ground/material/builtins';

export interface PulseEffectsCompileReport {
	ready: boolean;
	isWebGL2: boolean;
	errors: string[];
	materialNames: string[];
	pulseSourceValid: boolean;
	scaleSourceValid: boolean;
	textureBranchSchemaStable: boolean;
	timeValues: number[];
	programCountBeforeFrames: number;
	programCountAfterFrames: number;
	programObjectSetStable: boolean;
	compiledMaterialsStable: boolean;
	geometryCountBeforeFrames: number;
	geometryCountAfterFrames: number;
	textureCountBeforeFrames: number;
	textureCountAfterFrames: number;
	frameCount: number;
}

declare global {
	interface Window {
		__C23_PULSE_EFFECTS_COMPILE__?: PulseEffectsCompileReport;
	}
}

function compilePulseEffects(): PulseEffectsCompileReport {
	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false,
		stencil: true,
		powerPreference: 'high-performance',
	} );
	renderer.setSize( 64, 64, false );
	renderer.debug.checkShaderErrors = true;
	document.body.appendChild( renderer.domElement );

	const errors: string[] = [];
	renderer.debug.onShaderError = ( context, program, vertexShader, fragmentShader ) => {
		errors.push( [
			context.getProgramInfoLog( program ) ?? '',
			context.getShaderInfoLog( vertexShader ) ?? '',
			context.getShaderInfoLog( fragmentShader ) ?? '',
		].join( '\n' ) );
	};

	const pulseMaterial = createPulsePointMaterial( {
		color: '#ff5533',
		periodSeconds: 1.2,
		minScale: 0.55,
		maxScale: 1.25,
		minOpacity: 0.2,
		maxOpacity: 0.95,
		phase: 0.25,
	} );
	const scalePlainMaterial = createScalePulseMaterial( {
		periodSeconds: 1.6,
		minScale: 0.8,
		maxScale: 1.2,
		phase: -0.1,
	} );
	const texture = new DataTexture(
		new Uint8Array( [ 255, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255 ] ),
		2,
		2,
	);
	texture.needsUpdate = true;
	const scaleTexturedMaterial = createScalePulseMaterial( {
		texture,
		tint: '#66aaff',
		opacity: 0.9,
		periodSeconds: 1.6,
		minScale: 0.8,
		maxScale: 1.3,
		flipY: false,
	} );

	const pulsePoint = new CesiumGroundPointPrimitive( {
		position: [ 121.4, 31.2 ],
		shape: 'circle',
		size: 64 * 1.25,
		fillColor: '#ffffff',
		fillOpacity: 100,
		strokeColor: '#ffffff',
		strokeWidth: 0,
		strokeOpacity: 0,
		visible: true,
		appearance: new CesiumGroundMaterialAppearance( { material: pulseMaterial } ),
	} );
	const scalePlainPoint = new CesiumGroundPointPrimitive( {
		position: [ 121.401, 31.2 ],
		shape: 'square',
		size: 40 * 1.2,
		fillColor: '#ffffff',
		fillOpacity: 100,
		strokeColor: '#ffffff',
		strokeWidth: 0,
		strokeOpacity: 0,
		visible: true,
		appearance: new CesiumGroundMaterialAppearance( { material: scalePlainMaterial } ),
	} );
	const scaleTexturedPoint = new CesiumGroundPointPrimitive( {
		position: [ 121.402, 31.2 ],
		shape: 'square',
		size: 40 * 1.3,
		fillColor: '#ffffff',
		fillOpacity: 100,
		strokeColor: '#ffffff',
		strokeWidth: 0,
		strokeOpacity: 0,
		visible: true,
		appearance: new CesiumGroundMaterialAppearance( { material: scaleTexturedMaterial } ),
	} );
	const primitives = [ pulsePoint, scalePlainPoint, scaleTexturedPoint ];
	const scene = new Scene();
	for ( const primitive of primitives ) scene.add( primitive.classification.group );

	const camera = new PerspectiveCamera( 45, 1, 1, 1_000_000 );
	camera.position.z = 2;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );
	const depthTexture = new DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );
	depthTexture.needsUpdate = true;

	const frameState = {
		depthTexture,
		width: 64,
		height: 64,
		camera,
		timeSeconds: 3.25,
		deltaSeconds: 1 / 60,
		frameNumber: 12,
	};
	for ( const primitive of primitives ) primitive.update( frameState );
	renderer.compile( scene, camera );

	const materials = primitives.map( primitive =>
		primitive.classification.group.getObjectByName( 'CesiumClassificationColorCommand' )
			?.material as RawShaderMaterial,
	);
	const programsBeforeFrames = new Set( renderer.info.programs ?? [] );
	const programCountBeforeFrames = programsBeforeFrames.size;
	const geometryCountBeforeFrames = renderer.info.memory.geometries;
	const textureCountBeforeFrames = renderer.info.memory.textures;
	const materialsBeforeFrames = materials.slice();
	const frameCount = 600;
	for ( let frame = 1; frame <= frameCount; frame ++ ) {
		pulseMaterial.setUniform( 'u_phase', frame / frameCount );
		scalePlainMaterial.setUniform( 'u_phase', - frame / frameCount );
		scaleTexturedMaterial.setUniform( 'u_opacity', 0.5 + 0.5 * ( frame / frameCount ) );
		frameState.timeSeconds = 3.25 + frame / 60;
		frameState.deltaSeconds = 1 / 60;
		frameState.frameNumber = 12 + frame;
		for ( const primitive of primitives ) primitive.update( frameState );
		renderer.compile( scene, camera );
	}
	const programsAfterFrames = new Set( renderer.info.programs ?? [] );
	const programCountAfterFrames = programsAfterFrames.size;
	const materialsAfterFrames = primitives.map( primitive =>
		primitive.classification.group.getObjectByName( 'CesiumClassificationColorCommand' )
			?.material as RawShaderMaterial,
	);

	const report: PulseEffectsCompileReport = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		errors,
		materialNames: materials.map( material => material.name ),
		pulseSourceValid: materials[ 0 ].fragmentShader.includes( 'c23_time / max(u_periodSeconds, 1e-6)' ),
		scaleSourceValid: materials[ 1 ].fragmentShader.includes( 'if (u_hasTexture > 0.5)' ),
		textureBranchSchemaStable:
			Object.keys( materials[ 1 ].uniforms ).join( ',' ) === Object.keys( materials[ 2 ].uniforms ).join( ',' ) &&
			materials[ 1 ].uniforms.u_hasTexture.value === 0 &&
			materials[ 2 ].uniforms.u_hasTexture.value === 1,
		timeValues: materials.map( material => material.uniforms.c23_time.value as number ),
		programCountBeforeFrames,
		programCountAfterFrames,
		programObjectSetStable:
			programsBeforeFrames.size === programsAfterFrames.size &&
			[ ...programsBeforeFrames ].every( program => programsAfterFrames.has( program ) ),
		compiledMaterialsStable: materialsAfterFrames.every(
			( material, index ) => material === materialsBeforeFrames[ index ],
		),
		geometryCountBeforeFrames,
		geometryCountAfterFrames: renderer.info.memory.geometries,
		textureCountBeforeFrames,
		textureCountAfterFrames: renderer.info.memory.textures,
		frameCount,
	};

	for ( const primitive of primitives ) primitive.dispose();
	depthTexture.dispose();
	texture.dispose();
	renderer.dispose();
	return report;
}

try {
	window.__C23_PULSE_EFFECTS_COMPILE__ = compilePulseEffects();
} catch ( error ) {
	console.error( '[pulse-effects fixture] failed', error );
	throw error;
}
