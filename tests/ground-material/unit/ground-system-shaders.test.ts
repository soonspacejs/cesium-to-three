import { describe, expect, it } from 'vitest';

import { createGroundClassificationStencilShaders } from '../../../src/lib/ground/material/ground-system-shaders';

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
} );
