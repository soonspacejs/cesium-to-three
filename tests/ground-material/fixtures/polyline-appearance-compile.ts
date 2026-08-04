// ============================================================
// polyline-appearance-compile.ts
// Purpose: exercise the public CesiumGroundPolylinePrimitive Appearance
//         routes with a real WebGL2 renderer. The fixture intentionally uses
//         default, fragment-safe, vertex-only/default-fragment, and Raw routes
//         so constructor wiring, fallback wrapper binding, and Raw factory pass
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
	vertexOnlyUniformBound: boolean;
	vertexOnlyUsesDefaultDash: boolean;
	rawPasses: string[];
	arrowMaterialNames: string[];
	arrowCustomUniformBound: boolean;
	arrowRawPasses: string[];
	errors: string[];
	flowFrames: number;
	programCountBeforeFlowFrames: number;
	programCountAfterFlowFrames: number;
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

const SAFE_ARROW_SOURCE = /* glsl */ `
uniform vec4 u_arrowTint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_arrowTint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_arrowTint.a;
	return result;
}
`;

const VERTEX_ONLY_SOURCE = /* glsl */ `
uniform float u_amplitude;
void c23_vertexMain(
	c23_vertexInput vertexInput,
	inout c23_vertexOutput vertexOutput
) {
	vertexOutput.positionClip.y += u_amplitude * vertexOutput.positionClip.w;
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
	const vertexOnlyMaterial = new CesiumGroundMaterial( {
		type: 'VertexOnlyPolylineWebGL2Fixture',
		uniforms: { u_amplitude: { value: 0.002 } },
		vertexShader: VERTEX_ONLY_SOURCE,
	} );
	const vertexOnlyAppearance = new CesiumGroundMaterialAppearance( {
		material: vertexOnlyMaterial,
	} );
	const safeArrowLogicalMaterial = new CesiumGroundMaterial( {
		type: 'Stage9ArrowWebGL2Fixture',
		uniforms: { u_arrowTint: { value: new Vector4( 0.9, 0.4, 0.2, 1 ) } },
		fragmentShader: SAFE_ARROW_SOURCE,
	} );
	const safeArrowAppearance = new CesiumGroundMaterialAppearance( { material: safeArrowLogicalMaterial } );
	const dashAppearance = new CesiumGroundMaterialAppearance( {
		material: createPolylineDashMaterial( {
			dashLengthMeters: 24,
			gapLengthMeters: 12,
			offsetMeters: -6,
		} ),
	} );
	const flowMaterial = createFlowLineMaterial( {
			speed: 0.6,
			repeat: 4,
			trailFraction: 0.3,
			direction: -1,
	} );
	const flowAppearance = new CesiumGroundMaterialAppearance( { material: flowMaterial } );
	const rawPasses: string[] = [];
	const rawAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			rawPasses.push( `${ context.primitiveKind}:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = 'Stage7RawPolyline';
			return material;
		},
	} );
	const arrowRawPasses: string[] = [];
	const rawArrowAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			arrowRawPasses.push( `${ context.primitiveKind}:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = 'Stage9RawArrow';
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
		new CesiumGroundPolylinePrimitive( createOptions( {
			appearance: safeAppearance,
			arrowMode: 'both',
			arrowAppearance: safeArrowAppearance,
		} ) ),
		new CesiumGroundPolylinePrimitive( createOptions( {
			appearance: rawAppearance,
			arrowMode: 'right',
			arrowAppearance: rawArrowAppearance,
		} ) ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: dashAppearance } ) ),
		new CesiumGroundPolylinePrimitive( createOptions( { appearance: flowAppearance } ) ),
		new CesiumGroundPolylinePrimitive( createOptions( {
			appearance: vertexOnlyAppearance,
			dashEnabled: true,
			dashLengthMeters: 20,
			gapLengthMeters: 10,
		} ) ),
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
	const safeArrow = primitives[ 1 ].group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
	const safeArrowCompiledMaterial = safeArrow?.material as RawShaderMaterial;
	const rawArrow = primitives[ 2 ].group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
	const rawArrowMaterial = rawArrow?.material as RawShaderMaterial;
	const vertexOnlyLine = primitives[ 5 ].group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
	const vertexOnlyCompiledMaterial = vertexOnlyLine?.material as RawShaderMaterial;
	const programCountBeforeFlowFrames = renderer.info.programs?.length ?? 0;
	const flowFrames = 600;
	for ( let frame = 0; frame < flowFrames; frame ++ ) {
		// A real host may update speed or other uniform values between frames. The
		// logical Material schema/source stays fixed and renderer.compile must reuse
		// the same driver program instead of allocating a structural variant.
		flowMaterial.setUniform( 'u_speed', 0.25 + ( frame % 17 ) * 0.01 );
		renderer.compile( scene, camera );
	}
	const programCountAfterFlowFrames = renderer.info.programs?.length ?? 0;
	const report: PolylineAppearanceCompileReport = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		programCount: renderer.info.programs?.length ?? 0,
		materialNames,
		customUniformBound: safeLineMaterial.uniforms.u_tint === safeMaterial.uniforms.u_tint,
		vertexOnlyUniformBound:
			vertexOnlyCompiledMaterial.uniforms.u_amplitude === vertexOnlyMaterial.uniforms.u_amplitude,
		vertexOnlyUsesDefaultDash:
			vertexOnlyCompiledMaterial.uniforms.u_dashLengthMeters !== undefined &&
			vertexOnlyCompiledMaterial.fragmentShader.includes( 'uniform float u_dashLengthMeters;' ),
		rawPasses,
		arrowMaterialNames: [ safeArrowCompiledMaterial.name, rawArrowMaterial.name ],
		arrowCustomUniformBound:
			safeArrowCompiledMaterial.uniforms.u_arrowTint === safeArrowLogicalMaterial.uniforms.u_arrowTint,
		arrowRawPasses,
		errors,
		flowFrames,
		programCountBeforeFlowFrames,
		programCountAfterFlowFrames,
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
