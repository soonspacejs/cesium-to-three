// ============================================================
// ground-demo.ts
// Layer: runnable Three.js host for the Cesium-free ground adapter.
// Role:  drives 3d-tiles-renderer terrain, feeds its depth into our
//        shadow-volume classification pipeline, and exposes a lil-gui surface
//        that mirrors the reference project's rectangle + polygon GUI
//        layout (the project does not ship circle / point primitives, so
//        those sections are intentionally omitted).
// Dependencies: demo helpers, src/lib/ground, Three.js, 3d-tiles-renderer.
// Consumed by: main.ts.
// ============================================================

import {
	AmbientLight,
	Color,
	DirectionalLight,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
	type Material,
} from 'three';
import { GlobeControls, TilesRenderer } from '3d-tiles-renderer';
import GUI from 'lil-gui';

import {
	CesiumGlobeDepth,
	CesiumGroundPolygonPrimitive,
	CesiumGroundRectanglePrimitive,
	initializeApproximateTerrainHeights,
	rectangleMeterSizeFromDegrees,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type LonLatPoint,
} from '../lib/ground';
import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import { type GroundDebugSettings, type GroundDebugStatus } from './debug-types';
import {
	PlotOrderRegistry,
	plotOrderToRenderOrder,
} from './plot-utils';
import {
	configureLoadedTileScene,
	createCesiumTilesRenderer,
	type TileRuntimeCounters,
	type TilesRuntimeStats,
} from './tiles';

const RECTANGLE_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const RECTANGLE_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );
const RECTANGLE_HALF_WIDTH_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_WIDTH_DEGREES', 0.05 );
const RECTANGLE_HALF_HEIGHT_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_HEIGHT_DEGREES', 0.03 );
const DEBUG_GROUND_SURFACE = readStringEnv( 'VITE_DEBUG_GROUND_SURFACE', 'false' ).toLowerCase() === 'true';

type DemoPlotId = 'rectangle' | 'polygon';

interface RectangleGuiModel {
	points: string;
}

interface PolygonGuiModel {
	points: string;
	holes: string;
}

/**
 * Boots the Three scene and executes the Cesium-free ground pipeline every frame.
 */
export function runGroundDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

	// Inject the bundled Cesium ApproximateTerrainHeights.json synchronously so
	// every CesiumGroundRectanglePrimitive / CesiumGroundPolygonPrimitive
	// created below pulls a tile-accurate min/max terrain height window —
	// one of the precision fixes we explicitly preserve.
	initializeApproximateTerrainHeights();

	const app = document.getElementById( 'app' );
	if ( ! app ) {
		throw new Error( 'Missing #app container.' );
	}
	app.innerHTML = '';

	const scene = new Scene();
	scene.background = new Color( 0x05070a );
	scene.add( new AmbientLight( 0xffffff, 0.48 ) );

	const sun = new DirectionalLight( 0xffffff, 1.8 );
	sun.position.set( 0.35, - 0.45, 0.82 ).normalize();
	scene.add( sun );

	const renderer = new WebGLRenderer( {
		antialias: true,
		stencil: true,
		alpha: false,
		powerPreference: 'high-performance',
	} );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.autoClear = true;
	renderer.autoClearStencil = true;
	app.appendChild( renderer.domElement );
	validateCesiumGroundRenderer( renderer );

	const camera = new PerspectiveCamera(
		55,
		window.innerWidth / window.innerHeight,
		1.0,
		40000000.0,
	);
	camera.up.set( 0.0, 0.0, 1.0 );

	const target = wgs84PositionFromDegrees( RECTANGLE_CENTER_LON, RECTANGLE_CENTER_LAT, 0.0 );
	const up = wgs84NormalFromDegrees( RECTANGLE_CENTER_LON, RECTANGLE_CENTER_LAT );
	const eastBias = new Vector3( - up.y, up.x, 0.0 ).normalize();
	camera.position
		.copy( target )
		.addScaledVector( up, 720000.0 )
		.addScaledVector( eastBias, 260000.0 );
	camera.lookAt( target );
	camera.updateMatrixWorld();

	const tilesRenderer = createCesiumTilesRenderer();
	const tileCounters: TileRuntimeCounters = {
		modelsLoaded: 0,
		modelsVisible: 0,
		rootLoaded: false,
		rootUrl: '',
	};
	tilesRenderer.setCamera( camera );
	tilesRenderer.setResolutionFromRenderer( camera, renderer );
	scene.add( tilesRenderer.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( tilesRenderer.ellipsoid, tilesRenderer.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 10.0;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	const globeDepth = new CesiumGlobeDepth(
		renderer.domElement.width,
		renderer.domElement.height,
	);
	const initialRectangleDegrees = {
		west: RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES,
		south: RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES,
		east: RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES,
		north: RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES,
	};
	const initialRectangleMeterSize = rectangleMeterSizeFromDegrees( initialRectangleDegrees );
	const initialRectanglePoints: LonLatPoint[] = [
		[ initialRectangleDegrees.west, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.north ],
		[ initialRectangleDegrees.west, initialRectangleDegrees.north ],
	];
	const initialPolygonPoints: LonLatPoint[] = [
		[
			RECTANGLE_CENTER_LON,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.65,
		],
		[
			RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.55,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.2,
		],
		[
			RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.34,
			RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.56,
		],
		[
			RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.34,
			RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.56,
		],
		[
			RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.55,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.2,
		],
	];
	const initialPolygonHolePoints: LonLatPoint[] = [
		[
			RECTANGLE_CENTER_LON,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.18,
		],
		[
			RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.18,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.06,
		],
		[
			RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.11,
			RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.16,
		],
		[
			RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.11,
			RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.16,
		],
		[
			RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.18,
			RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.06,
		],
	];

	const debugSettings: GroundDebugSettings = {
		points: initialRectanglePoints,
		centerLon: RECTANGLE_CENTER_LON,
		centerLat: RECTANGLE_CENTER_LAT,
		widthDegrees: RECTANGLE_HALF_WIDTH_DEGREES * 2.0,
		heightDegrees: RECTANGLE_HALF_HEIGHT_DEGREES * 2.0,
		widthMeters: initialRectangleMeterSize.widthMeters,
		heightMeters: initialRectangleMeterSize.heightMeters,
		halfWidth: RECTANGLE_HALF_WIDTH_DEGREES,
		halfHeight: RECTANGLE_HALF_HEIGHT_DEGREES,
		fillColor: '#ff0000',
		fillOpacity: 72,
		visible: true,
		rectanglePlotOrder: 0,
		strokeColor: '#ffffff',
		strokeOpacity: 95,
		strokeWidth: 300.0,
		fragmentCull: true,
		useTilesDepth: true,
		showTiles: true,
		showFrontStencil: true,
		showBackStencil: true,
		showColorPass: true,
		polygonVisible: true,
		polygonPlotOrder: 1,
		polygonStrokeColor: '#ffffff',
		polygonStrokeOpacity: 92,
		polygonStrokeWidth: 300.0,
		polygonFillColor: '#00aaff',
		polygonFillOpacity: 68,
		polygonPoints: initialPolygonPoints,
		polygonHoles: [ initialPolygonHolePoints ],
		polygonRotationDegrees: 18.0,
		polygonHole: false,
		showDebugSurface: DEBUG_GROUND_SURFACE,
		debugSurfaceHeight: 5000.0,
		debugSurfaceOpacity: 0.55,
		rebuild: () => rebuildGroundRectangle(),
	};
	const debugStatus: GroundDebugStatus = {
		root: 'loading',
		models: 0,
		visibleTiles: 0,
		cacheTiles: 0,
		loadedTiles: 0,
		queue: '0 / 0 / 0 / 0',
		error: '',
	};
	const rectangleGuiModel: RectangleGuiModel = {
		points: JSON.stringify( debugSettings.points ),
	};
	const polygonGuiModel: PolygonGuiModel = {
		points: JSON.stringify( debugSettings.polygonPoints ),
		holes: JSON.stringify( debugSettings.polygonHoles ),
	};
	const plotOrderRegistry = new PlotOrderRegistry<DemoPlotId>();
	debugSettings.rectanglePlotOrder = plotOrderRegistry.register( 'rectangle', debugSettings.rectanglePlotOrder );
	debugSettings.polygonPlotOrder = plotOrderRegistry.register( 'polygon', debugSettings.polygonPlotOrder );

	/**
	 * Returns the current fill rectangle derived from the public points field.
	 *
	 * @returns Rectangle in WGS84 degrees.
	 */
	function getCurrentRectangleDegrees(): { west: number; south: number; east: number; north: number } {
		let west = Number.POSITIVE_INFINITY;
		let south = Number.POSITIVE_INFINITY;
		let east = Number.NEGATIVE_INFINITY;
		let north = Number.NEGATIVE_INFINITY;

		for ( const point of debugSettings.points ) {
			west = Math.min( west, point[ 0 ] );
			south = Math.min( south, point[ 1 ] );
			east = Math.max( east, point[ 0 ] );
			north = Math.max( north, point[ 1 ] );
		}

		return { west, south, east, north };
	}

	/**
	 * Serializes rectangle points into the compact GUI text field.
	 *
	 * @returns JSON string with four [lon, lat] corner points.
	 */
	function stringifyRectanglePoints(): string {
		return JSON.stringify( debugSettings.points );
	}

	/**
	 * Parses the public points GUI text into four WGS84 lon/lat points.
	 *
	 * @param value JSON text typed in lil-gui.
	 * @returns Validated lon/lat points.
	 */
	function parseRectanglePointsText( value: string ): LonLatPoint[] {
		const parsed = JSON.parse( value ) as unknown;

		if ( ! Array.isArray( parsed ) || parsed.length !== 4 ) {
			throw new Error( 'Rectangle points must be JSON with exactly four [lon, lat] pairs.' );
		}

		return parsed.map( point => {
			if ( ! Array.isArray( point ) || point.length !== 2 ) {
				throw new Error( 'Each rectangle point must be a [lon, lat] pair.' );
			}

			const longitude = Number( point[ 0 ] );
			const latitude = Number( point[ 1 ] );
			if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
				throw new Error( 'Rectangle point coordinates must be finite numbers.' );
			}

			return [ longitude, latitude ] as LonLatPoint;
		} );
	}

	/**
	 * Serializes polygon points into the compact GUI text field.
	 *
	 * @returns JSON string with [lon, lat] polygon vertices.
	 */
	function stringifyPolygonPoints(): string {
		return JSON.stringify( debugSettings.polygonPoints );
	}

	/**
	 * Serializes polygon hole rings into the compact GUI text field.
	 *
	 * @returns JSON string with one or more hole rings.
	 */
	function stringifyPolygonHoles(): string {
		return JSON.stringify( debugSettings.polygonHoles );
	}

	/**
	 * Creates a default editable hole by scaling the current polygon inward.
	 *
	 * @param points Outer polygon vertices in WGS84 lon/lat degrees.
	 * @returns A smaller ring that starts inside the current polygon.
	 */
	function createDefaultPolygonHolePoints( points: readonly LonLatPoint[] ): LonLatPoint[] {
		if ( points.length < 3 ) {
			return [];
		}

		let longitudeSum = 0.0;
		let latitudeSum = 0.0;
		for ( const point of points ) {
			longitudeSum += point[ 0 ];
			latitudeSum += point[ 1 ];
		}

		const centerLongitude = longitudeSum / points.length;
		const centerLatitude = latitudeSum / points.length;
		const holeScale = 0.36;

		return points.map( point => [
			centerLongitude + ( point[ 0 ] - centerLongitude ) * holeScale,
			centerLatitude + ( point[ 1 ] - centerLatitude ) * holeScale,
		] );
	}

	/**
	 * Parses the public polygon points GUI text.
	 *
	 * @param value JSON text typed in lil-gui.
	 * @returns Validated lon/lat polygon points.
	 */
	function parsePolygonPointsText( value: string ): LonLatPoint[] {
		const parsed = JSON.parse( value ) as unknown;

		if ( ! Array.isArray( parsed ) || parsed.length < 3 ) {
			throw new Error( 'Polygon points must be JSON with at least three [lon, lat] pairs.' );
		}

		return parsed.map( point => {
			if ( ! Array.isArray( point ) || point.length !== 2 ) {
				throw new Error( 'Each polygon point must be a [lon, lat] pair.' );
			}

			const longitude = Number( point[ 0 ] );
			const latitude = Number( point[ 1 ] );
			if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
				throw new Error( 'Polygon point coordinates must be finite numbers.' );
			}

			return [ longitude, latitude ] as LonLatPoint;
		} );
	}

	/**
	 * Parses one polygon ring from a GUI JSON value.
	 *
	 * @param parsed Unknown JSON value representing a ring.
	 * @param label Human-readable label used in validation errors.
	 * @returns Validated lon/lat ring.
	 */
	function parsePolygonRingValue( parsed: unknown, label: string ): LonLatPoint[] {
		if ( ! Array.isArray( parsed ) || parsed.length < 3 ) {
			throw new Error( `${ label } must contain at least three [lon, lat] pairs.` );
		}

		return parsed.map( point => {
			if ( ! Array.isArray( point ) || point.length !== 2 ) {
				throw new Error( `Each ${ label } point must be a [lon, lat] pair.` );
			}

			const longitude = Number( point[ 0 ] );
			const latitude = Number( point[ 1 ] );
			if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
				throw new Error( `${ label } coordinates must be finite numbers.` );
			}

			return [ longitude, latitude ] as LonLatPoint;
		} );
	}

	/**
	 * Parses the public polygon holes GUI text.
	 *
	 * @param value JSON text typed in lil-gui.
	 * @returns Validated hole rings in WGS84 lon/lat degrees.
	 */
	function parsePolygonHolesText( value: string ): LonLatPoint[][] {
		const parsed = JSON.parse( value ) as unknown;

		if ( ! Array.isArray( parsed ) ) {
			throw new Error( 'Polygon holes must be JSON with hole rings.' );
		}
		if ( parsed.length === 0 ) {
			return [];
		}

		const first = parsed[ 0 ] as unknown;
		const isSingleRing = Array.isArray( first ) && first.length === 2 && ! Array.isArray( first[ 0 ] );
		if ( isSingleRing ) {
			return [ parsePolygonRingValue( parsed, 'Polygon hole' ) ];
		}

		return parsed.map( ( ring, index ) => parsePolygonRingValue( ring, `Polygon hole ${ index + 1 }` ) );
	}

	/**
	 * Stores public points and refreshes derived center/size state.
	 *
	 * @param points Four WGS84 lon/lat corner points.
	 */
	function applyRectanglePointsToDebugSettings( points: LonLatPoint[] ): void {
		debugSettings.points = points.map( point => [ point[ 0 ], point[ 1 ] ] );
		rectangleGuiModel.points = stringifyRectanglePoints();
		syncRectangleDerivedState();
	}

	/**
	 * Stores public polygon points and keeps the GUI text synchronized.
	 *
	 * @param points Three or more WGS84 lon/lat polygon vertices.
	 */
	function applyPolygonPointsToDebugSettings( points: LonLatPoint[] ): void {
		debugSettings.polygonPoints = points.map( point => [ point[ 0 ], point[ 1 ] ] );
		polygonGuiModel.points = stringifyPolygonPoints();
	}

	/**
	 * Stores public polygon hole rings and keeps the GUI text synchronized.
	 *
	 * @param holes Zero or more WGS84 lon/lat hole rings.
	 */
	function applyPolygonHolesToDebugSettings( holes: LonLatPoint[][] ): void {
		debugSettings.polygonHoles = holes.map( ring => ring.map( point => [ point[ 0 ], point[ 1 ] ] ) );
		polygonGuiModel.holes = stringifyPolygonHoles();
	}

	/**
	 * Refreshes derived rectangle state used by diagnostics.
	 */
	function syncRectangleDerivedState(): void {
		const rectangle = getCurrentRectangleDegrees();
		debugSettings.centerLon = ( rectangle.west + rectangle.east ) * 0.5;
		debugSettings.centerLat = ( rectangle.south + rectangle.north ) * 0.5;
		debugSettings.halfWidth = Math.max( ( rectangle.east - rectangle.west ) * 0.5, 0.0005 );
		debugSettings.halfHeight = Math.max( ( rectangle.north - rectangle.south ) * 0.5, 0.0005 );
		debugSettings.widthDegrees = debugSettings.halfWidth * 2.0;
		debugSettings.heightDegrees = debugSettings.halfHeight * 2.0;

		const meterSize = rectangleMeterSizeFromDegrees( rectangle );
		debugSettings.widthMeters = meterSize.widthMeters;
		debugSettings.heightMeters = meterSize.heightMeters;
	}

	/**
	 * Registers one edited plot order and keeps the registry as the uniqueness owner.
	 *
	 * @param target Plot whose GUI value is being applied.
	 */
	function updateRegisteredPlotOrder( target: DemoPlotId ): void {
		if ( target === 'rectangle' ) {
			debugSettings.rectanglePlotOrder = plotOrderRegistry.update(
				'rectangle',
				debugSettings.rectanglePlotOrder,
			);
			return;
		}

		debugSettings.polygonPlotOrder = plotOrderRegistry.update(
			'polygon',
			debugSettings.polygonPlotOrder,
		);
	}

	/**
	 * Normalizes polygon GUI values before geometry is rebuilt.
	 */
	function normalizePolygonDebugSettings(): void {
		debugSettings.polygonRotationDegrees = Number.isFinite( debugSettings.polygonRotationDegrees )
			? debugSettings.polygonRotationDegrees
			: 0.0;

		if ( debugSettings.polygonHole && debugSettings.polygonHoles.length === 0 ) {
			const defaultHole = createDefaultPolygonHolePoints( debugSettings.polygonPoints );
			if ( defaultHole.length >= 3 ) {
				debugSettings.polygonHoles = [ defaultHole ];
				polygonGuiModel.holes = stringifyPolygonHoles();
			}
		}
	}

	/**
	 * Creates a shadow-volume rectangle from the current GUI settings.
	 *
	 * @returns Ground rectangle primitive wired for classification and debugging.
	 */
	function createGroundRectangle(): CesiumGroundRectanglePrimitive {
		return new CesiumGroundRectanglePrimitive( {
			points: debugSettings.points,
			strokeColor: debugSettings.strokeColor,
			strokeWidth: debugSettings.strokeWidth,
			strokeOpacity: debugSettings.strokeOpacity,
			fillColor: debugSettings.fillColor,
			fillOpacity: debugSettings.fillOpacity,
			visible: debugSettings.visible,
			renderOrder: plotOrderToRenderOrder( debugSettings.rectanglePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
			debugSurface: true,
			debugSurfaceHeight: debugSettings.debugSurfaceHeight,
			debugSurfaceOpacity: debugSettings.debugSurfaceOpacity,
		} );
	}

	/**
	 * Creates a shadow-volume polygon from the current GUI settings.
	 *
	 * @returns Ground polygon primitive using the native shadow-volume builder.
	 */
	function createGroundPolygon(): CesiumGroundPolygonPrimitive {
		normalizePolygonDebugSettings();

		return new CesiumGroundPolygonPrimitive( {
			points: debugSettings.polygonPoints,
			strokeColor: debugSettings.polygonStrokeColor,
			strokeWidth: debugSettings.polygonStrokeWidth,
			strokeOpacity: debugSettings.polygonStrokeOpacity,
			fillColor: debugSettings.polygonFillColor,
			fillOpacity: debugSettings.polygonFillOpacity,
			visible: debugSettings.polygonVisible,
			rotationDegrees: debugSettings.polygonRotationDegrees,
			hole: debugSettings.polygonHole,
			holes: debugSettings.polygonHole ? debugSettings.polygonHoles : [],
			renderOrder: plotOrderToRenderOrder( debugSettings.polygonPlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	let groundRectangle = createGroundRectangle();
	let groundPolygon = createGroundPolygon();
	scene.add( groundRectangle.classification.group );
	scene.add( groundPolygon.classification.group );

	/**
	 * Applies GUI state to the existing primitive without rebuilding geometry.
	 */
	function applyGroundDebugSettings(): void {
		const color = new Color( debugSettings.fillColor );
		groundRectangle.classification.setColor( color, debugSettings.fillOpacity / 100.0 );
		groundRectangle.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundRectangle.setRenderOrder( plotOrderToRenderOrder( debugSettings.rectanglePlotOrder ) );
		groundRectangle.classification.group.visible = debugSettings.visible;
		groundRectangle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundRectangle.classification.setBorderStyle(
			debugSettings.strokeWidth > 0.0,
			new Color( debugSettings.strokeColor ),
			debugSettings.strokeOpacity / 100.0,
			debugSettings.strokeWidth,
		);

		if ( groundRectangle.debugSurface ) {
			groundRectangle.debugSurface.visible = debugSettings.showDebugSurface;
			const material = groundRectangle.debugSurface.material as Material & {
				color?: Color;
				opacity?: number;
			};
			if ( material.color ) {
				material.color.copy( color );
			}
			if ( typeof material.opacity === 'number' ) {
				material.opacity = debugSettings.debugSurfaceOpacity;
			}
		}

		groundPolygon.classification.setColor(
			new Color( debugSettings.polygonFillColor ),
			debugSettings.polygonFillOpacity / 100.0,
		);
		groundPolygon.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundPolygon.setRenderOrder( plotOrderToRenderOrder( debugSettings.polygonPlotOrder ) );
		groundPolygon.classification.group.visible = debugSettings.polygonVisible;
		groundPolygon.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundPolygon.classification.setBorderStyle(
			debugSettings.polygonStrokeWidth > 0.0,
			new Color( debugSettings.polygonStrokeColor ),
			debugSettings.polygonStrokeOpacity / 100.0,
			debugSettings.polygonStrokeWidth,
		);
	}

	/**
	 * Applies a rectangle plot-order edit while preserving every other plot order.
	 */
	function applyRectanglePlotOrder(): void {
		updateRegisteredPlotOrder( 'rectangle' );
		applyGroundDebugSettings();
	}

	/**
	 * Applies a polygon plot-order edit while preserving every other plot order.
	 */
	function applyPolygonPlotOrder(): void {
		updateRegisteredPlotOrder( 'polygon' );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds geometry after the public points field changes.
	 */
	function rebuildRectangleFromPointsText(): void {
		try {
			applyRectanglePointsToDebugSettings( parseRectanglePointsText( rectangleGuiModel.points ) );
			rebuildGroundRectangle();
		} catch ( error ) {
			rectangleGuiModel.points = stringifyRectanglePoints();
			console.error( error );
		}
	}

	/**
	 * Rebuilds polygon geometry after the public points field changes.
	 */
	function rebuildPolygonFromPointsText(): void {
		try {
			applyPolygonPointsToDebugSettings( parsePolygonPointsText( polygonGuiModel.points ) );
			rebuildGroundPolygon();
		} catch ( error ) {
			polygonGuiModel.points = stringifyPolygonPoints();
			console.error( error );
		}
	}

	/**
	 * Rebuilds polygon geometry after the public hole points field changes.
	 */
	function rebuildPolygonFromHolesText(): void {
		try {
			applyPolygonHolesToDebugSettings( parsePolygonHolesText( polygonGuiModel.holes ) );
			rebuildGroundPolygon();
		} catch ( error ) {
			polygonGuiModel.holes = stringifyPolygonHoles();
			console.error( error );
		}
	}

	/**
	 * Rebuilds only geometry-dependent polygon state after polygon GUI edits.
	 */
	function rebuildGroundPolygonFromGui(): void {
		normalizePolygonDebugSettings();
		rebuildGroundPolygon();
	}

	/**
	 * Rebuilds geometry when rectangle extents or debug-surface height change.
	 */
	function rebuildGroundRectangle(): void {
		scene.remove( groundRectangle.classification.group );
		groundRectangle.dispose();
		groundRectangle = createGroundRectangle();
		scene.add( groundRectangle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds only the polygon primitive when polygon-only GUI values change.
	 */
	function rebuildGroundPolygon(): void {
		scene.remove( groundPolygon.classification.group );
		groundPolygon.dispose();
		groundPolygon = createGroundPolygon();
		scene.add( groundPolygon.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Creates the lil-gui control surface for render-pass diagnosis.
	 */
	function createGroundDebugGui(): GUI {
		const gui = new GUI( { title: 'Cesium Ground Debug' } );
		gui.domElement.style.right = '16px';
		gui.domElement.style.top = '16px';

		const rectangleFolder = gui.addFolder( 'Rectangle' );
		rectangleFolder.add( rectangleGuiModel, 'points' ).name( 'points' ).onFinishChange( rebuildRectangleFromPointsText ).listen();
		rectangleFolder.addColor( debugSettings, 'strokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'strokeWidth', 0.0, 100000.0, 100.0 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundRectangle );
		rectangleFolder.add( debugSettings, 'strokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		rectangleFolder.addColor( debugSettings, 'fillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'fillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'visible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'rectanglePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyRectanglePlotOrder ).listen();

		const polygonFolder = gui.addFolder( 'Polygon' );
		polygonFolder.add( polygonGuiModel, 'points' ).name( 'points' ).onFinishChange( rebuildPolygonFromPointsText ).listen();
		polygonFolder.add( polygonGuiModel, 'holes' ).name( 'holes' ).onFinishChange( rebuildPolygonFromHolesText ).listen();
		polygonFolder.add( debugSettings, 'polygonVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyPolygonPlotOrder ).listen();
		polygonFolder.addColor( debugSettings, 'polygonStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonStrokeWidth', 0.0, 100000.0, 100.0 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundPolygon );
		polygonFolder.add( debugSettings, 'polygonStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		polygonFolder.addColor( debugSettings, 'polygonFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonHole' ).name( 'hole' ).onChange( rebuildGroundPolygonFromGui );

		const passesFolder = gui.addFolder( 'Passes' );
		passesFolder.add( debugSettings, 'showFrontStencil' ).name( 'front stencil' ).onChange( applyGroundDebugSettings );
		passesFolder.add( debugSettings, 'showBackStencil' ).name( 'back stencil' ).onChange( applyGroundDebugSettings );
		passesFolder.add( debugSettings, 'showColorPass' ).name( 'color pass' ).onChange( applyGroundDebugSettings );
		passesFolder.add( debugSettings, 'fragmentCull' ).name( 'CULL_FRAGMENTS' ).onChange( applyGroundDebugSettings );

		const depthFolder = gui.addFolder( 'Tiles / Depth' );
		depthFolder.add( debugSettings, 'useTilesDepth' ).name( 'tiles depth source' );
		depthFolder.add( debugSettings, 'showTiles' ).name( 'show tiles' );

		const debugFolder = gui.addFolder( 'Debug Surface' );
		debugFolder.add( debugSettings, 'showDebugSurface' ).name( 'show surface' ).onChange( applyGroundDebugSettings );
		debugFolder.add( debugSettings, 'debugSurfaceHeight', - 1000.0, 20000.0, 10.0 ).name( 'surface height m' ).onFinishChange( rebuildGroundRectangle );
		debugFolder.add( debugSettings, 'debugSurfaceOpacity', 0.0, 1.0, 0.01 ).name( 'surface opacity' ).onChange( applyGroundDebugSettings );

		const statusFolder = gui.addFolder( 'Status' );
		statusFolder.add( debugStatus, 'root' ).name( 'root' ).listen();
		statusFolder.add( debugStatus, 'models' ).name( 'models' ).listen();
		statusFolder.add( debugStatus, 'visibleTiles' ).name( 'visible tiles' ).listen();
		statusFolder.add( debugStatus, 'cacheTiles' ).name( 'cache tiles' ).listen();
		statusFolder.add( debugStatus, 'loadedTiles' ).name( 'loaded tiles' ).listen();
		statusFolder.add( debugStatus, 'queue' ).name( 'queue d/p/f' ).listen();
		statusFolder.add( debugStatus, 'error' ).name( 'error' ).listen();

		return gui;
	}

	applyGroundDebugSettings();
	const debugGui = createGroundDebugGui();

	let tileLoadError = '';
	tilesRenderer.addEventListener( 'load-error', event => {
		tileLoadError = String( event.error?.message ?? event.error ?? 'unknown' );
		console.error( event );
	} );
	tilesRenderer.addEventListener( 'load-tileset', event => {
		tileCounters.rootLoaded = true;
		tileCounters.rootUrl = String( event.url ?? '' );
		controls.setEllipsoid( tilesRenderer.ellipsoid, tilesRenderer.group );
	} );
	tilesRenderer.addEventListener( 'load-model', event => {
		tileCounters.modelsLoaded ++;
		configureLoadedTileScene( event.scene );
	} );
	tilesRenderer.addEventListener( 'tile-visibility-change', event => {
		tileCounters.modelsVisible += event.visible ? 1 : - 1;
		tileCounters.modelsVisible = Math.max( tileCounters.modelsVisible, 0 );
	} );

	function resize(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setSize( width, height );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
		tilesRenderer.setResolutionFromRenderer( camera, renderer );
		globeDepth.resize( renderer.domElement.width, renderer.domElement.height );
	}
	window.addEventListener( 'resize', resize );

	function renderFrame(): void {
		controls.update();
		camera.updateMatrixWorld();
		tilesRenderer.setResolutionFromRenderer( camera, renderer );
		tilesRenderer.update();

		// Refresh terrain log-depth uniforms before any pass touches the main
		// or packed depth buffers (precision path).
		updateTerrainLogDepthUniforms( camera.near, camera.far );

		tilesRenderer.group.visible = debugSettings.useTilesDepth;
		globeDepth.render( renderer, camera, scene, tilesRenderer.group );
		tilesRenderer.group.visible = debugSettings.showTiles;
		groundRectangle.update( {
			depthTexture: globeDepth.target.texture,
			width: renderer.domElement.width,
			height: renderer.domElement.height,
			camera,
		} );
		groundPolygon.update( {
			depthTexture: globeDepth.target.texture,
			width: renderer.domElement.width,
			height: renderer.domElement.height,
			camera,
		} );

		renderer.render( scene, camera );

		const stats = ( tilesRenderer as TilesRenderer & { stats: TilesRuntimeStats } ).stats;
		debugStatus.root = tileCounters.rootLoaded ? 'loaded' : 'loading';
		debugStatus.models = tileCounters.modelsLoaded;
		debugStatus.visibleTiles = stats.visible;
		debugStatus.cacheTiles = stats.inCache;
		debugStatus.loadedTiles = stats.loaded;
		debugStatus.queue = `${ stats.queued } / ${ stats.downloading } / ${ stats.parsing } / ${ stats.failed }`;
		debugStatus.error = tileLoadError || '';

		const assetIdReported = readStringEnv( 'VITE_CESIUM_ION_ASSET_ID', '96188' );
		const assetIdLabel = assetIdReported === '1' ? '96188' : assetIdReported;
		infoBody.textContent =
			`Ground adapter: Cesium-free rectangle + polygon (math/ + rectangle/ + polygon/)\n` +
			`Tiles: 3d-tiles-renderer + Cesium Ion asset ${ assetIdLabel }\n` +
			`Terrain plugin: QuantizedMeshPlugin for TERRAIN assets\n` +
			`Geometry: buildRectangleShadowVolumeGeometry / buildPolygonShadowVolumeGeometry\n` +
			`Rectangle: ${ debugSettings.visible ? 'on' : 'off' } / order ${ debugSettings.rectanglePlotOrder } / ${ debugSettings.widthDegrees.toFixed( 4 ) } deg x ${ debugSettings.heightDegrees.toFixed( 4 ) } deg\n` +
			`Rectangle meters: ${ debugSettings.widthMeters.toFixed( 1 ) } m x ${ debugSettings.heightMeters.toFixed( 1 ) } m\n` +
			`Polygon: ${ debugSettings.polygonVisible ? 'on' : 'off' } / order ${ debugSettings.polygonPlotOrder } / points ${ debugSettings.polygonPoints.length } / holes ${ debugSettings.polygonHoles.length } / rotation ${ debugSettings.polygonRotationDegrees.toFixed( 1 ) } deg / hole ${ debugSettings.polygonHole ? 'on' : 'off' }\n` +
			`Debug surface: ${ debugSettings.showDebugSurface ? 'on' : 'off' }\n` +
			`Rectangle stroke: ${ debugSettings.strokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.strokeOpacity.toFixed( 0 ) }%\n` +
			`Polygon stroke: ${ debugSettings.polygonStrokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.polygonStrokeOpacity.toFixed( 0 ) }%\n` +
			`CULL_FRAGMENTS: ${ debugSettings.fragmentCull ? 'on' : 'off' }\n` +
			`Shader: ShadowVolumeAppearanceVS/FS + ShadowVolumeFS (LOG_DEPTH on)\n` +
			`Stencil mask: 0x0f, zfail front=DECR_WRAP back=INCR_WRAP, depthFunc=LESS_EQUAL\n` +
			`Globe depth: tilesRenderer.group -> czm_packDepth -> czm_unpackDepth (log depth)\n` +
			`Root/model visible: ${ tileCounters.rootLoaded ? 'yes' : 'loading' } / ${ tileCounters.modelsVisible }\n` +
			`Tiles visible/cache/loaded: ${ stats.visible } / ${ stats.inCache } / ${ stats.loaded }\n` +
			`Queue download parse failed: ${ stats.queued } / ${ stats.downloading } / ${ stats.parsing } / ${ stats.failed }\n` +
			`Loaded model events: ${ tileCounters.modelsLoaded }\n` +
			`Drawing buffer: ${ renderer.domElement.width } x ${ renderer.domElement.height }` +
			( tileLoadError ? `\nTile load error: ${ tileLoadError }` : '' );

		requestAnimationFrame( renderFrame );
	}

	( window as unknown as { __demo?: unknown } ).__demo = {
		renderer,
		scene,
		camera,
		tilesRenderer,
		controls,
		globeDepth,
		debugGui,
		debugSettings,
		get groundRectangle() {
			return groundRectangle;
		},
		get groundPolygon() {
			return groundPolygon;
		},
	};

	renderFrame();
}
