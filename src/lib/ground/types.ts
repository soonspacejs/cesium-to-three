// ============================================================
// types.ts
// 层级:Cesium-to-Three 贴地适配器共享契约。
// 职责:把公开图元选项与内部几何 / uniform 结构从渲染实现文件中拆出。
// 依赖:仅 Three.js 类型声明。
// 被消费:cesium-ground-adapter.ts 与公开 ground 入口。
// ============================================================

import type {
	Color,
	Matrix3,
	Matrix4,
	PerspectiveCamera,
	Texture,
	Vector2,
	Vector3,
	Vector4,
	WebGLRenderTarget,
} from 'three';

export interface EncodedScalar {
	high: number;
	low: number;
}

export interface CesiumGeometryAttribute {
	values: ArrayLike<number>;
	componentsPerAttribute: number;
}

export interface CartesianLike {
	x: number;
	y: number;
	z: number;
}

export interface CesiumGeometryResult {
	attributes: Record<string, CesiumGeometryAttribute>;
	indices?: Uint8Array | Uint16Array | Uint32Array | number[];
}

export interface RectangleDegrees {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface RectangleMeterSize {
	widthMeters: number;
	heightMeters: number;
}

export type LonLatPoint = [ number, number ];

export interface LongitudeLatitude {
	longitude: number;
	latitude: number;
}

export interface EastNorthOffsetMeters {
	eastMeters: number;
	northMeters: number;
}

export interface PolygonHierarchyDegrees {
	positions: LongitudeLatitude[];
	holes?: PolygonHierarchyDegrees[];
}

export interface RectangleRadians {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface CesiumGroundRectangleOptions {
	points: LonLatPoint[];
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
}

export interface CesiumGroundRectanglePrimitiveOptions extends CesiumGroundRectangleOptions {
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	debugSurface?: boolean;
	debugSurfaceHeight?: number;
	debugSurfaceOpacity?: number;
	fragmentCull?: boolean;
}

/**
 * 公开 polygon 选项，语义与矩形 plot-spec 契约保持一致:
 * lon/lat 点环、描边 / 填充、可见性、可选洞环和可选平面内旋转。
 * 旧适配器的 `polygonHierarchyDegrees` 形式也继续接受；构造器会按实际字段分支，
 * 保证既有调用方仍可工作。
 */
export interface CesiumGroundPolygonOptions {
	points?: LonLatPoint[];
	holes?: LonLatPoint[][];
	hole?: boolean;
	rotationDegrees?: number;
	strokeColor?: string;
	strokeWidth?: number;
	strokeOpacity?: number;
	fillColor?: string;
	fillOpacity?: number;
	visible?: boolean;
	polygonHierarchyDegrees?: PolygonHierarchyDegrees;
	color?: Color | string | number;
	alpha?: number;
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	fragmentCull?: boolean;
}

/**
 * 贴地圆形的 plot-spec 契约:中心 lon/lat、半径(米)、描边 / 填充样式、
 * 可选环线 / 扇区装饰、可选平面内纹理旋转、可选 shadow-volume 高度窗口。
 * 字段形状与参考项目的 `CesiumGroundCircleOptions` 保持一致，方便复用同名 JSON。
 */
export interface CesiumGroundCircleOptions {
	center: LonLatPoint;
	radius: number;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
}

export interface CesiumGroundCirclePrimitiveOptions extends CesiumGroundCircleOptions {
	height?: number;
	extrudedHeight?: number;
	granularityRadians?: number;
	stRotationRadians?: number;
	ringCount?: number;
	ringGapMeters?: number;
	sectorStartDegrees?: number;
	sectorAngleDegrees?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	fragmentCull?: boolean;
}

/**
 * 点标绘的形状类型。圆形走圆形渲染管线（CesiumGroundCirclePrimitive），
 * 正方形走矩形渲染管线（CesiumGroundRectanglePrimitive）。
 */
export type CesiumGroundPointShape = 'circle' | 'square';

/**
 * 贴地点标绘的 plot-spec 契约：单个 lon/lat 锚点 + 形状 + 米尺寸 +
 * 描边/填充/可见性。size 在 circle 时解释为直径，square 时解释为边长。
 */
export interface CesiumGroundPointOptions {
	position: LonLatPoint;
	shape: CesiumGroundPointShape;
	size: number;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
}

export interface CesiumGroundPointPrimitiveOptions extends CesiumGroundPointOptions {
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	fragmentCull?: boolean;
}

export interface CesiumClassificationCommandVisibility {
	frontStencil?: boolean;
	backStencil?: boolean;
	color?: boolean;
}

export interface CesiumGroundFrameState {
	depthTexture: WebGLRenderTarget['texture'];
	width: number;
	height: number;
	camera: PerspectiveCamera;
}

export interface CesiumLogDepthParameters {
	near: number;
	far: number;
	farDepthFromNearPlusOne: number;
	log2FarDepthFromNearPlusOne: number;
	oneOverLog2FarDepthFromNearPlusOne: number;
}

export interface PlanarExtents {
	southWestHigh: Vector3;
	southWestLow: Vector3;
	eastward: Vector3;
	northward: Vector3;
	uvMinAndExtents: Vector4;
	uMaxVmax: Vector4;
	innerMetersRect: Vector4;
}

export interface PlanarBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export interface SharedUniforms {
	[ uniform: string ]: { value: unknown };
	czm_encodedCameraPositionMCHigh: { value: Vector3 };
	czm_encodedCameraPositionMCLow: { value: Vector3 };
	czm_modelViewRelativeToEye: { value: Matrix4 };
	czm_modelViewProjectionRelativeToEye: { value: Matrix4 };
	czm_normal: { value: Matrix3 };
	czm_geometricToleranceOverMeter: { value: number };
	czm_sceneMode: { value: number };
	u_globeMinimumAltitude: { value: number };
	u_southWest_HIGH: { value: Vector3 };
	u_southWest_LOW: { value: Vector3 };
	u_eastward: { value: Vector3 };
	u_northward: { value: Vector3 };
	u_uvMinAndExtents: { value: Vector4 };
	u_uMaxVmax: { value: Vector4 };
	u_color: { value: Vector4 };
	u_borderColor: { value: Vector4 };
	u_borderEnabled: { value: number };
	u_borderWidthMeters: { value: number };
	u_innerMetersRect: { value: Vector4 };
	u_cpuWestPlane: { value: Vector4 };
	u_cpuSouthPlane: { value: Vector4 };
	u_polygonBorderMode: { value: number };
	u_polygonMiterStrokeMode: { value: number };
	u_polygonPointCount: { value: number };
	u_polygonPoints: { value: Vector2[] };
	u_circleBorderMode: { value: number };
	u_circleCenterMeters: { value: Vector2 };
	u_circleFillRadiusMeters: { value: number };
	u_circleRenderRadiusMeters: { value: number };
	u_circleRingCount: { value: number };
	u_circleRingGapMeters: { value: number };
	u_circleSectorStartRadians: { value: number };
	u_circleSectorAngleRadians: { value: number };
	czm_globeDepthTexture: { value: WebGLRenderTarget['texture'] | null };
	czm_viewport: { value: Vector4 };
	czm_inverseProjection: { value: Matrix4 };
	czm_viewportTransformation: { value: Matrix4 };
	czm_frustumPlanes: { value: Vector4 };
	czm_currentFrustum: { value: Vector3 };
	czm_farDepthFromNearPlusOne: { value: number };
	czm_log2FarDepthFromNearPlusOne: { value: number };
	czm_oneOverLog2FarDepthFromNearPlusOne: { value: number };
	/**
	 * 贴地文本内容纹理。CesiumGroundTextPrimitive 经 classification 的
	 * extraUniforms 注入真实纹理；其它图元保持 `{ value: null }`。GLSL 端用
	 * `#ifdef CESIUM_THREE_TEXT` 守住声明，不污染其它材质编译。
	 */
	u_textTexture: { value: Texture | null };
}
