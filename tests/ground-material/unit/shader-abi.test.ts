import { describe, expect, it } from 'vitest';

import {
	C23_GROUND_SHADER_ABI_VERSION,
	C23_SHADER_ABI_SOURCE,
	C23_SYSTEM_UNIFORM_NAMES,
	createFinalOutputSource,
	createGroundKindDefineSource,
	createGroundUserDefineSource,
	createMaterialInputSource,
} from '../../../src/lib/ground/material/shader-abi';

describe( 'Ground Shader ABI v1', () => {
	it( 'locks the public version, struct fields, order, and time uniforms', () => {
		expect( C23_GROUND_SHADER_ABI_VERSION ).toBe( 1 );
		expect( C23_SHADER_ABI_SOURCE ).toMatchSnapshot();
		expect( C23_SYSTEM_UNIFORM_NAMES ).toMatchSnapshot();
	} );

	it( 'emits exactly one kind define', () => {
		expect( createGroundKindDefineSource( 'surface' ) ).toBe( '#define C23_SURFACE 1' );
		expect( createGroundKindDefineSource( 'polyline' ) ).toBe( '#define C23_POLYLINE 1' );
		expect( createGroundKindDefineSource( 'decal' ) ).toBe( '#define C23_DECAL 1' );
		expect( createGroundKindDefineSource( 'arrow' ) ).toBe( '#define C23_ARROW 1' );
	} );

	it( 'emits sorted enabled defines while preserving false only in logical keys', () => {
		expect( createGroundUserDefineSource( {
			Z_DISABLED: false,
			B_NUMBER: 2.5,
			A_ENABLED: true,
			C_TOKEN: '(1 + 2)',
		} ) ).toBe( [
			'#define A_ENABLED 1',
			'#define B_NUMBER 2.5',
			'#define C_TOKEN (1 + 2)',
		].join( '\n' ) );
	} );

	it( 'initializes every input field and premultiplies final output exactly once', () => {
		const input = createMaterialInputSource();
		for ( const field of [
			'st', 'localMeters', 'baseColor', 'isStroke', 'positionEC',
			'positionToEyeEC', 'normalEC', 'distanceAlongMeters',
			'distanceAcrossMeters', 'lineTotalMeters', 'metersPerPixel',
		] ) {
			expect( input ).toContain( `c23_input.${ field } =` );
		}

		const output = createFinalOutputSource();
		expect( output ).toContain( '.alpha * c23_systemCoverage' );
		expect( output ).toContain( '.diffuse + c23_surfaceMaterial.emission' );
		expect( output ).toContain( 'c23_straightRgb * c23_finalAlpha' );
		expect( output ).not.toContain( 'clamp' );
		expect( output ).not.toContain( 'discard' );
	} );
} );
