import { describe, expect, it } from 'vitest';

import { validateCesiumGroundRenderer } from '../../../src/lib/ground/validation';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';
import {
	assertGroundDefines,
	assertGroundUserUniforms,
	assertUserUniformName,
	canonicalizeGroundDefines,
} from '../../../src/lib/ground/material/validation';

function expectGroundError( callback: () => void, code: string ): CesiumGroundMaterialError {
	try {
		callback();
	} catch ( error ) {
		expect( error ).toBeInstanceOf( CesiumGroundMaterialError );
		expect(( error as CesiumGroundMaterialError ).code ).toBe( code );
		return error as CesiumGroundMaterialError;
	}
	throw new Error( `Expected ${ code } to be thrown.` );
}

describe( 'Ground Material validation', () => {
	it( 'accepts ordinary u_* uniforms and rejects malformed or reserved names', () => {
		expect( () => assertUserUniformName( 'u_speed' ) ).not.toThrow();
		expect( () => assertUserUniformName( 'c23Foo' ) ).not.toThrow();
		expect( () => assertUserUniformName( 'u_c23_color' ) ).not.toThrow();

		expectGroundError( () => assertUserUniformName( '' ), 'GROUND_RESERVED_IDENTIFIER' );
		expectGroundError( () => assertUserUniformName( '9speed' ), 'GROUND_RESERVED_IDENTIFIER' );
		expectGroundError( () => assertUserUniformName( 'czm_view' ), 'GROUND_RESERVED_IDENTIFIER' );
		expectGroundError( () => assertUserUniformName( 'c23_time' ), 'GROUND_RESERVED_IDENTIFIER' );
		expectGroundError( () => assertUserUniformName( 'C23_SURFACE' ), 'GROUND_RESERVED_IDENTIFIER' );
	} );

	it( 'rejects user wrappers that collide with Three automatic uniforms', () => {
		const error = expectGroundError(
			() => assertUserUniformName( 'modelViewMatrix' ),
			'GROUND_UNIFORM_CONFLICT',
		);
		expect( error.detail ).toMatchObject( {
			identifier: 'modelViewMatrix',
			domain: 'three-automatic-uniform',
		} );
	} );

	it( 'validates every wrapper without cloning the supplied schema', () => {
		const wrapper = { value: 0.5 };
		const uniforms = { u_speed: wrapper };
		expect( () => assertGroundUserUniforms( uniforms ) ).not.toThrow();
		expect( uniforms.u_speed ).toBe( wrapper );

		expect( () => assertGroundUserUniforms( {
			u_missingValue: {} as { value: unknown },
		} ) ).toThrow( /value property/ );
	} );

	it( 'accepts safe define values and canonicalizes insertion order', () => {
		const defines = { Z_LAST: false, A_FIRST: true, MID: 2.5, TOKEN: '(1 + 2)' };
		expect( () => assertGroundDefines( defines ) ).not.toThrow();
		expect( canonicalizeGroundDefines( defines ) ).toEqual( [
			[ 'A_FIRST', true ],
			[ 'MID', 2.5 ],
			[ 'TOKEN', '(1 + 2)' ],
			[ 'Z_LAST', false ],
		] );
	} );

	it.each( [
		[ 'C23_SURFACE', true ],
		[ 'BAD-NAME', true ],
		[ 'NOT_FINITE', Number.POSITIVE_INFINITY ],
		[ 'NEWLINE', '1\n#define INJECTED 1' ],
		[ 'HASH', '#include <bad>' ],
		[ 'LINE_COMMENT', '1 // injected' ],
		[ 'BLOCK_COMMENT', '1 /* injected */' ],
	] )( 'rejects unsafe define %s', ( name, value ) => {
		expect( () => assertGroundDefines( { [ name ]: value } as never ) ).toThrow(
			CesiumGroundMaterialError,
		);
	} );
} );

describe( 'Ground renderer validation', () => {
	function createRendererStub( isWebGL2: boolean, stencilBits: number ) {
		const gl = {
			STENCIL_BITS: 0x0D57,
			getParameter: ( parameter: number ) => {
				expect( parameter ).toBe( gl.STENCIL_BITS );
				return stencilBits;
			},
		};
		return {
			capabilities: { isWebGL2 },
			getContext: () => gl,
		};
	}

	it( 'accepts WebGL2 renderers with an 8-bit or wider stencil buffer', () => {
		for ( const bits of [ 8, 16 ] ) {
			expect( () => validateCesiumGroundRenderer(
				createRendererStub( true, bits ) as never,
			) ).not.toThrow();
		}
	} );

	it( 'reports the unsupported WebGL1 boundary before inspecting stencil bits', () => {
		const renderer = createRendererStub( false, 0 );
		expect( () => validateCesiumGroundRenderer( renderer as never ) )
			.toThrow( 'Cesium ground classification requires WebGL2' );
	} );

	it( 'reports a missing 8-bit stencil buffer', () => {
		for ( const bits of [ 0, 7 ] ) {
			expect( () => validateCesiumGroundRenderer(
				createRendererStub( true, bits ) as never,
			) ).toThrow( 'requires an 8-bit stencil buffer' );
		}
	} );
} );
