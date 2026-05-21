// ============================================================
// terrain-log-depth.ts
// Layer: Cesium-to-Three terrain depth shim.
// Role: inject Cesium-compatible log-depth GLSL into Three.js MeshStandard
//       (or any onBeforeCompile-friendly) material, so the main framebuffer's
//       depth values are written in the same `log2((w - near) + 1) /
//       log2((far - near) + 1)` space the shadow-volume color command samples.
//       Without this shim, terrain depth (linear in NDC) and shadow-volume
//       depth (Cesium log depth) live in different spaces and the
//       LESS_OR_EQUAL stencil pass would mis-fire on every fragment.
// Dependencies: Three.js Material / Shader hooks.
// Consumed by: demo terrain wiring (tiles.ts) and any external host that
//       feeds non-Cesium depth into the ground classification pipeline.
// ============================================================

import { Vector3, type Material, type WebGLRenderer } from 'three';

interface ShaderLike {
	uniforms: Record<string, { value: unknown }>;
	vertexShader: string;
	fragmentShader: string;
}

type OnBeforeCompileFn = ( shader: ShaderLike, renderer: WebGLRenderer ) => void;

/**
 * Shared log-depth uniform references. Three.js materials reuse the same
 * `{value}` boxes by reference; updating these once per frame propagates to
 * every material that has been augmented via {@link applyCesiumLogDepthToMaterial}.
 */
export const terrainLogDepthUniforms = {
	czm_currentFrustum: { value: new Vector3( 1.0, 1.0, 0.0 ) },
	czm_farDepthFromNearPlusOne: { value: 1.0 },
	czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
};

/**
 * Refreshes the shared terrain log-depth uniforms for the active frustum.
 * Must be called once per frame, before the main scene render.
 *
 * @param near Camera near plane (meters).
 * @param far Camera far plane (meters).
 */
export function updateTerrainLogDepthUniforms( near: number, far: number ): void {
	terrainLogDepthUniforms.czm_currentFrustum.value.set( near, far, 0.0 );

	const farDepthFromNearPlusOne = ( far - near ) + 1.0;
	const log2FarDepthFromNearPlusOne = Math.log2( farDepthFromNearPlusOne );
	terrainLogDepthUniforms.czm_farDepthFromNearPlusOne.value = farDepthFromNearPlusOne;
	terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne.value =
		log2FarDepthFromNearPlusOne > 0.0 ? 1.0 / log2FarDepthFromNearPlusOne : 1.0;
}

const TERRAIN_VERTEX_DECLARATION = /* glsl */ `
varying float v_depthFromNearPlusOne;
uniform vec3 czm_currentFrustum;
`;

const TERRAIN_VERTEX_WRITE = /* glsl */ `
	v_depthFromNearPlusOne = ( gl_Position.w - czm_currentFrustum.x ) + 1.0;
	gl_Position.z = clamp( gl_Position.z / gl_Position.w, - 1.0, 1.0 ) * gl_Position.w;
`;

const TERRAIN_FRAGMENT_DECLARATION = /* glsl */ `
varying float v_depthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
`;

// Cesium-equivalent log-depth write, clamping near/far instead of discarding
// so terrain still rasterizes when it slightly oversteps the frustum due to
// log-depth precision rounding.
const TERRAIN_FRAGMENT_WRITE = /* glsl */ `
	{
		float czm_logDepth = v_depthFromNearPlusOne;
		if ( czm_logDepth <= 1.0 ) {
			gl_FragDepth = 0.0;
		} else if ( czm_logDepth > czm_farDepthFromNearPlusOne ) {
			gl_FragDepth = 1.0;
		} else {
			gl_FragDepth = log2( czm_logDepth ) * czm_oneOverLog2FarDepthFromNearPlusOne;
		}
	}
`;

interface CesiumLogDepthFlaggedMaterial extends Material {
	userData: {
		cesiumLogDepthApplied?: boolean;
		[ key: string ]: unknown;
	};
	onBeforeCompile?: OnBeforeCompileFn;
}

/**
 * Replaces the first occurrence of `pattern` in `source` and verifies that the
 * replacement actually happened. Throws when the source has drifted away from
 * Three.js stock chunks, so a silent layout regression is caught loudly
 * during development rather than producing broken depth values at runtime.
 *
 * @param source Original GLSL source.
 * @param pattern Match to replace (string or regex).
 * @param replacement Replacement payload.
 * @param context Context name used in the thrown error.
 * @returns Replaced source.
 */
function replaceOnce(
	source: string,
	pattern: string | RegExp,
	replacement: string,
	context: string,
): string {
	const next = source.replace( pattern, replacement );
	if ( next === source ) {
		throw new Error( `Cesium log-depth injection failed: ${ context } anchor not found.` );
	}
	return next;
}

/**
 * Injects Cesium log-depth output into a Three.js material's shader, chained
 * after any caller-supplied `onBeforeCompile`. Idempotent.
 *
 * @param material Three.js material to augment.
 */
export function applyCesiumLogDepthToMaterial( material: Material ): void {
	const flagged = material as CesiumLogDepthFlaggedMaterial;
	if ( flagged.userData?.cesiumLogDepthApplied === true ) {
		return;
	}
	if ( ! flagged.userData ) {
		flagged.userData = {};
	}
	flagged.userData.cesiumLogDepthApplied = true;

	const previousOnBeforeCompile = flagged.onBeforeCompile;

	flagged.onBeforeCompile = ( shader, renderer ) => {
		if ( typeof previousOnBeforeCompile === 'function' ) {
			previousOnBeforeCompile( shader, renderer );
		}

		shader.uniforms.czm_currentFrustum = terrainLogDepthUniforms.czm_currentFrustum;
		shader.uniforms.czm_farDepthFromNearPlusOne =
			terrainLogDepthUniforms.czm_farDepthFromNearPlusOne;
		shader.uniforms.czm_oneOverLog2FarDepthFromNearPlusOne =
			terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne;

		shader.vertexShader = replaceOnce(
			shader.vertexShader,
			'void main() {',
			`${ TERRAIN_VERTEX_DECLARATION }\nvoid main() {`,
			'vertex declaration',
		);
		shader.vertexShader = replaceOnce(
			shader.vertexShader,
			'#include <project_vertex>',
			`#include <project_vertex>\n${ TERRAIN_VERTEX_WRITE }`,
			'vertex log-depth write',
		);

		shader.fragmentShader = replaceOnce(
			shader.fragmentShader,
			'void main() {',
			`${ TERRAIN_FRAGMENT_DECLARATION }\nvoid main() {`,
			'fragment declaration',
		);
		shader.fragmentShader = shader.fragmentShader.replace(
			/\}\s*$/,
			`${ TERRAIN_FRAGMENT_WRITE }\n}`,
		);
	};

	// Force Three.js to recompile this material with the augmented shader.
	flagged.needsUpdate = true;
	// Cache key uniqueness: the modified shader text differs from stock, so
	// Three.js's WebGLPrograms cache must not merge us with non-log-depth
	// MeshStandardMaterial variants on the same defines.
	flagged.customProgramCacheKey = () => 'cesium-log-depth-v1';
}
