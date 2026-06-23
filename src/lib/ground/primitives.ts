// ============================================================
// primitives.ts
// 层级:贴地图元构造层(矩形与多边形路径的几何生成已脱离 Cesium)。
// 职责:使用 math/、rectangle/、polygon/ 下的本地模块构造矩形与多边形 shadow volume。
//      classification 运行时(classification.ts、materials.ts、depth.ts、
//      terrain-log-depth.ts、terrain-heights.ts)保持所有精度修复路径与 Cesium 对齐：
//      Float64 MVP、LOG_DEPTH、动态 czm_geometricToleranceOverMeter、
//      LessEqualDepth stencil、地形 log-depth 注入、ApproximateTerrainHeights 窗口。
//      classification 侧唯一新增能力是 polygon 描边的 point-in-polygon 路径，
//      它挂在 `u_polygonBorderMode` 控制的独立 shader 分支上。
// 依赖:Three.js 调试网格、本地 rectangle/polygon/math 模块、
//      classification 图元运行时、ApproximateTerrainHeights 查询。
// 被消费:公开贴地适配器与 demo。
// ============================================================

import {
	BufferGeometry,
	Color,
	DoubleSide,
	Group,
	Matrix3,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	Vector2,
	Vector3,
	Vector4,
	type Material,
	type RawShaderMaterial,
} from 'three';

import {
	CesiumClassificationPrimitive,
	resolveClassificationDepthTexture,
	updateFrameStateUniforms,
} from './classification';
import { computeCirclePlanarExtents } from './circle/circle-extents';
import { buildCircleShadowVolumeGeometry } from './circle/circle-shadow-volume';
import { encodeCesiumVector3 } from './geometry';
import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	LINE_DEFAULT_WIDTH_PIXELS,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
} from './constants';
import { buildLineShadowVolumeGeometry } from './line/line-shadow-volume';
import {
	parseArrowMode,
	parseArrowStyle,
	resolvePublicLineOptions,
	toLineShadowVolumeOptions,
	type ResolvedLineOptions,
} from './line/line-options';
import type { LineGeometryUserData } from './line/line-shadow-volume';
import {
	ARROW_MODE,
	ARROW_STYLE_ID,
	buildArrowHeadGeometry,
} from './line/line-arrowhead';
import { LineWidthMode } from './line/line-types';
import { createArrowHeadMaterial, createPolylineMaterial } from './materials';
import { computePolygonPlanarExtents } from './polygon/polygon-extents';
import { polygonRenderBoundsThroughMeters } from './polygon/polygon-offset';
import {
	normalizePolygonPoints,
	polygonHierarchyFromLonLatPoints,
	type PolygonHierarchy,
} from './polygon/polygon-hierarchy';
import {
	buildPolygonShadowVolumeGeometry,
	type PolygonGeometryUserData,
} from './polygon/polygon-shadow-volume';
import { computePolygonPlanarStylePoints } from './polygon/polygon-style-points';
import { createDebugRectangleSurfaceGeometry } from './rectangle/rectangle-debug';
import { computeRectanglePlanarExtents } from './rectangle/rectangle-extents';
import {
	expandRectangleDegreesThroughMeters,
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromLonLatPoints,
} from './rectangle/rectangle-helpers';
import { rectangleRadiansFromDegrees } from './rectangle/rectangle-radians';
import { buildRectangleShadowVolumeGeometry } from './rectangle/rectangle-shadow-volume';
import { ClassificationType } from './types';
import type {
	CartesianLike,
	CesiumGroundArrowMode,
	CesiumGroundArrowStyle,
	CesiumGroundCirclePrimitiveOptions,
	CesiumGroundFrameState,
	CesiumGroundPointPrimitiveOptions,
	CesiumGroundPointShape,
	CesiumGroundPolygonOptions,
	CesiumGroundPolylineOptions,
	CesiumGroundRectanglePrimitiveOptions,
	LonLatPoint,
	PolygonHierarchyDegrees,
	RectangleRadians,
	SharedUniforms,
} from './types';

/**
 * 将 SoonSpace 风格的整数不透明度转换为 shader 使用的归一化范围。
 *
 * @param opacity 0-100 存储格式的不透明度百分比。
 * @returns 限制到 0-1 范围后的 Three uniform 不透明度。
 */
function normalizePercentOpacity( opacity: number ): number {
	const safeOpacity = Number.isFinite( opacity ) ? opacity : 100.0;
	return Math.min( Math.max( safeOpacity, 0.0 ), 100.0 ) / 100.0;
}

/**
 * 将旧版 `PolygonHierarchyDegrees` 表示转换为本地 polygon 模块消费的
 * 扁平 (LonLatPoint[], LonLatPoint[][]) 数据。
 */
function polygonHierarchyDegreesToLonLatPoints(
	hierarchy: PolygonHierarchyDegrees,
): { points: LonLatPoint[]; holes: LonLatPoint[][] } {
	const points = hierarchy.positions.map(
		( p ) => [ p.longitude, p.latitude ] as LonLatPoint,
	);
	const holes = ( hierarchy.holes ?? [] ).map(
		( sub ) => sub.positions.map(
			( p ) => [ p.longitude, p.latitude ] as LonLatPoint,
		),
	);
	return { points, holes };
}

/**
 * 将本地 `PolygonHierarchy`(Vector3 ECEF)适配回公开的 `CartesianLike` 形状，
 * 保证外部调用方读取 `primitive.polygonHierarchy.positions` 时契约不变。
 */
function polygonHierarchyToCartesianLike(
	hierarchy: PolygonHierarchy,
): { positions: CartesianLike[]; holes: unknown[] } {
	const positions: CartesianLike[] = hierarchy.positions.map(
		( v: Vector3 ) => ( { x: v.x, y: v.y, z: v.z } as CartesianLike ),
	);
	const holes: unknown[] = ( hierarchy.holes ?? [] ).map(
		( hole ) => ( {
			positions: hole.positions.map(
				( v: Vector3 ) => ( { x: v.x, y: v.y, z: v.z } as CartesianLike ),
			),
		} ),
	);
	return { positions, holes };
}

/**
 * 计算 lon/lat 环的中心点。`options.rotationDegrees` 请求平面内旋转时，
 * 以该点作为旋转轴心。
 */
function lonLatCentroid( points: readonly LonLatPoint[] ): LonLatPoint {
	let lonSum = 0.0;
	let latSum = 0.0;
	for ( const p of points ) {
		lonSum += p[ 0 ];
		latSum += p[ 1 ];
	}
	const safeCount = Math.max( points.length, 1 );
	return [ lonSum / safeCount, latSum / safeCount ];
}

/**
 * 围绕轴心旋转 lon/lat 环。这里使用小范围近似：把轴心附近的 lon/lat
 * 当作平面 2D 坐标处理，与参考项目对 demo 多边形(半径数公里内)的做法一致。
 */
function rotateLonLatPoints(
	points: readonly LonLatPoint[],
	pivot: LonLatPoint,
	rotationDegrees: number,
): LonLatPoint[] {
	if ( ! Number.isFinite( rotationDegrees ) || rotationDegrees === 0.0 ) {
		return points.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	}

	const rad = rotationDegrees * Math.PI / 180.0;
	const cos = Math.cos( rad );
	const sin = Math.sin( rad );

	return points.map( ( p ) => {
		const dx = p[ 0 ] - pivot[ 0 ];
		const dy = p[ 1 ] - pivot[ 1 ];
		return [
			pivot[ 0 ] + dx * cos - dy * sin,
			pivot[ 1 ] + dx * sin + dy * cos,
		] as LonLatPoint;
	} );
}

/**
 * 使用本地 rectangle shadow-volume 管线实现的贴地矩形。
 * classification 命令组保持复用，保留此前针对抖动问题落地的全部精度修复。
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: RectangleRadians;

	public constructor( options: CesiumGroundRectanglePrimitiveOptions ) {
		const rectangleDegrees = rectangleDegreesFromLonLatPoints( options.points );

		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		// 矩形遵循面图元契约：输入点描述填充矩形，strokeWidth 将实际渲染面向外扩张。
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			rectangleDegrees,
			strokeWidthMeters,
		);

		const fillRectangleRadians = rectangleRadiansFromDegrees(
			rectangleDegrees.west,
			rectangleDegrees.south,
			rectangleDegrees.east,
			rectangleDegrees.north,
		);
		const renderRectangleRadians = rectangleRadiansFromDegrees(
			renderRectangleDegrees.west,
			renderRectangleDegrees.south,
			renderRectangleDegrees.east,
			renderRectangleDegrees.north,
		);
		this.rectangle = fillRectangleRadians;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Shadow-volume 垂直窗口。调用方显式传入时优先使用，否则回退到 Cesium ±55km
		// 高度窗口(CESIUM_GLOBE_MINIMUM_ALTITUDE)。
		//
		// 为什么使用固定 ±55km，而不是 ApproximateTerrainHeights 给出的紧包围盒：
		//   shadow volume 必须在用户可能飞行的任意相机高度下都大于远裁剪面的视锥切片。
		//   否则远裁剪面会切到 volume 顶部/侧面，使受影响片元的 Z-fail stencil
		//   计数失去一致性，出现填充缺失的弯曲带。圆形没有该伪影，是因为它的
		//   volume 原本就在 ±55km 尺度。110km 垂直跨度足以让 box 在现实相机高度下
		//   始终落在视锥边界之外。
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		let maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		if ( maximumHeight <= minimumHeight ) {
			maximumHeight = minimumHeight + 1.0;
		}

		const threeGeometry = buildRectangleShadowVolumeGeometry( {
			rectangle: renderRectangleRadians,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		const extents = computeRectanglePlanarExtents(
			renderRectangleRadians,
			fillRectangleRadians,
		);

		const color = new Color( options.fillColor );
		const alpha = normalizePercentOpacity( options.fillOpacity );
		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 10,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible;
		this.classification.setClassificationType( options.classificationType );
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);

		this.debugSurface = null;
		if ( options.debugSurface === true ) {
			const debugThreeGeometry = createDebugRectangleSurfaceGeometry(
				fillRectangleRadians,
				options.debugSurfaceHeight ?? 5000.0,
			);
			const debugMaterial = new MeshBasicMaterial( {
				color,
				transparent: true,
				opacity: options.debugSurfaceOpacity ?? alpha,
				depthTest: false,
				depthWrite: false,
				side: DoubleSide,
				toneMapped: false,
			} );
			debugMaterial.name = 'CesiumGroundRectangleDebugSurfaceMaterial';

			this.debugSurface = new Mesh( debugThreeGeometry, debugMaterial );
			this.debugSurface.name = 'CesiumGroundRectangleDebugSurface';
			this.debugSurface.frustumCulled = false;
			this.debugSurface.renderOrder = ( options.renderOrder ?? 10 ) + 2;

			// 将 debug surface 放到不可拾取 layer。
			//
			// 这是唯一拥有普通 Three.js `position` attribute 与真实 bounding sphere
			// 的 Cesium-ground 网格；shadow volume 网格使用 RTE 编码的 `position3DHigh` /
			// `position3DLow`，boundingSphere 为空，实践中不会产生 raycast 命中。
			// debug surface 会被命中，导致 GlobeControls
			// (`EnvironmentControls._raycast` → `Raycaster.intersectObject(scene)`)
			// 把它当作地形：
			//   - `_updateZoomPoint`:zoomPoint 落在 debugSurfaceHeight(默认 5000m)
			//     的表面上，鼠标滚轮缩放会渐近地把相机拉到该高度并卡住。
			//   - `_getPointBelowCamera` / `adjustHeight = true`:返回 debugSurfaceHeight
			//     处的命中点，把相机钉在真实地形上方。
			//
			// 关键点：Three.js 的 `Raycaster.intersect` 不认 `object.visible = false`，
			// 只认 `object.layers`。因此从 GUI 切换 `debugSurface.visible` 不能阻止
			// raycast，只有换 layer 才行。这个网格只是调试可视化，永远不应参与场景拾取，
			// 所以固定放到 CESIUM_GROUND_NON_PICKABLE_LAYER。宿主相机必须启用该 layer
			// (见 ground-demo.ts 的 `camera.layers.enable(...)`)以继续渲染该网格。
			this.debugSurface.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );

			this.classification.group.add( this.debugSurface );
		}
	}

	/**
	 * 更新逐帧 uniform。
	 *
	 * @param frameState 当前 Three 侧帧状态。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * 更新矩形命令块的渲染顺序。
	 *
	 * @param renderOrder 分配给 front-stencil 命令的基础顺序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
		if ( this.debugSurface ) {
			this.debugSurface.renderOrder = renderOrder + 2;
		}
	}

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。供桥接器在 GUI 改「分类目标」时热更新调用。
	 * 不同步会让图元继续采样上一目标那张已不再逐帧刷新的 packed 深度纹理，导致标绘
	 * 随相机漂浮（仅初始 BOTH 正常，切 TERRAIN / CESIUM_3D_TILE 后异常）。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.classification.setClassificationType( classificationType );
	}

	/**
	 * 释放资源。
	 */
	public dispose(): void {
		this.classification.dispose();
		if ( this.debugSurface ) {
			this.debugSurface.geometry.dispose();
			( this.debugSurface.material as Material ).dispose();
		}
	}
}

/**
 * 使用本地 polygon shadow-volume 管线实现的贴地多边形。
 * 描边通过 classification 图元的 polygon-border uniform 支持，是附加能力，
 * 不影响精度关键路径。
 *
 * 支持两种调用形态:
 *   1. 新的 ref 风格 API:`points`、可选 `holes` / `hole` / `rotationDegrees`，
 *      以及独立的 `fillColor` / `strokeColor` 等字段。
 *   2. 旧版 `polygonHierarchyDegrees` 形态，搭配 `color` / `alpha`。
 *      构造器会检测实际输入并路由到对应路径。
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };
	public readonly rotationDegrees: number;
	public readonly hole: boolean;

	public constructor( options: CesiumGroundPolygonOptions ) {
		// 解析输入形态；存在新 ref 风格 API 时优先使用它。
		const usingPlotSpec = Array.isArray( options.points ) && options.points.length > 0;
		let outerLonLat: LonLatPoint[];
		let holesLonLat: LonLatPoint[][];

		if ( usingPlotSpec ) {
			outerLonLat = normalizePolygonPoints( options.points as LonLatPoint[] );
			const holesInput = options.hole === true && Array.isArray( options.holes )
				? options.holes
				: [];
			holesLonLat = holesInput.map( ( hole ) => normalizePolygonPoints( hole ) );
		} else if ( options.polygonHierarchyDegrees ) {
			const flattened = polygonHierarchyDegreesToLonLatPoints(
				options.polygonHierarchyDegrees,
			);
			outerLonLat = flattened.points;
			holesLonLat = flattened.holes;
		} else {
			throw new Error(
				'CesiumGroundPolygonPrimitive requires either `points` or `polygonHierarchyDegrees`.',
			);
		}

		this.rotationDegrees = Number.isFinite( options.rotationDegrees )
			? ( options.rotationDegrees as number )
			: 0.0;
		this.hole = options.hole === true;

		// 围绕外环中心应用平面内旋转，与参考 demo 一致。
		const rotationPivot = lonLatCentroid( outerLonLat );
		const rotatedOuter = rotateLonLatPoints( outerLonLat, rotationPivot, this.rotationDegrees );
		const rotatedHoles = holesLonLat.map(
			( hole ) => rotateLonLatPoints( hole, rotationPivot, this.rotationDegrees ),
		);

		// 描边宽度(米)向外扩张，得到实际渲染用外环。
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? ( options.strokeWidth as number ) : 0.0,
			0.0,
		);
		const renderOuter = strokeWidthMeters > 0.0
			? polygonRenderBoundsThroughMeters( rotatedOuter, strokeWidthMeters )
			: rotatedOuter.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );

		// 输入多边形是填充面。描边由片元着色器测量到同一边界的距离，
		// 在填充环外侧进行 classification。render ring 只是保守外壳，
		// 让 shader 在外侧描边带上有片元可处理。
		const fillHierarchy = polygonHierarchyFromLonLatPoints( rotatedOuter, rotatedHoles );
		const renderHierarchy = polygonHierarchyFromLonLatPoints( renderOuter, rotatedHoles );
		this.polygonHierarchy = polygonHierarchyToCartesianLike( fillHierarchy );

		// 默认 granularity 与之前的适配器保持一致。
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Shadow-volume 垂直窗口。使用与矩形/圆形图元相同的固定 ±55km 回退
		// (完整原因见矩形构造器)：地形感知的紧包围盒会被相机远裁剪面切到，
		// 触发弯曲带状填充伪影；±55km 跨度在现实相机高度下始终位于视锥之外。
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		let maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		if ( maximumHeight <= minimumHeight ) {
			maximumHeight = minimumHeight + 1.0;
		}

		// 一个本地调用替代之前 6 步 Cesium 链路。
		const threeGeometry = buildPolygonShadowVolumeGeometry( {
			hierarchy: renderHierarchy,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		const userData = threeGeometry.userData as PolygonGeometryUserData;
		const polygonRectangle = userData.polygonRectangle;

		const extents = computePolygonPlanarExtents(
			polygonRectangle,
			renderHierarchy,
		);

		// 多边形描边的平面参考点：把填充环投影到片元着色器用于 uv 解码的同一 SW 米制平面。
		const stylePoints = computePolygonPlanarStylePoints(
			polygonRectangle,
			renderHierarchy,
			rotatedOuter,
		);

		// 填充颜色/透明度解析：新 API 使用 fillColor + fillOpacity(0..100 百分比)，
		// 旧 API 使用 color + alpha(0..1)。
		let fillColorInput: Color | string | number;
		let fillAlpha: number;
		if ( usingPlotSpec ) {
			fillColorInput = options.fillColor ?? '#00aaff';
			fillAlpha = normalizePercentOpacity(
				Number.isFinite( options.fillOpacity ) ? ( options.fillOpacity as number ) : 65,
			);
		} else {
			fillColorInput = options.color ?? 0x00aaff;
			fillAlpha = Number.isFinite( options.alpha ) ? ( options.alpha as number ) : 0.65;
		}
		const color = new Color( fillColorInput );

		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			fillAlpha,
			options.renderOrder ?? 30,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible ?? true;
		this.classification.setClassificationType( options.classificationType );
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ?? '#ffffff' ),
			normalizePercentOpacity(
				Number.isFinite( options.strokeOpacity ) ? ( options.strokeOpacity as number ) : 95,
			),
			strokeWidthMeters,
		);
		// 用填充环的平面米制坐标激活 polygon-stroke shader 分支。
		// 三个及以上点启用 polygon-border 模式，更少点则回退到矩形轴对齐边框。
		this.classification.setPolygonBorderPoints( stylePoints );
		this.classification.setPolygonMiterStrokeMode( false );
	}

	/**
	 * 更新逐帧 uniform。
	 *
	 * @param frameState 当前 Three 侧帧状态。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * 更新多边形命令块的渲染顺序。
	 *
	 * @param renderOrder 分配给 front-stencil 命令的基础顺序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。供桥接器在 GUI 改「分类目标」时热更新调用，
	 * 使图元改采样对应的 packed 深度纹理；不同步会导致采样旧纹理、标绘随相机漂浮。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.classification.setClassificationType( classificationType );
	}

	/**
	 * 释放资源。
	 */
	public dispose(): void {
		this.classification.dispose();
	}
}

/**
 * 使用本地 circle shadow-volume 管线实现的贴地圆。
 *
 * plot-spec 选项与参考项目保持同形：`center` + `radius` + stroke/fill/visible，
 * 以及可选装饰字段 `ringCount`、`ringGapMeters`、`sectorStartDegrees`、
 * `sectorAngleDegrees`、`stRotationRadians`、`granularityRadians`，
 * shadow-volume 窗口高度 `height` / `extrudedHeight`，以及
 * `renderOrder` / `fragmentCull` 控制项。片元着色器的 circle 分支通过
 * `classification.setCircleBorderStyle(...)` 激活；LOG_DEPTH 与 Float64 路径不受影响。
 */
export class CesiumGroundCirclePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly center: LonLatPoint;
	public readonly radius: number;

	public constructor( options: CesiumGroundCirclePrimitiveOptions ) {
		const centerLongitude = options.center[ 0 ];
		const centerLatitude = options.center[ 1 ];
		if (
			! Number.isFinite( centerLongitude ) ||
			! Number.isFinite( centerLatitude ) ||
			centerLongitude < - 180.0 ||
			centerLongitude > 180.0 ||
			centerLatitude < - 90.0 ||
			centerLatitude > 90.0
		) {
			throw new Error( 'Ground circle center must be a valid WGS84 [lon, lat] point.' );
		}

		const fillRadiusMeters = Number.isFinite( options.radius )
			? Math.max( options.radius, 1.0 )
			: 1.0;
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		// 圆形遵循同一面图元契约：options.radius 是填充半径；
		// 实际渲染的 shadow volume 半径包含外侧描边。
		const renderRadiusMeters = fillRadiusMeters + strokeWidthMeters;

		const requestedRingCount = options.ringCount ?? 1.0;
		const requestedRingGapMeters = options.ringGapMeters ?? 0.0;
		const ringCount = Number.isFinite( requestedRingCount )
			? Math.max( Math.floor( requestedRingCount ), 1.0 )
			: 1.0;
		const ringGapMeters = Number.isFinite( requestedRingGapMeters )
			? Math.max( requestedRingGapMeters, 0.0 )
			: 0.0;

		const requestedSectorStartDegrees = options.sectorStartDegrees ?? 0.0;
		const requestedSectorAngleDegrees = options.sectorAngleDegrees ?? 360.0;
		const sectorStartRadians = Number.isFinite( requestedSectorStartDegrees )
			? requestedSectorStartDegrees * Math.PI / 180.0
			: 0.0;
		const sectorAngleRadians = Number.isFinite( requestedSectorAngleDegrees )
			? Math.min( Math.max( requestedSectorAngleDegrees, - 360.0 ), 360.0 ) * Math.PI / 180.0
			: Math.PI * 2.0;

		this.center = [ centerLongitude, centerLatitude ];
		this.radius = fillRadiusMeters;

		const requestedGranularity = options.granularityRadians ?? ( Math.PI / 180.0 );
		const granularityRadians = Number.isFinite( requestedGranularity )
			? Math.min(
				Math.max( requestedGranularity, MIN_CIRCLE_GRANULARITY_RADIANS ),
				MAX_CIRCLE_GRANULARITY_RADIANS,
			)
			: Math.PI / 180.0;

		// Shadow-volume 垂直窗口。调用方传入的 minimum/maximumHeight 优先；
		// 否则回退到 Cesium ±55km 高度窗口。这里跳过 ApproximateTerrainHeights，
		// 因为圆形标绘位于小圆盘内，±55km 回退已经足够覆盖。
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		let maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		if ( maximumHeight <= minimumHeight ) {
			maximumHeight = minimumHeight + 1.0;
		}

		const threeGeometry = buildCircleShadowVolumeGeometry( {
			centerLongitudeDegrees: centerLongitude,
			centerLatitudeDegrees: centerLatitude,
			radiusMeters: renderRadiusMeters,
			granularityRadians,
			stRotationRadians: options.stRotationRadians ?? 0.0,
			minimumHeight,
			maximumHeight,
		} );

		const circlePlanar = computeCirclePlanarExtents(
			centerLongitude,
			centerLatitude,
			fillRadiusMeters,
			renderRadiusMeters,
		);

		const color = new Color( options.fillColor );
		const alpha = normalizePercentOpacity( options.fillOpacity );

		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			circlePlanar.extents,
			color,
			alpha,
			options.renderOrder ?? 50,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible;
		this.classification.setClassificationType( options.classificationType );
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);
		this.classification.setCircleBorderStyle(
			circlePlanar.centerMeters,
			circlePlanar.fillRadiusMeters,
			circlePlanar.renderRadiusMeters,
			ringCount,
			ringGapMeters,
			sectorStartRadians,
			sectorAngleRadians,
		);
	}

	/**
	 * 更新逐帧 uniform。
	 *
	 * @param frameState 当前 Three 侧帧状态。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * 更新圆形命令块的渲染顺序。
	 *
	 * @param renderOrder 分配给 front-stencil 命令的基础顺序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。供桥接器在 GUI 改「分类目标」时热更新调用，
	 * 使图元改采样对应的 packed 深度纹理；不同步会导致采样旧纹理、标绘随相机漂浮。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.classification.setClassificationType( classificationType );
	}

	/**
	 * 释放资源。
	 */
	public dispose(): void {
		this.classification.dispose();
	}
}

/**
 * 贴地点标绘。点本质上是一种"特殊"图元——把 lon/lat 锚点 + 米尺寸映射到既有
 * 的圆形或矩形 shadow-volume 管线，而不是新增一套渲染路径：
 *   - shape='circle' → 委托给 CesiumGroundCirclePrimitive，center=position，
 *     radius=size/2。沿用圆形的扇区 / 环线 / 描边 shader 分支。
 *   - shape='square' → 委托给 CesiumGroundRectanglePrimitive，4 角点由 ENU 米
 *     偏移反算（±size/2 east/north），沿用矩形的轴对齐 fill + 描边路径。
 *
 * 这样描边 / 填充 / 命令 visibility / fragment culling / classification depth
 * 等所有精度修复都自动继承，不会引入任何新的着色器分支或几何路径。
 */
export class CesiumGroundPointPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly position: LonLatPoint;
	public readonly shape: CesiumGroundPointShape;
	public readonly size: number;

	private readonly delegate:
		| CesiumGroundCirclePrimitive
		| CesiumGroundRectanglePrimitive;

	public constructor( options: CesiumGroundPointPrimitiveOptions ) {
		const longitude = options.position?.[ 0 ];
		const latitude = options.position?.[ 1 ];
		if (
			! Number.isFinite( longitude ) ||
			! Number.isFinite( latitude ) ||
			longitude < - 180.0 ||
			longitude > 180.0 ||
			latitude < - 90.0 ||
			latitude > 90.0
		) {
			throw new Error( 'Ground point position must be a valid WGS84 [lon, lat] point.' );
		}

		const sizeMeters = Number.isFinite( options.size )
			? Math.max( options.size, 1.0 )
			: 1.0;

		this.position = [ longitude, latitude ];
		this.shape = options.shape;
		this.size = sizeMeters;

		if ( options.shape === 'circle' ) {
			this.delegate = new CesiumGroundCirclePrimitive( {
				center: this.position,
				radius: sizeMeters * 0.5,
				strokeColor: options.strokeColor,
				strokeWidth: options.strokeWidth,
				strokeOpacity: options.strokeOpacity,
				fillColor: options.fillColor,
				fillOpacity: options.fillOpacity,
				visible: options.visible,
				granularityRadians: options.granularityRadians,
				minimumHeight: options.minimumHeight,
				maximumHeight: options.maximumHeight,
				renderOrder: options.renderOrder,
				fragmentCull: options.fragmentCull,
				classificationType: options.classificationType,
			} );
		} else {
			const halfSize = sizeMeters * 0.5;
			// 4 角由 ENU 米偏移反算，沿用矩形 helper 的 cartographic → ECEF
			// 双精度路径，避免在高纬度退化为均匀 lon/lat 偏移。
			const cornerLonLat = longitudeLatitudeFromCenterOffsetsMeters(
				longitude,
				latitude,
				[
					{ eastMeters: - halfSize, northMeters: - halfSize },
					{ eastMeters: halfSize, northMeters: - halfSize },
					{ eastMeters: halfSize, northMeters: halfSize },
					{ eastMeters: - halfSize, northMeters: halfSize },
				],
			);
			const points: LonLatPoint[] = cornerLonLat.map(
				( c ) => [ c.longitude, c.latitude ] as LonLatPoint,
			);

			this.delegate = new CesiumGroundRectanglePrimitive( {
				points,
				strokeColor: options.strokeColor,
				strokeWidth: options.strokeWidth,
				strokeOpacity: options.strokeOpacity,
				fillColor: options.fillColor,
				fillOpacity: options.fillOpacity,
				visible: options.visible,
				granularityRadians: options.granularityRadians,
				minimumHeight: options.minimumHeight,
				maximumHeight: options.maximumHeight,
				renderOrder: options.renderOrder,
				fragmentCull: options.fragmentCull,
				classificationType: options.classificationType,
			} );
		}

		this.classification = this.delegate.classification;
	}

	/**
	 * 更新底层图元的逐帧 uniform。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.delegate.update( frameState );
	}

	/**
	 * 更新点图元命令块的渲染顺序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.delegate.setRenderOrder( renderOrder );
	}

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。转发给底层圆 / 矩形委托图元，使其改采样
	 * 对应的 packed 深度纹理；不同步会导致采样旧纹理、标绘随相机漂浮。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.delegate.setClassificationType( classificationType );
	}

	/**
	 * 释放资源。
	 */
	public dispose(): void {
		this.delegate.dispose();
	}
}

/**
 * 把 #rrggbb / css 颜色 + 0..100 不透明度解析成 Three Color + 0..1 alpha。
 */
function parseLineColor( strokeColor: string, strokeOpacity: number ): { color: Color; alpha: number } {
	return {
		color: new Color( strokeColor ),
		alpha: normalizePercentOpacity( strokeOpacity ),
	};
}

/**
 * 贴地折线（polyline）—— 与 polygon/rectangle/circle 等贴地面图元正交的
 * 「深度纹理重建分类法」单 pass 管线：每段 8 顶点 box + FS 内重建地形点 +
 * 三平面距离裁切 + 上色。无 stencil。详见 doc 00 §1。
 *
 * 公开方法：
 *   primitive.group              // Three.Group，scene.add(primitive.group)
 *   primitive.update(frameState) // 每帧
 *   primitive.setColor(...)
 *   primitive.setWidth(...)      // screen→px / world→m
 *   primitive.setRenderOrder(n)
 *   primitive.setVisible(b)
 *   primitive.dispose()
 */
export class CesiumGroundPolylinePrimitive {
	private readonly _group = new Group();
	private readonly uniforms: SharedUniforms;
	private readonly mesh: Mesh;
	private readonly material: RawShaderMaterial;
	private geometry: ReturnType<typeof buildLineShadowVolumeGeometry>;
	private readonly options: ResolvedLineOptions;
	private readonly cameraHigh = new Vector3();
	private readonly cameraLow = new Vector3();
	// 箭头是可选的次级 mesh，与线 mesh 同 group、同 uniform 表。`arrowColorExplicit`
	// 标志「箭头是否独立配色」——`setColor` 改线色时若为 false 则同步刷新箭头色，
	// 否则保持独立色不变。
	private arrowMesh?: Mesh;
	private arrowMaterial?: RawShaderMaterial;
	private arrowGeometry?: BufferGeometry;
	private arrowColorExplicit = false;
	private disposed = false;

	/**
	 * 分类目标：决定 {@link update} 采样哪张 packed 深度纹理（贴地形 / 贴模型 / 二者）。
	 * 默认 BOTH；单纹理宿主下不影响结果。可经 {@link setClassificationType} 热更新
	 * （GUI 改「分类目标」时由桥接器调用），故非 readonly。
	 */
	private classificationType: ClassificationType;

	public constructor( options: CesiumGroundPolylineOptions ) {
		this.options = resolvePublicLineOptions( options );
		this.classificationType = options.classificationType ?? ClassificationType.BOTH;

		// 1. 几何（line-shadow-volume facade）。一次性、纯 CPU。
		this.geometry = buildLineShadowVolumeGeometry(
			toLineShadowVolumeOptions( this.options ),
		);
		const userData = this.geometry.userData as LineGeometryUserData;

		// 2. 共享 uniform。线只用极小一部分共享键 + 自己的 9 个 line uniform；
		//    面图元那一大堆 (u_polygon* / u_circle* / extents / 等) 留占位值
		//    即可——materials.ts 的 prefix 把它们都声明为 inactive，运行期写
		//    入对 GPU 是 no-op，且面图元那侧用同名键 + 真值不受影响。
		const { color, alpha } = parseLineColor(
			this.options.strokeColor,
			this.options.strokeOpacity,
		);
		this.uniforms = createPolylineUniforms( color, alpha, this.options, userData.length3D );
		// `czm_encodedCameraPositionMC*` 是 RTE 解码的另一半（与每个顶点 RTE
		// 位置在 GPU 端做 `(p.high - eye.high) + (p.low - eye.low)`）。这里把
		// uniform 槽位的 value 指向类成员 Vector3，update() 每帧 in-place
		// 写入相机位置 high/low——与 CesiumClassificationPrimitive 的相机
		// 编码同步逻辑一致，否则线全在 ECEF 原点附近 ~6.4e6 m 处，相机看不到。
		( this.uniforms.czm_encodedCameraPositionMCHigh as { value: Vector3 } ).value = this.cameraHigh;
		( this.uniforms.czm_encodedCameraPositionMCLow as { value: Vector3 } ).value = this.cameraLow;

		// 3. 材质 + Mesh
		this.material = createPolylineMaterial( this.uniforms, this.options.debugVolume );
		this.mesh = new Mesh( this.geometry, this.material );
		this.mesh.name = 'CesiumGroundPolylineColorCommand';
		// 几何无 `position` 属性 → boundingSphere 空 → 必须关闭视锥剔除（doc 04 §11）。
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = this.options.renderOrder;
		// 不可拾取层：与其它贴地图元一致，相机 layers.enable(1) 才会渲染。
		this.mesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.mesh.visible = this.options.visible;
		this._group.add( this.mesh );

		// 4. 可选的箭头 mesh：与线共用 uniform 表，材质换 shader + 加
		//    ARROW define。renderOrder=line+1 让箭头画在线之上。
		if ( this.options.arrowMode !== ARROW_MODE.NONE ) {
			this.buildArrowMesh( userData );
		}
	}

	/**
	 * 构造或重建箭头 mesh。在 `options.arrowMode` 不是 NONE 时调用。
	 * 调用前需确保旧的 arrowMesh / Geometry / Material 已 dispose。
	 *
	 * @param userData 线几何 userData，含端点标架。
	 */
	private buildArrowMesh( userData: LineGeometryUserData ): void {
		// 颜色：调用方显式给了 arrowColor 就独立配色，否则跟随线色。
		if ( this.options.arrowColor !== undefined ) {
			this.arrowColorExplicit = true;
			const { color, alpha } = parseLineColor(
				this.options.arrowColor,
				this.options.arrowOpacity ?? this.options.strokeOpacity,
			);
			( this.uniforms.u_arrowColor as { value: Vector4 } ).value.set(
				color.r, color.g, color.b, alpha,
			);
		} else {
			this.arrowColorExplicit = false;
			const { color, alpha } = parseLineColor(
				this.options.strokeColor,
				this.options.strokeOpacity,
			);
			( this.uniforms.u_arrowColor as { value: Vector4 } ).value.set(
				color.r, color.g, color.b, alpha,
			);
		}

		this.arrowGeometry = buildArrowHeadGeometry(
			userData.startFrame,
			userData.endFrame,
			this.options.arrowMode,
			this.options.arrowStartStyle,
			this.options.arrowEndStyle,
		);
		// 单材质即可：两端样式由几何顶点属性 arrowStyleId 携带，FS 按 id 分派。
		this.arrowMaterial = createArrowHeadMaterial(
			this.uniforms,
			this.options.debugVolume,
		);
		this.arrowMesh = new Mesh( this.arrowGeometry, this.arrowMaterial );
		this.arrowMesh.name = 'CesiumGroundPolylineArrowCommand';
		this.arrowMesh.frustumCulled = false;
		this.arrowMesh.renderOrder = this.options.renderOrder + 1;
		this.arrowMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.arrowMesh.visible = this.options.visible;
		this._group.add( this.arrowMesh );
	}

	/**
	 * 拆掉当前 arrowMesh + geometry + material。`setArrowMode` 切端 → 重建 /
	 * dispose() 总清理 都用这条路径。
	 */
	private disposeArrowMesh(): void {
		if ( this.arrowMesh === undefined ) {
			return;
		}
		this._group.remove( this.arrowMesh );
		this.arrowGeometry?.dispose();
		this.arrowMaterial?.dispose();
		this.arrowMesh = undefined;
		this.arrowGeometry = undefined;
		this.arrowMaterial = undefined;
	}

	/** 把图元挂到场景：`scene.add(primitive.group)`。 */
	public get group(): Group {
		return this._group;
	}

	/** 每帧调用：刷新相机相关 uniform + 全局地形深度纹理。 */
	public update( frameState: CesiumGroundFrameState ): void {
		if ( this.disposed || ! this.mesh.visible ) {
			return;
		}
		// 先把相机位置编码到 high/low（与 CesiumClassificationPrimitive 完全一致）。
		// 漏掉这一步线就被 RTE 解码到 ECEF 原点附近，全帧不可见。
		encodeCesiumVector3( frameState.camera.position, this.cameraHigh, this.cameraLow );
		updateFrameStateUniforms( frameState, this.uniforms );
		// updateFrameStateUniforms 已写入默认深度纹理；按本线的分类目标覆盖为对应
		// packed 深度纹理（贴地形 / 贴模型 / 二者）。单纹理宿主下回退到同一张默认纹理。
		this.uniforms.czm_globeDepthTexture.value =
			resolveClassificationDepthTexture( frameState, this.classificationType );
	}

	/**
	 * 切换分类目标（贴地形 / 贴模型 / 二者）。供桥接器在 GUI 改「分类目标」时热更新调用，
	 * 使下一帧 {@link update} 改采样对应的 packed 深度纹理；不同步会导致采样旧纹理、
	 * 折线随相机漂浮。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		if ( classificationType !== undefined ) {
			this.classificationType = classificationType;
		}
	}

	/**
	 * 改线色。
	 *
	 * @param strokeColor  '#rrggbb' 或 css 颜色。
	 * @param strokeOpacity 0..100 百分比（与其它图元一致）。
	 */
	public setColor( strokeColor: string, strokeOpacity?: number ): void {
		const safeOpacity = Number.isFinite( strokeOpacity )
			? ( strokeOpacity as number )
			: this.options.strokeOpacity;
		const { color, alpha } = parseLineColor( strokeColor, safeOpacity );
		const u = this.uniforms.u_color as { value: Vector4 };
		u.value.set( color.r, color.g, color.b, alpha );
		this.options.strokeColor = strokeColor;
		this.options.strokeOpacity = safeOpacity;
		// 箭头未独立配色 → 跟随线色。
		if ( this.arrowMesh !== undefined && ! this.arrowColorExplicit ) {
			( this.uniforms.u_arrowColor as { value: Vector4 } ).value.set(
				color.r, color.g, color.b, alpha,
			);
		}
	}

	/**
	 * 改线宽。screen 模式传像素，world 模式传米。**只改当前模式对应的那一个
	 * uniform**——切换模式请用 `applyWidthState`，否则 `this.options.widthMode`
	 * 跟实际意图不一致时会写错 uniform。
	 *
	 * @param width 像素或米。
	 */
	public setWidth( width: number ): void {
		if ( this.options.widthMode === LineWidthMode.WORLD ) {
			( this.uniforms.u_lineWidthMeters as { value: number } ).value = width;
			this.options.widthMeters = width;
		} else {
			( this.uniforms.u_lineWidthPixels as { value: number } ).value = width;
			this.options.widthPixels = width;
		}
	}

	/**
	 * 一次性原子地刷新「线宽相关三件」——`u_lineWidthMode` + `u_lineWidthPixels`
	 * + `u_lineWidthMeters`，并同步 `this.options.widthMode/Pixels/Meters`。
	 *
	 * 为什么需要这条 API：单 `setWidth(value)` 用 `this.options.widthMode` 决定
	 * 写哪个 uniform。如果调用方在 GUI 上切了 `widthMode` 但没触发 rebuild，
	 * `this.options.widthMode` 还是旧值，`setWidth` 会写错 uniform，而且
	 * `u_lineWidthMode` 也没人更新 → 线的宽度模式跟显示对不上、且来回切
	 * 不回原状态。这条方法让宿主把 widthMode + 两个宽度值一次刷到位。
	 *
	 * @param mode         'screen' or 'world'。
	 * @param widthPixels  像素宽（即使当前是 world 模式也写入，便于切回）。
	 * @param widthMeters  米宽（即使当前是 screen 模式也写入，便于切回）。
	 */
	public applyWidthState(
		mode: 'screen' | 'world',
		widthPixels: number,
		widthMeters: number,
	): void {
		const enumMode = mode === 'world' ? LineWidthMode.WORLD : LineWidthMode.SCREEN;
		( this.uniforms.u_lineWidthMode as { value: number } ).value =
			enumMode === LineWidthMode.WORLD ? 1.0 : 0.0;
		( this.uniforms.u_lineWidthPixels as { value: number } ).value = widthPixels;
		( this.uniforms.u_lineWidthMeters as { value: number } ).value = widthMeters;
		this.options.widthMode = enumMode;
		this.options.widthPixels = widthPixels;
		this.options.widthMeters = widthMeters;
	}

	/** 改渲染顺序（直接设 mesh.renderOrder，无 stencil 三件套偏移）。 */
	public setRenderOrder( order: number ): void {
		this.mesh.renderOrder = order;
		this.options.renderOrder = order;
		if ( this.arrowMesh !== undefined ) {
			this.arrowMesh.renderOrder = order + 1;
		}
	}

	/** 改可见性。 */
	public setVisible( visible: boolean ): void {
		this.mesh.visible = visible;
		this._group.visible = visible;
		if ( this.arrowMesh !== undefined ) {
			this.arrowMesh.visible = visible;
		}
	}

	/**
	 * 切换箭头放置模式。NONE → 拆掉 arrowMesh；其它 → 重建 arrowMesh（端点数
	 * 变化需要新的几何）。颜色 / 大小变化不必走这条路径，分别用
	 * `setArrowColor` / `setArrowSize`。
	 *
	 * @param mode 'none' / 'left' / 'right' / 'both'。
	 */
	public setArrowMode( mode: CesiumGroundArrowMode ): void {
		const newMode = parseArrowMode( mode );
		if ( newMode === this.options.arrowMode && this.arrowMesh !== undefined ) {
			return; // 已经是这个 mode，不必重建。
		}
		this.disposeArrowMesh();
		this.options.arrowMode = newMode;
		this.syncLineArrowClipUniforms();
		if ( newMode === ARROW_MODE.NONE ) {
			return;
		}
		const userData = this.geometry.userData as LineGeometryUserData;
		this.buildArrowMesh( userData );
	}

	/**
	 * 切换两端箭头样式（统一设成同一样式）。要让两端不同请用 `setArrowStyles`。
	 *
	 * @param style 'solid' / 'open'。
	 */
	public setArrowStyle( style: CesiumGroundArrowStyle ): void {
		this.setArrowStyles( style, style );
	}

	/**
	 * 分别设置起 / 终端箭头样式——两端可不同（例：起点实心三角、终点开口雪佛龙）。
	 *
	 * 样式 id 烘焙在箭头几何的 `arrowStyleId` 顶点属性里，所以换样式需重建箭头
	 * 几何（材质单一、不带 style define，按 id 分派）。线 FS 的逐端收口 uniform
	 * 一并刷新——即使当前没有 arrowMesh 也先写，之后开启箭头时 clipEnabled 决定
	 * 是否生效。
	 *
	 * @param startStyle 起点端样式 'solid' / 'open'。
	 * @param endStyle   终点端样式 'solid' / 'open'。
	 */
	public setArrowStyles(
		startStyle: CesiumGroundArrowStyle,
		endStyle: CesiumGroundArrowStyle,
	): void {
		const newStart = parseArrowStyle( startStyle );
		const newEnd = parseArrowStyle( endStyle );
		if (
			newStart === this.options.arrowStartStyle &&
			newEnd === this.options.arrowEndStyle
		) {
			return;
		}
		this.options.arrowStartStyle = newStart;
		this.options.arrowEndStyle = newEnd;
		( this.uniforms.u_lineArrowStyleStart as { value: number } ).value =
			ARROW_STYLE_ID[ newStart ];
		( this.uniforms.u_lineArrowStyleEnd as { value: number } ).value =
			ARROW_STYLE_ID[ newEnd ];
		if ( this.arrowMesh === undefined ) {
			return; // 没启用箭头，等开启时再用新 style 建几何。
		}
		// 样式烘焙在几何顶点属性里 → 重建箭头几何（不只是换材质）。
		const userData = this.geometry.userData as LineGeometryUserData;
		this.disposeArrowMesh();
		this.buildArrowMesh( userData );
	}

	/**
	 * 把 `u_lineArrowClip{Start,End}Enabled` 同步成「对应端是否有箭头」的逻辑值。
	 * `setArrowMode` 改变端数时必须调一遍——否则线 FS 的 V 形收口会停留在
	 * 上一个状态（拔掉箭头还在收口、加上箭头不收口）。
	 * 与 style 无关（SOLID / OPEN 共享同一套 V 形几何边界）。
	 */
	private syncLineArrowClipUniforms(): void {
		const mode = this.options.arrowMode;
		const hasEnd = mode === ARROW_MODE.RIGHT || mode === ARROW_MODE.BOTH;
		const hasStart = mode === ARROW_MODE.LEFT || mode === ARROW_MODE.BOTH;
		( this.uniforms.u_lineArrowClipEndEnabled as { value: number } ).value =
			hasEnd ? 1.0 : 0.0;
		( this.uniforms.u_lineArrowClipStartEnabled as { value: number } ).value =
			hasStart ? 1.0 : 0.0;
	}

	/**
	 * 独立给箭头改色（设过之后 `setColor` 改线色不再波及箭头）。
	 *
	 * @param color   '#rrggbb' / css 颜色。
	 * @param opacity 0..100 百分比。缺省沿用线 strokeOpacity。
	 */
	public setArrowColor( color: string, opacity?: number ): void {
		this.arrowColorExplicit = true;
		const safeOpacity = Number.isFinite( opacity )
			? ( opacity as number )
			: this.options.strokeOpacity;
		const parsed = parseLineColor( color, safeOpacity );
		( this.uniforms.u_arrowColor as { value: Vector4 } ).value.set(
			parsed.color.r, parsed.color.g, parsed.color.b, parsed.alpha,
		);
		this.options.arrowColor = color;
		this.options.arrowOpacity = safeOpacity;
	}

	/**
	 * 改箭头尺寸模式（'screen' = 屏幕像素恒定，'world' = 世界米恒定）。
	 * 与线 widthMode 独立，对应 Cesium `Billboard.sizeInMeters` 语义。
	 *
	 * @param mode 'screen' or 'world'。
	 */
	public setArrowWidthMode( mode: 'screen' | 'world' ): void {
		const enumMode = mode === 'world' ? LineWidthMode.WORLD : LineWidthMode.SCREEN;
		( this.uniforms.u_arrowWidthMode as { value: number } ).value =
			enumMode === LineWidthMode.WORLD ? 1.0 : 0.0;
		this.options.arrowWidthMode = enumMode;
	}

	/**
	 * 改箭头屏幕像素尺寸（沿线长 + 基底全宽）。world 模式用 `setArrowSizeMeters`。
	 *
	 * @param lengthPixels 沿线长（屏幕像素）。
	 * @param widthPixels  基底全宽（屏幕像素）。
	 */
	public setArrowSize( lengthPixels: number, widthPixels: number ): void {
		( this.uniforms.u_arrowLengthPixels as { value: number } ).value = lengthPixels;
		( this.uniforms.u_arrowHalfWidthPixels as { value: number } ).value = widthPixels * 0.5;
		this.options.arrowLengthPixels = lengthPixels;
		this.options.arrowWidthPixels = widthPixels;
	}

	/**
	 * 改箭头世界米尺寸（仅在 u_arrowWidthMode=1 时生效）。
	 *
	 * @param lengthMeters 沿线长（米）。
	 * @param widthMeters  基底全宽（米）。
	 */
	public setArrowSizeMeters( lengthMeters: number, widthMeters: number ): void {
		( this.uniforms.u_arrowLengthMeters as { value: number } ).value = lengthMeters;
		( this.uniforms.u_arrowHalfWidthMeters as { value: number } ).value = widthMeters * 0.5;
		this.options.arrowLengthMeters = lengthMeters;
		this.options.arrowWidthMeters = widthMeters;
	}

	/** 释放 geometry / material（共享深度纹理由 CesiumGlobeDepth 管理，不动）。 */
	public dispose(): void {
		if ( this.disposed ) {
			return;
		}
		this.disposeArrowMesh();
		this._group.remove( this.mesh );
		this.geometry.dispose();
		this.material.dispose();
		this.disposed = true;
	}
}

/**
 * 构造 polyline 专用 uniform map。除了 `czm_*` 共享键和 `u_color` 之外，
 * 还含 9 个线专属键（czm_projection / czm_pixelRatio / 4 个线宽 / 4 个虚线）。
 * 面图元用到的所有 u_polygon* / u_circle* / extents 用占位值——polyline FS
 * 不读这些字段，但 prefix 里的 `uniform` 声明仍存在（inactive），写占位值
 * 既不影响编译也不影响其它材质。
 */
function createPolylineUniforms(
	color: Color,
	alpha: number,
	options: ResolvedLineOptions,
	length3D: number,
): SharedUniforms {
	const safeAlpha = Math.min( Math.max( alpha, 0.0 ), 1.0 );

	return {
		// Float64 + RTE 每帧刷新（与面图元一致）。
		czm_encodedCameraPositionMCHigh: { value: new Vector3() },
		czm_encodedCameraPositionMCLow: { value: new Vector3() },
		czm_modelViewRelativeToEye: { value: new Matrix4() },
		czm_modelViewProjectionRelativeToEye: { value: new Matrix4() },
		czm_normal: { value: new Matrix3() },
		czm_geometricToleranceOverMeter: { value: 0.0 },
		czm_sceneMode: { value: 3.0 },

		// 占位字段（polyline 不读，但与共享 SharedUniforms 接口保持兼容）
		u_globeMinimumAltitude: { value: CESIUM_GLOBE_MINIMUM_ALTITUDE },
		u_southWest_HIGH: { value: new Vector3() },
		u_southWest_LOW: { value: new Vector3() },
		u_eastward: { value: new Vector3() },
		u_northward: { value: new Vector3() },
		u_uvMinAndExtents: { value: new Vector4() },
		u_uMaxVmax: { value: new Vector4() },
		u_color: { value: new Vector4( color.r, color.g, color.b, safeAlpha ) },
		u_borderColor: { value: new Vector4( 1.0, 1.0, 1.0, 1.0 ) },
		u_borderEnabled: { value: 0.0 },
		u_borderWidthMeters: { value: 0.0 },
		u_innerMetersRect: { value: new Vector4() },
		u_cpuWestPlane: { value: new Vector4( 1.0, 0.0, 0.0, 0.0 ) },
		u_cpuSouthPlane: { value: new Vector4( 0.0, 1.0, 0.0, 0.0 ) },
		u_polygonBorderMode: { value: 0.0 },
		u_polygonMiterStrokeMode: { value: 0.0 },
		u_polygonPointCount: { value: 0.0 },
		u_polygonPoints: { value: [ new Vector2() ] },
		u_circleBorderMode: { value: 0.0 },
		u_circleCenterMeters: { value: new Vector2() },
		u_circleFillRadiusMeters: { value: 0.0 },
		u_circleRenderRadiusMeters: { value: 0.0 },
		u_circleRingCount: { value: 1.0 },
		u_circleRingGapMeters: { value: 0.0 },
		u_circleSectorStartRadians: { value: 0.0 },
		u_circleSectorAngleRadians: { value: Math.PI * 2.0 },

		// 共享每帧量
		czm_globeDepthTexture: { value: null },
		czm_viewport: { value: new Vector4( 0.0, 0.0, 1.0, 1.0 ) },
		czm_inverseProjection: { value: new Matrix4() },
		czm_viewportTransformation: { value: new Matrix4() },
		czm_frustumPlanes: { value: new Vector4() },
		czm_currentFrustum: { value: new Vector3() },
		czm_farDepthFromNearPlusOne: { value: 1.0 },
		czm_log2FarDepthFromNearPlusOne: { value: 1.0 },
		czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
		u_textTexture: { value: null },

		// ── 贴地线扩展 9 件套 ──
		czm_projection: { value: new Matrix4() },
		czm_pixelRatio: { value: 1.0 },
		u_lineWidthPixels: { value: options.widthPixels ?? LINE_DEFAULT_WIDTH_PIXELS },
		u_lineWidthMode: { value: options.widthMode === LineWidthMode.WORLD ? 1.0 : 0.0 },
		u_lineWidthMeters: { value: options.widthMeters },
		u_lineDashEnabled: { value: options.dashEnabled ? 1.0 : 0.0 },
		u_lineDashLengthMeters: { value: options.dashLengthMeters },
		u_lineGapLengthMeters: { value: options.gapLengthMeters },
		u_lineTotalMeters: { value: length3D },

		// ── 线端箭头 7 件套（线材质里这些 uniform 是 inactive，无副作用） ──
		// 箭头尺寸模式：与 Cesium `Billboard.sizeInMeters` 同义——0 = 屏幕像素恒定
		// （默认，对应 'screen'），1 = 世界米恒定（对应 'world'）。与线 widthMode
		// 解耦，调用方可独立控制；shader 端的分支用 `czm_branchFreeTernary` 切换
		// `Lm = u_arrowLengthMeters` vs `Lm = u_arrowLengthPixels × mpp`（与 Cesium
		// `BillboardCollectionVS.glsl` 的 `halfSize × ternary(sizeInMeters, 1.0, mpp)`
		// 完全一致）。
		u_arrowWidthMode: { value: options.arrowWidthMode === LineWidthMode.WORLD ? 1.0 : 0.0 },
		u_arrowLengthPixels: { value: options.arrowLengthPixels },
		u_arrowHalfWidthPixels: { value: options.arrowWidthPixels * 0.5 },
		u_arrowLengthMeters: { value: options.arrowLengthMeters },
		u_arrowHalfWidthMeters: { value: options.arrowWidthMeters * 0.5 },
		u_arrowColor: { value: new Vector4( color.r, color.g, color.b, safeAlpha ) },
		u_arrowStrokeHalfPixels: { value: options.arrowStrokeWidthPixels * 0.5 },
		// 线 FS 用，arrowMode 包含对应端时启用收口裁剪。
		u_lineArrowClipEndEnabled: {
			value: options.arrowMode === ARROW_MODE.RIGHT || options.arrowMode === ARROW_MODE.BOTH
				? 1.0 : 0.0,
		},
		u_lineArrowClipStartEnabled: {
			value: options.arrowMode === ARROW_MODE.LEFT || options.arrowMode === ARROW_MODE.BOTH
				? 1.0 : 0.0,
		},
		// 起 / 终端各自的箭头样式 id（与 ARROW_STYLE_ID 对齐）。线 FS 按各端 id 选
		// 收口策略：solid 整段收平到 base、open 收窄成 V 形。两端独立。
		u_lineArrowStyleStart: { value: ARROW_STYLE_ID[ options.arrowStartStyle ] },
		u_lineArrowStyleEnd: { value: ARROW_STYLE_ID[ options.arrowEndStyle ] },
	} as unknown as SharedUniforms;
}
