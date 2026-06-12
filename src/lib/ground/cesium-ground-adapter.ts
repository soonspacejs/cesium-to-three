// ============================================================
// cesium-ground-adapter.ts
// 层级:Cesium-to-Three 贴地适配器兼容门面。
// 职责:在矩形 / 多边形几何管线迁移为无 Cesium 依赖实现后，保留历史公开接口。
//      内部子模块:
//        - validation.ts / depth.ts / classification.ts / materials.ts
//          是精度关键路径，重构时保持行为不变。
//        - terrain-heights.ts / terrain-log-depth.ts 是精度关键路径。
//        - primitives.ts 调用原生 rectangle / polygon / circle 构造器。
//        - rectangle/*、polygon/*、circle/* 是原生几何子模块。
//        - math/* 提供原生 ECEF / ENU / RTE 辅助函数。
// 依赖:本地 ground adapter 模块。
// 被消费:src/lib/ground/index.ts 与旧版 src/cesium-three-ground.ts。
// ============================================================

export { validateCesiumGroundRenderer } from './validation';
export { CesiumGlobeDepth, createCesiumEllipsoidDepthMeshes } from './depth';
export {
	EllipsoidDepthSource,
	computeEllipsoidLimbQuadPositions,
} from './ellipsoid-depth-source';
export type {
	EllipsoidDepthSourceOptions,
	EllipsoidDepthAttachTarget,
	EllipsoidRadii,
} from './ellipsoid-depth-source';
export { CesiumClassificationPrimitive } from './classification';
export {
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
	CesiumGroundRectanglePrimitive,
} from './primitives';

// 矩形辅助函数，历史上曾从 geometry.ts 重新导出。
export {
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromCenterSizeMeters,
	rectangleDegreesFromLonLatPoints,
	rectangleMeterSizeFromDegrees,
} from './rectangle/rectangle-helpers';

// WGS84 辅助函数，历史上曾从 geometry.ts 重新导出。
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
