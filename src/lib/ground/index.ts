// ============================================================
// index.ts
// 层级:公开贴地适配器入口。
// 职责:统一导出 Cesium-to-Three 贴地 classification 图元。
// 依赖:cesium-ground-adapter.ts。
// 被消费:demo 与旧版 src/cesium-three-ground.ts 入口。
// ============================================================

export * from './cesium-ground-adapter';
export { CesiumGroundTextPrimitive } from './text';
export type {
	PlotTextOptions,
	PlotTextAlign,
	PlotTextVerticalAlign,
	PlotTextAnchorX,
	PlotTextAnchorY,
	PlotTextLayoutDirection,
	PlotTextBoxOverflow,
} from './text';
export {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	LINE_DEFAULT_GRANULARITY,
	LINE_DEFAULT_RENDER_ORDER,
	LINE_DEFAULT_WIDTH_PIXELS,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
} from './constants';
// 贴地分类目标枚举（贴地形 / 贴模型 / 二者）——值导出，业务可直接引用。
export { ClassificationType } from './types';
export type {
	CartesianLike,
	CesiumClassificationCommandVisibility,
	CesiumGeometryAttribute,
	CesiumGeometryResult,
	CesiumGroundArcType,
	CesiumGroundArrowMode,
	CesiumGroundArrowStyle,
	CesiumGroundCircleOptions,
	CesiumGroundCirclePrimitiveOptions,
	CesiumGroundFrameState,
	CesiumGroundLineWidthMode,
	CesiumGroundPointOptions,
	CesiumGroundImagePrimitiveOptions,
	CesiumGroundPointPrimitiveOptions,
	CesiumGroundPointShape,
	CesiumGroundPolygonOptions,
	CesiumGroundPolylineOptions,
	CesiumGroundRectangleOptions,
	CesiumGroundRectanglePrimitiveOptions,
	ClassificationDepthTextureSet,
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
