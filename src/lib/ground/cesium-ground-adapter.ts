// ============================================================
// cesium-ground-adapter.ts
// Layer: compatibility facade for the Cesium-to-Three ground adapter.
// Role: keep the historical public surface while the rectangle / polygon
//       geometry pipeline is now Cesium-free. Internal sub-modules:
//         - validation.ts / depth.ts / classification.ts / materials.ts
//           (precision-critical, untouched by the refactor)
//         - terrain-heights.ts / terrain-log-depth.ts (precision-critical)
//         - primitives.ts (rewritten — calls native rectangle / polygon
//           builders instead of Cesium geometry)
//         - rectangle/* and polygon/* (native geometry submodules)
//         - math/* (native ECEF / ENU / RTE helpers)
// Dependencies: local ground adapter modules.
// Consumed by: src/lib/ground/index.ts and legacy src/cesium-three-ground.ts.
// ============================================================

export { validateCesiumGroundRenderer } from './validation';
export { CesiumGlobeDepth, createCesiumEllipsoidDepthMeshes } from './depth';
export { CesiumClassificationPrimitive } from './classification';
export { CesiumGroundRectanglePrimitive, CesiumGroundPolygonPrimitive } from './primitives';

// Rectangle helpers (formerly re-exported from geometry.ts).
export {
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromCenterSizeMeters,
	rectangleDegreesFromLonLatPoints,
	rectangleMeterSizeFromDegrees,
} from './rectangle/rectangle-helpers';

// WGS84 helpers (formerly re-exported from geometry.ts).
export {
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from './math/wgs84-helpers';

export {
	initializeApproximateTerrainHeights,
	isApproximateTerrainHeightsReady,
	getTerrainMinMaxHeightsForRectangle,
} from './terrain-heights';
export {
	applyCesiumLogDepthToMaterial,
	terrainLogDepthUniforms,
	updateTerrainLogDepthUniforms,
} from './terrain-log-depth';
