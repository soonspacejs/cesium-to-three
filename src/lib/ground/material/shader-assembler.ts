// ============================================================
// material/shader-assembler.ts
// Purpose: deterministic GLSL assembly from explicit, named source sections.
//          This module never searches or rewrites a Cesium `main()` anchor.
//          System stages provide complete bodies and the safe material path
//          owns its sole entry call, final premultiplication, and output write.
// ============================================================

import type { CesiumGroundMaterial } from './CesiumGroundMaterial';
import {
	C23_SHADER_ABI_SOURCE,
	C23_VERTEX_SHADER_ABI_SOURCE,
	createFinalOutputSource,
	createGroundKindDefineSource,
	createGroundUserDefineSource,
	createMaterialInputSource,
} from './shader-abi';
import { C23_GROUND_FRAGMENT_SHADER_TEMPLATE } from './templates';
import type { GroundPrimitiveKind, GroundRenderPass } from './types';
import { validateGroundMaterialSource } from './validation';

/** Pipeline macros are library-owned and available to trusted system sections. */
export const C23_PASS_DEFINE_NAMES = {
	frontStencil: 'C23_PASS_FRONT_STENCIL',
	backStencil: 'C23_PASS_BACK_STENCIL',
	color: 'C23_PASS_COLOR',
	polyline: 'C23_PASS_POLYLINE',
	arrow: 'C23_PASS_ARROW',
} as const satisfies Record<GroundRenderPass, string>;

/** Shared identity and trusted system prefix for either shader stage. */
interface GroundShaderAssemblyBase {
	kind: GroundPrimitiveKind;
	pass: GroundRenderPass;
	/** Compile-time system macros such as fragment-culling/debug switches. */
	systemDefines?: readonly string[];
}

/**
 * Vertex source is entirely library-owned for safe appearances. The supplied
 * `main` section must be a complete function, which removes every reason for
 * the assembler to rename or patch an imported function.
 */
export interface GroundVertexShaderAssemblyOptions extends GroundShaderAssemblyBase {
	/** Optional logical Material whose safe vertex hook is shared by this pass. */
	material?: Pick<
		CesiumGroundMaterial,
		'type' | 'vertexShader' | 'fragmentShader' | 'uniforms' | 'defines'
	>;
	sections: {
		declarations: string;
		attributes: string;
		varyings?: string;
		helpers?: string;
		main: string;
	};
}

/** Internal bridge keeps the system main independent of optional user source. */
function createSafeVertexHook(
	options: GroundVertexShaderAssemblyOptions,
): readonly string[] {
	const material = options.material;
	if ( material?.vertexShader === undefined ) {
		return [
			emitNamedSection( 'ground-vertex-abi', undefined ),
			emitNamedSection( 'ground-user-defines', undefined ),
			emitNamedSection( 'ground-user-vertex', undefined ),
			emitNamedSection( 'vertex-safe-hook', /* glsl */ `
void c23_applyVertex(vec3 positionEC, inout vec4 positionClip) {
	// Fixed safe path: no logical vertex hook was supplied.
}
` ),
		];
	}

	// Validate both stages here so a custom surface stencil pass cannot accept a
	// structure that the later color pass would reject after partial compilation.
	validateGroundMaterialSource( material, options.kind );
	return [
		emitNamedSection( 'ground-vertex-abi', C23_VERTEX_SHADER_ABI_SOURCE ),
		emitNamedSection( 'ground-user-defines', createGroundUserDefineSource( material.defines ) ),
		emitNamedSection( 'ground-user-vertex', material.vertexShader ),
		emitNamedSection( 'vertex-safe-hook', /* glsl */ `
void c23_applyVertex(vec3 positionEC, inout vec4 positionClip) {
	c23_vertexInput vertexInput;
	vertexInput.positionEC = positionEC;
	c23_vertexOutput vertexOutput;
	vertexOutput.positionClip = positionClip;
	c23_vertexMain(vertexInput, vertexOutput);
	positionClip = vertexOutput.positionClip;
}
` ),
	];
}

/** Fixed front/back stencil source; it deliberately has no Material ABI call. */
export interface GroundStencilFragmentShaderAssemblyOptions extends GroundShaderAssemblyBase {
	mode: 'stencil';
	sections: {
		declarations: string;
		varyings?: string;
		helpers?: string;
		main: string;
	};
}

/**
 * Safe color/line/arrow system stages run around one validated Material call.
 * `mainPrologue` reconstructs depth/membership and may update coverage;
 * `inputAssignments` fills fields supported by the current primitive kind;
 * `mainEpilogue` is reserved for pass cleanup after the output write.
 */
export interface GroundMaterialFragmentShaderAssemblyOptions extends GroundShaderAssemblyBase {
	mode: 'material';
	material: Pick<
		CesiumGroundMaterial,
		'type' | 'vertexShader' | 'fragmentShader' | 'uniforms' | 'defines'
	>;
	sections: {
		declarations: string;
		varyings?: string;
		helpers?: string;
		mainPrologue?: string;
		inputAssignments?: string;
		mainEpilogue?: string;
	};
}

export type GroundFragmentShaderAssemblyOptions =
	| GroundStencilFragmentShaderAssemblyOptions
	| GroundMaterialFragmentShaderAssemblyOptions;

/** Stable precision declarations owned by the assembled GLSL3 vertex stage. */
const VERTEX_PRECISION_SOURCE = /* glsl */ `
precision highp float;
precision highp int;
`;

/** Stable precision/output declarations owned by the assembled GLSL3 fragment stage. */
const FRAGMENT_PRECISION_SOURCE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 out_FragColor;
`;

/**
 * Normalizes only source boundaries. Internal whitespace and user line numbers
 * remain untouched, which keeps driver diagnostics aligned with the validated
 * source while preventing platform-specific CRLF changes in compile keys.
 */
function normalizeSectionSource( source: string | undefined ): string {
	if ( source === undefined ) return '';
	return source.split( '\r\n' ).join( '\n' ).trim();
}

/** Emits a visible boundary so snapshots and compiler logs identify ownership. */
function emitNamedSection( name: string, source: string | undefined ): string {
	const normalized = normalizeSectionSource( source );
	return normalized.length === 0
		? `// [c23:${ name }]`
		: `// [c23:${ name }]\n${ normalized }`;
}

/**
 * System defines are already library-owned constants, but validating their
 * shape here prevents an accidental newline or directive from corrupting all
 * later named sections.
 */
function createGroundSystemDefineSource( defines: readonly string[] | undefined ): string {
	if ( defines === undefined ) return '';
	return defines.map( define => {
		if ( ! /^[A-Za-z_][A-Za-z0-9_]*(?:\s+[^\r\n#]+)?$/.test( define ) ) {
			throw new TypeError( `Ground system define "${ define }" is not one safe GLSL define.` );
		}
		return `#define ${ define }`;
	} ).join( '\n' );
}

/** Builds the macros shared by trusted vertex/fragment system source. */
function createPipelineDefineSource( options: GroundShaderAssemblyBase ): string {
	return [
		createGroundKindDefineSource( options.kind ),
		`#define ${ C23_PASS_DEFINE_NAMES[ options.pass ] } 1`,
		createGroundSystemDefineSource( options.systemDefines ),
	].filter( section => section.length > 0 ).join( '\n' );
}

/** Joins named sections with exactly one blank line and one trailing newline. */
function joinNamedSections( sections: readonly string[] ): string {
	return `${ sections.join( '\n\n' ) }\n`;
}

/** Assembles one complete GLSL3 vertex source from explicit system sections. */
export function assembleGroundVertexShader(
	options: GroundVertexShaderAssemblyOptions,
): string {
	return joinNamedSections( [
		emitNamedSection( 'vertex-precision', VERTEX_PRECISION_SOURCE ),
		emitNamedSection( 'pipeline-defines', createPipelineDefineSource( options ) ),
		emitNamedSection( 'vertex-system-declarations', options.sections.declarations ),
		emitNamedSection( 'vertex-attributes', options.sections.attributes ),
		emitNamedSection( 'vertex-varyings', options.sections.varyings ),
		emitNamedSection( 'vertex-system-helpers', options.sections.helpers ),
		...createSafeVertexHook( options ),
		emitNamedSection( 'vertex-main', options.sections.main ),
	] );
}

/** Creates the only `main()` permitted in a safe Material fragment shader. */
function createSafeFragmentMain(
	sections: GroundMaterialFragmentShaderAssemblyOptions['sections'],
): string {
	const body = [
		'void main() {',
		'\t// Coverage is separate from Material alpha so classification always reaches cleanup.',
		'\tfloat c23_systemCoverage = 1.0;',
		normalizeSectionSource( createMaterialInputSource() ),
		emitNamedSection( 'fragment-main-system-prologue', sections.mainPrologue ),
		emitNamedSection( 'fragment-main-input-assignments', sections.inputAssignments ),
		'c23_material c23_surfaceMaterial = c23_getMaterial(c23_input);',
		normalizeSectionSource( createFinalOutputSource() ),
		emitNamedSection( 'fragment-main-epilogue', sections.mainEpilogue ),
		'}',
	];
	return body.join( '\n' );
}

/**
 * Assembles either a fixed stencil fragment shader or a complete safe Material
 * shader. Validation occurs before concatenation so injected ABI declarations
 * cannot hide user-owned reserved identifiers or forbidden operations.
 */
export function assembleGroundFragmentShader(
	options: GroundFragmentShaderAssemblyOptions,
): string {
	const commonSections = [
		emitNamedSection( 'fragment-precision-output', FRAGMENT_PRECISION_SOURCE ),
		emitNamedSection( 'pipeline-defines', createPipelineDefineSource( options ) ),
		emitNamedSection( 'fragment-system-declarations', options.sections.declarations ),
		emitNamedSection( 'fragment-varyings', options.sections.varyings ),
		emitNamedSection( 'fragment-system-helpers', options.sections.helpers ),
	];

	if ( options.mode === 'stencil' ) {
		return joinNamedSections( [
			...commonSections,
			emitNamedSection( 'fragment-stencil-main', options.sections.main ),
		] );
	}

	const fragmentShader = options.material.fragmentShader
		?? C23_GROUND_FRAGMENT_SHADER_TEMPLATE;
	const effectiveMaterial = options.material.fragmentShader === undefined
		? { ...options.material, fragmentShader }
		: options.material;
	validateGroundMaterialSource( effectiveMaterial, options.kind );
	return joinNamedSections( [
		...commonSections,
		emitNamedSection( 'ground-material-abi', C23_SHADER_ABI_SOURCE ),
		emitNamedSection( 'ground-user-defines', createGroundUserDefineSource( options.material.defines ) ),
		emitNamedSection( 'ground-user-material', fragmentShader ),
		emitNamedSection( 'fragment-safe-main', createSafeFragmentMain( options.sections ) ),
	] );
}
