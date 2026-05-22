// ============================================================
// primitives.ts
// Layer: ground primitive construction (rectangle and polygon paths are now
//        Cesium-free for geometry generation).
// Role:  build rectangle and polygon shadow volumes using the native modules
//        under math/, rectangle/, and polygon/. The classification runtime
//        (classification.ts, materials.ts, depth.ts, terrain-log-depth.ts,
//        terrain-heights.ts) keeps every precision fix bit-for-bit identical
//        (Float64 MVP, LOG_DEPTH, dynamic czm_geometricToleranceOverMeter,
//        LessEqualDepth stencil, terrain log-depth injection, ApproximateTerrainHeights
//        window). The only additive change on the classification side is the
//        polygon-stroke point-in-polygon path, which is on a separate shader
//        branch keyed off `u_polygonBorderMode`.
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
	expandPolygonPointsThroughMeters,
} from './polygon/polygon-helpers';
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
 * Caller overrides win, otherwise ApproximateTerrainHeights queries the
 * rectangle for tile-accurate min/max so the shadow volume stays just thick
 * enough to enclose the rendered terrain (one of the precision fixes — kept).
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
		maximumHeight = minimumHeight + 1.0;
	}
	return { minimumHeight, maximumHeight };
}

/**
 * Computes the outer-ring axis-aligned WGS84 rectangle (degrees) from a flat
 * lon/lat point list. Used both to query ApproximateTerrainHeights and as the
 * polygon stroke planar reference rectangle.
 */
function rectangleDegreesFromLonLatPointList(
	points: readonly LonLatPoint[],
): RectangleDegrees {
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( const point of points ) {
		const lon = point[ 0 ];
		const lat = point[ 1 ];
		if ( ! Number.isFinite( lon ) || ! Number.isFinite( lat ) ) {
			continue;
		}
		west = Math.min( west, lon );
		east = Math.max( east, lon );
		south = Math.min( south, lat );
		north = Math.max( north, lat );
	}

	if (
		! Number.isFinite( west ) || ! Number.isFinite( east ) ||
		! Number.isFinite( south ) || ! Number.isFinite( north ) ||
		east <= west || north <= south
	) {
		throw new Error( 'Polygon points must contain at least three finite lon/lat values forming a non-degenerate ring.' );
	}

	return { west, south, east, north };
}

/**
 * Converts the legacy `PolygonHierarchyDegrees` representation into the flat
 * (LonLatPoint[], LonLatPoint[][]) pair consumed by the native polygon
 * module.
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
 * Centroid of a lon/lat ring. Used as the rotation pivot when an in-plane
 * polygon rotation is requested via `options.rotationDegrees`.
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
 * Rotates a lon/lat ring around a pivot. Approximate (small-area) rotation:
 * we treat lon/lat as flat 2-D coordinates around the pivot, which matches
 * what the reference project does for the demo polygon (radius < a few km).
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
 * Ground rectangle implemented with the native rectangle shadow-volume
 * pipeline. The classification command group is reused unchanged, preserving
 * every precision fix landed for the jitter issue.
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

		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			renderRectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);

		const threeGeometry = buildRectangleShadowVolumeGeometry( {
			rectangle: renderRectangleRadians,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

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
 * Ground polygon implemented with the native polygon shadow-volume pipeline,
 * with stroke support via the classification primitive's polygon-border
 * uniforms (additive; no impact on the precision paths).
 *
 * Two call shapes are accepted:
 *   1. The new ref-style API: `points`, optional `holes` / `hole` /
 *      `rotationDegrees`, plus separate `fillColor` / `strokeColor` etc.
 *   2. The legacy `polygonHierarchyDegrees` form with `color` / `alpha`. The
 *      constructor detects which one is present and routes accordingly.
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };
	public readonly rotationDegrees: number;
	public readonly hole: boolean;

	public constructor( options: CesiumGroundPolygonOptions ) {
		// Resolve the input shape — prefer the new ref-style API when present.
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

		// Apply in-plane rotation around the outer-ring centroid (matches ref demo).
		const rotationPivot = lonLatCentroid( outerLonLat );
		const rotatedOuter = rotateLonLatPoints( outerLonLat, rotationPivot, this.rotationDegrees );
		const rotatedHoles = holesLonLat.map(
			( hole ) => rotateLonLatPoints( hole, rotationPivot, this.rotationDegrees ),
		);

		// Stroke width (meters) outward expansion → render-time outer ring.
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? ( options.strokeWidth as number ) : 0.0,
			0.0,
		);
		const renderOuter = strokeWidthMeters > 0.0
			? expandPolygonPointsThroughMeters( rotatedOuter, strokeWidthMeters )
			: rotatedOuter.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );

		// Fill + render hierarchies. The fill ring drives planar style points
		// for the shader's point-in-polygon test; the render ring drives the
		// shadow-volume geometry plus the planar extents.
		const fillHierarchy = polygonHierarchyFromLonLatPoints( rotatedOuter, rotatedHoles );
		const renderHierarchy = polygonHierarchyFromLonLatPoints( renderOuter, rotatedHoles );
		this.polygonHierarchy = polygonHierarchyToCartesianLike( fillHierarchy );

		// Granularity default keeps parity with the prior adapter.
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Terrain-aware shadow-volume window (precision fix preserved).
		const rectangleDegrees = rectangleDegreesFromLonLatPointList( renderOuter );
		const { minimumHeight, maximumHeight } = resolveShadowVolumeHeights(
			rectangleDegrees,
			options.minimumHeight,
			options.maximumHeight,
		);

		// One local call replaces the previous 6-step Cesium chain.
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
			maximumHeight,
		);

		// Polygon stroke planar reference points — the fill ring projected into
		// the same SW-meter plane the fragment shader uses for uv decoding.
		const stylePoints = computePolygonPlanarStylePoints(
			polygonRectangle,
			renderHierarchy,
			rotatedOuter,
			maximumHeight,
		);

		// Fill color / alpha resolution: new API uses fillColor + fillOpacity
		// (0..100 percent), legacy API uses color + alpha (0..1).
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
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ?? '#ffffff' ),
			normalizePercentOpacity(
				Number.isFinite( options.strokeOpacity ) ? ( options.strokeOpacity as number ) : 95,
			),
			strokeWidthMeters,
		);
		// Activate the polygon-stroke shader branch with the fill ring's planar
		// meter coordinates. Three or more points enable polygon-border mode,
		// fewer fall back to the rectangle axis-aligned border.
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
