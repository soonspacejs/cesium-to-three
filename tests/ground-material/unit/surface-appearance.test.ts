import { RawShaderMaterial, Vector4 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
	CesiumGroundCirclePrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundRectanglePrimitive,
} from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';

/** A valid surface Material used to prove public option/getter forwarding. */
function createSurfaceAppearance(): CesiumGroundMaterialAppearance {
	return new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'SurfaceOptionFixture',
			uniforms: { u_tint: { value: new Vector4( 1, 1, 1, 1 ) } },
			fragmentShader: /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_tint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`,
		} ),
	} );
}

describe( 'surface primitive safe Appearance forwarding', () => {
	it( 'forwards the exact Appearance through rectangle, polygon, and circle', () => {
		const appearance = createSurfaceAppearance();
		const rectangle = new CesiumGroundRectanglePrimitive( {
			points: [ [ 121.4, 31.2 ], [ 121.401, 31.2 ], [ 121.401, 31.201 ], [ 121.4, 31.201 ] ],
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
			appearance,
		} );
		const polygon = new CesiumGroundPolygonPrimitive( {
			points: [ [ 121.4, 31.2 ], [ 121.401, 31.2 ], [ 121.401, 31.201 ] ],
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
			appearance,
		} );
		const circle = new CesiumGroundCirclePrimitive( {
			center: [ 121.4, 31.2 ],
			radius: 50,
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
			appearance,
		} );

		expect( rectangle.appearance ).toBe( appearance );
		expect( polygon.appearance ).toBe( appearance );
		expect( circle.appearance ).toBe( appearance );

		// Restoring undefined selects each primitive's own internal default, then
		// passing the same user object binds it again without cloning its wrappers.
		rectangle.setAppearance( undefined );
		expect( rectangle.appearance ).not.toBe( appearance );
		rectangle.setAppearance( appearance );
		expect( rectangle.appearance ).toBe( appearance );

		rectangle.dispose();
		polygon.dispose();
		circle.dispose();
	} );

	it( 'binds an independent Raw material for each surface pass', () => {
		const passes: string[] = [];
		const raw = new CesiumGroundRawShaderAppearance( {
			factory: context => {
				passes.push( context.pass );
				const material = context.createDefaultMaterial();
				material.name = `RawSurface/${ context.pass }`;
				return material;
			},
		} );
		const circle = new CesiumGroundCirclePrimitive( {
			center: [ 121.4, 31.2 ],
			radius: 50,
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
			appearance: raw,
		} );

		expect( circle.appearance ).toBe( raw );
		expect( passes ).toEqual( [ 'frontStencil', 'backStencil', 'color' ] );
		expect(( circle.classification.group.getObjectByName(
		'CesiumClassificationFrontStencilDepthCommand',
		)?.material as RawShaderMaterial ).name ).toBe( 'RawSurface/frontStencil' );
		expect(( circle.classification.group.getObjectByName(
		'CesiumClassificationBackStencilDepthCommand',
		)?.material as RawShaderMaterial ).name ).toBe( 'RawSurface/backStencil' );
		expect(( circle.classification.group.getObjectByName(
		'CesiumClassificationColorCommand',
		)?.material as RawShaderMaterial ).name ).toBe( 'RawSurface/color' );

		circle.setAppearance( undefined );
		expect( circle.appearance ).not.toBe( raw );
		passes.length = 0;
		circle.setAppearance( raw );
		expect( circle.appearance ).toBe( raw );
		expect( passes ).toEqual( [ 'frontStencil', 'backStencil', 'color' ] );
		circle.setAppearance( undefined );
		circle.dispose();
	} );

	it( 'keeps the live safe pass set when a Raw third-pass factory throws', () => {
		const circle = new CesiumGroundCirclePrimitive( {
			center: [ 121.4, 31.2 ],
			radius: 50,
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
		} );
		const front = circle.classification.group.getObjectByName(
			'CesiumClassificationFrontStencilDepthCommand',
		)?.material;
		const back = circle.classification.group.getObjectByName(
			'CesiumClassificationBackStencilDepthCommand',
		)?.material;
		const color = circle.classification.group.getObjectByName(
			'CesiumClassificationColorCommand',
		)?.material;
		const candidateDisposes = [ vi.fn(), vi.fn() ];
		let successfulCandidates = 0;
		const failingRaw = new CesiumGroundRawShaderAppearance( {
			factory: context => {
				if ( context.pass === 'color' ) throw new Error( 'third pass failed' );
				const candidate = context.createDefaultMaterial();
				candidate.addEventListener( 'dispose', candidateDisposes[ successfulCandidates ] );
				successfulCandidates += 1;
				return candidate;
			},
		} );

		let thrown: unknown;
		try {
			circle.setAppearance( failingRaw );
		} catch ( error ) {
			thrown = error;
		}
		expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
		expect(( thrown as CesiumGroundMaterialError ).code )
			.toBe( 'GROUND_RAW_FACTORY_RESULT_INVALID' );
		expect(( thrown as CesiumGroundMaterialError ).detail?.pass ).toBe( 'color' );
		expect(( thrown as CesiumGroundMaterialError ).detail?.cause )
			.toEqual( expect.objectContaining( { message: 'third pass failed' } ) );
		expect( circle.appearance ).not.toBe( failingRaw );
		expect( circle.classification.group.getObjectByName(
			'CesiumClassificationFrontStencilDepthCommand',
		)?.material ).toBe( front );
		expect( circle.classification.group.getObjectByName(
			'CesiumClassificationBackStencilDepthCommand',
		)?.material ).toBe( back );
		expect( circle.classification.group.getObjectByName(
			'CesiumClassificationColorCommand',
		)?.material ).toBe( color );
		expect( candidateDisposes[ 0 ] ).toHaveBeenCalledOnce();
		expect( candidateDisposes[ 1 ] ).toHaveBeenCalledOnce();
		circle.dispose();
	} );
} );
