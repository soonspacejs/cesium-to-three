// ============================================================
// index.ts
// Layer: public ground adapter entry point.
// Role: re-export Cesium-to-Three ground classification primitives.
// Dependencies: cesium-ground-adapter.ts.
// Consumed by: demos and legacy src/cesium-three-ground.ts entry point.
// ============================================================

export * from './cesium-ground-adapter';
export {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
} from './constants';
export type {
	CartesianLike,
	CesiumClassificationCommandVisibility,
	CesiumGeometryAttribute,
	CesiumGeometryResult,
	CesiumGroundCircleOptions,
	CesiumGroundCirclePrimitiveOptions,
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
