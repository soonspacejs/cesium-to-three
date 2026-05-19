// ============================================================
// main.ts
// Layer: runnable Three.js host for the Cesium GroundPrimitive adapter.
// Role: drives 3d-tiles-renderer terrain and feeds its depth into Cesium's
//       shadow-volume classification shaders through a Three adapter.
// Dependencies: cesium-three-ground.ts, Three.js, 3d-tiles-renderer.
// Consumed by: index.html.
// ============================================================

import {
	AmbientLight,
	Color,
	DirectionalLight,
	FrontSide,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
	type Material,
	type Object3D,
} from 'three';
import { GlobeControls, TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins';
import GUI from 'lil-gui';

import {
	CesiumGlobeDepth,
	CesiumGroundRectanglePrimitive,
	rectangleDegreesFromCenterSizeMeters,
	rectangleMeterSizeFromDegrees,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from './cesium-three-ground';

const RECTANGLE_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const RECTANGLE_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );
const RECTANGLE_HALF_WIDTH_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_WIDTH_DEGREES', 1.5 );
const RECTANGLE_HALF_HEIGHT_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_HEIGHT_DEGREES', 1.0 );
const DEBUG_GROUND_SURFACE = readStringEnv( 'VITE_DEBUG_GROUND_SURFACE', 'false' ).toLowerCase() === 'true';

interface TilesRuntimeStats {
	inCache: number;
	visible: number;
	loaded: number;
	queued: number;
	downloading: number;
	parsing: number;
	failed: number;
}

interface TileRuntimeCounters {
	modelsLoaded: number;
	modelsVisible: number;
	rootLoaded: boolean;
	rootUrl: string;
}

interface GroundDebugSettings {
	centerLon: number;
	centerLat: number;
	widthDegrees: number;
	heightDegrees: number;
	widthMeters: number;
	heightMeters: number;
	halfWidth: number;
	halfHeight: number;
	color: string;
	alpha: number;
	showDebugBorder: boolean;
	borderColor: string;
	borderOpacity: number;
	borderWidthMeters: number;
	fragmentCull: boolean;
	useTilesDepth: boolean;
	showTiles: boolean;
	showFrontStencil: boolean;
	showBackStencil: boolean;
	showColorPass: boolean;
	showDebugSurface: boolean;
	debugSurfaceHeight: number;
	debugSurfaceOpacity: number;
	rebuild: () => void;
}

interface GroundDebugStatus {
	root: string;
	models: number;
	visibleTiles: number;
	cacheTiles: number;
	loadedTiles: number;
	queue: string;
	error: string;
}

/**
 * Reads one numeric Vite environment variable.
 *
 * @param name Vite environment variable name.
 * @param fallback Value used when the variable is absent or invalid.
 * @returns Parsed finite number.
 */
function readNumberEnv( name: string, fallback: number ): number {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	const value = raw === undefined ? Number.NaN : Number( raw );
	return Number.isFinite( value ) ? value : fallback;
}

/**
 * Reads one string Vite environment variable.
 *
 * @param name Vite environment variable name.
 * @param fallback Value used when the variable is absent.
 * @returns Trimmed string value.
 */
function readStringEnv( name: string, fallback = '' ): string {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	return ( raw ?? fallback ).trim();
}

/**
 * Installs a compact page style without relying on a separate stylesheet.
 */
function installPageStyle(): void {
	const style = document.createElement( 'style' );
	style.textContent = `
		body {
			margin: 0;
			overflow: hidden;
			background: #05070a;
			color: #d8e7f2;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		#app {
			width: 100vw;
			height: 100vh;
		}

		#info-panel {
			position: fixed;
			left: 16px;
			top: 16px;
			width: min(470px, calc(100vw - 32px));
			box-sizing: border-box;
			border: 1px solid rgba(255, 255, 255, 0.14);
			border-radius: 8px;
			background: rgba(5, 7, 10, 0.78);
			backdrop-filter: blur(10px);
			padding: 14px 16px;
			pointer-events: none;
			box-shadow: 0 16px 52px rgba(0, 0, 0, 0.34);
		}

		#info-panel .title {
			font-weight: 700;
			margin-bottom: 8px;
		}

		#info-panel .body,
		#info-panel .hint {
			white-space: pre-line;
			font-family: "SFMono-Regular", Consolas, monospace;
			font-size: 12px;
			line-height: 1.55;
			color: #aebdca;
		}

		#info-panel .hint {
			margin-top: 10px;
			color: #8edeb5;
		}
	`;
	document.head.appendChild( style );
}

/**
 * Creates the fixed info panel expected by the demo page.
 *
 * @returns The body element whose text is updated per frame.
 */
function createInfoPanel(): HTMLElement {
	const oldInfoPanel = document.getElementById( 'info-panel' );
	oldInfoPanel?.remove();

	const panel = document.createElement( 'div' );
	panel.id = 'info-panel';
	panel.innerHTML = `
		<div class="title">Cesium GroundPrimitive -> Three + 3D Tiles</div>
		<div class="body" id="info-body"></div>
		<div class="hint">drag: globe controls / wheel: zoom / right drag: pan</div>
	`;
	document.body.appendChild( panel );

	return panel.querySelector( '#info-body' ) as HTMLElement;
}

/**
 * Applies stable render state to every model that 3d-tiles-renderer loads.
 *
 * @param modelScene Root object created for a loaded tile.
 */
function configureLoadedTileScene( modelScene: Object3D ): void {
	modelScene.traverse( object => {
		object.visible = true;
		object.frustumCulled = false;
		object.renderOrder = 0;

		const maybeMesh = object as Object3D & {
			isMesh?: boolean;
			material?: Material | Material[];
		};
		if ( maybeMesh.isMesh && maybeMesh.material ) {
			const materials = Array.isArray( maybeMesh.material )
				? maybeMesh.material
				: [ maybeMesh.material ];

			for ( const material of materials ) {
				material.depthTest = true;
				material.depthWrite = true;
				material.side = FrontSide;

				const maybeColoredMaterial = material as Material & {
					color?: Color;
					roughness?: number;
					metalness?: number;
				};
				if ( maybeColoredMaterial.color ) {
					maybeColoredMaterial.color.set( 0x8ea37c );
				}
				if ( typeof maybeColoredMaterial.roughness === 'number' ) {
					maybeColoredMaterial.roughness = 0.92;
				}
				if ( typeof maybeColoredMaterial.metalness === 'number' ) {
					maybeColoredMaterial.metalness = 0.0;
				}
			}
		}
	} );
}

/**
 * Creates a Cesium Ion backed 3D Tiles renderer. Terrain assets are handled by
 * QuantizedMeshPlugin so the surface is real terrain geometry, not an ellipsoid.
 *
 * @returns Configured TilesRenderer instance.
 */
function createCesiumTilesRenderer(): TilesRenderer {
	const apiToken = readStringEnv( 'VITE_CESIUM_ION_TOKEN' );
	const configuredAssetId = readStringEnv( 'VITE_CESIUM_ION_ASSET_ID', '1' );
	const assetId = configuredAssetId

	if ( apiToken.length === 0 ) {
		throw new Error( 'Missing VITE_CESIUM_ION_TOKEN. 3d-tiles-renderer terrain cannot start.' );
	}

	const tilesRenderer = new TilesRenderer( '' );
	tilesRenderer.group.name = 'CesiumIonTilesRendererGroup';
	tilesRenderer.errorTarget = 2.0;
	tilesRenderer.autoDisableRendererCulling = true;
	tilesRenderer.displayActiveTiles = true;

	tilesRenderer.registerPlugin( new CesiumIonAuthPlugin( {
		apiToken,
		assetId,
		useRecommendedSettings: true,
		assetTypeHandler: ( type, tiles ) => {
			if ( type === 'TERRAIN' && tiles.getPluginByName( 'QUANTIZED_MESH_PLUGIN' ) === null ) {
				tiles.registerPlugin( new QuantizedMeshPlugin( {
					useRecommendedSettings: true,
					smoothSkirtNormals: true,
					solid: false,
				} ) );
				return;
			}

			console.warn( `Unhandled Cesium Ion asset type: ${ type }` );
		},
	} ) );

	if ( configuredAssetId === '1' ) {
		console.warn( 'VITE_CESIUM_ION_ASSET_ID=1 is treated as 96188 for Cesium World Terrain.' );
	}

	return tilesRenderer;
}

/**
 * Boots the Three scene and executes the Cesium ground pipeline every frame.
 */
function main(): void {
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
		showDebugBorder: true,
		borderColor: '#ffffff',
		borderOpacity: 0.95,
		borderWidthMeters: 6000.0,
		fragmentCull: true,
		useTilesDepth: true,
		showTiles: true,
		showFrontStencil: true,
		showBackStencil: true,
		showColorPass: true,
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
	 * Creates a Cesium shadow-volume rectangle from the current GUI settings.
	 *
	 * @returns Ground rectangle primitive wired for classification and debugging.
	 */
	function createGroundRectangle(): CesiumGroundRectanglePrimitive {
		return new CesiumGroundRectanglePrimitive( {
			rectangleDegrees: getCurrentRectangleDegrees(),
			color: debugSettings.color,
			alpha: debugSettings.alpha,
			renderOrder: 10,
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

	let groundRectangle = createGroundRectangle();
	scene.add( groundRectangle.classification.group );

	/**
	 * Applies GUI state to the existing primitive without rebuilding geometry.
	 */
	function applyGroundDebugSettings(): void {
		const color = new Color( debugSettings.color );
		groundRectangle.classification.setColor( color, debugSettings.alpha );
		groundRectangle.classification.setFragmentCulling( debugSettings.fragmentCull );
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
		groundRectangle.dispose();
		groundRectangle = createGroundRectangle();
		scene.add( groundRectangle.classification.group );
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
		rectangleFolder.add( debugSettings, 'centerLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildFromCenterMeters ).listen();
		rectangleFolder.add( debugSettings, 'centerLat', - 85.0, 85.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildFromCenterMeters ).listen();
		rectangleFolder.add( debugSettings, 'widthMeters', 1.0, 5000000.0, 1.0 ).name( 'width m' ).onFinishChange( rebuildFromSizeMeters ).listen();
		rectangleFolder.add( debugSettings, 'heightMeters', 1.0, 5000000.0, 1.0 ).name( 'height m' ).onFinishChange( rebuildFromSizeMeters ).listen();
		rectangleFolder.add( debugSettings, 'widthDegrees', 0.002, 20.0, 0.001 ).name( 'width deg' ).onFinishChange( rebuildFromSizeDegrees ).listen();
		rectangleFolder.add( debugSettings, 'heightDegrees', 0.002, 20.0, 0.001 ).name( 'height deg' ).onFinishChange( rebuildFromSizeDegrees ).listen();
		rectangleFolder.add( debugSettings, 'halfWidth', 0.001, 10.0, 0.001 ).name( 'half width deg' ).onFinishChange( rebuildFromHalfExtents ).listen();
		rectangleFolder.add( debugSettings, 'halfHeight', 0.001, 10.0, 0.001 ).name( 'half height deg' ).onFinishChange( rebuildFromHalfExtents ).listen();
		rectangleFolder.add( debugSettings, 'rebuild' ).name( 'rebuild primitive' );

		const styleFolder = gui.addFolder( 'Style' );
		styleFolder.addColor( debugSettings, 'color' ).name( 'color' ).onChange( applyGroundDebugSettings );
		styleFolder.add( debugSettings, 'alpha', 0.0, 1.0, 0.01 ).name( 'alpha' ).onChange( applyGroundDebugSettings );
		styleFolder.add( debugSettings, 'showDebugBorder' ).name( 'border overlay' ).onChange( applyGroundDebugSettings );
		styleFolder.addColor( debugSettings, 'borderColor' ).name( 'border color' ).onChange( applyGroundDebugSettings );
		styleFolder.add( debugSettings, 'borderOpacity', 0.0, 1.0, 0.01 ).name( 'border opacity' ).onChange( applyGroundDebugSettings );
		styleFolder.add( debugSettings, 'borderWidthMeters', 1.0, 100000.0, 100.0 ).name( 'border width m' ).onFinishChange( rebuildGroundRectangle );

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
			`Rectangle: ${ debugSettings.widthDegrees.toFixed( 4 ) } deg x ${ debugSettings.heightDegrees.toFixed( 4 ) } deg\\n` +
			`Rectangle meters: ${ debugSettings.widthMeters.toFixed( 1 ) } m x ${ debugSettings.heightMeters.toFixed( 1 ) } m\\n` +
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
	};

	renderFrame();
}

main();
