// ============================================================
// ground-demo.ts
// 层级:Cesium-free 贴地适配器的 Three.js 可运行宿主。
// 职责:驱动 um-3d-tiles-renderer 地形，把地形深度喂给 shadow-volume classification
//      管线，并暴露 lil-gui 调试面板，用于矩形、多边形、圆形和箭头标绘。
// 依赖:demo helpers、src/lib/ground、Three.js、um-3d-tiles-renderer。
// 被消费:main.ts。
// ============================================================

import {
	AmbientLight,
	Box3,
	Clock,
	Color,
	DirectionalLight,
	Group,
	Matrix4,
	PerspectiveCamera,
	Scene,
	Vector3,
	Vector4,
	WebGLRenderer,
	type Material,
	type Object3D,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';
import GUI from 'lil-gui';

import {
	CesiumGlobeDepth,
	createCesiumEllipsoidDepthMeshes,
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
	CesiumGroundRectanglePrimitive,
	CesiumGroundTextPrimitive,
	CesiumGroundMaterial,
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
	createFlowLineMaterial,
	createPulsePointMaterial,
	createScalePulseMaterial,
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	LINE_DEFAULT_GRANULARITY,
	MAX_CIRCLE_GRANULARITY_RADIANS,
	MIN_CIRCLE_GRANULARITY_RADIANS,
	eastNorthUpToFixedFrame,
	initializeApproximateTerrainHeights,
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleMeterSizeFromDegrees,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type CesiumGroundArcType,
	type CesiumGroundArrowMode,
	type CesiumGroundArrowStyle,
	type CesiumGroundLineWidthMode,
	type CesiumGroundPointShape,
	type LonLatPoint,
} from '../lib/ground';
import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import { type GroundDebugSettings, type GroundDebugStatus } from './debug-types';
import {
	clampNumber,
	createLocalPolygonOffsets,
	PlotOrderRegistry,
	plotOrderToRenderOrder,
} from './plot-utils';
import {
	configureLoadedTileScene,
	createCesiumTilesRenderer,
	type TileRuntimeCounters,
	type TilesRuntimeStats,
} from './tiles';
import { ArrowSubsystem, type ArrowPlotId } from './arrow-demo';

const RECTANGLE_CENTER_LON = readNumberEnv( 'VITE_PLOT_LON', 86.9250 );
const RECTANGLE_CENTER_LAT = readNumberEnv( 'VITE_PLOT_LAT', 27.9881 );
// 1:1 比例测试:每个图元约 10 m；近景相机下约 1 px/m，便于观察贴地误差。
// 在纬度 28° 附近，半边长约 5 m ≈ 4.5e-5 度。
const RECTANGLE_HALF_WIDTH_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_WIDTH_DEGREES', 5.0e-5 );
const RECTANGLE_HALF_HEIGHT_DEGREES = readNumberEnv( 'VITE_PLOT_HALF_HEIGHT_DEGREES', 5.0e-5 );
const DEBUG_GROUND_SURFACE = readStringEnv( 'VITE_DEBUG_GROUND_SURFACE', 'false' ).toLowerCase() === 'true';
const DEMO_GLB_MODEL_URL = encodeURI( '/\u95e8\u7a97\u8bbe\u7f6e\u7b49\u6d4b\u8bd5\u5e26fds.glb' );
const DEMO_GLB_DRACO_DECODER_PATH = '/draco/gltf/';
const DEMO_GLB_MODEL_LON = readNumberEnv( 'VITE_GLB_MODEL_LON', RECTANGLE_CENTER_LON );
const DEMO_GLB_MODEL_LAT = readNumberEnv( 'VITE_GLB_MODEL_LAT', RECTANGLE_CENTER_LAT );
const DEMO_GLB_MODEL_HEIGHT_METERS = readNumberEnv( 'VITE_GLB_MODEL_HEIGHT_METERS', 50.0 );
const DEMO_GLB_MODEL_SCALE = Math.max( readNumberEnv( 'VITE_GLB_MODEL_SCALE', 1.0 ), 1.0e-6 );
const DEMO_GLB_MODEL_HEADING_DEGREES = readNumberEnv( 'VITE_GLB_MODEL_HEADING_DEGREES', 0.0 );
const DEMO_GLB_MODEL_RENDER_ORDER = 100000;

// 箭头子系统开关。保留为常量，便于调试时快速隔离。
// 最初用于定位曲线填充被切断的问题:关闭箭头后仍可复现，说明问题来自贴地
// 图元管线本身，而不是箭头代码。对应修复在 primitives.ts 中，矩形 / 多边形
// 现在与圆形一样使用 ±55km 的 flat shadow volume。
const ENABLE_ARROW_SUBSYSTEM = true;

// 1:1 比例测试:三个贴地图元都约 10 m，并放在不同经纬度槽位，
// 近景下更容易区分。纬度 28° 附近，1 m ≈ 1.02e-5 经度 ≈ 9.01e-6 纬度。
//
// 布局(中心 = rectangle):
//      [polygon]          -> 东北，约向东 50 m + 向北 30 m
//   [rectangle]            -> 中心
//                 [circle] -> 西南，避免与箭头初始位置重叠
//
// polygon 放东北、circle 放西南，避免和 arrow-demo.ts 在矩形周围生成的箭头重叠。
const POLYGON_OFFSET_LON = 70.0 * 1.02e-5;   // ~70 m east of rectangle
const POLYGON_OFFSET_LAT = 18.0 * 9.01e-6;   // ~18 m north of rectangle
const CIRCLE_OFFSET_LON = -65.0 * 1.02e-5;   // ~65 m west of rectangle
const CIRCLE_OFFSET_LAT = -18.0 * 9.01e-6;   // ~18 m south of rectangle
// 文字标绘 1:1 比例尺锚点：放在矩形正上方约 30 m。content 用 fontSize=16 +
// metersPerPixel=1.0 时，按比例尺名义「1 纹素 ≈ 1 米」绘制，地面足迹与图元同量级。
const TEXT_OFFSET_LON = 0.0;
const TEXT_OFFSET_LAT = 30.0 * 9.01e-6;

// 点标绘锚点：两个点放在矩形东南方向，分别走圆形 / 矩形渲染路径，
// 避免与 polygon (东北) / circle (西南) / text (正北) 的足迹重叠。
const POINT_CIRCLE_OFFSET_LON = 25.0 * 1.02e-5;   // ~25 m east of rectangle
const POINT_CIRCLE_OFFSET_LAT = - 35.0 * 9.01e-6; // ~35 m south of rectangle
const POINT_SQUARE_OFFSET_LON = - 20.0 * 1.02e-5; // ~20 m west of rectangle
const POINT_SQUARE_OFFSET_LAT = - 35.0 * 9.01e-6; // ~35 m south of rectangle

// 折线 1:1 锚点：四个折点形成跨越矩形周围其它图元的 zig-zag 路径，方便
// 观察拐角斜接 + breakMiter 行为；总长约 200 m，与其它 1:1 图元同量级。
const POLYLINE_VERTEX_OFFSETS: { eastMeters: number; northMeters: number }[] = [
	{ eastMeters: - 90.0, northMeters: 55.0 },   // 西北
	{ eastMeters: - 30.0, northMeters: 65.0 },
	{ eastMeters: 30.0, northMeters: 45.0 },
	{ eastMeters: 90.0, northMeters: 55.0 },     // 东北
];

/**
 * lil-gui 的 string controller 默认是 `<input type="text">` 单行，按 Enter 直接
 * 失焦提交，无法输入 `\n`。但 text-layout.ts 已经按 `content.split('\n')` 支持
 * 横排换行 / 竖排换列——也就是说渲染层早就准备好了多行，缺的是 GUI 的输入手段。
 *
 * **关键陷阱**：`HTMLInputElement.value` setter 按 HTML 规范会剥掉所有换行符
 * (`\n` / `\r`)，再读 `.value` 拿到的是单行。早期把 textarea 内容回写隐藏
 * input 再 dispatch 事件的方案就栽在这里——lil-gui 的监听器执行
 * `this.setValue(this.$input.value)` 时读到的已经是被剥掉换行的字符串。
 *
 * 正确做法：直接 **替换** 原 input 节点为 `<textarea>`，并把
 * `controller.$input` 指向它（lil-gui `updateDisplay()` 会写 `this.$input.value
 * = getValue()`，textarea 接住换行不变）；监听 textarea 自己的 input / blur，
 * 走 controller 的公开 `setValue` 与底层 `_callOnFinishChange` 触发外部回调链。
 *
 * @param controller lil-gui 的 string controller。
 * @param rows       textarea 行数，默认 3。
 */
function convertControllerToTextarea(
	controller: { getValue: () => unknown; setValue: ( v: unknown ) => unknown },
	rows = 3,
): void {
	// lil-gui 的公共 Controller 类型不含 `$input` / `$disable` / `_callOnFinishChange`，
	// 但实现里都有；走 unknown → object 单步 cast 拿引用，运行期判空兜底。
	const internal = controller as unknown as {
		$input?: HTMLInputElement;
		$disable?: HTMLElement;
		_callOnFinishChange?: () => void;
	};
	const input = internal.$input;
	if ( input === undefined || input === null || input.parentNode === null ) {
		return;
	}

	const textarea = document.createElement( 'textarea' );
	textarea.rows = rows;
	textarea.value = String( controller.getValue() ?? '' );
	textarea.spellcheck = false;
	textarea.style.width = '100%';
	textarea.style.minHeight = `${ rows * 18 }px`;
	textarea.style.resize = 'vertical';
	textarea.style.fontFamily = 'inherit';
	textarea.style.fontSize = 'inherit';
	textarea.style.lineHeight = '1.4';
	// 沿用 lil-gui 既有视觉变量，跟随主题切换不需要手动维护。
	textarea.style.background = 'var(--widget-color)';
	textarea.style.color = 'var(--text-color)';
	textarea.style.border = '1px solid var(--widget-color)';
	textarea.style.borderRadius = 'var(--widget-border-radius, 2px)';
	textarea.style.padding = '0 var(--padding, 4px)';
	textarea.style.boxSizing = 'border-box';

	// 用 textarea 替换原 input。原 input 失去 parentNode 即从 DOM 摘出，
	// 它注册的 input/blur/keydown 监听器不会再被触发——这正是我们想要的，
	// 不然 Enter 会触发 blur → onFinishChange，用户没法换行。
	input.parentNode.replaceChild( textarea, input );

	// 同步 controller 的两个内部 DOM 引用到 textarea：updateDisplay() 会写
	// `$input.value = getValue()`，让 textarea 接住换行；$disable 控启用态。
	internal.$input = textarea as unknown as HTMLInputElement;
	internal.$disable = textarea;

	textarea.addEventListener( 'input', () => {
		// setValue 内部会调 updateDisplay() → textarea.value = newValue，幂等。
		controller.setValue( textarea.value );
	} );
	textarea.addEventListener( 'blur', () => {
		// 私有 _callOnFinishChange 触发外部 .onFinishChange 回调 → rebuild。
		if ( typeof internal._callOnFinishChange === 'function' ) {
			internal._callOnFinishChange.call( controller );
		}
	} );
}

type DemoPlotId =
	| 'rectangle'
	| 'polygon'
	| 'circle'
	| 'text'
	| 'pointCircle'
	| 'pointSquare'
	| 'polyline'
	| 'largeRectangle'
	| 'largePolygon'
	| 'largeCircle'
	| 'largeText'
	| 'largePointCircle'
	| 'largePointSquare'
	| 'largePolyline'
	| ArrowPlotId;

interface RectangleGuiModel {
	points: string;
}

interface PolygonGuiModel {
	points: string;
	holes: string;
}

/**
 * 将 WGS84 锚点周围的局部 ENU 米制偏移转换为 lon/lat 点。
 *
 * @param centerLongitude ENU 锚点经度，单位为度。
 * @param centerLatitude ENU 锚点纬度，单位为度。
 * @param offsets 局部 east/north 偏移，单位为米。
 * @returns 与 offsets 顺序一致的 WGS84 lon/lat 点。
 */
function lonLatPointsFromMeterOffsets(
	centerLongitude: number,
	centerLatitude: number,
	offsets: { eastMeters: number; northMeters: number }[],
): LonLatPoint[] {
	return longitudeLatitudeFromCenterOffsetsMeters(
		centerLongitude,
		centerLatitude,
		offsets,
	).map( point => [ point.longitude, point.latitude ] as LonLatPoint );
}

/**
 * 启动 Three 场景，并在每帧执行 Cesium-free 贴地管线。
 */
export function runGroundDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

	// 同步注入随包携带的 Cesium ApproximateTerrainHeights.json，使下面创建的
	// CesiumGroundRectanglePrimitive / CesiumGroundPolygonPrimitive 能拿到按瓦片
	// 对齐的 terrain min/max 高度窗口，这是必须保留的精度修复之一。
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
	// 启用 Cesium-ground 的不可拾取图层，让 shadow-volume mesh 和矩形调试面仍参与渲染。
	// 这些 mesh 已在 classification.ts / primitives.ts 中移出 layer 0，使默认 raycaster
	// 在 GlobeControls 的 adjustHeight / zoomPoint 计算中跳过它们；否则多公里高的
	// shadow volume 顶面或 5km 调试面会把相机高度错误地钉住。
	// Three.js 相机默认只启用 layer 0，因此这里显式启用不可拾取图层。
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );

	const target = wgs84PositionFromDegrees( RECTANGLE_CENTER_LON, RECTANGLE_CENTER_LAT, 0.0 );
	const up = wgs84NormalFromDegrees( RECTANGLE_CENTER_LON, RECTANGLE_CENTER_LAT );
	const eastBias = new Vector3( - up.y, up.x, 0.0 ).normalize();
	camera.position
		.copy( target )
		.addScaledVector( up, 720000.0 );
	camera.lookAt( target );
	camera.updateMatrixWorld();

	// 1:1 比例测试的相机预设:约 150 m 高度，并稍微向东偏移，
	// 让矩形 / 多边形 / 圆形和周围箭头在近景视锥内完整可见。
	// 由下面 GUI 的 "fly to plot" 按钮触发。
	const FLY_TO_ALTITUDE_METERS = 150.0;
	const FLY_TO_EAST_OFFSET_METERS = 40.0;

	/**
	 * 将相机吸附到矩形中心预设，避免用户从 720km 高度一路滚轮缩放到 10m 图元。
	 * `controls.update()` 会在下一帧运行，因此这里只需要写入 camera.position 和朝向；
	 * GlobeControls 会自动接收新状态，不需要显式 reset。
	 */
	function flyToPlot(): void {
		camera.position
			.copy( target )
			.addScaledVector( up, FLY_TO_ALTITUDE_METERS )
			.addScaledVector( eastBias, FLY_TO_EAST_OFFSET_METERS );
		camera.lookAt( target );
		camera.updateMatrixWorld();
	}

	const glbModelAnchor = new Group();
	glbModelAnchor.name = 'GroundDemoGlbAnchor';
	glbModelAnchor.matrixAutoUpdate = false;

	const glbModelRenderScene = new Scene();
	glbModelRenderScene.add( new AmbientLight( 0xffffff, 0.48 ) );
	const glbModelSun = new DirectionalLight( 0xffffff, 1.8 );
	glbModelSun.position.copy( sun.position );
	glbModelRenderScene.add( glbModelSun );
	glbModelRenderScene.add( glbModelAnchor );

	const glbModelLocalBounds = new Box3();
	const glbModelLocalSize = new Vector3();
	let glbModelScene: Object3D | null = null;
	let glbModelStatus = 'loading';
	let glbModelError = '';

	const glbModelGuiModel = {
		visible: true,
		flyToModel: () => flyToGlbModel(),
	};

	function updateGlbModelAnchorTransform(): void {
		const modelOrigin = wgs84PositionFromDegrees(
			DEMO_GLB_MODEL_LON,
			DEMO_GLB_MODEL_LAT,
			DEMO_GLB_MODEL_HEIGHT_METERS,
		);
		const enu = eastNorthUpToFixedFrame( modelOrigin, new Matrix4() );
		if ( DEMO_GLB_MODEL_HEADING_DEGREES !== 0.0 ) {
			enu.multiply( new Matrix4().makeRotationZ(
				DEMO_GLB_MODEL_HEADING_DEGREES * Math.PI / 180.0,
			) );
		}
		glbModelAnchor.matrix.copy( enu );
		glbModelAnchor.matrixWorldNeedsUpdate = true;
	}

	function flyToGlbModel(): void {
		const modelHeight = glbModelLocalSize.z > 0.0 ? glbModelLocalSize.z : 40.0;
		const focus = wgs84PositionFromDegrees(
			DEMO_GLB_MODEL_LON,
			DEMO_GLB_MODEL_LAT,
			DEMO_GLB_MODEL_HEIGHT_METERS + modelHeight * 0.35,
		);
		const modelUp = wgs84NormalFromDegrees( DEMO_GLB_MODEL_LON, DEMO_GLB_MODEL_LAT );
		const modelEast = new Vector3( - modelUp.y, modelUp.x, 0.0 ).normalize();
		const span = Math.max(
			glbModelLocalSize.x,
			glbModelLocalSize.y,
			glbModelLocalSize.z,
			80.0,
		);
		const distance = clampNumber( span * 1.8, 140.0, 2500.0 );

		camera.position
			.copy( focus )
			.addScaledVector( modelUp, distance )
			.addScaledVector( modelEast, distance * 0.28 );
		camera.lookAt( focus );
		camera.updateMatrixWorld();
	}

	function prepareGroundDemoGlbModel( modelScene: Object3D ): void {
		modelScene.name = modelScene.name || 'GroundDemoPublicGlbModel';
		configureLoadedTileScene( modelScene, { recolor: false } );
		// Cesium draws terrain classification before 3D Tiles / normal models.
		// Rendering this GLB after the ground commands lets the opaque model
		// cover terrain decals instead of letting decal stencil tests classify it.
		modelScene.traverse( object => {
			object.renderOrder = DEMO_GLB_MODEL_RENDER_ORDER;
		} );

		// GLB files are Y-up. The ground demo's local ENU frame uses Z-up.
		modelScene.rotation.x = Math.PI * 0.5;
		modelScene.scale.multiplyScalar( DEMO_GLB_MODEL_SCALE );
		modelScene.updateMatrixWorld( true );

		const initialBounds = new Box3().setFromObject( modelScene );
		if ( initialBounds.isEmpty() ) {
			glbModelLocalBounds.makeEmpty();
			glbModelLocalSize.set( 0.0, 0.0, 0.0 );
			return;
		}

		const initialCenter = initialBounds.getCenter( new Vector3() );
		modelScene.position.x -= initialCenter.x;
		modelScene.position.y -= initialCenter.y;
		modelScene.position.z -= initialBounds.min.z;
		modelScene.updateMatrixWorld( true );

		glbModelLocalBounds.copy( new Box3().setFromObject( modelScene ) );
		glbModelLocalBounds.getSize( glbModelLocalSize );
	}

	function loadGroundDemoGlbModel(): void {
		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath( DEMO_GLB_DRACO_DECODER_PATH );

		const gltfLoader = new GLTFLoader();
		gltfLoader.setDRACOLoader( dracoLoader );
		gltfLoader.load(
			DEMO_GLB_MODEL_URL,
			gltf => {
				const modelScene = gltf.scene;
				prepareGroundDemoGlbModel( modelScene );
				modelScene.visible = true;
				glbModelAnchor.visible = glbModelGuiModel.visible;
				glbModelAnchor.add( modelScene );
				glbModelScene = modelScene;
				glbModelStatus = 'loaded';
				dracoLoader.dispose();
			},
			event => {
				if ( event.lengthComputable && event.total > 0 ) {
					const progress = Math.round( event.loaded / event.total * 100.0 );
					glbModelStatus = `loading ${ progress }%`;
				}
			},
			error => {
				glbModelStatus = 'error';
				glbModelError =
					error instanceof ErrorEvent
						? error.message
						: error instanceof Error
							? error.message
							: String( error );
				console.error( '[ground-demo] Failed to load GLB model:', error );
				dracoLoader.dispose();
			},
		);
	}

	updateGlbModelAnchorTransform();
	loadGroundDemoGlbModel();

	const tilesRenderer = createCesiumTilesRenderer( renderer );
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
	controls.minDistance = 0.1;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	const globeDepth = new CesiumGlobeDepth(
		renderer.domElement.width,
		renderer.domElement.height,
	);

	// The material system deliberately has no private animation loop. The demo
	// owns one host Clock and forwards this single, coherent frame snapshot to
	// every ground primitive, so all materials observe identical time,
	// delta-time, viewport, camera, and globe-depth inputs during a frame.
	const hostClock = new Clock();
	let hostFrameNumber = 0;
	const hostFrameState = {
		depthTexture: globeDepth.target.texture,
		width: renderer.domElement.width,
		height: renderer.domElement.height,
		camera,
		timeSeconds: 0,
		deltaSeconds: 0,
		frameNumber: 0,
		pixelRatio: renderer.getPixelRatio(),
	};

	// 椭球面兜底深度：让贴地标绘与瓦片加载解耦。无此兜底时，相机下方一旦没有
	// 加载到瓦片(放大超过最深层级 / 瓦片仍在下载)，主深度缓冲与 packed 深度纹理
	// 在该区域都为空，stencil Z-fail 记不到值、CULL_FRAGMENTS 又读到空深度，标绘
	// 整体消失。加入 WGS84 椭球面后：
	//   - mainDepthMesh(renderOrder 5, depth-only) draws after tiles and before
	//     classification. Drawing it before tiles would occlude real terrain.
	//   - packedDepthMesh 注入 globeDepth 自有场景，给 packed 深度纹理兜底，供 color
	//     pass 重建 EC + CULL_FRAGMENTS。
	// 两者都在椭球面(海平面)高度，海平面场景下与真实地形几乎重合；高海拔山区若瓦片
	// 缺失，标绘会落到海平面高度(可后续用更细分段/抬升网格优化)。
	const { mainDepthMesh, packedDepthMesh } = createCesiumEllipsoidDepthMeshes();
	scene.add( mainDepthMesh );
	globeDepth.addDepthMesh( packedDepthMesh );

	const initialRectangleDegrees = {
		west: RECTANGLE_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES,
		south: RECTANGLE_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES,
		east: RECTANGLE_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES,
		north: RECTANGLE_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES,
	};
	const initialRectangleMeterSize = rectangleMeterSizeFromDegrees( initialRectangleDegrees );
	// 1:1 比例测试:圆半径固定为 5 m(直径 10 m)，不随矩形尺寸缩放，
	// 这样各自的尺寸滑块互不影响。
	const initialCircleRadiusMeters = 5.0;
	const initialRectanglePoints: LonLatPoint[] = [
		[ initialRectangleDegrees.west, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.south ],
		[ initialRectangleDegrees.east, initialRectangleDegrees.north ],
		[ initialRectangleDegrees.west, initialRectangleDegrees.north ],
	];
	// Polygon spawned offset east of the rectangle (POLYGON_OFFSET_*), so its
	// footprint does NOT overlap the rectangle. Isolation test: lets us
	// confirm whether overlapping primitive footprints contribute to the
	// curved-band fill cut.
	const POLYGON_CENTER_LON = RECTANGLE_CENTER_LON + POLYGON_OFFSET_LON;
	const POLYGON_CENTER_LAT = RECTANGLE_CENTER_LAT + POLYGON_OFFSET_LAT;
	const initialPolygonPoints: LonLatPoint[] = [
		[
			POLYGON_CENTER_LON,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.65,
		],
		[
			POLYGON_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.55,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.2,
		],
		[
			POLYGON_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.34,
			POLYGON_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.56,
		],
		[
			POLYGON_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.34,
			POLYGON_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.56,
		],
		[
			POLYGON_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.55,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.2,
		],
	];
	const initialPolygonHolePoints: LonLatPoint[] = [
		[
			POLYGON_CENTER_LON,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.18,
		],
		[
			POLYGON_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.18,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.06,
		],
		[
			POLYGON_CENTER_LON + RECTANGLE_HALF_WIDTH_DEGREES * 0.11,
			POLYGON_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.16,
		],
		[
			POLYGON_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.11,
			POLYGON_CENTER_LAT - RECTANGLE_HALF_HEIGHT_DEGREES * 0.16,
		],
		[
			POLYGON_CENTER_LON - RECTANGLE_HALF_WIDTH_DEGREES * 0.18,
			POLYGON_CENTER_LAT + RECTANGLE_HALF_HEIGHT_DEGREES * 0.06,
		],
	];
	const largePlotAnchors = lonLatPointsFromMeterOffsets(
		RECTANGLE_CENTER_LON,
		RECTANGLE_CENTER_LAT,
		[
			{ eastMeters: - 14000.0, northMeters: 11500.0 },
			{ eastMeters: 1000.0, northMeters: 14500.0 },
			{ eastMeters: 15000.0, northMeters: 11500.0 },
			// largeText：放在 large 系列下方 ~5 km，content 用 metersPerPixel
			// 较大时与 5 km 圆 / 矩形 / 多边形等量级。
			{ eastMeters: 0.0, northMeters: 4500.0 },
			// large points：放在 rectangle 中心南侧 ~3 km，与 large 系列 (北侧)
			// 和 1:1 系列 (中心附近) 都拉开距离；左右各一个，分别 circle / square。
			{ eastMeters: - 3500.0, northMeters: - 3000.0 },
			{ eastMeters: 3500.0, northMeters: - 3000.0 },
		],
	);
	const largeRectangleCenter = largePlotAnchors[ 0 ];
	const largePolygonCenter = largePlotAnchors[ 1 ];
	const largeCircleCenter = largePlotAnchors[ 2 ];
	const largeTextCenter = largePlotAnchors[ 3 ];
	const largePointCircleCenter = largePlotAnchors[ 4 ];
	const largePointSquareCenter = largePlotAnchors[ 5 ];
	const initialLargeRectangleWidthMeters = 10000.0;
	const initialLargeRectangleHeightMeters = 5000.0;
	const initialLargeRectanglePoints = lonLatPointsFromMeterOffsets(
		largeRectangleCenter[ 0 ],
		largeRectangleCenter[ 1 ],
		[
			{ eastMeters: - initialLargeRectangleWidthMeters * 0.5, northMeters: - initialLargeRectangleHeightMeters * 0.5 },
			{ eastMeters: initialLargeRectangleWidthMeters * 0.5, northMeters: - initialLargeRectangleHeightMeters * 0.5 },
			{ eastMeters: initialLargeRectangleWidthMeters * 0.5, northMeters: initialLargeRectangleHeightMeters * 0.5 },
			{ eastMeters: - initialLargeRectangleWidthMeters * 0.5, northMeters: initialLargeRectangleHeightMeters * 0.5 },
		],
	);
	const initialLargePolygonWidthMeters = 10000.0;
	const initialLargePolygonHeightMeters = 8000.0;
	const initialLargePolygonRotationDegrees = 14.0;
	const initialLargePolygonPoints = lonLatPointsFromMeterOffsets(
		largePolygonCenter[ 0 ],
		largePolygonCenter[ 1 ],
		createLocalPolygonOffsets(
			initialLargePolygonWidthMeters,
			initialLargePolygonHeightMeters,
			6,
			initialLargePolygonRotationDegrees,
		),
	);
	const initialLargeCircleRadiusMeters = 5000.0;

	// 折线 1:1：四个折点环绕矩形向北分布。
	const initialPolylinePoints: LonLatPoint[] = lonLatPointsFromMeterOffsets(
		RECTANGLE_CENTER_LON,
		RECTANGLE_CENTER_LAT,
		POLYLINE_VERTEX_OFFSETS,
	);
	// 大比例尺折线：横跨 large rectangle / circle / polygon 之间的 km 级 zig-zag。
	const initialLargePolylinePoints: LonLatPoint[] = lonLatPointsFromMeterOffsets(
		RECTANGLE_CENTER_LON,
		RECTANGLE_CENTER_LAT,
		[
			{ eastMeters: - 17000.0, northMeters: 4500.0 },
			{ eastMeters: - 9000.0, northMeters: 8000.0 },
			{ eastMeters: 0.0, northMeters: 6000.0 },
			{ eastMeters: 9000.0, northMeters: 8000.0 },
			{ eastMeters: 17000.0, northMeters: 4500.0 },
		],
	);

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
		strokeWidth: 1.0,
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
		polygonStrokeWidth: 1.0,
		polygonFillColor: '#00aaff',
		polygonFillOpacity: 68,
		polygonPoints: initialPolygonPoints,
		polygonHoles: [ initialPolygonHolePoints ],
		polygonRotationDegrees: 18.0,
		polygonHole: false,
		circleVisible: true,
		circlePlotOrder: 2,
		circleCenterLon: RECTANGLE_CENTER_LON + CIRCLE_OFFSET_LON,
		circleCenterLat: RECTANGLE_CENTER_LAT + CIRCLE_OFFSET_LAT,
		circleRadius: initialCircleRadiusMeters,
		circleHeight: 0.0,
		circleExtrudedHeight: 0.0,
		circleMinimumHeight: - CESIUM_GLOBE_MINIMUM_ALTITUDE,
		circleMaximumHeight: CESIUM_GLOBE_MINIMUM_ALTITUDE,
		circleGranularityRadians: Math.PI / 180.0,
		circleStRotationRadians: 0.0,
		circleRingCount: 3,
		circleRingGapMeters: initialCircleRadiusMeters * 0.55 / 4.1,
		circleSectorStartDegrees: 0.0,
		circleSectorAngleDegrees: 90.0,
		circleStrokeColor: '#ffffff',
		circleStrokeOpacity: 92,
		circleStrokeWidth: 1.0,
		circleFillColor: '#00ff88',
		circleFillOpacity: 64,
		// 点标绘默认：圆形点 + 正方形点各放一个，size 6 m 与其他 1:1 比例图元同量级。
		pointCircleVisible: true,
		pointCirclePlotOrder: 4,
		pointCircleCenterLon: RECTANGLE_CENTER_LON + POINT_CIRCLE_OFFSET_LON,
		pointCircleCenterLat: RECTANGLE_CENTER_LAT + POINT_CIRCLE_OFFSET_LAT,
		pointCircleShape: 'circle',
		pointCircleSize: 6.0,
		pointCircleStrokeColor: '#ffffff',
		pointCircleStrokeOpacity: 95,
		pointCircleStrokeWidth: 1.0,
		pointCircleFillColor: '#ffaa00',
		pointCircleFillOpacity: 80,
		pointSquareVisible: true,
		pointSquarePlotOrder: 5,
		pointSquareCenterLon: RECTANGLE_CENTER_LON + POINT_SQUARE_OFFSET_LON,
		pointSquareCenterLat: RECTANGLE_CENTER_LAT + POINT_SQUARE_OFFSET_LAT,
		pointSquareShape: 'square',
		pointSquareSize: 6.0,
		pointSquareStrokeColor: '#ffffff',
		pointSquareStrokeOpacity: 95,
		pointSquareStrokeWidth: 1.0,
		pointSquareFillColor: '#aa66ff',
		pointSquareFillOpacity: 80,
		largeRectangleVisible: true,
		largeRectanglePlotOrder: 8,
		largeRectangleStrokeColor: '#ffffff',
		largeRectangleStrokeOpacity: 92,
		largeRectangleStrokeWidth: 150.0,
		largeRectangleFillColor: '#ffcc00',
		largeRectangleFillOpacity: 48,
		largeRectanglePoints: initialLargeRectanglePoints,
		largeRectangleWidthMeters: initialLargeRectangleWidthMeters,
		largeRectangleHeightMeters: initialLargeRectangleHeightMeters,
		largePolygonVisible: true,
		largePolygonPlotOrder: 9,
		largePolygonStrokeColor: '#ffffff',
		largePolygonStrokeOpacity: 92,
		largePolygonStrokeWidth: 150.0,
		largePolygonFillColor: '#00ddff',
		largePolygonFillOpacity: 46,
		largePolygonPoints: initialLargePolygonPoints,
		largePolygonRotationDegrees: initialLargePolygonRotationDegrees,
		largeCircleVisible: true,
		largeCirclePlotOrder: 10,
		largeCircleCenterLon: largeCircleCenter[ 0 ],
		largeCircleCenterLat: largeCircleCenter[ 1 ],
		largeCircleRadius: initialLargeCircleRadiusMeters,
		largeCircleStrokeColor: '#ffffff',
		largeCircleStrokeOpacity: 92,
		largeCircleStrokeWidth: 150.0,
		largeCircleFillColor: '#66ff66',
		largeCircleFillOpacity: 42,
		// 大比例尺点：size 2 km 与 large 系列同量级，放在 rectangle 中心南侧
		// 两侧。circle / square 两种 shape 分别走圆形 / 矩形渲染路径。
		largePointCircleVisible: true,
		largePointCirclePlotOrder: 12,
		largePointCircleCenterLon: largePointCircleCenter[ 0 ],
		largePointCircleCenterLat: largePointCircleCenter[ 1 ],
		largePointCircleShape: 'circle',
		largePointCircleSize: 2000.0,
		largePointCircleStrokeColor: '#ffffff',
		largePointCircleStrokeOpacity: 92,
		largePointCircleStrokeWidth: 60.0,
		largePointCircleFillColor: '#ffaa00',
		largePointCircleFillOpacity: 55,
		largePointSquareVisible: true,
		largePointSquarePlotOrder: 13,
		largePointSquareCenterLon: largePointSquareCenter[ 0 ],
		largePointSquareCenterLat: largePointSquareCenter[ 1 ],
		largePointSquareShape: 'square',
		largePointSquareSize: 2000.0,
		largePointSquareStrokeColor: '#ffffff',
		largePointSquareStrokeOpacity: 92,
		largePointSquareStrokeWidth: 60.0,
		largePointSquareFillColor: '#aa66ff',
		largePointSquareFillOpacity: 55,
		// 折线 1:1：4 个折点的 zig-zag，~3 px 屏宽，screen 模式（缩放屏宽恒定）。
		polylineVisible: true,
		polylinePlotOrder: 6,
		polylinePoints: initialPolylinePoints,
		polylineStrokeColor: '#ff3030',
		polylineStrokeOpacity: 95,
		polylineWidthPixels: 3.0,
		polylineWidthMeters: 5.0,
		polylineWidthMode: 'screen',
		polylineArcType: 'geodesic',
		polylineLoop: false,
		polylineDashLengthMeters: 0.0,
		polylineGapLengthMeters: 0.0,
		polylineDebugVolume: false,
		// 默认终点端有箭头，方便看「箭头跟着线方向走」。
		polylineArrowMode: 'right',
		polylineArrowStyle: 'solid',
		polylineArrowWidthMode: 'world',
		polylineArrowLengthPixels: 18,
		polylineArrowWidthPixels: 16,
		// world 模式下匹配 widthMeters=5 的线粗，跟库默认 30/24 一致。
		polylineArrowLengthMeters: 30,
		polylineArrowWidthMeters: 24,
		// 折线大比例尺：5 段、~50 km 总长、screen 模式 3 px 屏宽（远视角不消失）。
		largePolylineVisible: true,
		largePolylinePlotOrder: 14,
		largePolylinePoints: initialLargePolylinePoints,
		largePolylineStrokeColor: '#ff66ff',
		largePolylineStrokeOpacity: 95,
		largePolylineWidthPixels: 3.0,
		largePolylineWidthMeters: 200.0,
		largePolylineWidthMode: 'screen',
		largePolylineArcType: 'geodesic',
		largePolylineLoop: false,
		largePolylineDashLengthMeters: 0.0,
		largePolylineGapLengthMeters: 0.0,
		largePolylineDebugVolume: false,
		// 大比例尺折线两端都加箭头展示。
		largePolylineArrowMode: 'both',
		largePolylineArrowStyle: 'solid',
		largePolylineArrowWidthMode: 'world',
		largePolylineArrowLengthPixels: 22,
		largePolylineArrowWidthPixels: 20,
		// world 模式下匹配 widthMeters=200 的线粗，~4:1 length / ~3:1 width
		// 比例让箭头与线视觉成比例（业务侧决定，库层不假设）。
		largePolylineArrowLengthMeters: 800,
		largePolylineArrowWidthMeters: 600,
		// 文字标绘 1:1：metersPerPixel=1.0 即「1 纹素 = 1 米」字面意义比例尺。
		// 默认 content 含 \n 演示横排换行；anchor 放在矩形正北 ~30 m。
		textVisible: true,
		textPlotOrder: 3,
		textCenterLon: RECTANGLE_CENTER_LON + TEXT_OFFSET_LON,
		textCenterLat: RECTANGLE_CENTER_LAT + TEXT_OFFSET_LAT,
		textContent: '1:1\n比例尺',
		textFontSize: 16,
		textMetersPerPixel: 1.0,
		textRotationDegrees: 0.0,
		textFontColor: '#ffffff',
		textFontStrokeColor: '#000000',
		textFontStrokeWidth: 2,
		textFillColor: '#ff5500',
		textFillOpacity: 70,
		textStrokeColor: '#ffffff',
		textStrokeOpacity: 100,
		textStrokeWidth: 1,
		textCornerRadius: 4,
		textTextAlign: 'center',
		textVerticalAlign: 'middle',
		textAnchorX: 'center',
		textAnchorY: 'middle',
		textLayoutDirection: 'horizontal',
		// 文字标绘 5 km：fontSize 64 + metersPerPixel 25 ≈ 5 km 宽度量级，
		// 与 largeCircle（5 km 半径）等量级，放在 large 系列中部下方。
		largeTextVisible: true,
		largeTextPlotOrder: 11,
		largeTextCenterLon: largeTextCenter[ 0 ],
		largeTextCenterLat: largeTextCenter[ 1 ],
		largeTextContent: '5 km\n大比例尺',
		largeTextFontSize: 64,
		largeTextMetersPerPixel: 25.0,
		largeTextRotationDegrees: 0.0,
		largeTextFontColor: '#ffffff',
		largeTextFontStrokeColor: '#000000',
		largeTextFontStrokeWidth: 6,
		largeTextFillColor: '#1f6feb',
		largeTextFillOpacity: 60,
		largeTextStrokeColor: '#ffffff',
		largeTextStrokeOpacity: 100,
		largeTextStrokeWidth: 4,
		largeTextCornerRadius: 24,
		largeTextTextAlign: 'center',
		largeTextVerticalAlign: 'middle',
		largeTextAnchorX: 'center',
		largeTextAnchorY: 'middle',
		largeTextLayoutDirection: 'horizontal',
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
	debugSettings.circlePlotOrder = plotOrderRegistry.register( 'circle', debugSettings.circlePlotOrder );
	debugSettings.textPlotOrder = plotOrderRegistry.register( 'text', debugSettings.textPlotOrder );
	debugSettings.pointCirclePlotOrder = plotOrderRegistry.register( 'pointCircle', debugSettings.pointCirclePlotOrder );
	debugSettings.pointSquarePlotOrder = plotOrderRegistry.register( 'pointSquare', debugSettings.pointSquarePlotOrder );
	debugSettings.largeRectanglePlotOrder = plotOrderRegistry.register( 'largeRectangle', debugSettings.largeRectanglePlotOrder );
	debugSettings.largePolygonPlotOrder = plotOrderRegistry.register( 'largePolygon', debugSettings.largePolygonPlotOrder );
	debugSettings.largeCirclePlotOrder = plotOrderRegistry.register( 'largeCircle', debugSettings.largeCirclePlotOrder );
	debugSettings.largeTextPlotOrder = plotOrderRegistry.register( 'largeText', debugSettings.largeTextPlotOrder );
	debugSettings.largePointCirclePlotOrder = plotOrderRegistry.register( 'largePointCircle', debugSettings.largePointCirclePlotOrder );
	debugSettings.largePointSquarePlotOrder = plotOrderRegistry.register( 'largePointSquare', debugSettings.largePointSquarePlotOrder );
	debugSettings.polylinePlotOrder = plotOrderRegistry.register( 'polyline', debugSettings.polylinePlotOrder );
	debugSettings.largePolylinePlotOrder = plotOrderRegistry.register( 'largePolyline', debugSettings.largePolylinePlotOrder );

	/**
	 * 返回从公开 points 字段推导出的当前填充矩形。
 *
	 * @returns WGS84 度制矩形。
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
	 * 把矩形点序列序列化到紧凑 GUI 文本字段。
 *
	 * @returns 包含四个 [lon, lat] 角点的 JSON 字符串。
	 */
	function stringifyRectanglePoints(): string {
		return JSON.stringify( debugSettings.points );
	}

	/**
	 * 把公开 points GUI 文本解析为四个 WGS84 lon/lat 点。
 *
	 * @param value lil-gui 中输入的 JSON 文本。
	 * @returns 校验后的 lon/lat 点。
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
	 * 把多边形点序列序列化到紧凑 GUI 文本字段。
 *
	 * @returns 包含 [lon, lat] 多边形顶点的 JSON 字符串。
	 */
	function stringifyPolygonPoints(): string {
		return JSON.stringify( debugSettings.polygonPoints );
	}

	/**
	 * 把多边形洞环序列化到紧凑 GUI 文本字段。
 *
	 * @returns 包含一个或多个洞环的 JSON 字符串。
	 */
	function stringifyPolygonHoles(): string {
		return JSON.stringify( debugSettings.polygonHoles );
	}

	/**
	 * 通过向内缩放当前多边形创建默认可编辑洞。
 *
	 * @param points WGS84 lon/lat 度制外环多边形顶点。
	 * @returns 位于当前多边形内部的较小环。
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
	 * 解析公开 polygon points GUI 文本。
 *
	 * @param value lil-gui 中输入的 JSON 文本。
	 * @returns 校验后的 lon/lat 多边形点。
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
	 * 从 GUI JSON 值解析一个多边形环。
 *
	 * @param parsed 表示环的未知 JSON 值。
	 * @param label 校验错误中使用的人类可读标签。
	 * @returns 校验后的 lon/lat 环。
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
	 * 解析公开 polygon holes GUI 文本。
 *
	 * @param value lil-gui 中输入的 JSON 文本。
	 * @returns 校验后的 WGS84 lon/lat 度制洞环。
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

		if ( target === 'circle' ) {
			debugSettings.circlePlotOrder = plotOrderRegistry.update(
				'circle',
				debugSettings.circlePlotOrder,
			);
			return;
		}

		if ( target === 'largeRectangle' ) {
			debugSettings.largeRectanglePlotOrder = plotOrderRegistry.update(
				'largeRectangle',
				debugSettings.largeRectanglePlotOrder,
			);
			return;
		}

		if ( target === 'largePolygon' ) {
			debugSettings.largePolygonPlotOrder = plotOrderRegistry.update(
				'largePolygon',
				debugSettings.largePolygonPlotOrder,
			);
			return;
		}

		if ( target === 'largeCircle' ) {
			debugSettings.largeCirclePlotOrder = plotOrderRegistry.update(
				'largeCircle',
				debugSettings.largeCirclePlotOrder,
			);
			return;
		}

		if ( target === 'text' ) {
			debugSettings.textPlotOrder = plotOrderRegistry.update(
				'text',
				debugSettings.textPlotOrder,
			);
			return;
		}

		if ( target === 'largeText' ) {
			debugSettings.largeTextPlotOrder = plotOrderRegistry.update(
				'largeText',
				debugSettings.largeTextPlotOrder,
			);
			return;
		}

		if ( target === 'pointCircle' ) {
			debugSettings.pointCirclePlotOrder = plotOrderRegistry.update(
				'pointCircle',
				debugSettings.pointCirclePlotOrder,
			);
			return;
		}

		if ( target === 'pointSquare' ) {
			debugSettings.pointSquarePlotOrder = plotOrderRegistry.update(
				'pointSquare',
				debugSettings.pointSquarePlotOrder,
			);
			return;
		}

		if ( target === 'largePointCircle' ) {
			debugSettings.largePointCirclePlotOrder = plotOrderRegistry.update(
				'largePointCircle',
				debugSettings.largePointCirclePlotOrder,
			);
			return;
		}

		if ( target === 'largePointSquare' ) {
			debugSettings.largePointSquarePlotOrder = plotOrderRegistry.update(
				'largePointSquare',
				debugSettings.largePointSquarePlotOrder,
			);
			return;
		}

		if ( target === 'polyline' ) {
			debugSettings.polylinePlotOrder = plotOrderRegistry.update(
				'polyline',
				debugSettings.polylinePlotOrder,
			);
			return;
		}

		if ( target === 'largePolyline' ) {
			debugSettings.largePolylinePlotOrder = plotOrderRegistry.update(
				'largePolyline',
				debugSettings.largePolylinePlotOrder,
			);
			return;
		}

		debugSettings.polygonPlotOrder = plotOrderRegistry.update(
			'polygon',
			debugSettings.polygonPlotOrder,
		);
	}

	/**
	 * Rebuilds the large rectangle's editable points from its meter size.
	 */
	function syncLargeRectanglePointsFromMeters(): void {
		debugSettings.largeRectangleWidthMeters = Number.isFinite( debugSettings.largeRectangleWidthMeters )
			? Math.max( debugSettings.largeRectangleWidthMeters, 100.0 )
			: initialLargeRectangleWidthMeters;
		debugSettings.largeRectangleHeightMeters = Number.isFinite( debugSettings.largeRectangleHeightMeters )
			? Math.max( debugSettings.largeRectangleHeightMeters, 100.0 )
			: initialLargeRectangleHeightMeters;
		debugSettings.largeRectanglePoints = lonLatPointsFromMeterOffsets(
			largeRectangleCenter[ 0 ],
			largeRectangleCenter[ 1 ],
			[
				{ eastMeters: - debugSettings.largeRectangleWidthMeters * 0.5, northMeters: - debugSettings.largeRectangleHeightMeters * 0.5 },
				{ eastMeters: debugSettings.largeRectangleWidthMeters * 0.5, northMeters: - debugSettings.largeRectangleHeightMeters * 0.5 },
				{ eastMeters: debugSettings.largeRectangleWidthMeters * 0.5, northMeters: debugSettings.largeRectangleHeightMeters * 0.5 },
				{ eastMeters: - debugSettings.largeRectangleWidthMeters * 0.5, northMeters: debugSettings.largeRectangleHeightMeters * 0.5 },
			],
		);
	}

	/**
	 * Rebuilds the large polygon's six-point meter footprint.
	 */
	function syncLargePolygonPointsFromMeters(): void {
		debugSettings.largePolygonRotationDegrees = Number.isFinite( debugSettings.largePolygonRotationDegrees )
			? debugSettings.largePolygonRotationDegrees
			: initialLargePolygonRotationDegrees;
		debugSettings.largePolygonPoints = lonLatPointsFromMeterOffsets(
			largePolygonCenter[ 0 ],
			largePolygonCenter[ 1 ],
			createLocalPolygonOffsets(
				initialLargePolygonWidthMeters,
				initialLargePolygonHeightMeters,
				6,
				debugSettings.largePolygonRotationDegrees,
			),
		);
	}

	/**
	 * 几何重建前归一化圆 GUI 值。它镜像参考项目的 clamp 规则,确保无论编辑哪个滑块,
	 * radius / heights / granularity 都保持在有效范围内。
	 */
	function normalizeCircleDebugSettings(): void {
		debugSettings.circleCenterLon = Number.isFinite( debugSettings.circleCenterLon )
			? clampNumber( debugSettings.circleCenterLon, - 180.0, 180.0 )
			: RECTANGLE_CENTER_LON;
		debugSettings.circleCenterLat = Number.isFinite( debugSettings.circleCenterLat )
			? clampNumber( debugSettings.circleCenterLat, - 90.0, 90.0 )
			: RECTANGLE_CENTER_LAT;
		debugSettings.circleRadius = Number.isFinite( debugSettings.circleRadius )
			? Math.max( debugSettings.circleRadius, 1.0 )
			: 1.0;
		debugSettings.circleHeight = Number.isFinite( debugSettings.circleHeight )
			? debugSettings.circleHeight
			: 0.0;
		debugSettings.circleExtrudedHeight = Number.isFinite( debugSettings.circleExtrudedHeight )
			? debugSettings.circleExtrudedHeight
			: debugSettings.circleHeight;
		debugSettings.circleMinimumHeight = Number.isFinite( debugSettings.circleMinimumHeight )
			? debugSettings.circleMinimumHeight
			: - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		debugSettings.circleMaximumHeight = Number.isFinite( debugSettings.circleMaximumHeight )
			? debugSettings.circleMaximumHeight
			: CESIUM_GLOBE_MINIMUM_ALTITUDE;
		if ( debugSettings.circleMaximumHeight <= debugSettings.circleMinimumHeight ) {
			debugSettings.circleMaximumHeight = debugSettings.circleMinimumHeight + 1.0;
		}
		debugSettings.circleGranularityRadians = Number.isFinite( debugSettings.circleGranularityRadians )
			? clampNumber(
				debugSettings.circleGranularityRadians,
				MIN_CIRCLE_GRANULARITY_RADIANS,
				MAX_CIRCLE_GRANULARITY_RADIANS,
			)
			: Math.PI / 180.0;
		debugSettings.circleStRotationRadians = Number.isFinite( debugSettings.circleStRotationRadians )
			? debugSettings.circleStRotationRadians
			: 0.0;
		debugSettings.circleRingCount = Number.isFinite( debugSettings.circleRingCount )
			? clampNumber( Math.floor( debugSettings.circleRingCount ), 1.0, 12.0 )
			: 1.0;
		debugSettings.circleRingGapMeters = Number.isFinite( debugSettings.circleRingGapMeters )
			? clampNumber( debugSettings.circleRingGapMeters, 0.0, debugSettings.circleRadius )
			: 0.0;
		debugSettings.circleSectorStartDegrees = Number.isFinite( debugSettings.circleSectorStartDegrees )
			? clampNumber( debugSettings.circleSectorStartDegrees, - 360.0, 360.0 )
			: 0.0;
		debugSettings.circleSectorAngleDegrees = Number.isFinite( debugSettings.circleSectorAngleDegrees )
			? clampNumber( debugSettings.circleSectorAngleDegrees, - 360.0, 360.0 )
			: 360.0;
	}

	/**
	 * 几何重建前归一化多边形 GUI 值。
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
	 * 根据当前 GUI 设置创建阴影体矩形。
 *
	 * @returns 已接入 classification 与调试路径的贴地矩形图元。
	 */
	// -------------------------------------------------------------------------
	// Stage 13 Material showcase. These logical objects are created once and
	// reused whenever GUI geometry rebuilds occur; compiled pass materials remain
	// primitive-owned, while uniform values stay shared and update in place.
	// -------------------------------------------------------------------------
	const flowLineMaterial = createFlowLineMaterial( {
		color: '#39d9ff',
		backgroundColor: new Vector4( 0.02, 0.04, 0.08, 0.18 ),
		speed: 0.65,
		repeat: 4.0,
		trailFraction: 0.32,
		direction: 1,
	} );
	const flowLineAppearance = new CesiumGroundMaterialAppearance( {
		material: flowLineMaterial,
	} );

	const PULSE_POINT_FOOTPRINT_SCALE = 1.25;
	const SCALE_PULSE_FOOTPRINT_SCALE = 1.3;
	const pulsePointMaterial = createPulsePointMaterial( {
		color: '#ff5533',
		periodSeconds: 1.8,
		minScale: 0.55,
		maxScale: PULSE_POINT_FOOTPRINT_SCALE,
		minOpacity: 0.2,
		maxOpacity: 0.95,
		phase: 0.0,
	} );
	const pulsePointAppearance = new CesiumGroundMaterialAppearance( {
		material: pulsePointMaterial,
	} );

	const scalePulseMaterial = createScalePulseMaterial( {
		tint: '#66aaff',
		opacity: 0.9,
		periodSeconds: 1.6,
		minScale: 0.78,
		maxScale: SCALE_PULSE_FOOTPRINT_SCALE,
		phase: 0.25,
	} );
	const scalePulseAppearance = new CesiumGroundMaterialAppearance( {
		material: scalePulseMaterial,
	} );

	const customMaterial = new CesiumGroundMaterial( {
		type: 'GroundDemoTimeGradient',
		uniforms: {
			u_hot: { value: new Color( '#ff3d00' ) },
			u_cold: { value: new Color( '#17345f' ) },
			u_frequency: { value: 1.5 },
		},
		fragmentShader: /* glsl */ `
uniform vec3 u_hot;
uniform vec3 u_cold;
uniform float u_frequency;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	float wave = 0.5 + 0.5 * sin(
		6.28318530718 * (c23_time * u_frequency + materialInput.st.x)
	);
	c23_material material;
	material.diffuse = mix(u_cold, u_hot, wave);
	material.emission = vec3(0.0);
	material.alpha = materialInput.baseColor.a;
	return material;
}
`,
	} );
	const customAppearance = new CesiumGroundMaterialAppearance( { material: customMaterial } );

	const completeRawAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			// Returning the context-owned default once per pass preserves all fixed
			// vertex/stencil/depth state while proving front/back/color dispatch.
			const material = context.createDefaultMaterial();
			material.name = `GroundDemoRaw/${ context.primitiveKind }/${ context.pass }`;
			material.userData.groundDemoRawPass = context.pass;
			return material;
		},
	} );

	const effectSettings = {
		animate: true,
		timeScale: 1.0,
		flowSpeed: 0.65,
		pulsePhase: 0.0,
		scalePhase: 0.25,
		customFrequency: 1.5,
	};

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
			appearance: completeRawAppearance,
		} );
	}

	/**
	 * 根据当前 GUI 设置创建阴影体圆。
 *
	 * @returns 使用原生阴影体构建器的贴地圆图元。
	 */
	function createGroundCircle(): CesiumGroundCirclePrimitive {
		normalizeCircleDebugSettings();

		return new CesiumGroundCirclePrimitive( {
			center: [ debugSettings.circleCenterLon, debugSettings.circleCenterLat ],
			radius: debugSettings.circleRadius,
			strokeColor: debugSettings.circleStrokeColor,
			strokeWidth: debugSettings.circleStrokeWidth,
			strokeOpacity: debugSettings.circleStrokeOpacity,
			fillColor: debugSettings.circleFillColor,
			fillOpacity: debugSettings.circleFillOpacity,
			visible: debugSettings.circleVisible,
			height: debugSettings.circleHeight,
			extrudedHeight: debugSettings.circleExtrudedHeight,
			granularityRadians: debugSettings.circleGranularityRadians,
			stRotationRadians: debugSettings.circleStRotationRadians,
			ringCount: debugSettings.circleRingCount,
			ringGapMeters: debugSettings.circleRingGapMeters,
			sectorStartDegrees: debugSettings.circleSectorStartDegrees,
			sectorAngleDegrees: debugSettings.circleSectorAngleDegrees,
			minimumHeight: debugSettings.circleMinimumHeight,
			maximumHeight: debugSettings.circleMaximumHeight,
			renderOrder: plotOrderToRenderOrder( debugSettings.circlePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 根据当前 GUI 设置创建阴影体多边形。
 *
	 * @returns 使用原生阴影体构建器的贴地多边形图元。
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
			appearance: customAppearance,
		} );
	}

	/**
	 * 创建大尺度矩形伴随图元。
 *
	 * @returns 跨度为公里级而非米级的贴地矩形。
	 */
	function createLargeGroundRectangle(): CesiumGroundRectanglePrimitive {
		syncLargeRectanglePointsFromMeters();

		return new CesiumGroundRectanglePrimitive( {
			points: debugSettings.largeRectanglePoints,
			strokeColor: debugSettings.largeRectangleStrokeColor,
			strokeWidth: debugSettings.largeRectangleStrokeWidth,
			strokeOpacity: debugSettings.largeRectangleStrokeOpacity,
			fillColor: debugSettings.largeRectangleFillColor,
			fillOpacity: debugSettings.largeRectangleFillOpacity,
			visible: debugSettings.largeRectangleVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.largeRectanglePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 创建大尺度多边形伴随图元。
 *
	 * @returns 跨度为公里级而非米级的贴地多边形。
	 */
	function createLargeGroundPolygon(): CesiumGroundPolygonPrimitive {
		syncLargePolygonPointsFromMeters();

		return new CesiumGroundPolygonPrimitive( {
			points: debugSettings.largePolygonPoints,
			strokeColor: debugSettings.largePolygonStrokeColor,
			strokeWidth: debugSettings.largePolygonStrokeWidth,
			strokeOpacity: debugSettings.largePolygonStrokeOpacity,
			fillColor: debugSettings.largePolygonFillColor,
			fillOpacity: debugSettings.largePolygonFillOpacity,
			visible: debugSettings.largePolygonVisible,
			rotationDegrees: 0.0,
			renderOrder: plotOrderToRenderOrder( debugSettings.largePolygonPlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 创建大尺度圆伴随图元。
 *
	 * @returns 默认半径为 5 km 的贴地圆。
	 */
	function createLargeGroundCircle(): CesiumGroundCirclePrimitive {
		debugSettings.largeCircleRadius = Number.isFinite( debugSettings.largeCircleRadius )
			? Math.max( debugSettings.largeCircleRadius, 100.0 )
			: initialLargeCircleRadiusMeters;

		return new CesiumGroundCirclePrimitive( {
			center: [ debugSettings.largeCircleCenterLon, debugSettings.largeCircleCenterLat ],
			radius: debugSettings.largeCircleRadius,
			strokeColor: debugSettings.largeCircleStrokeColor,
			strokeWidth: debugSettings.largeCircleStrokeWidth,
			strokeOpacity: debugSettings.largeCircleStrokeOpacity,
			fillColor: debugSettings.largeCircleFillColor,
			fillOpacity: debugSettings.largeCircleFillOpacity,
			visible: debugSettings.largeCircleVisible,
			height: 0.0,
			extrudedHeight: 0.0,
			granularityRadians: Math.PI / 180.0 / 8.0,
			stRotationRadians: 0.0,
			ringCount: 3,
			ringGapMeters: debugSettings.largeCircleRadius * 0.55 / 4.1,
			sectorStartDegrees: 0.0,
			sectorAngleDegrees: 360.0,
			minimumHeight: - CESIUM_GLOBE_MINIMUM_ALTITUDE,
			maximumHeight: CESIUM_GLOBE_MINIMUM_ALTITUDE,
			renderOrder: plotOrderToRenderOrder( debugSettings.largeCirclePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 创建 1:1 比例尺文字标绘。anchor 用 textCenterLon/Lat（已带矩形上方偏移），
	 * metersPerPixel=1.0 时纹素 px 与地面米直接对应——这是「1:1 比例尺」的字面
	 * 意义：canvas 上 1 像素 = 地面 1 米。fontSize 决定纹理清晰度（更高 → 纹理更
	 * 大但视觉同样大小，因为足迹尺寸由 boxWidth × MPP 推得，而 boxWidth 又随
	 * fontSize 增大）。
	 *
	 * @returns 配置好的贴地文字图元。
	 */
	function createGroundText(): CesiumGroundTextPrimitive {
		return new CesiumGroundTextPrimitive( {
			points: [ [ debugSettings.textCenterLon, debugSettings.textCenterLat ] ],
			content: debugSettings.textContent,
			fontSize: debugSettings.textFontSize,
			fontFamily: 'sans-serif',
			fontWeight: 'bold',
			fontColor: debugSettings.textFontColor,
			fontStrokeColor: debugSettings.textFontStrokeColor,
			fontStrokeWidth: debugSettings.textFontStrokeWidth,
			fillColor: debugSettings.textFillColor,
			fillOpacity: debugSettings.textFillOpacity,
			strokeColor: debugSettings.textStrokeColor,
			strokeOpacity: debugSettings.textStrokeOpacity,
			strokeWidth: debugSettings.textStrokeWidth,
			cornerRadius: debugSettings.textCornerRadius,
			padding: 4,
			textAlign: debugSettings.textTextAlign,
			verticalAlign: debugSettings.textVerticalAlign,
			layoutDirection: debugSettings.textLayoutDirection,
			metersPerPixel: debugSettings.textMetersPerPixel,
			anchorX: debugSettings.textAnchorX,
			anchorY: debugSettings.textAnchorY,
			rotation: debugSettings.textRotationDegrees,
			visible: debugSettings.textVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.textPlotOrder ),
		} );
	}

	/**
	 * 创建 5 km 大比例尺文字标绘。fontSize 64 + metersPerPixel 25 时单字符约
	 * 1.6 km，"5 km" 三字符 + padding 总宽 ~5 km，匹配 5 km 圆 / 矩形规模。
	 *
	 * @returns 配置好的贴地文字图元。
	 */
	function createLargeGroundText(): CesiumGroundTextPrimitive {
		return new CesiumGroundTextPrimitive( {
			points: [ [ debugSettings.largeTextCenterLon, debugSettings.largeTextCenterLat ] ],
			content: debugSettings.largeTextContent,
			fontSize: debugSettings.largeTextFontSize,
			fontFamily: 'sans-serif',
			fontWeight: 'bold',
			fontColor: debugSettings.largeTextFontColor,
			fontStrokeColor: debugSettings.largeTextFontStrokeColor,
			fontStrokeWidth: debugSettings.largeTextFontStrokeWidth,
			fillColor: debugSettings.largeTextFillColor,
			fillOpacity: debugSettings.largeTextFillOpacity,
			strokeColor: debugSettings.largeTextStrokeColor,
			strokeOpacity: debugSettings.largeTextStrokeOpacity,
			strokeWidth: debugSettings.largeTextStrokeWidth,
			cornerRadius: debugSettings.largeTextCornerRadius,
			padding: [ 16, 28, 16, 28 ],
			textAlign: debugSettings.largeTextTextAlign,
			verticalAlign: debugSettings.largeTextVerticalAlign,
			layoutDirection: debugSettings.largeTextLayoutDirection,
			metersPerPixel: debugSettings.largeTextMetersPerPixel,
			anchorX: debugSettings.largeTextAnchorX,
			anchorY: debugSettings.largeTextAnchorY,
			rotation: debugSettings.largeTextRotationDegrees,
			visible: debugSettings.largeTextVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.largeTextPlotOrder ),
		} );
	}

	/**
	 * 创建圆形点：shape='circle' → 走 CesiumGroundCirclePrimitive。
	 */
	function createGroundPointCircle(): CesiumGroundPointPrimitive {
		return new CesiumGroundPointPrimitive( {
			position: [ debugSettings.pointCircleCenterLon, debugSettings.pointCircleCenterLat ],
			shape: debugSettings.pointCircleShape,
			size: debugSettings.pointCircleSize * PULSE_POINT_FOOTPRINT_SCALE,
			strokeColor: debugSettings.pointCircleStrokeColor,
			strokeWidth: debugSettings.pointCircleStrokeWidth,
			strokeOpacity: debugSettings.pointCircleStrokeOpacity,
			fillColor: debugSettings.pointCircleFillColor,
			fillOpacity: debugSettings.pointCircleFillOpacity,
			visible: debugSettings.pointCircleVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.pointCirclePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
			appearance: pulsePointAppearance,
		} );
	}

	/**
	 * 创建正方形点：shape='square' → 走 CesiumGroundRectanglePrimitive。
	 */
	function createGroundPointSquare(): CesiumGroundPointPrimitive {
		return new CesiumGroundPointPrimitive( {
			position: [ debugSettings.pointSquareCenterLon, debugSettings.pointSquareCenterLat ],
			shape: debugSettings.pointSquareShape,
			size: debugSettings.pointSquareSize * SCALE_PULSE_FOOTPRINT_SCALE,
			strokeColor: debugSettings.pointSquareStrokeColor,
			strokeWidth: debugSettings.pointSquareStrokeWidth,
			strokeOpacity: debugSettings.pointSquareStrokeOpacity,
			fillColor: debugSettings.pointSquareFillColor,
			fillOpacity: debugSettings.pointSquareFillOpacity,
			visible: debugSettings.pointSquareVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.pointSquarePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
			appearance: scalePulseAppearance,
		} );
	}

	/**
	 * 创建大比例尺圆形点。
	 */
	function createLargeGroundPointCircle(): CesiumGroundPointPrimitive {
		return new CesiumGroundPointPrimitive( {
			position: [
				debugSettings.largePointCircleCenterLon,
				debugSettings.largePointCircleCenterLat,
			],
			shape: debugSettings.largePointCircleShape,
			size: debugSettings.largePointCircleSize,
			strokeColor: debugSettings.largePointCircleStrokeColor,
			strokeWidth: debugSettings.largePointCircleStrokeWidth,
			strokeOpacity: debugSettings.largePointCircleStrokeOpacity,
			fillColor: debugSettings.largePointCircleFillColor,
			fillOpacity: debugSettings.largePointCircleFillOpacity,
			visible: debugSettings.largePointCircleVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.largePointCirclePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 创建大比例尺正方形点。
	 */
	function createLargeGroundPointSquare(): CesiumGroundPointPrimitive {
		return new CesiumGroundPointPrimitive( {
			position: [
				debugSettings.largePointSquareCenterLon,
				debugSettings.largePointSquareCenterLat,
			],
			shape: debugSettings.largePointSquareShape,
			size: debugSettings.largePointSquareSize,
			strokeColor: debugSettings.largePointSquareStrokeColor,
			strokeWidth: debugSettings.largePointSquareStrokeWidth,
			strokeOpacity: debugSettings.largePointSquareStrokeOpacity,
			fillColor: debugSettings.largePointSquareFillColor,
			fillOpacity: debugSettings.largePointSquareFillOpacity,
			visible: debugSettings.largePointSquareVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.largePointSquarePlotOrder ),
			fragmentCull: debugSettings.fragmentCull,
		} );
	}

	/**
	 * 折线 1:1：~3 px 屏宽（缩放屏宽恒定），geodesic 拐角斜接。
	 */
	function createGroundPolyline(): CesiumGroundPolylinePrimitive {
		return new CesiumGroundPolylinePrimitive( {
			points: debugSettings.polylinePoints,
			strokeColor: debugSettings.polylineStrokeColor,
			strokeOpacity: debugSettings.polylineStrokeOpacity,
			widthPixels: debugSettings.polylineWidthPixels,
			widthMeters: debugSettings.polylineWidthMeters,
			widthMode: debugSettings.polylineWidthMode,
			arcType: debugSettings.polylineArcType,
			loop: debugSettings.polylineLoop,
			visible: debugSettings.polylineVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.polylinePlotOrder ),
			dashLengthMeters: debugSettings.polylineDashLengthMeters,
			gapLengthMeters: debugSettings.polylineGapLengthMeters,
			granularityRadians: LINE_DEFAULT_GRANULARITY,
			debugVolume: debugSettings.polylineDebugVolume,
			arrowMode: debugSettings.polylineArrowMode,
			arrowStyle: debugSettings.polylineArrowStyle,
			arrowWidthMode: debugSettings.polylineArrowWidthMode,
			arrowLengthPixels: debugSettings.polylineArrowLengthPixels,
			arrowWidthPixels: debugSettings.polylineArrowWidthPixels,
			arrowLengthMeters: debugSettings.polylineArrowLengthMeters,
			arrowWidthMeters: debugSettings.polylineArrowWidthMeters,
			appearance: flowLineAppearance,
		} );
	}

	/**
	 * 折线大比例尺：km 长度 + 3 px 屏宽，几何加密 + Vincenty 大地线在远视角也保持平滑。
	 */
	function createLargeGroundPolyline(): CesiumGroundPolylinePrimitive {
		return new CesiumGroundPolylinePrimitive( {
			points: debugSettings.largePolylinePoints,
			strokeColor: debugSettings.largePolylineStrokeColor,
			strokeOpacity: debugSettings.largePolylineStrokeOpacity,
			widthPixels: debugSettings.largePolylineWidthPixels,
			widthMeters: debugSettings.largePolylineWidthMeters,
			widthMode: debugSettings.largePolylineWidthMode,
			arcType: debugSettings.largePolylineArcType,
			loop: debugSettings.largePolylineLoop,
			visible: debugSettings.largePolylineVisible,
			renderOrder: plotOrderToRenderOrder( debugSettings.largePolylinePlotOrder ),
			dashLengthMeters: debugSettings.largePolylineDashLengthMeters,
			gapLengthMeters: debugSettings.largePolylineGapLengthMeters,
			granularityRadians: LINE_DEFAULT_GRANULARITY,
			debugVolume: debugSettings.largePolylineDebugVolume,
			arrowMode: debugSettings.largePolylineArrowMode,
			arrowStyle: debugSettings.largePolylineArrowStyle,
			arrowWidthMode: debugSettings.largePolylineArrowWidthMode,
			arrowLengthPixels: debugSettings.largePolylineArrowLengthPixels,
			arrowWidthPixels: debugSettings.largePolylineArrowWidthPixels,
			arrowLengthMeters: debugSettings.largePolylineArrowLengthMeters,
			arrowWidthMeters: debugSettings.largePolylineArrowWidthMeters,
		} );
	}

	let groundRectangle = createGroundRectangle();
	let groundPolygon = createGroundPolygon();
	let groundCircle = createGroundCircle();
	let groundText = createGroundText();
	let groundPointCircle = createGroundPointCircle();
	let groundPointSquare = createGroundPointSquare();
	let largeGroundRectangle = createLargeGroundRectangle();
	let largeGroundPolygon = createLargeGroundPolygon();
	let largeGroundCircle = createLargeGroundCircle();
	let largeGroundText = createLargeGroundText();
	let largeGroundPointCircle = createLargeGroundPointCircle();
	let largeGroundPointSquare = createLargeGroundPointSquare();
	let groundPolyline = createGroundPolyline();
	let largeGroundPolyline = createLargeGroundPolyline();
	scene.add( groundRectangle.classification.group );
	scene.add( groundPolygon.classification.group );
	scene.add( groundCircle.classification.group );
	scene.add( groundText.group );
	scene.add( groundPointCircle.classification.group );
	scene.add( groundPointSquare.classification.group );
	scene.add( largeGroundRectangle.classification.group );
	scene.add( largeGroundPolygon.classification.group );
	scene.add( largeGroundCircle.classification.group );
	scene.add( largeGroundText.group );
	scene.add( largeGroundPointCircle.classification.group );
	scene.add( largeGroundPointSquare.classification.group );
	scene.add( groundPolyline.group );
	scene.add( largeGroundPolyline.group );

	// Lazily set after createGroundDebugGui() so we can attach to its GUI root.
	// Forwarded settings (fragmentCull + pass visibility) are applied via the
	// ArrowSubsystem's public hooks from applyGroundDebugSettings() below.
	let arrowSubsystem: ArrowSubsystem | null = null;

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

		groundCircle.classification.setColor(
			new Color( debugSettings.circleFillColor ),
			debugSettings.circleFillOpacity / 100.0,
		);
		groundCircle.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundCircle.setRenderOrder( plotOrderToRenderOrder( debugSettings.circlePlotOrder ) );
		groundCircle.classification.group.visible = debugSettings.circleVisible;
		groundCircle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundCircle.classification.setBorderStyle(
			debugSettings.circleStrokeWidth > 0.0,
			new Color( debugSettings.circleStrokeColor ),
			debugSettings.circleStrokeOpacity / 100.0,
			debugSettings.circleStrokeWidth,
		);

		largeGroundRectangle.classification.setColor(
			new Color( debugSettings.largeRectangleFillColor ),
			debugSettings.largeRectangleFillOpacity / 100.0,
		);
		largeGroundRectangle.classification.setFragmentCulling( debugSettings.fragmentCull );
		largeGroundRectangle.setRenderOrder( plotOrderToRenderOrder( debugSettings.largeRectanglePlotOrder ) );
		largeGroundRectangle.classification.group.visible = debugSettings.largeRectangleVisible;
		largeGroundRectangle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		largeGroundRectangle.classification.setBorderStyle(
			debugSettings.largeRectangleStrokeWidth > 0.0,
			new Color( debugSettings.largeRectangleStrokeColor ),
			debugSettings.largeRectangleStrokeOpacity / 100.0,
			debugSettings.largeRectangleStrokeWidth,
		);

		largeGroundPolygon.classification.setColor(
			new Color( debugSettings.largePolygonFillColor ),
			debugSettings.largePolygonFillOpacity / 100.0,
		);
		largeGroundPolygon.classification.setFragmentCulling( debugSettings.fragmentCull );
		largeGroundPolygon.setRenderOrder( plotOrderToRenderOrder( debugSettings.largePolygonPlotOrder ) );
		largeGroundPolygon.classification.group.visible = debugSettings.largePolygonVisible;
		largeGroundPolygon.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		largeGroundPolygon.classification.setBorderStyle(
			debugSettings.largePolygonStrokeWidth > 0.0,
			new Color( debugSettings.largePolygonStrokeColor ),
			debugSettings.largePolygonStrokeOpacity / 100.0,
			debugSettings.largePolygonStrokeWidth,
		);

		largeGroundCircle.classification.setColor(
			new Color( debugSettings.largeCircleFillColor ),
			debugSettings.largeCircleFillOpacity / 100.0,
		);
		largeGroundCircle.classification.setFragmentCulling( debugSettings.fragmentCull );
		largeGroundCircle.setRenderOrder( plotOrderToRenderOrder( debugSettings.largeCirclePlotOrder ) );
		largeGroundCircle.classification.group.visible = debugSettings.largeCircleVisible;
		largeGroundCircle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		largeGroundCircle.classification.setBorderStyle(
			debugSettings.largeCircleStrokeWidth > 0.0,
			new Color( debugSettings.largeCircleStrokeColor ),
			debugSettings.largeCircleStrokeOpacity / 100.0,
			debugSettings.largeCircleStrokeWidth,
		);

		// 文字标绘：颜色 / 描边写在纹理里，所以这里只调整 visible / renderOrder
		// + 三命令显隐（与 rectangle 等保持一致）。纹理重绘走 rebuild 路径。
		groundText.setVisible( debugSettings.textVisible );
		groundText.setRenderOrder( plotOrderToRenderOrder( debugSettings.textPlotOrder ) );
		groundText.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );

		largeGroundText.setVisible( debugSettings.largeTextVisible );
		largeGroundText.setRenderOrder( plotOrderToRenderOrder( debugSettings.largeTextPlotOrder ) );
		largeGroundText.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );

		// 点标绘：颜色 / 描边可在不重建几何的前提下热更新（与圆 / 矩形同路径）。
		// position / shape / size 变化要走 rebuild 路径（重建底层 circle/rectangle 几何）。
		groundPointCircle.classification.setColor(
			new Color( debugSettings.pointCircleFillColor ),
			debugSettings.pointCircleFillOpacity / 100.0,
		);
		groundPointCircle.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundPointCircle.setRenderOrder( plotOrderToRenderOrder( debugSettings.pointCirclePlotOrder ) );
		groundPointCircle.classification.group.visible = debugSettings.pointCircleVisible;
		groundPointCircle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundPointCircle.classification.setBorderStyle(
			debugSettings.pointCircleStrokeWidth > 0.0,
			new Color( debugSettings.pointCircleStrokeColor ),
			debugSettings.pointCircleStrokeOpacity / 100.0,
			debugSettings.pointCircleStrokeWidth,
		);

		groundPointSquare.classification.setColor(
			new Color( debugSettings.pointSquareFillColor ),
			debugSettings.pointSquareFillOpacity / 100.0,
		);
		groundPointSquare.classification.setFragmentCulling( debugSettings.fragmentCull );
		groundPointSquare.setRenderOrder( plotOrderToRenderOrder( debugSettings.pointSquarePlotOrder ) );
		groundPointSquare.classification.group.visible = debugSettings.pointSquareVisible;
		groundPointSquare.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		groundPointSquare.classification.setBorderStyle(
			debugSettings.pointSquareStrokeWidth > 0.0,
			new Color( debugSettings.pointSquareStrokeColor ),
			debugSettings.pointSquareStrokeOpacity / 100.0,
			debugSettings.pointSquareStrokeWidth,
		);

		largeGroundPointCircle.classification.setColor(
			new Color( debugSettings.largePointCircleFillColor ),
			debugSettings.largePointCircleFillOpacity / 100.0,
		);
		largeGroundPointCircle.classification.setFragmentCulling( debugSettings.fragmentCull );
		largeGroundPointCircle.setRenderOrder( plotOrderToRenderOrder( debugSettings.largePointCirclePlotOrder ) );
		largeGroundPointCircle.classification.group.visible = debugSettings.largePointCircleVisible;
		largeGroundPointCircle.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		largeGroundPointCircle.classification.setBorderStyle(
			debugSettings.largePointCircleStrokeWidth > 0.0,
			new Color( debugSettings.largePointCircleStrokeColor ),
			debugSettings.largePointCircleStrokeOpacity / 100.0,
			debugSettings.largePointCircleStrokeWidth,
		);

		largeGroundPointSquare.classification.setColor(
			new Color( debugSettings.largePointSquareFillColor ),
			debugSettings.largePointSquareFillOpacity / 100.0,
		);
		largeGroundPointSquare.classification.setFragmentCulling( debugSettings.fragmentCull );
		largeGroundPointSquare.setRenderOrder( plotOrderToRenderOrder( debugSettings.largePointSquarePlotOrder ) );
		largeGroundPointSquare.classification.group.visible = debugSettings.largePointSquareVisible;
		largeGroundPointSquare.classification.setCommandVisibility( {
			frontStencil: debugSettings.showFrontStencil,
			backStencil: debugSettings.showBackStencil,
			color: debugSettings.showColorPass,
		} );
		largeGroundPointSquare.classification.setBorderStyle(
			debugSettings.largePointSquareStrokeWidth > 0.0,
			new Color( debugSettings.largePointSquareStrokeColor ),
			debugSettings.largePointSquareStrokeOpacity / 100.0,
			debugSettings.largePointSquareStrokeWidth,
		);

		// ── 折线 1:1 ── 颜色 / 宽度三件 / 可见性 / renderOrder，不重建几何。
		//    用 `applyWidthState` 一次性刷 widthMode + 两个宽度 uniform，
		//    避免 setWidth 单参数版用 stale `this.options.widthMode` 写错
		//    uniform 导致「切回原 mode 也回不去」。点位 / arcType / loop /
		//    dash 才走 rebuildGroundPolyline。
		groundPolyline.setColor( debugSettings.polylineStrokeColor, debugSettings.polylineStrokeOpacity );
		groundPolyline.applyWidthState(
			debugSettings.polylineWidthMode,
			debugSettings.polylineWidthPixels,
			debugSettings.polylineWidthMeters,
		);
		groundPolyline.setRenderOrder( plotOrderToRenderOrder( debugSettings.polylinePlotOrder ) );
		groundPolyline.setVisible( debugSettings.polylineVisible );
		// 箭头尺寸（屏宽像素 + 世界米）可热改不重建；mode / style 走 GUI rebuild。
		groundPolyline.setArrowSize(
			debugSettings.polylineArrowLengthPixels,
			debugSettings.polylineArrowWidthPixels,
		);
		groundPolyline.setArrowSizeMeters(
			debugSettings.polylineArrowLengthMeters,
			debugSettings.polylineArrowWidthMeters,
		);

		// ── 折线大比例尺 ── 同上。
		largeGroundPolyline.setColor( debugSettings.largePolylineStrokeColor, debugSettings.largePolylineStrokeOpacity );
		largeGroundPolyline.applyWidthState(
			debugSettings.largePolylineWidthMode,
			debugSettings.largePolylineWidthPixels,
			debugSettings.largePolylineWidthMeters,
		);
		largeGroundPolyline.setRenderOrder( plotOrderToRenderOrder( debugSettings.largePolylinePlotOrder ) );
		largeGroundPolyline.setVisible( debugSettings.largePolylineVisible );
		largeGroundPolyline.setArrowSize(
			debugSettings.largePolylineArrowLengthPixels,
			debugSettings.largePolylineArrowWidthPixels,
		);
		largeGroundPolyline.setArrowSizeMeters(
			debugSettings.largePolylineArrowLengthMeters,
			debugSettings.largePolylineArrowWidthMeters,
		);

		// 共享渲染状态旋钮(fragment culling + 3-pass 可见性)也必须传到每个箭头图元。
		// 延迟到子系统存在后再执行,这样首次 applyGroundDebugSettings()
		// (在子系统构造前调用)对箭头仍是 no-op。
		if ( arrowSubsystem ) {
			arrowSubsystem.applyFragmentCull( debugSettings.fragmentCull );
			arrowSubsystem.applyPassVisibility( {
				frontStencil: debugSettings.showFrontStencil,
				backStencil: debugSettings.showBackStencil,
				color: debugSettings.showColorPass,
			} );
		}
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
	 * Applies a circle plot-order edit while preserving every other plot order.
	 */
	function applyCirclePlotOrder(): void {
		updateRegisteredPlotOrder( 'circle' );
		applyGroundDebugSettings();
	}

	/**
	 * Applies a large rectangle plot-order edit.
	 */
	function applyLargeRectanglePlotOrder(): void {
		updateRegisteredPlotOrder( 'largeRectangle' );
		applyGroundDebugSettings();
	}

	/**
	 * Applies a large polygon plot-order edit.
	 */
	function applyLargePolygonPlotOrder(): void {
		updateRegisteredPlotOrder( 'largePolygon' );
		applyGroundDebugSettings();
	}

	/**
	 * Applies a large circle plot-order edit.
	 */
	function applyLargeCirclePlotOrder(): void {
		updateRegisteredPlotOrder( 'largeCircle' );
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
	 * Rebuilds only the circle primitive when circle-only GUI values change.
	 */
	function rebuildGroundCircle(): void {
		scene.remove( groundCircle.classification.group );
		groundCircle.dispose();
		groundCircle = createGroundCircle();
		scene.add( groundCircle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds the circle primitive after a normalize + dispose cycle.
	 */
	function rebuildGroundCircleFromGui(): void {
		normalizeCircleDebugSettings();
		rebuildGroundCircle();
	}

	/**
	 * Rebuilds only the large rectangle primitive.
	 */
	function rebuildLargeGroundRectangle(): void {
		scene.remove( largeGroundRectangle.classification.group );
		largeGroundRectangle.dispose();
		largeGroundRectangle = createLargeGroundRectangle();
		scene.add( largeGroundRectangle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds only the large polygon primitive.
	 */
	function rebuildLargeGroundPolygon(): void {
		scene.remove( largeGroundPolygon.classification.group );
		largeGroundPolygon.dispose();
		largeGroundPolygon = createLargeGroundPolygon();
		scene.add( largeGroundPolygon.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds only the large circle primitive.
	 */
	function rebuildLargeGroundCircle(): void {
		scene.remove( largeGroundCircle.classification.group );
		largeGroundCircle.dispose();
		largeGroundCircle = createLargeGroundCircle();
		scene.add( largeGroundCircle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds the 1:1 ground text primitive. Required when content / fontSize /
	 * MPP / rotation / fill / stroke change (texture re-paint + footprint redo).
	 */
	function rebuildGroundText(): void {
		scene.remove( groundText.group );
		groundText.dispose();
		groundText = createGroundText();
		scene.add( groundText.group );
		applyGroundDebugSettings();
	}

	/**
	 * Rebuilds the 5 km large ground text primitive.
	 */
	function rebuildLargeGroundText(): void {
		scene.remove( largeGroundText.group );
		largeGroundText.dispose();
		largeGroundText = createLargeGroundText();
		scene.add( largeGroundText.group );
		applyGroundDebugSettings();
	}

	/**
	 * Plot-order edit for the 1:1 text.
	 */
	function applyTextPlotOrder(): void {
		updateRegisteredPlotOrder( 'text' );
		applyGroundDebugSettings();
	}

	/**
	 * Plot-order edit for the 5 km text.
	 */
	function applyLargeTextPlotOrder(): void {
		updateRegisteredPlotOrder( 'largeText' );
		applyGroundDebugSettings();
	}

	/**
	 * 重建圆形点。position / shape / size 变了必须重建底层 circle/rectangle 实例。
	 */
	function rebuildGroundPointCircle(): void {
		scene.remove( groundPointCircle.classification.group );
		groundPointCircle.dispose();
		groundPointCircle = createGroundPointCircle();
		scene.add( groundPointCircle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * 重建正方形点。
	 */
	function rebuildGroundPointSquare(): void {
		scene.remove( groundPointSquare.classification.group );
		groundPointSquare.dispose();
		groundPointSquare = createGroundPointSquare();
		scene.add( groundPointSquare.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * 圆形点 plot-order 编辑。
	 */
	function applyPointCirclePlotOrder(): void {
		updateRegisteredPlotOrder( 'pointCircle' );
		applyGroundDebugSettings();
	}

	/**
	 * 正方形点 plot-order 编辑。
	 */
	function applyPointSquarePlotOrder(): void {
		updateRegisteredPlotOrder( 'pointSquare' );
		applyGroundDebugSettings();
	}

	/**
	 * 重建大比例尺圆形点。
	 */
	function rebuildLargeGroundPointCircle(): void {
		scene.remove( largeGroundPointCircle.classification.group );
		largeGroundPointCircle.dispose();
		largeGroundPointCircle = createLargeGroundPointCircle();
		scene.add( largeGroundPointCircle.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * 重建大比例尺正方形点。
	 */
	function rebuildLargeGroundPointSquare(): void {
		scene.remove( largeGroundPointSquare.classification.group );
		largeGroundPointSquare.dispose();
		largeGroundPointSquare = createLargeGroundPointSquare();
		scene.add( largeGroundPointSquare.classification.group );
		applyGroundDebugSettings();
	}

	/**
	 * 大比例尺圆形点 plot-order 编辑。
	 */
	function applyLargePointCirclePlotOrder(): void {
		updateRegisteredPlotOrder( 'largePointCircle' );
		applyGroundDebugSettings();
	}

	/**
	 * 大比例尺正方形点 plot-order 编辑。
	 */
	function applyLargePointSquarePlotOrder(): void {
		updateRegisteredPlotOrder( 'largePointSquare' );
		applyGroundDebugSettings();
	}

	/** 重建 1:1 折线（点位 / arcType / loop / width mode 变化时调）。 */
	function rebuildGroundPolyline(): void {
		scene.remove( groundPolyline.group );
		groundPolyline.dispose();
		groundPolyline = createGroundPolyline();
		scene.add( groundPolyline.group );
		applyGroundDebugSettings();
	}

	/** 重建大比例尺折线（同上）。 */
	function rebuildLargeGroundPolyline(): void {
		scene.remove( largeGroundPolyline.group );
		largeGroundPolyline.dispose();
		largeGroundPolyline = createLargeGroundPolyline();
		scene.add( largeGroundPolyline.group );
		applyGroundDebugSettings();
	}

	function applyPolylinePlotOrder(): void {
		updateRegisteredPlotOrder( 'polyline' );
		applyGroundDebugSettings();
	}

	function applyLargePolylinePlotOrder(): void {
		updateRegisteredPlotOrder( 'largePolyline' );
		applyGroundDebugSettings();
	}

	/**
	 * 创建用于 render-pass 诊断的 lil-gui 控制面板。
	 */
	function createGroundDebugGui(): GUI {
		const gui = new GUI( { title: 'Cesium Ground Debug' } );
		gui.domElement.style.right = '16px';
		gui.domElement.style.top = '16px';

		// GUI 顶部的 "Camera" 文件夹承载导航快捷操作。目前只有 "fly to plot" 按钮:
		// 把无参函数包装到对象字面量中,因为 lil-gui 会把任何值为函数的
		// `gui.add(obj, key)` 渲染为可点击按钮。默认 720km 高度视图会显示
		// nothing of the ~10 m primitives, and scrolling all the way down
		// with the mouse wheel takes dozens of seconds.
		const cameraFolder = gui.addFolder( 'Camera' );
		cameraFolder.add( {
			flyToPlot: () => flyToPlot(),
		}, 'flyToPlot' ).name( 'fly to plot (1:1)' );
		cameraFolder.add( glbModelGuiModel, 'flyToModel' ).name( 'fly to GLB model' );

		const glbModelFolder = gui.addFolder( 'GLB Model' );
		glbModelFolder.add( glbModelGuiModel, 'visible' ).name( 'visible' ).onChange( ( visible: boolean ) => {
			glbModelAnchor.visible = visible;
		} );
		glbModelFolder.add( glbModelGuiModel, 'flyToModel' ).name( 'fly to model' );
		glbModelFolder.close();

		const rectangleFolder = gui.addFolder( 'Rectangle' );
		rectangleFolder.add( rectangleGuiModel, 'points' ).name( 'points' ).onFinishChange( rebuildRectangleFromPointsText ).listen();
		rectangleFolder.addColor( debugSettings, 'strokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		rectangleFolder.add( debugSettings, 'strokeWidth', 0.0, 20.0, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundRectangle );
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
		polygonFolder.add( debugSettings, 'polygonStrokeWidth', 0.0, 20.0, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundPolygon );
		polygonFolder.add( debugSettings, 'polygonStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		polygonFolder.addColor( debugSettings, 'polygonFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		polygonFolder.add( debugSettings, 'polygonRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildGroundPolygonFromGui ).listen();
		polygonFolder.add( debugSettings, 'polygonHole' ).name( 'hole' ).onChange( rebuildGroundPolygonFromGui );

		const circleFolder = gui.addFolder( 'Circle' );
		circleFolder.add( debugSettings, 'circleVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		circleFolder.add( debugSettings, 'circlePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyCirclePlotOrder ).listen();
		circleFolder.add( debugSettings, 'circleCenterLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleCenterLat', - 90.0, 90.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleRadius', 1.0, 20.0, 0.5 ).name( 'radius m' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleHeight', - 10000.0, 10000.0, 1.0 ).name( 'height m' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleExtrudedHeight', - 10000.0, 10000.0, 1.0 ).name( 'extrudedHeight m' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleMinimumHeight', - 200000.0, 200000.0, 100.0 ).name( 'minHeight fn' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleMaximumHeight', - 200000.0, 200000.0, 100.0 ).name( 'maxHeight fn' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add(
			debugSettings,
			'circleGranularityRadians',
			MIN_CIRCLE_GRANULARITY_RADIANS,
			MAX_CIRCLE_GRANULARITY_RADIANS,
			0.001,
		).name( 'granularity rad' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleStRotationRadians', - Math.PI, Math.PI, 0.001 ).name( 'stRotation rad' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleRingCount', 1, 12, 1 ).name( 'ring count' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleRingGapMeters', 0.0, 20.0, 0.5 ).name( 'ring gap m' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleSectorStartDegrees', - 360.0, 360.0, 1.0 ).name( 'sector start deg' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.add( debugSettings, 'circleSectorAngleDegrees', - 360.0, 360.0, 1.0 ).name( 'sector angle deg' ).onFinishChange( rebuildGroundCircleFromGui ).listen();
		circleFolder.addColor( debugSettings, 'circleStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		circleFolder.add( debugSettings, 'circleStrokeWidth', 0.0, 20.0, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundCircle );
		circleFolder.add( debugSettings, 'circleStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		circleFolder.addColor( debugSettings, 'circleFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		circleFolder.add( debugSettings, 'circleFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );

		// 文字标绘 1:1：fontSize 调整纹理清晰度（足迹 = boxWidthCssPx × MPP），
		// metersPerPixel 调整地面足迹的米/纹素换算。content 用 textarea 支持
		// 多行（\n 横排换行 / 竖排换列）；对齐控件覆盖框内 textAlign/verticalAlign
		// 以及框相对锚点 anchorX/anchorY 两套。变化都走 rebuild（重画纹理 +
		// 重算足迹 + 重建几何）。
		const textFolder = gui.addFolder( 'Text 1:1' );
		textFolder.add( debugSettings, 'textVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		textFolder.add( debugSettings, 'textPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyTextPlotOrder ).listen();
		const textContentController = textFolder
			.add( debugSettings, 'textContent' ).name( 'content' )
			.onFinishChange( rebuildGroundText ).listen();
		convertControllerToTextarea( textContentController, 3 );
		textFolder.add( debugSettings, 'textFontSize', 8, 128, 1 ).name( 'fontSize px' ).onFinishChange( rebuildGroundText ).listen();
		textFolder.add( debugSettings, 'textMetersPerPixel', 0.1, 10.0, 0.1 ).name( 'metersPerPixel' ).onFinishChange( rebuildGroundText ).listen();
		textFolder.add( debugSettings, 'textRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildGroundText ).listen();
		textFolder.add( debugSettings, 'textLayoutDirection', [ 'horizontal', 'vertical-rl', 'vertical-lr' ] ).name( 'layout direction' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textTextAlign', [ 'left', 'center', 'right' ] ).name( 'textAlign (字↔框)' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textVerticalAlign', [ 'top', 'middle', 'bottom' ] ).name( 'verticalAlign (字↔框)' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textAnchorX', [ 'left', 'center', 'right' ] ).name( 'anchorX (框↔锚点)' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textAnchorY', [ 'top', 'middle', 'bottom' ] ).name( 'anchorY (框↔锚点)' ).onChange( rebuildGroundText );
		textFolder.addColor( debugSettings, 'textFontColor' ).name( 'font color' ).onChange( rebuildGroundText );
		textFolder.addColor( debugSettings, 'textFontStrokeColor' ).name( 'font stroke' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textFontStrokeWidth', 0, 8, 0.5 ).name( 'font strokeWidth' ).onFinishChange( rebuildGroundText );
		textFolder.addColor( debugSettings, 'textFillColor' ).name( 'fillColor' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textFillOpacity', 0, 100, 1 ).name( 'fillOpacity' ).onChange( rebuildGroundText );
		textFolder.addColor( debugSettings, 'textStrokeColor' ).name( 'strokeColor' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textStrokeOpacity', 0, 100, 1 ).name( 'strokeOpacity' ).onChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textStrokeWidth', 0, 8, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundText );
		textFolder.add( debugSettings, 'textCornerRadius', 0, 32, 1 ).name( 'cornerRadius' ).onFinishChange( rebuildGroundText );

		// 点标绘：position / shape / size 需 rebuild（底层 circle/rectangle 重建），
		// 颜色 / 描边 / visible / plot order 走 applyGroundDebugSettings 热更新。
		// shape 下拉切换 'circle' ↔ 'square' 时，会丢弃旧 primitive 并按新形状重新
		// 创建——这正是点标绘"两种渲染路径"的演示入口。
		const pointShapeOptions: CesiumGroundPointShape[] = [ 'circle', 'square' ];

		const pointCircleFolder = gui.addFolder( 'Point Circle' );
		pointCircleFolder.add( debugSettings, 'pointCircleVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		pointCircleFolder.add( debugSettings, 'pointCirclePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyPointCirclePlotOrder ).listen();
		pointCircleFolder.add( debugSettings, 'pointCircleShape', pointShapeOptions ).name( 'shape' ).onChange( rebuildGroundPointCircle );
		pointCircleFolder.add( debugSettings, 'pointCircleCenterLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildGroundPointCircle ).listen();
		pointCircleFolder.add( debugSettings, 'pointCircleCenterLat', - 90.0, 90.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildGroundPointCircle ).listen();
		pointCircleFolder.add( debugSettings, 'pointCircleSize', 1.0, 40.0, 0.5 ).name( 'size m' ).onFinishChange( rebuildGroundPointCircle ).listen();
		pointCircleFolder.addColor( debugSettings, 'pointCircleStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		pointCircleFolder.add( debugSettings, 'pointCircleStrokeWidth', 0.0, 20.0, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundPointCircle );
		pointCircleFolder.add( debugSettings, 'pointCircleStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		pointCircleFolder.addColor( debugSettings, 'pointCircleFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		pointCircleFolder.add( debugSettings, 'pointCircleFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );

		const pointSquareFolder = gui.addFolder( 'Point Square' );
		pointSquareFolder.add( debugSettings, 'pointSquareVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		pointSquareFolder.add( debugSettings, 'pointSquarePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyPointSquarePlotOrder ).listen();
		pointSquareFolder.add( debugSettings, 'pointSquareShape', pointShapeOptions ).name( 'shape' ).onChange( rebuildGroundPointSquare );
		pointSquareFolder.add( debugSettings, 'pointSquareCenterLon', - 180.0, 180.0, 0.0001 ).name( 'center lon' ).onFinishChange( rebuildGroundPointSquare ).listen();
		pointSquareFolder.add( debugSettings, 'pointSquareCenterLat', - 90.0, 90.0, 0.0001 ).name( 'center lat' ).onFinishChange( rebuildGroundPointSquare ).listen();
		pointSquareFolder.add( debugSettings, 'pointSquareSize', 1.0, 40.0, 0.5 ).name( 'size m' ).onFinishChange( rebuildGroundPointSquare ).listen();
		pointSquareFolder.addColor( debugSettings, 'pointSquareStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		pointSquareFolder.add( debugSettings, 'pointSquareStrokeWidth', 0.0, 20.0, 0.5 ).name( 'strokeWidth' ).onFinishChange( rebuildGroundPointSquare );
		pointSquareFolder.add( debugSettings, 'pointSquareStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		pointSquareFolder.addColor( debugSettings, 'pointSquareFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		pointSquareFolder.add( debugSettings, 'pointSquareFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );

		// Material Effects exposes only logical material controls. Geometry
		// rebuilds keep these objects alive, which demonstrates that setUniform
		// and setAppearance update the existing render pipeline in place.
		const effectsFolder = gui.addFolder( 'Material Effects' );
		effectsFolder.add( effectSettings, 'animate' ).name( 'animate host time' );
		effectsFolder.add( effectSettings, 'timeScale', 0.0, 4.0, 0.05 ).name( 'time scale' );
		effectsFolder.add( effectSettings, 'flowSpeed', 0.0, 3.0, 0.05 )
			.name( 'FlowLine speed' )
			.onChange( ( value: number ) => {
				flowLineMaterial.setUniform( 'u_speed', value );
			} );
		effectsFolder.add( effectSettings, 'pulsePhase', - 1.0, 1.0, 0.01 )
			.name( 'PulsePoint phase' )
			.onChange( ( value: number ) => {
				pulsePointMaterial.setUniform( 'u_phase', value );
			} );
		effectsFolder.add( effectSettings, 'scalePhase', - 1.0, 1.0, 0.01 )
			.name( 'ScalePulse phase' )
			.onChange( ( value: number ) => {
				scalePulseMaterial.setUniform( 'u_phase', value );
			} );
		effectsFolder.add( effectSettings, 'customFrequency', 0.0, 4.0, 0.05 )
			.name( 'custom frequency' )
			.onChange( ( value: number ) => {
				customMaterial.setUniform( 'u_frequency', value );
			} );
		effectsFolder.close();

		// 折线 1:1：4 段 zig-zag，与 polygon/circle/text/point 同 1:1 比例尺。
		// 拖 strokeWidth 滑杆 → 直接 setWidth；切 arcType / loop / widthMode →
		// rebuildGroundPolyline 重建几何（与点 / 文字 rebuild 同模式）。
		const widthModeOptions: Record<string, CesiumGroundLineWidthMode> = {
			'screen (px)': 'screen',
			'world (m)': 'world',
		};
		const arcTypeOptions: Record<string, CesiumGroundArcType> = {
			geodesic: 'geodesic',
			rhumb: 'rhumb',
			none: 'none',
		};
		const polylineFolder = gui.addFolder( 'Polyline 1:1 (~200 m)' );
		polylineFolder.add( debugSettings, 'polylineVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylinePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyPolylinePlotOrder ).listen();
		polylineFolder.addColor( debugSettings, 'polylineStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylineStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylineWidthMode', widthModeOptions ).name( 'widthMode' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylineWidthPixels', 0.5, 20.0, 0.5 ).name( 'widthPixels' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylineWidthMeters', 0.5, 50.0, 0.5 ).name( 'widthMeters' ).onChange( applyGroundDebugSettings );
		polylineFolder.add( debugSettings, 'polylineArcType', arcTypeOptions ).name( 'arcType' ).onFinishChange( rebuildGroundPolyline );
		polylineFolder.add( debugSettings, 'polylineLoop' ).name( 'loop' ).onChange( rebuildGroundPolyline );
		polylineFolder.add( debugSettings, 'polylineDashLengthMeters', 0.0, 50.0, 1.0 ).name( 'dash m' ).onFinishChange( rebuildGroundPolyline );
		polylineFolder.add( debugSettings, 'polylineGapLengthMeters', 0.0, 50.0, 1.0 ).name( 'gap m' ).onFinishChange( rebuildGroundPolyline );
		polylineFolder.add( debugSettings, 'polylineDebugVolume' ).name( 'debug volume' ).onChange( rebuildGroundPolyline );
		// 线端箭头：mode 切换端数走 setArrowMode（无需重建几何）；尺寸热刷。
		const arrowModeOptions: Record<string, CesiumGroundArrowMode> = {
			none: 'none',
			left: 'left',
			right: 'right',
			both: 'both',
		};
		const arrowStyleOptions: Record<string, CesiumGroundArrowStyle> = {
			solid: 'solid',
			open: 'open',
		};
		polylineFolder.add( debugSettings, 'polylineArrowMode', arrowModeOptions ).name( 'arrow mode' ).onChange( () => {
			groundPolyline.setArrowMode( debugSettings.polylineArrowMode );
		} );
		polylineFolder.add( debugSettings, 'polylineArrowStyle', arrowStyleOptions ).name( 'arrow style' ).onChange( () => {
			groundPolyline.setArrowStyle( debugSettings.polylineArrowStyle );
		} );
		// 箭头尺寸模式（对应 Cesium `Billboard.sizeInMeters`）：screen 像素恒定 /
		// world 世界米恒定。两套尺寸滑块（px / m）按当前 mode 互斥 show——切到哪
		// 边显示哪边，避免拽到「不生效」的那组困惑。
		const polylineArrowLenPxCtl = polylineFolder.add( debugSettings, 'polylineArrowLengthPixels', 4.0, 60.0, 1.0 ).name( 'arrow len px' ).onChange( applyGroundDebugSettings );
		const polylineArrowWidthPxCtl = polylineFolder.add( debugSettings, 'polylineArrowWidthPixels', 4.0, 60.0, 1.0 ).name( 'arrow width px' ).onChange( applyGroundDebugSettings );
		const polylineArrowLenMCtl = polylineFolder.add( debugSettings, 'polylineArrowLengthMeters', 1.0, 200.0, 1.0 ).name( 'arrow len m' ).onChange( applyGroundDebugSettings );
		const polylineArrowWidthMCtl = polylineFolder.add( debugSettings, 'polylineArrowWidthMeters', 1.0, 200.0, 1.0 ).name( 'arrow width m' ).onChange( applyGroundDebugSettings );
		const syncPolylineArrowSizeVisibility = () => {
			const isWorld = debugSettings.polylineArrowWidthMode === 'world';
			polylineArrowLenPxCtl.show( ! isWorld );
			polylineArrowWidthPxCtl.show( ! isWorld );
			polylineArrowLenMCtl.show( isWorld );
			polylineArrowWidthMCtl.show( isWorld );
		};
		syncPolylineArrowSizeVisibility();
		polylineFolder.add( debugSettings, 'polylineArrowWidthMode', widthModeOptions ).name( 'arrow widthMode' ).onChange( () => {
			groundPolyline.setArrowWidthMode( debugSettings.polylineArrowWidthMode );
			syncPolylineArrowSizeVisibility();
		} );
		polylineFolder.close();

		const largeFolder = gui.addFolder( 'Large Scale' );
		const largeRectangleFolder = largeFolder.addFolder( 'Rectangle 10km x 5km' );
		largeRectangleFolder.add( debugSettings, 'largeRectangleVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largeRectangleFolder.add( debugSettings, 'largeRectanglePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargeRectanglePlotOrder ).listen();
		largeRectangleFolder.add( debugSettings, 'largeRectangleWidthMeters', 1000.0, 20000.0, 100.0 ).name( 'width m' ).onFinishChange( rebuildLargeGroundRectangle ).listen();
		largeRectangleFolder.add( debugSettings, 'largeRectangleHeightMeters', 1000.0, 20000.0, 100.0 ).name( 'height m' ).onFinishChange( rebuildLargeGroundRectangle ).listen();
		largeRectangleFolder.addColor( debugSettings, 'largeRectangleStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largeRectangleFolder.add( debugSettings, 'largeRectangleStrokeWidth', 0.0, 1000.0, 25.0 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundRectangle );
		largeRectangleFolder.add( debugSettings, 'largeRectangleStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largeRectangleFolder.addColor( debugSettings, 'largeRectangleFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		largeRectangleFolder.add( debugSettings, 'largeRectangleFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		largeRectangleFolder.close();

		const largePolygonFolder = largeFolder.addFolder( 'Polygon 10km' );
		largePolygonFolder.add( debugSettings, 'largePolygonVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largePolygonFolder.add( debugSettings, 'largePolygonPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargePolygonPlotOrder ).listen();
		largePolygonFolder.add( debugSettings, 'largePolygonRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildLargeGroundPolygon ).listen();
		largePolygonFolder.addColor( debugSettings, 'largePolygonStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largePolygonFolder.add( debugSettings, 'largePolygonStrokeWidth', 0.0, 1000.0, 25.0 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundPolygon );
		largePolygonFolder.add( debugSettings, 'largePolygonStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largePolygonFolder.addColor( debugSettings, 'largePolygonFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		largePolygonFolder.add( debugSettings, 'largePolygonFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		largePolygonFolder.close();

		const largeCircleFolder = largeFolder.addFolder( 'Circle 5km' );
		largeCircleFolder.add( debugSettings, 'largeCircleVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largeCircleFolder.add( debugSettings, 'largeCirclePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargeCirclePlotOrder ).listen();
		largeCircleFolder.add( debugSettings, 'largeCircleRadius', 1000.0, 10000.0, 100.0 ).name( 'radius m' ).onFinishChange( rebuildLargeGroundCircle ).listen();
		largeCircleFolder.addColor( debugSettings, 'largeCircleStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largeCircleFolder.add( debugSettings, 'largeCircleStrokeWidth', 0.0, 1000.0, 25.0 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundCircle );
		largeCircleFolder.add( debugSettings, 'largeCircleStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largeCircleFolder.addColor( debugSettings, 'largeCircleFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		largeCircleFolder.add( debugSettings, 'largeCircleFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		largeCircleFolder.close();

		// 文字标绘 5 km：与 largeCircle 同量级。content 短文 "5 km\n大比例尺"
		// 配 fontSize=64 / metersPerPixel=25 时足迹宽 ≈ 5 km；下调 MPP 即整段
		// 缩小，但 fontSize 不变 → 纹理保持锐利。同样用 textarea 支持换行 +
		// 对齐 / 锚点下拉。
		const largeTextFolder = largeFolder.addFolder( 'Text 5km' );
		largeTextFolder.add( debugSettings, 'largeTextVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largeTextFolder.add( debugSettings, 'largeTextPlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargeTextPlotOrder ).listen();
		const largeTextContentController = largeTextFolder
			.add( debugSettings, 'largeTextContent' ).name( 'content' )
			.onFinishChange( rebuildLargeGroundText ).listen();
		convertControllerToTextarea( largeTextContentController, 3 );
		largeTextFolder.add( debugSettings, 'largeTextFontSize', 16, 128, 1 ).name( 'fontSize px' ).onFinishChange( rebuildLargeGroundText ).listen();
		largeTextFolder.add( debugSettings, 'largeTextMetersPerPixel', 5.0, 100.0, 1.0 ).name( 'metersPerPixel' ).onFinishChange( rebuildLargeGroundText ).listen();
		largeTextFolder.add( debugSettings, 'largeTextRotationDegrees', - 180.0, 180.0, 1.0 ).name( 'rotation deg' ).onFinishChange( rebuildLargeGroundText ).listen();
		largeTextFolder.add( debugSettings, 'largeTextLayoutDirection', [ 'horizontal', 'vertical-rl', 'vertical-lr' ] ).name( 'layout direction' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextTextAlign', [ 'left', 'center', 'right' ] ).name( 'textAlign (字↔框)' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextVerticalAlign', [ 'top', 'middle', 'bottom' ] ).name( 'verticalAlign (字↔框)' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextAnchorX', [ 'left', 'center', 'right' ] ).name( 'anchorX (框↔锚点)' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextAnchorY', [ 'top', 'middle', 'bottom' ] ).name( 'anchorY (框↔锚点)' ).onChange( rebuildLargeGroundText );
		largeTextFolder.addColor( debugSettings, 'largeTextFontColor' ).name( 'font color' ).onChange( rebuildLargeGroundText );
		largeTextFolder.addColor( debugSettings, 'largeTextFontStrokeColor' ).name( 'font stroke' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextFontStrokeWidth', 0, 16, 1 ).name( 'font strokeWidth' ).onFinishChange( rebuildLargeGroundText );
		largeTextFolder.addColor( debugSettings, 'largeTextFillColor' ).name( 'fillColor' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextFillOpacity', 0, 100, 1 ).name( 'fillOpacity' ).onChange( rebuildLargeGroundText );
		largeTextFolder.addColor( debugSettings, 'largeTextStrokeColor' ).name( 'strokeColor' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextStrokeOpacity', 0, 100, 1 ).name( 'strokeOpacity' ).onChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextStrokeWidth', 0, 16, 1 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundText );
		largeTextFolder.add( debugSettings, 'largeTextCornerRadius', 0, 64, 1 ).name( 'cornerRadius' ).onFinishChange( rebuildLargeGroundText );
		largeTextFolder.close();

		// 大比例尺点：同样的 shape 下拉切换 circle ↔ square 触发 rebuild，验证两种
		// 渲染路径在公里级 size + 米级 strokeWidth 下也能正常工作。
		const largePointCircleFolder = largeFolder.addFolder( 'Point Circle 2km' );
		largePointCircleFolder.add( debugSettings, 'largePointCircleVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largePointCircleFolder.add( debugSettings, 'largePointCirclePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargePointCirclePlotOrder ).listen();
		largePointCircleFolder.add( debugSettings, 'largePointCircleShape', pointShapeOptions ).name( 'shape' ).onChange( rebuildLargeGroundPointCircle );
		largePointCircleFolder.add( debugSettings, 'largePointCircleSize', 200.0, 10000.0, 100.0 ).name( 'size m' ).onFinishChange( rebuildLargeGroundPointCircle ).listen();
		largePointCircleFolder.addColor( debugSettings, 'largePointCircleStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largePointCircleFolder.add( debugSettings, 'largePointCircleStrokeWidth', 0.0, 1000.0, 25.0 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundPointCircle );
		largePointCircleFolder.add( debugSettings, 'largePointCircleStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largePointCircleFolder.addColor( debugSettings, 'largePointCircleFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		largePointCircleFolder.add( debugSettings, 'largePointCircleFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		largePointCircleFolder.close();

		const largePointSquareFolder = largeFolder.addFolder( 'Point Square 2km' );
		largePointSquareFolder.add( debugSettings, 'largePointSquareVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largePointSquareFolder.add( debugSettings, 'largePointSquarePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargePointSquarePlotOrder ).listen();
		largePointSquareFolder.add( debugSettings, 'largePointSquareShape', pointShapeOptions ).name( 'shape' ).onChange( rebuildLargeGroundPointSquare );
		largePointSquareFolder.add( debugSettings, 'largePointSquareSize', 200.0, 10000.0, 100.0 ).name( 'size m' ).onFinishChange( rebuildLargeGroundPointSquare ).listen();
		largePointSquareFolder.addColor( debugSettings, 'largePointSquareStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largePointSquareFolder.add( debugSettings, 'largePointSquareStrokeWidth', 0.0, 1000.0, 25.0 ).name( 'strokeWidth' ).onFinishChange( rebuildLargeGroundPointSquare );
		largePointSquareFolder.add( debugSettings, 'largePointSquareStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largePointSquareFolder.addColor( debugSettings, 'largePointSquareFillColor' ).name( 'fillColor' ).onChange( applyGroundDebugSettings );
		largePointSquareFolder.add( debugSettings, 'largePointSquareFillOpacity', 0.0, 100.0, 1.0 ).name( 'fillOpacity' ).onChange( applyGroundDebugSettings );
		largePointSquareFolder.close();

		// 大比例尺折线：50 km 总长 5 段 zig-zag，screen 模式默认 3 px，远视角
		// 仍然可见。切到 world 模式（widthMeters=200 m）观察「远处变细」效果。
		const largePolylineFolder = largeFolder.addFolder( 'Polyline ~50km' );
		largePolylineFolder.add( debugSettings, 'largePolylineVisible' ).name( 'visible' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylinePlotOrder', 0, 100, 1 ).name( 'plot order' ).onChange( applyLargePolylinePlotOrder ).listen();
		largePolylineFolder.addColor( debugSettings, 'largePolylineStrokeColor' ).name( 'strokeColor' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylineStrokeOpacity', 0.0, 100.0, 1.0 ).name( 'strokeOpacity' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylineWidthMode', widthModeOptions ).name( 'widthMode' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylineWidthPixels', 0.5, 20.0, 0.5 ).name( 'widthPixels' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylineWidthMeters', 50.0, 2000.0, 25.0 ).name( 'widthMeters' ).onChange( applyGroundDebugSettings );
		largePolylineFolder.add( debugSettings, 'largePolylineArcType', arcTypeOptions ).name( 'arcType' ).onFinishChange( rebuildLargeGroundPolyline );
		largePolylineFolder.add( debugSettings, 'largePolylineLoop' ).name( 'loop' ).onChange( rebuildLargeGroundPolyline );
		largePolylineFolder.add( debugSettings, 'largePolylineDashLengthMeters', 0.0, 5000.0, 50.0 ).name( 'dash m' ).onFinishChange( rebuildLargeGroundPolyline );
		largePolylineFolder.add( debugSettings, 'largePolylineGapLengthMeters', 0.0, 5000.0, 50.0 ).name( 'gap m' ).onFinishChange( rebuildLargeGroundPolyline );
		largePolylineFolder.add( debugSettings, 'largePolylineDebugVolume' ).name( 'debug volume' ).onChange( rebuildLargeGroundPolyline );
		largePolylineFolder.add( debugSettings, 'largePolylineArrowMode', arrowModeOptions ).name( 'arrow mode' ).onChange( () => {
			largeGroundPolyline.setArrowMode( debugSettings.largePolylineArrowMode );
		} );
		largePolylineFolder.add( debugSettings, 'largePolylineArrowStyle', arrowStyleOptions ).name( 'arrow style' ).onChange( () => {
			largeGroundPolyline.setArrowStyle( debugSettings.largePolylineArrowStyle );
		} );
		// 箭头尺寸 mode + px/m 互斥 show（同 polyline）。
		const largePolylineArrowLenPxCtl = largePolylineFolder.add( debugSettings, 'largePolylineArrowLengthPixels', 4.0, 80.0, 1.0 ).name( 'arrow len px' ).onChange( applyGroundDebugSettings );
		const largePolylineArrowWidthPxCtl = largePolylineFolder.add( debugSettings, 'largePolylineArrowWidthPixels', 4.0, 80.0, 1.0 ).name( 'arrow width px' ).onChange( applyGroundDebugSettings );
		const largePolylineArrowLenMCtl = largePolylineFolder.add( debugSettings, 'largePolylineArrowLengthMeters', 50.0, 3000.0, 50.0 ).name( 'arrow len m' ).onChange( applyGroundDebugSettings );
		const largePolylineArrowWidthMCtl = largePolylineFolder.add( debugSettings, 'largePolylineArrowWidthMeters', 50.0, 3000.0, 50.0 ).name( 'arrow width m' ).onChange( applyGroundDebugSettings );
		const syncLargePolylineArrowSizeVisibility = () => {
			const isWorld = debugSettings.largePolylineArrowWidthMode === 'world';
			largePolylineArrowLenPxCtl.show( ! isWorld );
			largePolylineArrowWidthPxCtl.show( ! isWorld );
			largePolylineArrowLenMCtl.show( isWorld );
			largePolylineArrowWidthMCtl.show( isWorld );
		};
		syncLargePolylineArrowSizeVisibility();
		largePolylineFolder.add( debugSettings, 'largePolylineArrowWidthMode', widthModeOptions ).name( 'arrow widthMode' ).onChange( () => {
			largeGroundPolyline.setArrowWidthMode( debugSettings.largePolylineArrowWidthMode );
			syncLargePolylineArrowSizeVisibility();
		} );
		largePolylineFolder.close();

		largeFolder.close();

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

	// ── 箭头子系统 ─────────────────────────────────────────────────
	// 5 类特殊形状箭头(fine / assault direction / attack / swallowtail / curved)
	// 放在独立子系统中,因此本文件无需了解任何箭头几何。构造发生在 debugGui 之后,
	// 这样箭头可以把自己的文件夹挂到同一个 GUI;它还共享 demo 的 PlotOrderRegistry,
	// 让箭头与上方矩形 / 多边形 / 圆图元参与同一个全局渲染顺序池。
	//
	// 当前由 `ENABLE_ARROW_SUBSYSTEM` 门控,用于隔离测试:如果此 flag 为 false
	// (也就是场景中只剩位于不同 lon/lat 的 rectangle + polygon + circle)时仍能复现
	// 弧带填充裁切,说明问题内生于贴地图元管线,不是箭头侧代码引入的。
	if ( ENABLE_ARROW_SUBSYSTEM ) {
		arrowSubsystem = new ArrowSubsystem( {
			scene,
			parentGui: debugGui,
			plotOrderRegistry,
			centerLongitude: RECTANGLE_CENTER_LON,
			centerLatitude: RECTANGLE_CENTER_LAT,
			fragmentCull: debugSettings.fragmentCull,
			passVisibility: {
				frontStencil: debugSettings.showFrontStencil,
				backStencil: debugSettings.showBackStencil,
				color: debugSettings.showColorPass,
			},
		} );
		// Run apply once more so the subsystem picks up the host's current
		// fragmentCull + pass-visibility flags via the new arrowSubsystem !== null
		// branch (the first applyGroundDebugSettings() above ran before the
		// subsystem existed and intentionally skipped that branch).
		applyGroundDebugSettings();
	}

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
		// Advance the host clock once. Every material receives this same snapshot,
		// preventing visible phase drift between the rectangle, polygon, point,
		// polyline, and arrow examples.
		const deltaSeconds = Math.min( hostClock.getDelta(), 0.25 );
		hostFrameState.deltaSeconds = deltaSeconds;
		hostFrameState.frameNumber = ++ hostFrameNumber;
		if ( effectSettings.animate ) {
			hostFrameState.timeSeconds += deltaSeconds * effectSettings.timeScale;
		}

		controls.update();
		camera.updateMatrixWorld();
		tilesRenderer.setResolutionFromRenderer( camera, renderer );
		tilesRenderer.update();

		// Refresh terrain log-depth uniforms before any pass touches the main
		// or packed depth buffers (precision path).
		updateTerrainLogDepthUniforms( camera.near, camera.far );

		tilesRenderer.group.visible = debugSettings.useTilesDepth;
		// Match Cesium's terrain-classification order: globe/terrain depth is
		// copied before 3D Tiles / models are drawn. The public GLB is a normal
		// model here, not a CESIUM_3D_TILE classification target, so it must not
		// be mixed into czm_globeDepthTexture.
		globeDepth.render( renderer, camera, scene, tilesRenderer.group, {
			// 使用真实瓦片深度时关闭 packed 椭球兜底，防止低视角地平线附近的
			// 不可见椭球面被贴地线当成天空中的有效地面。无瓦片测试时再打开兜底。
			includeFallbackDepth: ! debugSettings.useTilesDepth,
		} );
		tilesRenderer.group.visible = debugSettings.showTiles;
		hostFrameState.depthTexture = globeDepth.target.texture;
		hostFrameState.width = renderer.domElement.width;
		hostFrameState.height = renderer.domElement.height;
		hostFrameState.pixelRatio = renderer.getPixelRatio();

		groundRectangle.update( hostFrameState );
		groundPolygon.update( hostFrameState );
		groundCircle.update( hostFrameState );
		groundPointCircle.update( hostFrameState );
		groundPointSquare.update( hostFrameState );
		largeGroundRectangle.update( hostFrameState );
		largeGroundPolygon.update( hostFrameState );
		largeGroundCircle.update( hostFrameState );
		largeGroundPointCircle.update( hostFrameState );
		largeGroundPointSquare.update( hostFrameState );
		// 贴地线必须填 pixelRatio——czm_metersPerPixel 内部要乘它，HiDPI 下
		// 漏掉会让屏宽差 2×（doc 09 §4.2 / doc 10 §15）。
		groundPolyline.update( hostFrameState );
		largeGroundPolyline.update( hostFrameState );
		groundText.update( hostFrameState );
		largeGroundText.update( hostFrameState );

		// Forward the host's frame state to every arrow primitive so the
		// arrows participate in the same depth + viewport classification path
		// the rectangle / polygon / circle primitives use above.
		arrowSubsystem?.update( hostFrameState );

		renderer.render( scene, camera );
		if ( glbModelAnchor.visible && glbModelAnchor.children.length > 0 ) {
			const previousAutoClear = renderer.autoClear;
			renderer.autoClear = false;
			// Cesium clears/rebuilds globe depth before the 3D Tiles pass, so
			// terrain classification does not leave globe depth in the main
			// framebuffer to reject later model fragments.
			renderer.clearDepth();
			renderer.render( glbModelRenderScene, camera );
			renderer.autoClear = previousAutoClear;
		}

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
		// 每种箭头类型一行信息。用 `\n` 拼接,让固定信息面板保持单个扁平文本块。
		const arrowInfoBlock = arrowSubsystem
			? arrowSubsystem.getInfoLines().map( ( line ) => `${ line }\n` ).join( '' )
			: '';
		infoBody.textContent =
			`Ground adapter: Cesium-free rectangle + polygon (math/ + rectangle/ + polygon/)\n` +
			`Tiles: um-3d-tiles-renderer + Cesium Ion asset ${ assetIdLabel }\n` +
			`Terrain plugin: QuantizedMeshPlugin for TERRAIN assets\n` +
			`GLB model: ${ glbModelStatus } / visible ${ glbModelAnchor.visible ? 'on' : 'off' } / scale ${ DEMO_GLB_MODEL_SCALE.toFixed( 2 ) } / size ${ glbModelLocalSize.x.toFixed( 1 ) } x ${ glbModelLocalSize.y.toFixed( 1 ) } x ${ glbModelLocalSize.z.toFixed( 1 ) } m\n` +
			`Geometry: buildRectangleShadowVolumeGeometry / buildPolygonShadowVolumeGeometry\n` +
			`Rectangle: ${ debugSettings.visible ? 'on' : 'off' } / order ${ debugSettings.rectanglePlotOrder } / ${ debugSettings.widthDegrees.toFixed( 4 ) } deg x ${ debugSettings.heightDegrees.toFixed( 4 ) } deg\n` +
			`Rectangle meters: ${ debugSettings.widthMeters.toFixed( 1 ) } m x ${ debugSettings.heightMeters.toFixed( 1 ) } m\n` +
			`Polygon: ${ debugSettings.polygonVisible ? 'on' : 'off' } / order ${ debugSettings.polygonPlotOrder } / points ${ debugSettings.polygonPoints.length } / holes ${ debugSettings.polygonHoles.length } / rotation ${ debugSettings.polygonRotationDegrees.toFixed( 1 ) } deg / hole ${ debugSettings.polygonHole ? 'on' : 'off' }\n` +
			`Circle: ${ debugSettings.circleVisible ? 'on' : 'off' } / order ${ debugSettings.circlePlotOrder } / center ${ debugSettings.circleCenterLon.toFixed( 5 ) }, ${ debugSettings.circleCenterLat.toFixed( 5 ) } / radius ${ debugSettings.circleRadius.toFixed( 1 ) } m / rings ${ debugSettings.circleRingCount } / gap ${ debugSettings.circleRingGapMeters.toFixed( 1 ) } m / sector ${ debugSettings.circleSectorStartDegrees.toFixed( 0 ) } deg + ${ debugSettings.circleSectorAngleDegrees.toFixed( 0 ) } deg / granularity ${ debugSettings.circleGranularityRadians.toFixed( 5 ) } rad\n` +
			`Circle shadow heights: ${ debugSettings.circleMinimumHeight.toFixed( 1 ) } m -> ${ debugSettings.circleMaximumHeight.toFixed( 1 ) } m\n` +
			`Large Rectangle: ${ debugSettings.largeRectangleVisible ? 'on' : 'off' } / order ${ debugSettings.largeRectanglePlotOrder } / ${ ( debugSettings.largeRectangleWidthMeters / 1000.0 ).toFixed( 1 ) } km x ${ ( debugSettings.largeRectangleHeightMeters / 1000.0 ).toFixed( 1 ) } km\n` +
			`Large Polygon: ${ debugSettings.largePolygonVisible ? 'on' : 'off' } / order ${ debugSettings.largePolygonPlotOrder } / points ${ debugSettings.largePolygonPoints.length } / rotation ${ debugSettings.largePolygonRotationDegrees.toFixed( 1 ) } deg\n` +
			`Large Circle: ${ debugSettings.largeCircleVisible ? 'on' : 'off' } / order ${ debugSettings.largeCirclePlotOrder } / radius ${ ( debugSettings.largeCircleRadius / 1000.0 ).toFixed( 1 ) } km\n` +
			`Text 1:1: ${ debugSettings.textVisible ? 'on' : 'off' } / order ${ debugSettings.textPlotOrder } / "${ debugSettings.textContent }" / ${ debugSettings.textFontSize } px × ${ debugSettings.textMetersPerPixel.toFixed( 2 ) } m/px / rotation ${ debugSettings.textRotationDegrees.toFixed( 0 ) } deg\n` +
			`Text 5km: ${ debugSettings.largeTextVisible ? 'on' : 'off' } / order ${ debugSettings.largeTextPlotOrder } / "${ debugSettings.largeTextContent }" / ${ debugSettings.largeTextFontSize } px × ${ debugSettings.largeTextMetersPerPixel.toFixed( 1 ) } m/px / rotation ${ debugSettings.largeTextRotationDegrees.toFixed( 0 ) } deg\n` +
			arrowInfoBlock +
			`Debug surface: ${ debugSettings.showDebugSurface ? 'on' : 'off' }\n` +
			`Rectangle stroke: ${ debugSettings.strokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.strokeOpacity.toFixed( 0 ) }%\n` +
			`Polygon stroke: ${ debugSettings.polygonStrokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.polygonStrokeOpacity.toFixed( 0 ) }%\n` +
			`Circle stroke: ${ debugSettings.circleStrokeWidth.toFixed( 0 ) } m / opacity ${ debugSettings.circleStrokeOpacity.toFixed( 0 ) }%\n` +
			`CULL_FRAGMENTS: ${ debugSettings.fragmentCull ? 'on' : 'off' }\n` +
			`Shader: ShadowVolumeAppearanceVS/FS + ShadowVolumeFS (LOG_DEPTH on)\n` +
			`Stencil mask: 0x0f, zfail front=DECR_WRAP back=INCR_WRAP, depthFunc=LESS_EQUAL\n` +
			`Globe depth: tilesRenderer.group -> czm_packDepth -> czm_unpackDepth (log depth)\n` +
			`Root/model visible: ${ tileCounters.rootLoaded ? 'yes' : 'loading' } / ${ tileCounters.modelsVisible }\n` +
			`Tiles visible/cache/loaded: ${ stats.visible } / ${ stats.inCache } / ${ stats.loaded }\n` +
			`Queue download parse failed: ${ stats.queued } / ${ stats.downloading } / ${ stats.parsing } / ${ stats.failed }\n` +
			`Loaded model events: ${ tileCounters.modelsLoaded }\n` +
			`Drawing buffer: ${ renderer.domElement.width } x ${ renderer.domElement.height }` +
			( glbModelError ? `\nGLB load error: ${ glbModelError }` : '' ) +
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
		glbModelAnchor,
		glbModelRenderScene,
		glbModelGuiModel,
		get glbModelScene() {
			return glbModelScene;
		},
		get glbModelStatus() {
			return glbModelStatus;
		},
		get glbModelLocalSize() {
			return glbModelLocalSize;
		},
		get groundRectangle() {
			return groundRectangle;
		},
		get groundPolygon() {
			return groundPolygon;
		},
		get groundCircle() {
			return groundCircle;
		},
		get largeGroundRectangle() {
			return largeGroundRectangle;
		},
		get largeGroundPolygon() {
			return largeGroundPolygon;
		},
		get largeGroundCircle() {
			return largeGroundCircle;
		},
		get groundText() {
			return groundText;
		},
		get largeGroundText() {
			return largeGroundText;
		},
		get arrowSubsystem() {
			return arrowSubsystem;
		},
	};

	renderFrame();
}
