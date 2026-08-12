/** 经度、纬度和高度的规范三元坐标，单位依次为度、度、米。 */
export type Position3D = readonly [
	longitudeDegrees: number,
	latitudeDegrees: number,
	heightMeters: number,
];

/** 设计文档早期章节使用的同义名称。 */
export type GeoPosition = Position3D;

/** 仅允许出现在兼容输入边界的旧二维坐标。 */
export type LegacyLonLatPosition = readonly [
	longitudeDegrees: number,
	latitudeDegrees: number,
];

export type PositionInput = Position3D | LegacyLonLatPosition;

/** 与 Cesium HeightReference 的数值逐项对齐。 */
export const HeightReference = Object.freeze( {
	NONE: 0,
	CLAMP_TO_GROUND: 1,
	RELATIVE_TO_GROUND: 2,
	CLAMP_TO_TERRAIN: 3,
	RELATIVE_TO_TERRAIN: 4,
	CLAMP_TO_3D_TILE: 5,
	RELATIVE_TO_3D_TILE: 6,
} as const );

export type HeightReference =
	typeof HeightReference[ keyof typeof HeightReference ];

export type HeightReferenceName = keyof typeof HeightReference;
export type HeightMode = 'absolute' | 'clamp' | 'relative';
export type HeightSurface = 'ellipsoid' | 'ground' | 'terrain' | '3d-tile';

export type PlotFeatureId = string;
export type VertexId = string;

export type PlotFeatureType =
	| 'point'
	| 'line'
	| 'polygon'
	| 'rectangle'
	| 'sector'
	| 'arrow'
	| 'text'
	| 'circle';

/** 文档属性只允许无副作用、可安全 JSON 序列化的值。 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [ key: string ]: JsonValue };

export interface PointGeometry {
	readonly position: Position3D;
}

export interface LineGeometry {
	readonly positions: readonly Position3D[];
}

export interface PolygonGeometry {
	/** 外环不重复保存首点；渲染端负责闭合。 */
	readonly positions: readonly Position3D[];
}

export interface RectangleGeometry {
	/** 依次为西南、东南、东北、西北角，不重复首点。 */
	readonly positions: readonly [ Position3D, Position3D, Position3D, Position3D ];
}

export interface SectorGeometry {
	readonly center: Position3D;
	readonly radius: number;
	/** 北向为 0 度，顺时针为正，规范范围为 [0, 360)。 */
	readonly startAngle: number;
	/** 顺时针张角，规范范围为 (0, 360]。 */
	readonly sectorAngle: number;
}

export type ArrowType =
	| 'fine'
	| 'assaultDirection'
	| 'attack'
	| 'swallowtailAttack'
	| 'curved';

export interface ArrowGeometry {
	/** 箭头的作者数据始终是控制点，派生轮廓不得持久化。 */
	readonly positions: readonly Position3D[];
	readonly arrowType: ArrowType;
	readonly sizeScale: number;
	readonly curvedBodyWidthFactor?: number;
	readonly curvedHeadWidthFactor?: number;
	readonly curvedHeadLengthFactor?: number;
}

export interface TextGeometry {
	readonly position: Position3D;
}

export interface CircleGeometry {
	readonly center: Position3D;
	readonly radius: number;
}

export type PlotGeometry =
	| PointGeometry
	| LineGeometry
	| PolygonGeometry
	| RectangleGeometry
	| SectorGeometry
	| ArrowGeometry
	| TextGeometry
	| CircleGeometry;

/** 八类图形共享的规范样式。透明度使用 0..100 的现有项目口径。 */
export interface PlotStyle {
	readonly strokeColor: string;
	readonly strokeWidth: number;
	readonly strokeOpacity: number;
	readonly fillColor: string;
	readonly fillOpacity: number;
}

export type PointStyle =
	| ( PlotStyle & {
		readonly pointStyle: 'circle' | 'square';
		readonly size: number;
	} )
	| ( PlotStyle & {
		readonly pointStyle: 'image';
		readonly imageUrl: string;
		readonly imageWidth: number;
		readonly imageHeight: number;
		readonly rotation: number;
	} );

export interface LineStyle extends PlotStyle {
	readonly strokeStyle: 'solid' | 'dashed';
	readonly showArrow: boolean;
	readonly startArrowStyle: 'filledArrow' | 'unfilledArrow' | null;
	readonly endArrowStyle: 'filledArrow' | 'unfilledArrow' | null;
}

export type TextHorizontalAlign = 'left' | 'center' | 'right';
export type TextVerticalAlign = 'top' | 'middle' | 'bottom';
export type TextLayoutDirection = 'horizontal' | 'vertical-rl' | 'vertical-lr';

export interface TextStyle extends PlotStyle {
	readonly content: string;
	readonly fontColor: string;
	readonly fontSize: number;
	readonly scale: number;
	readonly textAlign: TextHorizontalAlign;
	readonly verticalAlign: TextVerticalAlign;
	readonly anchorX: TextHorizontalAlign;
	readonly anchorY: TextVerticalAlign;
	readonly boxWidth?: number;
	readonly boxHeight?: number;
	readonly padding: number | readonly [ number, number, number, number ];
	readonly layoutDirection: TextLayoutDirection;
	readonly rotation: number;
	readonly offsetX: number;
	readonly offsetY: number;
	readonly showBorder: boolean;
}

export interface PlotFeatureBase<
	TType extends PlotFeatureType,
	TGeometry extends PlotGeometry,
	TStyle extends PlotStyle = PlotStyle,
> {
	readonly id: PlotFeatureId;
	readonly type: TType;
	readonly geometry: Readonly<TGeometry>;
	readonly style: Readonly<TStyle>;
	readonly heightReference: HeightReference;
	readonly visible: boolean;
	readonly properties: Readonly<Record<string, JsonValue>>;
	/** 每次成功修改此图形后递增，供并发编辑检测使用。 */
	readonly revision: number;
}

export type PointFeature = PlotFeatureBase<'point', PointGeometry, PointStyle>;
export type LineFeature = PlotFeatureBase<'line', LineGeometry, LineStyle>;
export type PolygonFeature = PlotFeatureBase<'polygon', PolygonGeometry>;
export type RectangleFeature = PlotFeatureBase<'rectangle', RectangleGeometry>;
export type SectorFeature = PlotFeatureBase<'sector', SectorGeometry>;
export type ArrowFeature = PlotFeatureBase<'arrow', ArrowGeometry>;
export type TextFeature = PlotFeatureBase<'text', TextGeometry, TextStyle>;
export type CircleFeature = PlotFeatureBase<'circle', CircleGeometry>;

export type PlotFeature =
	| PointFeature
	| LineFeature
	| PolygonFeature
	| RectangleFeature
	| SectorFeature
	| ArrowFeature
	| TextFeature
	| CircleFeature;

export interface PlotDocumentSnapshot {
	readonly schema: 'cesium-to-three/plot-document';
	readonly version: 1;
	readonly documentId: string;
	readonly revision: number;
	readonly features: readonly PlotFeature[];
	readonly order: readonly PlotFeatureId[];
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ResolvedPlotGeometry {
	readonly plotId: PlotFeatureId;
	readonly sourceRevision: number;
	/** 与 canonical 作者控制点一一对应的运行时绝对坐标。 */
	readonly effectivePositions: readonly Position3D[];
	/**
	 * 与 GeometryAdapter.toRenderDescription().positions 一一对应的表面坐标。
	 * 圆、扇形、箭头等派生轮廓必须逐顶点解析，不能把中心高度铺成一张平板。
	 */
	readonly effectiveRenderPositions?: readonly Position3D[];
	/** 首次采样存在空洞且没有可复用完整表面时为 true；此时不得构建拾取代理。 */
	readonly surfaceIncomplete?: true;
	readonly status: 'ready' | 'pending' | 'unavailable';
}
