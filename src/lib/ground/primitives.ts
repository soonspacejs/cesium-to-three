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
import { computeCirclePlanarExtents } from './circle/circle-extents';
import { buildCircleShadowVolumeGeometry } from './circle/circle-shadow-volume';
import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
} from './constants';
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
	rectangleDegreesFromLonLatPoints,
} from './rectangle/rectangle-helpers';
import { rectangleRadiansFromDegrees } from './rectangle/rectangle-radians';
import { buildRectangleShadowVolumeGeometry } from './rectangle/rectangle-shadow-volume';
import type {
	CartesianLike,
	CesiumGroundCirclePrimitiveOptions,
	CesiumGroundFrameState,
	CesiumGroundPolygonOptions,
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

		// Shadow-volume vertical window. Caller overrides win, otherwise fall
		// back to the Cesium ±55km altitude window (CESIUM_GLOBE_MINIMUM_ALTITUDE).
		//
		// Why a flat ±55km instead of an ApproximateTerrainHeights-tight box:
		//   The shadow volume must STAY BIGGER than the camera's far frustum
		//   slice at any altitude the user is going to fly through, otherwise
		//   the far plane bites into the volume's top/sides and the Z-fail
		//   stencil count for the affected fragments becomes incoherent (a
		//   curved band where fill is missing — same artefact circle never
		//   exhibits because its volume was already on this ±55km scale).
		//   A 110km vertical extent is enough to keep the box fully outside
		//   the frustum bounds at every realistic camera altitude.
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

			// Move the debug surface to the non-pickable layer.
			//
			// This is the only Cesium-ground mesh with a regular Three.js
			// `position` attribute + a real bounding sphere — the shadow
			// volume meshes use RTE-encoded `position3DHigh` /
			// `position3DLow` so their boundingSphere is empty and they
			// don't produce raycast hits in practice. The debug surface
			// does, which makes GlobeControls (`EnvironmentControls._raycast`
			// → `Raycaster.intersectObject(scene)`) treat it as terrain:
			//   - `_updateZoomPoint`: zoomPoint lands on the surface at
			//     debugSurfaceHeight (default 5000m); mouse-wheel zoom
			//     asymptotically pulls the camera to that altitude and
			//     gets stuck.
			//   - `_getPointBelowCamera` / `adjustHeight = true`: returns
			//     a hit at debugSurfaceHeight, pinning the camera above
			//     the real terrain.
			//
			// Critically, Three.js's `Raycaster.intersect` does NOT honour
			// `object.visible = false` — only `object.layers`. So toggling
			// `debugSurface.visible` from the GUI does not stop raycasting;
			// only a layer change does. We pin this mesh to
			// CESIUM_GROUND_NON_PICKABLE_LAYER permanently because it's a
			// debug-only visualization that should never participate in
			// scene picking. The host camera must enable that layer
			// (see ground-demo.ts `camera.layers.enable(...)`) so the
			// mesh still renders.
			this.debugSurface.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );

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
			? polygonRenderBoundsThroughMeters( rotatedOuter, strokeWidthMeters )
			: rotatedOuter.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );

		// Fill + render hierarchies. The fill ring drives planar style points
		// for the shader's point-in-polygon test; the render ring drives the
		// shadow-volume geometry plus the planar extents.
		const fillHierarchy = polygonHierarchyFromLonLatPoints( rotatedOuter, rotatedHoles );
		const renderHierarchy = polygonHierarchyFromLonLatPoints( renderOuter, rotatedHoles );
		this.polygonHierarchy = polygonHierarchyToCartesianLike( fillHierarchy );

		// Granularity default keeps parity with the prior adapter.
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );

		// Shadow-volume vertical window. Same flat ±55km fallback the
		// rectangle / circle primitives use (see rectangle constructor for
		// the full reasoning) — terrain-aware tight boxes get bitten by the
		// camera's far plane and trigger curved-band fill artefacts, the
		// ±55km extent stays outside the frustum at every realistic camera
		// altitude.
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		let maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		if ( maximumHeight <= minimumHeight ) {
			maximumHeight = minimumHeight + 1.0;
		}

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
		);

		// Polygon stroke planar reference points — the fill ring projected into
		// the same SW-meter plane the fragment shader uses for uv decoding.
		const stylePoints = computePolygonPlanarStylePoints(
			polygonRectangle,
			renderHierarchy,
			rotatedOuter,
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

/**
 * Ground circle implemented with the native circle shadow-volume pipeline.
 *
 * Plot-spec options are the same shape the reference project uses
 * (`center` + `radius` + stroke/fill/visible, plus optional decoration:
 * `ringCount`, `ringGapMeters`, `sectorStartDegrees`, `sectorAngleDegrees`,
 * `stRotationRadians`, `granularityRadians`, `height` / `extrudedHeight` for
 * the shadow-volume window, and `renderOrder`/`fragmentCull` knobs). The
 * fragment shader's circle branch is activated via
 * `classification.setCircleBorderStyle(...)`; nothing on the LOG_DEPTH or
 * Float64 paths is touched.
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

		// Shadow-volume vertical window. Caller-supplied minimum/maximumHeight
		// wins; otherwise fall back to the Cesium ±55 km altitude window. We
		// skip ApproximateTerrainHeights here because the circle plot lives
		// in a small disc and the ±55 km fallback already covers it cleanly.
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
