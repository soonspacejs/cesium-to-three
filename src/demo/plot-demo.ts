// ============================================================
// plot-demo.ts
// 层级：Plot Editor v1 端到端演示。
// 职责：首屏直接提供八类图形、统一输入/状态机、编辑 overlay 与 history；
//       不再安装 demo 私有 pointer listener，也不直接修改 GroundDecalManager。
// ============================================================

import {
	AmbientLight,
	Color,
	DirectionalLight,
	Matrix4,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';

import {
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	CesiumGlobeDepth,
	EllipsoidDepthSource,
	initializeApproximateTerrainHeights,
	longitudeLatitudeFromCenterOffsetsMeters,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from '../lib/ground';
import {
	EditorSurfacePicker,
	GlobeControlsNavigationAdapter,
	HeightReference,
	createPlotEditor,
	type DrawTool,
	type PlotDocumentSnapshot,
	type PlotEditor,
	type PlotFeature,
	type PlotFeatureType,
	type Position3D,
	type ScreenPosition,
	type SurfaceHit,
	type SurfaceRaycastPort,
} from '../lib/plot-editor';
import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import {
	configureLoadedTileScene,
	createCesiumTilesRenderer,
} from './tiles';

const CENTER_LONGITUDE = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const CENTER_LATITUDE = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );
const DEMO_POSITION_SCALE = 1;

export function runPlotDemo(): void {
	installPageStyle();
	installEditorPanelStyle();
	initializeApproximateTerrainHeights();
	const infoBody = createInfoPanel();
	const app = document.getElementById( 'app' );
	if ( app === null ) throw new Error( 'Missing #app container.' );
	app.replaceChildren();
	app.style.position = 'relative';
	app.tabIndex = 0;

	const scene = new Scene();
	scene.background = new Color( 0x05070a );
	scene.add( new AmbientLight( 0xffffff, 0.48 ) );
	const sun = new DirectionalLight( 0xffffff, 1.8 );
	sun.position.set( 0.35, -0.45, 0.82 ).normalize();
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
		0.1,
		40_000_000,
	);
	camera.up.set( 0, 0, 1 );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );
	const target = wgs84PositionFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE, 0 );
	const up = wgs84NormalFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE );
	// 首屏保留街区级米制尺寸，同时给八类示例和两层编辑面板留出可点击空间。
	camera.position.copy( target ).addScaledVector( up, 400 );
	camera.lookAt( target );
	camera.updateMatrixWorld();

	const url = new URLSearchParams( window.location.search );
	const disableTerrain = url.has( 'noterrain' )
		|| url.has( 'noTerrain' )
		|| readStringEnv( 'VITE_DISABLE_TERRAIN' ).toLowerCase() === 'true';
	const tilesRenderer = createCesiumTilesRenderer( renderer, disableTerrain );
	let tileLoadError = '';
	tilesRenderer.addEventListener( 'load-model', ( event ) => {
		configureLoadedTileScene( ( event as unknown as { scene: object } ).scene as never );
	} );
	tilesRenderer.addEventListener( 'load-error', ( event ) => {
		const error = ( event as unknown as { error?: { message?: string } } ).error;
		tileLoadError = error?.message ?? 'unknown';
	} );
	tilesRenderer.setCamera( camera );
	tilesRenderer.setResolutionFromRenderer( camera, renderer );
	scene.add( tilesRenderer.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( tilesRenderer.ellipsoid, tilesRenderer.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 0.1;
	controls.maxDistance = 30_000_000;
	controls.adjustHeight = true;

	const globeDepth = new CesiumGlobeDepth(
		renderer.domElement.width,
		renderer.domElement.height,
	);
	const ellipsoidDepth = new EllipsoidDepthSource();
	ellipsoidDepth.attach( { mainScene: scene, globeDepth } );
	const navigation = new GlobeControlsNavigationAdapter( controls );
	const surfacePicker = new EditorSurfacePicker(
		createDemoSurfaceRaycastPort( renderer, camera, tilesRenderer ),
	);
	const status: DemoStatus = {
		mode: 'select',
		selection: '无',
		history: 'undo 0 / redo 0',
		message: '单击图形选择；双击进入顶点编辑；G/R/S 变换；F2 编辑文本。',
	};
	let renderRequested = true;
	const editor = createPlotEditor( {
		root: app,
		canvas: renderer.domElement,
		document: createDemoDocument(),
		renderHost: {
			scene,
			camera,
			requestRender: () => { renderRequested = true; },
			getFrameState: () => ( {
				depthTexture: globeDepth.target.texture,
				width: renderer.domElement.width,
				height: renderer.domElement.height,
				camera,
				pixelRatio: renderer.getPixelRatio(),
			} ),
		},
		surfacePicker,
		cameraController: navigation,
		requestSave: ( snapshot ) => {
			localStorage.setItem( 'cesium-to-three/plot-editor-demo', JSON.stringify( snapshot ) );
			status.message = `已保存 revision ${ snapshot.revision } 到 localStorage。`;
		},
	} );
	const panel = installEditorPanel( app, editor, status );
	installEditorEvents( editor, status, panel );
	editor.focus();
	let animationFrameRequestId: number | undefined;
	let disposed = false;

	function resize(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setSize( width, height );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
		tilesRenderer.setResolutionFromRenderer( camera, renderer );
		globeDepth.resize( renderer.domElement.width, renderer.domElement.height );
		renderRequested = true;
	}
	window.addEventListener( 'resize', resize );

	function renderFrame(): void {
		if ( disposed ) return;
		animationFrameRequestId = requestAnimationFrame( renderFrame );
		controls.update();
		const shouldRender = renderRequested || controls.enabled;
		if ( shouldRender ) {
			camera.updateMatrixWorld();
			tilesRenderer.setResolutionFromRenderer( camera, renderer );
			tilesRenderer.update();
			updateTerrainLogDepthUniforms( camera.near, camera.far );
			ellipsoidDepth.update( camera );
			globeDepth.render( renderer, camera, scene, tilesRenderer.group, {
				includeFallbackDepth: disableTerrain,
			} );
		}
		editor.update();
		if ( shouldRender ) {
			renderer.render( scene, camera );
			renderRequested = false;
			updateInfo( infoBody, editor, tilesRenderer, tileLoadError, disableTerrain, status );
		}
	}

	( window as unknown as { __plotDemo?: unknown } ).__plotDemo = {
		renderer,
		scene,
		camera,
		tilesRenderer,
		controls,
		globeDepth,
		ellipsoidDepth,
		editor,
		dispose(): void {
			if ( disposed ) return;
			disposed = true;
			if ( animationFrameRequestId !== undefined ) {
				cancelAnimationFrame( animationFrameRequestId );
				animationFrameRequestId = undefined;
			}
			window.removeEventListener( 'resize', resize );
			editor.dispose();
			surfacePicker.dispose();
			controls.dispose();
			tilesRenderer.dispose();
			ellipsoidDepth.dispose();
			globeDepth.dispose();
			renderer.dispose();
			panel.remove();
		},
	};
	animationFrameRequestId = requestAnimationFrame( renderFrame );
}

interface DemoStatus {
	mode: string;
	selection: string;
	history: string;
	message: string;
}

function installEditorEvents(
	editor: PlotEditor,
	status: DemoStatus,
	panel: HTMLElement,
): void {
	const message = panel.querySelector( '[data-editor-message]' ) as HTMLElement;
	const refresh = () => { message.textContent = status.message; };
	editor.addEventListener( 'modechange', ( event ) => {
		status.mode = event.mode;
		for ( const button of panel.querySelectorAll<HTMLButtonElement>( '[data-tool]' ) ) {
			button.classList.toggle(
				'active',
				button.dataset.tool === ( event.mode.startsWith( 'draw:' )
					? event.mode.slice( 5 )
					: event.mode ),
			);
		}
	} );
	editor.addEventListener( 'selectionchange', ( event ) => {
		status.selection = event.selection.ids.length === 0
			? '无'
			: event.selection.ids.join( ', ' );
	} );
	editor.addEventListener( 'historystatechange', ( event ) => {
		status.history = `undo ${ event.undoCount } / redo ${ event.redoCount }`;
	} );
	editor.addEventListener( 'validationerror', ( event ) => {
		status.message = `${ event.diagnostic.code }：${ event.diagnostic.message }`;
		refresh();
	} );
	editor.addEventListener( 'surfacechange', ( event ) => {
		status.message = `${ event.featureIds.join( ', ' ) } surface ${ event.status }`;
		refresh();
	} );
	editor.addEventListener( 'saverequest', () => {
		status.message = '正在保存当前文档……';
		refresh();
	} );
}

function installEditorPanel(
	root: HTMLElement,
	editor: PlotEditor,
	status: DemoStatus,
): HTMLElement {
	root.querySelector( '#plot-editor-panel' )?.remove();
	const panel = document.createElement( 'section' );
	panel.id = 'plot-editor-panel';
	const title = document.createElement( 'h1' );
	title.textContent = 'GIS Plot Editor v1';
	panel.appendChild( title );
	const tools = document.createElement( 'div' );
	tools.className = 'editor-tools';
	for ( const type of [
		'select', 'point', 'line', 'polygon', 'rectangle',
		'circle', 'sector', 'arrow', 'text',
	] as const ) {
		const button = document.createElement( 'button' );
		button.type = 'button';
		button.dataset.tool = type;
		button.textContent = toolLabel( type );
		button.classList.toggle( 'active', type === 'select' );
		button.addEventListener( 'click', () => {
			const tool: DrawTool | 'select' = type === 'select'
				? 'select'
				: drawTool( type );
			editor.activateTool( tool );
			editor.focus();
		} );
		tools.appendChild( button );
	}
	panel.appendChild( tools );
	const message = document.createElement( 'p' );
	message.dataset.editorMessage = 'true';
	message.textContent = status.message;
	panel.appendChild( message );
	const shortcuts = document.createElement( 'p' );
	shortcuts.className = 'editor-shortcuts';
	shortcuts.textContent = '左键绘制/选择 · 右键或 Enter 完成 · Esc 取消 · Ctrl 拖框 · Ctrl+Z/Y · Delete · G/R/S · X/Y/Z · 方向键 · F2';
	panel.appendChild( shortcuts );
	document.body.appendChild( panel );
	return panel;
}

function drawTool( type: Exclude<PlotFeatureType, never> ): DrawTool {
	if ( type === 'text' ) {
		return {
			type,
			heightReference: HeightReference.CLAMP_TO_GROUND,
			options: { content: '新建文本（F2 可编辑）' },
		};
	}
	if ( type === 'arrow' ) {
		return {
			type,
			heightReference: HeightReference.CLAMP_TO_GROUND,
			options: { arrowType: 'attack', sizeScale: 1 },
		};
	}
	return { type, heightReference: HeightReference.CLAMP_TO_GROUND };
}

function toolLabel( type: PlotFeatureType | 'select' ): string {
	return ( {
		select: '选择', point: '点', line: '线', polygon: '面', rectangle: '矩形',
		circle: '圆', sector: '扇形', arrow: '箭头', text: '文本',
	} as const )[ type ];
}

function createDemoDocument(): PlotDocumentSnapshot {
	const features = createDemoFeatures();
	return Object.freeze( {
		schema: 'cesium-to-three/plot-document' as const,
		version: 1 as const,
		documentId: 'plot-editor-demo',
		revision: 0,
		features,
		order: Object.freeze( features.map( ( feature ) => feature.id ) ),
		metadata: Object.freeze( { demo: true } ),
	} );
}

function createDemoFeatures(): readonly PlotFeature[] {
	const point = positionAt( -90, 45 );
	const line = positionsAt( [ [ -70, 0 ], [ -25, 25 ], [ 20, 2 ] ] );
	const polygon = positionsAt( [ [ 35, 5 ], [ 80, 5 ], [ 90, 42 ], [ 48, 55 ] ] );
	const rectangle = positionsAt( [ [ -105, -65 ], [ -45, -65 ], [ -45, -25 ], [ -105, -25 ] ] );
	const arrow = positionsAt( [ [ -15, -60 ], [ 20, -30 ], [ 60, -55 ] ] );
	const common = Object.freeze( {
		strokeColor: '#ffffff', strokeWidth: 3, strokeOpacity: 100,
		fillColor: '#168cff', fillOpacity: 34,
	} );
	return Object.freeze( [
		{
			id: 'demo-point', type: 'point', geometry: { position: point },
			style: { ...common, fillColor: '#ffb020', pointStyle: 'circle', size: 14 },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '点' }, revision: 0,
		},
		{
			id: 'demo-line', type: 'line', geometry: { positions: line },
			style: { ...common, fillOpacity: 0, strokeStyle: 'solid', showArrow: true, startArrowStyle: null, endArrowStyle: 'filledArrow' },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '线' }, revision: 0,
		},
		{
			id: 'demo-polygon', type: 'polygon', geometry: { positions: polygon }, style: common,
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '多边形' }, revision: 0,
		},
		{
			id: 'demo-rectangle', type: 'rectangle', geometry: { positions: rectangle },
			style: { ...common, fillColor: '#22c55e' },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '矩形' }, revision: 0,
		},
		{
			id: 'demo-circle', type: 'circle', geometry: { center: positionAt( 0, 70 ), radius: 22 },
			style: { ...common, fillColor: '#a855f7' },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '圆' }, revision: 0,
		},
		{
			id: 'demo-sector', type: 'sector', geometry: { center: positionAt( 85, -38 ), radius: 30, startAngle: 25, sectorAngle: 120 },
			style: { ...common, fillColor: '#f43f5e' },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '扇形' }, revision: 0,
		},
		{
			id: 'demo-arrow', type: 'arrow', geometry: { positions: arrow, arrowType: 'attack', sizeScale: 1 },
			style: { ...common, fillColor: '#06b6d4' },
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '箭头' }, revision: 0,
		},
		{
			id: 'demo-text', type: 'text', geometry: { position: positionAt( 105, 60 ) },
			style: {
				...common, content: '双击或 F2 编辑中文', fontColor: '#ffffff', fontSize: 20,
				scale: 1, textAlign: 'left', verticalAlign: 'middle', anchorX: 'center',
				anchorY: 'middle', padding: 5, layoutDirection: 'horizontal', rotation: 0,
				offsetX: 0, offsetY: 0, showBorder: true,
			},
			heightReference: HeightReference.CLAMP_TO_GROUND, visible: true,
			properties: { name: '文本' }, revision: 0,
		},
	] as PlotFeature[] );
}

function positionAt( eastMeters: number, northMeters: number ): Position3D {
	const position = longitudeLatitudeFromCenterOffsetsMeters(
		CENTER_LONGITUDE,
		CENTER_LATITUDE,
		[ {
			eastMeters: eastMeters * DEMO_POSITION_SCALE,
			northMeters: northMeters * DEMO_POSITION_SCALE,
		} ],
	)[ 0 ];
	return Object.freeze( [ position.longitude, position.latitude, 0 ] );
}

function positionsAt(
	offsets: readonly ( readonly [ eastMeters: number, northMeters: number ] )[],
): readonly Position3D[] {
	return Object.freeze( offsets.map( ( offset ) => positionAt( offset[ 0 ], offset[ 1 ] ) ) );
}

function createDemoSurfaceRaycastPort(
	renderer: WebGLRenderer,
	camera: PerspectiveCamera,
	tilesRenderer: TilesRenderer,
): SurfaceRaycastPort {
	const raycaster = new Raycaster();
	const ndc = new Vector2();
	const local = new Vector3();
	const inverse = new Matrix4();
	const setRay = ( screen: ScreenPosition ) => {
		const rect = renderer.domElement.getBoundingClientRect();
		ndc.set(
			( ( screen.clientX - rect.left ) / rect.width ) * 2 - 1,
			-( ( screen.clientY - rect.top ) / rect.height ) * 2 + 1,
		);
		raycaster.setFromCamera( ndc, camera );
		tilesRenderer.group.updateMatrixWorld();
	};
	const surfaceHit = ( point: Vector3, surface: SurfaceHit[ 'surface' ] ): SurfaceHit => {
		local.copy( point );
		tilesRenderer.group.worldToLocal( local );
		const cartographic = tilesRenderer.ellipsoid.getPositionToCartographic(
			local,
			{ lat: 0, lon: 0, height: 0 },
		);
		return Object.freeze( {
			surfacePosition: Object.freeze( [
				cartographic.lon * 180 / Math.PI,
				cartographic.lat * 180 / Math.PI,
				cartographic.height,
			] ) as Position3D,
			surface,
			distanceFromCamera: camera.position.distanceTo( point ),
		} );
	};
	return {
		pickTerrain( screen ) {
			setRay( screen );
			const hit = raycaster.intersectObject( tilesRenderer.group, true )[ 0 ];
			return hit === undefined ? Object.freeze( [] ) : Object.freeze( [ surfaceHit( hit.point, 'terrain' ) ] );
		},
		pickTiles() { return Object.freeze( [] ); },
		pickEllipsoid( screen ) {
			setRay( screen );
			inverse.copy( tilesRenderer.group.matrixWorld ).invert();
			const localRay = raycaster.ray.clone().applyMatrix4( inverse );
			const hit = tilesRenderer.ellipsoid.intersectRay( localRay, local );
			if ( hit === null ) return null;
			const world = tilesRenderer.group.localToWorld( hit.clone() );
			return surfaceHit( world, 'ellipsoid' );
		},
	};
}

function updateInfo(
	info: HTMLElement,
	editor: PlotEditor,
	tilesRenderer: TilesRenderer,
	tileLoadError: string,
	disableTerrain: boolean,
	status: DemoStatus,
): void {
	const stats = ( tilesRenderer as TilesRenderer & {
		stats: { visible: number; inCache: number; loaded: number };
	} ).stats;
	info.textContent = [
		`Plot Editor @ (${ CENTER_LONGITUDE.toFixed( 4 ) }, ${ CENTER_LATITUDE.toFixed( 4 ) })`,
		`Document revision: ${ editor.document.revision } · features: ${ editor.document.getAll().length }`,
		`Mode: ${ status.mode } · selection: ${ status.selection }`,
		`History: ${ status.history }`,
		disableTerrain ? 'Surface: WGS84 ellipsoid fallback' : 'Surface: Cesium terrain + ellipsoid fallback',
		`Tiles: visible ${ stats.visible } / cache ${ stats.inCache } / loaded ${ stats.loaded }`,
		...( tileLoadError === '' ? [] : [ `Tile load error: ${ tileLoadError }` ] ),
		'',
		status.message,
	].join( '\n' );
}

function installEditorPanelStyle(): void {
	if ( document.getElementById( 'plot-editor-panel-style' ) !== null ) return;
	const style = document.createElement( 'style' );
	style.id = 'plot-editor-panel-style';
	style.textContent = `
		#plot-editor-panel { position:fixed; left:16px; bottom:16px; z-index:30; width:350px;
			padding:14px; border:1px solid rgba(255,255,255,.18); border-radius:10px;
			background:rgba(5,10,16,.88); color:#dcecf6; backdrop-filter:blur(12px);
			font:12px/1.45 Inter,system-ui,sans-serif; box-shadow:0 18px 60px rgba(0,0,0,.38); }
		#plot-editor-panel h1 { margin:0 0 10px; font-size:15px; }
		#plot-editor-panel .editor-tools { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
		#plot-editor-panel button { padding:6px 4px; border:1px solid rgba(255,255,255,.16);
			border-radius:5px; background:rgba(255,255,255,.07); color:inherit; cursor:pointer; }
		#plot-editor-panel button:hover { background:rgba(255,255,255,.14); }
		#plot-editor-panel button.active { color:#00131a; background:#00e5ff; border-color:#00e5ff; }
		#plot-editor-panel p { margin:10px 0 0; }
		#plot-editor-panel .editor-shortcuts { color:#8fb6c8; font-size:11px; }
		.plot-editor-text-input { box-sizing:border-box; }
	`;
	document.head.appendChild( style );
}
