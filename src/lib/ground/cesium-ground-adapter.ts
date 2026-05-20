// ============================================================
// cesium-ground-adapter.ts
// Layer: compatibility facade for the Cesium-to-Three ground adapter.
// Role: keep the historical module name while the implementation is split
//       into geometry, materials, depth, classification, and primitive files.
// Dependencies: local ground adapter modules.
// Consumed by: src/lib/ground/index.ts and legacy src/cesium-three-ground.ts.
// ============================================================

export { validateCesiumGroundRenderer } from './validation';
export { CesiumGlobeDepth, createCesiumEllipsoidDepthMeshes } from './depth';
export { CesiumClassificationPrimitive } from './classification';
export { CesiumGroundRectanglePrimitive, CesiumGroundPolygonPrimitive } from './primitives';
export {
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromCenterSizeMeters,
	rectangleDegreesFromLonLatPoints,
	rectangleMeterSizeFromDegrees,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from './geometry';
