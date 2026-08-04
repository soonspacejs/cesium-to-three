// ============================================================
// surface-appearance-compile.ts
// Purpose: link the Stage 5 safe surface Appearance through a real WebGL2
//          renderer for rectangle, polygon, and circle simultaneously.
// The fixture does not render a golden image; it verifies driver compilation,
// pass separation, and exact user-wrapper binding without mocking Three.
// ============================================================

import {
	Color,
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	DataTexture,
	WebGLRenderer,
	Vector4,
} from 'three';

import {
	CesiumGroundCirclePrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundRectanglePrimitive,
} from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import { CesiumGroundRawShaderAppearance } from '../../../src/lib/ground/material/appearances';

export interface SurfaceAppearanceCompileReport {
	ready: boolean;
	isWebGL2: boolean;
	programCount: number;
	colorMaterialNames: string[];
	customUniformBound: boolean[];
	stencilMaterialCallsMaterial: boolean[];
	rawPasses: string[];
	valueUpdateProgramSetStable: boolean;
	structuralProgramSetSizes: number[];
	structuralProgramSetChanges: number[];
	geometryStableAcrossRebuilds: boolean;
	errors: string[];
}

declare global {
	interface Window {
		__C23_SURFACE_APPEARANCE_COMPILE__?: SurfaceAppearanceCompileReport;
	}
}

const SAFE_SOURCE = /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_tint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`;

function compileSurfaceAppearances(): SurfaceAppearanceCompileReport {
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

	const appearance = new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'Stage5WebGL2Fixture',
			uniforms: { u_tint: { value: new Vector4( 1, 0.8, 0.7, 0.9 ) } },
			fragmentShader: SAFE_SOURCE,
		} ),
	} );
	const rawPasses: string[] = [];
	const rawAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			rawPasses.push( context.pass );
			const material = context.createDefaultMaterial();
			material.name = `Stage5Raw/${ context.pass }`;
			return material;
		},
	} );
	const rectangle = new CesiumGroundRectanglePrimitive( {
		points: [ [ 121.4, 31.2 ], [ 121.401, 31.2 ], [ 121.401, 31.201 ], [ 121.4, 31.201 ] ],
		strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
		fillColor: '#44aa66', fillOpacity: 80, visible: true, appearance,
	} );
	const polygon = new CesiumGroundPolygonPrimitive( {
		points: [ [ 121.4, 31.2 ], [ 121.401, 31.2 ], [ 121.401, 31.201 ] ],
		strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
		fillColor: '#44aa66', fillOpacity: 80, visible: true, appearance,
	} );
	const circle = new CesiumGroundCirclePrimitive( {
		center: [ 121.4, 31.2 ], radius: 50,
		strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
		fillColor: '#44aa66', fillOpacity: 80, visible: true, appearance,
	} );
	const rawCircle = new CesiumGroundCirclePrimitive( {
		center: [ 121.405, 31.2 ], radius: 50,
		strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
		fillColor: '#44aa66', fillOpacity: 80, visible: true, appearance: rawAppearance,
	} );

	const primitives = [ rectangle, polygon, circle, rawCircle ];
	const scene = new Scene();
	for ( const primitive of primitives ) scene.add( primitive.classification.group );
	const camera = new PerspectiveCamera( 45, 1, 1, 1_000_000 );
	camera.position.z = 2;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );
	renderer.compile( scene, camera );
	const safePrimitives = [ rectangle, polygon, circle ];
	const safeGeometries = safePrimitives.map( primitive =>
		primitive.classification.group.getObjectByName( 'CesiumClassificationColorCommand' )!.geometry,
	);
	const depthTexture = new DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );
	depthTexture.needsUpdate = true;
	const updateSafePrimitives = (): void => {
		for ( const primitive of safePrimitives ) {
			primitive.update( { depthTexture, width: 64, height: 64, camera } );
		}
		renderer.compile( scene, camera );
	};
	const programSet = () => new Set( renderer.info.programs ?? [] );
	const symmetricDifferenceSize = ( before: Set<unknown>, after: Set<unknown> ): number =>
		[ ...before ].filter( program => ! after.has( program ) ).length +
		[ ...after ].filter( program => ! before.has( program ) ).length;
	const warmPrograms = programSet();
	appearance.material.setUniform( 'u_tint', new Vector4( 0.8, 0.7, 1, 0.85 ) );
	updateSafePrimitives();
	const valuePrograms = programSet();
	const valueUpdateProgramSetStable =
		warmPrograms.size === valuePrograms.size &&
		[ ...warmPrograms ].every( program => valuePrograms.has( program ) );

	const structuralProgramSetSizes: number[] = [];
	const structuralProgramSetChanges: number[] = [];
	let previousPrograms = valuePrograms;
	const rebuild = ( mutate: () => void ): void => {
		mutate();
		appearance.material.needsUpdate = true;
		updateSafePrimitives();
		const nextPrograms = programSet();
		structuralProgramSetSizes.push( nextPrograms.size );
		structuralProgramSetChanges.push( symmetricDifferenceSize( previousPrograms, nextPrograms ) );
		previousPrograms = nextPrograms;
	};
	rebuild( () => {
		appearance.material.fragmentShader = appearance.material.fragmentShader.replace(
			'result.emission = vec3(0.0);',
			'result.emission = vec3(0.05);',
		);
	} );
	rebuild( () => { appearance.material.defines.ACCEPTANCE_VARIANT = 1; } );
	rebuild( () => {
		appearance.material.uniforms.u_extra = { value: 0.02 };
		appearance.material.fragmentShader = appearance.material.fragmentShader.replace(
			'uniform vec4 u_tint;',
			'uniform vec4 u_tint;\nuniform float u_extra;',
		).replace(
			'result.emission = vec3(0.05);',
			'result.emission = vec3(0.05 + u_extra);',
		);
	} );
	const geometryStableAcrossRebuilds = safePrimitives.every(
		( primitive, index ) => primitive.classification.group
			.getObjectByName( 'CesiumClassificationColorCommand' )!.geometry === safeGeometries[ index ],
	);

	const colorMaterialNames: string[] = [];
	const customUniformBound: boolean[] = [];
	const stencilMaterialCallsMaterial: boolean[] = [];
	for ( const primitive of primitives ) {
		const front = primitive.classification.group.getObjectByName(
			'CesiumClassificationFrontStencilDepthCommand',
		);
		const back = primitive.classification.group.getObjectByName(
			'CesiumClassificationBackStencilDepthCommand',
		);
		const color = primitive.classification.group.getObjectByName(
			'CesiumClassificationColorCommand',
		);
		const frontMaterial = front?.material as RawShaderMaterial;
		const backMaterial = back?.material as RawShaderMaterial;
		const colorMaterial = color?.material as RawShaderMaterial;
		colorMaterialNames.push( colorMaterial.name );
		customUniformBound.push(
			colorMaterial.uniforms.u_tint === appearance.material.uniforms.u_tint,
		);
		stencilMaterialCallsMaterial.push(
			frontMaterial.fragmentShader.includes( 'c23_getMaterial' ) ||
			backMaterial.fragmentShader.includes( 'c23_getMaterial' ),
		);
	}

	const report: SurfaceAppearanceCompileReport = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		programCount: renderer.info.programs?.length ?? 0,
		colorMaterialNames,
		customUniformBound,
		stencilMaterialCallsMaterial,
		rawPasses,
		valueUpdateProgramSetStable,
		structuralProgramSetSizes,
		structuralProgramSetChanges,
		geometryStableAcrossRebuilds,
		errors,
	};

	for ( const primitive of primitives ) primitive.dispose();
	depthTexture.dispose();
	renderer.dispose();
	return report;
}

try {
	window.__C23_SURFACE_APPEARANCE_COMPILE__ = compileSurfaceAppearances();
} catch ( error ) {
	console.error( '[surface-appearance fixture] failed', error );
	throw error;
}
