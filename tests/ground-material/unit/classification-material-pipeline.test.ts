import {
	BufferGeometry,
	Color,
	FrontSide,
	GLSL3,
	Mesh,
	RawShaderMaterial,
	Vector3,
	Vector4,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CesiumClassificationPrimitive } from '../../../src/lib/ground/classification';
import type { PlanarExtents } from '../../../src/lib/ground/types';

/**
 * Unit tests intentionally stop before a renderer compiles the GLSL. The Stage 4
 * contract under test is ownership and identity: one canonical system map is
 * created, only color is assembled, and the existing command graph survives a
 * fragment-culling rebuild unchanged.
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

describe( 'classification color Material pipeline', () => {
	it( 'keeps fixed stencil commands and wrapper aliases while compiling only color', () => {
		const geometry = new BufferGeometry();
		const primitive = new CesiumClassificationPrimitive(
			geometry,
			createExtents(),
			new Color( '#d34c61' ),
			0.75,
			12,
			true,
			{ useMaterialPipeline: true },
		);
		const commands = getCommands( primitive );
		const frontMaterial = commands.front.material as RawShaderMaterial;
		const backMaterial = commands.back.material as RawShaderMaterial;
		const colorMaterial = commands.color.material as RawShaderMaterial;

		// Stencil remains the legacy material and therefore keeps its historical
		// source/state identity; the compiled color pass uses GLSL3 and canonical
		// c23_* aliases alongside the logical u_color multiplier.
		expect( frontMaterial.side ).toBe( FrontSide );
		expect( frontMaterial.uniforms.u_color ).toBeDefined();
		expect( backMaterial.uniforms.u_color ).toBe( frontMaterial.uniforms.u_color );
		expect( colorMaterial.glslVersion ).toBe( GLSL3 );
		expect( colorMaterial.uniforms.c23_fillColor ).toBe( frontMaterial.uniforms.u_color );
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
			.toBe( frontMaterial.uniforms.u_color );
		expect( oldColorDispose ).toHaveBeenCalledTimes( 1 );

		primitive.dispose();
	} );

	it( 'does not silently combine the opt-in compiler with a legacy factory', () => {
		const legacyFactory = vi.fn( () => new RawShaderMaterial() );
		const geometry = new BufferGeometry();
		expect( () => new CesiumClassificationPrimitive(
			geometry,
			createExtents(),
			new Color( 1, 1, 1 ),
			1,
			0,
			true,
			{
				useMaterialPipeline: true,
				colorMaterialFactory: legacyFactory,
			},
		) ).toThrow( /cannot be combined/ );
		expect( legacyFactory ).not.toHaveBeenCalled();
		geometry.dispose();
	} );
} );
