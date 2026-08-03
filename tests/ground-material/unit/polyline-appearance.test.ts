import {
	Mesh,
	PerspectiveCamera,
	RawShaderMaterial,
	Vector4,
} from 'three';
import { describe, expect, it } from 'vitest';

import {
	CesiumGroundPolylinePrimitive,
} from '../../../src/lib/ground/primitives';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';

const LINE_POINTS: [ number, number ][] = [
	[ 121.4, 31.2 ],
	[ 121.401, 31.2005 ],
	[ 121.402, 31.201 ],
];

/** Finds the stable line command without reaching into private implementation fields. */
function lineMesh( primitive: CesiumGroundPolylinePrimitive ): Mesh {
	const mesh = primitive.group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
	if ( ! ( mesh instanceof Mesh ) ) throw new Error( 'Polyline line Mesh is missing.' );
	return mesh;
}

/** Creates valid input shared by all tests while keeping each primitive independent. */
function createPolyline(
	extra: Partial<ConstructorParameters<typeof CesiumGroundPolylinePrimitive>[ 0 ]> = {},
): CesiumGroundPolylinePrimitive {
	return new CesiumGroundPolylinePrimitive( {
		points: LINE_POINTS,
		strokeColor: '#336699',
		strokeOpacity: 80,
		visible: true,
		widthPixels: 4,
		...extra,
	} );
}

/** Safe Material exercises the formal line ABI rather than legacy u_color text. */
function createGradientAppearance(): CesiumGroundMaterialAppearance {
	return new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'PolylineGradientFixture',
			uniforms: { u_tint: { value: new Vector4( 1, 1, 1, 1 ) } },
			fragmentShader: /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	float along = materialInput.lineTotalMeters > 0.0
		? materialInput.distanceAlongMeters / materialInput.lineTotalMeters
		: 0.0;
	c23_material result;
	result.diffuse = mix(vec3(0.1, 0.2, 0.8), vec3(0.9, 0.8, 0.1), along) * u_tint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`,
		} ),
	} );
}

describe( 'polyline ABI and Appearance integration', () => {
	it( 'uses the compiler-backed Color Material for solid default lines', () => {
		const primitive = createPolyline();
		const line = lineMesh( primitive );
		const material = line.material as RawShaderMaterial;

		expect( primitive.appearance ).toBeInstanceOf( CesiumGroundMaterialAppearance );
		expect( material.fragmentShader ).toContain( '// [c23:ground-material-abi]' );
		expect( material.fragmentShader ).toContain( 'c23_getMaterial(c23_input)' );
		expect( material.vertexShader ).toContain( '#define C23_POLYLINE 1' );
		expect( material.uniforms.c23_lineColor ).toBe(
		( primitive as unknown as { systemUniforms: Record<string, unknown> } )
			.systemUniforms.c23_lineColor,
		);
		primitive.dispose();
	} );

	it( 'keeps the historical dash shader only for the compatibility default', () => {
		const primitive = createPolyline( { dashLengthMeters: 10, gapLengthMeters: 5 } );
		const material = lineMesh( primitive ).material as RawShaderMaterial;

		expect( material.fragmentShader ).toContain( 'CESIUM_THREE_POLYLINE' );
		expect( material.fragmentShader ).not.toContain( '// [c23:ground-material-abi]' );
		primitive.dispose();
	} );

	it( 'switches safe Appearance without changing line or arrow topology', () => {
		const appearance = createGradientAppearance();
		const primitive = createPolyline( { arrowMode: 'both', appearance } );
		const line = lineMesh( primitive );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const geometry = line.geometry;
		const arrowGeometry = arrow.geometry;
		const arrowMaterial = arrow.material;

		primitive.setAppearance( undefined );
		primitive.setAppearance( appearance );

		expect( primitive.appearance ).toBe( appearance );
		expect( line.geometry ).toBe( geometry );
		expect( lineMesh( primitive ) ).toBe( line );
		expect( arrow.geometry ).toBe( arrowGeometry );
		expect( arrow.material ).toBe( arrowMaterial );
		expect(( line.material as RawShaderMaterial ).fragmentShader ).toContain( 'u_tint' );
		primitive.dispose();
	} );

	it( 'compiles one independent Raw polyline pass and preserves system wrappers', () => {
		const passes: string[] = [];
		const raw = new CesiumGroundRawShaderAppearance( {
			factory: context => {
				passes.push( `${ context.primitiveKind}:${ context.pass }` );
				const material = context.createDefaultMaterial();
				material.name = 'RawPolylineFixture';
				return material;
			},
		} );
		const primitive = createPolyline( { appearance: raw } );
		const material = lineMesh( primitive ).material as RawShaderMaterial;

		expect( passes ).toEqual( [ 'polyline:polyline' ] );
		expect( primitive.appearance ).toBe( raw );
		expect( material.name ).toBe( 'RawPolylineFixture' );
		expect( material.uniforms.c23_lineColor ).toBe(
		( primitive as unknown as { systemUniforms: Record<string, unknown> } )
			.systemUniforms.c23_lineColor,
		);
		primitive.dispose();
	} );

	it( 'rebuilds only the compiled line material after a logical version change', () => {
		const appearance = createGradientAppearance();
		const primitive = createPolyline( { appearance } );
		const line = lineMesh( primitive );
		const geometry = line.geometry;
		const before = line.material;
		appearance.material.needsUpdate = true;

		primitive.update( {
			depthTexture: null,
			width: 960,
			height: 640,
			camera: new PerspectiveCamera( 45, 1.5, 1, 10000000 ),
		} );

		expect( line.material ).not.toBe( before );
		expect( line.geometry ).toBe( geometry );
		primitive.dispose();
	} );
} );
