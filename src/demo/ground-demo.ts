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

const RECTANGLE_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const RECTANGLE_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );
const RECTANGLE_HALF_WIDTH_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_WIDTH_DEGREES', 0.05 );
const RECTANGLE_HALF_HEIGHT_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_HEIGHT_DEGREES', 0.03 );
const DEBUG_GROUND_SURFACE = readStringEnv( 'VITE_DEBUG_GROUND_SURFACE', 'false' ).toLowerCase() === 'true';

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

	const debugSettings: GroundDebugSettings = {
		centerLon: RECTANGLE_CENTER_LON,
		centerLat: RECTANGLE_CENTER_LAT,
		widthDegrees: RECTANGLE_HALF_WIDTH_DEGREES * 2.0,
		heightDegrees: RECTANGLE_HALF_HEIGHT_DEGREES * 2.0,
		widthMeters: initialRectangleMeterSize.widthMeters,
		heightMeters: initialRectangleMeterSize.heightMeters,
		halfWidth: RECTANGLE_HALF_WIDTH_DEGREES,
		halfHeight: RECTANGLE_HALF_HEIGHT_DEGREES,
		color: '#ff0000',
		alpha: 0.72,
		showRectangle: true,
		rectanglePlotOrder: 0,
		showDebugBorder: true,
		borderColor: '#ffffff',
		borderOpacity: 0.95,
		borderWidthMeters: 300.0,
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
		polygonOffsetEastMeters: 0.0,
		polygonOffsetNorthMeters: 0.0,
		polygonWidthMeters: Math.max( initialRectangleMeterSize.widthMeters * 0.7, 1.0 ),
		polygonHeightMeters: Math.max( initialRectangleMeterSize.heightMeters * 0.7, 1.0 ),
		polygonRotationDegrees: 18.0,
		polygonVertexCount: 5,
		polygonDentRatio: 1.0,
		polygonHole: false,
		polygonHoleScale: 0.36,
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

	/**
	 * Returns the current fill rectangle described by the GUI center and degree extents.
	 *
	 * @returns Rectangle in WGS84 degrees.
	 */
	function getCurrentRectangleDegrees(): { west: number; south: number; east: number; north: number } {
		return {
			west: debugSettings.centerLon - debugSettings.halfWidth,
			south: debugSettings.centerLat - debugSettings.halfHeight,
			east: debugSettings.centerLon + debugSettings.halfWidth,
			north: debugSettings.centerLat + debugSettings.halfHeight,
		};
	}

	/**
	 * Stores a WGS84 degree rectangle back into the GUI size fields.
	 *
	 * @param rectangle Rectangle in WGS84 degrees.
	 */
	function applyRectangleDegreesToDebugSettings( rectangle: { west: number; south: number; east: number; north: number } ): void {
		debugSettings.centerLon = ( rectangle.west + rectangle.east ) * 0.5;
		debugSettings.centerLat = ( rectangle.south + rectangle.north ) * 0.5;
		debugSettings.halfWidth = Math.max( ( rectangle.east - rectangle.west ) * 0.5, 0.0005 );
		debugSettings.halfHeight = Math.max( ( rectangle.north - rectangle.south ) * 0.5, 0.0005 );
		debugSettings.widthDegrees = debugSettings.halfWidth * 2.0;
		debugSettings.heightDegrees = debugSettings.halfHeight * 2.0;
	}

	/**
	 * Refreshes the meter-size GUI fields from the current geographic rectangle.
	 */
	function syncMeterSizeFromCurrentRectangle(): void {
		const meterSize = rectangleMeterSizeFromDegrees( getCurrentRectangleDegrees() );
		debugSettings.widthMeters = meterSize.widthMeters;
		debugSettings.heightMeters = meterSize.heightMeters;
	}

	/**
	 * Normalizes polygon GUI values before Cesium geometry is created.
	 */
	function normalizePolygonDebugSettings(): void {
		debugSettings.polygonOffsetEastMeters = Number.isFinite( debugSettings.polygonOffsetEastMeters )
			? debugSettings.polygonOffsetEastMeters
			: 0.0;
		debugSettings.polygonOffsetNorthMeters = Number.isFinite( debugSettings.polygonOffsetNorthMeters )
			? debugSettings.polygonOffsetNorthMeters
			: 0.0;
		debugSettings.polygonWidthMeters = Number.isFinite( debugSettings.polygonWidthMeters )
			? Math.max( debugSettings.polygonWidthMeters, 1.0 )
			: 1.0;
		debugSettings.polygonHeightMeters = Number.isFinite( debugSettings.polygonHeightMeters )
			? Math.max( debugSettings.polygonHeightMeters, 1.0 )
			: 1.0;
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
			rectangleDegrees: getCurrentRectangleDegrees(),
			color: debugSettings.color,
			alpha: debugSettings.alpha,
			renderOrder: plotOrderToRenderOrder( debugSettings.rectanglePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
			debugSurface: true,
			debugSurfaceHeight: debugSettings.debugSurfaceHeight,
			debugSurfaceOpacity: debugSettings.debugSurfaceOpacity,
			border: debugSettings.showDebugBorder,
			borderColor: debugSettings.borderColor,
			borderOpacity: debugSettings.borderOpacity,
			borderWidthMeters: debugSettings.borderWidthMeters,
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
			debugSettings.centerLon,
			debugSettings.centerLat,
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
		const color = new Color( debugSettings.color );
		groundRectangle.classification.setColor( color, debugSettings.alpha );
		groundRectangle.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundRectangle.setRenderOrder( plotOrderToRenderOrder( debugSettings.rectanglePlotOrder ) );
		groundRectangle.classification.group.visible = debugSettings.showRectangle;
		groundRectangle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundRectangle.classification.setBorderStyle(
			debugSettings.showDebugBorder,
			new Color( debugSettings.borderColor ),
			debugSettings.borderOpacity,
			debugSettings.borderWidthMeters,
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
	 * Rebuilds geometry after the GUI full-size fields change.
	 */
	function rebuildFromSizeDegrees(): void {
		debugSettings.halfWidth = Math.max( debugSettings.widthDegrees * 0.5, 0.0005 );
		debugSettings.halfHeight = Math.max( debugSettings.heightDegrees * 0.5, 0.0005 );
		debugSettings.widthDegrees = debugSettings.halfWidth * 2.0;
		debugSettings.heightDegrees = debugSettings.halfHeight * 2.0;
		syncMeterSizeFromCurrentRectangle();
		rebuildGroundRectangle();
	}

	/**
	 * Rebuilds only geometry-dependent polygon state after polygon GUI edits.
	 */
	function rebuildGroundPolygonFromGui(): void {
		normalizePolygonDebugSettings();
		rebuildGroundPolygon();
	}

	/**
	 * Rebuilds geometry after meter-size fields change.
	 */
	function rebuildFromSizeMeters(): void {
		const rectangle = rectangleDegreesFromCenterSizeMeters(
			debugSettings.centerLon,
			debugSettings.centerLat,
			Math.max( debugSettings.widthMeters, 1.0 ),
			Math.max( debugSettings.heightMeters, 1.0 ),
		);
		applyRectangleDegreesToDebugSettings( rectangle );
		syncMeterSizeFromCurrentRectangle();
		rebuildGroundRectangle();
	}

	/**
	 * Rebuilds geometry after center fields change while keeping meter size stable.
	 */
	function rebuildFromCenterMeters(): void {
		rebuildFromSizeMeters();
	}

	/**
	 * Rebuilds geometry after the GUI half-extent fields change.
	 */
	function rebuildFromHalfExtents(): void {
		debugSettings.halfWidth = Math.max( debugSettings.halfWidth, 0.0005 );
		debugSettings.halfHeight = Math.max( debugSettings.halfHeight, 0.0005 );
		debugSettings.widthDegrees = debugSettings.halfWidth * 2.0;
		debugSettings.heightDegrees = debugSettings.halfHeight * 2.0;
		syncMeterSizeFromCurrentRectangle();
		rebuildGroundRectangle();
	}

	/**
	 * Rebuilds geometry when rectangle extents or debug-surface height change.
	 */
	function rebuildGroundRectangle(): void {
		scene.remove( groundRectangle.classification.group );
		scene.remove( groundPolygon.classification.group );
		groundRectangle.dispose();
		groundPolygon.dispose();
		groundRectangle = createGroundRectangle();
		groundPolygon = createGroundPolygon();
		scene.add( groundRectangle.classification.group );
		scene.add( groundPolygon.classification.group );
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
		rectangleFolder.add( debugSettings, 'showRectangle' ).name( 'show rectangle' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'rectanglePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyGroundDebugSettings ).listen();
		rectangleFolder.add( debugSettings, 'centerLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildFromCenterMeters ).listen();
		rectangleFolder.add( debugSettings, 'centerLat', - 85.0, 85.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildFromCenterMeters ).listen();
		rectangleFolder.add( debugSettings, 'widthMeters', 1.0, 5000000.0, 1.0 ).name( 'width m' ).onFinishChange( rebuildFromSizeMeters ).listen();
		rectangleFolder.add( debugSettings, 'heightMeters', 1.0, 5000000.0, 1.0 ).name( 'height m' ).onFinishChange( rebuildFromSizeMeters ).listen();
		rectangleFolder.add( debugSettings, 'widthDegrees', 0.002, 20.0, 0.001 ).name( 'width deg' ).onFinishChange( rebuildFromSizeDegrees ).listen();
		rectangleFolder.add( debugSettings, 'heightDegrees', 0.002, 20.0, 0.001 ).name( 'height deg' ).onFinishChange( rebuildFromSizeDegrees ).listen();
		rectangleFolder.add( debugSettings, 'halfWidth', 0.001, 10.0, 0.001 ).name( 'half width deg' ).onFinishChange( rebuildFromHalfExtents ).listen();
		rectangleFolder.add( debugSettings, 'halfHeight', 0.001, 10.0, 0.001 ).name( 'half height deg' ).onFinishChange( rebuildFromHalfExtents ).listen();
		rectangleFolder.addColor( debugSettings, 'color' ).name( 'color' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'alpha', 0.0, 1.0, 0.01 ).name( 'alpha' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'showDebugBorder' ).name( 'border overlay' ).onChange( applyGroundDebugSettings );
		rectangleFolder.addColor( debugSettings, 'borderColor' ).name( 'border color' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'borderOpacity', 0.0, 1.0, 0.01 ).name( 'border opacity' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'borderWidthMeters', 1.0, 100000.0, 100.0 ).name( 'border width m' ).onFinishChange( rebuildGroundRectangle );
		rectangleFolder.add( debugSettings, 'rebuild' ).name( 'rebuild primitive' );

		const polygonFolder = gui.addFolder( 'Polygon' );
		polygonFolder.add( debugSettings, 'showPolygon' ).name( 'show polygon' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyGroundDebugSettings ).listen();
		polygonFolder.addColor( debugSettings, 'polygonColor' ).name( 'polygon color' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonAlpha', 0.0, 1.0, 0.01 ).name( 'polygon alpha' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonOffsetEastMeters', - 500000.0, 500000.0, 1.0 ).name( 'offset east m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonOffsetNorthMeters', - 500000.0, 500000.0, 1.0 ).name( 'offset north m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonWidthMeters', 1.0, 2000000.0, 1.0 ).name( 'width m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonHeightMeters', 1.0, 2000000.0, 1.0 ).name( 'height m' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
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
			`Rectangle: ${ debugSettings.showRectangle ? 'on' : 'off' } / order ${ debugSettings.rectanglePlotOrder } / ${ debugSettings.widthDegrees.toFixed( 4 ) } deg x ${ debugSettings.heightDegrees.toFixed( 4 ) } deg\\n` +
			`Rectangle meters: ${ debugSettings.widthMeters.toFixed( 1 ) } m x ${ debugSettings.heightMeters.toFixed( 1 ) } m\\n` +
			`Polygon: ${ debugSettings.showPolygon ? 'on' : 'off' } / order ${ debugSettings.polygonPlotOrder } / PolygonGeometry.createShadowVolume\\n` +
			`Polygon shape: ${ debugSettings.polygonWidthMeters.toFixed( 1 ) } m x ${ debugSettings.polygonHeightMeters.toFixed( 1 ) } m / vertices ${ debugSettings.polygonVertexCount } / hole ${ debugSettings.polygonHole ? 'on' : 'off' }\\n` +
			`Polygon offset: east ${ debugSettings.polygonOffsetEastMeters.toFixed( 1 ) } m, north ${ debugSettings.polygonOffsetNorthMeters.toFixed( 1 ) } m / rotation ${ debugSettings.polygonRotationDegrees.toFixed( 1 ) } deg\\n` +
			`Debug surface: ${ debugSettings.showDebugSurface ? 'on' : 'off' }\\n` +
			`Debug border: ${ debugSettings.showDebugBorder ? 'on' : 'off' } / ${ debugSettings.borderWidthMeters.toFixed( 0 ) } m\\n` +
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

