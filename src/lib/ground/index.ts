// ============================================================
// index.ts
// 层级:公开贴地适配器入口。
// 职责:统一导出 Cesium-to-Three 贴地 classification 图元。
// 依赖:cesium-ground-adapter.ts。
// 被消费:demo 与旧版 src/cesium-three-ground.ts 入口。
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
