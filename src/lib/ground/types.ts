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
import type { CesiumGroundAppearance } from './material/appearances';

// ── 贴地分类目标（标绘"贴什么表面"）─────────────────────────────────
// 数值与 Cesium `Source/Scene/ClassificationType.js` 逐值对齐，便于业务层在
// Cesium / cesium-to-three 间迁移时直接复用同一常量含义。
//
// 在 Cesium 中，三种类型对应不同的渲染 Pass 与深度比对来源：
//   - TERRAIN：只在 globe（地形）深度上分类——标绘贴到地形表面，即便地形上方
//     有 3D Tiles 模型（楼房 / 倾斜摄影）遮挡，标绘仍贴在模型【下方】的地面。
//   - CESIUM_3D_TILE：只在 3D Tiles 模型表面分类——标绘贴到模型（楼顶 / 立面 /
//     倾斜摄影网格）上；没有模型覆盖的像素不着色（被掩掉）。
//   - BOTH：地形与模型都分类——标绘贴到二者中【离相机更近】的那个表面，
//     即"有模型贴模型、无模型贴地形"。
//
// cesium-to-three 的实现差异（见 classification-depth.ts 文件头详注）：
//   Cesium 用"globe 深度纹理 + 帧缓冲深度 + 3D-Tile stencil 位掩码"区分三类；
//   本移植把贴地深度统一打包成 packed RGBA 纹理，因此改为"按分类目标渲染至多
//   三张 packed 深度纹理"（terrain / tileset / both），标绘按自身 classificationType
//   采样对应纹理。CESIUM_3D_TILE 的"无模型处掩掉"由 tileset 纹理在无模型像素
//   留下清屏哨兵值（depth==0）+ 既有 CULL_FRAGMENTS 分支天然达成，无需 stencil 位。
export enum ClassificationType {
	/** 仅地形参与分类（贴到地形表面，忽略其上的 3D Tiles 模型）。 */
	TERRAIN = 0,
	/** 仅 3D Tiles 模型参与分类（贴到模型表面，无模型处不着色）。 */
	CESIUM_3D_TILE = 1,
	/** 地形与 3D Tiles 模型都参与分类（贴到二者中离相机更近的表面）。 */
	BOTH = 2,
}

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
	/** Optional safe Material Appearance; omitted uses the legacy-equivalent Color preset. */
	appearance?: CesiumGroundAppearance;
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	debugSurface?: boolean;
	debugSurfaceHeight?: number;
	debugSurfaceOpacity?: number;
	/**
	 * 贴地分类目标（贴地形 / 贴模型 / 二者）。默认 BOTH。
	 * 仅当宿主通过 frameState.classificationDepthTextures 提供多纹理时生效；
	 * 否则回退到 frameState.depthTexture 单纹理（行为与历史一致）。
	 */
	classificationType?: ClassificationType;
	fragmentCull?: boolean;
}

/**
 * 公开 polygon 选项，语义与矩形 plot-spec 契约保持一致:
 * lon/lat 点环、描边 / 填充、可见性、可选洞环和可选平面内旋转。
 * 旧适配器的 `polygonHierarchyDegrees` 形式也继续接受；构造器会按实际字段分支，
 * 保证既有调用方仍可工作。
 */
export interface CesiumGroundPolygonOptions {
	/** Optional safe Material Appearance; Raw is validated when the primitive is built. */
	appearance?: CesiumGroundAppearance;
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
	/**
	 * 贴地分类目标（贴地形 / 贴模型 / 二者）。默认 BOTH。
	 * 仅当宿主通过 frameState.classificationDepthTextures 提供多纹理时生效；
	 * 否则回退到 frameState.depthTexture 单纹理（行为与历史一致）。
	 */
	classificationType?: ClassificationType;
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
	/** Optional safe Material Appearance; omitted uses the internal Color preset. */
	appearance?: CesiumGroundAppearance;
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
	/**
	 * 贴地分类目标（贴地形 / 贴模型 / 二者）。默认 BOTH。
	 * 仅当宿主通过 frameState.classificationDepthTextures 提供多纹理时生效；
	 * 否则回退到 frameState.depthTexture 单纹理（行为与历史一致）。
	 */
	classificationType?: ClassificationType;
	fragmentCull?: boolean;
}

/**
 * 点标绘形状。圆形由 CesiumGroundCirclePrimitive 渲染，正方形由
 * CesiumGroundRectanglePrimitive 渲染，图片由 CesiumGroundImagePrimitive
 * 使用透明纹理贴花管线渲染。
 */
export type CesiumGroundPointShape = 'circle' | 'square' | 'image';

/**
 * 贴地点标绘契约：单个 lon/lat 中心锚点 + 形状 + 米制尺寸 + 样式与可见性。
 * circle/square 使用 size；image 使用 imageWidth/imageHeight。
 */
interface CesiumGroundPointCommonOptions {
	position: LonLatPoint;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
}

export type CesiumGroundPointOptions = CesiumGroundPointCommonOptions & (
	| {
		shape: 'circle' | 'square';
		size: number;
	}
	| {
		shape: 'image';
		imageUrl: string;
		imageWidth: number;
		imageHeight: number;
		/** 俯视顺时针角度；0 表示图片顶部朝北。 */
		rotation?: number;
	}
);

/**
 * 图片点底层图元选项。position 固定为图片中心，显式米制宽高决定 ENU 足迹；
 * stroke/fillColor 字段为公共点契约兼容字段，图片着色只使用原始纹理 alpha 与
 * fillOpacity，不绘制背景或描边。
 */
export type CesiumGroundImagePrimitiveOptions = CesiumGroundPointCommonOptions & {
	imageUrl: string;
	imageWidth: number;
	imageHeight: number;
	/** 俯视顺时针角度；0 表示图片顶部朝北。 */
	rotation?: number;
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	classificationType?: ClassificationType;
	fragmentCull?: boolean;
};

export type CesiumGroundPointPrimitiveOptions = CesiumGroundPointOptions & {
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	/**
	 * 贴地分类目标（贴地形 / 贴模型 / 二者）。默认 BOTH。
	 * 仅当宿主通过 frameState.classificationDepthTextures 提供多纹理时生效；
	 * 否则回退到 frameState.depthTexture 单纹理（行为与历史一致）。
	 */
	classificationType?: ClassificationType;
	fragmentCull?: boolean;
};

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
 *
 * **箭头样式的单一事实源**：内部 `ArrowStyle`（line-arrowhead.ts）直接别名到此处，
 * `ARROW_STYLE_ID` 以 `Record<ArrowStyle, number>` 绑定数值 id，`parseArrowStyle`
 * 按 `ARROW_STYLE_ID` 成员判定放行——在此联合加一个字面量即自动贯通到三者
 * （再配一条 id + 一个 GLSL define + 一个 FS 分支，详见 ARROW_STYLE_ID 的步骤注释）。
 */
export type CesiumGroundArrowStyle = 'solid' | 'open';

/**
 * 贴地折线的 plot-spec 契约：lon/lat 点序 + 颜色 + 宽度 + 可见性。
 * 高级字段（loop / arcType / granularity / width mode / dash / 高度窗口）
 * 全部可选；resolvePublicLineOptions 填默认并严格校验。
 */
export interface CesiumGroundPolylineOptions {
	/**
	 * Optional appearance for the line body. The selected Appearance owns only
	 * the single `polyline` color pass; system depth reconstruction, width,
	 * horizon/sky clipping, and arrow endpoint closure remain library-owned.
	 * Omitting this field creates the internal Color Material equivalent to the
	 * historical strokeColor/strokeOpacity path.
	 */
	appearance?: CesiumGroundAppearance;
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
	/**
	 * 箭头形态：'solid' 实心三角 / 'open' 开口雪佛龙。默认 'solid'。
	 * 作为两端的统一默认值；要让两端样式不同，用 `startArrowStyle` /
	 * `endArrowStyle` 分别覆盖（未设的那端回退到本字段）。
	 */
	arrowStyle?: CesiumGroundArrowStyle;
	/** 起点端（points[0]）箭头样式；缺省回退到 `arrowStyle`。 */
	startArrowStyle?: CesiumGroundArrowStyle;
	/** 终点端（points[N-1]）箭头样式；缺省回退到 `arrowStyle`。 */
	endArrowStyle?: CesiumGroundArrowStyle;
	/**
	 * 箭头尺寸模式（默认 'world'，与线 / 面世界模式视觉一致——远小近大）。
	 * 对应 Cesium `Billboard.sizeInMeters` 语义：
	 *   - 'world'  = 世界米恒定，远小近大随相机透视（默认，用 `arrowLengthMeters`
	 *     / `arrowWidthMeters`，shader 直接当米用）。
	 *   - 'screen' = 屏幕像素恒定，不随相机远近变化（用 `arrowLengthPixels` /
	 *     `arrowWidthPixels`，shader 端 `pixels × czm_metersPerPixel(P)` 转成米；
	 *     与 Cesium Billboard `sizeInMeters=false` 同义）。
	 * 与 `widthMode` 独立——通常 `screen` 配 `screen` / `world` 配 `world` 视觉
	 * 一致，但混搭也合法（例：线在 world 模式按米渲、箭头在 screen 模式恒定像素，
	 * 类似 Cesium 里 `Polyline.width`+像素 billboard 标记的组合）。
	 */
	arrowWidthMode?: CesiumGroundLineWidthMode;
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
	/**
	 * 贴地分类目标（贴地形 / 贴模型 / 二者）。默认 BOTH。
	 * 仅当宿主通过 frameState.classificationDepthTextures 提供多纹理时生效；
	 * 否则回退到 frameState.depthTexture 单纹理（行为与历史一致）。
	 */
	classificationType?: ClassificationType;
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
	/**
	 * 可选：按 {@link ClassificationType} 分目标的 packed 深度纹理集合。
	 *
	 * 当宿主使用 {@link ClassificationDepthManager}（贴模型 / 倾斜摄影场景）时填入；
	 * 标绘图元据自身 classificationType 采样对应纹理：
	 *   - TERRAIN        → terrain（地形 + 椭球兜底）
	 *   - CESIUM_3D_TILE → tileset（仅 3D Tiles 模型；无模型处为清屏哨兵被掩掉）
	 *   - BOTH           → both（地形 + 模型 + 椭球兜底，取最近表面）
	 *
	 * 不填（旧宿主 / 纯地形场景）时，所有图元回退到 {@link depthTexture} 单纹理，
	 * 行为与历史完全一致——这是向后兼容的关键。
	 */
	classificationDepthTextures?: ClassificationDepthTextureSet;
}

/**
 * 按 {@link ClassificationType} 分目标的 packed 深度纹理集合。
 * 任一字段缺省时，对应分类目标的图元回退到 {@link CesiumGroundFrameState.depthTexture}。
 */
export interface ClassificationDepthTextureSet {
	/** TERRAIN 目标纹理：地形（含椭球兜底）深度。 */
	terrain?: Texture | null;
	/** CESIUM_3D_TILE 目标纹理：仅 3D Tiles 模型深度（无模型处留清屏哨兵）。 */
	tileset?: Texture | null;
	/** BOTH 目标纹理：地形 + 模型 + 椭球兜底（取最近表面）的合并深度。 */
	both?: Texture | null;
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
	 * 历史贴地文本内容纹理槽。保留用于兼容；新代码使用通用 u_decalTexture。
	 */
	u_textTexture: { value: Texture | null };
	/** 通用透明纹理贴花（贴地文字和图片点共享）。 */
	u_decalTexture: { value: Texture | null };
	/** 贴花整体透明度，0..1；与纹理自身 alpha 相乘。 */
	u_decalOpacity: { value: number };
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
	// ── 线 FS 端「arrow 收口裁剪」：让线在「端点 / 起点 Lm 米内」按 style 裁线，
	//    避免线体与箭头在同一像素叠加（半透明翻倍）。任何 arrowMode 包含对应端时
	//    启用。Enabled > 0.5 时启用，否则线 FS 跳过裁剪保留原有矩形端面。──
	u_lineArrowClipEndEnabled?: { value: number };
	u_lineArrowClipStartEnabled?: { value: number };
	// 起 / 终端各自的箭头样式 id（与 ARROW_STYLE_ID 对齐）。线 FS 按各端 id 选收口
	// 策略：solid 类整段收平到 base；open 类收窄成 V 形嵌进 chevron。两端独立，
	// 支持「起点实心、终点空心」。随各端 arrowStyle 更新。
	u_lineArrowStyleStart?: { value: number };
	u_lineArrowStyleEnd?: { value: number };
}
