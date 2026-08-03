import { Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
	C23_PULSE_POINT_MATERIAL_SOURCE,
	createPulsePointMaterial,
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
