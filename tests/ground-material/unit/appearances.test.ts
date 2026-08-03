import { RawShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';

const SOURCE = `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	return c23_material(materialInput.baseColor.rgb, materialInput.baseColor.a);
}`;

describe( 'Ground appearances', () => {
	it( 'safe appearance retains its material and always proxies material.version', () => {
		const material = new CesiumGroundMaterial( { fragmentShader: SOURCE } );
		const appearance = new CesiumGroundMaterialAppearance( { material } );

		expect( appearance.kind ).toBe( 'material' );
		expect( appearance.material ).toBe( material );
		expect( appearance.version ).toBe( 0 );
		material.needsUpdate = true;
		expect( appearance.version ).toBe( 1 );
	} );

	it( 'rejects non-Material safe appearance input with a stable code', () => {
		expect( () => new CesiumGroundMaterialAppearance( {
			material: {} as CesiumGroundMaterial,
		} ) ).toThrowError( expect.objectContaining( {
			code: 'GROUND_APPEARANCE_INCOMPATIBLE',
		} ) );
	} );

	it( 'Raw appearance retains original wrapper and immutable factory identities', () => {
		const wrapper = { value: 0.5 };
		const uniforms = { u_gain: wrapper };
		const factory = () => new RawShaderMaterial();
		const appearance = new CesiumGroundRawShaderAppearance( { uniforms, factory } );

		expect( appearance.kind ).toBe( 'raw' );
		expect( appearance.uniforms ).toBe( uniforms );
		expect( appearance.uniforms.u_gain ).toBe( wrapper );
		expect( appearance.factory ).toBe( factory );
		expect( appearance.version ).toBe( 0 );
	} );

	it( 'Raw uniform value updates do not change version', () => {
		const appearance = new CesiumGroundRawShaderAppearance( {
			uniforms: { u_gain: { value: 0.5 } },
			factory: () => new RawShaderMaterial(),
		} );

		appearance.uniforms.u_gain.value = 0.75;

		expect( appearance.version ).toBe( 0 );
	} );

	it( 'Raw needsUpdate increments and notifies once for every true assignment', () => {
		const appearance = new CesiumGroundRawShaderAppearance( {
			factory: () => new RawShaderMaterial(),
		} );
		const versions: number[] = [];
		appearance.addEventListener( 'change', () => versions.push( appearance.version ) );

		appearance.needsUpdate = false;
		appearance.needsUpdate = true;
		appearance.needsUpdate = true;

		expect( versions ).toEqual( [ 1, 2 ] );
		expect( appearance.version ).toBe( 2 );
	} );

	it( 'Raw dispose is repeatable, preserves version, and does not clear uniforms', () => {
		const wrapper = { value: 1 };
		const appearance = new CesiumGroundRawShaderAppearance( {
			uniforms: { u_gain: wrapper },
			factory: () => new RawShaderMaterial(),
		} );
		let count = 0;
		appearance.addEventListener( 'dispose', () => count += 1 );

		appearance.dispose();
		appearance.dispose();

		expect( count ).toBe( 2 );
		expect( appearance.version ).toBe( 0 );
		expect( appearance.uniforms.u_gain ).toBe( wrapper );
	} );

	it( 'rejects invalid Raw factories and reserved Raw uniform schemas', () => {
		expect( () => new CesiumGroundRawShaderAppearance( {
			factory: null as never,
		} ) ).toThrow( CesiumGroundMaterialError );
		expect( () => new CesiumGroundRawShaderAppearance( {
			uniforms: { c23_time: { value: 0 } },
			factory: () => new RawShaderMaterial(),
		} ) ).toThrowError( expect.objectContaining( {
			code: 'GROUND_RESERVED_IDENTIFIER',
		} ) );
	} );
} );
