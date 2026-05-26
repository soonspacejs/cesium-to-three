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

import { CesiumClassificationPrimitive, updateFrameStateUniforms } from './classification';
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
		// Rectangle follows the face contract: input points describe the fill
		// rectangle, and strokeWidth grows the rendered face outward.
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

		// The input polygon is the fill face. Stroke is classified outside this
		// fill ring in the fragment shader by measuring distance to the same
		// boundary. The render ring is only a conservative shell so the shader
		// has fragments available for the outside stroke band.
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
		this.classification.setPolygonMiterStrokeMode( false );
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
		// Circle follows the same face contract: options.radius is the fill
		// radius; the rendered shadow volume radius includes the outside stroke.
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
			} );
		}

		this.classification = this.delegate.classification;
	}

	/**
	 * Updates per-frame uniforms on the underlying primitive.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.delegate.update( frameState );
	}

	/**
	 * Updates this point's command-block render order.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.delegate.setRenderOrder( renderOrder );
	}

	/**
	 * Releases resources.
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

	public constructor( options: CesiumGroundPolylineOptions ) {
		this.options = resolvePublicLineOptions( options );

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
		);
		this.arrowMaterial = createArrowHeadMaterial(
			this.uniforms,
			this.options.debugVolume,
			this.options.arrowStyle === 'open',
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
		if ( newMode === ARROW_MODE.NONE ) {
			return;
		}
		const userData = this.geometry.userData as LineGeometryUserData;
		this.buildArrowMesh( userData );
	}

	/**
	 * 切换箭头样式（实心三角 / 开口雪佛龙）。要换 material 的 define，所以
	 * 必须重建材质——但几何不变。
	 *
	 * @param style 'solid' / 'open'。
	 */
	public setArrowStyle( style: CesiumGroundArrowStyle ): void {
		const newStyle = parseArrowStyle( style );
		if ( newStyle === this.options.arrowStyle ) {
			return;
		}
		this.options.arrowStyle = newStyle;
		if ( this.arrowMesh === undefined ) {
			return; // 没启用箭头，等开启时再用新 style 建。
		}
		// 只换材质，几何复用。
		this.arrowMaterial?.dispose();
		this.arrowMaterial = createArrowHeadMaterial(
			this.uniforms,
			this.options.debugVolume,
			newStyle === 'open',
		);
		this.arrowMesh.material = this.arrowMaterial;
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
		u_arrowWidthMode: { value: 0.0 },   // 始终用屏幕像素恒定，与线宽屏宽语义一致
		u_arrowLengthPixels: { value: options.arrowLengthPixels },
		u_arrowHalfWidthPixels: { value: options.arrowWidthPixels * 0.5 },
		u_arrowLengthMeters: { value: options.arrowLengthMeters },
		u_arrowHalfWidthMeters: { value: options.arrowWidthMeters * 0.5 },
		u_arrowColor: { value: new Vector4( color.r, color.g, color.b, safeAlpha ) },
		u_arrowStrokeHalfPixels: { value: options.arrowStrokeWidthPixels * 0.5 },
	} as unknown as SharedUniforms;
}
