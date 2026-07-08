// ============================================================
// types.ts — 标绘类型层
// 层级：L0（零运行时依赖）
// 职责：定义所有标绘的入参类型 GisPlot*Options、类别枚举 GisPlotCategory、
//       快照类型 GisPlotSnapshot / GisPlotArrowSnapshot、管理器工厂入参
//       PlotAddOptions。本文件仅导出 type，不引入任何运行时模块，
//       可被任意层 import 而不产生循环依赖或框架耦合。
// 依赖：无。
// 被消费：plugins/base.ts、plugins/<子类>.ts、GroundDecalManager、
//       PlotPrimitiveBridge、业务调用方。
//
// 单位 / 口径约定：
//   - LonLatPoint 固定为 [经度°, 纬度°]。
//   - strokeOpacity / fillOpacity / strokeWidth 等不透明度字段为 0..100 整数
//     百分比（与 c2t 图元 0..100 口径一致；不做换算，直接透传）。
//   - 颜色字段为 CSS 字符串（'#rrggbb' / 'rgb()' / 'rgba()' / 'transparent'）。
// ============================================================

/** 经纬度顶点：[经度°, 纬度°]，单位度。 */
export type LonLatPoint = [ number, number ];

/** 标绘类别枚举，与 8 个 GisPlot* 子类一一对应；也是桥接器 switch(category) 的分支依据。 */
export type GisPlotCategory =
	| 'point'
	| 'line'
	| 'polygon'
	| 'rectangle'
	| 'sector'
	| 'arrow'
	| 'text'
	| 'circle';

/**
 * 标绘公共基类型。所有 GisPlot*Options 都继承自它。
 *
 * 关键口径：
 *   - strokeOpacity / fillOpacity 为 0..100 整数百分比（非 0..1）。
 *   - strokeColor / fillColor 为 CSS 颜色字符串。
 *   - points 元素顺序固定为 [lon, lat]。
 */
export type GisPlotBaseOptions = {
	/** 图形顶点列表 [[lon, lat], ...]。 */
	points: LonLatPoint[];
	/** 描边色（CSS 字符串）。 */
	strokeColor: string;
	/** 描边宽（米；折线在 c2t 下用像素）。 */
	strokeWidth: number;
	/** 描边不透明度：0..100 整数百分比。 */
	strokeOpacity: number;
	/** 填充色（CSS 字符串）。 */
	fillColor: string;
	/** 填充不透明度：0..100 整数百分比。 */
	fillOpacity: number;
	/** 可见性。 */
	visible: boolean;
	/**
	 * 是否贴地（ground-clamp）。默认 true。
	 *   - true（默认）：走 Cesium classification / stencil shadow-volume 贴地路径
	 *     （CesiumGround*Primitive）。有地形贴地形、无地形贴 EllipsoidDepthSource
	 *     椭球面，几何始终精确"贴"在地表/海平面上。
	 *   - false：走普通 Three 图元路径（PlainPlotPrimitive），在 heightMeters 指定的
	 *     离地高度直接成面/成线/成字，**完全不依赖深度纹理与 stencil**——即便宿主
	 *     没有接入任何贴地深度通道也能渲染。
	 * 该字段不进入几何/样式之外的语义，桥接器据此在两条渲染路径间分流。
	 */
	clampToGround?: boolean;
	/**
	 * 不贴地（clampToGround === false）时的离地高度，单位米，相对 WGS84 椭球面
	 * （海平面）。默认 0（贴在椭球面上）。贴地模式（clampToGround !== false）忽略此字段。
	 */
	heightMeters?: number;
};

/**
 * 通用浅快照结构：{ type, options }。type 即 category。
 * GisPlotBase.getSnapshot / getSnapshotDeep 的返回结构。
 */
export type GisPlotSnapshot<
	T extends GisPlotBaseOptions = GisPlotBaseOptions,
> = {
	type: GisPlotCategory;
	options: T;
};

/**
 * 箭头专用快照：在 { type, options } 之外额外带 generatedCoords（闭合多边形顶点）。
 * 管理器 getItem 的返回联合类型 GisPlotItemSnapshot = GisPlotSnapshot | GisPlotArrowSnapshot 由此而来。
 */
export type GisPlotArrowSnapshot = GisPlotSnapshot<PlotArrowOptions> & {
	generatedCoords: LonLatPoint[];
};

// ── 点 ──

/** 点标绘形状：'circle' = 圆点，'square' = 方点。 */
export type PlotPointStyle = 'circle' | 'square';

/**
 * 点标绘选项。points[0] 为点中心；size 在 c2t 侧：
 * circle 解释为直径、square 解释为边长。
 */
export type PlotPointOptions = GisPlotBaseOptions & {
	/** 点形状：'circle' / 'square'。 */
	pointStyle: PlotPointStyle;
	/** 尺寸（米）：circle 为直径、square 为边长。 */
	size: number;
};

// ── 折线 ──

/**
 * 折线描边样式：实线 / 虚线。c2t 贴地折线着色器只支持 solid / dash 两态，
 * 故移除参考项目里的 'dotted'。
 */
export type PlotLineStrokeStyle = 'solid' | 'dashed';

/**
 * 折线端点箭头样式：实心箭头 / 空心（不填充）箭头。
 * c2t 折线只有 solid / open 两态：
 *   - 'filledArrow'   → c2t arrowStyle='solid'
 *   - 'unfilledArrow' → c2t arrowStyle='open'
 * 参考项目里的 'filledDiamond' / 'filledCircle' / 'bar' 在 c2t 无对应渲染，
 * 因此对外契约只保留这 2 种。
 */
export type PlotArrowStyle = 'filledArrow' | 'unfilledArrow';

/**
 * 折线标绘选项。showArrow / startArrowStyle / endArrowStyle 是端点装饰相关
 * 的可选字段；strokeStyle 控制实线 / 虚线。
 */
export type PlotLineOptions = GisPlotBaseOptions & {
	strokeStyle?: PlotLineStrokeStyle;
	showArrow?: boolean;
	/** 起点箭头样式；null / 缺省表示无。 */
	startArrowStyle?: PlotArrowStyle | null;
	/** 终点箭头样式；null / 缺省表示无。 */
	endArrowStyle?: PlotArrowStyle | null;
};

// ── 面（多边形 / 矩形 / 圆 / 扇形） ──
//
// c2t 面图元（CesiumGroundPolygonPrimitive / RectanglePrimitive /
// CirclePrimitive）只支持实线描边 + 纯色填充，因此对外契约里不暴露
// strokeStyle / fillStyle —— 它们在参考项目中存在但 c2t 无对应渲染分支。

/** 多边形标绘选项：≥3 顶点。 */
export type PlotPolygonOptions = GisPlotBaseOptions;

/** 矩形标绘选项：points 为 4 个角点（顺 / 逆时针），c2t 下映射为任意四边形 polygon。 */
export type PlotRectangleOptions = GisPlotBaseOptions;

/** 扇形标绘选项：points[0] 为扇心；startAngle / sectorAngle 单位为度。 */
export type PlotSectorOptions = GisPlotBaseOptions & {
	/** 半径（米）。 */
	radius: number;
	/** 起始角（度）。 */
	startAngle: number;
	/** 张开角（度）。 */
	sectorAngle: number;
};

/** 圆形标绘选项：points[0] 为圆心。 */
export type PlotCircleOptions = GisPlotBaseOptions & {
	/** 半径（米）。 */
	radius: number;
};

// ── 箭头 ──

/**
 * 箭头类型，与 c2t arrow SDK（src/lib/arrow）的 5 个生成函数一一对应：
 *   - 'fine'              → createFineArrow              细箭头（2 控制点：起 / 止）
 *   - 'assaultDirection'  → createAssaultDirectionArrow  突击方向箭头（2 控制点：起 / 止）
 *   - 'attack'            → createAttackArrow            攻击箭头（≥3 控制点：前 2 = 尾边、后 N-2 = 脊线，最后一个为 tip）
 *   - 'swallowtailAttack' → createSwallowtailAttackArrow 燕尾攻击箭头（同 attack 控制点约定）
 *   - 'curved'            → createCurvedArrow            曲线箭头（≥2 控制点，全部作为脊线）
 */
export type PlotArrowType =
	| 'fine'
	| 'assaultDirection'
	| 'attack'
	| 'swallowtailAttack'
	| 'curved';

/**
 * 箭头标绘选项。points 为控制点；不同 arrowType 对 points 的解释见 PlotArrowType。
 *
 * 曲线箭头(arrowType='curved')可选的体型参数,均相对曲线总弧长:
 *   - curvedBodyWidthFactor:带子粗细(默认见 createCurvedArrow)。
 *   - curvedHeadWidthFactor:箭翼展开宽度。
 *   - curvedHeadLengthFactor:箭头三角长度。
 * 未提供时使用 SDK 默认值。仅 'curved' 类型会消费这些字段。
 */
export type PlotArrowOptions = GisPlotBaseOptions & {
	arrowType: PlotArrowType;
	/**
	 * 整体大小(宽度)倍率,默认 1.0,**对全部 arrowType 生效**。
	 * 透传为各箭头 SDK 的 widthScale(fine/assault/attack/swallow/curved 各自把
	 * 自己的宽度量同乘此值)。长度由控制点决定,本字段只改粗细。
	 */
	sizeScale?: number;
	curvedBodyWidthFactor?: number;
	curvedHeadWidthFactor?: number;
	curvedHeadLengthFactor?: number;
};

// ── 文本 ──

/** 文本水平对齐（框内）。 */
export type PlotTextAlign = 'left' | 'center' | 'right';
/** 文本垂直对齐（框内）。 */
export type PlotTextVerticalAlign = 'top' | 'middle' | 'bottom';
/** 文本框相对锚点的水平对齐。 */
export type PlotTextAnchorX = 'left' | 'center' | 'right';
/** 文本框相对锚点的垂直对齐。 */
export type PlotTextAnchorY = 'top' | 'middle' | 'bottom';
/** 文本排版方向：横排 / 竖排（自右向左 / 自左向右）。 */
export type PlotTextLayoutDirection = 'horizontal' | 'vertical-rl' | 'vertical-lr';

/**
 * 文本标绘选项。points[0] 为文本框锚点；
 * textAlign / verticalAlign 控制框内对齐；
 * anchorX / anchorY 控制框相对锚点位置。
 *
 * 与 c2t PlotTextOptions（src/lib/ground/text/text-types.ts）高度同构：
 * 字段名 content / fontColor / fontSize / textAlign / verticalAlign /
 * anchorX / anchorY / layoutDirection / rotation / showBorder /
 * fillColor / fillOpacity / strokeColor / strokeOpacity / boxWidth /
 * boxHeight / padding 完全同名，桥接器可几乎一一映射。
 */
export type PlotTextOptions = GisPlotBaseOptions & {
	/** 文本内容；\n 在横排是换行、竖排是换列。 */
	content: string;
	/** 字色（CSS 字符串）。 */
	fontColor: string;
	/** 字号（纹素像素，> 0）。 */
	fontSize: number;
	/** 缩放倍率（参考项目；c2t 可折进 metersPerPixel）。 */
	scale?: number;
	/** 文字在框内水平对齐，默认 'left'。 */
	textAlign?: PlotTextAlign;
	/** 文字在框内垂直对齐，默认 'middle'。 */
	verticalAlign?: PlotTextVerticalAlign;
	/** 框相对锚点水平对齐，默认 'center'。 */
	anchorX?: PlotTextAnchorX;
	/** 框相对锚点垂直对齐，默认 'middle'。 */
	anchorY?: PlotTextAnchorY;
	/** 固定框宽（纹素像素）；不传则按内容自适应。 */
	boxWidth?: number;
	/** 固定框高（纹素像素）；不传则按内容自适应。 */
	boxHeight?: number;
	/** 内边距：单值或 [top, right, bottom, left]（纹素像素）。 */
	padding?: number | [ number, number, number, number ];
	/** 排版方向，默认 'horizontal'。 */
	layoutDirection?: PlotTextLayoutDirection;
	/** 地平面内旋转，度，北向顺时针为正，默认 0。 */
	rotation?: number;
	/** X 方向偏移（参考项目；c2t 映射为 offsetEastMeters）。 */
	offsetX?: number;
	/** Y 方向偏移（参考项目；c2t 映射为 offsetNorthMeters）。 */
	offsetY?: number;
	/** 是否显示框边框。 */
	showBorder?: boolean;
};

/**
 * 工厂入参：管理器 addPlot 的唯一入参类型。判别联合（discriminated union）。
 * 管理器据此 switch(type) 实例化对应子类。
 */
export type PlotAddOptions =
	| ( { type: 'point' } & PlotPointOptions )
	| ( { type: 'line' } & PlotLineOptions )
	| ( { type: 'polygon' } & PlotPolygonOptions )
	| ( { type: 'rectangle' } & PlotRectangleOptions )
	| ( { type: 'circle' } & PlotCircleOptions )
	| ( { type: 'sector' } & PlotSectorOptions )
	| ( { type: 'text' } & PlotTextOptions )
	| ( { type: 'arrow' } & PlotArrowOptions );
