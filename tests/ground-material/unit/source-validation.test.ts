import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';
import {
	validateGroundMaterialSource,
	validateGroundVertexSource,
} from '../../../src/lib/ground/material/validation';

const ENTRY_BODY = /* glsl */ `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	// Words in comments are not lexical operations: discard; main(); gl_FragDepth.
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a;
	return result;
}
`;

function createMaterial(
	fragmentShader: string,
	uniforms: Record<string, { value: unknown }> = {},
): CesiumGroundMaterial {
	return new CesiumGroundMaterial( {
		type: 'SourceValidationFixture',
		uniforms,
		fragmentShader,
	} );
}

function expectSourceError(
	fragmentShader: string,
	code: string,
	token?: string,
	uniforms: Record<string, { value: unknown }> = {},
): CesiumGroundMaterialError {
	let thrown: unknown;
	try {
		validateGroundMaterialSource( createMaterial( fragmentShader, uniforms ), 'surface' );
	} catch ( error ) {
		thrown = error;
	}
	expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
	const sourceError = thrown as CesiumGroundMaterialError;
	expect( sourceError.code ).toBe( code );
	if ( token !== undefined ) expect( sourceError.detail?.token ).toBe( token );
	expect( sourceError.detail ).toMatchObject( {
		materialType: 'SourceValidationFixture',
		kind: 'surface',
		abiVersion: 1,
	} );
	return sourceError;
}

describe( 'safe Ground Material source validation', () => {
	it( 'accepts helpers, constants, matching uniforms, comments, and conditional directives', () => {
		const source = /* glsl */ `
			uniform highp vec3 u_color;
			uniform float u_weights[4], u_opacity;
			const float USER_PI = 3.14159265359;

			float userWave(float x) { return sin(x * USER_PI); }

			#ifdef C23_SURFACE
				// A legal branch can inspect the library-owned kind macro.
			#elif defined(C23_POLYLINE)
			#endif

			${ ENTRY_BODY }
		`;
		const analysis = validateGroundMaterialSource( createMaterial( source, {
			u_color: { value: 'color' },
			u_opacity: { value: 1 },
			u_weights: { value: [ 1, 2, 3, 4 ] },
		} ), 'surface' );

		expect( analysis.declaredUserUniforms ).toEqual( [
			'u_color',
			'u_opacity',
			'u_weights',
		] );
		expect( analysis.tokenCount ).toBeGreaterThan( 20 );
		expect( Object.isFrozen( analysis ) ).toBe( true );
	} );

	it( 'ignores forbidden words in line and block comments without losing locations', () => {
		const source = /* glsl */ `
			/*
				void main() { discard; gl_FragDepth = 1.0; }
			*/
			${ ENTRY_BODY }
		`;
		expect( () => validateGroundMaterialSource( createMaterial( source ), 'decal' ) ).not.toThrow();

		const error = expectSourceError(
			`${ ENTRY_BODY.replace( 'return result;', 'discard;\n\treturn result;' ) }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'discard',
		);
		expect( error.detail?.line ).toBeTypeOf( 'number' );
		expect( error.detail?.column ).toBeTypeOf( 'number' );
	} );

	it.each( [
		[ '#version 300 es', '#version' ],
		[ '#include <common>', '#include' ],
		[ '#extension GL_EXT_frag_depth : enable', '#extension' ],
		[ '#line 12', '#line' ],
		[ '#pragma optimize(on)', '#pragma' ],
		[ '#define USER_MACRO 1', '#define' ],
		[ '#undef USER_MACRO', '#undef' ],
	] )( 'rejects forbidden preprocessor directive %s', ( directive, token ) => {
		expectSourceError(
			`${ directive }\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			token,
		);
	} );

	it.each( [
		[ 'precision highp float;', 'precision', 'precision-declaration-forbidden' ],
		[ 'layout(location=0) out vec4 userOutput;', 'layout', 'layout-declaration-forbidden' ],
		[ 'in vec2 userUv;', 'in', 'stage-interface-declaration-forbidden' ],
		[ 'out vec4 userOutput;', 'out', 'stage-interface-declaration-forbidden' ],
		[ 'varying vec2 userUv;', 'varying', 'stage-interface-declaration-forbidden' ],
	] )( 'rejects library-owned stage declaration: %s', ( declaration, token, reason ) => {
		const error = expectSourceError(
			`${ declaration }\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			token,
		);
		expect( error.detail?.reason ).toBe( reason );
	} );

	it.each( [
		[ 'uniform float c23_time;', 'c23_time' ],
		[ 'const float czm_custom = 1.0;', 'czm_custom' ],
		[ 'struct c23_material { vec3 value; };', 'c23_material' ],
		[ 'float C23_helper(float x) { return x; }', 'C23_helper' ],
	] )( 'rejects reserved top-level declaration: %s', ( declaration, token ) => {
		expectSourceError(
			`${ declaration }\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			token,
		);
	} );

	it( 'rejects main, fragment depth access, and real discard as distinct diagnostics', () => {
		expectSourceError(
			`void main() {}\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_MAIN_FORBIDDEN',
			'main',
		);
		expectSourceError(
			ENTRY_BODY.replace( 'return result;', 'gl_FragDepth = 1.0; return result;' ),
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'gl_FragDepth',
		);
		expectSourceError(
			ENTRY_BODY.replace( 'return result;', 'discard; return result;' ),
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'discard',
		);
	} );

	it( 'requires exactly one implementation with the exact ABI signature', () => {
		expectSourceError(
			'float userHelper(float x) { return x; }',
			'GROUND_MATERIAL_FUNCTION_MISSING',
			'c23_getMaterial',
		);
		expectSourceError(
			ENTRY_BODY.replace( 'c23_materialInput materialInput', 'c23_materialInput input' ),
			'GROUND_MATERIAL_FUNCTION_INVALID',
			'c23_getMaterial',
		);
		expectSourceError(
			`c23_material c23_getMaterial(c23_materialInput materialInput);\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_FUNCTION_INVALID',
			'c23_getMaterial',
		);
		expectSourceError(
			`${ ENTRY_BODY }\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_FUNCTION_INVALID',
			'c23_getMaterial',
		);
	} );

	it( 'requires a one-to-one GLSL uniform and wrapper schema', () => {
		const missingWrapper = expectSourceError(
			`uniform float u_speed;\n${ ENTRY_BODY }`,
			'GROUND_UNIFORM_NOT_DECLARED',
			'u_speed',
		);
		expect( missingWrapper.detail?.reason ).toBe( 'uniform-wrapper-missing' );

		const missingDeclaration = expectSourceError(
			ENTRY_BODY,
			'GROUND_UNIFORM_NOT_DECLARED',
			'u_speed',
			{ u_speed: { value: 1 } },
		);
		expect( missingDeclaration.detail?.reason ).toBe( 'uniform-declaration-missing' );
	} );

	it( 'rejects malformed lexical structure deterministically', () => {
		expectSourceError(
			`/* unterminated\n${ ENTRY_BODY }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'/*',
		);
		expectSourceError(
			`${ ENTRY_BODY } }`,
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'}',
		);
	} );
} );

describe( 'safe Ground vertex source validation', () => {
	it( 'accepts the exact vertex hook, time ABI, helpers, and backed uniforms', () => {
		const material = new CesiumGroundMaterial( {
			uniforms: { u_amplitude: { value: 0.01 } },
			vertexShader: /* glsl */ `
uniform float u_amplitude;
float userWave(float value) { return sin(value); }
void c23_vertexMain(
	c23_vertexInput vertexInput,
	inout c23_vertexOutput vertexOutput
) {
	float wave = userWave(vertexInput.positionEC.x + c23_time);
	vertexOutput.positionClip.y += wave * u_amplitude * vertexOutput.positionClip.w;
}
`,
			fragmentShader: ENTRY_BODY,
		} );

		const analysis = validateGroundVertexSource( material, 'surface' );
		expect( analysis.declaredUserUniforms ).toEqual( [ 'u_amplitude' ] );
		expect( analysis.tokenCount ).toBeGreaterThan( 20 );
		expect( () => validateGroundMaterialSource( material, 'surface' ) ).not.toThrow();
	} );

	it.each( [
		[ 'void main() {}', 'GROUND_MATERIAL_MAIN_FORBIDDEN', 'main' ],
		[
			'void c23_vertexMain(c23_vertexInput vertexInput, inout c23_vertexOutput vertexOutput) { gl_Position = vertexOutput.positionClip; }',
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'gl_Position',
		],
		[
			'#ifdef C23_PASS_COLOR\n#endif\nvoid c23_vertexMain(c23_vertexInput vertexInput, inout c23_vertexOutput vertexOutput) {}',
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			'C23_PASS_COLOR',
		],
	] )( 'rejects unsafe vertex source %#', ( vertexShader, code, token ) => {
		const material = new CesiumGroundMaterial( { vertexShader, fragmentShader: ENTRY_BODY } );
		let thrown: unknown;
		try {
			validateGroundVertexSource( material, 'surface' );
		} catch ( error ) {
			thrown = error;
		}
		expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
		expect(( thrown as CesiumGroundMaterialError ).code ).toBe( code );
		expect(( thrown as CesiumGroundMaterialError ).detail?.token ).toBe( token );
	} );

	it( 'requires the exact vertex signature and a wrapper for each declared uniform', () => {
		const invalidSignature = new CesiumGroundMaterial( {
			vertexShader: 'void c23_vertexMain(inout c23_vertexOutput vertexOutput) {}',
			fragmentShader: ENTRY_BODY,
		} );
		expect( () => validateGroundVertexSource( invalidSignature, 'surface' ) )
			.toThrow( /exactly void c23_vertexMain/ );

		const missingWrapper = new CesiumGroundMaterial( {
			vertexShader: /* glsl */ `
uniform float u_amplitude;
void c23_vertexMain(c23_vertexInput vertexInput, inout c23_vertexOutput vertexOutput) {}
`,
			fragmentShader: ENTRY_BODY,
		} );
		expect( () => validateGroundVertexSource( missingWrapper, 'surface' ) )
			.toThrow( /u_amplitude.*no user wrapper/ );
	} );
} );
