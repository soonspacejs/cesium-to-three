import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';
import {
	createCanonicalGroundSystemUniforms,
	createGroundTimeUniforms,
	mergeGroundUniforms,
} from '../../../src/lib/ground/material/system-uniforms';
import type { GroundRuntimeUniforms } from '../../../src/lib/ground/types';

describe( 'canonical Ground system uniforms', () => {
	it( 'aliases surface legacy wrappers without exposing legacy keys', () => {
		const viewport = { value: 'viewport' };
		const fill = { value: 'fill' };
		const stroke = { value: 'stroke' };
		const legacy = {
			czm_viewport: viewport,
			u_color: fill,
			u_borderColor: stroke,
		} as unknown as GroundRuntimeUniforms;
		const canonical = createCanonicalGroundSystemUniforms( legacy, 'surface' );

		expect( canonical.czm_viewport ).toBe( viewport );
		expect( canonical.c23_fillColor ).toBe( fill );
		expect( canonical.c23_strokeColor ).toBe( stroke );
		expect( canonical.u_color ).toBeUndefined();
		expect( Object.isFrozen( canonical ) ).toBe( true );
	} );

	it( 'maps the ambiguous legacy u_color to line color for polyline/arrow kinds', () => {
		const color = { value: 'line' };
		const width = { value: 7 };
		const legacy = {
			u_color: color,
			u_lineWidthPixels: width,
		} as unknown as GroundRuntimeUniforms;

		for ( const kind of [ 'polyline', 'arrow' ] as const ) {
			const canonical = createCanonicalGroundSystemUniforms( legacy, kind );
			expect( canonical.c23_lineColor ).toBe( color );
			expect( canonical.c23_lineWidthPixels ).toBe( width );
			expect( canonical.c23_fillColor ).toBeUndefined();
		}
	} );

	it( 'creates independent time wrappers with static zero defaults', () => {
		const first = createGroundTimeUniforms();
		const second = createGroundTimeUniforms();

		expect( first ).toEqual( {
			c23_time: { value: 0 },
			c23_deltaTime: { value: 0 },
			c23_frameNumber: { value: 0 },
		} );
		expect( second.c23_time ).not.toBe( first.c23_time );
	} );

	it( 'reuses pre-existing time wrappers when building the canonical map', () => {
		const existing = createGroundTimeUniforms();
		const legacy = {
			c23_time: existing.c23_time,
			c23_deltaTime: existing.c23_deltaTime,
			c23_frameNumber: existing.c23_frameNumber,
		} as unknown as GroundRuntimeUniforms;
		const replacement = createGroundTimeUniforms();
		const canonical = createCanonicalGroundSystemUniforms( legacy, 'surface', replacement );

		expect( canonical.c23_time ).toBe( existing.c23_time );
		expect( canonical.c23_deltaTime ).toBe( existing.c23_deltaTime );
		expect( canonical.c23_frameNumber ).toBe( existing.c23_frameNumber );
		expect( legacy.c23_time ).toBe( existing.c23_time );
	} );

	it( 'merges into a new map while preserving all system and user wrappers', () => {
		const systemWrapper = { value: 1 };
		const userWrapper = { value: 2 };
		const system = { c23_time: systemWrapper };
		const user = { u_color: userWrapper };
		const merged = mergeGroundUniforms( system, user );

		expect( merged ).not.toBe( system );
		expect( merged ).not.toBe( user );
		expect( merged.c23_time ).toBe( systemWrapper );
		expect( merged.u_color ).toBe( userWrapper );
	} );

	it( 'rejects collisions before overriding either wrapper', () => {
		const systemWrapper = { value: 1 };
		const userWrapper = { value: 2 };
		let thrown: unknown;
		try {
			mergeGroundUniforms(
				{ u_collision: systemWrapper },
				{ u_collision: userWrapper },
			);
		} catch ( error ) {
			thrown = error;
		}

		expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
		expect(( thrown as CesiumGroundMaterialError ).code ).toBe( 'GROUND_UNIFORM_CONFLICT' );
		expect( systemWrapper.value ).toBe( 1 );
		expect( userWrapper.value ).toBe( 2 );
	} );
} );
