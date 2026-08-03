import { describe, expect, it } from 'vitest';

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
