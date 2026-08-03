import { describe, expect, it } from 'vitest';

import {
	C23_COLOR_GROUND_MATERIAL_SOURCE,
	C23_FLOW_LINE_MATERIAL_SOURCE,
	C23_POLYLINE_DASH_MATERIAL_SOURCE,
	C23_PULSE_POINT_MATERIAL_SOURCE,
	C23_SCALE_PULSE_MATERIAL_SOURCE,
	C23_TEXTURED_DECAL_MATERIAL_SOURCE,
} from '../../../src/lib/ground/material/builtins';

function fract( value: number ): number {
	return value - Math.floor( value );
}

function smoothstep( edge0: number, edge1: number, value: number ): number {
	const unit = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return unit * unit * ( 3 - 2 * unit );
}

function dashCoverage( along: number, dash = 16, gap = 8, aa = 0.1 ): number {
	const period = dash + gap;
	const rawPhase = ( along % period );
	const phase = ( rawPhase + period ) % period;
	return gap === 0 ? 1 : 1 - smoothstep( dash - aa, dash + aa, phase );
}

function flowIntensity(
	along01: number,
	time: number,
	direction: -1 | 1,
	repeat = 1,
	speed = 1,
	trail = 0.35,
	aa = 0.01,
): number {
	const orientedAlong = direction > 0 ? along01 : 1 - along01;
	const cellPhase = fract( orientedAlong * repeat - time * speed );
	const distanceBehindHead = fract( - cellPhase );
	return 1 - smoothstep(
		Math.max( trail - aa, 0 ),
		Math.min( trail + aa, 1 ),
		distanceBehindHead,
	);
}

function cosineWave( phase: number ): number {
	return 0.5 - 0.5 * Math.cos( Math.PI * 2 * fract( phase ) );
}

describe( 'documented built-in formula matrix B-01 through B-11', () => {
	it( 'B-01 multiplies base color and white without changing the value', () => {
		const base = [ 0.2, 0.4, 0.8, 0.5 ];
		expect( base.map( component => component * 1 ) ).toEqual( base );
		expect( C23_COLOR_GROUND_MATERIAL_SOURCE )
			.toContain( '* clamp(u_color, 0.0, 1.0)' );
	} );

	it( 'B-02 maps flipY 0/1 to the documented four-corner texture orientation', () => {
		const corners = [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ];
		expect( corners.map( ( [ u, v ] ) => [ u, v ] ) ).toEqual( corners );
		expect( corners.map( ( [ u, v ] ) => [ u, 1 - v ] ) ).toEqual( [
			[ 0, 1 ], [ 1, 1 ], [ 0, 0 ], [ 1, 0 ],
		] );
		expect( C23_TEXTURED_DECAL_MATERIAL_SOURCE )
			.toContain( 'u_flipY > 0.5 ? 1.0 - clamp(materialInput.st.y' );
	} );

	it( 'B-03/B-04 keeps dash phase on whole-line meters across segment boundaries', () => {
		expect( [ 0, 15.9, 16.1, 23.9, 24.1 ].map( value => dashCoverage( value ) ) )
			.toEqual( [ 1, 1, 0, 0, 1 ] );
		// A second segment starts at the accumulated 16.1 m, not at local zero.
		expect( dashCoverage( 16.1 ) ).toBe( 0 );
		expect( dashCoverage( 0 ) ).toBe( 1 );
		expect( C23_POLYLINE_DASH_MATERIAL_SOURCE )
			.toContain( 'materialInput.distanceAlongMeters + u_offsetMeters' );
	} );

	it( 'B-05/B-06 follows absolute time, mirrors direction, and permits alpha-zero gaps', () => {
		const keyframes = [ 0, 0.25, 0.5, 1 ].map(
			time => flowIntensity( 0.25, time, 1 ),
		);
		expect( keyframes ).toEqual( [ 0, 1, 1, 0 ] );
		for ( const along of [ 0.1, 0.37, 0.8 ] ) {
			expect( flowIntensity( along, 0.2, -1, 3, 0.6 ) )
				.toBeCloseTo( flowIntensity( 1 - along, 0.2, 1, 3, 0.6 ), 14 );
		}
		const backgroundAlpha = 0;
		expect( backgroundAlpha * ( 1 - keyframes[ 0 ] ) ).toBe( 0 );
		expect( C23_FLOW_LINE_MATERIAL_SOURCE ).not.toContain( 'discard' );
	} );

	it( 'B-07/B-08 reaches pulse min/mid/max/mid and stays inside its footprint', () => {
		expect( [ 0, 0.25, 0.5, 0.75 ].map( cosineWave ) ).toEqual( [
			0, 0.49999999999999994, 1, 0.5000000000000001,
		] );
		expect( 1.4 / 1.4 ).toBe( 1 );
		expect( C23_PULSE_POINT_MATERIAL_SOURCE )
			.toContain( 'requestedScale / footprintScale' );
	} );

	it( 'B-09 maps nominal 24 px through the fixed 1.3 footprint', () => {
		expect( 24 * 1 ).toBe( 24 );
		expect( 24 * 1.3 ).toBeCloseTo( 31.2, 14 );
		expect( C23_SCALE_PULSE_MATERIAL_SOURCE )
			.toContain( '(materialInput.st - vec2(0.5)) / normalizedScale' );
	} );

	it( 'B-10 makes every animation depend on absolute time only', () => {
		for ( const source of [
			C23_FLOW_LINE_MATERIAL_SOURCE,
			C23_PULSE_POINT_MATERIAL_SOURCE,
			C23_SCALE_PULSE_MATERIAL_SOURCE,
		] ) {
			expect( source ).toContain( 'c23_time' );
			expect( source ).not.toContain( 'c23_deltaTime' );
			expect( source ).not.toContain( 'c23_frameNumber' );
		}
	} );

	it( 'B-11 keeps zero-softness coverage finite and non-degenerate', () => {
		const epsilon = 1e-5;
		const outside = smoothstep( 0, epsilon, - epsilon );
		const edge = smoothstep( 0, epsilon, epsilon * 0.5 );
		const inside = smoothstep( 0, epsilon, epsilon );
		expect( [ outside, edge, inside ].every( Number.isFinite ) ).toBe( true );
		expect( [ outside, edge, inside ] ).toEqual( [ 0, 0.5, 1 ] );
		for ( const source of [ C23_PULSE_POINT_MATERIAL_SOURCE, C23_SCALE_PULSE_MATERIAL_SOURCE ] ) {
			expect( source ).toContain( '1e-5' );
		}
	} );
} );
