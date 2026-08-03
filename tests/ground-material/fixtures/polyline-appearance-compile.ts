// ============================================================
// polyline-appearance-compile.ts
// Purpose: exercise the public CesiumGroundPolylinePrimitive Appearance
//         routes with a real WebGL2 renderer. The fixture intentionally uses
//         one solid default line, one safe gradient line, and one Raw line so
//         constructor wiring, canonical wrapper binding, and Raw factory pass
//         dispatch are tested together rather than through isolated strings.
// ============================================================

import {
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	Vector4,
	WebGLRenderer,
} from 'three';

import { CesiumGroundPolylinePrimitive } from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';
import {
	createFlowLineMaterial,
	createPolylineDashMaterial,
} from '../../../src/lib/ground/material/builtins';

export interface PolylineAppearanceCompileReport {
	ready: boolean;
	isWebGL2: boolean;
	programCount: number;
	materialNames: string[];
	customUniformBound: boolean;
	rawPasses: string[];
	errors: string[];
}

declare global {
	interface Window {
		__C23_POLYLINE_APPEARANCE_COMPILE__?: PolylineAppearanceCompileReport;
	}
}

const SAFE_SOURCE = /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	float ratio = materialInput.lineTotalMeters > 0.0
		? materialInput.distanceAlongMeters / materialInput.lineTotalMeters
		: 0.0;
	c23_material result;
	result.diffuse = mix(vec3(0.1, 0.2, 0.8), vec3(0.9, 0.8, 0.1), ratio) * u_tint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`;

function compilePolylineAppearances(): PolylineAppearanceCompileReport {
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

	const safeMaterial = new CesiumGroundMaterial( {
		type: 'Stage7PolylineWebGL2Fixture',
		uniforms: { u_tint: { value: new Vector4( 1, 0.8, 0.7, 0.9 ) } },
		fragmentShader: SAFE_SOURCE,
	} );
	const safeAppearance = new CesiumGroundMaterialAppearance( { material: safeMaterial } );
	const dashAppearance = new CesiumGroundMaterialAppearance( {
		material: createPolylineDashMaterial( {
			dashLengthMeters: 24,
			gapLengthMeters: 12,
			offsetMeters: -6,
		} ),
	} );
	const flowAppearance = new CesiumGroundMaterialAppearance( {
		material: createFlowLineMaterial( {
			speed: 0.6,
			repeat: 4,
			trailFraction: 0.3,
			direction: -1,
		} ),
	} );
	const rawPasses: string[] = [];
	const rawAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			rawPasses.push( `${ context.primitiveKind}:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = 'Stage7RawPolyline';
			return material;
		},
	} );

	const createOptions = ( extra: Record<string, unknown> = {} ) => ( {
		points: [ [ 121.4, 31.2 ], [ 121.401, 31.2005 ], [ 121.402, 31.201 ] ] as [ number, number ][],
		strokeColor: '#336699',
		strokeOpacity: 80,
		visible: true,
		widthPixels: 4,
		...extra,
	} );
	const primitives = [
		new CesiumGroundPolylinePrimitive( createOptions() ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: safeAppearance } ) ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: rawAppearance } ) ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: dashAppearance } ) ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: flowAppearance } ) ),
	];

	const scene = new Scene();
	for ( const primitive of primitives ) scene.add( primitive.group );
	const camera = new PerspectiveCamera( 45, 1, 1, 1_000_000 );
	camera.position.z = 2;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );
	renderer.compile( scene, camera );

	const materialNames: string[] = [];
	for ( const primitive of primitives ) {
		const line = primitive.group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
		const material = line?.material as RawShaderMaterial;
		materialNames.push( material.name );
	}

	const safeLine = primitives[ 1 ].group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
	const safeLineMaterial = safeLine?.material as RawShaderMaterial;
	const report: PolylineAppearanceCompileReport = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		programCount: renderer.info.programs?.length ?? 0,
		materialNames,
		customUniformBound: safeLineMaterial.uniforms.u_tint === safeMaterial.uniforms.u_tint,
		rawPasses,
		errors,
	};

	for ( const primitive of primitives ) primitive.dispose();
	renderer.dispose();
	return report;
}

try {
	window.__C23_POLYLINE_APPEARANCE_COMPILE__ = compilePolylineAppearances();
} catch ( error ) {
	console.error( '[polyline-appearance fixture] failed', error );
	throw error;
}
