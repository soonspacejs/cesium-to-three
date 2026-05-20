// ============================================================
// validation.ts
// Layer: Cesium-to-Three ground runtime validation.
// Role: check the WebGL capabilities required by Cesium ground classification.
// Dependencies: Three.js renderer capabilities.
// Consumed by: public ground adapter and demos.
// ============================================================

import type { WebGLRenderer } from 'three';

/**
 * Checks the WebGL features Cesium classification needs.
 *
 * @param renderer Active Three WebGL renderer.
 */
export function validateCesiumGroundRenderer( renderer: WebGLRenderer ): void {
	const gl = renderer.getContext();

	if ( ! renderer.capabilities.isWebGL2 ) {
		throw new Error( 'Cesium ground classification requires WebGL2 in this Three adapter.' );
	}

	if ( gl.getParameter( gl.STENCIL_BITS ) < 8 ) {
		throw new Error( 'Cesium ground classification requires an 8-bit stencil buffer.' );
	}
}
