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

/**
 * 贴地线连线方式。'geodesic' = Vincenty 大地线（默认），'rhumb' = 恒向线，
 * 'none' = ECEF 弦（仅在调用方明确要求或极短段时用）。
 */
export type CesiumGroundArcType = 'none' | 'geodesic' | 'rhumb';

/**
 * 贴地线宽度模式。'screen' = 像素恒定（默认，缩放不消失），
 * 'world' = 米恒定（远处变细）。
 */
export type CesiumGroundLineWidthMode = 'screen' | 'world';

/**
 * 贴地线两端箭头放置模式。
 *   - 'none'  无箭头（默认）
 *   - 'left'  起点端（points[0]）画箭头
 *   - 'right' 终点端（points[N-1]）画箭头
 *   - 'both'  两端都画
 */
export type CesiumGroundArrowMode = 'none' | 'left' | 'right' | 'both';

/**
 * 箭头形态：实心三角 / 开口雪佛龙（V 形线条）。
 */
export type CesiumGroundArrowStyle = 'solid' | 'open';

/**
 * 贴地折线的 plot-spec 契约：lon/lat 点序 + 颜色 + 宽度 + 可见性。
 * 高级字段（loop / arcType / granularity / width mode / dash / 高度窗口）
 * 全部可选；resolvePublicLineOptions 填默认并严格校验。
 */
export interface CesiumGroundPolylineOptions {
	/** lon/lat 折点（度），≥ 2 个。 */
	points: LonLatPoint[];
	/** 线色（'#rrggbb' 或 css 颜色）。 */
	strokeColor: string;
	/** 不透明度 0..100（与其它图元一致的百分比口径）。 */
	strokeOpacity: number;
	/** 可见性。 */
	visible: boolean;
	/** 屏宽模式下的像素宽（默认 3）。 */
	widthPixels?: number;
	/** 是否闭合（默认 false；2 点强制 false）。 */
	loop?: boolean;
	/** 连线方式（默认 'geodesic'）。 */
	arcType?: CesiumGroundArcType;
	/**
	 * 加密距离阈值（**米**，默认 9999）。`interpolateSegment` 用
	 * `segments = ceil(surfaceDistance / granularity)` 计算每段中间点数；
	 * 默认 9999 m 对 km 级线段产生 5-10 个中间点，能保持平滑又不爆量。
	 *
	 * 字段名以 "Radians" 结尾是历史包袱（Cesium 同名 API），实际单位是米。
	 */
	granularityRadians?: number;
	/** 高度窗口下限（米，默认 -55000）。高级。 */
	minimumHeight?: number;
	/** 高度窗口上限（米，默认 +55000）。高级。 */
	maximumHeight?: number;
	/** 线宽模式（默认 'screen'）。 */
	widthMode?: CesiumGroundLineWidthMode;
	/** 世界宽模式下的米宽（widthMode==='world' 时使用，默认 5）。 */
	widthMeters?: number;
	/** 渲染顺序（默认 40，> polygon 的 30）。 */
	renderOrder?: number;
	/** 虚线：实线段长（米）。设置且 > 0 即启用虚线。 */
	dashLengthMeters?: number;
	/** 虚线：间隙长（米）。 */
	gapLengthMeters?: number;
	/**
	 * 调试：把盒子整体染红显示，跳过 terrain depth 重建 / 平面距离裁切。
	 * 用来定位「线段为什么不渲染」——盒子覆盖的屏幕区域就是 FS 实际被调用的
	 * 范围，盒子有但没线 → FS 平面距离/depth 裁切问题；盒子无 → 几何 / 视锥
	 * 问题。
	 */
	debugVolume?: boolean;
	/** 线端箭头：'none'/'left'/'right'/'both'。默认 'none'。 */
	arrowMode?: CesiumGroundArrowMode;
	/** 箭头形态：'solid' 实心三角 / 'open' 开口雪佛龙。默认 'solid'。 */
	arrowStyle?: CesiumGroundArrowStyle;
	/** 箭头沿线长（屏幕像素，默认 18）。 */
	arrowLengthPixels?: number;
	/** 箭头基底全宽（屏幕像素，默认 16）。 */
	arrowWidthPixels?: number;
	/** world 模式下箭头沿线长（米，默认 30）。 */
	arrowLengthMeters?: number;
	/** world 模式下箭头基底全宽（米，默认 24）。 */
	arrowWidthMeters?: number;
	/** 箭头色，默认跟随 strokeColor。 */
	arrowColor?: string;
	/** 箭头不透明度 0..100，默认跟随 strokeOpacity。 */
	arrowOpacity?: number;
	/** open 样式的斜边笔宽（屏幕像素，默认 3）。 */
	arrowStrokeWidthPixels?: number;
}

export interface CesiumGroundFrameState {
	depthTexture: WebGLRenderTarget['texture'];
	width: number;
	height: number;
	camera: PerspectiveCamera;
	/**
	 * 物理像素与 CSS 像素的比值，由宿主每帧填入（典型：renderer.getPixelRatio()）。
	 * 仅 CesiumGroundPolylinePrimitive 在意——`czm_metersPerPixel` 内部要乘它。
	 * 面图元不读，缺省 1.0（HiDPI 下线宽偏窄）。
	 */
	pixelRatio?: number;
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
	[ uniform: string ]: { value: unknown } | undefined;
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
	// ── 贴地线扩展（全部可选；面图元的 uniform map 不设这些键，
	//    classification.ts 守卫式写入跳过它们）。GLSL 端用
	//    `#ifdef CESIUM_THREE_POLYLINE` 守住声明，对 stencil/color 编译无影响。──
	czm_projection?: { value: Matrix4 };
	czm_pixelRatio?: { value: number };
	u_lineWidthPixels?: { value: number };
	u_lineWidthMode?: { value: number };
	u_lineWidthMeters?: { value: number };
	u_lineDashEnabled?: { value: number };
	u_lineDashLengthMeters?: { value: number };
	u_lineGapLengthMeters?: { value: number };
	u_lineTotalMeters?: { value: number };
	// ── 线端箭头扩展（仅在 polyline 材质 / 箭头材质里使用；其它材质
	//    prefix 不声明这些 uniform，写入 no-op，零回归）。──
	u_arrowWidthMode?: { value: number };
	u_arrowLengthPixels?: { value: number };
	u_arrowHalfWidthPixels?: { value: number };
	u_arrowLengthMeters?: { value: number };
	u_arrowHalfWidthMeters?: { value: number };
	u_arrowColor?: { value: Vector4 };
	u_arrowStrokeHalfPixels?: { value: number };
}
