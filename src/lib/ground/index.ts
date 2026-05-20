// ============================================================
// index.ts
// Layer: public ground adapter entry point.
// Role: re-export Cesium-to-Three ground classification primitives.
// Dependencies: cesium-ground-adapter.ts.
// Consumed by: demos and legacy src/cesium-three-ground.ts entry point.
// ============================================================

export * from './cesium-ground-adapter';
export type {
	CartesianLike,
	CesiumClassificationCommandVisibility,
	CesiumGeometryAttribute,
	CesiumGeometryResult,
	CesiumGroundFrameState,
	CesiumGroundPolygonOptions,
	CesiumGroundRectangleOptions,
	CesiumGroundRectanglePrimitiveOptions,
	EastNorthOffsetMeters,
	EncodedScalar,
	LonLatPoint,
	LongitudeLatitude,
	PlanarBounds,
	PlanarExtents,
	PolygonHierarchyDegrees,
	RectangleDegrees,
	RectangleMeterSize,
	RectangleRadians,
	SharedUniforms,
} from './types';
