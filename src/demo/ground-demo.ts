// ============================================================
// ground-demo.ts
// Layer: runnable Three.js host for the Cesium GroundPrimitive adapter.
// Role: drives 3d-tiles-renderer terrain and feeds its depth into Cesium's
//       shadow-volume classification shaders through a Three adapter.
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
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleDegreesFromCenterSizeMeters,
	rectangleMeterSizeFromDegrees,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type LonLatPoint,
	type PolygonHierarchyDegrees,
} from '../lib/ground';
import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import { type GroundDebugSettings, type GroundDebugStatus } from './debug-types';
import { clampNumber, createLocalPolygonOffsets, plotOrderToRenderOrder } from './plot-utils';
import {
	configureLoadedTileScene,
	createCesiumTilesRenderer,
	type TileRuntimeCounters,
	type TilesRuntimeStats,
} from './tiles';

const PLAIN_CENTER_LON = 121.5;
const PLAIN_CENTER_LAT = 31.24;
const DEFAULT_PLOT_SIZE_METERS = 10.0;
const MIN_GUI_METER_VALUE = 1.0;
const MAX_GUI_METER_VALUE = 20.0;
const MIN_GUI_OFFSET_METERS = - MAX_GUI_METER_VALUE;
const MAX_GUI_OFFSET_METERS = MAX_GUI_METER_VALUE;
const GUI_METER_STEP = 0.1;
const CAMERA_HEIGHT_MULTIPLIER = 8.0;
const CAMERA_EAST_MULTIPLIER = 3.0;
const MIN_CAMERA_HEIGHT_METERS = 40.0;
const MIN_CAMERA_EAST_METERS = 20.0;
const RECTANGLE_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', PLAIN_CENTER_LON );
const RECTANGLE_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', PLAIN_CENTER_LAT );
const RECTANGLE_WIDTH_METERS = readNumberEnv( 'VITE_PLOT_WIDTH_METERS', DEFAULT_PLOT_SIZE_METERS );
const RECTANGLE_HEIGHT_METERS = readNumberEnv( 'VITE_PLOT_HEIGHT_METERS', DEFAULT_PLOT_SIZE_METERS );
const DEBUG_GROUND_SURFACE = readStringEnv( 'VITE_DEBUG_GROUND_SURFACE', 'false' ).toLowerCase() === 'true';

interface RectangleGuiModel {
	points: string;
}

/**
 * Boots the Three scene and executes the Cesium ground pipeline every frame.
 */
export function runGroundDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

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
	const cameraHeightMeters = Math.max(
		Math.max( RECTANGLE_WIDTH_METERS, RECTANGLE_HEIGHT_METERS ) * CAMERA_HEIGHT_MULTIPLIER,
		MIN_CAMERA_HEIGHT_METERS,
	);
	const cameraEastMeters = Math.max(
		Math.max( RECTANGLE_WIDTH_METERS, RECTANGLE_HEIGHT_METERS ) * CAMERA_EAST_MULTIPLIER,
		MIN_CAMERA_EAST_METERS,
	);
	camera.position
		.copy( target )
		.addScaledVector( up, cameraHeightMeters )
		.addScaledVector( eastBias, cameraEastMeters );
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
	const initialRectangleDegrees = rectangleDegreesFromCenterSizeMeters(
		RECTANGLE_CENTER_LON,
		RECTANGLE_CENTER_LAT,
		RECTANGLE_WIDTH_METERS,
		RECTANGLE_HEIGHT_METERS,
	);
	const initialRectangleMeterSize = rectangleMeterSizeFromDegrees( initialRectangleDegrees );
	const initialRectanglePoints: LonLatPoint[] = [
		[ initialRectangleDegrees.west, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.north ],
		[ initialRectangleDegrees.west, initialRectangleDegrees.north ],
	];

	const debugSettings: GroundDebugSettings = {
		points: initialRectanglePoints,
		centerLon: RECTANGLE_CENTER_LON,
		centerLat: RECTANGLE_CENTER_LAT,
		widthDegrees: initialRectangleDegrees.east - initialRectangleDegrees.west,
		heightDegrees: initialRectangleDegrees.north - initialRectangleDegrees.south,
		widthMeters: initialRectangleMeterSize.widthMeters,
		heightMeters: initialRectangleMeterSize.heightMeters,
		halfWidth: ( initialRectangleDegrees.east - initialRectangleDegrees.west ) * 0.5,
		halfHeight: ( initialRectangleDegrees.north - initialRectangleDegrees.south ) * 0.5,
		fillColor: '#ff0000',
		fillOpacity: 72,
		visible: true,
		rectanglePlotOrder: 0,
		strokeColor: '#ffffff',
		strokeOpacity: 95,
		strokeWidth: DEFAULT_PLOT_SIZE_METERS,
		fragmentCull: true,
		useTilesDepth: true,
		showTiles: true,
		showFrontStencil: true,
		showBackStencil: true,
		showColorPass: true,
		showPolygon: true,
		polygonPlotOrder: 1,
		polygonColor: '#00aaff',
		polygonAlpha: 0.68,
		polygonCenterLon: RECTANGLE_CENTER_LON,
		polygonCenterLat: RECTANGLE_CENTER_LAT,
		polygonOffsetEastMeters: 0.0,
		polygonOffsetNorthMeters: 0.0,
		polygonWidthMeters: clampNumber( initialRectangleMeterSize.widthMeters, MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE ),
		polygonHeightMeters: clampNumber( initialRectangleMeterSize.heightMeters, MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE ),
		polygonRotationDegrees: 18.0,
		polygonVertexCount: 5,
		polygonDentRatio: 1.0,
		polygonHole: false,
		polygonHoleScale: 0.36,
		showDebugSurface: DEBUG_GROUND_SURFACE,
		debugSurfaceHeight: DEFAULT_PLOT_SIZE_METERS,
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
	 * Normalizes polygon GUI values before Cesium geometry is created.
	 */
	function normalizePolygonDebugSettings(): void {
		debugSettings.polygonOffsetEastMeters = Number.isFinite( debugSettings.polygonOffsetEastMeters )
			? clampNumber( debugSettings.polygonOffsetEastMeters, MIN_GUI_OFFSET_METERS, MAX_GUI_OFFSET_METERS )
			: 0.0;
		debugSettings.polygonOffsetNorthMeters = Number.isFinite( debugSettings.polygonOffsetNorthMeters )
			? clampNumber( debugSettings.polygonOffsetNorthMeters, MIN_GUI_OFFSET_METERS, MAX_GUI_OFFSET_METERS )
			: 0.0;
		debugSettings.polygonWidthMeters = Number.isFinite( debugSettings.polygonWidthMeters )
			? clampNumber( debugSettings.polygonWidthMeters, MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE )
			: DEFAULT_PLOT_SIZE_METERS;
		debugSettings.polygonHeightMeters = Number.isFinite( debugSettings.polygonHeightMeters )
			? clampNumber( debugSettings.polygonHeightMeters, MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE )
			: DEFAULT_PLOT_SIZE_METERS;
		debugSettings.polygonRotationDegrees = Number.isFinite( debugSettings.polygonRotationDegrees )
			? debugSettings.polygonRotationDegrees
			: 0.0;
		debugSettings.polygonVertexCount = Number.isFinite( debugSettings.polygonVertexCount )
			? Math.round( clampNumber( debugSettings.polygonVertexCount, 3, 64 ) )
			: 3;
		debugSettings.polygonDentRatio = Number.isFinite( debugSettings.polygonDentRatio )
			? clampNumber( debugSettings.polygonDentRatio, 0.05, 1.0 )
			: 1.0;
		debugSettings.polygonHoleScale = Number.isFinite( debugSettings.polygonHoleScale )
			? clampNumber( debugSettings.polygonHoleScale, 0.01, 0.85 )
			: 0.36;
		if ( debugSettings.polygonHole ) {
			const maxHoleScale = Math.max( debugSettings.polygonDentRatio * 0.85, 0.01 );
			debugSettings.polygonHoleScale = Math.min( debugSettings.polygonHoleScale, maxHoleScale );
		}
	}

	/**
	 * Creates a Cesium shadow-volume rectangle from the current GUI settings.
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
	 * Creates a configurable Cesium polygon near the current rectangle center.
	 *
	 * @returns Ground polygon primitive using Cesium shadow-volume geometry.
	 */
	function createGroundPolygon(): CesiumGroundPolygonPrimitive {
		normalizePolygonDebugSettings();

		const polygonCenter = longitudeLatitudeFromCenterOffsetsMeters(
			debugSettings.polygonCenterLon,
			debugSettings.polygonCenterLat,
			[
				{
					eastMeters: debugSettings.polygonOffsetEastMeters,
					northMeters: debugSettings.polygonOffsetNorthMeters,
				},
			],
		)[ 0 ];
		const outerOffsets = createLocalPolygonOffsets(
			debugSettings.polygonWidthMeters,
			debugSettings.polygonHeightMeters,
			debugSettings.polygonVertexCount,
			debugSettings.polygonRotationDegrees,
			debugSettings.polygonDentRatio,
		);
		const positions = longitudeLatitudeFromCenterOffsetsMeters(
			polygonCenter.longitude,
			polygonCenter.latitude,
			outerOffsets,
		);
		const hierarchy: PolygonHierarchyDegrees = { positions };

		if ( debugSettings.polygonHole ) {
			const maxHoleScale = Math.max( debugSettings.polygonDentRatio * 0.85, 0.01 );
			const holeScale = clampNumber( debugSettings.polygonHoleScale, 0.01, maxHoleScale );
			const holeOffsets = createLocalPolygonOffsets(
				debugSettings.polygonWidthMeters * holeScale,
				debugSettings.polygonHeightMeters * holeScale,
				Math.max( Math.round( debugSettings.polygonVertexCount ), 3 ),
				debugSettings.polygonRotationDegrees,
				1.0,
			).reverse();
			hierarchy.holes = [
				{
					positions: longitudeLatitudeFromCenterOffsetsMeters(
						polygonCenter.longitude,
						polygonCenter.latitude,
						holeOffsets,
					),
				},
			];
		}

		return new CesiumGroundPolygonPrimitive( {
			polygonHierarchyDegrees: hierarchy,
			color: debugSettings.polygonColor,
			alpha: debugSettings.polygonAlpha,
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
			new Color( debugSettings.polygonColor ),
			debugSettings.polygonAlpha,
		);
		groundPolygon.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundPolygon.setRenderOrder( plotOrderToRenderOrder( debugSettings.polygonPlotOrder ) );
		groundPolygon.classification.group.visible = debugSettings.showPolygon;
		groundPolygon.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
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
		rectangleFolder.add( debugSettings, 'strokeWidth', MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE, GUI_METER_STEP ).name( 'strokeWidth' ).onFinishChange( rebuildGroundRectangle );
		rectangleFolder.add( debugSettings, 'strokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		rectangleFolder.addColor( debugSettings, 'fillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'fillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'visible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'rectanglePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyGroundDebugSettings ).listen();

		const polygonFolder = gui.addFolder( 'Polygon' );
		polygonFolder.add( debugSettings, 'showPolygon' ).name( 'show polygon' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyGroundDebugSettings ).listen();
		polygonFolder.addColor( debugSettings, 'polygonColor' ).name( 'polygon color' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonAlpha', 0.0, 1.0, 0.01 ).name( 'polygon alpha' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonCenterLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonCenterLat', - 85.0, 85.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonOffsetEastMeters', MIN_GUI_OFFSET_METERS, MAX_GUI_OFFSET_METERS, GUI_METER_STEP ).name( 'offset east m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonOffsetNorthMeters', MIN_GUI_OFFSET_METERS, MAX_GUI_OFFSET_METERS, GUI_METER_STEP ).name( 'offset north m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonWidthMeters', MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE, GUI_METER_STEP ).name( 'width m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonHeightMeters', MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE, GUI_METER_STEP ).name( 'height m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonVertexCount', 3, 16, 1 ).name( 'vertices' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonDentRatio', 0.05, 1.0, 0.01 ).name( 'dent ratio' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonHole' ).name( 'hole' ).onChange( rebuildGroundPolygonFromGui );
		polygonFolder.add( debugSettings, 'polygonHoleScale', 0.01, 0.85, 0.01 ).name( 'hole scale' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();

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
		debugFolder.add( debugSettings, 'debugSurfaceHeight', MIN_GUI_METER_VALUE, MAX_GUI_METER_VALUE, GUI_METER_STEP ).name( 'surface height m' ).onFinishChange( rebuildGroundRectangle );
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

		infoBody.textContent =
			`Cesium source: cesium-ground-source\\n` +
			`Tiles: 3d-tiles-renderer + Cesium Ion asset ${ readStringEnv( 'VITE_CESIUM_ION_ASSET_ID', '96188' ) === '1' ? '96188' : readStringEnv( 'VITE_CESIUM_ION_ASSET_ID', '96188' ) }\\n` +
			`Terrain plugin: QuantizedMeshPlugin for TERRAIN assets\\n` +
			`Geometry: RectangleGeometry.createShadowVolume\\n` +
			`Rectangle: ${ debugSettings.visible ? 'on' : 'off' } / order ${ debugSettings.rectanglePlotOrder } / ${ debugSettings.widthDegrees.toFixed( 4 ) } deg x ${ debugSettings.heightDegrees.toFixed( 4 ) } deg\\n` +
			`Rectangle meters: ${ debugSettings.widthMeters.toFixed( 1 ) } m x ${ debugSettings.heightMeters.toFixed( 1 ) } m\\n` +
			`Polygon: ${ debugSettings.showPolygon ? 'on' : 'off' } / order ${ debugSettings.polygonPlotOrder } / PolygonGeometry.createShadowVolume\\n` +
			`Polygon shape: ${ debugSettings.polygonWidthMeters.toFixed( 1 ) } m x ${ debugSettings.polygonHeightMeters.toFixed( 1 ) } m / vertices ${ debugSettings.polygonVertexCount } / hole ${ debugSettings.polygonHole ? 'on' : 'off' }\\n` +
			`Polygon center: ${ debugSettings.polygonCenterLon.toFixed( 5 ) }, ${ debugSettings.polygonCenterLat.toFixed( 5 ) } / offset east ${ debugSettings.polygonOffsetEastMeters.toFixed( 1 ) } m, north ${ debugSettings.polygonOffsetNorthMeters.toFixed( 1 ) } m / rotation ${ debugSettings.polygonRotationDegrees.toFixed( 1 ) } deg\\n` +
			`Debug surface: ${ debugSettings.showDebugSurface ? 'on' : 'off' }\\n` +
			`Rectangle stroke: ${ debugSettings.strokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.strokeOpacity.toFixed( 0 ) }%\\n` +
			`CULL_FRAGMENTS: ${ debugSettings.fragmentCull ? 'on' : 'off' }\\n` +
			`Shader: ShadowVolumeAppearanceVS/FS + ShadowVolumeFS\\n` +
			`Stencil mask: 0x0f, zfail front=DECR_WRAP back=INCR_WRAP\\n` +
			`Globe depth: tilesRenderer.group -> czm_packDepth -> czm_unpackDepth\\n` +
			`Root/model visible: ${ tileCounters.rootLoaded ? 'yes' : 'loading' } / ${ tileCounters.modelsVisible }\\n` +
			`Tiles visible/cache/loaded: ${ stats.visible } / ${ stats.inCache } / ${ stats.loaded }\\n` +
			`Queue download parse failed: ${ stats.queued } / ${ stats.downloading } / ${ stats.parsing } / ${ stats.failed }\\n` +
			`Loaded model events: ${ tileCounters.modelsLoaded }\\n` +
			`Drawing buffer: ${ renderer.domElement.width } x ${ renderer.domElement.height }` +
			( tileLoadError ? `\\nTile load error: ${ tileLoadError }` : '' );

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

