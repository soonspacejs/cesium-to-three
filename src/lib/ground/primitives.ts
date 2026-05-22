// ============================================================
// primitives.ts
// Layer: ground primitive construction (rectangle and polygon paths are now
//        Cesium-free for geometry generation).
// Role:  build rectangle and polygon shadow volumes using the native modules
//        under math/, rectangle/, and polygon/. The classification runtime
//        (classification.ts, materials.ts, depth.ts, terrain-log-depth.ts,
//        terrain-heights.ts) is deliberately untouched — every precision
//        fix landed for the jitter issue (Float64 MVP, LOG_DEPTH, dynamic
//        czm_geometricToleranceOverMeter, LessEqualDepth stencil, terrain
//        log-depth injection, ApproximateTerrainHeights window) stays
//        bit-for-bit identical.
// Dependencies: Three.js debug meshes, native rectangle/polygon/math modules,
//        classification primitive runtime, ApproximateTerrainHeights query.
// Consumed by: public ground adapter and demos.
// ============================================================

import {
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	Vector3,
	type Material,
} from 'three';

import { CesiumClassificationPrimitive } from './classification';
import { computePolygonPlanarExtents } from './polygon/polygon-extents';
import {
	polygonHierarchyFromLonLatPoints,
	type PolygonHierarchy,
} from './polygon/polygon-hierarchy';
import {
	buildPolygonShadowVolumeGeometry,
	type PolygonGeometryUserData,
} from './polygon/polygon-shadow-volume';
import { createDebugRectangleSurfaceGeometry } from './rectangle/rectangle-debug';
import { computeRectanglePlanarExtents } from './rectangle/rectangle-extents';
import {
	expandRectangleDegreesThroughMeters,
	rectangleDegreesFromLonLatPoints,
} from './rectangle/rectangle-helpers';
import { rectangleRadiansFromDegrees } from './rectangle/rectangle-radians';
import { buildRectangleShadowVolumeGeometry } from './rectangle/rectangle-shadow-volume';
import { getTerrainMinMaxHeightsForRectangle } from './terrain-heights';
import type {
	CartesianLike,
	CesiumGroundFrameState,
	CesiumGroundPolygonOptions,
	CesiumGroundRectanglePrimitiveOptions,
	LonLatPoint,
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
 * Resolves the minimum and maximum extrusion heights used by the local
 * shadow-volume builder.
 *
 * The terrain-aware path is identical to the previous Cesium-bound version:
 * caller overrides win, otherwise ApproximateTerrainHeights queries the
 * rectangle for tile-accurate min/max so the shadow volume is just thick
 * enough to enclose the rendered terrain (this is one of the precision
 * fixes we explicitly preserve here).
 *
 * @param rectangleDegrees Plot rectangle in WGS84 degrees.
 * @param minimumHeightOverride Optional explicit minimum height.
 * @param maximumHeightOverride Optional explicit maximum height.
 * @returns Resolved min/max heights for buildShadowVolumeGeometry.
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
		// Keep a non-degenerate shadow volume even if the table reports a bad
		// sample for the queried tile.
		maximumHeight = minimumHeight + 1.0;
	}
	return { minimumHeight, maximumHeight };
}

/**
 * Computes the polygon's outer-ring axis-aligned WGS84 rectangle in degrees.
 * Used to query ApproximateTerrainHeights for the shadow volume's height
 * window.
 *
 * @param hierarchyDegrees Plot polygon hierarchy in degrees.
 * @returns Outer rectangle (degrees).
 */
function rectangleDegreesFromPolygonHierarchyDegrees(
	hierarchyDegrees: PolygonHierarchyDegrees,
): RectangleDegrees {
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( const point of hierarchyDegrees.positions ) {
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
 * Converts the legacy `PolygonHierarchyDegrees` (positions as
 * `{ longitude, latitude }` objects with optional sub-hierarchies for holes)
 * into the flat `LonLatPoint[]` plus `LonLatPoint[][]` shape expected by the
 * native polygon module.
 *
 * @param hierarchy Polygon hierarchy in degrees (legacy adapter contract).
 * @returns Outer ring as `LonLatPoint[]` and holes as `LonLatPoint[][]`.
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
 * Adapts the native `PolygonHierarchy` (Vector3 ECEF) back to the public
 * `CartesianLike` shape so external callers reading
 * `primitive.polygonHierarchy.positions` get an unchanged contract.
 *
 * @param hierarchy Native polygon hierarchy.
 * @returns Cartesian-like positions plus optional Cartesian-like hole rings.
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
 * Ground rectangle implemented with the native rectangle shadow-volume
 * pipeline. The classification command group is reused unchanged, preserving
 * every precision fix landed for the jitter issue (Float64 MVP, LOG_DEPTH,
 * dynamic geometric tolerance, LessEqualDepth stencil).
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: RectangleRadians;

	public constructor( options: CesiumGroundRectanglePrimitiveOptions ) {
		// Plot-spec four lon/lat points → axis-aligned degree rectangle.
		const rectangleDegrees = rectangleDegreesFromLonLatPoints( options.points );

		// Stroke width (meters) outward expansion → render-time degree rectangle.
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			rectangleDegrees,
			strokeWidthMeters,
		);

		// Two radians-form rectangles (fill = stroke inner, render = with outward expansion).
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

		// Granularity default matches the previous adapter (π / (180 · 32)).
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Terrain-aware shadow-volume window (one of the precision fixes — kept here).
		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			renderRectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);

		// Geometry build (one local call replaces the previous 6-step Cesium chain).
		const threeGeometry = buildRectangleShadowVolumeGeometry( {
			rectangle: renderRectangleRadians,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// PlanarExtents uniforms (still computed from radians-form rectangles).
		const extents = computeRectanglePlanarExtents(
			renderRectangleRadians,
			fillRectangleRadians,
			maximumHeight,
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
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);

		// Optional debug surface keeps the historical lon/lat → ENU grid behaviour.
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
 * The public option / property surface is unchanged from the previous
 * Cesium-bound version so the demo (and other callers) keep working.
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };

	public constructor( options: CesiumGroundPolygonOptions ) {
		// Legacy adapter accepts a polygonHierarchyDegrees object — convert to
		// the flat (LonLatPoint[], LonLatPoint[][]) tuple the native module wants.
		const { points, holes } = polygonHierarchyDegreesToLonLatPoints(
			options.polygonHierarchyDegrees,
		);
		const polygonHierarchy = polygonHierarchyFromLonLatPoints( points, holes );
		this.polygonHierarchy = polygonHierarchyToCartesianLike( polygonHierarchy );

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Terrain-aware shadow-volume window — also driven by the outer ring
		// rectangle, identical to the rectangle path.
		const rectangleDegrees = rectangleDegreesFromPolygonHierarchyDegrees(
			options.polygonHierarchyDegrees,
		);
		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			rectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);

		// Geometry build (one local call replaces the previous 6-step Cesium chain).
		const threeGeometry = buildPolygonShadowVolumeGeometry( {
			hierarchy: polygonHierarchy,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// Pull the outer-ring radians rectangle from userData (populated by
		// buildPolygonShadowVolumeGeometry) so PlanarExtents reuses the same
		// ENU centre downstream caller would compute anyway.
		const userData = threeGeometry.userData as PolygonGeometryUserData;
		const polygonRectangle = userData.polygonRectangle;

		const extents = computePolygonPlanarExtents(
			polygonRectangle,
			polygonHierarchy,
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
		// Polygon path keeps the existing "no axis-aligned stroke" behaviour —
		// the classification material's u_innerMetersRect-based border only
		// makes sense for the rectangle path, so this preserves the previous
		// adapter's exact behaviour.
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
