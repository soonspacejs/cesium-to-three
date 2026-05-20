// ============================================================
// primitives.ts
// Layer: Ground primitive construction (rectangle is now Cesium-free).
// Role: build rectangle and polygon shadow volumes;矩形路径使用本地 math/ +
//       rectangle/ 模块,polygon 路径仍使用 Cesium。两者共享 classification 运行时。
// Dependencies: Three.js debug meshes, 本地 ground rectangle/math 模块,
//       polygon 路径保留 Cesium Core(PolygonGeometry / Ellipsoid /
//       VertexFormat / GeometryPipeline)。
// Consumed by: public ground adapter and demos.
// ============================================================

import {
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	type Material,
} from 'three';

// 矩形路径不再 import Cesium Rectangle / RectangleGeometry,
// 但 polygon 路径仍需 Cesium Core 几何生成 API,因此下面 4 个 import 保留。

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import PolygonGeometry from '../../../cesium-ground-source/engine/Source/Core/PolygonGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import VertexFormat from '../../../cesium-ground-source/engine/Source/Core/VertexFormat.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import GeometryPipeline from '../../../cesium-ground-source/engine/Source/Core/GeometryPipeline.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartographic from '../../../cesium-ground-source/engine/Source/Core/Cartographic.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartesian3 from '../../../cesium-ground-source/engine/Source/Core/Cartesian3.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Matrix4Cesium from '../../../cesium-ground-source/engine/Source/Core/Matrix4.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Transforms from '../../../cesium-ground-source/engine/Source/Core/Transforms.js';

import { CesiumClassificationPrimitive } from './classification';
import {
	BORDER_GEOMETRY_EXPANSION_SCALE,
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	MAX_POLYGON_STYLE_VERTICES,
} from './constants';
import {
	cesiumGeometryToThree,
	computePolygonPlanarStylePoints,
	computePolygonPlanarExtents,
	polygonHierarchyDegreesToCesium,
} from './geometry';
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
	CartesianLike,
	CesiumGeometryResult,
	CesiumGroundFrameState,
	CesiumGroundPolygonPrimitiveOptions,
	CesiumGroundRectanglePrimitiveOptions,
	LonLatPoint,
	PolygonHierarchyDegrees,
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
 * Validates and clones public polygon lon/lat points.
 *
 * @param points Public polygon points as [lon, lat] degree pairs.
 * @returns Cloned points in their original winding order.
 */
function normalizePolygonPoints( points: readonly LonLatPoint[] ): LonLatPoint[] {
	if ( points.length < 3 ) {
		throw new Error( 'Cesium ground polygon requires at least three lon/lat points.' );
	}
	if ( points.length > MAX_POLYGON_STYLE_VERTICES ) {
		throw new Error( `Cesium ground polygon supports at most ${ MAX_POLYGON_STYLE_VERTICES } points.` );
	}

	return points.map( ( point ) => {
		const longitude = point[ 0 ];
		const latitude = point[ 1 ];

		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
			throw new Error( 'Cesium ground polygon points must contain finite lon/lat numbers.' );
		}
		if (
			longitude < -180.0 ||
			longitude > 180.0 ||
			latitude < -90.0 ||
			latitude > 90.0
		) {
			throw new Error( 'Cesium ground polygon points must be valid WGS84 lon/lat degrees.' );
		}

		return [ longitude, latitude ];
	} );
}

/**
 * Converts public lon/lat point arrays to the internal hierarchy shape.
 *
 * @param points Outer ring [lon, lat] degree points.
 * @param holes Optional hole rings in [lon, lat] degrees.
 * @returns Polygon hierarchy in object lon/lat degrees.
 */
function polygonHierarchyDegreesFromLonLatPoints(
	points: readonly LonLatPoint[],
	holes: readonly ( readonly LonLatPoint[] )[] = [],
): PolygonHierarchyDegrees {
	const normalizedPoints = normalizePolygonPoints( points );
	const normalizedHoles = holes.map( normalizePolygonPoints );

	return {
		positions: normalizedPoints.map( point => ( {
			longitude: point[ 0 ],
			latitude: point[ 1 ],
		} ) ),
		holes: normalizedHoles.length > 0
			? normalizedHoles.map( hole => ( {
				positions: hole.map( point => ( {
					longitude: point[ 0 ],
					latitude: point[ 1 ],
				} ) ),
			} ) )
			: undefined,
	};
}

/**
 * Computes a simple degree-space centroid for local polygon expansion.
 *
 * @param points Valid WGS84 lon/lat points.
 * @returns Centroid in degree coordinates.
 */
function computePolygonCentroidDegrees( points: readonly LonLatPoint[] ): LonLatPoint {
	let longitudeSum = 0.0;
	let latitudeSum = 0.0;

	for ( const point of points ) {
		longitudeSum += point[ 0 ];
		latitudeSum += point[ 1 ];
	}

	return [
		longitudeSum / points.length,
		latitudeSum / points.length,
	];
}

/**
 * Expands a lon/lat polygon away from its centroid by a meter distance.
 *
 * The expansion is intentionally done in the local tangent plane because the
 * requested stroke width is a meter-space styling value, while Cesium still
 * owns the final ellipsoid shadow-volume tessellation.
 *
 * @param points Original fill polygon [lon, lat] points.
 * @param borderWidthMeters Stroke width in meters.
 * @returns Render polygon points expanded to cover the stroke band.
 */
function expandPolygonPointsThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
): LonLatPoint[] {
	const safeWidthMeters = Math.max( borderWidthMeters, 0.0 ) * BORDER_GEOMETRY_EXPANSION_SCALE;
	if ( safeWidthMeters === 0.0 ) {
		return points.map( point => [ point[ 0 ], point[ 1 ] ] );
	}

	const centroid = computePolygonCentroidDegrees( points );
	const centerCartographic = new Cartographic(
		centroid[ 0 ] * Math.PI / 180.0,
		centroid[ 1 ] * Math.PI / 180.0,
		0.0,
	);
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const pointCartographic = new Cartographic();
	const pointCartesian = new Cartesian3();
	const pointEnu = new Cartesian3();

	return points.map( ( point ) => {
		pointCartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		pointCartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		pointCartographic.height = 0.0;
		Ellipsoid.WGS84.cartographicToCartesian( pointCartographic, pointCartesian );
		Matrix4Cesium.multiplyByPoint( inverseEnu, pointCartesian, pointEnu );

		const length = Math.hypot( pointEnu.x, pointEnu.y );
		if ( length > 1e-6 ) {
			const expansion = safeWidthMeters / length;
			pointEnu.x += pointEnu.x * expansion;
			pointEnu.y += pointEnu.y * expansion;
		}

		Matrix4Cesium.multiplyByPoint( enuMatrix, pointEnu, pointCartesian );
		Ellipsoid.WGS84.cartesianToCartographic( pointCartesian, pointCartographic );

		return [
			pointCartographic.longitude * 180.0 / Math.PI,
			pointCartographic.latitude * 180.0 / Math.PI,
		];
	} );
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
 * Ground polygon implemented with Cesium PolygonGeometry.createShadowVolume.
 *
 * Polygon 路径在本期保持不变,继续使用 Cesium 几何流水线。
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };
	public readonly rotationDegrees: number;
	public readonly dentRatio: number;
	public readonly hole: boolean;

	public constructor( options: CesiumGroundPolygonPrimitiveOptions ) {
		const fillPoints = normalizePolygonPoints( options.points );
		this.rotationDegrees = Number.isFinite( options.rotationDegrees )
			? options.rotationDegrees
			: 0.0;
		this.dentRatio = Number.isFinite( options.dentRatio )
			? Math.min( Math.max( options.dentRatio, 0.05 ), 1.0 )
			: 1.0;
		this.hole = options.hole === true;
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		const renderPoints = expandPolygonPointsThroughMeters(
			fillPoints,
			strokeWidthMeters,
		);
		const fillHierarchyDegrees = polygonHierarchyDegreesFromLonLatPoints(
			fillPoints,
			this.hole ? options.holes ?? [] : [],
		);
		const renderHierarchyDegrees = polygonHierarchyDegreesFromLonLatPoints(
			renderPoints,
			this.hole ? options.holes ?? [] : [],
		);
		const renderPolygonHierarchy = polygonHierarchyDegreesToCesium( renderHierarchyDegrees );
		const fillPolygonHierarchy = polygonHierarchyDegreesToCesium( fillHierarchyDegrees );
		this.polygonHierarchy = fillPolygonHierarchy;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const polygonGeometry = new PolygonGeometry( {
			polygonHierarchy: renderPolygonHierarchy,
			ellipsoid: Ellipsoid.WGS84,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
			perPositionHeight: false,
		} );
		const shadowVolumeGeometry = PolygonGeometry.createShadowVolume(
			polygonGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = PolygonGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult;

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );

		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const extents = computePolygonPlanarExtents(
			polygonGeometry.rectangle,
			renderPolygonHierarchy,
			Ellipsoid.WGS84,
			maximumHeight,
		);
		const stylePoints = computePolygonPlanarStylePoints(
			polygonGeometry.rectangle,
			renderPolygonHierarchy,
			fillPoints,
			Ellipsoid.WGS84,
			maximumHeight,
		);
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
