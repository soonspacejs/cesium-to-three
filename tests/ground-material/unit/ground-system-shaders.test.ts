import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	createGroundClassificationColorShaders,
	createGroundClassificationStencilShaders,
	createGroundPolylineShaders,
} from '../../../src/lib/ground/material/ground-system-shaders';

const COLOR_MATERIAL = new CesiumGroundMaterial( {
	type: 'SystemShaderColorFixture',
	fragmentShader: /* glsl */ `
c23_material c23_getMaterial(c23_materialInput input) {
	c23_material result;
	result.diffuse = input.baseColor.rgb;
	result.emission = vec3(0.0);
	result.alpha = input.baseColor.a;
	return result;
}
`,
} );

describe( 'Ground classification stencil system shaders', () => {
	it( 'locks the complete front-stencil source pair', () => {
		const source = createGroundClassificationStencilShaders( 'surface', 'frontStencil' );
		expect( source ).toMatchSnapshot();
		expect( Object.isFrozen( source ) ).toBe( true );
	} );

	it( 'keeps front/back math identical while changing only the pass macro', () => {
		const front = createGroundClassificationStencilShaders( 'decal', 'frontStencil' );
		const back = createGroundClassificationStencilShaders( 'decal', 'backStencil' );

		expect( front.vertexShader ).toContain( '#define C23_PASS_FRONT_STENCIL 1' );
		expect( back.vertexShader ).toContain( '#define C23_PASS_BACK_STENCIL 1' );
		expect( front.vertexShader.split( '#define C23_PASS_FRONT_STENCIL 1' ).join( '' ) )
			.toBe( back.vertexShader.split( '#define C23_PASS_BACK_STENCIL 1' ).join( '' ) );
		expect( front.fragmentShader.split( '#define C23_PASS_FRONT_STENCIL 1' ).join( '' ) )
			.toBe( back.fragmentShader.split( '#define C23_PASS_BACK_STENCIL 1' ).join( '' ) );
	} );

	it( 'retains the strict stencil-only log-depth discard contract', () => {
		const { vertexShader, fragmentShader } = createGroundClassificationStencilShaders(
			'surface',
			'backStencil',
		);

		expect( vertexShader ).toContain( 'czm_modelViewProjectionRelativeToEye * positionRte' );
		expect( vertexShader ).toContain( 'extrudeDirection * extrusionDelta' );
		expect( fragmentShader ).toContain( 'depthFromNearPlusOne > czm_farDepthFromNearPlusOne' );
		expect( fragmentShader ).toContain( 'discard;' );
		expect( fragmentShader ).toContain( 'gl_FragDepth = log2(depthFromNearPlusOne)' );
		expect( fragmentShader ).not.toContain( 'c23_getMaterial' );
	} );

	it( 'locks the full surface color evaluation and safe finalizer source', () => {
		const source = createGroundClassificationColorShaders(
			'surface',
			COLOR_MATERIAL,
			true,
		);
		expect( source ).toMatchSnapshot();
		expect( source.fragmentShader ).toContain( 'c23_evaluateRectangle(evaluation)' );
		expect( source.fragmentShader ).toContain( 'c23_evaluatePolygon(evaluation)' );
		expect( source.fragmentShader ).toContain( 'c23_evaluateCircle(evaluation)' );
		expect( source.fragmentShader ).toContain( 'c23_systemCoverage = c23_surface.coverage' );
		expect( source.fragmentShader ).not.toContain( 'discard;' );
		expect( source.fragmentShader ).not.toContain( 'gl_FragDepth' );
	} );

	it( 'uses decal footprint inputs without enabling surface shape branches', () => {
		const source = createGroundClassificationColorShaders(
			'decal',
			COLOR_MATERIAL,
			false,
		);
		expect( source.fragmentShader ).toContain( '#define C23_DECAL 1' );
		expect( source.fragmentShader ).not.toContain( '#define C23_FRAGMENT_CULL 1' );
		expect( source.fragmentShader ).toContain( 'c23_input.st = c23_surface.st' );
		expect( source.fragmentShader ).not.toContain( 'discard;' );
	} );

	it( 'locks the full polyline reconstruction, membership, and ABI source', () => {
		const source = createGroundPolylineShaders( COLOR_MATERIAL, false );
		expect( source ).toMatchSnapshot();
		expect( source.vertexShader ).toContain( 'startHiAndForwardOffsetX' );
		expect( source.fragmentShader ).toContain( 'c23_polylineRayMissesEllipsoid' );
		expect( source.fragmentShader ).toContain( 'c23_polylineEyePointBeyondHorizon' );
		expect( source.fragmentShader ).toContain( 'c23_distanceAlongMeters' );
		expect( source.fragmentShader ).toContain( 'c23_input.distanceAcrossMeters = c23_acrossMeters' );
		expect( source.fragmentShader.match( /c23_getMaterial\(c23_input\)/g ) ).toHaveLength( 1 );
	} );

	it( 'adds debug box output only through a compile-time system define', () => {
		const normal = createGroundPolylineShaders( COLOR_MATERIAL, false );
		const debug = createGroundPolylineShaders( COLOR_MATERIAL, true );
		expect( normal.fragmentShader ).not.toContain( '#define C23_DEBUG_VOLUME 1' );
		expect( debug.fragmentShader ).toContain( '#define C23_DEBUG_VOLUME 1' );
	} );
} );
