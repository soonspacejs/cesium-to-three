// ============================================================
// cesium-ground-adapter.ts
// Layer: compatibility facade for the Cesium-to-Three ground adapter.
// Role: keep the historical module name while the implementation is split
//       into validation / depth / classification / primitive / rectangle / polygon
//       / math 子模块。本期(polygon 抽离)完成后,`./geometry.ts` 被删除,
//       此处的 6 个 rectangle / wgs84 helper 直接从底层 rectangle/* 与 math/*
//       重导出,语义不变。
// Dependencies: local ground adapter modules(rectangle/* 与 math/*)。
// Consumed by: src/lib/ground/index.ts and legacy src/cesium-three-ground.ts.
// ============================================================

export { validateCesiumGroundRenderer } from './validation';
export { CesiumGlobeDepth, createCesiumEllipsoidDepthMeshes } from './depth';
export { CesiumClassificationPrimitive } from './classification';
export { CesiumGroundRectanglePrimitive, CesiumGroundPolygonPrimitive } from './primitives';

// 矩形相关 lon/lat 度坐标 helper(从 geometry.ts 迁出到 rectangle-helpers.ts;
// 历史 caller 仍能从 cesium-ground-adapter 拿到,公开 API 与重构前一致)。
export {
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromCenterSizeMeters,
	rectangleDegreesFromLonLatPoints,
	rectangleMeterSizeFromDegrees,
} from './rectangle/rectangle-helpers';

// WGS84 (lon°, lat°) → ECEF / 单位法向 helper(从 math/wgs84-helpers 重导出)。
export {
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from './math/wgs84-helpers';
