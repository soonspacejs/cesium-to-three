import {
	Color,
	Matrix4,
	Quaternion,
	Texture,
	Vector2,
	WebGLRenderTarget,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { CesiumGroundMaterialAppearance } from '../../../src/lib/ground/material/appearances';
import { compileGroundPass } from '../../../src/lib/ground/material/compiler';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';

const SOURCE = `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	return c23_material(materialInput.baseColor.rgb, materialInput.baseColor.a);
}`;

describe( 'CesiumGroundMaterial', () => {
	it( 'allows a vertex-only material and preserves the omitted fragment through clone()', () => {
		const vertexShader = /* glsl */ `
void c23_vertexMain(c23_vertexInput vertexInput, inout c23_vertexOutput vertexOutput) {}
`;
		const material = new CesiumGroundMaterial( { vertexShader } );
		const clone = material.clone();

		expect( material.vertexShader ).toBe( vertexShader );
		expect( material.fragmentShader ).toBeUndefined();
		expect( clone.vertexShader ).toBe( vertexShader );
		expect( clone.fragmentShader ).toBeUndefined();
	} );

	it( 'rejects a non-string fragmentShader when one is provided', () => {
		expect( () => new CesiumGroundMaterial( {
			fragmentShader: 123,
		} as unknown as ConstructorParameters<typeof CesiumGroundMaterial>[ 0 ] ) )
			.toThrow( /fragmentShader must be a string when provided/ );
	} );

	it( 'preserves constructor map/wrapper identities and applies documented defaults', () => {
		const wrapper = { value: 0.25 };
		const uniforms = { u_phase: wrapper };
		const defines = { USE_MASK: false };
		const material = new CesiumGroundMaterial( { uniforms, defines, fragmentShader: SOURCE } );

		expect( material.type ).toBe( 'CesiumGroundMaterial' );
		expect( material.uniforms ).toBe( uniforms );
		expect( material.uniforms.u_phase ).toBe( wrapper );
		expect( material.defines ).toBe( defines );
		expect( material.vertexShader ).toBeUndefined();
		expect( material.fragmentShader ).toBe( SOURCE );
		expect( material.version ).toBe( 0 );
		expect( material.uuid ).toMatch( /^[0-9a-f-]{36}$/i );
	} );

	it( 'updates only an existing value without changing wrapper, map, or version', () => {
		const wrapper = { value: 0.25 };
		const uniforms = { u_phase: wrapper };
		const material = new CesiumGroundMaterial( { uniforms, fragmentShader: SOURCE } );

		expect( material.setUniform( 'u_phase', 0.75 ) ).toBe( material );
		expect( material.uniforms ).toBe( uniforms );
		expect( material.uniforms.u_phase ).toBe( wrapper );
		expect( wrapper.value ).toBe( 0.75 );
		expect( material.version ).toBe( 0 );
	} );

	it( 'rejects unknown setUniform names without mutating schema or version', () => {
		const material = new CesiumGroundMaterial( { fragmentShader: SOURCE } );
		let thrown: unknown;
		try {
			material.setUniform( 'u_missing', 1 );
		} catch ( error ) {
			thrown = error;
		}

		expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
		expect(( thrown as CesiumGroundMaterialError ).code ).toBe( 'GROUND_UNIFORM_NOT_DECLARED' );
		expect( Object.keys( material.uniforms ) ).toEqual( [] );
		expect( material.version ).toBe( 0 );
	} );

	it( 'increments every explicit structural revision and dispatches change', () => {
		const material = new CesiumGroundMaterial( { fragmentShader: SOURCE } );
		const versions: number[] = [];
		material.addEventListener( 'change', () => versions.push( material.version ) );

		material.needsUpdate = false;
		material.needsUpdate = true;
		material.needsUpdate = true;

		expect( versions ).toEqual( [ 1, 2 ] );
		expect( material.version ).toBe( 2 );
	} );

	it( 'dispatches repeatable dispose notifications and remains fully reusable', () => {
		const material = new CesiumGroundMaterial( {
			uniforms: { u_phase: { value: 0 } },
			fragmentShader: SOURCE,
		} );
		let disposeCount = 0;
		material.addEventListener( 'dispose', () => disposeCount += 1 );

		material.dispose();
		material.dispose();
		material.setUniform( 'u_phase', 0.5 );
		material.needsUpdate = true;

		expect( disposeCount ).toBe( 2 );
		expect( material.uniforms.u_phase.value ).toBe( 0.5 );
		expect( material.version ).toBe( 1 );
	} );

	it( 'shares wrapper values and revisions through independent safe appearances', () => {
		const material = new CesiumGroundMaterial( {
			uniforms: { u_phase: { value: 0 } },
			fragmentShader: SOURCE.replace(
				'c23_material c23_getMaterial',
				'uniform float u_phase;\nc23_material c23_getMaterial',
			).replace(
				'materialInput.baseColor.a)',
				'materialInput.baseColor.a * (1.0 - u_phase))',
			),
		} );
		const first = new CesiumGroundMaterialAppearance( { material } );
		const second = new CesiumGroundMaterialAppearance( { material } );

		material.setUniform( 'u_phase', 0.25 );
		expect( first.material.uniforms.u_phase ).toBe( second.material.uniforms.u_phase );
		expect( second.material.uniforms.u_phase.value ).toBe( 0.25 );
		material.needsUpdate = true;
		expect( first.version ).toBe( 1 );
		expect( second.version ).toBe( 1 );
	} );

	it( 'never disposes user textures and can clone and compile again after dispose', () => {
		const texture = new Texture();
		const textureDispose = vi.fn();
		texture.addEventListener( 'dispose', textureDispose );
		const material = new CesiumGroundMaterial( {
			uniforms: {
				u_texture: { value: texture },
				u_phase: { value: 0 },
			},
			fragmentShader: /* glsl */ `
uniform sampler2D u_texture;
uniform float u_phase;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = texture(u_texture, materialInput.st).rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * (1.0 - u_phase);
	return result;
}
`,
		} );

		material.dispose();
		material.dispose();
		material.setUniform( 'u_phase', 0.5 );
		const clone = material.clone();
		material.needsUpdate = true;
		const appearance = new CesiumGroundMaterialAppearance( { material } );
		const compiled = compileGroundPass( {
			primitiveKind: 'decal',
			pass: 'color',
			appearance,
			systemUniforms: {},
			defaultMaterial: material,
			pipelineState: {
				fragmentCull: true,
				debugVolume: false,
				attributeLayoutKey: 'decal-v1',
				primitiveId: 'material-reuse-fixture',
			},
		} );

		expect( material.uniforms.u_texture.value ).toBe( texture );
		expect( clone.uniforms.u_texture.value ).not.toBe( texture );
		expect( compiled.material.uniforms.u_texture ).toBe( material.uniforms.u_texture );
		expect( textureDispose ).not.toHaveBeenCalled();
		compiled.material.dispose();
		clone.dispose();
		material.dispose();
		expect( textureDispose ).not.toHaveBeenCalled();
	} );

	it( 'clones Three values, Three-object arrays, wrappers, and defines independently', () => {
		const color = new Color( '#ff3366' );
		const matrix = new Matrix4().makeTranslation( 1, 2, 3 );
		const quaternion = new Quaternion( 0.1, 0.2, 0.3, 0.9 );
		const texture = new Texture();
		const vectorArray = [ new Vector2( 1, 2 ), new Vector2( 3, 4 ) ];
		const ordinaryArray = [ { shared: true }, 2 ];
		const businessObject = { nested: { retained: true } };
		const typedArray = new Float32Array( [ 1, 2, 3 ] );
		const source = new CesiumGroundMaterial( {
			type: 'CloneFixture',
			vertexShader: 'void c23_vertexMain(c23_vertexInput vertexInput, inout c23_vertexOutput vertexOutput) {}',
			uniforms: {
				u_color: { value: color },
				u_matrix: { value: matrix },
				u_quaternion: { value: quaternion },
				u_texture: { value: texture },
				u_vectors: { value: vectorArray },
				u_array: { value: ordinaryArray },
				u_object: { value: businessObject },
				u_typed: { value: typedArray },
			},
			defines: { USE_COLOR: true },
			fragmentShader: SOURCE,
		} );
		source.needsUpdate = true;

		const clone = source.clone();

		expect( clone.uuid ).not.toBe( source.uuid );
		expect( clone.version ).toBe( 0 );
		expect( clone.type ).toBe( source.type );
		expect( clone.vertexShader ).toBe( source.vertexShader );
		expect( clone.fragmentShader ).toBe( source.fragmentShader );
		expect( clone.uniforms ).not.toBe( source.uniforms );
		expect( clone.defines ).not.toBe( source.defines );
		expect( clone.defines ).toEqual( source.defines );

		for ( const name of Object.keys( source.uniforms ) ) {
			expect( clone.uniforms[ name ] ).not.toBe( source.uniforms[ name ] );
		}
		expect( clone.uniforms.u_color.value ).not.toBe( color );
		expect( clone.uniforms.u_matrix.value ).not.toBe( matrix );
		expect( clone.uniforms.u_quaternion.value ).not.toBe( quaternion );
		expect( clone.uniforms.u_texture.value ).not.toBe( texture );
		expect( clone.uniforms.u_vectors.value ).not.toBe( vectorArray );
		expect(( clone.uniforms.u_vectors.value as Vector2[] )[ 0 ] ).not.toBe( vectorArray[ 0 ] );
		expect( clone.uniforms.u_array.value ).not.toBe( ordinaryArray );
		expect(( clone.uniforms.u_array.value as unknown[] )[ 0 ] ).toBe( ordinaryArray[ 0 ] );
		expect( clone.uniforms.u_object.value ).toBe( businessObject );
		expect( clone.uniforms.u_typed.value ).toBe( typedArray );
	} );

	it( 'warns and writes null when cloning a render-target texture', () => {
		const target = new WebGLRenderTarget( 4, 4 );
		const source = new CesiumGroundMaterial( {
			uniforms: { u_sceneColor: { value: target.texture } },
			fragmentShader: SOURCE,
		} );
		const warning = vi.spyOn( console, 'warn' ).mockImplementation( () => undefined );

		const clone = source.clone();

		expect( clone.uniforms.u_sceneColor.value ).toBeNull();
		expect( warning ).toHaveBeenCalledOnce();
		expect( warning.mock.calls[ 0 ][ 0 ] ).toContain( 'render targets cannot be cloned' );
		target.dispose();
	} );

	it( 'does not copy event listeners to a clone', () => {
		const source = new CesiumGroundMaterial( { fragmentShader: SOURCE } );
		const listener = vi.fn();
		source.addEventListener( 'change', listener );
		const clone = source.clone();

		clone.needsUpdate = true;

		expect( listener ).not.toHaveBeenCalled();
	} );
} );
