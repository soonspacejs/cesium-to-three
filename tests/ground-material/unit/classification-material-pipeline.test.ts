import {
	BufferGeometry,
	Color,
	DataTexture,
	FrontSide,
	GLSL3,
	Mesh,
	PerspectiveCamera,
	RawShaderMaterial,
	Vector3,
	Vector4,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CesiumClassificationPrimitive } from '../../../src/lib/ground/classification';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import type { PlanarExtents } from '../../../src/lib/ground/types';

/**
 * Unit tests intentionally stop before a renderer compiles the GLSL. The
 * contract under test is ownership and identity: one canonical system map is
 * shared by the explicitly assembled stencil/color pass set, and the command
 * graph survives a fragment-culling rebuild unchanged.
 */
function createExtents(): PlanarExtents {
	return {
		southWestHigh: new Vector3(),
		southWestLow: new Vector3(),
		eastward: new Vector3( 100, 0, 0 ),
		northward: new Vector3( 0, 100, 0 ),
		uvMinAndExtents: new Vector4( 0, 0, 100, 100 ),
		uMaxVmax: new Vector4( 1, 1, 0, 0 ),
		innerMetersRect: new Vector4( 0, 0, 100, 100 ),
	};
}

function getCommands( primitive: CesiumClassificationPrimitive ): {
	front: Mesh;
	back: Mesh;
	color: Mesh;
} {
	const front = primitive.group.getObjectByName( 'CesiumClassificationFrontStencilDepthCommand' );
	const back = primitive.group.getObjectByName( 'CesiumClassificationBackStencilDepthCommand' );
	const color = primitive.group.getObjectByName( 'CesiumClassificationColorCommand' );
	if ( ! ( front instanceof Mesh ) || ! ( back instanceof Mesh ) || ! ( color instanceof Mesh ) ) {
		throw new Error( 'Classification command graph is incomplete.' );
	}
	return { front, back, color };
}

/** Creates a valid safe surface shader with one observable user wrapper. */
function createSafeAppearance( gain = 1 ): CesiumGroundMaterialAppearance {
	return new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'ClassificationSafeFixture',
			uniforms: { u_gain: { value: gain } },
			fragmentShader: /* glsl */ `
uniform float u_gain;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_gain;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a;
	return result;
}
`,
		} ),
	} );
}

describe( 'classification color Material pipeline', () => {
	it( 'disposes the command set once and rejects use after disposal', () => {
		const geometry = new BufferGeometry();
		const primitive = new CesiumClassificationPrimitive(
			geometry,
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{},
		);
		const commands = getCommands( primitive );
		const geometryDispose = vi.fn();
		const frontDispose = vi.fn();
		const backDispose = vi.fn();
		const colorDispose = vi.fn();
		geometry.addEventListener( 'dispose', geometryDispose );
		( commands.front.material as RawShaderMaterial ).addEventListener( 'dispose', frontDispose );
		( commands.back.material as RawShaderMaterial ).addEventListener( 'dispose', backDispose );
		( commands.color.material as RawShaderMaterial ).addEventListener( 'dispose', colorDispose );

		primitive.dispose();
		primitive.dispose();

		expect( primitive.group.children ).toHaveLength( 0 );
		expect( geometryDispose ).toHaveBeenCalledOnce();
		expect( frontDispose ).toHaveBeenCalledOnce();
		expect( backDispose ).toHaveBeenCalledOnce();
		expect( colorDispose ).toHaveBeenCalledOnce();
		expect( () => primitive.setColor( new Color(), 1 ) ).toThrow( /already disposed/ );
		expect( () => primitive.setAppearance( undefined ) ).toThrow( /already disposed/ );
		expect( () => primitive.update( {} as never ) ).toThrow( /already disposed/ );
		expect( () => primitive.appearance ).toThrow( /already disposed/ );
	} );

	it( 'assembles fixed stencil commands without legacy shader patching', () => {
		const geometry = new BufferGeometry();
		const primitive = new CesiumClassificationPrimitive(
			geometry,
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{},
		);
		const commands = getCommands( primitive );
		const frontMaterial = commands.front.material as RawShaderMaterial;
		const backMaterial = commands.back.material as RawShaderMaterial;
		const colorMaterial = commands.color.material as RawShaderMaterial;

		// All three passes use the canonical compiler. Fixed stencil shaders borrow
		// only system wrappers; the color pass additionally owns logical u_color.
		expect( frontMaterial.side ).toBe( FrontSide );
		expect( frontMaterial.uniforms.u_color ).toBeUndefined();
		expect( frontMaterial.uniforms.c23_fillColor ).toBeDefined();
		expect( backMaterial.uniforms.c23_fillColor ).toBe( frontMaterial.uniforms.c23_fillColor );
		expect( colorMaterial.glslVersion ).toBe( GLSL3 );
		expect( colorMaterial.uniforms.c23_fillColor ).toBe( frontMaterial.uniforms.c23_fillColor );
		expect( colorMaterial.uniforms.u_color ).toBeDefined();
		expect( colorMaterial.uniforms.u_color ).not.toBe( frontMaterial.uniforms.u_color );
		expect( colorMaterial.fragmentShader ).toContain( 'c23_getMaterial' );
		expect( colorMaterial.fragmentShader ).toContain( '[c23:fragment-safe-main]' );
		expect( colorMaterial.fragmentShader ).not.toContain( 'discard' );

		const originalFront = commands.front;
		const originalBack = commands.back;
		const originalColor = commands.color;
		const originalGeometry = commands.color.geometry;
		const oldColorDispose = vi.fn();
		colorMaterial.addEventListener( 'dispose', oldColorDispose );

		primitive.setColor( new Color( '#4d9de0' ), 0.5 );
		primitive.setFragmentCulling( false );

		const rebuilt = getCommands( primitive );
		expect( rebuilt.front ).toBe( originalFront );
		expect( rebuilt.back ).toBe( originalBack );
		expect( rebuilt.color ).toBe( originalColor );
		expect( rebuilt.color.geometry ).toBe( originalGeometry );
		expect( rebuilt.front.material ).toBe( frontMaterial );
		expect( rebuilt.back.material ).toBe( backMaterial );
		expect( rebuilt.color.material ).not.toBe( colorMaterial );
		expect(( rebuilt.color.material as RawShaderMaterial ).uniforms.c23_fillColor )
			.toBe( frontMaterial.uniforms.c23_fillColor );
		expect( oldColorDispose ).toHaveBeenCalledTimes( 1 );

		primitive.dispose();
	} );

	it( 'atomically switches safe appearances and restores the internal default', () => {
		const primitive = new CesiumClassificationPrimitive(
			new BufferGeometry(),
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{},
		);
		const defaultAppearance = primitive.appearance;
		const before = getCommands( primitive );
		const previousColorMaterial = before.color.material as RawShaderMaterial;
		const previousDispose = vi.fn();
		previousColorMaterial.addEventListener( 'dispose', previousDispose );
		const safeAppearance = createSafeAppearance( 0.6 );

		primitive.setAppearance( safeAppearance );
		const after = getCommands( primitive );
		expect( primitive.appearance ).toBe( safeAppearance );
		expect( after.front ).toBe( before.front );
		expect( after.back ).toBe( before.back );
		expect( after.color ).toBe( before.color );
		expect( after.color.geometry ).toBe( before.color.geometry );
		expect( after.front.material ).toBe( before.front.material );
		expect( after.back.material ).toBe( before.back.material );
		expect( after.color.material ).not.toBe( previousColorMaterial );
		expect(( after.color.material as RawShaderMaterial ).uniforms.u_gain )
			.toBe( safeAppearance.material.uniforms.u_gain );
		expect( previousDispose ).toHaveBeenCalledTimes( 1 );

		// An invalid candidate is rejected before the current command is changed.
		const stableColorMaterial = after.color.material;
		const invalidAppearance = new CesiumGroundMaterialAppearance( {
			material: new CesiumGroundMaterial( {
				fragmentShader: /* glsl */ `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	discard;
	return c23_material(vec3(1.0), vec3(0.0), 1.0);
}
`,
			} ),
		} );
		expect( () => primitive.setAppearance( invalidAppearance ) ).toThrow();
		expect( primitive.appearance ).toBe( safeAppearance );
		expect( getCommands( primitive ).color.material ).toBe( stableColorMaterial );

		primitive.setAppearance( undefined );
		expect( primitive.appearance ).toBe( defaultAppearance );
		expect( getCommands( primitive ).color.material ).not.toBe( stableColorMaterial );
		primitive.dispose();
	} );

	it( 'reconciles a logical Material version on update without replacing wrappers', () => {
		const appearance = createSafeAppearance( 0.8 );
		const primitive = new CesiumClassificationPrimitive(
			new BufferGeometry(),
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{ appearance },
		);
		const before = getCommands( primitive );
		const oldColorMaterial = before.color.material as RawShaderMaterial;
		const wrapper = appearance.material.uniforms.u_gain;
		const oldDispose = vi.fn();
		oldColorMaterial.addEventListener( 'dispose', oldDispose );

		appearance.material.fragmentShader = appearance.material.fragmentShader.replace(
			'materialInput.baseColor.rgb * u_gain',
			'materialInput.baseColor.rgb * u_gain * 0.5',
		);
		appearance.material.needsUpdate = true;
		// Version invalidation is lazy: the material remains bound until the next
		// primitive update establishes a render-boundary transaction.
		expect( getCommands( primitive ).color.material ).toBe( oldColorMaterial );

		const camera = new PerspectiveCamera( 45, 1, 1, 1_000_000 );
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld( true );
		const depthTexture = new DataTexture();
		primitive.update( {
			depthTexture,
			width: 64,
			height: 64,
			camera,
		} );

		const rebuilt = getCommands( primitive );
		expect( rebuilt.front ).toBe( before.front );
		expect( rebuilt.back ).toBe( before.back );
		expect( rebuilt.color ).toBe( before.color );
		expect( rebuilt.color.geometry ).toBe( before.color.geometry );
		expect( rebuilt.color.material ).not.toBe( oldColorMaterial );
		expect(( rebuilt.color.material as RawShaderMaterial ).uniforms.u_gain ).toBe( wrapper );
		expect( oldDispose ).toHaveBeenCalledTimes( 1 );

		primitive.dispose();
		depthTexture.dispose();
	} );

	it( 'updates canonical time wrappers in place and defaults missing values to zero', () => {
		const appearance = createSafeAppearance( 0.8 );
		const primitive = new CesiumClassificationPrimitive(
			new BufferGeometry(),
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{ appearance },
		);
		const colorMaterial = getCommands( primitive ).color.material as RawShaderMaterial;
		const time = colorMaterial.uniforms.c23_time;
		const delta = colorMaterial.uniforms.c23_deltaTime;
		const frame = colorMaterial.uniforms.c23_frameNumber;
		const version = appearance.material.version;
		const camera = new PerspectiveCamera( 45, 1, 1, 1000 );
		camera.updateProjectionMatrix();
		const depthTexture = new DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );

		primitive.update( {
			depthTexture,
			width: 64,
			height: 64,
			camera,
			timeSeconds: 12.5,
			deltaSeconds: 1 / 60,
			frameNumber: 42,
		} );

		expect( colorMaterial.uniforms.c23_time ).toBe( time );
		expect( colorMaterial.uniforms.c23_deltaTime ).toBe( delta );
		expect( colorMaterial.uniforms.c23_frameNumber ).toBe( frame );
		expect( time.value ).toBe( 12.5 );
		expect( delta.value ).toBeCloseTo( 1 / 60 );
		expect( frame.value ).toBe( 42 );
		expect( appearance.material.version ).toBe( version );

		primitive.update( { depthTexture, width: 64, height: 64, camera } );
		expect( time.value ).toBe( 0 );
		expect( delta.value ).toBe( 0 );
		expect( frame.value ).toBe( 0 );
		expect( appearance.material.version ).toBe( version );

		primitive.dispose();
		depthTexture.dispose();
	} );
} );
