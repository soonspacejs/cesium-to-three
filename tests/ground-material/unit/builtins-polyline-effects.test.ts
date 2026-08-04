import { DataTexture, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import {
	C23_FLOW_LINE_MATERIAL_SOURCE,
	C23_POLYLINE_DASH_MATERIAL_SOURCE,
	createFlowLineMaterial,
	createPolylineDashMaterial,
} from '../../../src/lib/ground/material/builtins';

describe( 'Polyline Dash Ground Material', () => {
	it( 'creates the documented fixed schema and defaults', () => {
		const material = createPolylineDashMaterial();

		expect( material.type ).toBe( 'PolylineDashGroundMaterial' );
		expect( Object.keys( material.uniforms ) ).toEqual( [
			'u_color',
			'u_dashLengthMeters',
			'u_gapLengthMeters',
			'u_offsetMeters',
		] );
		expect(( material.uniforms.u_color.value as Vector4 ).toArray() )
			.toEqual( [ 1, 1, 1, 1 ] );
		expect( material.uniforms.u_dashLengthMeters.value ).toBe( 16 );
		expect( material.uniforms.u_gapLengthMeters.value ).toBe( 8 );
		expect( material.uniforms.u_offsetMeters.value ).toBe( 0 );
		expect( material.fragmentShader ).toBe( C23_POLYLINE_DASH_MATERIAL_SOURCE );
		expect( material.fragmentShader ).toContain( 'materialInput.distanceAlongMeters' );
		expect( material.fragmentShader ).not.toContain( 'discard' );
	} );

	it( 'accepts negative phase offsets and a zero-gap solid degeneration', () => {
		const material = createPolylineDashMaterial( {
			color: '#336699',
			opacity: 0.4,
			dashLengthMeters: 12,
			gapLengthMeters: 0,
			offsetMeters: -7.5,
		} );
		const color = material.uniforms.u_color.value as Vector4;

		expect( color.w ).toBe( 0.4 );
		expect( material.uniforms.u_dashLengthMeters.value ).toBe( 12 );
		expect( material.uniforms.u_gapLengthMeters.value ).toBe( 0 );
		expect( material.uniforms.u_offsetMeters.value ).toBe( -7.5 );
		expect( material.fragmentShader ).toContain( 'mod(rawPhase + period, period)' );
	} );

	it.each( [ 0, -1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid dashLengthMeters %s',
		dashLengthMeters => {
			expect( () => createPolylineDashMaterial( { dashLengthMeters } ) ).toThrow( RangeError );
		},
	);

	it.each( [ -1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid gapLengthMeters %s',
		gapLengthMeters => {
			expect( () => createPolylineDashMaterial( { gapLengthMeters } ) ).toThrow( RangeError );
		},
	);
} );

describe( 'FlowLine Ground Material', () => {
	it( 'uses the same phase for equal absolute time at 30, 60, and 120 FPS', () => {
		const linePosition = 0.37;
		const repeat = 4.0;
		const speed = 0.6;
		const durationSeconds = 2.4;
		const phaseAt = ( frameRate: number ): number => {
			let timeSeconds = 0.0;
			for ( let frame = 0; frame < frameRate * durationSeconds; frame ++ ) {
				timeSeconds += 1.0 / frameRate;
			}
			const raw = linePosition * repeat - timeSeconds * speed;
			return raw - Math.floor( raw );
		};

		// The GLSL formula reads c23_time (seconds), never frame count or delta;
		// only floating accumulation noise remains between host sampling rates.
		const reference = phaseAt( 60 );
		expect( phaseAt( 30 ) ).toBeCloseTo( reference, 12 );
		expect( phaseAt( 120 ) ).toBeCloseTo( reference, 12 );
	} );

	it( 'creates one texture-capable fixed schema without a hidden phase or timer', () => {
		const material = createFlowLineMaterial();

		expect( material.type ).toBe( 'FlowLineGroundMaterial' );
		expect( Object.keys( material.uniforms ) ).toEqual( [
			'u_texture',
			'u_hasTexture',
			'u_color',
			'u_backgroundColor',
			'u_speed',
			'u_repeat',
			'u_trailFraction',
			'u_direction',
			'u_flipY',
		] );
		expect( material.uniforms.u_texture.value ).toBeNull();
		expect( material.uniforms.u_hasTexture.value ).toBe( 0 );
		expect(( material.uniforms.u_color.value as Vector4 ).toArray() )
			.toEqual( [ 0, 1, 1, 1 ] );
		expect(( material.uniforms.u_backgroundColor.value as Vector4 ).toArray() )
			.toEqual( [ 0, 0, 0, 0 ] );
		expect( material.uniforms.u_speed.value ).toBe( 1 );
		expect( material.uniforms.u_repeat.value ).toBe( 1 );
		expect( material.uniforms.u_trailFraction.value ).toBe( 0.35 );
		expect( material.uniforms.u_direction.value ).toBe( 1 );
		expect( material.uniforms.u_flipY.value ).toBe( 1 );
		expect( material.uniforms.u_phase ).toBeUndefined();
		expect( material.fragmentShader ).toBe( C23_FLOW_LINE_MATERIAL_SOURCE );
		expect( material.fragmentShader ).toContain( 'c23_time * max(u_speed, 0.0)' );
		expect( material.fragmentShader ).not.toContain( 'c23_deltaTime' );
		expect( material.fragmentShader ).not.toContain( 'c23_frameNumber' );
		expect( material.fragmentShader ).not.toContain( 'discard' );
	} );

	it( 'binds a borrowed scrolling texture without changing the shader schema', () => {
		const texture = new DataTexture( new Uint8Array( [ 255, 128, 0, 255 ] ), 1, 1 );
		const plain = createFlowLineMaterial();
		const textured = createFlowLineMaterial( { texture, color: '#ffffff', flipY: false } );

		expect( Object.keys( textured.uniforms ) ).toEqual( Object.keys( plain.uniforms ) );
		expect( textured.uniforms.u_texture.value ).toBe( texture );
		expect( textured.uniforms.u_hasTexture.value ).toBe( 1 );
		expect( textured.uniforms.u_flipY.value ).toBe( 0 );
		expect( textured.fragmentShader ).toContain( 'vec2 textureUv = vec2(cellPhase' );
		expect( textured.fragmentShader ).toContain( 'textureCoverage = texel.a' );
		texture.dispose();
	} );

	it( 'normalizes direction and preserves explicit background alpha', () => {
		const background = new Vector4( 0.02, 0.08, 0.12, 0.15 );
		const reverse = createFlowLineMaterial( {
			color: '#33ddff',
			opacity: 0.9,
			backgroundColor: background,
			speed: 0.6,
			repeat: 4.5,
			trailFraction: 0.3,
			direction: -100,
		} );
		const forward = createFlowLineMaterial( { direction: 0 } );

		expect( reverse.uniforms.u_direction.value ).toBe( -1 );
		expect( forward.uniforms.u_direction.value ).toBe( 1 );
		expect(( reverse.uniforms.u_backgroundColor.value as Vector4 ).toArray() )
			.toEqual( background.toArray() );
		expect( reverse.uniforms.u_backgroundColor.value ).not.toBe( background );
		expect(( reverse.uniforms.u_color.value as Vector4 ).w ).toBe( 0.9 );
	} );

	it( 'updates runtime values without changing source, schema, or version', () => {
		const material = createFlowLineMaterial();
		const source = material.fragmentShader;
		const schema = Object.keys( material.uniforms );

		material.setUniform( 'u_speed', 3.25 );
		material.setUniform( 'u_repeat', 8 );

		expect( material.version ).toBe( 0 );
		expect( material.fragmentShader ).toBe( source );
		expect( Object.keys( material.uniforms ) ).toEqual( schema );
	} );

	it.each( [ -1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid speed %s',
		speed => expect( () => createFlowLineMaterial( { speed } ) ).toThrow( RangeError ),
	);

	it.each( [ 0, -1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid repeat %s',
		repeat => expect( () => createFlowLineMaterial( { repeat } ) ).toThrow( RangeError ),
	);

	it.each( [ 0, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY ] )(
		'rejects invalid trailFraction %s',
		trailFraction => {
			expect( () => createFlowLineMaterial( { trailFraction } ) ).toThrow( RangeError );
		},
	);
} );
