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
import type { LonLatPoint, RectangleDegrees } from './types';

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
 * **Suitable for the rectangle primitive only.** For polygons (including
 * arrows), prefer {@link getTerrainMinMaxHeightsForPolygon}: a polygon's
 * bbox can be wildly larger than its actual footprint, and the Cesium
 * tile-lookup algorithm falls back to a coarser tile (= much larger
 * geographic region, capturing far-away peaks) whenever the bbox straddles
 * a tile boundary. The per-vertex sampling variant avoids that fallback by
 * doing micro-bbox queries that always land inside a single max-depth tile.
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

/**
 * Micro-bbox half-side (degrees) used for per-vertex polygon sampling.
 *
 * Picked to be **much smaller than the deepest tile size** in the bundled
 * ApproximateTerrainHeights table (level 6 → 2.8125° per side). With this
 * half-side ≈ 5.6 cm at the equator, the 4 corners of a query rectangle
 * around any single sample point are guaranteed to share the same level-6
 * tile — so `getTileXYLevel` always returns the deepest (= smallest) tile
 * and we get the local-tile max instead of being forced back to a coarser
 * tile by an inadvertent boundary straddle.
 *
 * Why so small (instead of just "small"): the Cesium algorithm requires
 * **all four corners** of the query rectangle to be in the SAME tile.
 * If a sample point happens to sit right on a tile boundary, even a 1e-3°
 * half-side may straddle. A 5e-7° half-side leaves the corners virtually
 * coincident, guaranteeing single-tile residency for any sample.
 */
const POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES = 5e-7;

/**
 * Queries Cesium ApproximateTerrainHeights for the tile-aligned min/max
 * inside a polygon **without** the bbox-fallback problem that biases
 * `getTerrainMinMaxHeightsForRectangle` for elongated / curved shapes.
 *
 * **Why the bbox path is wrong for polygons**:
 *   Cesium's `ApproximateTerrainHeights.getMinimumMaximumHeights` calls
 *   `getTileXYLevel(rectangle)` which finds the **deepest level at which
 *   all four corners share one tile** and returns the tile min/max for
 *   that level. When the rectangle straddles a deep-level tile boundary
 *   the algorithm falls back to a shallower (= geographically larger)
 *   tile, and the returned max is the max over that **larger** region.
 *
 *   Demo case (Mt Everest, lat 27.988°): the level-5 lat boundary is
 *   exactly at 28.125°. A curved arrow whose vertices span lat
 *   28.10°..28.15° straddles that boundary → falls back to level 4
 *   (11.25° × 11.25°, ~ half the Tibetan Plateau) → returned max
 *   includes Everest 8848m, even though the arrow itself never touches
 *   that peak. The arrow's shadow volume then extrudes to ~9km altitude
 *   and gets clipped by the camera's far plane at typical zoom altitudes,
 *   producing the curved fill-cut artefact.
 *
 * **The fix**: sample at each polygon vertex with a **micro-bbox** so
 * the per-query rectangle is small enough to always sit inside a single
 * level-6 tile (the deepest level in the bundled table). Take the
 * element-wise min/max across all samples. The resulting max is bounded
 * by the level-6 tiles **actually touched by the polygon vertices**,
 * not by whichever shallow tile happens to enclose the polygon's
 * full bbox.
 *
 * **What this still misses**: a peak that lies between two vertices in a
 * level-6 tile *not touched* by any vertex. For typical plot polygons
 * (arrows ≤ ~50 vertices, max edge length << level-6 tile width of
 * 2.8125° ≈ 313 km) the vertex set densely covers every level-6 tile
 * the polygon enters, so this is not a concern in practice. If callers
 * later need stricter coverage they can pre-densify the polygon
 * (e.g. via Catmull-Rom subdivision) before passing it in.
 *
 * @param points Polygon ring vertices in WGS84 degrees (at least 1 vertex).
 * @returns Element-wise min / max across per-vertex samples, with the
 *          adapter's default range as a fallback when nothing was sampled
 *          or the heights table is not initialized yet.
 */
export function getTerrainMinMaxHeightsForPolygon(
	points: readonly LonLatPoint[],
): TerrainMinMaxHeights {
	if ( ! initialized || points.length === 0 ) {
		return {
			minimumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
			maximumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
		};
	}

	const halfSide = POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES;
	let minTerrainHeight = Number.POSITIVE_INFINITY;
	let maxTerrainHeight = Number.NEGATIVE_INFINITY;

	for ( let i = 0; i < points.length; i++ ) {
		const lon = points[ i ][ 0 ];
		const lat = points[ i ][ 1 ];

		// Build a micro-rectangle centred on the vertex. Each corner sits
		// 5e-7° away from the others — far less than any single level-6
		// tile width (2.8125°), so `getTileXYLevel` resolves at level 6
		// unless the vertex is literally on a level-6 tile boundary (in
		// which case the +ε/-ε offset disambiguates).
		const rectangle = Rectangle.fromDegrees(
			lon - halfSide,
			lat - halfSide,
			lon + halfSide,
			lat + halfSide,
			lookupRectangleScratch,
		);
		const result = ApproximateTerrainHeights.getMinimumMaximumHeights(
			rectangle,
			Ellipsoid.WGS84,
		) as TerrainMinMaxHeights;

		if ( Number.isFinite( result.minimumTerrainHeight ) ) {
			if ( result.minimumTerrainHeight < minTerrainHeight ) {
				minTerrainHeight = result.minimumTerrainHeight;
			}
		}
		if ( Number.isFinite( result.maximumTerrainHeight ) ) {
			if ( result.maximumTerrainHeight > maxTerrainHeight ) {
				maxTerrainHeight = result.maximumTerrainHeight;
			}
		}
	}

	if ( ! Number.isFinite( minTerrainHeight ) ) {
		minTerrainHeight = APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT;
	}
	if ( ! Number.isFinite( maxTerrainHeight ) ) {
		maxTerrainHeight = APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT;
	}

	return {
		minimumTerrainHeight: minTerrainHeight,
		maximumTerrainHeight: maxTerrainHeight,
	};
}
