import {
	BufferAttribute,
	BufferGeometry,
	GLSL3,
	Mesh,
	OrthographicCamera,
	RawShaderMaterial,
	Scene,
	WebGLRenderer,
} from 'three';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundRawShaderAppearance } from '../../../src/lib/ground/material/appearances';
import {
	compileGroundPass,
	type GroundCompiledMaterialDiagnostic,
} from '../../../src/lib/ground/material/compiler';

export interface RawShaderErrorReport {
	ready: boolean;
	isWebGL2: boolean;
	shaderErrors: string[];
	diagnostic: GroundCompiledMaterialDiagnostic;
	materialPreserved: boolean;
	materialName: string;
}

declare global {
	interface Window {
		__C23_RAW_SHADER_ERROR__?: RawShaderErrorReport;
	}
}

function runRawShaderError(): RawShaderErrorReport {
	const renderer = new WebGLRenderer( { antialias: false, stencil: true } );
	renderer.setSize( 32, 32, false );
	renderer.debug.checkShaderErrors = true;
	document.body.appendChild( renderer.domElement );
	const shaderErrors: string[] = [];
	renderer.debug.onShaderError = ( context, program, vertexShader, fragmentShader ) => {
		shaderErrors.push( [
			context.getProgramInfoLog( program ) ?? '',
			context.getShaderInfoLog( vertexShader ) ?? '',
			context.getShaderInfoLog( fragmentShader ) ?? '',
		].join( '\n' ) );
	};

	const fallback = new CesiumGroundMaterial( {
		fragmentShader: 'c23_material c23_getMaterial(c23_materialInput input) { return c23_material(input.baseColor.rgb, input.baseColor.a); }',
	} );
	const raw = new CesiumGroundRawShaderAppearance( {
		factory: () => new RawShaderMaterial( {
			name: 'IntentionallyBrokenRaw',
			glslVersion: GLSL3,
			vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position, 1.0); }',
			fragmentShader: 'precision highp float; out vec4 out_FragColor; void main() { this is invalid GLSL; }',
		} ),
	} );
	const compiled = compileGroundPass( {
		primitiveKind: 'polyline',
		pass: 'polyline',
		appearance: raw,
		systemUniforms: {},
		defaultMaterial: fallback,
		pipelineState: {
			fragmentCull: false,
			debugVolume: false,
			attributeLayoutKey: 'raw-error-position-v1',
			primitiveId: 'raw-gpu-error-fixture',
		},
	} );
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( [
		- 1, - 1, 0, 1, - 1, 0, 0, 1, 0,
	] ), 3 ) );
	const mesh = new Mesh( geometry, compiled.material );
	const scene = new Scene();
	scene.add( mesh );
	const camera = new OrthographicCamera( - 1, 1, 1, - 1, 0.1, 10 );
	camera.position.z = 2;
	camera.updateMatrixWorld( true );
	renderer.compile( scene, camera );
	// A draw forces onFirstUse/program diagnostics even when the browser exposes
	// KHR_parallel_shader_compile and compile() only queues the program.
	renderer.render( scene, camera );
	renderer.getContext().finish();

	const report = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		shaderErrors,
		diagnostic: compiled.material.userData.c23Ground as GroundCompiledMaterialDiagnostic,
		materialPreserved: mesh.material === compiled.material,
		materialName: compiled.material.name,
	};
	geometry.dispose();
	compiled.material.dispose();
	renderer.dispose();
	return report;
}

window.__C23_RAW_SHADER_ERROR__ = runRawShaderError();
