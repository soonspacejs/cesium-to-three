// ============================================================
// types.ts
// Layer: Cesium-to-Three ground adapter shared contracts.
// Role: keep public primitive options and internal geometry/uniform shapes
//       out of the rendering implementation file.
// Dependencies: Three.js type declarations only.
// Consumed by: cesium-ground-adapter.ts and public ground entry points.
// ============================================================

import type {
	Matrix3,
	Matrix4,
	PerspectiveCamera,
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

export interface CesiumGroundPolygonOptions {
	points: LonLatPoint[];
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
	rotationDegrees: number;
	hole: boolean;
	holes?: LonLatPoint[][];
}

export interface CesiumGroundPolygonPrimitiveOptions extends CesiumGroundPolygonOptions {
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	fragmentCull?: boolean;
}

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

export type CesiumGroundPointShape = 'circle' | 'square';

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
	u_polygonBorderMode: { value: number };
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
	czm_log2FarDepthFromNearPlusOne: { value: number };
}
