import { DataTexture, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
	C23_PULSE_POINT_MATERIAL_SOURCE,
	C23_SCALE_PULSE_MATERIAL_SOURCE,
	createPulsePointMaterial,
	createScalePulseMaterial,
} from '../../../src/lib/ground/material/builtins';

describe( 'PulsePoint Ground Material', () => {
	it( 'creates the documented fixed schema and default footprint', () => {
		const material = createPulsePointMaterial();

		expect( material.type ).toBe( 'PulsePointGroundMaterial' );
		expect( Object.keys( material.uniforms ) ).toEqual( [
			'u_color',
			'u_periodSeconds',
			'u_minScale',
			'u_maxScale',
			'u_minOpacity',
			'u_maxOpacity',
			'u_phase',
			'u_edgeSoftness',
			'u_footprintScale',
		] );
		expect(( material.uniforms.u_color.value as Vector4 ).toArray() )
			.toEqual( [ 1, 1, 1, 1 ] );
		expect( material.uniforms.u_periodSeconds.value ).toBe( 1.5 );
		expect( material.uniforms.u_minScale.value ).toBe( 0.65 );
		expect( material.uniforms.u_maxScale.value ).toBe( 1 );
		expect( material.uniforms.u_minOpacity.value ).toBe( 0.25 );
		expect( material.uniforms.u_maxOpacity.value ).toBe( 1 );
		expect( material.uniforms.u_phase.value ).toBe( 0 );
		expect( material.uniforms.u_edgeSoftness.value ).toBe( 0.02 );
		expect( material.uniforms.u_footprintScale.value ).toBe( 1 );
		expect( material.fragmentShader ).toBe( C23_PULSE_POINT_MATERIAL_SOURCE );
		expect( material.fragmentShader ).toContain( 'c23_time / max(u_periodSeconds, 1e-6)' );
		expect( material.fragmentShader ).toContain( 'length((materialInput.st - vec2(0.5)) * 2.0)' );
		expect( material.fragmentShader ).not.toContain( 'discard' );
	} );

	it( 'preserves an explicit footprint for maxScale above one', () => {
		const material = createPulsePointMaterial( {
			color: '#ff6633',
			periodSeconds: 2,
			minScale: 0.4,
			maxScale: 1.4,
			minOpacity: 0.1,
			maxOpacity: 0.8,
			phase: -0.25,
			edgeSoftness: 0,
			footprintScale: 1.8,
		} );

		expect( material.uniforms.u_maxScale.value ).toBe( 1.4 );
		expect( material.uniforms.u_footprintScale.value ).toBe( 1.8 );
		expect(( material.uniforms.u_color.value as Vector4 ).w ).toBe( 1 );
		expect( material.uniforms.u_phase.value ).toBe( -0.25 );
	} );

	it( 'keeps cloned phase wrappers independent', () => {
		const original = createPulsePointMaterial( { phase: 0.25 } );
		const clone = original.clone();
		clone.setUniform( 'u_phase', 0.75 );

		expect( clone.uniforms.u_phase ).not.toBe( original.uniforms.u_phase );
		expect( original.uniforms.u_phase.value ).toBe( 0.25 );
		expect( clone.uniforms.u_phase.value ).toBe( 0.75 );
		expect( clone.fragmentShader ).toBe( original.fragmentShader );
		expect( clone.version ).toBe( 0 );
	} );

	it.each( [ 0, -1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid periodSeconds %s',
		periodSeconds => expect( () => createPulsePointMaterial( { periodSeconds } ) )
			.toThrow( RangeError ),
	);

	it( 'rejects invalid scale ordering and footprint budgets', () => {
		expect( () => createPulsePointMaterial( { minScale: 1.1, maxScale: 1 } ) )
			.toThrow( RangeError );
		expect( () => createPulsePointMaterial( { minScale: 0 } ) ).toThrow( RangeError );
		expect( () => createPulsePointMaterial( { maxScale: -1 } ) ).toThrow( RangeError );
		expect( () => createPulsePointMaterial( { maxScale: 1.4, footprintScale: 1.2 } ) )
			.toThrow( RangeError );
	} );

	it( 'rejects invalid opacity and edge softness values', () => {
		expect( () => createPulsePointMaterial( { minOpacity: -0.1 } ) ).toThrow( RangeError );
		expect( () => createPulsePointMaterial( { maxOpacity: 1.1 } ) ).toThrow( RangeError );
		expect( () => createPulsePointMaterial( { minOpacity: 0.9, maxOpacity: 0.8 } ) )
			.toThrow( RangeError );
		expect( () => createPulsePointMaterial( { edgeSoftness: -0.01 } ) )
			.toThrow( RangeError );
		expect( () => createPulsePointMaterial( { edgeSoftness: 0.51 } ) )
			.toThrow( RangeError );
	} );
} );

describe( 'ScalePulse Ground Material', () => {
	it( 'keeps textured and untextured variants on one fixed schema', () => {
		const plain = createScalePulseMaterial();
		const texture = new DataTexture( new Uint8Array( [ 255, 0, 0, 255 ] ), 1, 1 );
		const textured = createScalePulseMaterial( {
			texture,
			tint: new Vector4( 0.5, 0.75, 1, 0.8 ),
			opacity: 0.9,
			periodSeconds: 2,
			minScale: 0.6,
			maxScale: 1.3,
			phase: 0.25,
			edgeSoftness: 0,
			flipY: false,
		} );
		const schema = [
			'u_texture',
			'u_hasTexture',
			'u_tint',
			'u_opacity',
			'u_periodSeconds',
			'u_minScale',
			'u_maxScale',
			'u_phase',
			'u_edgeSoftness',
			'u_flipY',
			'u_footprintScale',
		];

		expect( plain.type ).toBe( 'ScalePulseGroundMaterial' );
		expect( Object.keys( plain.uniforms ) ).toEqual( schema );
		expect( Object.keys( textured.uniforms ) ).toEqual( schema );
		expect( plain.uniforms.u_texture.value ).toBeNull();
		expect( plain.uniforms.u_hasTexture.value ).toBe( 0 );
		expect( textured.uniforms.u_texture.value ).toBe( texture );
		expect( textured.uniforms.u_hasTexture.value ).toBe( 1 );
		expect( textured.uniforms.u_flipY.value ).toBe( 0 );
		expect( textured.uniforms.u_footprintScale.value ).toBe( 1.3 );
		expect( textured.fragmentShader ).toBe( C23_SCALE_PULSE_MATERIAL_SOURCE );
		expect( textured.fragmentShader ).toContain( 'if (u_hasTexture > 0.5)' );
		expect( textured.fragmentShader ).toContain( 'sourceSt = (materialInput.st - vec2(0.5))' );
		expect( textured.fragmentShader ).not.toContain( 'discard' );

		texture.dispose();
	} );

	it( 'uses documented defaults and keeps cloned phase independent', () => {
		const original = createScalePulseMaterial();
		const clone = original.clone();
		clone.setUniform( 'u_phase', 0.5 );

		expect( original.uniforms.u_hasTexture.value ).toBe( 0 );
		expect( original.uniforms.u_tint.value ).toEqual( new Vector4( 1, 1, 1, 1 ) );
		expect( original.uniforms.u_opacity.value ).toBe( 1 );
		expect( original.uniforms.u_periodSeconds.value ).toBe( 1.5 );
		expect( original.uniforms.u_minScale.value ).toBe( 0.75 );
		expect( original.uniforms.u_maxScale.value ).toBe( 1 );
		expect( original.uniforms.u_edgeSoftness.value ).toBe( 0.01 );
		expect( original.uniforms.u_flipY.value ).toBe( 1 );
		expect( original.uniforms.u_footprintScale.value ).toBe( 1 );
		expect( clone.uniforms.u_phase ).not.toBe( original.uniforms.u_phase );
		expect( original.uniforms.u_phase.value ).toBe( 0 );
		expect( clone.uniforms.u_phase.value ).toBe( 0.5 );
	} );

	it( 'rejects invalid scale, period, opacity, edge, and footprint values', () => {
		expect( () => createScalePulseMaterial( { periodSeconds: 0 } ) ).toThrow( RangeError );
		expect( () => createScalePulseMaterial( { minScale: 1.1, maxScale: 1 } ) )
			.toThrow( RangeError );
		expect( () => createScalePulseMaterial( { minScale: 0 } ) ).toThrow( RangeError );
		expect( () => createScalePulseMaterial( { opacity: 1.1 } ) ).toThrow( RangeError );
		expect( () => createScalePulseMaterial( { edgeSoftness: 0.51 } ) )
			.toThrow( RangeError );
		expect( () => createScalePulseMaterial( { maxScale: 1.3, footprintScale: 1.2 } ) )
			.toThrow( RangeError );
	} );
} );
