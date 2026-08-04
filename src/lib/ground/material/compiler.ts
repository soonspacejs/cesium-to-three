// ============================================================
// material/compiler.ts
// Purpose: compile one validated Ground pass into an independently owned
//          RawShaderMaterial, with stable render state, wrapper identities,
//          compile keys, and strict Raw factory ownership/cleanup semantics.
// ============================================================

import {
	AddEquation,
	AlwaysStencilFunc,
	BackSide,
	CustomBlending,
	DecrementWrapStencilOp,
	DoubleSide,
	FrontSide,
	GLSL3,
	IncrementWrapStencilOp,
	KeepStencilOp,
	LessEqualDepth,
	NotEqualStencilFunc,
	OneFactor,
	OneMinusSrcAlphaFactor,
	RawShaderMaterial,
	ZeroStencilOp,
	type IUniform,
} from 'three';

import { CLASSIFICATION_MASK } from '../constants';
import {
	CesiumGroundMaterial,
	commitGroundMaterialStructureForCompile,
	prepareGroundMaterialStructureForCompile,
} from './CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
	commitGroundRawStructureForCompile,
	prepareGroundRawStructureForCompile,
	type CesiumGroundAppearance,
} from './appearances';
import { CesiumGroundMaterialError } from './errors';
import {
	createGroundArrowShaders,
	createGroundClassificationColorShaders,
	createGroundClassificationStencilShaders,
	createGroundPolylineShaders,
	type GroundShaderSourcePair,
} from './ground-system-shaders';
import { C23_GROUND_SHADER_ABI_VERSION } from './shader-abi';
import { mergeGroundUniforms } from './system-uniforms';
import { C23_GROUND_FRAGMENT_SHADER_TEMPLATE } from './templates';
import {
	GROUND_RENDER_PASSES,
	type GroundPrimitiveKind,
	type GroundRenderPass,
	type GroundSystemUniforms,
	type GroundUserUniforms,
} from './types';

/** Runtime-independent switches that alter system GLSL or attribute layout. */
export interface GroundCompilePipelineState {
	fragmentCull: boolean;
	debugVolume: boolean;
	/** Stable geometry schema identity, never a mutable BufferAttribute value. */
	attributeLayoutKey: string;
	/** Diagnostic owner identity used only for Raw instance claims. */
	primitiveId: string | number;
}

export interface CompileGroundPassOptions {
	primitiveKind: GroundPrimitiveKind;
	pass: GroundRenderPass;
	appearance: CesiumGroundAppearance;
	systemUniforms: GroundSystemUniforms;
	/**
	 * Current built-in/default logical Material for Raw createDefaultMaterial()
	 * and for a safe appearance whose fragmentShader is omitted. Its wrappers
	 * remain borrowed.
	 */
	defaultMaterial: CesiumGroundMaterial;
	pipelineState: GroundCompilePipelineState;
}

/** Actual per-primitive/per-pass resource owned and disposed by the primitive. */
export interface GroundCompiledMaterial {
	readonly primitiveKind: GroundPrimitiveKind;
	readonly pass: GroundRenderPass;
	readonly material: RawShaderMaterial;
	readonly appearance: CesiumGroundAppearance;
	readonly appearanceVersion: number;
	readonly materialVersion?: number;
	readonly compileKey: string;
}

/** Diagnostic metadata retained on every compiled Three material. */
export interface GroundCompiledMaterialDiagnostic {
	readonly kind: GroundPrimitiveKind;
	readonly pass: GroundRenderPass;
	readonly abiVersion: typeof C23_GROUND_SHADER_ABI_VERSION;
	readonly appearanceKind: CesiumGroundAppearance['kind'];
	readonly appearanceVersion: number;
	readonly materialType?: string;
	readonly primitiveId: string | number;
}

interface RawMaterialClaimMetadata {
	primitiveId: string | number;
	kind: GroundPrimitiveKind;
	pass: GroundRenderPass;
	appearanceVersion: number;
}

/**
 * Claims persist for the JS object's lifetime, including after disposal. This
 * rejects a factory cache that tries to recycle a historical material during a
 * later rebuild while allowing garbage collection through weak keys.
 */
const RAW_MATERIAL_CLAIMS = new WeakMap<RawShaderMaterial, RawMaterialClaimMetadata>();

/** One-line source used only if an impossible caller passes no valid fallback. */
function assertDefaultMaterial( material: unknown ): asserts material is CesiumGroundMaterial {
	if ( ! ( material instanceof CesiumGroundMaterial ) ) {
		throw new CesiumGroundMaterialError(
			'GROUND_APPEARANCE_INCOMPATIBLE',
			'Ground pass compilation requires the primitive default logical Material.',
			{ reason: 'default-material-missing', abiVersion: C23_GROUND_SHADER_ABI_VERSION },
		);
	}
}

/** Validates the exact kind/pass matrix before any resource is allocated. */
function assertGroundPassCompatible( kind: GroundPrimitiveKind, pass: GroundRenderPass ): void {
	if (( GROUND_RENDER_PASSES[ kind ] as readonly GroundRenderPass[] ).includes( pass ) ) return;
	throw new CesiumGroundMaterialError(
		'GROUND_APPEARANCE_INCOMPATIBLE',
		`Ground pass "${ pass }" is not valid for primitive kind "${ kind }".`,
		{
			kind,
			pass,
			reason: 'kind-pass-mismatch',
			abiVersion: C23_GROUND_SHADER_ABI_VERSION,
		},
	);
}

/**
 * Merges primitive default wrappers and Raw user wrappers. Raw user entries may
 * intentionally replace a same-named built-in wrapper so the returned default
 * shader observes the factory context's documented user wrapper identity.
 */
function mergeDefaultAndRawUserUniforms(
	defaultUniforms: GroundUserUniforms,
	rawUniforms: GroundUserUniforms,
): GroundUserUniforms {
	const merged: GroundUserUniforms = { ...defaultUniforms };
	for ( const [ name, wrapper ] of Object.entries( rawUniforms ) ) merged[ name ] = wrapper;
	return merged;
}

type GroundShaderMaterialSource = Pick<
	CesiumGroundMaterial,
	'type' | 'vertexShader' | 'fragmentShader' | 'uniforms' | 'defines'
>;

/**
 * Resolves a vertex-only safe Material against this primitive's real default
 * fragment source. This preserves solid color, line dashes, textured decals,
 * and their wrapper identities instead of replacing them with a generic color.
 */
function resolveSafeGroundMaterial(
	logicalMaterial: CesiumGroundMaterial,
	defaultMaterial: CesiumGroundMaterial,
): GroundShaderMaterialSource {
	if ( logicalMaterial.fragmentShader !== undefined ) return logicalMaterial;
	return {
		type: logicalMaterial.type,
		vertexShader: logicalMaterial.vertexShader,
		fragmentShader: defaultMaterial.fragmentShader
			?? C23_GROUND_FRAGMENT_SHADER_TEMPLATE,
		uniforms: mergeDefaultAndRawUserUniforms(
			defaultMaterial.uniforms,
			logicalMaterial.uniforms,
		),
		defines: { ...defaultMaterial.defines, ...logicalMaterial.defines },
	};
}

/** Selects the complete trusted source pair for one safe/default pass. */
function createGroundPassShaders(
	kind: GroundPrimitiveKind,
	pass: GroundRenderPass,
	material: GroundShaderMaterialSource,
	state: GroundCompilePipelineState,
): GroundShaderSourcePair {
	if ( pass === 'frontStencil' || pass === 'backStencil' ) {
		if ( kind !== 'surface' && kind !== 'decal' ) {
			// Matrix validation should make this branch unreachable, but keeping the
			// guard local prevents future pass additions from weakening type safety.
			throw new TypeError( `Stencil pass cannot be assembled for ${ kind }.` );
		}
		return createGroundClassificationStencilShaders( kind, pass, material );
	}
	if ( pass === 'color' ) {
		if ( kind !== 'surface' && kind !== 'decal' ) {
			throw new TypeError( `Classification color pass cannot be assembled for ${ kind }.` );
		}
		return createGroundClassificationColorShaders( kind, material, state.fragmentCull );
	}
	if ( pass === 'polyline' ) return createGroundPolylineShaders( material, state.debugVolume );
	return createGroundArrowShaders( material, state.debugVolume );
}

/** Applies the fixed default render-state contract for one physical pass. */
function createDefaultRawShaderMaterial(
	kind: GroundPrimitiveKind,
	pass: GroundRenderPass,
	logicalMaterial: GroundShaderMaterialSource,
	uniforms: Record<string, IUniform>,
	state: GroundCompilePipelineState,
): RawShaderMaterial {
	const shaders = createGroundPassShaders( kind, pass, logicalMaterial, state );
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: shaders.vertexShader,
		fragmentShader: shaders.fragmentShader,
		toneMapped: false,
	} );

	if ( pass === 'frontStencil' || pass === 'backStencil' ) {
		material.side = pass === 'frontStencil' ? FrontSide : BackSide;
		material.colorWrite = false;
		material.depthWrite = false;
		material.depthTest = true;
		material.depthFunc = LessEqualDepth;
		material.stencilWrite = true;
		material.stencilFunc = AlwaysStencilFunc;
		material.stencilRef = 0;
		material.stencilFuncMask = CLASSIFICATION_MASK;
		material.stencilWriteMask = CLASSIFICATION_MASK;
		material.stencilFail = KeepStencilOp;
		material.stencilZFail = pass === 'frontStencil'
			? DecrementWrapStencilOp
			: IncrementWrapStencilOp;
		material.stencilZPass = KeepStencilOp;
		material.name = pass === 'frontStencil'
			? 'CesiumGroundFrontStencilMaterial'
			: 'CesiumGroundBackStencilMaterial';
		return material;
	}

	material.side = DoubleSide;
	material.colorWrite = true;
	material.depthWrite = false;
	material.depthTest = false;
	material.blending = CustomBlending;
	material.blendEquation = AddEquation;
	material.blendSrc = OneFactor;
	material.blendDst = OneMinusSrcAlphaFactor;
	material.blendSrcAlpha = OneFactor;
	material.blendDstAlpha = OneMinusSrcAlphaFactor;

	if ( pass === 'color' ) {
		material.stencilWrite = true;
		material.stencilFunc = NotEqualStencilFunc;
		material.stencilRef = 0;
		material.stencilFuncMask = CLASSIFICATION_MASK;
		material.stencilWriteMask = CLASSIFICATION_MASK;
		material.stencilFail = ZeroStencilOp;
		material.stencilZFail = ZeroStencilOp;
		material.stencilZPass = ZeroStencilOp;
		// Keep classification color in Three's opaque list so front/back/color
		// renderOrder adjacency is not split by transparent sorting.
		material.transparent = false;
		material.name = kind === 'decal'
			? 'CesiumGroundDecalColorMaterial'
			: 'CesiumGroundSurfaceColorMaterial';
	} else {
		material.stencilWrite = false;
		material.transparent = true;
		material.name = pass === 'polyline'
			? 'CesiumGroundPolylineMaterial'
			: 'CesiumGroundArrowMaterial';
	}
	return material;
}

/** Canonicalizes Three defines without inspecting runtime uniform values. */
function canonicalizeThreeDefines( defines: RawShaderMaterial['defines'] ): readonly unknown[] {
	if ( defines === undefined ) return [];
	return Object.keys( defines ).sort().map( name => [ name, defines[ name ] ] );
}

/** Stable logical/program identity used by reconciliation and unit diagnostics. */
function computeCompiledMaterialKey(
	kind: GroundPrimitiveKind,
	pass: GroundRenderPass,
	material: RawShaderMaterial,
	state: GroundCompilePipelineState,
): string {
	return JSON.stringify( [
		'c23-ground-compiled-material',
		C23_GROUND_SHADER_ABI_VERSION,
		kind,
		pass,
		state.attributeLayoutKey,
		material.glslVersion,
		material.vertexShader,
		material.fragmentShader,
		canonicalizeThreeDefines( material.defines ),
		Object.keys( material.uniforms ).sort(),
	] );
}

/** Adds context shared by all compiler-owned errors. */
function rawErrorDetail(
	options: CompileGroundPassOptions,
	extra: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return {
		kind: options.primitiveKind,
		pass: options.pass,
		appearanceKind: options.appearance.kind,
		appearanceVersion: options.appearance.version,
		primitiveId: options.pipelineState.primitiveId,
		abiVersion: C23_GROUND_SHADER_ABI_VERSION,
		...extra,
	};
}

/** Disposes a failed candidate only if no live/historical owner has claimed it. */
function disposeUnclaimedRawCandidate( candidate: unknown ): void {
	if ( ! ( candidate instanceof RawShaderMaterial ) ) return;
	if ( RAW_MATERIAL_CLAIMS.has( candidate ) ) return;
	candidate.dispose();
}

/** Validates every context-owned name that a complete Raw replacement binds. */
function assertRawUniformWrapperIdentities(
	material: RawShaderMaterial,
	options: CompileGroundPassOptions,
): void {
	const rawAppearance = options.appearance as CesiumGroundRawShaderAppearance;
	for ( const [ name, actual ] of Object.entries( material.uniforms ) ) {
		const expected = options.systemUniforms[ name ] ?? rawAppearance.uniforms[ name ];
		if ( expected === undefined || actual === expected ) continue;
		throw new CesiumGroundMaterialError(
			'GROUND_UNIFORM_CONFLICT',
			`Raw Ground material replaced the required wrapper for uniform "${ name }".`,
			rawErrorDetail( options, {
				identifier: name,
				reason: 'raw-uniform-wrapper-replaced',
			} ),
		);
	}
}

/** Claims a successful Raw result after all factory/result checks pass. */
function claimRawMaterial(
	material: RawShaderMaterial,
	options: CompileGroundPassOptions,
): void {
	const firstOwner = RAW_MATERIAL_CLAIMS.get( material );
	if ( firstOwner !== undefined ) {
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_MATERIAL_REUSED',
			'Raw Ground factory returned a RawShaderMaterial that was already claimed.',
			rawErrorDetail( options, {
				reason: 'raw-material-identity-reused',
				firstOwner,
			} ),
		);
	}
	RAW_MATERIAL_CLAIMS.set( material, {
		primitiveId: options.pipelineState.primitiveId,
		kind: options.primitiveKind,
		pass: options.pass,
		appearanceVersion: options.appearance.version,
	} );
}

/** Executes one Raw factory with strict default-candidate ownership tracking. */
function compileRawGroundPass(
	options: CompileGroundPassOptions,
): RawShaderMaterial {
	const appearance = options.appearance as CesiumGroundRawShaderAppearance;
	const structureKey = prepareGroundRawStructureForCompile(
		appearance,
		rawErrorDetail( options, {} ),
	);
	const defaultUserUniforms = mergeDefaultAndRawUserUniforms(
		options.defaultMaterial.uniforms,
		appearance.uniforms,
	);
	const defaultMergedUniforms = mergeGroundUniforms(
		options.systemUniforms,
		defaultUserUniforms,
	);
	// Validate conflicts for the public context map even if the factory chooses
	// complete replacement and never asks for a default material.
	mergeGroundUniforms( options.systemUniforms, appearance.uniforms );

	let defaultCalls = 0;
	let defaultCandidate: RawShaderMaterial | undefined;
	let defaultCallViolation = false;
	const createDefaultMaterial = (): RawShaderMaterial => {
		defaultCalls += 1;
		if ( defaultCalls > 1 ) {
			defaultCallViolation = true;
			throw new CesiumGroundMaterialError(
				'GROUND_RAW_FACTORY_RESULT_INVALID',
				'Raw Ground factory may call createDefaultMaterial() at most once.',
				rawErrorDetail( options, { reason: 'default-material-called-more-than-once' } ),
			);
		}
		defaultCandidate = createDefaultRawShaderMaterial(
			options.primitiveKind,
			options.pass,
			options.defaultMaterial,
			defaultMergedUniforms,
			options.pipelineState,
		);
		return defaultCandidate;
	};

	let result: unknown;
	try {
		result = appearance.factory( Object.freeze( {
			primitiveKind: options.primitiveKind,
			pass: options.pass,
			systemUniforms: options.systemUniforms,
			userUniforms: appearance.uniforms,
			createDefaultMaterial,
		} ) );
	} catch ( error ) {
		disposeUnclaimedRawCandidate( defaultCandidate );
		if ( error instanceof CesiumGroundMaterialError ) throw error;
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_FACTORY_RESULT_INVALID',
			'Raw Ground factory threw while compiling a pass.',
			rawErrorDetail( options, { reason: 'factory-threw', cause: error } ),
		);
	}

	if ( defaultCallViolation ) {
		disposeUnclaimedRawCandidate( defaultCandidate );
		disposeUnclaimedRawCandidate( result );
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_FACTORY_RESULT_INVALID',
			'Raw Ground factory continued after an invalid second default-material call.',
			rawErrorDetail( options, { reason: 'default-material-call-violation-caught' } ),
		);
	}
	if ( ! ( result instanceof RawShaderMaterial ) ) {
		disposeUnclaimedRawCandidate( defaultCandidate );
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_FACTORY_RESULT_INVALID',
			'Raw Ground factory must synchronously return a RawShaderMaterial.',
			rawErrorDetail( options, {
				reason: 'factory-result-not-raw-shader-material',
				resultType: result === null ? 'null' : typeof result,
			} ),
		);
	}
	if ( defaultCandidate !== undefined && result !== defaultCandidate ) {
		disposeUnclaimedRawCandidate( defaultCandidate );
		disposeUnclaimedRawCandidate( result );
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_FACTORY_RESULT_INVALID',
			'Raw Ground factory must return the exact material created by createDefaultMaterial().',
			rawErrorDetail( options, { reason: 'default-material-not-returned' } ),
		);
	}
	if ( result.glslVersion !== GLSL3 ) {
		disposeUnclaimedRawCandidate( result );
		throw new CesiumGroundMaterialError(
			'GROUND_RAW_FACTORY_RESULT_INVALID',
			'Raw Ground factory result must use Three.GLSL3.',
			rawErrorDetail( options, { reason: 'raw-material-not-glsl3' } ),
		);
	}

	try {
		assertRawUniformWrapperIdentities( result, options );
		claimRawMaterial( result, options );
		commitGroundRawStructureForCompile( appearance, structureKey );
	} catch ( error ) {
		disposeUnclaimedRawCandidate( result );
		throw error;
	}
	return result;
}

/**
 * Compiles exactly one pass. Complete candidate-set transaction/atomic swap is
 * owned by the primitive reconciliation layer; this function guarantees that
 * a failed individual pass leaks no compiler-created candidate.
 */
export function compileGroundPass( options: CompileGroundPassOptions ): GroundCompiledMaterial {
	assertGroundPassCompatible( options.primitiveKind, options.pass );
	assertDefaultMaterial( options.defaultMaterial );

	let compiled: RawShaderMaterial;
	let materialVersion: number | undefined;
	if ( options.appearance instanceof CesiumGroundMaterialAppearance ) {
		const logicalMaterial = options.appearance.material;
		const isStencil = options.pass === 'frontStencil' || options.pass === 'backStencil';
		const isFixedStencil = isStencil && logicalMaterial.vertexShader === undefined;
		const resolvedMaterial = isFixedStencil
			? logicalMaterial
			: resolveSafeGroundMaterial( logicalMaterial, options.defaultMaterial );
		const structureKey = isFixedStencil
			? undefined
			: prepareGroundMaterialStructureForCompile( logicalMaterial, {
				kind: options.primitiveKind,
				pass: options.pass,
				appearanceKind: options.appearance.kind,
				appearanceVersion: options.appearance.version,
				primitiveId: options.pipelineState.primitiveId,
				abiVersion: C23_GROUND_SHADER_ABI_VERSION,
			} );
		// A stencil remains fixed only when no safe vertex hook exists. Custom
		// vertex source and wrappers must be identical across front/back/color.
		const uniforms = isFixedStencil
			? { ...options.systemUniforms }
			: mergeGroundUniforms( options.systemUniforms, resolvedMaterial.uniforms );
		compiled = createDefaultRawShaderMaterial(
			options.primitiveKind,
			options.pass,
			resolvedMaterial,
			uniforms,
			options.pipelineState,
		);
		if ( ! isFixedStencil ) {
			commitGroundMaterialStructureForCompile( logicalMaterial, structureKey as string );
			materialVersion = logicalMaterial.version;
		}
	} else if ( options.appearance instanceof CesiumGroundRawShaderAppearance ) {
		compiled = compileRawGroundPass( options );
	} else {
		throw new CesiumGroundMaterialError(
			'GROUND_APPEARANCE_INCOMPATIBLE',
			'Ground pass received an unknown Appearance implementation.',
			{
				kind: options.primitiveKind,
				pass: options.pass,
				reason: 'unknown-appearance-implementation',
				abiVersion: C23_GROUND_SHADER_ABI_VERSION,
			},
		);
	}

	const record: GroundCompiledMaterial = {
		primitiveKind: options.primitiveKind,
		pass: options.pass,
		material: compiled,
		appearance: options.appearance,
		appearanceVersion: options.appearance.version,
		compileKey: computeCompiledMaterialKey(
			options.primitiveKind,
			options.pass,
			compiled,
			options.pipelineState,
		),
	};
	const diagnostic: GroundCompiledMaterialDiagnostic = Object.freeze( {
		kind: options.primitiveKind,
		pass: options.pass,
		abiVersion: C23_GROUND_SHADER_ABI_VERSION,
		appearanceKind: options.appearance.kind,
		appearanceVersion: options.appearance.version,
		materialType: options.appearance instanceof CesiumGroundMaterialAppearance
			? options.appearance.material.type
			: undefined,
		primitiveId: options.pipelineState.primitiveId,
	} );
	compiled.userData.c23Ground = diagnostic;
	if ( materialVersion !== undefined ) {
		return Object.freeze( { ...record, materialVersion } );
	}
	return Object.freeze( record );
}
