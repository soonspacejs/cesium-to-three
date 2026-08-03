// ============================================================
// material/ground-system-shaders.ts
// Purpose: trusted, pass-specific GLSL sections consumed by the explicit
//          assembler. These sections own geometry, depth reconstruction,
//          membership, and coverage; safe user source only owns appearance.
// ============================================================

import { SCENE_MODE_3D } from '../constants';
import {
	assembleGroundFragmentShader,
	assembleGroundVertexShader,
} from './shader-assembler';
import type { GroundPrimitiveKind, GroundRenderPass } from './types';

/** Complete source pair ready for a Three GLSL3 RawShaderMaterial. */
export interface GroundShaderSourcePair {
	readonly vertexShader: string;
	readonly fragmentShader: string;
}

/**
 * Canonical frame and shadow-volume uniforms used by both classification
 * stencil halves. Values are provided through wrapper aliases; no legacy u_*
 * identifier is exposed in this source.
 */
const CLASSIFICATION_STENCIL_VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_modelViewProjectionRelativeToEye;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;
uniform vec3 czm_currentFrustum;
uniform float c23_globeMinimumAltitude;
`;

/** The v1 surface/decal geometry layout is identical for all three passes. */
const CLASSIFICATION_ATTRIBUTES = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
in vec3 extrudeDirection;
`;

/** Log-depth value interpolated after the final clip-space position is known. */
const CLASSIFICATION_STENCIL_VERTEX_VARYINGS = /* glsl */ `
out float c23_depthFromNearPlusOne;
`;

/**
 * Cesium-style relative-to-eye reconstruction and vertex log-depth clamp.
 * Subtracting encoded camera parts before summation preserves low bits at ECEF
 * magnitudes where a direct high+low reconstruction would visibly jitter.
 */
const CLASSIFICATION_STENCIL_VERTEX_HELPERS = /* glsl */ `
vec4 c23_translateRelativeToEye(vec3 high, vec3 low) {
	vec3 highDifference = high - czm_encodedCameraPositionMCHigh;
	vec3 lowDifference = low - czm_encodedCameraPositionMCLow;
	return vec4(highDifference + lowDifference, 1.0);
}

void c23_writeVertexLogDepth() {
	c23_depthFromNearPlusOne = (gl_Position.w - czm_currentFrustum.x) + 1.0;
	gl_Position.z = clamp(gl_Position.z / gl_Position.w, -1.0, 1.0) * gl_Position.w;
}
`;

/**
 * Produces the same shadow-volume extrusion used by both stencil halves. The
 * top layer carries a zero direction; bottom/wall vertices move toward the
 * conservative globe floor only in 3D scene mode.
 */
const CLASSIFICATION_STENCIL_VERTEX_MAIN = /* glsl */ `
void main() {
	vec4 positionRte = c23_translateRelativeToEye(position3DHigh, position3DLow);
	float extrusionDelta = min(
		c23_globeMinimumAltitude,
		czm_geometricToleranceOverMeter * length(positionRte.xyz)
	);
	extrusionDelta *= czm_sceneMode == ${ SCENE_MODE_3D.toFixed( 1 ) } ? 1.0 : 0.0;
	positionRte.xyz += extrudeDirection * extrusionDelta;

	// Keep the ABI-prescribed batch attribute live without changing the single-instance result.
	positionRte.w += batchId * 0.0;
	gl_Position = czm_modelViewProjectionRelativeToEye * positionRte;
	c23_writeVertexLogDepth();
}
`;

const CLASSIFICATION_STENCIL_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
`;

const CLASSIFICATION_STENCIL_FRAGMENT_VARYINGS = /* glsl */ `
in float c23_depthFromNearPlusOne;
`;

/**
 * Unlike classification color cleanup, stencil depth must discard values
 * outside the current frustum. Clamping those fragments would create false
 * increment/decrement contributions in the Z-fail count.
 */
const CLASSIFICATION_STENCIL_FRAGMENT_HELPERS = /* glsl */ `
void c23_writeStencilLogDepth(float depthFromNearPlusOne) {
	if (
		depthFromNearPlusOne <= 0.9999999 ||
		depthFromNearPlusOne > czm_farDepthFromNearPlusOne
	) {
		discard;
	}
	gl_FragDepth = log2(depthFromNearPlusOne) * czm_oneOverLog2FarDepthFromNearPlusOne;
}
`;

const CLASSIFICATION_STENCIL_FRAGMENT_MAIN = /* glsl */ `
void main() {
	// Color writes are disabled by render state, but a defined output keeps the
	// GLSL3 fragment interface complete on strict WebGL2 drivers.
	out_FragColor = vec4(1.0);
	c23_writeStencilLogDepth(c23_depthFromNearPlusOne);
}
`;

/**
 * Builds one fixed surface/decal stencil half. Front and back share identical
 * GLSL and differ only in side/stencil render state owned by the compiler.
 */
export function createGroundClassificationStencilShaders(
	kind: Extract<GroundPrimitiveKind, 'surface' | 'decal'>,
	pass: Extract<GroundRenderPass, 'frontStencil' | 'backStencil'>,
): GroundShaderSourcePair {
	return Object.freeze( {
		vertexShader: assembleGroundVertexShader( {
			kind,
			pass,
			sections: {
				declarations: CLASSIFICATION_STENCIL_VERTEX_DECLARATIONS,
				attributes: CLASSIFICATION_ATTRIBUTES,
				varyings: CLASSIFICATION_STENCIL_VERTEX_VARYINGS,
				helpers: CLASSIFICATION_STENCIL_VERTEX_HELPERS,
				main: CLASSIFICATION_STENCIL_VERTEX_MAIN,
			},
		} ),
		fragmentShader: assembleGroundFragmentShader( {
			mode: 'stencil',
			kind,
			pass,
			sections: {
				declarations: CLASSIFICATION_STENCIL_FRAGMENT_DECLARATIONS,
				varyings: CLASSIFICATION_STENCIL_FRAGMENT_VARYINGS,
				helpers: CLASSIFICATION_STENCIL_FRAGMENT_HELPERS,
				main: CLASSIFICATION_STENCIL_FRAGMENT_MAIN,
			},
		} ),
	} );
}
