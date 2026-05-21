// ============================================================
// terrain-heights.ts
// Layer: Cesium-to-Three ground adapter terrain height initialization.
// Role: bootstrap Cesium ApproximateTerrainHeights by injecting the bundled
//       approximateTerrainHeights.json so GroundPrimitive-style geometry can
//       query a tile-accurate min/max for shadow-volume construction without
//       performing a runtime fetch.
// Dependencies: unmodified Cesium ApproximateTerrainHeights + bundled JSON.
// Consumed by: primitives.ts and the public ground adapter entry point.
// ============================================================

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import ApproximateTerrainHeights from '../../../cesium-ground-source/engine/Source/Core/ApproximateTerrainHeights.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Rectangle from '../../../cesium-ground-source/engine/Source/Core/Rectangle.js';
import approximateTerrainHeightsJson from '../../../cesium-ground-source/engine/Source/Assets/approximateTerrainHeights.json';

import {
	APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
} from './constants';
import type { RectangleDegrees } from './types';

/**
 * Synchronous min/max height pair returned by the adapter.
 */
export interface TerrainMinMaxHeights {
	minimumTerrainHeight: number;
	maximumTerrainHeight: number;
}

let initialized = false;

/**
 * Injects the bundled approximateTerrainHeights.json into Cesium
 * ApproximateTerrainHeights without triggering its async Resource.fetchJson
 * path. Idempotent: safe to call from multiple entry points.
 */
export function initializeApproximateTerrainHeights(): void {
	if ( initialized ) {
		return;
	}

	ApproximateTerrainHeights._terrainHeights = approximateTerrainHeightsJson;
	// Match the resolved promise contract so any caller that defensively waits
	// on initialize() still gets a settled promise instead of dispatching a
	// network request through buildModuleUrl / Resource.
	ApproximateTerrainHeights._initPromise = Promise.resolve();
	initialized = true;
}

/**
 * Reports whether the adapter has injected the terrain-height table yet.
 */
export function isApproximateTerrainHeightsReady(): boolean {
	return initialized;
}

const lookupRectangleScratch = new Rectangle();

/**
 * Queries Cesium ApproximateTerrainHeights for the tile-aligned min/max in a
 * geographic rectangle. Returns the Cesium default range if the heights have
 * not been initialized yet, so callers always receive a usable shadow-volume
 * window rather than throwing.
 *
 * @param rectangleDegrees Plot rectangle in WGS84 degrees.
 * @returns Minimum and maximum terrain height in meters.
 */
export function getTerrainMinMaxHeightsForRectangle(
	rectangleDegrees: RectangleDegrees,
): TerrainMinMaxHeights {
	if ( ! initialized ) {
		return {
			minimumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
			maximumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
		};
	}

	const rectangle = Rectangle.fromDegrees(
		rectangleDegrees.west,
		rectangleDegrees.south,
		rectangleDegrees.east,
		rectangleDegrees.north,
		lookupRectangleScratch,
	);

	const result = ApproximateTerrainHeights.getMinimumMaximumHeights(
		rectangle,
		Ellipsoid.WGS84,
	) as TerrainMinMaxHeights;

	return {
		minimumTerrainHeight: Number.isFinite( result.minimumTerrainHeight )
			? result.minimumTerrainHeight
			: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
		maximumTerrainHeight: Number.isFinite( result.maximumTerrainHeight )
			? result.maximumTerrainHeight
			: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	};
}
