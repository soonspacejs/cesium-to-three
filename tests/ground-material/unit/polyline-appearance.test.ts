import {
	BufferGeometry,
	Mesh,
	PerspectiveCamera,
	RawShaderMaterial,
	Vector4,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

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

/** Raw arrow fixture records pass invocations while retaining the canonical wrappers. */
function createRawArrowAppearance( passes: string[] ): CesiumGroundRawShaderAppearance {
	return new CesiumGroundRawShaderAppearance( {
		uniforms: { u_arrowFixtureTint: { value: new Vector4( 0.8, 0.2, 0.1, 1 ) } },
		factory: context => {
			passes.push( `${ context.primitiveKind }:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = 'RawArrowFixture';
			return material;
		},
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

	it( 'routes historical dash options through the built-in Dash Material', () => {
		const primitive = createPolyline( { dashLengthMeters: 10, gapLengthMeters: 5 } );
		const material = lineMesh( primitive ).material as RawShaderMaterial;
		const appearance = primitive.appearance as CesiumGroundMaterialAppearance;

		expect( appearance.material.type ).toBe( 'PolylineDashGroundMaterial' );
		expect( material.fragmentShader ).toContain( '// [c23:ground-material-abi]' );
		expect( material.fragmentShader ).toContain( 'u_dashLengthMeters' );
		expect( material.uniforms.u_dashLengthMeters.value ).toBe( 10 );
		expect( material.uniforms.u_gapLengthMeters.value ).toBe( 5 );
		expect( material.uniforms.u_lineDashEnabled ).toBeUndefined();
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

	it( 'releases and recompiles a still-bound line Material after dispose', () => {
		const appearance = createGradientAppearance();
		const primitive = createPolyline( { appearance } );
		const line = lineMesh( primitive );
		const before = line.material as RawShaderMaterial;
		const dispose = vi.fn();
		before.addEventListener( 'dispose', dispose );

		appearance.material.dispose();
		primitive.update( {
			depthTexture: null,
			width: 960,
			height: 640,
			camera: new PerspectiveCamera( 45, 1.5, 1, 10000000 ),
		} );

		expect( primitive.appearance ).toBe( appearance );
		expect( line.material ).not.toBe( before );
		expect( dispose ).toHaveBeenCalledOnce();
		primitive.dispose();
	} );

	it( 'keeps the live line intact when a Raw switch candidate fails', () => {
		const primitive = createPolyline( { arrowMode: 'right' } );
		const line = lineMesh( primitive );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const originalAppearance = primitive.appearance;
		const originalMaterial = line.material;
		const originalGeometry = line.geometry;
		const originalArrowMaterial = arrow.material;
		let candidateDisposeEvents = 0;
		const brokenRaw = new CesiumGroundRawShaderAppearance( {
			factory: context => {
				const candidate = context.createDefaultMaterial();
				candidate.addEventListener( 'dispose', () => { candidateDisposeEvents += 1; } );
				throw new Error( 'intentional polyline Raw failure' );
			},
		} );

		expect( () => primitive.setAppearance( brokenRaw ) ).toThrow();
		expect( candidateDisposeEvents ).toBe( 1 );
		expect( primitive.appearance ).toBe( originalAppearance );
		expect( line.material ).toBe( originalMaterial );
		expect( line.geometry ).toBe( originalGeometry );
		expect( arrow.material ).toBe( originalArrowMaterial );
		primitive.dispose();
	} );

	it( 'releases line geometry when constructor-time Material validation fails', () => {
		const geometryDispose = vi.spyOn( BufferGeometry.prototype, 'dispose' );
		const invalidAppearance = new CesiumGroundMaterialAppearance( {
			material: new CesiumGroundMaterial( {
				type: 'InvalidPolylineConstructorFixture',
				// The safe compiler requires exactly one valid c23_getMaterial entry.
				fragmentShader: 'float unrelatedFunction() { return 1.0; }',
			} ),
		} );

		expect( () => createPolyline( { appearance: invalidAppearance } ) ).toThrow();
		expect( geometryDispose ).toHaveBeenCalledTimes( 1 );
		geometryDispose.mockRestore();
	} );

	it( 'keeps line and arrow Appearances independent', () => {
		const lineAppearance = createGradientAppearance();
		const arrowAppearance = new CesiumGroundMaterialAppearance( {
			material: new CesiumGroundMaterial( {
				type: 'ArrowGradientFixture',
				uniforms: { u_arrowTint: { value: new Vector4( 0.2, 0.8, 0.3, 1 ) } },
				fragmentShader: /* glsl */ `
uniform vec4 u_arrowTint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_arrowTint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_arrowTint.a;
	return result;
}
`,
			} ),
		} );
		const primitive = createPolyline( {
			arrowMode: 'both',
			appearance: lineAppearance,
			arrowAppearance,
		} );
		const line = lineMesh( primitive );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );

		expect( primitive.appearance ).toBe( lineAppearance );
		expect( primitive.arrowAppearance ).toBe( arrowAppearance );
		expect( ( line.material as RawShaderMaterial ).fragmentShader ).toContain( 'u_tint' );
		expect( ( arrow.material as RawShaderMaterial ).fragmentShader ).toContain( 'u_arrowTint' );
		expect( ( arrow.material as RawShaderMaterial ).vertexShader ).toContain( '#define C23_ARROW 1' );
		primitive.dispose();
	} );

	it( 'stores arrow Appearance while disabled and compiles it on re-enable', () => {
		const passes: string[] = [];
		const arrowAppearance = createRawArrowAppearance( passes );
		const primitive = createPolyline( { arrowAppearance } );

		expect( primitive.arrowAppearance ).toBe( arrowAppearance );
		expect( passes ).toEqual( [] );
		primitive.setArrowMode( 'both' );
		expect( passes ).toEqual( [ 'arrow:arrow' ] );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		expect( arrow.material ).toBeInstanceOf( RawShaderMaterial );
		expect( ( arrow.material as RawShaderMaterial ).name ).toBe( 'RawArrowFixture' );
		primitive.setArrowMode( 'none' );
		expect( primitive.arrowAppearance ).toBe( arrowAppearance );
		primitive.setArrowMode( 'right' );
		expect( passes ).toEqual( [ 'arrow:arrow', 'arrow:arrow' ] );
		primitive.dispose();
	} );

	it( 'releases and recompiles a still-bound Raw arrow after dispose', () => {
		const passes: string[] = [];
		const arrowAppearance = createRawArrowAppearance( passes );
		const primitive = createPolyline( { arrowMode: 'right', arrowAppearance } );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const before = arrow.material as RawShaderMaterial;
		const dispose = vi.fn();
		before.addEventListener( 'dispose', dispose );

		arrowAppearance.dispose();
		primitive.update( {
			depthTexture: null,
			width: 960,
			height: 640,
			camera: new PerspectiveCamera( 45, 1.5, 1, 10000000 ),
		} );

		expect( primitive.arrowAppearance ).toBe( arrowAppearance );
		expect( arrow.material ).not.toBe( before );
		expect( passes ).toEqual( [ 'arrow:arrow', 'arrow:arrow' ] );
		expect( dispose ).toHaveBeenCalledOnce();
		primitive.dispose();
	} );

	it( 'rolls back a failed arrow Appearance candidate without touching the live command', () => {
		const primitive = createPolyline( { arrowMode: 'right' } );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const originalAppearance = primitive.arrowAppearance;
		const originalMaterial = arrow.material;
		const originalGeometry = arrow.geometry;
		let candidateDisposeEvents = 0;
		const brokenRaw = new CesiumGroundRawShaderAppearance( {
			factory: context => {
				const candidate = context.createDefaultMaterial();
				candidate.addEventListener( 'dispose', () => { candidateDisposeEvents += 1; } );
				throw new Error( 'intentional arrow Raw failure' );
			},
		} );

		expect( () => primitive.setArrowAppearance( brokenRaw ) ).toThrow();
		expect( candidateDisposeEvents ).toBe( 1 );
		expect( primitive.arrowAppearance ).toBe( originalAppearance );
		expect( arrow.material ).toBe( originalMaterial );
		expect( arrow.geometry ).toBe( originalGeometry );
		primitive.dispose();
	} );

	it( 'preserves arrow Appearance and user wrapper identity across geometry rebuilds', () => {
		const passes: string[] = [];
		const arrowAppearance = createRawArrowAppearance( passes );
		const primitive = createPolyline( { arrowMode: 'both', arrowAppearance } );
		const arrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const userWrapper = arrow.material instanceof RawShaderMaterial
			? arrow.material.uniforms.u_arrowFixtureTint
			: undefined;
		const line = lineMesh( primitive );
		const lineGeometry = line.geometry;

		primitive.setArrowStyles( 'open', 'solid' );
		primitive.setArrowMode( 'left' );

		const rebuiltArrow = primitive.group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( rebuiltArrow instanceof Mesh ) ) throw new Error( 'Rebuilt arrow Mesh is missing.' );
		expect( primitive.arrowAppearance ).toBe( arrowAppearance );
		expect( rebuiltArrow ).not.toBe( arrow );
		expect( ( rebuiltArrow.material as RawShaderMaterial ).uniforms.u_arrowFixtureTint )
			.toBe( userWrapper );
		expect( line.geometry ).toBe( lineGeometry );
		primitive.dispose();
	} );

	it( 'disposes line and arrow resources once and rejects all public operations afterward', () => {
		const primitive = createPolyline( { arrowMode: 'both' } );
		const group = primitive.group;
		const line = lineMesh( primitive );
		const arrow = group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
		if ( ! ( arrow instanceof Mesh ) ) throw new Error( 'Polyline arrow Mesh is missing.' );
		const disposalCounts = {
			lineGeometry: 0,
			lineMaterial: 0,
			arrowGeometry: 0,
			arrowMaterial: 0,
		};
		line.geometry.addEventListener( 'dispose', () => { disposalCounts.lineGeometry += 1; } );
		line.material.addEventListener( 'dispose', () => { disposalCounts.lineMaterial += 1; } );
		arrow.geometry.addEventListener( 'dispose', () => { disposalCounts.arrowGeometry += 1; } );
		arrow.material.addEventListener( 'dispose', () => { disposalCounts.arrowMaterial += 1; } );
		const frameState = {
			depthTexture: null,
			width: 960,
			height: 640,
			camera: new PerspectiveCamera( 45, 1.5, 1, 10000000 ),
		};

		primitive.dispose();
		primitive.dispose();

		expect( group.children ).toHaveLength( 0 );
		expect( disposalCounts ).toEqual( {
			lineGeometry: 1,
			lineMaterial: 1,
			arrowGeometry: 1,
			arrowMaterial: 1,
		} );
		const operations = [
			() => primitive.appearance,
			() => primitive.setAppearance(),
			() => primitive.arrowAppearance,
			() => primitive.setArrowAppearance(),
			() => primitive.group,
			() => primitive.update( frameState ),
			() => primitive.setClassificationType(),
			() => primitive.setColor( '#ffffff' ),
			() => primitive.setWidth( 3 ),
			() => primitive.applyWidthState( 'screen', 3, 30 ),
			() => primitive.setRenderOrder( 20 ),
			() => primitive.setVisible( true ),
			() => primitive.setArrowMode( 'right' ),
			() => primitive.setArrowStyle( 'solid' ),
			() => primitive.setArrowStyles( 'solid', 'open' ),
			() => primitive.setArrowColor( '#ffffff' ),
			() => primitive.setArrowWidthMode( 'screen' ),
			() => primitive.setArrowSize( 10, 8 ),
			() => primitive.setArrowSizeMeters( 10, 8 ),
		];
		for ( const operation of operations ) {
			expect( operation ).toThrow( /already disposed/ );
		}
	} );
} );
