import { Color, Texture, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
	C23_COLOR_GROUND_MATERIAL_SOURCE,
	createColorGroundMaterial,
	createTexturedDecalMaterial,
} from '../../../src/lib/ground/material/builtins';
import { computeLogicalMaterialKey } from '../../../src/lib/ground/material/logical-key';
import { validateGroundMaterialSource } from '../../../src/lib/ground/material/validation';

describe( 'Color Ground Material preset', () => {
	it( 'creates the documented white pass-through default', () => {
		const material = createColorGroundMaterial();
		expect( material.type ).toBe( 'ColorGroundMaterial' );
		expect( material.fragmentShader ).toBe( C23_COLOR_GROUND_MATERIAL_SOURCE );
		expect( material.uniforms.u_color.value ).toEqual( new Vector4( 1, 1, 1, 1 ) );
		expect( validateGroundMaterialSource( material, 'surface' ).declaredUserUniforms )
			.toEqual( [ 'u_color' ] );
	} );

	it( 'normalizes Three color representations and preserves requested opacity', () => {
		const material = createColorGroundMaterial( { color: '#336699', opacity: 0.35 } );
		const value = material.uniforms.u_color.value as Vector4;
		const expected = new Color( '#336699' );
		// ColorRepresentation follows Three's working-color-space conversion;
		// comparing with Color avoids incorrectly treating sRGB bytes as linear.
		expect( value.x ).toBeCloseTo( expected.r );
		expect( value.y ).toBeCloseTo( expected.g );
		expect( value.z ).toBeCloseTo( expected.b );
		expect( value.w ).toBe( 0.35 );
	} );

	it.each( [ -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid opacity %s',
		opacity => {
			expect( () => createColorGroundMaterial( { opacity } ) ).toThrow( RangeError );
		},
	);

	it( 'updates the existing wrapper without changing the logical compile key', () => {
		const material = createColorGroundMaterial();
		const wrapper = material.uniforms.u_color;
		const key = computeLogicalMaterialKey( material );
		material.setUniform( 'u_color', new Vector4( 0.5, 0.25, 1, 0.75 ) );

		expect( material.uniforms.u_color ).toBe( wrapper );
		expect( computeLogicalMaterialKey( material ) ).toBe( key );
		expect( material.version ).toBe( 0 );
	} );
} );

describe( 'Textured Decal Ground Material preset', () => {
	it( 'keeps the borrowed texture and fixed shader schema', () => {
		const texture = new Texture();
		const material = createTexturedDecalMaterial( {
			texture,
			opacity: 0.6,
			tint: new Vector4( 0.2, 0.4, 0.8, 0.5 ),
			flipY: false,
		} );

		expect( material.type ).toBe( 'TexturedDecalGroundMaterial' );
		expect( material.uniforms.u_texture.value ).toBe( texture );
		expect( material.uniforms.u_opacity.value ).toBe( 0.6 );
		expect( material.uniforms.u_flipY.value ).toBe( 0 );
		expect( material.fragmentShader ).toContain( 'uniform sampler2D u_texture' );
		expect( material.fragmentShader ).not.toContain( 'discard' );
		material.dispose();
		texture.dispose();
	} );

	it( 'rejects missing textures and invalid opacity', () => {
		expect( () => createTexturedDecalMaterial( {
			texture: null as unknown as Texture,
		} ) ).toThrow( /Three Texture/ );
		const texture = new Texture();
		expect( () => createTexturedDecalMaterial( { texture, opacity: 1.1 } ) )
			.toThrow( /inclusive range/ );
		texture.dispose();
	} );
} );
