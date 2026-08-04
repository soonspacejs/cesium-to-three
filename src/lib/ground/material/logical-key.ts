// ============================================================
// material/logical-key.ts
// Purpose: deterministic, collision-free logical Material structure identity.
// This payload decides whether source/schema bindings are equivalent; it is not
// a hash and does not replace Three's own WebGLProgram cache key.
// ============================================================

import type { CesiumGroundMaterial } from './CesiumGroundMaterial';
import { canonicalizeGroundDefines } from './validation';

/** Bump only when the canonical payload layout or semantics change. */
export const C23_LOGICAL_MATERIAL_KEY_VERSION = 1 as const;

interface LogicalMaterialKeySource {
	vertexShader?: CesiumGroundMaterial['vertexShader'];
	fragmentShader: CesiumGroundMaterial['fragmentShader'];
	defines: CesiumGroundMaterial['defines'];
	uniforms: CesiumGroundMaterial['uniforms'];
}

/** Returns the sorted, value-independent user-uniform schema identity. */
export function getGroundUniformSchemaNames(
	material: Pick<LogicalMaterialKeySource, 'uniforms'>,
): readonly string[] {
	return Object.keys( material.uniforms ).sort();
}

/**
 * Serializes exact structural inputs without a short hash. JSON arrays avoid
 * object-key ordering ambiguity; define/schema names are already sorted.
 */
export function computeLogicalMaterialKey(
	material: LogicalMaterialKeySource,
): string {
	return JSON.stringify( [
		'c23-ground-logical-material',
		C23_LOGICAL_MATERIAL_KEY_VERSION,
		material.vertexShader ?? null,
		material.fragmentShader,
		canonicalizeGroundDefines( material.defines ),
		getGroundUniformSchemaNames( material ),
	] );
}
