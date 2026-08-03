import { RawShaderMaterial, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

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

	it( 'rejects Raw Appearance before a surface primitive can bind a partial Stage 5 path', () => {
		const raw = new CesiumGroundRawShaderAppearance( {
			factory: () => new RawShaderMaterial(),
		} );
		expect( () => new CesiumGroundCirclePrimitive( {
			center: [ 121.4, 31.2 ],
			radius: 50,
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#44aa66',
			fillOpacity: 80,
			visible: true,
			appearance: raw,
		} ) ).toThrow( /CesiumGroundMaterialAppearance/ );
	} );
} );
