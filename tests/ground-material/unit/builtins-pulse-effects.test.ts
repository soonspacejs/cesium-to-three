import { DataTexture, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
	C23_PULSE_POINT_MATERIAL_SOURCE,
	C23_SCALE_PULSE_MATERIAL_SOURCE,
	createPulsePointMaterial,
	createScalePulseMaterial,
} from '../../../src/lib/ground/material/builtins';

function cosinePulseWave( timeSeconds: number, periodSeconds: number, phase: number ): number {
	const unwrapped = timeSeconds / periodSeconds + phase;
	const phase01 = unwrapped - Math.floor( unwrapped );
	return 0.5 - 0.5 * Math.cos( Math.PI * 2 * phase01 );
}

function accumulatedTime( frameRate: number, durationSeconds: number ): number {
	let time = 0;
	for ( let frame = 0; frame < frameRate * durationSeconds; frame += 1 ) {
		time += 1 / frameRate;
	}
	return time;
}

describe( 'PulsePoint Ground Material', () => {
	it( 'follows min-mid-max-mid-min phases and equal absolute time at every FPS', () => {
		const phases = [ 0, 0.25, 0.5, 0.75, 1 ];
		expect( phases.map( time => cosinePulseWave( time, 1, 0 ) ) ).toEqual( [
			0, 0.49999999999999994, 1, 0.5000000000000001, 0,
		] );
		expect( cosinePulseWave( 0, 1, 0.25 ) ).toBeCloseTo( 0.5, 14 );
		const reference = cosinePulseWave( accumulatedTime( 60, 2.4 ), 1.5, 0.125 );
		expect( cosinePulseWave( accumulatedTime( 30, 2.4 ), 1.5, 0.125 ) )
			.toBeCloseTo( reference, 12 );
		expect( cosinePulseWave( accumulatedTime( 120, 2.4 ), 1.5, 0.125 ) )
			.toBeCloseTo( reference, 12 );
		expect( C23_PULSE_POINT_MATERIAL_SOURCE ).not.toContain( 'c23_deltaTime' );
		expect( C23_PULSE_POINT_MATERIAL_SOURCE ).not.toContain( 'c23_frameNumber' );
	} );

	it( 'creates the documented fixed schema and default footprint', () => {
		const material = createPulsePointMaterial();

		expect( material.type ).toBe( 'PulsePointGroundMaterial' );
		expect( Object.keys( material.uniforms ) ).toEqual( [
			'u_texture',
			'u_hasTexture',
			'u_color',
			'u_periodSeconds',
			'u_minScale',
			'u_maxScale',
			'u_minOpacity',
			'u_maxOpacity',
			'u_phase',
			'u_edgeSoftness',
			'u_footprintScale',
			'u_flipY',
		] );
		expect( material.uniforms.u_texture.value ).toBeNull();
		expect( material.uniforms.u_hasTexture.value ).toBe( 0 );
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
		expect( material.uniforms.u_flipY.value ).toBe( 1 );
		expect( material.fragmentShader ).toBe( C23_PULSE_POINT_MATERIAL_SOURCE );
		expect( material.fragmentShader ).toContain( 'c23_time / max(u_periodSeconds, 1e-6)' );
		expect( material.fragmentShader ).toContain( 'length((materialInput.st - vec2(0.5)) * 2.0)' );
		expect( material.fragmentShader ).not.toContain( 'discard' );
	} );

	it( 'samples an optional borrowed image inside the animated footprint', () => {
		const texture = new DataTexture( new Uint8Array( [ 255, 255, 255, 128 ] ), 1, 1 );
		const plain = createPulsePointMaterial();
		const textured = createPulsePointMaterial( { texture, flipY: false } );

		expect( Object.keys( textured.uniforms ) ).toEqual( Object.keys( plain.uniforms ) );
		expect( textured.uniforms.u_texture.value ).toBe( texture );
		expect( textured.uniforms.u_hasTexture.value ).toBe( 1 );
		expect( textured.uniforms.u_flipY.value ).toBe( 0 );
		expect( textured.fragmentShader ).toContain( 'sourceSt = (materialInput.st - vec2(0.5))' );
		expect( textured.fragmentShader ).toContain( 'texture(u_texture, sampleSt)' );
		texture.dispose();
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
	it( 'uses the same cosine scale at 30, 60, and 120 FPS', () => {
		const minScale = 0.7;
		const maxScale = 1.3;
		const scaleAt = ( time: number ): number =>
			minScale + ( maxScale - minScale ) * cosinePulseWave( time, 2, -0.2 );
		const reference = scaleAt( accumulatedTime( 60, 3.2 ) );
		expect( scaleAt( accumulatedTime( 30, 3.2 ) ) ).toBeCloseTo( reference, 12 );
		expect( scaleAt( accumulatedTime( 120, 3.2 ) ) ).toBeCloseTo( reference, 12 );
		expect( C23_SCALE_PULSE_MATERIAL_SOURCE ).not.toContain( 'c23_deltaTime' );
		expect( C23_SCALE_PULSE_MATERIAL_SOURCE ).not.toContain( 'c23_frameNumber' );
	} );

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
