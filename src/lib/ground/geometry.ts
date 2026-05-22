// ============================================================
// geometry.ts
// Layer: Cesium-to-Three ground geometry RTE encoder.
// Role:  expose the Cesium-equivalent EncodedCartesian3.encode helper used by
//        the classification runtime when packing the camera position into
//        high / low Float32 components. Everything else that used to live
//        here (Cesium-bound rectangle / polygon helpers, planar extent
//        computation, debug grid) has been migrated into the native
//        `math/`, `rectangle/`, and `polygon/` submodules during the
//        Cesium-free refactor — this file is intentionally minimal so the
//        precision-critical import in classification.ts (encodeCesiumVector3)
//        still resolves unchanged.
// Dependencies: Three.js Vector3 only.
// Consumed by: classification.ts (precision path).
// ============================================================

import type { Vector3 } from 'three';

import type { EncodedScalar } from './types';

/**
 * Encodes one float using Cesium's EncodedCartesian3.encode algorithm.
 *
 * @param value 64-bit JavaScript number in model coordinates.
 * @returns The high and low parts consumed by czm_translateRelativeToEye.
 */
function encodeCesiumFloat( value: number ): EncodedScalar {
	let doubleHigh: number;

	if ( value >= 0.0 ) {
		doubleHigh = Math.floor( value / 65536.0 ) * 65536.0;
		return { high: doubleHigh, low: value - doubleHigh };
	}

	doubleHigh = Math.floor( - value / 65536.0 ) * 65536.0;
	return { high: - doubleHigh, low: value + doubleHigh };
}

/**
 * Encodes a Three vector with the same fixed-point split used by Cesium.
 *
 * Kept in this module so classification.ts can import it unchanged.
 *
 * @param source ECEF/model-coordinate vector.
 * @param high Output high vector.
 * @param low Output low vector.
 */
export function encodeCesiumVector3( source: Vector3, high: Vector3, low: Vector3 ): void {
	const x = encodeCesiumFloat( source.x );
	const y = encodeCesiumFloat( source.y );
	const z = encodeCesiumFloat( source.z );

	high.set( x.high, y.high, z.high );
	low.set( x.low, y.low, z.low );
}
