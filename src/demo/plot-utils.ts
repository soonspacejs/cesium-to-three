// ============================================================
// plot-utils.ts
// Layer: demo plotting helpers.
// Role: build editable local ENU polygon control shapes and plot ordering.
// Dependencies: ground adapter shared GIS types.
// Consumed by: ground-demo.ts.
// ============================================================

import type { EastNorthOffsetMeters } from '../lib/ground';

const PLOT_RENDER_ORDER_STRIDE = 10;
const PLOT_RENDER_ORDER_BASE = 1000;

/**
 * Clamps a number to a closed interval.
 *
 * @param value Input value.
 * @param min Minimum accepted value.
 * @param max Maximum accepted value.
 * @returns Clamped finite value.
 */
export function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * Converts one degree value to radians.
 *
 * @param degrees Angle in degrees.
 * @returns Angle in radians.
 */
function degreesToRadians( degrees: number ): number {
	return degrees * Math.PI / 180.0;
}

/**
 * Builds local ENU offsets for a rotated polygon.
 *
 * The offsets are converted to WGS84 later, so Cesium still owns the actual
 * ground polygon triangulation and shadow-volume construction.
 *
 * @param widthMeters Width in local east-west meters.
 * @param heightMeters Height in local north-south meters.
 * @param vertexCount Number of polygon vertices.
 * @param rotationDegrees Counter-clockwise visual rotation in local ENU.
 * @param dentRatio Radius scale for every alternate vertex.
 * @returns Local east/north offsets in counter-clockwise order.
 */
export function createLocalPolygonOffsets(
	widthMeters: number,
	heightMeters: number,
	vertexCount: number,
	rotationDegrees: number,
	dentRatio: number,
): EastNorthOffsetMeters[] {
	const safeVertexCount = Math.round( clampNumber( vertexCount, 3, 64 ) );
	const halfWidthMeters = Math.max( widthMeters, 1.0 ) * 0.5;
	const halfHeightMeters = Math.max( heightMeters, 1.0 ) * 0.5;
	const safeDentRatio = clampNumber( dentRatio, 0.05, 1.0 );
	const rotationRadians = degreesToRadians( rotationDegrees );
	const cosRotation = Math.cos( rotationRadians );
	const sinRotation = Math.sin( rotationRadians );
	const offsets: EastNorthOffsetMeters[] = [];

	for ( let i = 0; i < safeVertexCount; i ++ ) {
		const angle = Math.PI * 0.5 + i * Math.PI * 2.0 / safeVertexCount;
		const radiusScale = i % 2 === 0 ? 1.0 : safeDentRatio;
		const localEast = Math.cos( angle ) * halfWidthMeters * radiusScale;
		const localNorth = Math.sin( angle ) * halfHeightMeters * radiusScale;
		offsets.push( {
			eastMeters: localEast * cosRotation - localNorth * sinRotation,
			northMeters: localEast * sinRotation + localNorth * cosRotation,
		} );
	}

	return offsets;
}

/**
 * Converts a user-facing plot layer to a contiguous Three renderOrder block.
 *
 * Plot order is a user-facing order inside the ground-classification layer.
 * The Three renderOrder still needs a positive base offset so order 0 never
 * collides with terrain/3D Tiles meshes, which normally render at order 0.
 *
 * @param plotOrder User-facing layer order.
 * @returns Base renderOrder for the primitive's front-stencil command.
 */
export function plotOrderToRenderOrder( plotOrder: number ): number {
	const safePlotOrder = Number.isFinite( plotOrder ) ? Math.max( Math.round( plotOrder ), 0 ) : 0;
	return PLOT_RENDER_ORDER_BASE + safePlotOrder * PLOT_RENDER_ORDER_STRIDE;
}
