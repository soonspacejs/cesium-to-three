// ============================================================
// plot-demo.ts
//         - rAF 甯у悎骞?+ 姣忓抚 update(frameState)
//

import {
	AmbientLight,
	Color,
	DirectionalLight,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';
import GUI from 'lil-gui';

import {
	CesiumGlobeDepth,
	EllipsoidDepthSource,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	initializeApproximateTerrainHeights,
	longitudeLatitudeFromCenterOffsetsMeters,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type LonLatPoint,
} from '../lib/ground';
import {
	GroundDecalManager,
	type PlotAddOptions,
	type PlotArrowOptions,
	type PlotArrowStyle,
	type PlotArrowType,
	type PlotCircleOptions,
	type PlotLineOptions,
	type PlotLineStrokeStyle,
	type PlotPointOptions,
	type PlotPolygonOptions,
	type PlotRectangleOptions,
	type PlotSectorOptions,
	type PlotTextAlign,
	type PlotTextAnchorX,
	type PlotTextAnchorY,
	type PlotTextLayoutDirection,
	type PlotTextOptions,
	type PlotTextVerticalAlign,
} from '../lib/plot';

import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import {
	configureLoadedTileScene,
	createCesiumTilesRenderer,
} from './tiles';

// Center anchor near Everest, matching the ground demo terrain target.
const PLOT_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const PLOT_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );

// ENU 鈫?lon/lat 杈呭姪

function lonLatPointsFromMeters(
	centerLon: number,
	centerLat: number,
	offsets: readonly { eastMeters: number; northMeters: number }[],
): LonLatPoint[] {
	return longitudeLatitudeFromCenterOffsetsMeters(
		centerLon,
		centerLat,
		offsets as { eastMeters: number; northMeters: number }[],
	).map( ( p ) => [ p.longitude, p.latitude ] as LonLatPoint );
}

function lonLatFromMeters(
	centerLon: number,
	centerLat: number,
	east: number,
	north: number,
): LonLatPoint {
	return lonLatPointsFromMeters(
		centerLon,
		centerLat,
		[ { eastMeters: east, northMeters: north } ],
	)[ 0 ];
}

function regularPolygonOffsets(
	eastMeters: number,
	northMeters: number,
	radiusMeters: number,
	vertexCount: number,
	rotationDeg: number,
): { eastMeters: number; northMeters: number }[] {
	const rad = ( rotationDeg * Math.PI ) / 180.0;
	const cos = Math.cos( rad );
	const sin = Math.sin( rad );
	const out: { eastMeters: number; northMeters: number }[] = [];
	for ( let i = 0; i < vertexCount; i++ ) {
		const a = ( Math.PI * 2 * i ) / vertexCount + Math.PI * 0.5;
		const x = Math.cos( a ) * radiusMeters;
		const y = Math.sin( a ) * radiusMeters;
		out.push( {
			eastMeters: eastMeters + x * cos - y * sin,
			northMeters: northMeters + x * sin + y * cos,
		} );
	}
	return out;
}


interface BaseState {
	visible: boolean;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	fillColor: string;
	fillOpacity: number;
}

interface PointState extends BaseState {
	pointStyle: 'circle' | 'square';
	size: number;
	centerLon: number;
	centerLat: number;
}

interface LineState {
	visible: boolean;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	strokeStyle: PlotLineStrokeStyle;
	showArrow: boolean;
	startArrowStyle: PlotArrowStyle | 'none';
	endArrowStyle: PlotArrowStyle | 'none';
	translateEastMeters: number;
	translateNorthMeters: number;
	_appliedEastMeters: number;
	_appliedNorthMeters: number;
}

interface PolygonState extends BaseState {
	translateEastMeters: number;
	translateNorthMeters: number;
	_appliedEastMeters: number;
	_appliedNorthMeters: number;
}

interface RectangleState extends BaseState {
	translateEastMeters: number;
	translateNorthMeters: number;
	_appliedEastMeters: number;
	_appliedNorthMeters: number;
}

interface CircleState extends BaseState {
	radius: number;
	centerLon: number;
	centerLat: number;
}

interface SectorState extends BaseState {
	radius: number;
	startAngle: number;
	sectorAngle: number;
	centerLon: number;
	centerLat: number;
}

interface ArrowState extends BaseState {
	arrowType: PlotArrowType;
	// 整体大小(宽度)倍率,对全部 arrowType 生效。
	sizeScale: number;
	// 曲线箭头(curved)体型,相对曲线总弧长;仅 curved 类型生效。
	curvedBodyWidthFactor: number;
	curvedHeadWidthFactor: number;
	curvedHeadLengthFactor: number;
	translateEastMeters: number;
	translateNorthMeters: number;
	_appliedEastMeters: number;
	_appliedNorthMeters: number;
}

interface TextState extends BaseState {
	content: string;
	fontColor: string;
	fontSize: number;
	scale: number;
	textAlign: PlotTextAlign;
	verticalAlign: PlotTextVerticalAlign;
	anchorX: PlotTextAnchorX;
	anchorY: PlotTextAnchorY;
	boxWidth: number;
	boxHeight: number;
	paddingSingle: number;
	layoutDirection: PlotTextLayoutDirection;
	rotation: number;
	offsetX: number;
	offsetY: number;
	showBorder: boolean;
	centerLon: number;
	centerLat: number;
}

interface PlotHandle {
	key: string;
	label: string;
	id: string;
	initialPoints: LonLatPoint[];
}

function normalizeTextContent( content: string ): string {
	return content.replace( /\r\n?/g, '\n' ).replace( /\\n/g, '\n' );
}

function pointStateToOptions(
	state: PointState,
): PlotPointOptions & { type: 'point' } {
	return {
		type: 'point',
		points: [ [ state.centerLon, state.centerLat ] ],
		pointStyle: state.pointStyle,
		size: state.size,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function lineStateToOptions(
	state: LineState,
	points: LonLatPoint[],
): PlotLineOptions & { type: 'line' } {
	return {
		type: 'line',
		points,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		// Lines ignore fill, but the shared base options still require a value.
		fillColor: '#000000',
		fillOpacity: 0,
		visible: state.visible,
		strokeStyle: state.strokeStyle,
		showArrow: state.showArrow,
		startArrowStyle: state.startArrowStyle === 'none' ? null : state.startArrowStyle,
		endArrowStyle: state.endArrowStyle === 'none' ? null : state.endArrowStyle,
	};
}

function polygonStateToOptions(
	state: PolygonState,
	points: LonLatPoint[],
): PlotPolygonOptions & { type: 'polygon' } {
	return {
		type: 'polygon',
		points,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function rectangleStateToOptions(
	state: RectangleState,
	points: LonLatPoint[],
): PlotRectangleOptions & { type: 'rectangle' } {
	return {
		type: 'rectangle',
		points,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function circleStateToOptions(
	state: CircleState,
): PlotCircleOptions & { type: 'circle' } {
	return {
		type: 'circle',
		points: [ [ state.centerLon, state.centerLat ] ],
		radius: state.radius,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function sectorStateToOptions(
	state: SectorState,
): PlotSectorOptions & { type: 'sector' } {
	return {
		type: 'sector',
		points: [ [ state.centerLon, state.centerLat ] ],
		radius: state.radius,
		startAngle: state.startAngle,
		sectorAngle: state.sectorAngle,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function arrowStateToOptions(
	state: ArrowState,
	points: LonLatPoint[],
): PlotArrowOptions & { type: 'arrow' } {
	return {
		type: 'arrow',
		points,
		arrowType: state.arrowType,
		sizeScale: state.sizeScale,
		curvedBodyWidthFactor: state.curvedBodyWidthFactor,
		curvedHeadWidthFactor: state.curvedHeadWidthFactor,
		curvedHeadLengthFactor: state.curvedHeadLengthFactor,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function textStateToOptions(
	state: TextState,
): PlotTextOptions & { type: 'text' } {
	return {
		type: 'text',
		points: [ [ state.centerLon, state.centerLat ] ],
		content: normalizeTextContent( state.content ),
		fontColor: state.fontColor,
		fontSize: state.fontSize,
		scale: state.scale,
		textAlign: state.textAlign,
		verticalAlign: state.verticalAlign,
		anchorX: state.anchorX,
		anchorY: state.anchorY,
		boxWidth: state.boxWidth > 0 ? state.boxWidth : undefined,
		boxHeight: state.boxHeight > 0 ? state.boxHeight : undefined,
		padding: state.paddingSingle,
		layoutDirection: state.layoutDirection,
		rotation: state.rotation,
		offsetX: state.offsetX,
		offsetY: state.offsetY,
		showBorder: state.showBorder,
		strokeColor: state.strokeColor,
		strokeWidth: state.strokeWidth,
		strokeOpacity: state.strokeOpacity,
		fillColor: state.fillColor,
		fillOpacity: state.fillOpacity,
		visible: state.visible,
	};
}

function installTextContentControl(
	folder: GUI,
	state: TextState,
	handle: PlotHandle,
	decals: GroundDecalManager,
): void {
	const controller = folder.add( state, 'content' ).name( 'content (setText)' );
	const input = controller.domElement.querySelector( 'input' );
	if ( ! input ) {
		controller.onChange( ( v: string ) => {
			state.content = normalizeTextContent( v );
			decals.setText( handle.id, state.content );
		} );
		return;
	}

	const textarea = document.createElement( 'textarea' );
	textarea.value = normalizeTextContent( state.content );
	textarea.rows = 3;
	textarea.spellcheck = false;
	textarea.style.width = '100%';
	textarea.style.minHeight = '64px';
	textarea.style.boxSizing = 'border-box';
	textarea.style.resize = 'vertical';
	textarea.style.font = 'inherit';
	textarea.style.lineHeight = '1.35';
	textarea.style.padding = '6px 8px';
	textarea.style.color = 'inherit';
	textarea.style.background = 'rgba(0, 0, 0, 0.24)';
	textarea.style.border = '1px solid rgba(255, 255, 255, 0.18)';
	textarea.style.borderRadius = '4px';

	textarea.addEventListener( 'keydown', ( event ) => {
		event.stopPropagation();
	} );
	textarea.addEventListener( 'keyup', ( event ) => {
		event.stopPropagation();
	} );

	textarea.addEventListener( 'input', () => {
		state.content = normalizeTextContent( textarea.value );
		decals.setText( handle.id, state.content );
	} );

	input.replaceWith( textarea );
}

// runPlotDemo

export function runPlotDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

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
		0.1,
		40000000.0,
	);
	camera.up.set( 0.0, 0.0, 1.0 );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );

	const target = wgs84PositionFromDegrees( PLOT_CENTER_LON, PLOT_CENTER_LAT, 0.0 );
	const up = wgs84NormalFromDegrees( PLOT_CENTER_LON, PLOT_CENTER_LAT );
	const eastBias = new Vector3( - up.y, up.x, 0.0 ).normalize();
	const northBias = new Vector3().crossVectors( up, eastBias ).normalize();
	camera.position.copy( target ).addScaledVector( up, 720000.0 );
	camera.lookAt( target );
	camera.updateMatrixWorld();

	// 无地形模式开关：URL 加 ?noterrain（或 ?noTerrain）即可，无需 token；
	// 也可在 .env 设 VITE_DISABLE_TERRAIN=true。用于验证 EllipsoidDepthSource
	// 椭球面兜底——无地形时贴地标绘应精确贴到 WGS84 椭球面而不是整体消失。
	const urlParams = new URLSearchParams( window.location.search );
	const disableTerrain =
		urlParams.has( 'noterrain' ) ||
		urlParams.has( 'noTerrain' ) ||
		readStringEnv( 'VITE_DISABLE_TERRAIN' ).toLowerCase() === 'true';

	const tilesRenderer = createCesiumTilesRenderer( renderer, disableTerrain );
	let tileLoadError = '';
	tilesRenderer.addEventListener( 'load-model', ( event ) => {
		configureLoadedTileScene( ( event as unknown as { scene: object } ).scene as never );
	} );
	tilesRenderer.addEventListener( 'load-error', ( event ) => {
		const err = ( event as unknown as { error?: { message?: string } } ).error;
		tileLoadError = err?.message ?? 'unknown';
	} );
	tilesRenderer.setCamera( camera );
	tilesRenderer.setResolutionFromRenderer( camera, renderer );
	scene.add( tilesRenderer.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( tilesRenderer.ellipsoid, tilesRenderer.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 0.1;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	const globeDepth = new CesiumGlobeDepth(
		renderer.domElement.width,
		renderer.domElement.height,
	);

	// 椭球面兜底深度：让贴地标绘与瓦片加载解耦。无此兜底时，相机下方一旦没有
	// 加载到瓦片（无 Ion Token / 瓦片下载中 / 放大超过最深层级），主深度缓冲与
	// packed 深度纹理在该区域都为空，stencil Z-fail 记不到值、CULL_FRAGMENTS
	// 又读到空深度，所有贴地标绘整体消失。加入 WGS84 椭球面兜底后，标绘在无地形
	// 时精确贴到椭球面（海平面）。参见 src/lib/ground/ellipsoid-depth-source.ts。
	const ellipsoidDepth = new EllipsoidDepthSource();
	ellipsoidDepth.attach( { mainScene: scene, globeDepth } );

	const decals = new GroundDecalManager( { scene } );

	// Keep every state/handle available for global GUI actions.
	const allStates: { state: { visible: boolean }; handle: PlotHandle }[] = [];


	// point/circle
	const smallPointCircleState: PointState = {
		visible: true,
		pointStyle: 'circle',
		size: 6,
		centerLon: lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 25, - 35 )[ 0 ],
		centerLat: lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 25, - 35 )[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 0.4,
		strokeOpacity: 95,
		fillColor: '#ffaa00',
		fillOpacity: 90,
	};
	const smallPointCircleHandle: PlotHandle = {
		key: 'small-point-circle',
		label: '[small] point/circle  size=6m',
		id: decals.addPlot( pointStateToOptions( smallPointCircleState ) ),
		initialPoints: [ [ smallPointCircleState.centerLon, smallPointCircleState.centerLat ] ],
	};
	allStates.push( { state: smallPointCircleState, handle: smallPointCircleHandle } );

	// point/square
	const smallPointSquareState: PointState = {
		visible: true,
		pointStyle: 'square',
		size: 6,
		centerLon: lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, - 25, - 35 )[ 0 ],
		centerLat: lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, - 25, - 35 )[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 0.4,
		strokeOpacity: 95,
		fillColor: '#aa66ff',
		fillOpacity: 90,
	};
	const smallPointSquareHandle: PlotHandle = {
		key: 'small-point-square',
		label: '[small] point/square  size=6m',
		id: decals.addPlot( pointStateToOptions( smallPointSquareState ) ),
		initialPoints: [ [ smallPointSquareState.centerLon, smallPointSquareState.centerLat ] ],
	};
	allStates.push( { state: smallPointSquareState, handle: smallPointSquareHandle } );

	// circle
	const smallCircleAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, - 65, - 10 );
	const smallCircleState: CircleState = {
		visible: true,
		radius: 5,
		centerLon: smallCircleAnchor[ 0 ],
		centerLat: smallCircleAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 0.4,
		strokeOpacity: 95,
		fillColor: '#00ff88',
		fillOpacity: 70,
	};
	const smallCircleHandle: PlotHandle = {
		key: 'small-circle',
		label: '[small] circle  r=5m',
		id: decals.addPlot( circleStateToOptions( smallCircleState ) ),
		initialPoints: [ [ smallCircleState.centerLon, smallCircleState.centerLat ] ],
	};
	allStates.push( { state: smallCircleState, handle: smallCircleHandle } );

	// sector
	const smallSectorAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 65, - 10 );
	const smallSectorState: SectorState = {
		visible: true,
		radius: 8,
		startAngle: 30,
		sectorAngle: 120,
		centerLon: smallSectorAnchor[ 0 ],
		centerLat: smallSectorAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 0.4,
		strokeOpacity: 95,
		fillColor: '#ff5577',
		fillOpacity: 70,
	};
	const smallSectorHandle: PlotHandle = {
		key: 'small-sector',
		label: '[small] sector  r=8m  start=30掳 sweep=120掳',
		id: decals.addPlot( sectorStateToOptions( smallSectorState ) ),
		initialPoints: [ [ smallSectorState.centerLon, smallSectorState.centerLat ] ],
	};
	allStates.push( { state: smallSectorState, handle: smallSectorHandle } );

	// rectangle 10m x 10m
	const smallRectanglePoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 5, northMeters: - 5 },
			{ eastMeters: 5, northMeters: - 5 },
			{ eastMeters: 5, northMeters: 5 },
			{ eastMeters: - 5, northMeters: 5 },
		],
	);
	const smallRectangleState: RectangleState = {
		visible: true,
		strokeColor: '#ffffff',
		strokeWidth: 0.5,
		strokeOpacity: 95,
		fillColor: '#ff3333',
		fillOpacity: 70,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const smallRectangleHandle: PlotHandle = {
		key: 'small-rectangle',
		label: '[small] rectangle  10m x 10m',
		id: decals.addPlot( rectangleStateToOptions( smallRectangleState, smallRectanglePoints ) ),
		initialPoints: smallRectanglePoints,
	};
	allStates.push( { state: smallRectangleState, handle: smallRectangleHandle } );
	// Small polygon.
	const smallPolygonPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		regularPolygonOffsets( 40, 30, 8, 5, 18 ),
	);
	const smallPolygonState: PolygonState = {
		visible: true,
		strokeColor: '#ffffff',
		strokeWidth: 0.5,
		strokeOpacity: 95,
		fillColor: '#00aaff',
		fillOpacity: 70,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const smallPolygonHandle: PlotHandle = {
		key: 'small-polygon',
		label: '[small] polygon  5-gon r=8m',
		id: decals.addPlot( polygonStateToOptions( smallPolygonState, smallPolygonPoints ) ),
		initialPoints: smallPolygonPoints,
	};
	allStates.push( { state: smallPolygonState, handle: smallPolygonHandle } );
	// Small zig-zag line.
	const smallLinePoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 95, northMeters: 50 },
			{ eastMeters: - 30, northMeters: 65 },
			{ eastMeters: 30, northMeters: 45 },
			{ eastMeters: 95, northMeters: 60 },
		],
	);
	const smallLineState: LineState = {
		visible: true,
		strokeStyle: 'dashed',
		showArrow: true,
		startArrowStyle: 'none',
		endArrowStyle: 'filledArrow',
		strokeColor: '#ffd633',
		strokeWidth: 2,
		strokeOpacity: 95,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const smallLineHandle: PlotHandle = {
		key: 'small-line',
		label: '[small] line  dashed + endArrow',
		id: decals.addPlot( lineStateToOptions( smallLineState, smallLinePoints ) ),
		initialPoints: smallLinePoints,
	};
	allStates.push( { state: smallLineState, handle: smallLineHandle } );
	// Small attack arrow.
	const smallArrowPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 95, northMeters: 92 },   // tail left
			{ eastMeters: - 95, northMeters: 102 },  // tail right (10m tail width)
			{ eastMeters: - 20, northMeters: 108 },  // spine kink
			{ eastMeters: 70, northMeters: 96 },     // tip
		],
	);
	const smallArrowState: ArrowState = {
		visible: true,
		arrowType: 'attack',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		strokeColor: '#ffffff',
		strokeWidth: 0.6,
		strokeOpacity: 95,
		fillColor: '#33ddff',
		fillOpacity: 85,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const smallArrowHandle: PlotHandle = {
		key: 'small-arrow',
		label: '[small] arrow  attack',
		id: decals.addPlot( arrowStateToOptions( smallArrowState, smallArrowPoints ) ),
		initialPoints: smallArrowPoints,
	};
	allStates.push( { state: smallArrowState, handle: smallArrowHandle } );
	// Small swallowtail attack arrow —— 与上方 attack 用同样的尾边契约控制点,
	// 单独成一个 1:1 图元,放在 attack 正下方 ~70m,便于和 attack 直接对比
	// (尾部多一个燕尾 V 凹口,其余体 / 头与 attack 完全一致)。
	const smallSwallowPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 95, northMeters: 22 },   // tail left
			{ eastMeters: - 95, northMeters: 32 },   // tail right (10m tail width)
			{ eastMeters: - 20, northMeters: 38 },   // spine kink
			{ eastMeters: 70, northMeters: 26 },     // tip
		],
	);
	const smallSwallowState: ArrowState = {
		visible: true,
		arrowType: 'swallowtailAttack',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		strokeColor: '#ffffff',
		strokeWidth: 0.6,
		strokeOpacity: 95,
		fillColor: '#ff9933',
		fillOpacity: 85,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const smallSwallowHandle: PlotHandle = {
		key: 'small-swallow-arrow',
		label: '[small] arrow  swallowtailAttack',
		id: decals.addPlot( arrowStateToOptions( smallSwallowState, smallSwallowPoints ) ),
		initialPoints: smallSwallowPoints,
	};
	allStates.push( { state: smallSwallowState, handle: smallSwallowHandle } );
	// Small hook curved arrow(钩形回环手绘轨迹,复刻"曲线箭头无头" bug 场景):
	// 48 个密集控制点,先向东直行 → 东侧大半圆向南掉头 → 向西回扫 → 末端向内
	// 卷曲 ~160°,尖端朝东指向回环中心。总转角 > 340°,曾经触发头部三角被环级
	// 降采样抽掉;修复后箭头头部应始终可见且多边形不自交。放在中心东北侧。
	const hookArrowOffsets: { eastMeters: number; northMeters: number }[] = [];
	const HOOK_POINT_COUNT = 48;
	const HOOK_SCALE_METERS = 14.0;
	for ( let i = 0; i < HOOK_POINT_COUNT; i++ ) {
		const t = i / ( HOOK_POINT_COUNT - 1 );
		let xMeters: number;
		let yMeters: number;
		if ( t < 0.40 ) {
			// 第一段(40% 弧长):向东直行。
			const u = t / 0.40;
			xMeters = ( -2.0 + u * 2.0 ) * HOOK_SCALE_METERS;
			yMeters = 0.8 * HOOK_SCALE_METERS;
		} else if ( t < 0.75 ) {
			// 第二段(35%):东侧大弯,从向东顺时针转 180° 到向西。
			const u = ( t - 0.40 ) / 0.35;
			const a = Math.PI / 2 - u * Math.PI;
			xMeters = 0.8 * HOOK_SCALE_METERS * Math.cos( a ) * 1.4;
			yMeters = 0.8 * HOOK_SCALE_METERS * Math.sin( a );
		} else {
			// 第三段(25%):末端向内卷曲(继续顺时针 ~160°)。
			const u = ( t - 0.75 ) / 0.25;
			const a = -Math.PI / 2 - u * ( 160.0 * Math.PI / 180.0 );
			xMeters = ( -0.4 + 0.45 * Math.cos( a ) ) * HOOK_SCALE_METERS;
			yMeters = ( -0.45 + 0.45 * Math.sin( a ) ) * HOOK_SCALE_METERS;
		}
		hookArrowOffsets.push( {
			eastMeters: 95 + xMeters,
			northMeters: 165 + yMeters,
		} );
	}
	const hookArrowPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		hookArrowOffsets,
	);
	const hookArrowState: ArrowState = {
		visible: true,
		arrowType: 'curved',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		strokeColor: '#1a50a9',
		strokeWidth: 0.6,
		strokeOpacity: 95,
		fillColor: '#3a86ff',
		fillOpacity: 85,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const hookArrowHandle: PlotHandle = {
		key: 'small-hook-arrow',
		label: '[small] arrow  curved hook (freehand 48 pts)',
		id: decals.addPlot( arrowStateToOptions( hookArrowState, hookArrowPoints ) ),
		initialPoints: hookArrowPoints,
	};
	allStates.push( { state: hookArrowState, handle: hookArrowHandle } );
	// Small U-shaped curved arrow(宽 U,开口朝左,尖端在左下,复刻用户手绘):
	// 上臂向右 → 右侧半圆向下(180°)→ 下臂向左,尖端朝左。44 个密集控制点。
	const uArrowOffsets: { eastMeters: number; northMeters: number }[] = [];
	const U_POINT_COUNT = 44;
	const U_SCALE_METERS = 13.0;
	for ( let i = 0; i < U_POINT_COUNT; i++ ) {
		const t = i / ( U_POINT_COUNT - 1 );
		let xMeters: number;
		let yMeters: number;
		if ( t < 0.40 ) {
			// 上臂:从左到右。
			const u = t / 0.40;
			xMeters = ( -1.8 + u * 3.6 ) * U_SCALE_METERS;
			yMeters = 0.9 * U_SCALE_METERS;
		} else if ( t < 0.70 ) {
			// 右侧半圆:上 → 下(顺时针 180°)。
			const u = ( t - 0.40 ) / 0.30;
			const a = Math.PI / 2 - u * Math.PI;
			xMeters = ( 1.8 + 0.9 * Math.cos( a ) ) * U_SCALE_METERS;
			yMeters = ( 0.9 * Math.sin( a ) ) * U_SCALE_METERS;
		} else {
			// 下臂:从右回到左(尖端在左下)。
			const u = ( t - 0.70 ) / 0.30;
			xMeters = ( 1.8 - u * 3.6 ) * U_SCALE_METERS;
			yMeters = -0.9 * U_SCALE_METERS;
		}
		// 放在中心正北 ~250 m 处,与钩形(中心东北)分开,避免重叠。
		uArrowOffsets.push( {
			eastMeters: -10 + xMeters,
			northMeters: 250 + yMeters,
		} );
	}
	const uArrowPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		uArrowOffsets,
	);
	const uArrowState: ArrowState = {
		visible: true,
		arrowType: 'curved',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		strokeColor: '#1a50a9',
		strokeWidth: 0.6,
		strokeOpacity: 95,
		fillColor: '#2b6cff',
		fillOpacity: 85,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const uArrowHandle: PlotHandle = {
		key: 'small-u-arrow',
		label: '[small] arrow  curved U-shape (44 pts)',
		id: decals.addPlot( arrowStateToOptions( uArrowState, uArrowPoints ) ),
		initialPoints: uArrowPoints,
	};
	allStates.push( { state: uArrowState, handle: uArrowHandle } );

	// text
	const smallTextAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 0, - 80 );
	const smallTextState: TextState = {
		visible: true,
		content: 'Plot 1:1',
		fontColor: '#ffffff',
		fontSize: 20,
		scale: 0.5,
		textAlign: 'center',
		verticalAlign: 'middle',
		anchorX: 'center',
		anchorY: 'middle',
		boxWidth: 0,
		boxHeight: 0,
		paddingSingle: 6,
		layoutDirection: 'horizontal',
		rotation: 0,
		offsetX: 0,
		offsetY: 0,
		showBorder: true,
		centerLon: smallTextAnchor[ 0 ],
		centerLat: smallTextAnchor[ 1 ],
		strokeColor: '#000000',
		strokeWidth: 2,
		strokeOpacity: 100,
		fillColor: '#3344aa',
		fillOpacity: 85,
	};
	const smallTextHandle: PlotHandle = {
		key: 'small-text',
		label: '[small] text  "Plot 1:1"',
		id: decals.addPlot( textStateToOptions( smallTextState ) ),
		initialPoints: [ [ smallTextState.centerLon, smallTextState.centerLat ] ],
	};
	allStates.push( { state: smallTextState, handle: smallTextHandle } );


	// large point/circle
	const largePointCircleAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, - 4000, - 3500 );
	const largePointCircleState: PointState = {
		visible: true,
		pointStyle: 'circle',
		size: 2000,
		centerLon: largePointCircleAnchor[ 0 ],
		centerLat: largePointCircleAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 60,
		strokeOpacity: 95,
		fillColor: '#ffaa00',
		fillOpacity: 60,
	};
	const largePointCircleHandle: PlotHandle = {
		key: 'large-point-circle',
		label: '[large] point/circle  size=2km',
		id: decals.addPlot( pointStateToOptions( largePointCircleState ) ),
		initialPoints: [ [ largePointCircleState.centerLon, largePointCircleState.centerLat ] ],
	};
	allStates.push( { state: largePointCircleState, handle: largePointCircleHandle } );

	// large point/square
	const largePointSquareAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 4000, - 3500 );
	const largePointSquareState: PointState = {
		visible: true,
		pointStyle: 'square',
		size: 2000,
		centerLon: largePointSquareAnchor[ 0 ],
		centerLat: largePointSquareAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 60,
		strokeOpacity: 95,
		fillColor: '#aa66ff',
		fillOpacity: 60,
	};
	const largePointSquareHandle: PlotHandle = {
		key: 'large-point-square',
		label: '[large] point/square  size=2km',
		id: decals.addPlot( pointStateToOptions( largePointSquareState ) ),
		initialPoints: [ [ largePointSquareState.centerLon, largePointSquareState.centerLat ] ],
	};
	allStates.push( { state: largePointSquareState, handle: largePointSquareHandle } );

	// large circle
	const largeCircleAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 7500, 5500 );
	const largeCircleState: CircleState = {
		visible: true,
		radius: 3000,
		centerLon: largeCircleAnchor[ 0 ],
		centerLat: largeCircleAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 80,
		strokeOpacity: 90,
		fillColor: '#66ff66',
		fillOpacity: 45,
	};
	const largeCircleHandle: PlotHandle = {
		key: 'large-circle',
		label: '[large] circle  r=3km',
		id: decals.addPlot( circleStateToOptions( largeCircleState ) ),
		initialPoints: [ [ largeCircleState.centerLon, largeCircleState.centerLat ] ],
	};
	allStates.push( { state: largeCircleState, handle: largeCircleHandle } );

	// large sector
	const largeSectorAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, - 7500, 5500 );
	const largeSectorState: SectorState = {
		visible: true,
		radius: 3000,
		startAngle: 20,
		sectorAngle: 200,
		centerLon: largeSectorAnchor[ 0 ],
		centerLat: largeSectorAnchor[ 1 ],
		strokeColor: '#ffffff',
		strokeWidth: 80,
		strokeOpacity: 90,
		fillColor: '#ff8855',
		fillOpacity: 45,
	};
	const largeSectorHandle: PlotHandle = {
		key: 'large-sector',
		label: '[large] sector  r=3km start=20掳 sweep=200掳',
		id: decals.addPlot( sectorStateToOptions( largeSectorState ) ),
		initialPoints: [ [ largeSectorState.centerLon, largeSectorState.centerLat ] ],
	};
	allStates.push( { state: largeSectorState, handle: largeSectorHandle } );

	// large rectangle 6km x 4km
	const largeRectanglePoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 11000 - 3000, northMeters: 13000 - 2000 },
			{ eastMeters: - 11000 + 3000, northMeters: 13000 - 2000 },
			{ eastMeters: - 11000 + 3000, northMeters: 13000 + 2000 },
			{ eastMeters: - 11000 - 3000, northMeters: 13000 + 2000 },
		],
	);
	const largeRectangleState: RectangleState = {
		visible: true,
		strokeColor: '#ffffff',
		strokeWidth: 120,
		strokeOpacity: 90,
		fillColor: '#ffcc00',
		fillOpacity: 42,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const largeRectangleHandle: PlotHandle = {
		key: 'large-rectangle',
		label: '[large] rectangle  6km x 4km',
		id: decals.addPlot( rectangleStateToOptions( largeRectangleState, largeRectanglePoints ) ),
		initialPoints: largeRectanglePoints,
	};
	allStates.push( { state: largeRectangleState, handle: largeRectangleHandle } );

	// large polygon
	const largePolygonPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		regularPolygonOffsets( 11000, 13000, 3200, 6, 14 ),
	);
	const largePolygonState: PolygonState = {
		visible: true,
		strokeColor: '#ffffff',
		strokeWidth: 120,
		strokeOpacity: 90,
		fillColor: '#00ddff',
		fillOpacity: 42,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const largePolygonHandle: PlotHandle = {
		key: 'large-polygon',
		label: '[large] polygon  6-gon r=3.2km',
		id: decals.addPlot( polygonStateToOptions( largePolygonState, largePolygonPoints ) ),
		initialPoints: largePolygonPoints,
	};
	allStates.push( { state: largePolygonState, handle: largePolygonHandle } );
	// Large zig-zag line.
	const largeLinePoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 17000, northMeters: 2000 },
			{ eastMeters: - 8000, northMeters: 3500 },
			{ eastMeters: 0, northMeters: 2200 },
			{ eastMeters: 8000, northMeters: 3500 },
			{ eastMeters: 17000, northMeters: 2000 },
		],
	);
	const largeLineState: LineState = {
		visible: true,
		strokeStyle: 'solid',
		showArrow: true,
		startArrowStyle: 'unfilledArrow',
		endArrowStyle: 'filledArrow',
		strokeColor: '#ffffff',
		strokeWidth: 120,
		strokeOpacity: 95,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const largeLineHandle: PlotHandle = {
		key: 'large-line',
		label: '[large] line  solid + unfilled/filled arrow',
		id: decals.addPlot( lineStateToOptions( largeLineState, largeLinePoints ) ),
		initialPoints: largeLinePoints,
	};
	allStates.push( { state: largeLineState, handle: largeLineHandle } );
	// Large swallowtail attack arrow.
	const largeArrowPoints: LonLatPoint[] = lonLatPointsFromMeters(
		PLOT_CENTER_LON,
		PLOT_CENTER_LAT,
		[
			{ eastMeters: - 16000, northMeters: 18500 },  // tail left
			{ eastMeters: - 16000, northMeters: 20000 },  // tail right (1.5km tail width)
			{ eastMeters: 0, northMeters: 22500 },        // spine kink
			{ eastMeters: 16000, northMeters: 19000 },    // tip
		],
	);
	const largeArrowState: ArrowState = {
		visible: true,
		arrowType: 'swallowtailAttack',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		strokeColor: '#ffffff',
		strokeWidth: 80,
		strokeOpacity: 95,
		fillColor: '#ff66cc',
		fillOpacity: 75,
		translateEastMeters: 0,
		translateNorthMeters: 0,
		_appliedEastMeters: 0,
		_appliedNorthMeters: 0,
	};
	const largeArrowHandle: PlotHandle = {
		key: 'large-arrow',
		label: '[large] arrow  swallowtailAttack',
		id: decals.addPlot( arrowStateToOptions( largeArrowState, largeArrowPoints ) ),
		initialPoints: largeArrowPoints,
	};
	allStates.push( { state: largeArrowState, handle: largeArrowHandle } );

	// large text
	const largeTextAnchor = lonLatFromMeters( PLOT_CENTER_LON, PLOT_CENTER_LAT, 0, 16500 );
	const largeTextState: TextState = {
		visible: true,
		content: 'Plot @ km scale',
		fontColor: '#ffffff',
		fontSize: 24,
		scale: 32,
		textAlign: 'center',
		verticalAlign: 'middle',
		anchorX: 'center',
		anchorY: 'middle',
		boxWidth: 0,
		boxHeight: 0,
		paddingSingle: 8,
		layoutDirection: 'horizontal',
		rotation: 0,
		offsetX: 0,
		offsetY: 0,
		showBorder: true,
		centerLon: largeTextAnchor[ 0 ],
		centerLat: largeTextAnchor[ 1 ],
		strokeColor: '#000000',
		strokeWidth: 3,
		strokeOpacity: 100,
		fillColor: '#332277',
		fillOpacity: 80,
	};
	const largeTextHandle: PlotHandle = {
		key: 'large-text',
		label: '[large] text  "Plot @ km scale"',
		id: decals.addPlot( textStateToOptions( largeTextState ) ),
		initialPoints: [ [ largeTextState.centerLon, largeTextState.centerLat ] ],
	};
	allStates.push( { state: largeTextState, handle: largeTextHandle } );

	// 鐩告満棰勮

	function flyToSmall(): void {
		camera.position
			.copy( target )
			.addScaledVector( up, 220.0 )
			.addScaledVector( eastBias, 30.0 );
		camera.lookAt( target );
		camera.updateMatrixWorld();
	}
	function flyToLarge(): void {
		camera.position
			.copy( target )
			.addScaledVector( up, 45000.0 )
			.addScaledVector( northBias, 8000.0 );
		camera.lookAt( target );
		camera.updateMatrixWorld();
	}
	function flyToOverview(): void {
		camera.position.copy( target ).addScaledVector( up, 720000.0 );
		camera.lookAt( target );
		camera.updateMatrixWorld();
	}

	// GUI construction.
	const gui = new GUI( { title: 'Plot Demo - all fields', width: 360 } );
	gui.domElement.style.right = '16px';
	gui.domElement.style.top = '16px';

	const camFolder = gui.addFolder( 'Camera' );
	camFolder.add( { f: flyToSmall }, 'f' ).name( 'fly to small (~220m)' );
	camFolder.add( { f: flyToLarge }, 'f' ).name( 'fly to large (~45km)' );
	camFolder.add( { f: flyToOverview }, 'f' ).name( 'overview (~720km)' );

	// ── 地形开关（无地形渲染验证）─────────────────────────────────────────────
	// 取消勾选即整体隐藏地形瓦片，模拟"无地形"。此时贴地标绘改由
	// EllipsoidDepthSource 椭球面兜底支撑：标绘应依然完整显示（精确贴到 WGS84
	// 椭球面 / 海平面），而不是整体消失——这正是"无地形也能正常渲染"的直观验证。
	// 勾选则恢复地形，标绘重新贴到真实地形表面。
	const terrainState = {
		terrainOn: ! disableTerrain,
	};
	// 让初始可见性与开关一致（startup ?noterrain 时本就为空，置 false 仅为统一显示）。
	tilesRenderer.group.visible = terrainState.terrainOn;
	const terrainFolder = gui.addFolder( 'Terrain (no-terrain test)' );
	terrainFolder.add( terrainState, 'terrainOn' )
		.name( 'terrain on (off → ellipsoid only)' )
		.onChange( ( on: boolean ) => {
			tilesRenderer.group.visible = on;
		} );

	const globalState = {
		globalOpacity: 1.0,
		hideAll: false,
		clearAll: (): void => {
			decals.clear();
		},
		readdAll: (): void => {
			decals.clear();
			// Recreate plots so IDs are refreshed while current state values are preserved.
			const refresh = (
				s: { visible: boolean },
				h: PlotHandle,
				opts: PlotAddOptions,
			): void => {
				h.id = decals.addPlot( opts );
				void s;
			};
			refresh( smallPointCircleState, smallPointCircleHandle, pointStateToOptions( smallPointCircleState ) );
			refresh( smallPointSquareState, smallPointSquareHandle, pointStateToOptions( smallPointSquareState ) );
			refresh( smallCircleState, smallCircleHandle, circleStateToOptions( smallCircleState ) );
			refresh( smallSectorState, smallSectorHandle, sectorStateToOptions( smallSectorState ) );
			refresh( smallRectangleState, smallRectangleHandle, rectangleStateToOptions( smallRectangleState, smallRectangleHandle.initialPoints ) );
			refresh( smallPolygonState, smallPolygonHandle, polygonStateToOptions( smallPolygonState, smallPolygonHandle.initialPoints ) );
			refresh( smallLineState, smallLineHandle, lineStateToOptions( smallLineState, smallLineHandle.initialPoints ) );
			refresh( smallArrowState, smallArrowHandle, arrowStateToOptions( smallArrowState, smallArrowHandle.initialPoints ) );
			refresh( smallTextState, smallTextHandle, textStateToOptions( smallTextState ) );
			refresh( largePointCircleState, largePointCircleHandle, pointStateToOptions( largePointCircleState ) );
			refresh( largePointSquareState, largePointSquareHandle, pointStateToOptions( largePointSquareState ) );
			refresh( largeCircleState, largeCircleHandle, circleStateToOptions( largeCircleState ) );
			refresh( largeSectorState, largeSectorHandle, sectorStateToOptions( largeSectorState ) );
			refresh( largeRectangleState, largeRectangleHandle, rectangleStateToOptions( largeRectangleState, largeRectangleHandle.initialPoints ) );
			refresh( largePolygonState, largePolygonHandle, polygonStateToOptions( largePolygonState, largePolygonHandle.initialPoints ) );
			refresh( largeLineState, largeLineHandle, lineStateToOptions( largeLineState, largeLineHandle.initialPoints ) );
			refresh( largeArrowState, largeArrowHandle, arrowStateToOptions( largeArrowState, largeArrowHandle.initialPoints ) );
			refresh( largeTextState, largeTextHandle, textStateToOptions( largeTextState ) );
		},
	};
	const globalFolder = gui.addFolder( 'Global' );
	globalFolder.add( globalState, 'globalOpacity', 0.0, 1.0, 0.01 )
		.name( 'global opacity' )
		.onChange( ( v: number ) => {
			decals.setGlobalOpacity( v );
		} );
	globalFolder.add( globalState, 'hideAll' )
		.name( 'hide all' )
		.onChange( ( hide: boolean ) => {
			for ( const { handle } of allStates ) {
				decals.setStyle( handle.id, { visible: ! hide } );
			}
		} );
	globalFolder.add( globalState, 'clearAll' ).name( 'clear()' );
	globalFolder.add( globalState, 'readdAll' ).name( 're-add all (addPlot)' );
	function bindBaseStyleControls<S extends BaseState>(
		folder: GUI,
		state: S,
		handle: PlotHandle,
		toOpts: ( s: S ) => PlotAddOptions,
		strokeWidthMin: number,
		strokeWidthMax: number,
		strokeWidthStep: number,
	): void {
		folder.add( state, 'visible' )
			.name( 'visible' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
		folder.addColor( state, 'strokeColor' )
			.name( 'strokeColor' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
		folder.add( state, 'strokeWidth', strokeWidthMin, strokeWidthMax, strokeWidthStep )
			.name( 'strokeWidth' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
		folder.add( state, 'strokeOpacity', 0, 100, 1 )
			.name( 'strokeOpacity 0..100' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
		folder.addColor( state, 'fillColor' )
			.name( 'fillColor' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
		folder.add( state, 'fillOpacity', 0, 100, 1 )
			.name( 'fillOpacity 0..100' )
			.onChange( () => { decals.setStyle( handle.id, toOpts( state ) ); } );
	}

	function bindCenterControls<S extends { centerLon: number; centerLat: number }>(
		folder: GUI,
		state: S,
		handle: PlotHandle,
		lonStep: number,
		latStep: number,
	): void {
		folder.add( state, 'centerLon', - 180, 180, lonStep )
			.name( 'center lon' )
			.onChange( () => {
				decals.setCenter( handle.id, { lon: state.centerLon, lat: state.centerLat } );
			} ).listen();
		folder.add( state, 'centerLat', - 90, 90, latStep )
			.name( 'center lat' )
			.onChange( () => {
				decals.setCenter( handle.id, { lon: state.centerLon, lat: state.centerLat } );
			} ).listen();
	}

	function bindTranslateControls<S extends {
		translateEastMeters: number;
		translateNorthMeters: number;
		_appliedEastMeters: number;
		_appliedNorthMeters: number;
	}>(
		folder: GUI,
		state: S,
		handle: PlotHandle,
		rangeMeters: number,
	): void {
		const apply = (): void => {
			// Convert meter offsets into approximate lon/lat deltas for demo dragging.
			const dEast = state.translateEastMeters - state._appliedEastMeters;
			const dNorth = state.translateNorthMeters - state._appliedNorthMeters;
			if ( dEast === 0 && dNorth === 0 ) return;
			// Local lon/lat increment uses latitude cosine for longitude scale.
			const lat0 = PLOT_CENTER_LAT;
			const dLat = dNorth / 111320;
			const dLon = dEast / ( 111320 * Math.cos( lat0 * Math.PI / 180 ) );
			decals.translateCoords( handle.id, dLon, dLat );
			state._appliedEastMeters = state.translateEastMeters;
			state._appliedNorthMeters = state.translateNorthMeters;
		};
		folder.add( state, 'translateEastMeters', - rangeMeters, rangeMeters, rangeMeters / 200 )
			.name( 'translate east (m)' )
			.onChange( apply );
		folder.add( state, 'translateNorthMeters', - rangeMeters, rangeMeters, rangeMeters / 200 )
			.name( 'translate north (m)' )
			.onChange( apply );
		folder.add( {
			reset: (): void => {
				decals.translateCoords(
					handle.id,
					- ( state._appliedEastMeters ) / ( 111320 * Math.cos( PLOT_CENTER_LAT * Math.PI / 180 ) ),
					- ( state._appliedNorthMeters ) / 111320,
				);
				state.translateEastMeters = 0;
				state.translateNorthMeters = 0;
				state._appliedEastMeters = 0;
				state._appliedNorthMeters = 0;
				folder.controllers.forEach( ( c ) => c.updateDisplay() );
			},
		}, 'reset' ).name( 'reset translation' );
	}

	function buildPointFolder(
		parent: GUI,
		title: string,
		state: PointState,
		handle: PlotHandle,
		sizeMin: number,
		sizeMax: number,
		sizeStep: number,
		strokeWidthMax: number,
		lonStep: number,
		latStep: number,
	): void {
		const folder = parent.addFolder( title );
		folder.add( state, 'pointStyle', [ 'circle', 'square' ] )
			.name( 'pointStyle' )
			.onChange( () => { decals.setStyle( handle.id, pointStateToOptions( state ) ); } );
		folder.add( state, 'size', sizeMin, sizeMax, sizeStep )
			.name( 'size (m)' )
			.onChange( () => { decals.setStyle( handle.id, pointStateToOptions( state ) ); } );
		bindCenterControls( folder, state, handle, lonStep, latStep );
		bindBaseStyleControls( folder, state, handle,
			pointStateToOptions, 0, strokeWidthMax, strokeWidthMax / 40 );
	}

	function buildCircleFolder(
		parent: GUI,
		title: string,
		state: CircleState,
		handle: PlotHandle,
		radiusMin: number,
		radiusMax: number,
		radiusStep: number,
		strokeWidthMax: number,
		lonStep: number,
		latStep: number,
	): void {
		const folder = parent.addFolder( title );
		folder.add( state, 'radius', radiusMin, radiusMax, radiusStep )
			.name( 'radius (m)' )
			.onChange( () => { decals.setStyle( handle.id, circleStateToOptions( state ) ); } );
		bindCenterControls( folder, state, handle, lonStep, latStep );
		bindBaseStyleControls( folder, state, handle,
			circleStateToOptions, 0, strokeWidthMax, strokeWidthMax / 40 );
	}

	function buildSectorFolder(
		parent: GUI,
		title: string,
		state: SectorState,
		handle: PlotHandle,
		radiusMin: number,
		radiusMax: number,
		radiusStep: number,
		strokeWidthMax: number,
		lonStep: number,
		latStep: number,
	): void {
		const folder = parent.addFolder( title );
		folder.add( state, 'radius', radiusMin, radiusMax, radiusStep )
			.name( 'radius (m)' )
			.onChange( () => { decals.setStyle( handle.id, sectorStateToOptions( state ) ); } );
		folder.add( state, 'startAngle', - 360, 360, 1 )
			.name( 'startAngle (deg)' )
			.onChange( () => { decals.setStyle( handle.id, sectorStateToOptions( state ) ); } );
		folder.add( state, 'sectorAngle', - 360, 360, 1 )
			.name( 'sectorAngle (deg)' )
			.onChange( () => { decals.setStyle( handle.id, sectorStateToOptions( state ) ); } );
		bindCenterControls( folder, state, handle, lonStep, latStep );
		bindBaseStyleControls( folder, state, handle,
			sectorStateToOptions, 0, strokeWidthMax, strokeWidthMax / 40 );
	}

	function buildRectangleFolder(
		parent: GUI,
		title: string,
		state: RectangleState,
		handle: PlotHandle,
		strokeWidthMax: number,
		translateRange: number,
	): void {
		const folder = parent.addFolder( title );
		bindBaseStyleControls( folder, state, handle,
			( s ) => rectangleStateToOptions( s, handle.initialPoints ),
			0, strokeWidthMax, strokeWidthMax / 40 );
		bindTranslateControls( folder, state, handle, translateRange );
	}

	function buildPolygonFolder(
		parent: GUI,
		title: string,
		state: PolygonState,
		handle: PlotHandle,
		strokeWidthMax: number,
		translateRange: number,
	): void {
		const folder = parent.addFolder( title );
		bindBaseStyleControls( folder, state, handle,
			( s ) => polygonStateToOptions( s, handle.initialPoints ),
			0, strokeWidthMax, strokeWidthMax / 40 );
		bindTranslateControls( folder, state, handle, translateRange );
	}

	const arrowStyleOptions: ( PlotArrowStyle | 'none' )[] = [
		'none', 'filledArrow', 'unfilledArrow',
	];
	function buildLineFolder(
		parent: GUI,
		title: string,
		state: LineState,
		handle: PlotHandle,
		strokeWidthMin: number,
		strokeWidthMax: number,
		strokeWidthStep: number,
		translateRange: number,
	): void {
		const folder = parent.addFolder( title );
		const apply = (): void => {
			decals.setStyle( handle.id, lineStateToOptions( state, handle.initialPoints ) );
		};
		folder.add( state, 'visible' ).name( 'visible' ).onChange( apply );
		folder.add( state, 'strokeStyle', [ 'solid', 'dashed' ] )
			.name( 'strokeStyle' )
			.onChange( apply );
		folder.add( state, 'showArrow' ).name( 'showArrow' ).onChange( apply );
		folder.add( state, 'startArrowStyle', arrowStyleOptions )
			.name( 'startArrowStyle' )
			.onChange( apply );
		folder.add( state, 'endArrowStyle', arrowStyleOptions )
			.name( 'endArrowStyle' )
			.onChange( apply );
		folder.addColor( state, 'strokeColor' ).name( 'strokeColor' ).onChange( apply );
		folder.add( state, 'strokeWidth', strokeWidthMin, strokeWidthMax, strokeWidthStep )
			.name( 'strokeWidth (m, world)' )
			.onChange( apply );
		folder.add( state, 'strokeOpacity', 0, 100, 1 )
			.name( 'strokeOpacity 0..100' )
			.onChange( apply );
		bindTranslateControls( folder, state, handle, translateRange );
	}

	function buildArrowFolder(
		parent: GUI,
		title: string,
		state: ArrowState,
		handle: PlotHandle,
		strokeWidthMax: number,
		translateRange: number,
	): void {
		const folder = parent.addFolder( title );
		folder.add( state, 'arrowType',
			[ 'fine', 'assaultDirection', 'attack', 'swallowtailAttack', 'curved' ],
		)
			.name( 'arrowType' )
			.onChange( () => {
				decals.setStyle( handle.id, arrowStateToOptions( state, handle.initialPoints ) );
			} );
		// 改几何参数需重算 → 走 setStyle(桥接器会重调 generateCoords)。
		const applyCurved = (): void => {
			decals.setStyle( handle.id, arrowStateToOptions( state, handle.initialPoints ) );
		};
		// 整体大小:对**全部 arrowType** 生效的宽度倍率(长度仍由控制点决定)。
		folder.add( state, 'sizeScale', 0.2, 3.0, 0.05 )
			.name( '★ size scale (全类型)' )
			.onChange( applyCurved );
		const curved = folder.addFolder( 'curved width (仅 curved 类型)' );
		curved.add( state, 'curvedBodyWidthFactor', 0.005, 0.20, 0.005 )
			.name( 'bodyWidth /arc' )
			.onChange( applyCurved );
		curved.add( state, 'curvedHeadWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'headWidth /arc' )
			.onChange( applyCurved );
		curved.add( state, 'curvedHeadLengthFactor', 0.02, 0.40, 0.005 )
			.name( 'headLength /arc' )
			.onChange( applyCurved );
		bindBaseStyleControls( folder, state, handle,
			( s ) => arrowStateToOptions( s, handle.initialPoints ),
			0, strokeWidthMax, strokeWidthMax / 40 );
		bindTranslateControls( folder, state, handle, translateRange );
	}

	function buildTextFolder(
		parent: GUI,
		title: string,
		state: TextState,
		handle: PlotHandle,
		fontSizeMin: number,
		fontSizeMax: number,
		scaleMin: number,
		scaleMax: number,
		strokeWidthMax: number,
		lonStep: number,
		latStep: number,
		offsetRange: number,
	): void {
		const folder = parent.addFolder( title );
		installTextContentControl( folder, state, handle, decals );
		folder.addColor( state, 'fontColor' )
			.name( 'fontColor' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'fontSize', fontSizeMin, fontSizeMax, 1 )
			.name( 'fontSize (px)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'scale', scaleMin, scaleMax, ( scaleMax - scaleMin ) / 100 )
			.name( 'scale 鈫?metersPerPixel' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'textAlign', [ 'left', 'center', 'right' ] )
			.name( 'textAlign' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'verticalAlign', [ 'top', 'middle', 'bottom' ] )
			.name( 'verticalAlign' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'anchorX', [ 'left', 'center', 'right' ] )
			.name( 'anchorX' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'anchorY', [ 'top', 'middle', 'bottom' ] )
			.name( 'anchorY' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'boxWidth', 0, 1024, 4 )
			.name( 'boxWidth (px, 0=auto)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'boxHeight', 0, 1024, 4 )
			.name( 'boxHeight (px, 0=auto)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'paddingSingle', 0, 32, 1 )
			.name( 'padding (px)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'layoutDirection', [ 'horizontal', 'vertical-rl', 'vertical-lr' ] )
			.name( 'layoutDirection' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'rotation', - 180, 180, 1 )
			.name( 'rotation (deg)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'offsetX', - offsetRange, offsetRange, offsetRange / 200 )
			.name( 'offsetX (m east)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'offsetY', - offsetRange, offsetRange, offsetRange / 200 )
			.name( 'offsetY (m north)' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		folder.add( state, 'showBorder' )
			.name( 'showBorder' )
			.onChange( () => { decals.setStyle( handle.id, textStateToOptions( state ) ); } );
		bindCenterControls( folder, state, handle, lonStep, latStep );
		bindBaseStyleControls( folder, state, handle,
			textStateToOptions, 0, strokeWidthMax, strokeWidthMax / 40 );
	}

	const smallGroup = gui.addFolder( 'Small (meter scale)' );
	smallGroup.close();
	buildPointFolder( smallGroup, 'point/circle', smallPointCircleState, smallPointCircleHandle, 1, 40, 0.5, 4, 0.000001, 0.000001 );
	buildPointFolder( smallGroup, 'point/square', smallPointSquareState, smallPointSquareHandle, 1, 40, 0.5, 4, 0.000001, 0.000001 );
	buildCircleFolder( smallGroup, 'circle', smallCircleState, smallCircleHandle, 1, 40, 0.5, 4, 0.000001, 0.000001 );
	buildSectorFolder( smallGroup, 'sector', smallSectorState, smallSectorHandle, 1, 40, 0.5, 4, 0.000001, 0.000001 );
	buildRectangleFolder( smallGroup, 'rectangle', smallRectangleState, smallRectangleHandle, 4, 200 );
	buildPolygonFolder( smallGroup, 'polygon', smallPolygonState, smallPolygonHandle, 4, 200 );
	buildLineFolder( smallGroup, 'line', smallLineState, smallLineHandle, 0.2, 10, 0.1, 200 );
	buildArrowFolder( smallGroup, 'arrow attack', smallArrowState, smallArrowHandle, 4, 200 );
	buildArrowFolder( smallGroup, 'arrow swallowtail', smallSwallowState, smallSwallowHandle, 4, 200 );
	buildArrowFolder( smallGroup, 'arrow hook (curved)', hookArrowState, hookArrowHandle, 4, 200 );
	buildArrowFolder( smallGroup, 'arrow U-shape (curved)', uArrowState, uArrowHandle, 4, 200 );
	buildTextFolder( smallGroup, 'text', smallTextState, smallTextHandle, 8, 128, 0.05, 5.0, 10, 0.000001, 0.000001, 200 );

	const largeGroup = gui.addFolder( 'Large (km scale)' );

	largeGroup.close();
	buildPointFolder( largeGroup, 'point/square', largePointSquareState, largePointSquareHandle, 100, 5000, 50, 300, 0.0001, 0.0001 );
	buildCircleFolder( largeGroup, 'circle', largeCircleState, largeCircleHandle, 100, 8000, 50, 400, 0.0001, 0.0001 );
	buildSectorFolder( largeGroup, 'sector', largeSectorState, largeSectorHandle, 100, 8000, 50, 400, 0.0001, 0.0001 );
	buildRectangleFolder( largeGroup, 'rectangle', largeRectangleState, largeRectangleHandle, 300, 20000 );
	buildPolygonFolder( largeGroup, 'polygon', largePolygonState, largePolygonHandle, 300, 20000 );
	buildLineFolder( largeGroup, 'line', largeLineState, largeLineHandle, 5, 500, 5, 20000 );
	buildArrowFolder( largeGroup, 'arrow', largeArrowState, largeArrowHandle, 300, 20000 );
	buildTextFolder( largeGroup, 'text', largeTextState, largeTextHandle, 8, 128, 0.5, 80, 10, 0.0001, 0.0001, 5000 );


	function resize(): void {
		const w = window.innerWidth;
		const h = window.innerHeight;
		renderer.setSize( w, h );
		camera.aspect = w / h;
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

		updateTerrainLogDepthUniforms( camera.near, camera.far );

		// 在 packed/主深度渲染前刷新兜底椭球面的 log-depth uniform（与上面 tiles
		// 的 updateTerrainLogDepthUniforms 同口径，保证两者深度空间一致）。
		ellipsoidDepth.update( camera );

		globeDepth.render( renderer, camera, scene, tilesRenderer.group );

		decals.update( {
			depthTexture: globeDepth.target.texture,
			width: renderer.domElement.width,
			height: renderer.domElement.height,
			camera,
			pixelRatio: renderer.getPixelRatio(),
		} );

		renderer.render( scene, camera );

		const lines: string[] = [];
		lines.push( `Plot demo @ (${ PLOT_CENTER_LON.toFixed( 4 ) }, ${ PLOT_CENTER_LAT.toFixed( 4 ) })` );
		lines.push( `Plots: ${ allStates.length } (8 categories x 2 scales + arrow variants)` );
		lines.push( `Global opacity: ${ ( globalState.globalOpacity * 100 ).toFixed( 0 ) }%` );
		lines.push(
			tilesRenderer.group.visible
				? 'Terrain: ON (Cesium Ion tiles)'
				: 'Terrain: OFF — plots clamp to WGS84 ellipsoid via EllipsoidDepthSource',
		);
		const stats = ( tilesRenderer as TilesRenderer & {
			stats: { visible: number; inCache: number; loaded: number; queued: number; downloading: number; parsing: number; failed: number };
		} ).stats;
		lines.push( `Tiles: visible ${ stats.visible } / cache ${ stats.inCache } / loaded ${ stats.loaded }` );
		if ( tileLoadError !== '' ) {
			lines.push( `Tile load error: ${ tileLoadError }` );
		}
		lines.push( '' );
		lines.push( '-- Plot list (ids allocated by GroundDecalManager) --' );
		for ( const { handle } of allStates ) {
			lines.push( `  [${ handle.id }] ${ handle.label }` );
		}
		infoBody.textContent = lines.join( '\n' );

		requestAnimationFrame( renderFrame );
	}

	( window as unknown as { __plotDemo?: unknown } ).__plotDemo = {
		renderer,
		scene,
		camera,
		tilesRenderer,
		controls,
		globeDepth,
		ellipsoidDepth,
		decals,
		allStates,
		flyToSmall,
		flyToLarge,
		flyToOverview,
	};

	renderFrame();
}
