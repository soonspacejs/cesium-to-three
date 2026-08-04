import { Mesh, PerspectiveCamera, RawShaderMaterial, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import { CesiumGroundPointPrimitive } from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';

/** Surface-safe fixture shared verbatim by circle and square delegates. */
function createAppearance(): CesiumGroundMaterialAppearance {
	return new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'PointDelegateFixture',
			uniforms: { u_pointTint: { value: new Vector4( 0.4, 0.8, 0.2, 1 ) } },
			fragmentShader: /* glsl */ `
uniform vec4 u_pointTint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_pointTint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_pointTint.a;
	return result;
}
`,
		} ),
	} );
}

function colorMaterial( point: CesiumGroundPointPrimitive ): RawShaderMaterial {
	const mesh = point.classification.group.getObjectByName( 'CesiumClassificationColorCommand' );
	if ( ! ( mesh instanceof Mesh ) ) throw new Error( 'Point color command is missing.' );
	return mesh.material as RawShaderMaterial;
}

describe( 'point delegate Appearance forwarding', () => {
	it.each( [ 'circle', 'square' ] as const )(
		'forwards the exact Appearance through the %s delegate',
		shape => {
			const appearance = createAppearance();
			const point = new CesiumGroundPointPrimitive( {
				position: [ 121.4, 31.2 ],
				shape,
				size: 20,
				strokeColor: '#ffffff',
				strokeWidth: 1,
				strokeOpacity: 100,
				fillColor: '#336699',
				fillOpacity: 80,
				visible: true,
				appearance,
			} );

			expect( point.appearance ).toBe( appearance );
			expect( colorMaterial( point ).uniforms.u_pointTint )
				.toBe( appearance.material.uniforms.u_pointTint );
			point.setAppearance( undefined );
			expect( point.appearance ).not.toBe( appearance );
			point.setAppearance( appearance );
			expect( point.appearance ).toBe( appearance );
			point.dispose();
		},
	);

	it.each( [ 'circle', 'square' ] as const )(
		'makes %s disposal idempotent and rejects every wrapper operation afterward',
		shape => {
			const point = new CesiumGroundPointPrimitive( {
				position: [ 121.4, 31.2 ],
				shape,
				size: 20,
				strokeColor: '#ffffff',
				strokeWidth: 1,
				strokeOpacity: 100,
				fillColor: '#336699',
				fillOpacity: 80,
				visible: true,
			} );
			const color = colorMaterial( point );
			let disposeEvents = 0;
			color.addEventListener( 'dispose', () => { disposeEvents += 1; } );
			const frameState = {
				depthTexture: null,
				width: 960,
				height: 640,
				camera: new PerspectiveCamera( 45, 1.5, 1, 10000000 ),
			};

			point.dispose();
			point.dispose();

			expect( disposeEvents ).toBe( 1 );
			const operations = [
				() => point.update( frameState ),
				() => point.setRenderOrder( 20 ),
				() => point.setClassificationType(),
				() => point.appearance,
				() => point.setAppearance(),
				() => point.setImageOpacity( 50 ),
			];
			for ( const operation of operations ) {
				expect( operation ).toThrow( /already disposed/ );
			}
		},
	);
} );
