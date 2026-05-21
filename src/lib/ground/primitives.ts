// ============================================================
// primitives.ts
// Layer: Cesium GroundPrimitive geometry construction.
// Role: build rectangle and polygon shadow volumes with unmodified Cesium
//       geometry generators, then wrap them in Three classification commands.
// Dependencies: Cesium Core geometry, Three.js debug meshes, ground geometry
//       helpers, and classification command group.
// Consumed by: public ground adapter and demos.
// ============================================================

import {
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	type Material,
} from 'three';

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Rectangle from '../../../cesium-ground-source/engine/Source/Core/Rectangle.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import RectangleGeometry from '../../../cesium-ground-source/engine/Source/Core/RectangleGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import PolygonGeometry from '../../../cesium-ground-source/engine/Source/Core/PolygonGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import VertexFormat from '../../../cesium-ground-source/engine/Source/Core/VertexFormat.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import GeometryPipeline from '../../../cesium-ground-source/engine/Source/Core/GeometryPipeline.js';

import { CesiumClassificationPrimitive } from './classification';
import {
	cesiumGeometryToThree,
	computePlanarExtents,
	computePolygonPlanarExtents,
	createDebugRectangleSurfaceGeometry,
	expandRectangleDegreesThroughMeters,
	polygonHierarchyDegreesToCesium,
	rectangleDegreesFromLonLatPoints,
} from './geometry';
import { getTerrainMinMaxHeightsForRectangle } from './terrain-heights';
import type {
	CartesianLike,
	CesiumGeometryResult,
	CesiumGroundFrameState,
	CesiumGroundPolygonOptions,
	CesiumGroundRectanglePrimitiveOptions,
	PolygonHierarchyDegrees,
	RectangleDegrees,
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
 * Resolves the minimum and maximum extrusion heights used by Cesium's
 * RectangleGeometry / PolygonGeometry shadow volume.
 *
 * Cesium's GroundPrimitive feeds these from
 * ApproximateTerrainHeights.getMinimumMaximumHeights, so the shadow volume
 * is just thick enough to fully contain the rendered terrain. The previous
 * adapter shipped a hardcoded `±CESIUM_GLOBE_MINIMUM_ALTITUDE` (110 km thick
 * shadow volume), which combined with the vertex-shader extrude pushed the
 * top face up to 165 km above terrain and amplified depth-precision jitter
 * at oblique angles.
 *
 * Caller-supplied overrides win, otherwise the terrain-aware query result is
 * used. If the terrain table is not initialized yet, the underlying helper
 * returns the Cesium default range (-100000 ... +9000).
 *
 * @param rectangleDegrees Plot rectangle in WGS84 degrees.
 * @param minimumHeightOverride Optional explicit minimum height.
 * @param maximumHeightOverride Optional explicit maximum height.
 * @returns Resolved min/max heights used by createShadowVolume.
 */
function resolveShadowVolumeHeights(
	rectangleDegrees: RectangleDegrees,
	minimumHeightOverride: number | undefined,
	maximumHeightOverride: number | undefined,
): { minimumHeight: number; maximumHeight: number } {
	const terrainHeights = getTerrainMinMaxHeightsForRectangle( rectangleDegrees );
	const minimumHeight = Number.isFinite( minimumHeightOverride )
		? ( minimumHeightOverride as number )
		: terrainHeights.minimumTerrainHeight;
	let maximumHeight = Number.isFinite( maximumHeightOverride )
		? ( maximumHeightOverride as number )
		: terrainHeights.maximumTerrainHeight;
	if ( maximumHeight <= minimumHeight ) {
		// Preserve a non-degenerate shadow volume even when the table reports a
		// bad sample for the queried tile.
		maximumHeight = minimumHeight + 1.0;
	}

	return { minimumHeight, maximumHeight };
}

/**
 * Computes the polygon's axis-aligned WGS84 rectangle in degrees, used to
 * query ApproximateTerrainHeights for the shadow volume's height window.
 *
 * @param hierarchy Polygon hierarchy in degrees.
 * @returns Outer rectangle bounding the polygon outer ring, in degrees.
 */
function rectangleDegreesFromPolygonHierarchy(
	hierarchy: PolygonHierarchyDegrees,
): RectangleDegrees {
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( const point of hierarchy.positions ) {
		if ( ! Number.isFinite( point.longitude ) || ! Number.isFinite( point.latitude ) ) {
			continue;
		}
		west = Math.min( west, point.longitude );
		east = Math.max( east, point.longitude );
		south = Math.min( south, point.latitude );
		north = Math.max( north, point.latitude );
	}

	if (
		! Number.isFinite( west ) || ! Number.isFinite( east ) ||
		! Number.isFinite( south ) || ! Number.isFinite( north ) ||
		east <= west || north <= south
	) {
		throw new Error( 'Polygon hierarchy must contain at least three finite lon/lat points forming a non-degenerate ring.' );
	}

	return { west, south, east, north };
}

/**
 * Ground rectangle implemented with Cesium RectangleGeometry.createShadowVolume.
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: unknown;

	public constructor( options: CesiumGroundRectanglePrimitiveOptions ) {
		const rectangleDegrees = rectangleDegreesFromLonLatPoints( options.points );
		const fillRectangle = Rectangle.fromDegrees(
			rectangleDegrees.west,
			rectangleDegrees.south,
			rectangleDegrees.east,
			rectangleDegrees.north,
		);
		const strokeWidthMeters = Math.max( Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0, 0.0 );
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			rectangleDegrees,
			strokeWidthMeters,
		);
		const renderRectangle = Rectangle.fromDegrees(
			renderRectangleDegrees.west,
			renderRectangleDegrees.south,
			renderRectangleDegrees.east,
			renderRectangleDegrees.north,
		);
		this.rectangle = fillRectangle;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			renderRectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);
		const rectangleGeometry = new RectangleGeometry( {
			rectangle: renderRectangle,
			ellipsoid: Ellipsoid.WGS84,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
		} );
		const shadowVolumeGeometry = RectangleGeometry.createShadowVolume(
			rectangleGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = RectangleGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult;

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );

		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const extents = computePlanarExtents( renderRectangle, Ellipsoid.WGS84, maximumHeight, fillRectangle );
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

		this.debugSurface = null;
		if ( options.debugSurface === true ) {
			const debugThreeGeometry = createDebugRectangleSurfaceGeometry(
				fillRectangle as RectangleRadians,
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
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };

	public constructor( options: CesiumGroundPolygonOptions ) {
		const polygonHierarchy = polygonHierarchyDegreesToCesium( options.polygonHierarchyDegrees );
		this.polygonHierarchy = polygonHierarchy;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const rectangleDegrees = rectangleDegreesFromPolygonHierarchy( options.polygonHierarchyDegrees );
		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			rectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);
		const polygonGeometry = new PolygonGeometry( {
			polygonHierarchy,
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
			polygonHierarchy,
			Ellipsoid.WGS84,
			maximumHeight,
		);
		const color = new Color( options.color ?? 0x00aaff );
		const alpha = options.alpha ?? 0.65;
		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 30,
			options.fragmentCull ?? true,
		);
		this.classification.setBorderStyle( false, new Color( 0xffffff ), 0.0, 0.0 );
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
