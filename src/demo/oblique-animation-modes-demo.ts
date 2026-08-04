// ============================================================
// oblique-animation-modes-demo.ts
// Real-scene vertex animation comparison: Cesium terrain + imagery, direct
// oblique-photogrammetry 3D Tiles, one floating Three mesh, one terrain-clamped
// surface, and one deliberately small animated image decal clamped to the model.
// ============================================================

import GUI from 'lil-gui';
import {
	AmbientLight,
	Color,
	DirectionalLight,
	DoubleSide,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	PerspectiveCamera,
	PlaneGeometry,
	Raycaster,
	Scene,
	Sphere,
	SRGBColorSpace,
	TextureLoader,
	Vector3,
	WebGLRenderer,
	type Object3D,
	type WebGLProgramParametersWithUniforms,
} from 'three';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';

import {
	applyCesiumLogDepthToMaterial,
	cartesianToCartographic,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	CesiumGroundImagePrimitive,
	CesiumGroundMaterial,
	CesiumGroundMaterialAppearance,
	CesiumGroundRectanglePrimitive,
	ClassificationDepthManager,
	ClassificationType,
	createGroundFragmentShader,
	eastNorthUpToFixedFrame,
	longitudeLatitudeFromCenterOffsetsMeters,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	createGroundVertexShader,
	type Cartographic,
	type CesiumGroundFrameState,
	type LonLatPoint,
} from '../lib/ground';
import { createInfoPanel, installPageStyle } from './dom';
import { readStringEnv } from './env';
import { configureLoadedTileScene, createCesiumTilesRenderer } from './tiles';

const DEFAULT_OBLIQUE_URL =
	'https://sooncps.xwbuilders.com/api/ugis-dataprocess/v1/model/taz4Wo8Q5/tileset.json';
const INITIAL_HINT_LONGITUDE = 110.39;
const INITIAL_HINT_LATITUDE = 33.01;
const MODEL_DECAL_TEXTURE_URL = '/nc159642.jpg';
const MAX_PIXEL_RATIO = 1.5;

interface ObliqueAnimationSettings {
	animate: boolean;
	timeScale: number;
	waveSpeed: number;
	clampedAmplitude: number;
	floatingAmplitude: number;
	showFloating: boolean;
	showTerrainAnimation: boolean;
	showModelTexture: boolean;
	showTerrain: boolean;
	showOblique: boolean;
	flyToModel: () => void;
}

interface ObliqueAnimationHandle {
	ready: boolean;
	renderedFrames: number;
	modeNames: readonly string[];
	modelStatus: string;
	terrainStatus: string;
	modelRadius: number;
	modelDecalSize: number;
	lastRenderPasses: readonly string[];
	renderer: WebGLRenderer;
	scene: Scene;
	camera: PerspectiveCamera;
	baseTiles: TilesRenderer;
	modelTiles: TilesRenderer;
	depthManager: ClassificationDepthManager;
	groundPrimitive: CesiumGroundRectanglePrimitive | null;
	modelPrimitive: CesiumGroundImagePrimitive | null;
	floatingMesh: Mesh | null;
	frameState: CesiumGroundFrameState | null;
	settings: ObliqueAnimationSettings;
	stop: () => void;
}

interface ShaderUniform {
	value: number;
}

function clamp( value: number, minimum: number, maximum: number ): number {
	return Math.min( maximum, Math.max( minimum, value ) );
}

function createRectanglePoints(
	centerLongitude: number,
	centerLatitude: number,
	eastOffset: number,
	northOffset: number,
	widthMeters: number,
	heightMeters: number,
): LonLatPoint[] {
	const halfWidth = widthMeters * 0.5;
	const halfHeight = heightMeters * 0.5;
	return longitudeLatitudeFromCenterOffsetsMeters(
		centerLongitude,
		centerLatitude,
		[
			{ eastMeters: eastOffset - halfWidth, northMeters: northOffset - halfHeight },
			{ eastMeters: eastOffset + halfWidth, northMeters: northOffset - halfHeight },
			{ eastMeters: eastOffset + halfWidth, northMeters: northOffset + halfHeight },
			{ eastMeters: eastOffset - halfWidth, northMeters: northOffset + halfHeight },
		],
	).map( point => [ point.longitude, point.latitude ] as LonLatPoint );
}

function configureFloatingMaterial(
	material: MeshStandardMaterial,
	timeUniform: ShaderUniform,
	amplitudeUniform: ShaderUniform,
	speedUniform: ShaderUniform,
): void {
	material.onBeforeCompile = ( shader: WebGLProgramParametersWithUniforms ) => {
		shader.uniforms.u_demoTime = timeUniform;
		shader.uniforms.u_demoAmplitude = amplitudeUniform;
		shader.uniforms.u_demoSpeed = speedUniform;
		shader.vertexShader = shader.vertexShader.replace(
			'#include <common>',
			`#include <common>
uniform float u_demoTime;
uniform float u_demoAmplitude;
uniform float u_demoSpeed;`,
		);
		shader.vertexShader = shader.vertexShader.replace(
			'#include <begin_vertex>',
			`#include <begin_vertex>
float demoWave = sin(position.x * 0.095 + u_demoTime * u_demoSpeed)
	* cos(position.y * 0.065 - u_demoTime * u_demoSpeed * 0.72);
transformed.z += demoWave * u_demoAmplitude;`,
		);
	};
	applyCesiumLogDepthToMaterial( material );
}

function createObliqueTilesRenderer( url: string ): TilesRenderer {
	const tiles = new TilesRenderer( url );
	tiles.group.name = 'AnimationObliqueTilesGroup';
	tiles.errorTarget = 6.0;
	tiles.autoDisableRendererCulling = true;
	tiles.displayActiveTiles = true;
	tiles.addEventListener( 'load-model', ( { scene }: { scene: Object3D } ) => {
		configureLoadedTileScene( scene, { recolor: false } );
	} );
	return tiles;
}

function installObliqueLegend(): void {
	const style = document.createElement( 'style' );
	style.textContent = `
		#animation-mode-legend {
			position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
			display: grid; grid-template-columns: repeat(3, minmax(160px, 230px));
			gap: 10px; width: min(750px, calc(100vw - 28px)); pointer-events: none;
		}
		#animation-mode-legend > div {
			padding: 9px 12px; border: 1px solid rgba(255,255,255,.16);
			border-radius: 8px; background: rgba(5,9,14,.82); backdrop-filter: blur(8px);
			font-size: 12px; line-height: 1.45; text-align: center;
		}
		#animation-mode-legend strong { display: block; font-size: 13px; }
		#animation-mode-legend .floating strong { color: #46d7ff; }
		#animation-mode-legend .ground strong { color: #45e09b; }
		#animation-mode-legend .model strong { color: #ffb13d; }
	`;
	document.head.appendChild( style );
	const oldLegend = document.getElementById( 'animation-mode-legend' );
	oldLegend?.remove();
	const legend = document.createElement( 'div' );
	legend.id = 'animation-mode-legend';
	legend.innerHTML = `
		<div class="floating"><strong>不贴地</strong>普通 Three 网格，悬浮在真实场景上方</div>
		<div class="ground"><strong>贴真实地形</strong>TERRAIN 分类，采样 Cesium 地形深度</div>
		<div class="model"><strong>小纹理贴倾斜</strong>局部图片贴花，尺寸远小于倾斜摄影范围</div>
	`;
	document.body.appendChild( legend );
}

export function runObliqueAnimationModesDemo(): void {
	installPageStyle();
	installObliqueLegend();
	const infoBody = createInfoPanel();
	const title = document.querySelector( '#info-panel .title' );
	if ( title ) title.textContent = '顶点动画 · 真实地形与倾斜摄影';
	const app = document.getElementById( 'app' );
	if ( ! app ) throw new Error( 'Missing #app container.' );
	app.innerHTML = '';

	const scene = new Scene();
	scene.background = new Color( 0x071018 );
	const renderer = new WebGLRenderer( {
		antialias: true,
		stencil: true,
		alpha: false,
		powerPreference: 'high-performance',
	} );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, MAX_PIXEL_RATIO ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.autoClearStencil = true;
	app.appendChild( renderer.domElement );
	validateCesiumGroundRenderer( renderer );

	scene.add( new AmbientLight( 0xffffff, 0.68 ) );
	const sun = new DirectionalLight( 0xffffff, 1.5 );
	sun.position.set( 0.35, - 0.45, 0.82 ).normalize();
	scene.add( sun );

	const camera = new PerspectiveCamera(
		55,
		window.innerWidth / window.innerHeight,
		0.1,
		40000000.0,
	);
	camera.up.set( 0, 0, 1 );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );
	const hint = wgs84PositionFromDegrees(
		INITIAL_HINT_LONGITUDE,
		INITIAL_HINT_LATITUDE,
		0.0,
	);
	camera.position.copy( hint ).addScaledVector(
		wgs84NormalFromDegrees( INITIAL_HINT_LONGITUDE, INITIAL_HINT_LATITUDE ),
		12000.0,
	);
	camera.lookAt( hint );
	camera.updateMatrixWorld();

	let terrainStatus = 'loading';
	let hasRealTerrain = false;
	let baseTiles: TilesRenderer;
	try {
		baseTiles = createCesiumTilesRenderer( renderer );
		baseTiles.addEventListener( 'load-model', ( { scene: tileScene }: { scene: Object3D } ) => {
			configureLoadedTileScene( tileScene, { recolor: false } );
			terrainStatus = 'loaded';
		} );
		hasRealTerrain = true;
	} catch ( error ) {
		terrainStatus = error instanceof Error ? error.message : String( error );
		baseTiles = createCesiumTilesRenderer( renderer, true );
		console.error( '[animation-oblique] Real Cesium terrain unavailable:', error );
	}
	baseTiles.setCamera( camera );
	baseTiles.setResolutionFromRenderer( camera, renderer );
	scene.add( baseTiles.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( baseTiles.ellipsoid, baseTiles.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 0.1;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	const obliqueUrl = readStringEnv( 'VITE_OBLIQUE_TILESET_URL' ) || DEFAULT_OBLIQUE_URL;
	const modelTiles = createObliqueTilesRenderer( obliqueUrl );
	modelTiles.setCamera( camera );
	modelTiles.setResolutionFromRenderer( camera, renderer );
	scene.add( modelTiles.group );
	let modelStatus = 'loading';
	modelTiles.addEventListener( 'load-model', () => {
		if ( ! modelCenter ) modelStatus = 'loading tiles';
	} );
	modelTiles.addEventListener( 'load-error', ( event ) => {
		const error = ( event as unknown as { error?: { message?: string } } ).error;
		modelStatus = `error: ${ error?.message ?? 'unknown' }`;
	} );

	const depthManager = new ClassificationDepthManager(
		renderer.domElement.width,
		renderer.domElement.height,
	);
	depthManager.attach( scene );
	if ( hasRealTerrain ) depthManager.addContributor( baseTiles.group, 'terrain' );
	depthManager.addContributor( modelTiles.group, 'tileset' );

	const settings: ObliqueAnimationSettings = {
		animate: true,
		timeScale: 1.0,
		waveSpeed: 2.1,
		clampedAmplitude: 0.016,
		floatingAmplitude: 16.0,
		showFloating: true,
		showTerrainAnimation: true,
		showModelTexture: true,
		showTerrain: true,
		showOblique: true,
		flyToModel: () => flyToModel(),
	};

	let groundPrimitive: CesiumGroundRectanglePrimitive | null = null;
	let modelPrimitive: CesiumGroundImagePrimitive | null = null;
	let floatingMesh: Mesh | null = null;
	let groundMaterial: CesiumGroundMaterial | null = null;
	let modelMaterial: CesiumGroundMaterial | null = null;
	let modelCenter: Vector3 | null = null;
	let modelUp = new Vector3( 0, 0, 1 );
	let modelRadius = 0.0;
	let modelDecalSize = 0.0;
	let flyDistance = 4000.0;
	const scratchSphere = new Sphere();
	const rootCenter = new Vector3();
	const rootUp = new Vector3();
	let rootSphereReady = false;
	const scratchCartographic: Cartographic = { longitude: 0, latitude: 0, height: 0 };
	const surfaceRaycaster = new Raycaster();
	const rayOrigin = new Vector3();
	const rayDirection = new Vector3();
	const rayEast = new Vector3();
	const rayNorth = new Vector3();
	const floatingTime = { value: 0.0 };
	const floatingAmplitude = { value: settings.floatingAmplitude };
	const floatingSpeed = { value: settings.waveSpeed };

	function flyToModel(): void {
		if ( ! modelCenter ) return;
		const east = new Vector3( - modelUp.y, modelUp.x, 0.0 ).normalize();
		camera.position
			.copy( modelCenter )
			.addScaledVector( modelUp, flyDistance )
			.addScaledVector( east, flyDistance * 0.22 );
		camera.lookAt( modelCenter );
		camera.updateMatrixWorld();
	}

	function findLoadedModelSurface(): Vector3 | null {
		if ( ! rootSphereReady || modelTiles.group.children.length === 0 ) return null;
		modelTiles.group.updateMatrixWorld( true );
		rayEast.set( - rootUp.y, rootUp.x, 0.0 ).normalize();
		rayNorth.crossVectors( rootUp, rayEast ).normalize();
		rayDirection.copy( rootUp ).negate();
		const offsets: ReadonlyArray<readonly [ number, number ]> = [
			[ 0.0, 0.0 ],
			[ 0.12, 0.0 ], [ - 0.12, 0.0 ], [ 0.0, 0.12 ], [ 0.0, - 0.12 ],
			[ 0.18, 0.18 ], [ - 0.18, 0.18 ], [ 0.18, - 0.18 ], [ - 0.18, - 0.18 ],
		];
		for ( const [ eastRatio, northRatio ] of offsets ) {
			rayOrigin
				.copy( rootCenter )
				.addScaledVector( rayEast, modelRadius * eastRatio )
				.addScaledVector( rayNorth, modelRadius * northRatio )
				.addScaledVector( rootUp, modelRadius * 1.6 );
			surfaceRaycaster.set( rayOrigin, rayDirection );
			surfaceRaycaster.near = 0.0;
			surfaceRaycaster.far = modelRadius * 3.2;
			const hit = surfaceRaycaster.intersectObject( modelTiles.group, true )[ 0 ];
			if ( hit ) return hit.point.clone();
		}
		return null;
	}

	function buildAnimationExamples(
		centerLongitude: number,
		centerLatitude: number,
		centerHeight: number,
		radius: number,
	): void {
		if ( groundPrimitive || modelPrimitive || floatingMesh ) return;
		const layoutUnit = clamp( radius * 0.06, 150.0, 650.0 );
		const groundWidth = clamp( layoutUnit * 0.48, 70.0, 310.0 );
		modelDecalSize = clamp( radius * 0.035, 30.0, 260.0 );

		groundMaterial = new CesiumGroundMaterial( {
			type: 'RealTerrainVertexWave',
			uniforms: {
				u_waveAmplitude: { value: settings.clampedAmplitude },
				u_waveFrequency: { value: 0.065 },
				u_waveSpeed: { value: settings.waveSpeed },
			},
			vertexShader: createGroundVertexShader( /* glsl */ `
uniform float u_waveAmplitude;
uniform float u_waveFrequency;
uniform float u_waveSpeed;
`, /* glsl */ `
	float wave = sin(vertexInput.positionEC.x * u_waveFrequency + c23_time * u_waveSpeed);
	vertexOutput.positionClip.y += wave * u_waveAmplitude * vertexOutput.positionClip.w;
` ),
			fragmentShader: createGroundFragmentShader( /* glsl */ `
uniform float u_waveSpeed;
`, /* glsl */ `
	float bands = smoothstep(0.32, 0.68, 0.5 + 0.5 * sin(
		materialInput.localMeters.x * 0.12 - c23_time * u_waveSpeed * 1.7
	));
	material.diffuse = mix(vec3(0.02, 0.3, 0.12), vec3(0.3, 1.0, 0.62), bands);
	material.emission = material.diffuse * 0.18;
` ),
		} );
		groundPrimitive = new CesiumGroundRectanglePrimitive( {
			points: createRectanglePoints(
				centerLongitude,
				centerLatitude,
				- layoutUnit * 1.8,
				0.0,
				groundWidth,
				groundWidth * 0.75,
			),
			strokeColor: '#ffffff',
			strokeWidth: 2.0,
			strokeOpacity: 95,
			fillColor: '#32dd8d',
			fillOpacity: 90,
			visible: settings.showTerrainAnimation,
			appearance: new CesiumGroundMaterialAppearance( { material: groundMaterial } ),
			classificationType: ClassificationType.TERRAIN,
			renderOrder: 20,
		} );
		scene.add( groundPrimitive.classification.group );

		const decalTexture = new TextureLoader().load( MODEL_DECAL_TEXTURE_URL );
		decalTexture.colorSpace = SRGBColorSpace;
		modelMaterial = new CesiumGroundMaterial( {
			type: 'SmallAnimatedObliqueTexture',
			uniforms: {
				u_decalTexture: { value: decalTexture },
				u_waveAmplitude: { value: settings.clampedAmplitude },
				u_waveFrequency: { value: 0.065 },
				u_waveSpeed: { value: settings.waveSpeed },
			},
			vertexShader: createGroundVertexShader( /* glsl */ `
uniform float u_waveAmplitude;
uniform float u_waveFrequency;
uniform float u_waveSpeed;
`, /* glsl */ `
	float wave = sin(vertexInput.positionEC.x * u_waveFrequency + c23_time * u_waveSpeed);
	vertexOutput.positionClip.y += wave * u_waveAmplitude * vertexOutput.positionClip.w;
` ),
			fragmentShader: createGroundFragmentShader( /* glsl */ `
uniform sampler2D u_decalTexture;
uniform float u_waveSpeed;
`, /* glsl */ `
	float scale = mix(0.78, 1.0, 0.5 + 0.5 * sin(c23_time * u_waveSpeed));
	vec2 uv = (materialInput.st - 0.5) / scale + 0.5;
	float inside = step(0.0, uv.x) * step(uv.x, 1.0)
		* step(0.0, uv.y) * step(uv.y, 1.0);
	vec3 texel = texture(u_decalTexture, vec2(uv.x, 1.0 - uv.y)).rgb;
	float brightness = dot(texel, vec3(0.299, 0.587, 0.114));
	material.diffuse = mix(vec3(0.02, 0.12, 0.24), vec3(1.0, 0.24, 0.03), brightness);
	material.emission = material.diffuse * 0.2;
	material.alpha = inside;
` ),
		} );
		modelPrimitive = new CesiumGroundImagePrimitive( {
			position: [ centerLongitude, centerLatitude ],
			imageUrl: MODEL_DECAL_TEXTURE_URL,
			imageWidth: modelDecalSize,
			imageHeight: modelDecalSize,
			rotation: 0.0,
			strokeColor: '#ffffff',
			strokeWidth: 0.0,
			strokeOpacity: 0.0,
			fillColor: '#ffffff',
			fillOpacity: 100,
			visible: settings.showModelTexture,
			appearance: new CesiumGroundMaterialAppearance( { material: modelMaterial } ),
			classificationType: ClassificationType.CESIUM_3D_TILE,
			renderOrder: 30,
		} );
		scene.add( modelPrimitive.group );

		const floatingMaterial = new MeshStandardMaterial( {
			color: 0x36c7f4,
			emissive: 0x06384a,
			emissiveIntensity: 1.1,
			roughness: 0.42,
			metalness: 0.12,
			side: DoubleSide,
			wireframe: true,
			transparent: true,
			opacity: 0.96,
		} );
		configureFloatingMaterial(
			floatingMaterial,
			floatingTime,
			floatingAmplitude,
			floatingSpeed,
		);
		const floatingGeometry = new PlaneGeometry( groundWidth, groundWidth * 0.75, 24, 18 );
		floatingGeometry.translate( layoutUnit * 1.8, 0.0, layoutUnit * 0.7 );
		floatingMesh = new Mesh( floatingGeometry, floatingMaterial );
		floatingMesh.name = 'RealSceneFloatingVertexMesh';
		floatingMesh.frustumCulled = false;
		floatingMesh.visible = settings.showFloating;
		const anchor = wgs84PositionFromDegrees(
			centerLongitude,
			centerLatitude,
			centerHeight,
		);
		floatingMesh.matrixAutoUpdate = false;
		floatingMesh.matrix.copy( eastNorthUpToFixedFrame( anchor, new Matrix4() ) );
		floatingMesh.matrixWorldNeedsUpdate = true;
		scene.add( floatingMesh );

		modelCenter = wgs84PositionFromDegrees( centerLongitude, centerLatitude, centerHeight );
		modelUp = wgs84NormalFromDegrees( centerLongitude, centerLatitude );
		modelRadius = radius;
		flyDistance = clamp( radius * 0.18, 1200.0, 4500.0 );
		modelStatus = 'ready';
		flyToModel();
	}

	const gui = new GUI( { title: '真实场景动画对比' } );
	gui.add( settings, 'animate' ).name( '播放动画' );
	gui.add( settings, 'timeScale', 0.0, 3.0, 0.05 ).name( '时间倍率' );
	gui.add( settings, 'waveSpeed', 0.1, 6.0, 0.1 ).name( '波动速度' ).onChange( ( value: number ) => {
		floatingSpeed.value = value;
		groundMaterial?.setUniform( 'u_waveSpeed', value );
		modelMaterial?.setUniform( 'u_waveSpeed', value );
	} );
	gui.add( settings, 'floatingAmplitude', 0.0, 50.0, 0.5 ).name( '不贴地振幅 m' ).onChange( ( value: number ) => {
		floatingAmplitude.value = value;
	} );
	gui.add( settings, 'clampedAmplitude', 0.0, 0.05, 0.001 ).name( '贴合振幅 NDC' ).onChange( ( value: number ) => {
		groundMaterial?.setUniform( 'u_waveAmplitude', value );
		modelMaterial?.setUniform( 'u_waveAmplitude', value );
	} );
	const displayFolder = gui.addFolder( '真实场景图层' );
	displayFolder.add( settings, 'showTerrain' ).name( '真实地形/影像' ).onChange( ( value: boolean ) => {
		baseTiles.group.visible = value;
	} );
	displayFolder.add( settings, 'showOblique' ).name( '倾斜摄影' ).onChange( ( value: boolean ) => {
		modelTiles.group.visible = value;
	} );
	displayFolder.add( settings, 'showFloating' ).name( '不贴地动画' ).onChange( ( value: boolean ) => {
		if ( floatingMesh ) floatingMesh.visible = value;
	} );
	displayFolder.add( settings, 'showTerrainAnimation' ).name( '贴地动画' ).onChange( ( value: boolean ) => {
		if ( groundPrimitive ) groundPrimitive.classification.group.visible = value;
	} );
	displayFolder.add( settings, 'showModelTexture' ).name( '小纹理贴倾斜' ).onChange( ( value: boolean ) => {
		if ( modelPrimitive ) modelPrimitive.group.visible = value;
	} );
	gui.add( settings, 'flyToModel' ).name( '定位倾斜摄影' );

	let running = true;
	let previousTimestamp = performance.now();
	let elapsedTime = 0.0;
	let frameNumber = 0;
	let renderedFrames = 0;
	let frameState: CesiumGroundFrameState | null = null;
	const lastRenderPasses: string[] = [];
	const handle: ObliqueAnimationHandle = {
		ready: false,
		renderedFrames: 0,
		modeNames: [ 'floating', 'terrain', 'oblique-texture' ],
		modelStatus,
		terrainStatus,
		modelRadius,
		modelDecalSize,
		lastRenderPasses,
		renderer,
		scene,
		camera,
		baseTiles,
		modelTiles,
		depthManager,
		groundPrimitive,
		modelPrimitive,
		floatingMesh,
		frameState,
		settings,
		stop: () => { running = false; },
	};
	( window as unknown as { __demo?: ObliqueAnimationHandle } ).__demo = handle;

	function resize(): void {
		renderer.setSize( window.innerWidth, window.innerHeight );
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		baseTiles.setResolutionFromRenderer( camera, renderer );
		modelTiles.setResolutionFromRenderer( camera, renderer );
		depthManager.resize( renderer.domElement.width, renderer.domElement.height );
	}
	window.addEventListener( 'resize', resize );

	function renderLayeredScene(): void {
		const terrainVisible = baseTiles.group.visible;
		const obliqueVisible = modelTiles.group.visible;
		const terrainAnimationVisible = groundPrimitive?.classification.group.visible ?? false;
		const obliqueTextureVisible = modelPrimitive?.group.visible ?? false;
		const floatingVisible = floatingMesh?.visible ?? false;
		const previousBackground = scene.background;
		const previousAutoClear = renderer.autoClear;
		lastRenderPasses.length = 0;

		try {
			// Pass 1: real terrain first, followed by TERRAIN classification.
			// Classification color intentionally has depthTest=false; the following
			// oblique pass is therefore responsible for covering terrain decals.
			baseTiles.group.visible = terrainVisible;
			modelTiles.group.visible = false;
			if ( groundPrimitive ) {
				groundPrimitive.classification.group.visible = terrainAnimationVisible;
			}
			if ( modelPrimitive ) modelPrimitive.group.visible = false;
			if ( floatingMesh ) floatingMesh.visible = false;
			renderer.autoClear = true;
			scene.background = previousBackground;
			renderer.render( scene, camera );
			lastRenderPasses.push( 'terrain+terrain-classification' );

			// Pass 2: preserve color/depth and draw oblique photogrammetry afterward.
			// It now naturally occludes the terrain classification beneath it.
			renderer.autoClear = false;
			scene.background = null;
			baseTiles.group.visible = false;
			if ( groundPrimitive ) groundPrimitive.classification.group.visible = false;
			modelTiles.group.visible = obliqueVisible;
			renderer.render( scene, camera );
			lastRenderPasses.push( 'oblique-occlusion' );

			// Pass 3: model depth is already in the framebuffer; draw only the small
			// CESIUM_3D_TILE texture classification over the oblique surface.
			modelTiles.group.visible = false;
			if ( modelPrimitive ) modelPrimitive.group.visible = obliqueTextureVisible;
			renderer.render( scene, camera );
			lastRenderPasses.push( 'oblique-texture-classification' );

			// Pass 4: ordinary floating geometry participates in the preserved depth.
			if ( modelPrimitive ) modelPrimitive.group.visible = false;
			if ( floatingMesh ) floatingMesh.visible = floatingVisible;
			renderer.render( scene, camera );
			lastRenderPasses.push( 'floating' );
		} finally {
			baseTiles.group.visible = terrainVisible;
			modelTiles.group.visible = obliqueVisible;
			if ( groundPrimitive ) {
				groundPrimitive.classification.group.visible = terrainAnimationVisible;
			}
			if ( modelPrimitive ) modelPrimitive.group.visible = obliqueTextureVisible;
			if ( floatingMesh ) floatingMesh.visible = floatingVisible;
			scene.background = previousBackground;
			renderer.autoClear = previousAutoClear;
		}
	}

	function renderFrame( timestamp: number ): void {
		if ( ! running ) return;
		requestAnimationFrame( renderFrame );
		const deltaSeconds = Math.min( ( timestamp - previousTimestamp ) / 1000.0, 0.1 );
		previousTimestamp = timestamp;
		if ( settings.animate ) elapsedTime += deltaSeconds * settings.timeScale;
		floatingTime.value = elapsedTime;

		controls.update();
		camera.updateMatrixWorld();
		baseTiles.setResolutionFromRenderer( camera, renderer );
		baseTiles.update();
		modelTiles.setResolutionFromRenderer( camera, renderer );
		modelTiles.update();

		if ( ! rootSphereReady && modelTiles.getBoundingSphere( scratchSphere ) ) {
			const cartographic = cartesianToCartographic(
				scratchSphere.center,
				scratchCartographic,
			);
			if ( cartographic ) {
				rootCenter.copy( scratchSphere.center );
				rootUp.copy( wgs84NormalFromDegrees(
					cartographic.longitude * 180.0 / Math.PI,
					cartographic.latitude * 180.0 / Math.PI,
				) );
				modelRadius = scratchSphere.radius;
				rootSphereReady = true;
			}
		}
		if ( ! modelCenter && rootSphereReady && renderedFrames % 10 === 0 ) {
			const surfacePoint = findLoadedModelSurface();
			if ( surfacePoint ) {
				const surfaceCartographic = cartesianToCartographic(
					surfacePoint,
					scratchCartographic,
				);
				if ( surfaceCartographic ) {
					buildAnimationExamples(
						surfaceCartographic.longitude * 180.0 / Math.PI,
						surfaceCartographic.latitude * 180.0 / Math.PI,
						surfaceCartographic.height,
						modelRadius,
					);
				}
			}
		}

		updateTerrainLogDepthUniforms( camera.near, camera.far );
		depthManager.update( camera );
		depthManager.renderDepth(
			renderer,
			camera,
			scene,
			[ ClassificationType.TERRAIN, ClassificationType.CESIUM_3D_TILE ],
		);
		const terrainTexture = depthManager.getTexture( ClassificationType.TERRAIN );
		if ( terrainTexture ) {
			frameState = depthManager.buildFrameState( {
				depthTexture: terrainTexture,
				width: renderer.domElement.width,
				height: renderer.domElement.height,
				camera,
				timeSeconds: elapsedTime,
				deltaSeconds,
				frameNumber: ++ frameNumber,
				pixelRatio: renderer.getPixelRatio(),
			} );
			groundPrimitive?.update( frameState );
			modelPrimitive?.update( frameState );
		}

		renderLayeredScene();
		renderedFrames ++;
		handle.renderedFrames = renderedFrames;
		handle.modelStatus = modelStatus;
		handle.terrainStatus = terrainStatus;
		handle.modelRadius = modelRadius;
		handle.modelDecalSize = modelDecalSize;
		handle.lastRenderPasses = lastRenderPasses;
		handle.groundPrimitive = groundPrimitive;
		handle.modelPrimitive = modelPrimitive;
		handle.floatingMesh = floatingMesh;
		handle.frameState = frameState;
		handle.ready = modelStatus === 'ready'
			&& terrainStatus === 'loaded'
			&& frameState !== null;

		const ratio = modelRadius > 0.0 ? modelDecalSize / ( modelRadius * 2.0 ) * 100.0 : 0.0;
		infoBody.textContent =
			`地形/影像: ${ terrainStatus }\n` +
			`倾斜摄影: ${ modelStatus }\n` +
			`倾斜来源: ${ obliqueUrl }\n` +
			`倾斜范围直径约: ${ ( modelRadius * 2.0 ).toFixed( 1 ) } m\n` +
			`局部纹理: ${ modelDecalSize.toFixed( 1 ) } × ${ modelDecalSize.toFixed( 1 ) } m（约倾斜范围直径 ${ ratio.toFixed( 2 ) }%）\n` +
			`动画: ${ elapsedTime.toFixed( 2 ) } s / frame ${ frameNumber }`;
	}

	requestAnimationFrame( renderFrame );
}
