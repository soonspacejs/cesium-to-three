// ============================================================
// material/types.ts
// Layer: public contracts shared by logical materials, appearances and the
//        compiler. This file contains no renderer state and no implementation
//        imports, keeping it safe for type-only consumers and declaration emit.
// ============================================================

import type { IUniform, RawShaderMaterial } from 'three';

/** Values that can be serialized deterministically into a GLSL define. */
export type GroundDefineValue = string | number | boolean;

/** User-controlled compile-time macros for a safe Ground material. */
export type GroundDefines = Record<string, GroundDefineValue>;

/**
 * User uniform wrappers. The wrapper object, not only its `.value`, is part of
 * the sharing contract: every compiled pass must retain these exact references.
 */
export type GroundUserUniforms = Record<string, IUniform>;

/** Per-primitive wrappers managed and updated exclusively by the library. */
export type GroundSystemUniforms = Readonly<Record<string, IUniform>>;

/** Stable shader-input families. Point delegates resolve to surface or decal. */
export type GroundPrimitiveKind = 'surface' | 'polyline' | 'decal' | 'arrow';

/** Physical draw passes that can request a compiled RawShaderMaterial. */
export type GroundRenderPass =
	| 'frontStencil'
	| 'backStencil'
	| 'color'
	| 'polyline'
	| 'arrow';

/**
 * Immutable context passed to one Raw factory invocation. The maps themselves
 * are read-only views; their wrapper values continue to update every frame.
 */
export interface GroundRawShaderBuildContext {
	primitiveKind: GroundPrimitiveKind;
	pass: GroundRenderPass;
	systemUniforms: GroundSystemUniforms;
	userUniforms: GroundUserUniforms;
	createDefaultMaterial(): RawShaderMaterial;
}

/** Expert-level factory called exactly once for each required Ground pass. */
export type GroundMaterialFactory = (
	context: GroundRawShaderBuildContext,
) => RawShaderMaterial;

/** Required pass set for each stable primitive kind. */
export const GROUND_RENDER_PASSES = {
	surface: [ 'frontStencil', 'backStencil', 'color' ],
	decal: [ 'frontStencil', 'backStencil', 'color' ],
	polyline: [ 'polyline' ],
	arrow: [ 'arrow' ],
} as const satisfies Record<GroundPrimitiveKind, readonly GroundRenderPass[]>;
