import {
	AlwaysStencilFunc,
	BackSide,
	DecrementWrapStencilOp,
	DoubleSide,
	FrontSide,
	GLSL3,
	IncrementWrapStencilOp,
	LessEqualDepth,
	MeshBasicMaterial,
	NotEqualStencilFunc,
	RawShaderMaterial,
	ZeroStencilOp,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';
import {
	compileGroundPass,
	type CompileGroundPassOptions,
} from '../../../src/lib/ground/material/compiler';
import { CesiumGroundMaterialError } from '../../../src/lib/ground/material/errors';

const SAFE_SOURCE = /* glsl */ `
uniform float u_opacity;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_opacity;
	return result;
}
`;

function createLogicalMaterial( opacity = 1 ): CesiumGroundMaterial {
	return new CesiumGroundMaterial( {
		type: 'CompilerFixture',
		uniforms: { u_opacity: { value: opacity } },
		fragmentShader: SAFE_SOURCE,
	} );
}

function createCompileOptions(
	overrides: Partial<CompileGroundPassOptions> = {},
): CompileGroundPassOptions {
	const logical = createLogicalMaterial();
	return {
		primitiveKind: 'surface',
		pass: 'color',
		appearance: new CesiumGroundMaterialAppearance( { material: logical } ),
		systemUniforms: Object.freeze( {
			c23_time: { value: 0 },
			c23_fillColor: { value: 'fill' },
		} ),
		defaultMaterial: createLogicalMaterial(),
		pipelineState: {
			fragmentCull: false,
			debugVolume: false,
			attributeLayoutKey: 'surface-v1',
			primitiveId: 'primitive-A',
		},
		...overrides,
	};
}

function expectCompilerError(
	callback: () => unknown,
	code: string,
): CesiumGroundMaterialError {
	let thrown: unknown;
	try {
		callback();
	} catch ( error ) {
		thrown = error;
	}
	expect( thrown ).toBeInstanceOf( CesiumGroundMaterialError );
	expect(( thrown as CesiumGroundMaterialError ).code ).toBe( code );
	return thrown as CesiumGroundMaterialError;
}

describe( 'Ground pass compiler', () => {
	it( 'creates independent safe records while preserving every wrapper identity', () => {
		const options = createCompileOptions();
		const first = compileGroundPass( options );
		const second = compileGroundPass( options );
		const logical = ( options.appearance as CesiumGroundMaterialAppearance ).material;

		expect( first ).not.toBe( second );
		expect( first.material ).not.toBe( second.material );
		expect( first.material.uniforms.c23_time ).toBe( options.systemUniforms.c23_time );
		expect( first.material.uniforms.u_opacity ).toBe( logical.uniforms.u_opacity );
		expect( first.compileKey ).toBe( second.compileKey );
		expect( first.materialVersion ).toBe( 0 );
		expect( Object.isFrozen( first ) ).toBe( true );
		expect( first.material.userData.c23Ground ).toEqual( {
			kind: 'surface',
			pass: 'color',
			abiVersion: 1,
			appearanceKind: 'material',
			appearanceVersion: 0,
			materialType: 'CompilerFixture',
			primitiveId: 'primitive-A',
		} );
		expect( Object.isFrozen( first.material.userData.c23Ground ) ).toBe( true );
	} );

	it( 'keeps value, UUID, type, and version changes out of a stable compile key', () => {
		const firstOptions = createCompileOptions();
		const secondMaterial = createLogicalMaterial( 99 );
		secondMaterial.type = 'DifferentDiagnosticType';
		secondMaterial.needsUpdate = true;
		const secondOptions = createCompileOptions( {
			appearance: new CesiumGroundMaterialAppearance( { material: secondMaterial } ),
		} );

		const first = compileGroundPass( firstOptions );
		const second = compileGroundPass( secondOptions );
		expect( first.compileKey ).toBe( second.compileKey );
	} );

	it.each( [ 'source', 'defines', 'schema' ] as const )(
		'rejects a direct %s structural edit until needsUpdate advances the revision',
		structure => {
			const options = createCompileOptions();
			const logical = ( options.appearance as CesiumGroundMaterialAppearance ).material;
			const first = compileGroundPass( options );

			if ( structure === 'source' ) {
				logical.fragmentShader = logical.fragmentShader.replace(
					'result.emission = vec3(0.0);',
					'result.emission = vec3(0.1);',
				);
			} else if ( structure === 'defines' ) {
				logical.defines.USE_FIXTURE = 1;
			} else {
				logical.uniforms.u_extra = { value: 2 };
				logical.fragmentShader = logical.fragmentShader.replace(
					'uniform float u_opacity;',
					'uniform float u_opacity;\nuniform float u_extra;',
				).replace(
					'result.emission = vec3(0.0);',
					'result.emission = vec3(u_extra);',
				);
			}

			const error = expectCompilerError(
				() => compileGroundPass( options ),
				'GROUND_APPEARANCE_INCOMPATIBLE',
			);
			expect( error.detail ).toEqual( expect.objectContaining( {
				kind: 'surface',
				pass: 'color',
				materialVersion: 0,
				reason: 'material-structure-changed-without-needs-update',
			} ) );

			logical.needsUpdate = true;
			const rebuilt = compileGroundPass( options );
			expect( rebuilt.materialVersion ).toBe( 1 );
			expect( rebuilt.compileKey ).not.toBe( first.compileKey );
		} );

	it( 'does not accept a failed new-version source as the revision snapshot', () => {
		const options = createCompileOptions();
		const logical = ( options.appearance as CesiumGroundMaterialAppearance ).material;
		compileGroundPass( options );
		logical.fragmentShader = 'invalid but explicitly revised';
		logical.needsUpdate = true;

		expect( () => compileGroundPass( options ) ).toThrow();
		logical.fragmentShader = SAFE_SOURCE.replace(
			'result.emission = vec3(0.0);',
			'result.emission = vec3(0.2);',
		);
		expect( () => compileGroundPass( options ) ).not.toThrow();
	} );

	it( 'applies exact surface/decal stencil and color render states', () => {
		const front = compileGroundPass( createCompileOptions( { pass: 'frontStencil' } ) ).material;
		const back = compileGroundPass( createCompileOptions( { pass: 'backStencil' } ) ).material;
		const color = compileGroundPass( createCompileOptions() ).material;

		expect( front.side ).toBe( FrontSide );
		expect( front.depthFunc ).toBe( LessEqualDepth );
		expect( front.stencilFunc ).toBe( AlwaysStencilFunc );
		expect( front.stencilZFail ).toBe( DecrementWrapStencilOp );
		expect( front.colorWrite ).toBe( false );
		expect( front.uniforms.u_opacity ).toBeUndefined();
		expect( back.side ).toBe( BackSide );
		expect( back.stencilZFail ).toBe( IncrementWrapStencilOp );

		expect( color.side ).toBe( DoubleSide );
		expect( color.depthTest ).toBe( false );
		expect( color.depthWrite ).toBe( false );
		expect( color.stencilFunc ).toBe( NotEqualStencilFunc );
		expect( color.stencilFail ).toBe( ZeroStencilOp );
		expect( color.stencilZFail ).toBe( ZeroStencilOp );
		expect( color.stencilZPass ).toBe( ZeroStencilOp );
		expect( color.transparent ).toBe( false );
	} );

	it( 'keeps safe stencil keys independent from logical Material structure and versions', () => {
		const firstOptions = createCompileOptions( { pass: 'frontStencil' } );
		const different = new CesiumGroundMaterial( {
			type: 'UnrelatedStencilMaterial',
			uniforms: { u_other: { value: 123 } },
			fragmentShader: /* glsl */ `
				uniform float u_other;
				c23_material c23_getMaterial(c23_materialInput materialInput) {
					c23_material result;
					result.diffuse = vec3(u_other);
					result.emission = vec3(0.0);
					result.alpha = materialInput.baseColor.a;
					return result;
				}
			`,
		} );
		different.needsUpdate = true;
		const secondOptions = createCompileOptions( {
			pass: 'frontStencil',
			appearance: new CesiumGroundMaterialAppearance( { material: different } ),
		} );
		const first = compileGroundPass( firstOptions );
		const second = compileGroundPass( secondOptions );

		expect( first.compileKey ).toBe( second.compileKey );
		expect( first.materialVersion ).toBeUndefined();
		expect( second.materialVersion ).toBeUndefined();
		expect( second.material.uniforms.u_other ).toBeUndefined();
	} );

	it( 'applies transparent premultiplied state to polyline and arrow', () => {
		for ( const [ primitiveKind, pass ] of [
			[ 'polyline', 'polyline' ],
			[ 'arrow', 'arrow' ],
		] as const ) {
			const compiled = compileGroundPass( createCompileOptions( { primitiveKind, pass } ) );
			expect( compiled.material.side ).toBe( DoubleSide );
			expect( compiled.material.depthTest ).toBe( false );
			expect( compiled.material.stencilWrite ).toBe( false );
			expect( compiled.material.transparent ).toBe( true );
		}
	} );

	it( 'rejects an invalid kind/pass before allocating a material', () => {
		const error = expectCompilerError(
			() => compileGroundPass( createCompileOptions( {
				primitiveKind: 'polyline',
				pass: 'color',
			} ) ),
			'GROUND_APPEARANCE_INCOMPATIBLE',
		);
		expect( error.detail?.reason ).toBe( 'kind-pass-mismatch' );
	} );

	it( 'lets Raw modify exactly one generated default and keeps context wrappers', () => {
		const rawWrapper = { value: 2 };
		let contextSystemWrapper: unknown;
		let contextKeys: string[] = [];
		const raw = new CesiumGroundRawShaderAppearance( {
			uniforms: { u_opacity: rawWrapper },
			factory( context ) {
				contextKeys = Object.keys( context ).sort();
				contextSystemWrapper = context.systemUniforms.c23_time;
				const candidate = context.createDefaultMaterial();
				candidate.name = 'RawModifiedDefault';
				return candidate;
			},
		} );
		const options = createCompileOptions( { appearance: raw } );
		const compiled = compileGroundPass( options );

		expect( compiled.material.name ).toBe( 'RawModifiedDefault' );
		expect( compiled.material.glslVersion ).toBe( GLSL3 );
		expect( compiled.material.uniforms.c23_time ).toBe( options.systemUniforms.c23_time );
		expect( compiled.material.uniforms.u_opacity ).toBe( rawWrapper );
		expect( contextSystemWrapper ).toBe( options.systemUniforms.c23_time );
		expect( contextKeys ).toEqual( [
			'createDefaultMaterial',
			'pass',
			'primitiveKind',
			'systemUniforms',
			'userUniforms',
		] );
		expect( compiled.materialVersion ).toBeUndefined();
	} );

	it( 'accepts a complete GLSL3 Raw replacement with a used wrapper subset', () => {
		const rawWrapper = { value: 3 };
		const raw = new CesiumGroundRawShaderAppearance( {
			uniforms: { u_opacity: rawWrapper },
			factory( context ) {
				return new RawShaderMaterial( {
					glslVersion: GLSL3,
					uniforms: { u_opacity: context.userUniforms.u_opacity },
					vertexShader: 'in vec3 position; void main(){gl_Position=vec4(position,1.0);}',
					fragmentShader: 'precision highp float; out vec4 out_FragColor; void main(){out_FragColor=vec4(1.0);}',
				} );
			},
		} );
		const compiled = compileGroundPass( createCompileOptions( { appearance: raw } ) );
		expect( compiled.material.uniforms.u_opacity ).toBe( rawWrapper );
	} );

	it( 'rejects an unversioned Raw schema edit and accepts it after needsUpdate', () => {
		const raw = new CesiumGroundRawShaderAppearance( {
			uniforms: { u_gain: { value: 1 } },
			factory: context => context.createDefaultMaterial(),
		} );
		const options = createCompileOptions( { appearance: raw } );
		compileGroundPass( options );
		raw.uniforms.u_extra = { value: 2 };

		const error = expectCompilerError(
			() => compileGroundPass( options ),
			'GROUND_APPEARANCE_INCOMPATIBLE',
		);
		expect( error.detail ).toEqual( expect.objectContaining( {
			kind: 'surface',
			pass: 'color',
			appearanceVersion: 0,
			reason: 'raw-schema-changed-without-needs-update',
		} ) );

		raw.needsUpdate = true;
		const rebuilt = compileGroundPass( options );
		expect( rebuilt.appearanceVersion ).toBe( 1 );
		expect( rebuilt.material.uniforms.u_extra ).toBe( raw.uniforms.u_extra );
	} );

	it( 'rejects async/non-Raw/GLSL1 results and replaced context wrappers', () => {
		const invalidFactories = [
			() => null,
			() => Promise.resolve( new RawShaderMaterial() ),
			() => new MeshBasicMaterial(),
			() => new RawShaderMaterial(),
			( context: Parameters<CesiumGroundRawShaderAppearance['factory']>[0] ) => new RawShaderMaterial( {
				glslVersion: GLSL3,
				uniforms: { c23_time: { value: context.systemUniforms.c23_time.value } },
			} ),
		];
		for ( const factory of invalidFactories ) {
			const raw = new CesiumGroundRawShaderAppearance( { factory: factory as never } );
			expectCompilerError(
				() => compileGroundPass( createCompileOptions( { appearance: raw } ) ),
				factory === invalidFactories[ 4 ]
					? 'GROUND_UNIFORM_CONFLICT'
					: 'GROUND_RAW_FACTORY_RESULT_INVALID',
			);
		}
	} );

	it( 'disposes an unreturned default and rejects a caught second default call', () => {
		let firstDefault: RawShaderMaterial | undefined;
		let replacement: RawShaderMaterial | undefined;
		const firstDispose = vi.fn();
		const replacementDispose = vi.fn();
		const raw = new CesiumGroundRawShaderAppearance( {
			factory( context ) {
				firstDefault = context.createDefaultMaterial();
				firstDefault.addEventListener( 'dispose', firstDispose );
				try {
					context.createDefaultMaterial();
				} catch {
					// A factory cannot make the invocation valid by catching this error.
				}
				replacement = new RawShaderMaterial( { glslVersion: GLSL3 } );
				replacement.addEventListener( 'dispose', replacementDispose );
				return replacement;
			},
		} );

		expectCompilerError(
			() => compileGroundPass( createCompileOptions( { appearance: raw } ) ),
			'GROUND_RAW_FACTORY_RESULT_INVALID',
		);
		expect( firstDefault ).toBeDefined();
		expect( replacement ).toBeDefined();
		expect( firstDispose ).toHaveBeenCalledTimes( 1 );
		expect( replacementDispose ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'rejects Raw material reuse across historical compiles without disposing the live owner', () => {
		const shared = new RawShaderMaterial( {
			glslVersion: GLSL3,
			vertexShader: 'void main(){gl_Position=vec4(0.0);}',
			fragmentShader: 'precision highp float; out vec4 out_FragColor; void main(){out_FragColor=vec4(1.0);}',
		} );
		const dispose = vi.fn();
		shared.addEventListener( 'dispose', dispose );
		const raw = new CesiumGroundRawShaderAppearance( { factory: () => shared } );
		compileGroundPass( createCompileOptions( { appearance: raw } ) );

		const error = expectCompilerError(
			() => compileGroundPass( createCompileOptions( {
				appearance: raw,
				pipelineState: {
					fragmentCull: false,
					debugVolume: false,
					attributeLayoutKey: 'surface-v1',
					primitiveId: 'primitive-B',
				},
			} ) ),
			'GROUND_RAW_MATERIAL_REUSED',
		);
		expect( error.detail?.firstOwner ).toMatchObject( { primitiveId: 'primitive-A' } );
		expect( dispose ).not.toHaveBeenCalled();
	} );
} );
