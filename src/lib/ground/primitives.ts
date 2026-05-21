// ============================================================
// primitives.ts
// Layer: Ground primitive construction(rectangle 与 polygon 路径均已 Cesium-free)。
// Role: build rectangle and polygon shadow volumes。
//       两条路径都基于本地 math/ + rectangle/ + polygon/ 模块,完全不再 import
//       cesium-ground-source 中的任何对象。共享 classification 运行时(`classification.ts`
//       不动)。
// Dependencies: Three.js debug meshes,本地 ground rectangle/polygon/math 模块。
// Consumed by: public ground adapter and demos。
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	type Material,
} from 'three';

// Circle is intentionally kept coupled to Cesium Core for the validation stage.
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import CircleGeometry from '../../../cesium-ground-source/engine/Source/Core/CircleGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartesian3 from '../../../cesium-ground-source/engine/Source/Core/Cartesian3.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import GeometryPipeline from '../../../cesium-ground-source/engine/Source/Core/GeometryPipeline.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import VertexFormat from '../../../cesium-ground-source/engine/Source/Core/VertexFormat.js';

import { CesiumClassificationPrimitive } from './classification';
import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
} from './constants';
import { computeCirclePlanarExtents } from './circle/circle-extents';
import {
	expandPolygonPointsThroughMeters,
} from './polygon/polygon-helpers';
import {
	normalizePolygonPoints,
	polygonHierarchyFromLonLatPoints,
	type PolygonHierarchy,
} from './polygon/polygon-hierarchy';
import { POLYGON_DEFAULT_GRANULARITY } from './polygon/polygon-options';
import { computePolygonPlanarExtents } from './polygon/polygon-extents';
import {
	buildPolygonShadowVolumeGeometry,
	type PolygonGeometryUserData,
} from './polygon/polygon-shadow-volume';
import { computePolygonPlanarStylePoints } from './polygon/polygon-style-points';
import { createDebugRectangleSurfaceGeometry } from './rectangle/rectangle-debug';
import { computeRectanglePlanarExtents } from './rectangle/rectangle-extents';
import {
	expandRectangleDegreesThroughMeters,
	rectangleDegreesFromLonLatPoints,
} from './rectangle/rectangle-helpers';
import {
	rectangleRadiansFromDegrees,
} from './rectangle/rectangle-radians';
import { buildRectangleShadowVolumeGeometry } from './rectangle/rectangle-shadow-volume';
import type {
	CesiumGeometryResult,
	CesiumGroundCirclePrimitiveOptions,
	CesiumGroundFrameState,
	CesiumGroundPolygonPrimitiveOptions,
	CesiumGroundRectanglePrimitiveOptions,
	RectangleRadians,
} from './types';

/**
 * Converts SoonSpace-style integer opacity into the normalized shader range.
 *
 * @param opacity Percent opacity in the 0-100 store format.
 * @returns Clamped opacity in the 0-1 range used by Three uniforms.
 */
function normalizePercentOpacity( opacity: number ): number {
	const safeOpacity = Number.isFinite( opacity ) ? opacity : 100.0;
	return Math.min( Math.max( safeOpacity, 0.0 ), 100.0 ) / 100.0;
}

/**
 * Converts Cesium Geometry attributes to a Three BufferGeometry.
 *
 * This adapter is used only by Cesium-coupled primitives such as CircleGeometry.
 * Rectangle and polygon already use local Cesium-free builders.
 *
 * @param cesiumGeometry Geometry returned by Cesium createGeometry.
 * @returns Three BufferGeometry with matching attribute names.
 */
function cesiumGeometryToThree( cesiumGeometry: CesiumGeometryResult ): BufferGeometry {
	if (
		! cesiumGeometry ||
		! cesiumGeometry.attributes ||
		Object.keys( cesiumGeometry.attributes ).length === 0
	) {
		throw new Error( 'Cesium geometry conversion failed: geometry has no vertex attributes.' );
	}

	const geometry = new BufferGeometry();

	for ( const [ name, attribute ] of Object.entries( cesiumGeometry.attributes ) ) {
		const sourceValues = attribute.values;
		const values = sourceValues instanceof Float32Array
			? sourceValues
			: new Float32Array( Array.from( sourceValues ) );

		geometry.setAttribute(
			name,
			new BufferAttribute( values, attribute.componentsPerAttribute ),
		);
	}

	const firstAttribute = Object.values( cesiumGeometry.attributes )[ 0 ];
	const vertexCount = firstAttribute.values.length / firstAttribute.componentsPerAttribute;
	geometry.setAttribute( 'batchId', new BufferAttribute( new Float32Array( vertexCount ), 1 ) );

	if ( cesiumGeometry.indices ) {
		const indices = cesiumGeometry.indices;
		const indexArray = indices instanceof Uint16Array || indices instanceof Uint32Array
			? indices
			: new Uint32Array( Array.from( indices ) );
		geometry.setIndex( new BufferAttribute( indexArray, 1 ) );
	}

	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Ground rectangle implemented with the native rectangle shadow-volume pipeline.
 *
 * 本类的公共 API(类名、构造选项、`update / setRenderOrder / dispose` 方法、
 * `classification / debugSurface / rectangle` 字段)与重构前完全一致;
 * 内部 6 步 Cesium 几何调用(Rectangle.fromDegrees → new RectangleGeometry →
 * createShadowVolume → createGeometry → encodeAttribute → cesiumGeometryToThree)
 * 被替换为 1 步 `buildRectangleShadowVolumeGeometry`,plot-spec 4 lon/lat 点
 * 适配、米外扩、opacity 归一化、setBorderStyle / visible 控制全部保留不动。
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: RectangleRadians;

	public constructor( options: CesiumGroundRectanglePrimitiveOptions ) {
		// ── plot-spec 4 lon/lat 点 → 轴对齐度矩形 ──
		const rectangleDegrees = rectangleDegreesFromLonLatPoints( options.points );

		// ── strokeWidth 米外扩 → render 度矩形 ──
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			rectangleDegrees,
			strokeWidthMeters,
		);

		// ── 度→弧度(fill 与 render 两份)──
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

		// ── 默认值 ──
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;

		// ── 几何构造(1 步取代原 6 步 Cesium 调用)──
		const threeGeometry = buildRectangleShadowVolumeGeometry( {
			rectangle: renderRectangleRadians,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// ── PlanarExtents uniforms ──
		const extents = computeRectanglePlanarExtents(
			renderRectangleRadians,
			fillRectangleRadians,
			maximumHeight,
		);

		// ── 颜色 / opacity 归一化(0-100 → 0-1,保留行为)──
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
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);

		// ── Debug 椭球面网格(可选)──
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
			this.classification.group.add( this.debugSurface );
		}
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Updates this rectangle's command-block render order.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
		if ( this.debugSurface ) {
			this.debugSurface.renderOrder = renderOrder + 2;
		}
	}

	/**
	 * Releases resources.
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
 * Ground polygon implemented with the native polygon shadow-volume pipeline.
 *
 * 本类的公共 API(类名、构造选项、`update / setRenderOrder / dispose` 方法、
 * `classification / polygonHierarchy / rotationDegrees / dentRatio / hole`
 * 字段)与重构前完全一致;内部 6 步 Cesium 几何调用
 * (polygonHierarchyDegreesToCesium → new PolygonGeometry → createShadowVolume →
 * createGeometry → GeometryPipeline.encodeAttribute → cesiumGeometryToThree)
 * 被替换为 1 步 `buildPolygonShadowVolumeGeometry`,plot-spec 校验、stroke 米外扩、
 * opacity 归一化、setBorderStyle / setPolygonBorderPoints / visible 控制全部保留不动。
 *
 * `polygonHierarchy` 字段类型从 `{ positions: CartesianLike[]; holes: unknown[] }`
 * 改为 `PolygonHierarchy`(Vector3 ECEF + Vector3 hole),Vector3 与 Cesium Cartesian3
 * 在 `CartesianLike`(`.x .y .z`)契约上结构兼容,但 `instanceof Cesium.Cartesian3`
 * 与 Cesium 特有 API 调用不可用(R7 文档化决策)。
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: PolygonHierarchy;
	public readonly rotationDegrees: number;
	public readonly dentRatio: number;
	public readonly hole: boolean;

	public constructor( options: CesiumGroundPolygonPrimitiveOptions ) {
		// ── plot-spec 校验 + 浅拷贝 ──
		// normalizePolygonPoints 在 polygon-hierarchy.ts 中迁移版本上还增加了
		// 跨 IDL / 极地保护(R6),非合法输入会抛 Error。
		const fillPoints = normalizePolygonPoints( options.points );

		// ── 旋转 / 凹陷比 / hole 开关 ──
		this.rotationDegrees = Number.isFinite( options.rotationDegrees )
			? options.rotationDegrees
			: 0.0;
		this.dentRatio = Number.isFinite( options.dentRatio )
			? Math.min( Math.max( options.dentRatio, 0.05 ), 1.0 )
			: 1.0;
		this.hole = options.hole === true;

		// ── 描边宽度(米)归一化 ──
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);

		// ── fill → render 米外扩(plot-spec 描边覆盖区)──
		const renderPoints = expandPolygonPointsThroughMeters(
			fillPoints,
			strokeWidthMeters,
		);

		// ── 构建两份 PolygonHierarchy(Vector3 ECEF;一步到位,不经 Cesium 中间格式)──
		const holesInput = this.hole ? options.holes ?? [] : [];
		const fillHierarchy = polygonHierarchyFromLonLatPoints( fillPoints, holesInput );
		const renderHierarchy = polygonHierarchyFromLonLatPoints( renderPoints, holesInput );
		this.polygonHierarchy = fillHierarchy;

		// ── 默认值 ──
		const granularity = options.granularityRadians ?? POLYGON_DEFAULT_GRANULARITY;
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;

		// ── 几何构造(1 步取代原 6 步 Cesium 调用)──
		const threeGeometry = buildPolygonShadowVolumeGeometry( {
			hierarchy: renderHierarchy,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// ── 从 BufferGeometry.userData 取 polygonRectangle(由 buildPolygonShadowVolumeGeometry 挂载)──
		const userData = threeGeometry.userData as PolygonGeometryUserData;
		const polygonRectangle = userData.polygonRectangle;

		// ── PlanarExtents uniforms + style points(用 render hierarchy + fill 顶点)──
		const extents = computePolygonPlanarExtents(
			polygonRectangle,
			renderHierarchy,
			maximumHeight,
		);
		const stylePoints = computePolygonPlanarStylePoints(
			polygonRectangle,
			renderHierarchy,
			fillPoints,
			maximumHeight,
		);

		// ── 颜色 / opacity 归一化(0-100 → 0-1,保留行为)──
		const color = new Color( options.fillColor );
		const alpha = normalizePercentOpacity( options.fillOpacity );

		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 30,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible;
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);
		this.classification.setPolygonBorderPoints( stylePoints );
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Updates this polygon's command-block render order.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * Releases resources.
	 */
	public dispose(): void {
		this.classification.dispose();
	}
}

/**
 * Ground circle implemented with Cesium CircleGeometry for validation.
 *
 * This class intentionally imports CircleGeometry from cesium-ground-source so
 * the first circle implementation can be compared against Cesium behavior
 * before any local decoupled implementation is attempted.
 */
export class CesiumGroundCirclePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly center: [ number, number ];
	public readonly radius: number;

	public constructor( options: CesiumGroundCirclePrimitiveOptions ) {
		const centerLongitude = options.center[ 0 ];
		const centerLatitude = options.center[ 1 ];
		if (
			! Number.isFinite( centerLongitude ) ||
			! Number.isFinite( centerLatitude ) ||
			centerLongitude < -180.0 ||
			centerLongitude > 180.0 ||
			centerLatitude < -90.0 ||
			centerLatitude > 90.0
		) {
			throw new Error( 'Cesium ground circle center must be a valid WGS84 [lon, lat] point.' );
		}

		const fillRadiusMeters = Number.isFinite( options.radius )
			? Math.max( options.radius, 1.0 )
			: 1.0;
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		const renderRadiusMeters = fillRadiusMeters + strokeWidthMeters;
		const requestedRingCount = options.ringCount ?? 1.0;
		const requestedRingGapRatio = options.ringGapRatio ?? 0.0;
		const ringCount = Number.isFinite( requestedRingCount )
			? Math.max( Math.floor( requestedRingCount ), 1.0 )
			: 1.0;
		const ringGapRatio = Number.isFinite( requestedRingGapRatio )
			? Math.max( requestedRingGapRatio, 0.0 )
			: 0.0;
		this.center = [ centerLongitude, centerLatitude ];
		this.radius = fillRadiusMeters;

		const requestedGranularity = options.granularityRadians ?? ( Math.PI / 180.0 );
		const granularity = Number.isFinite( requestedGranularity )
			? Math.min(
				Math.max( requestedGranularity, MIN_CIRCLE_GRANULARITY_RADIANS ),
				MAX_CIRCLE_GRANULARITY_RADIANS,
			)
			: Math.PI / 180.0;
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const centerCartesian = Cartesian3.fromDegrees(
			centerLongitude,
			centerLatitude,
			0.0,
			Ellipsoid.WGS84,
			new Cartesian3(),
		);
		const circleGeometry = new CircleGeometry( {
			center: centerCartesian,
			radius: renderRadiusMeters,
			ellipsoid: Ellipsoid.WGS84,
			height: options.height ?? 0.0,
			extrudedHeight: options.extrudedHeight,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
			stRotation: options.stRotationRadians ?? 0.0,
		} );
		const shadowVolumeGeometry = CircleGeometry.createShadowVolume(
			circleGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = CircleGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult | undefined;
		if ( cesiumGeometry === undefined ) {
			throw new Error( 'Cesium CircleGeometry.createGeometry returned undefined.' );
		}

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );
		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const circlePlanar = computeCirclePlanarExtents(
			centerLongitude,
			centerLatitude,
			fillRadiusMeters,
			renderRadiusMeters,
			maximumHeight,
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
			ringGapRatio,
		);
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Updates this circle's command-block render order.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * Releases resources.
	 */
	public dispose(): void {
		this.classification.dispose();
	}
}
