// ============================================================
// model-clamp-demo.ts
// 层级：贴模型 / 倾斜摄影 demo（标绘贴 3D Tiles 模型）。
// 职责：直观验证"标绘贴模型 / 贴倾斜摄影"，并能切换 classificationType 对比
//      TERRAIN / CESIUM_3D_TILE / BOTH 三种效果。三种模型来源（优先级从高到低，
//      可用 `?model=` 或 VITE_MODEL_SOURCE 强制）：
//        1. oblique（默认）——直连一个倾斜摄影 / 3D Tiles 的 tileset.json URL
//           （不走 Cesium Ion，无需 token；URL 由 VITE_OBLIQUE_TILESET_URL 覆盖，
//           缺省用 DEFAULT_OBLIQUE_URL）。加载后运行时从瓦片包围球反算中心，
//           把"全部标绘图形"摆到模型中心周围，再 clamp 到模型表面——这就是
//           用户要的"贴倾斜测试"。
//        2. ion——配置 VITE_CESIUM_ION_MODEL_ASSET_ID 且有 token 时，从 Ion 加载
//           该资产作 tileset 贡献者（同样运行时定位 + 标绘环绕）。
//        3. buildings——零依赖的合成楼房盒子（必做兜底）：在固定中心用 BoxGeometry
//           拼一组楼群，证明贴模型算法独立于具体数据源，离线可复现。
// 依赖：three、um-3d-tiles-renderer、lil-gui、lib/ground（ClassificationDepthManager
//      / ClassificationType / ENU / WGS84 / ECEF↔carto / log 深度）、lib/plot
//      （GroundDecalManager）、demo/dom、demo/env、demo/tiles。
// 被消费：main.ts（?demo=model 或 VITE_DEMO=model）。
//
// ── 三种 classificationType 的视觉预期 ───────────────────────────────────
//   | 类型           | 模型表面 | 模型外（空地/无覆盖）           |
//   | TERRAIN        | 不显示   | 贴地面/椭球面                   |
//   | CESIUM_3D_TILE | 贴模型   | 不着色（哨兵掩掉）              |
//   | BOTH（默认）   | 贴模型   | 贴椭球面（兜底）               |
//   切 GUI"分类目标"三档应能明显看出差异——这就是贴模型 / 贴倾斜功能的最终验收。
// ============================================================

import GUI from 'lil-gui';
import {
	AmbientLight,
	Box3,
	BoxGeometry,
	Color,
	DirectionalLight,
	Group,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	type Object3D,
	PerspectiveCamera,
	Scene,
	Sphere,
	Vector3,
	WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';
import { CesiumIonAuthPlugin } from 'um-3d-tiles-renderer/core/plugins';

import {
	applyCesiumLogDepthToMaterial,
	cartesianToCartographic,
	type Cartographic,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	ClassificationDepthManager,
	ClassificationType,
	eastNorthUpToFixedFrame,
	longitudeLatitudeFromCenterOffsetsMeters,
	type LonLatPoint,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from '../lib/ground';
import { GroundDecalManager } from '../lib/plot';

import { createInfoPanel, installPageStyle } from './dom';
import { readNumberEnv, readStringEnv } from './env';
import { configureLoadedTileScene, createCesiumTilesRenderer } from './tiles';

/** 默认倾斜摄影 tileset（用户提供，直连，CORS=*，无需 token）。 */
const DEFAULT_OBLIQUE_URL =
	'https://sooncps.xwbuilders.com/api/ugis-dataprocess/v1/model/taz4Wo8Q5/tileset.json';

const PLOT_RECTANGLE_CENTER_EAST_UNITS = 3.2;
const PLOT_RECTANGLE_CENTER_NORTH_UNITS = 2.0;
const PLOT_RECTANGLE_HALF_WIDTH_UNITS = 1.0;
const PLOT_RECTANGLE_HALF_HEIGHT_UNITS = 0.7;

const RECTANGLE_GLB_MODEL_URL = encodeURI(
	readStringEnv( 'VITE_RECTANGLE_GLB_MODEL_URL', '/Untitle.glb' ),
);

// const RECTANGLE_GLB_MODEL_URL = encodeURI(
// 	readStringEnv( 'VITE_RECTANGLE_GLB_MODEL_URL', '/model_2026-06-24 (11).glb' ),
// );

const RECTANGLE_GLB_DRACO_DECODER_PATH = '/draco/gltf/';
const RECTANGLE_GLB_MODEL_SCALE = Math.max(
	readNumberEnv( 'VITE_RECTANGLE_GLB_MODEL_SCALE', 1.0 ),
	1.0e-6,
);
const RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS =
	readNumberEnv( 'VITE_RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS', 0.0 );
const RECTANGLE_GLB_MODEL_HEADING_DEGREES =
	readNumberEnv( 'VITE_RECTANGLE_GLB_MODEL_HEADING_DEGREES', 0.0 );
const RECTANGLE_GLB_RENDER_LAYER = 2;
const ACTIVE_RENDER_GRACE_MS = 1200;
const IDLE_RENDER_INTERVAL_MS = 250;

/**
 * 首帧相机的"位置提示"——仅在倾斜瓦片包围球就绪前给一个合理的初始视角，
 * 让根 tileset 尽快进入加载；真正的中心在运行时由 getBoundingSphere 反算后
 * flyToModel 修正。取默认 URL 的大致位置（陕西），自定义 URL 也会在数帧内自动归位。
 */
const INITIAL_HINT_LON = 110.39;
const INITIAL_HINT_LAT = 33.01;

/** 合成楼房中心（buildings 兜底源专用）。 */
const BUILDINGS_LON = 120.0;
const BUILDINGS_LAT = 30.0;

/** classificationType 字面量 ↔ 枚举值映射（GUI 下拉用）。 */
const TYPE_MAP: Record<string, ClassificationType> = {
	TERRAIN: ClassificationType.TERRAIN,
	CESIUM_3D_TILE: ClassificationType.CESIUM_3D_TILE,
	BOTH: ClassificationType.BOTH,
};

/** 模型来源。 */
type ModelSource = 'oblique' | 'ion' | 'buildings';

/** 数值钳位。 */
function clamp( value: number, min: number, max: number ): number {
	return Math.min( max, Math.max( min, value ) );
}

function setObjectLayerRecursive( object: Object3D, layer: number ): void {
	object.traverse( child => child.layers.set( layer ) );
}

type RuntimeTilesRenderer = TilesRenderer & {
	lruCache?: {
		itemSet?: Map<unknown, unknown>;
		remove?: ( item: unknown ) => boolean;
		markAllUnused?: () => void;
		scheduleUnload?: () => void;
	};
};

function unloadTilesRendererContent( tiles: TilesRenderer | null ): void {
	if ( ! tiles ) return;

	const lruCache = ( tiles as RuntimeTilesRenderer ).lruCache;
	if ( ! lruCache ) return;

	if ( lruCache.itemSet && lruCache.remove ) {
		for ( const tile of Array.from( lruCache.itemSet.keys() ) ) {
			lruCache.remove( tile );
		}
		return;
	}

	lruCache.markAllUnused?.();
	lruCache.scheduleUnload?.();
}

/**
 * 解析模型来源：`?model=oblique|ion|buildings` 或 VITE_MODEL_SOURCE 强制；
 * 缺省 oblique（贴倾斜测试是本 demo 的主线）。
 */
function pickModelSource(): ModelSource {
	const fromUrl = new URLSearchParams( window.location.search ).get( 'model' );
	const fromEnv = readStringEnv( 'VITE_MODEL_SOURCE' );
	const choice = ( fromUrl ?? fromEnv ?? '' ).trim().toLowerCase();
	if ( choice === 'buildings' ) return 'buildings';
	if ( choice === 'ion' ) return 'ion';
	return 'oblique';
}

/**
 * 在 (lon°, lat°) 处生成一栋"楼"：底面贴椭球面，沿椭球法线向上挤出 heightMeters。
 */
function makeBuilding(
	lonDeg: number,
	latDeg: number,
	footprint: number,
	heightMeters: number,
	color: number,
): Mesh {
	const geometry = new BoxGeometry( footprint, footprint, heightMeters );
	geometry.translate( 0, 0, heightMeters * 0.5 );

	const material = new MeshStandardMaterial( {
		color,
		roughness: 0.85,
		metalness: 0.0,
	} );
	// 贴模型成立的关键：模型材质必须写与 stencil / 兜底相同的 log 深度，否则主缓冲
	// 深度（stencil Z-fail 比对）与 packed 深度在 log/NDC 空间间错位，贴模型闪烁 / 错位。
	applyCesiumLogDepthToMaterial( material );

	const mesh = new Mesh( geometry, material );
	mesh.frustumCulled = false;

	const origin = wgs84PositionFromDegrees( lonDeg, latDeg, 0.0 );
	const enu = eastNorthUpToFixedFrame( origin, new Matrix4() );
	mesh.matrixAutoUpdate = false;
	mesh.matrix.copy( enu );
	mesh.matrixWorldNeedsUpdate = true;

	return mesh;
}

/**
 * 在中心点附近生成一组高度各异、留有空地的"楼群"（buildings 兜底源）。
 */
function makeBuildingCluster( centerLon: number, centerLat: number ): Group {
	const group = new Group();
	group.name = 'synthetic-buildings';

	const step = 0.0006; // 约 60–70m
	const layout: Array<{ dx: number; dy: number; h: number; c: number }> = [
		{ dx: -1, dy: -1, h: 20, c: 0xb24a4a },
		{ dx: 0, dy: -1, h: 50, c: 0x4a78b2 },
		{ dx: 1, dy: -1, h: 35, c: 0x4ab27a },
		{ dx: -1, dy: 1, h: 120, c: 0xb2a14a },
		{ dx: 1, dy: 1, h: 80, c: 0x7a4ab2 },
	];
	for ( const b of layout ) {
		group.add( makeBuilding(
			centerLon + b.dx * step,
			centerLat + b.dy * step,
			40,
			b.h,
			b.c,
		) );
	}
	return group;
}

/**
 * 直连一个 tileset.json URL（倾斜摄影 / 普通 3D Tiles，不走 Cesium Ion）。
 * 加载的瓦片保留真实照片纹理（recolor:false），只统一 log 深度 / 不剔除 / 深度写。
 *
 * @param url tileset.json 的完整 URL。
 * @returns 配置好的 TilesRenderer。
 */
function createUrlTileset( url: string ): TilesRenderer {
	const tiles = new TilesRenderer( url );
	tiles.group.name = 'ObliqueUrlTilesGroup';
	tiles.errorTarget = 6.0;
	tiles.autoDisableRendererCulling = true;
	tiles.displayActiveTiles = true;
	tiles.addEventListener( 'load-model', ( { scene: modelScene }: { scene: Object3D } ) => {
		// 倾斜摄影：保留照片纹理（不要染绿）。
		configureLoadedTileScene( modelScene, { recolor: false } );
	} );
	return tiles;
}

/**
 * 若配置了 VITE_CESIUM_ION_MODEL_ASSET_ID，加载该 Ion 3D Tiles 模型作 tileset 贡献者。
 * 未配置（或无 token）时返回 null。
 */
function createIonModelTiles( ionToken: string ): TilesRenderer | null {
	const assetId = readStringEnv( 'VITE_CESIUM_ION_MODEL_ASSET_ID' );
	if ( assetId.length === 0 || ionToken.length === 0 ) {
		return null;
	}
	const tiles = new TilesRenderer();
	tiles.group.name = 'CesiumIonModelTilesGroup';
	tiles.registerPlugin( new CesiumIonAuthPlugin( {
		apiToken: ionToken,
		assetId,
	} ) );
	tiles.addEventListener( 'load-model', ( { scene: modelScene }: { scene: Object3D } ) => {
		configureLoadedTileScene( modelScene, { recolor: false } );
	} );
	return tiles;
}

/** 正多边形 ENU 偏移（米），rotationDeg 控制朝向。 */
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

/**
 * 在 (centerLon, centerLat) 周围摆放"全部标绘图形"：点（圆/方）、圆、扇形、矩形、
 * 多边形、折线（带箭头）、攻击箭头、燕尾攻击箭头、文字。所有尺寸以 u（米）为基准
 * 等比缩放，便于适配不同体量的模型。全部用同一 classificationType 入册，便于 GUI 联动。
 *
 * @param decals 标绘管理器。
 * @param centerLon 中心经度（度）。
 * @param centerLat 中心纬度（度）。
 * @param u 基准长度（米）：整组标绘大致铺在 ±6u 的范围内。
 * @param classificationType 入册时的分类目标。
 */
function rectangleCenterFromPlotCenter(
	centerLon: number,
	centerLat: number,
	u: number,
): { longitude: number; latitude: number } {
	const point = longitudeLatitudeFromCenterOffsetsMeters(
		centerLon,
		centerLat,
		[ {
			eastMeters: PLOT_RECTANGLE_CENTER_EAST_UNITS * u,
			northMeters: PLOT_RECTANGLE_CENTER_NORTH_UNITS * u,
		} ],
	)[ 0 ];
	return { longitude: point.longitude, latitude: point.latitude };
}

function buildPlotsAround(
	decals: GroundDecalManager,
	centerLon: number,
	centerLat: number,
	u: number,
	classificationType: ClassificationType,
): void {
	const pts = (
		offs: { eastMeters: number; northMeters: number }[],
	): LonLatPoint[] =>
		longitudeLatitudeFromCenterOffsetsMeters( centerLon, centerLat, offs )
			.map( ( p ) => [ p.longitude, p.latitude ] as LonLatPoint );
	const pt = ( e: number, n: number ): LonLatPoint =>
		pts( [ { eastMeters: e, northMeters: n } ] )[ 0 ];
	const sw = Math.max( 0.5, u * 0.05 ); // 基准描边宽（米）

	// 中心圆
	decals.addPlot( {
		type: 'circle',
		points: [ pt( 0, 0 ) ],
		radius: u * 1.2,
		strokeColor: '#ffcc00',
		strokeWidth: sw,
		strokeOpacity: 100,
		fillColor: '#ffcc00',
		fillOpacity: 25,
		visible: true,
		classificationType,
	} );

	// 点 / 圆
	decals.addPlot( {
		type: 'point',
		points: [ pt( -2 * u, -1.6 * u ) ],
		pointStyle: 'circle',
		size: u * 0.7,
		strokeColor: '#ffffff',
		strokeWidth: Math.max( 0.3, sw * 0.3 ),
		strokeOpacity: 95,
		fillColor: '#ffaa00',
		fillOpacity: 90,
		visible: true,
		classificationType,
	} );

	// 点 / 方
	decals.addPlot( {
		type: 'point',
		points: [ pt( 2 * u, -1.6 * u ) ],
		pointStyle: 'square',
		size: u * 0.7,
		strokeColor: '#ffffff',
		strokeWidth: Math.max( 0.3, sw * 0.3 ),
		strokeOpacity: 95,
		fillColor: '#aa66ff',
		fillOpacity: 90,
		visible: true,
		classificationType,
	} );

	// 扇形
	decals.addPlot( {
		type: 'sector',
		points: [ pt( -3.6 * u, 2.0 * u ) ],
		radius: u * 1.4,
		startAngle: 30,
		sectorAngle: 120,
		strokeColor: '#ffffff',
		strokeWidth: sw,
		strokeOpacity: 95,
		fillColor: '#ff5577',
		fillOpacity: 55,
		visible: true,
		classificationType,
	} );

	// 矩形
	const rectangleCenterEast = PLOT_RECTANGLE_CENTER_EAST_UNITS * u;
	const rectangleCenterNorth = PLOT_RECTANGLE_CENTER_NORTH_UNITS * u;
	const rectangleHalfWidth = PLOT_RECTANGLE_HALF_WIDTH_UNITS * u;
	const rectangleHalfHeight = PLOT_RECTANGLE_HALF_HEIGHT_UNITS * u;
	decals.addPlot( {
		type: 'rectangle',
		points: pts( [
			{ eastMeters: rectangleCenterEast - rectangleHalfWidth, northMeters: rectangleCenterNorth - rectangleHalfHeight },
			{ eastMeters: rectangleCenterEast + rectangleHalfWidth, northMeters: rectangleCenterNorth - rectangleHalfHeight },
			{ eastMeters: rectangleCenterEast + rectangleHalfWidth, northMeters: rectangleCenterNorth + rectangleHalfHeight },
			{ eastMeters: rectangleCenterEast - rectangleHalfWidth, northMeters: rectangleCenterNorth + rectangleHalfHeight },
		] ),
		strokeColor: '#ffffff',
		strokeWidth: sw,
		strokeOpacity: 95,
		fillColor: '#ff3333',
		fillOpacity: 55,
		visible: true,
		classificationType,
	} );

	// 多边形（六边形）
	decals.addPlot( {
		type: 'polygon',
		points: pts( regularPolygonOffsets( -3.4 * u, -2.6 * u, u * 1.2, 6, 14 ) ),
		strokeColor: '#ffffff',
		strokeWidth: sw,
		strokeOpacity: 95,
		fillColor: '#00aaff',
		fillOpacity: 55,
		visible: true,
		classificationType,
	} );

	// 折线（虚线 + 末端实心箭头）
	decals.addPlot( {
		type: 'line',
		points: pts( [
			{ eastMeters: -4 * u, northMeters: 3.4 * u },
			{ eastMeters: -1.3 * u, northMeters: 3.9 * u },
			{ eastMeters: 1.3 * u, northMeters: 3.2 * u },
			{ eastMeters: 4 * u, northMeters: 3.8 * u },
		] ),
		strokeColor: '#ffd633',
		strokeWidth: Math.max( 1, u * 0.08 ),
		strokeOpacity: 95,
		fillColor: '#000000',
		fillOpacity: 0,
		visible: true,
		strokeStyle: 'dashed',
		showArrow: true,
		startArrowStyle: null,
		endArrowStyle: 'filledArrow',
		classificationType,
	} );

	// 攻击箭头
	decals.addPlot( {
		type: 'arrow',
		arrowType: 'attack',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		points: pts( [
			{ eastMeters: -3.2 * u, northMeters: -3.6 * u },
			{ eastMeters: -3.2 * u, northMeters: -3.2 * u },
			{ eastMeters: -0.6 * u, northMeters: -3.0 * u },
			{ eastMeters: 2.6 * u, northMeters: -3.5 * u },
		] ),
		strokeColor: '#ffffff',
		strokeWidth: Math.max( 0.3, sw * 0.4 ),
		strokeOpacity: 95,
		fillColor: '#33ddff',
		fillOpacity: 80,
		visible: true,
		classificationType,
	} );

	// 燕尾攻击箭头
	decals.addPlot( {
		type: 'arrow',
		arrowType: 'swallowtailAttack',
		sizeScale: 1.0,
		curvedBodyWidthFactor: 0.06,
		curvedHeadWidthFactor: 0.12,
		curvedHeadLengthFactor: 0.14,
		points: pts( [
			{ eastMeters: -3.2 * u, northMeters: -4.9 * u },
			{ eastMeters: -3.2 * u, northMeters: -4.5 * u },
			{ eastMeters: -0.6 * u, northMeters: -4.3 * u },
			{ eastMeters: 2.6 * u, northMeters: -4.8 * u },
		] ),
		strokeColor: '#ffffff',
		strokeWidth: Math.max( 0.3, sw * 0.4 ),
		strokeOpacity: 95,
		fillColor: '#ff9933',
		fillOpacity: 80,
		visible: true,
		classificationType,
	} );

	// 文字标签（放在整组标绘上方，避免与折线 / 矩形重叠）
	decals.addPlot( {
		type: 'text',
		points: [ pt( 0, 5.4 * u ) ],
		content: '贴倾斜测试',
		fontColor: '#ffffff',
		fontSize: 48,
		fillColor: '#1e3a8a',
		fillOpacity: 75,
		strokeColor: '#ffffff',
		strokeWidth: 4,
		strokeOpacity: 100,
		scale: Math.max( 0.4, u / 70 ),
		visible: true,
		classificationType,
	} );
}

/**
 * 运行"标绘贴模型 / 贴倾斜摄影" demo。
 */
export function runModelClampDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

	const app = document.getElementById( 'app' );
	if ( ! app ) {
		throw new Error( 'Missing #app container.' );
	}
	app.innerHTML = '';

	const source = pickModelSource();

	// ── 场景 / 灯光 ──
	const scene = new Scene();
	scene.background = new Color( 0x05070a );
	const ambient = new AmbientLight( 0xffffff, 0.65 );
	ambient.layers.enable( RECTANGLE_GLB_RENDER_LAYER );
	scene.add( ambient );
	const sun = new DirectionalLight( 0xffffff, 1.4 );
	sun.position.set( 0.35, -0.45, 0.82 ).normalize();
	sun.layers.enable( RECTANGLE_GLB_RENDER_LAYER );
	scene.add( sun );

	// ── 渲染器（stencil 必开——shadow volume Z-fail 依赖它）──
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

	// ── 相机（ECEF 上向 = Z；启用不可拾取图层让 shadow volume / 兜底网格参与渲染）──
	const camera = new PerspectiveCamera(
		55,
		window.innerWidth / window.innerHeight,
		0.1,
		40000000.0,
	);
	camera.up.set( 0.0, 0.0, 1.0 );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );

	// 首帧位置提示：放在初始 hint 上空约 12km，俯视，等包围球就绪后 flyToModel 修正。
	const hint = wgs84PositionFromDegrees( INITIAL_HINT_LON, INITIAL_HINT_LAT, 0.0 );
	camera.position.copy( hint ).addScaledVector(
		wgs84NormalFromDegrees( INITIAL_HINT_LON, INITIAL_HINT_LAT ),
		12000.0,
	);
	camera.lookAt( hint );
	camera.updateMatrixWorld();

	// ── 底图 / 椭球参考瓦片 ──
	// 有 Cesium Ion token 时：加载真实地形 + Cesium World Imagery 作「底图」，让倾斜
	//   模型不再悬在黑色虚空里，模型外的区域也有卫星影像；同时登记为 terrain 深度
	//   贡献者（TERRAIN / BOTH 时标绘可贴到底图）。
	// 无 token 时：退回一个空 TilesRenderer，仅给 GlobeControls 提供 ellipsoid + group
	//   （此时确实没有底图，背景为纯色——属预期降级）。
	let baseTiles: TilesRenderer;
	let hasBaseMap = false;
	try {
		baseTiles = createCesiumTilesRenderer( renderer );
		baseTiles.addEventListener( 'load-model', ( { scene: baseScene }: { scene: Object3D } ) => {
			// 底图保留真实卫星影像（recolor:false），只统一 log 深度 / 不剔除。
			configureLoadedTileScene( baseScene, { recolor: false } );
		} );
		hasBaseMap = true;
	} catch ( err ) {
		console.warn( '[model-clamp] 无底图（Cesium Ion 不可用，退回空椭球参考）:', err );
		baseTiles = new TilesRenderer( '' );
		baseTiles.group.name = 'CesiumEllipsoidReferenceGroup';
		baseTiles.registerPlugin( {
			name: 'NO_TERRAIN_PLUGIN',
			loadRootTileset: () => Promise.resolve( null ),
		} );
	}
	baseTiles.setCamera( camera );
	baseTiles.setResolutionFromRenderer( camera, renderer );
	requestRenderOnTileEvents( baseTiles );
	scene.add( baseTiles.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( baseTiles.ellipsoid, baseTiles.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 0.1;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	let renderQueued = false;
	let renderRequested = true;
	let continuousRenderUntil = performance.now() + ACTIVE_RENDER_GRACE_MS;
	let lastRenderAt = - Infinity;

	function requestRender(): void {
		renderRequested = true;
		if ( renderQueued ) return;
		renderQueued = true;
		requestAnimationFrame( renderFrame );
	}

	function requestActiveRender(): void {
		continuousRenderUntil = Math.max(
			continuousRenderUntil,
			performance.now() + ACTIVE_RENDER_GRACE_MS,
		);
		requestRender();
	}

	function requestRenderOnTileEvents( tiles: TilesRenderer ): void {
		for ( const type of [
			'needs-update',
			'load-content',
			'load-tileset',
			'load-root-tileset',
			'load-model',
			'dispose-model',
			'tile-visibility-change',
			'tiles-load-start',
			'tiles-load-end',
			'load-error',
		] ) {
			tiles.addEventListener( type, requestActiveRender );
		}
	}

	controls.addEventListener( 'start', requestActiveRender );
	controls.addEventListener( 'change', requestActiveRender );
	controls.addEventListener( 'end', requestActiveRender );

	// ── 深度管理器（兜底默认开启）+ 椭球兜底主网格接入主场景 ──
	const depthManager = new ClassificationDepthManager(
		renderer.domElement.width,
		renderer.domElement.height,
	);
	depthManager.attach( scene );

	// 底图作为 terrain 深度贡献者：TERRAIN / BOTH 时标绘可贴到底图地形表面。
	if ( hasBaseMap ) {
		depthManager.addContributor( baseTiles.group, 'terrain' );
	}

	// ── 标绘管理器：不传 globeDepth，兜底唯一归 depthManager（避免双重兜底）──
	const decals = new GroundDecalManager( { scene } );

	const rectangleGlbAnchor = new Group();
	rectangleGlbAnchor.name = 'ModelClampRectangleGlbAnchor';
	rectangleGlbAnchor.matrixAutoUpdate = false;
	rectangleGlbAnchor.visible = false;
	setObjectLayerRecursive( rectangleGlbAnchor, RECTANGLE_GLB_RENDER_LAYER );
	scene.add( rectangleGlbAnchor );

	const rectangleGlbLocalSize = new Vector3();
	let rectangleGlbScene: Object3D | null = null;
	let rectangleGlbStatus = 'waiting for rectangle';
	let rectangleGlbError = '';
	let rectangleGlbVisible = true;
	let rectangleGlbLon = Number.NaN;
	let rectangleGlbLat = Number.NaN;
	let rectangleGlbHeight = 0.0;

	// 贴倾斜 / 贴模型默认用 BOTH：模型表面贴模型、模型外贴椭球面兜底，标绘始终可见；
	// 想看"纯贴模型（无模型处掩掉）"切到 CESIUM_3D_TILE。
	let currentType: ClassificationType = ClassificationType.BOTH;
	let plotsVisible = true;

	// ── 模型来源装配 ──
	const ionToken = readStringEnv( 'VITE_CESIUM_ION_TOKEN' );
	let modelTiles: TilesRenderer | null = null; // oblique / ion 的瓦片渲染器
	let buildingCluster: Group | null = null;
	let modelSourceLabel = '';
	let resolvedSource: ModelSource = source;
	let tileLoadError = '';
	let modelTilesActive = true;
	let baseTilesActive = true;

	if ( source === 'ion' ) {
		modelTiles = createIonModelTiles( ionToken );
		if ( modelTiles ) {
			modelSourceLabel = `Ion model asset ${ readStringEnv( 'VITE_CESIUM_ION_MODEL_ASSET_ID' ) }`;
		} else {
			resolvedSource = 'buildings'; // 未配置 Ion → 退回楼房
		}
	} else if ( source === 'oblique' ) {
		const url = readStringEnv( 'VITE_OBLIQUE_TILESET_URL' ) || DEFAULT_OBLIQUE_URL;
		modelTiles = createUrlTileset( url );
		modelSourceLabel = `oblique URL: ${ url }`;
	}

	if ( modelTiles ) {
		modelTiles.setCamera( camera );
		modelTiles.setResolutionFromRenderer( camera, renderer );
		requestRenderOnTileEvents( modelTiles );
		scene.add( modelTiles.group );
		depthManager.addContributor( modelTiles.group, 'tileset' );
		modelTiles.addEventListener( 'load-error', ( event ) => {
			const err = ( event as unknown as { error?: { message?: string } } ).error;
			tileLoadError = err?.message ?? 'unknown';
		} );
	}

	if ( resolvedSource === 'buildings' ) {
		buildingCluster = makeBuildingCluster( BUILDINGS_LON, BUILDINGS_LAT );
		scene.add( buildingCluster );
		depthManager.addContributor( buildingCluster, 'tileset' );
		modelSourceLabel = 'synthetic buildings (5 boxes, center gap)';
	}

	// ── 运行时定位：拿到模型中心后摆标绘 + 飞过去（只做一次）──
	let plotsBuilt = false;
	let modelCenterEcef: Vector3 | null = null;
	let modelUp = new Vector3( 0, 0, 1 );
	let flyDistance = 3000.0;
	const scratchSphere = new Sphere();
	const scratchCarto: Cartographic = { longitude: 0, latitude: 0, height: 0 };

	function flyToModel(): void {
		if ( ! modelCenterEcef ) return;
		// 俯视图：相机置于模型中心正上方，沿椭球法线竖直向下俯瞰（纯 nadir，无水平偏移）。
		camera.position
			.copy( modelCenterEcef )
			.addScaledVector( modelUp, flyDistance );
		camera.lookAt( modelCenterEcef );
		camera.updateMatrixWorld();
		requestRender();
	}

	function applyPlotsVisibility(): void {
		decals.setSceneAttached( plotsVisible );
	}

	function updateRectangleGlbAnchorTransform(): void {
		if ( ! Number.isFinite( rectangleGlbLon ) || ! Number.isFinite( rectangleGlbLat ) ) {
			rectangleGlbAnchor.visible = false;
			return;
		}

		const origin = wgs84PositionFromDegrees(
			rectangleGlbLon,
			rectangleGlbLat,
			rectangleGlbHeight + RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS,
		);
		const enu = eastNorthUpToFixedFrame( origin, new Matrix4() );
		if ( RECTANGLE_GLB_MODEL_HEADING_DEGREES !== 0.0 ) {
			enu.multiply( new Matrix4().makeRotationZ(
				RECTANGLE_GLB_MODEL_HEADING_DEGREES * Math.PI / 180.0,
			) );
		}
		rectangleGlbAnchor.matrix.copy( enu );
		rectangleGlbAnchor.matrixWorldNeedsUpdate = true;
		rectangleGlbAnchor.visible = rectangleGlbVisible && rectangleGlbScene !== null;
	}

	function flyToRectangleGlb(): void {
		if ( ! Number.isFinite( rectangleGlbLon ) || ! Number.isFinite( rectangleGlbLat ) ) {
			return;
		}

		const modelHeight = rectangleGlbLocalSize.z > 0.0 ? rectangleGlbLocalSize.z : 40.0;
		const focus = wgs84PositionFromDegrees(
			rectangleGlbLon,
			rectangleGlbLat,
			rectangleGlbHeight + RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS + modelHeight * 0.35,
		);
		const glbUp = wgs84NormalFromDegrees( rectangleGlbLon, rectangleGlbLat );
		const glbEast = new Vector3( - glbUp.y, glbUp.x, 0.0 ).normalize();
		const span = Math.max(
			rectangleGlbLocalSize.x,
			rectangleGlbLocalSize.y,
			rectangleGlbLocalSize.z,
			120.0,
		);
		const distance = clamp( span * 2.2, 240.0, 4500.0 );

		camera.position
			.copy( focus )
			.addScaledVector( glbUp, distance )
			.addScaledVector( glbEast, distance * 0.28 );
		camera.lookAt( focus );
		camera.updateMatrixWorld();
		requestRender();
	}

	function prepareRectangleGlbModel( modelScene: Object3D ): void {
		modelScene.name = modelScene.name || 'ModelClampRectangleGlbModel';
		setObjectLayerRecursive( modelScene, RECTANGLE_GLB_RENDER_LAYER );
		modelScene.scale.multiplyScalar( RECTANGLE_GLB_MODEL_SCALE );
		modelScene.updateMatrixWorld( true );

		const bounds = new Box3().setFromObject( modelScene );
		if ( bounds.isEmpty() ) {
			rectangleGlbLocalSize.set( 0.0, 0.0, 0.0 );
			return;
		}

		bounds.getSize( rectangleGlbLocalSize );
	}

	function loadRectangleGlbModel(): void {
		rectangleGlbStatus = 'loading';
		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath( RECTANGLE_GLB_DRACO_DECODER_PATH );

		const gltfLoader = new GLTFLoader();
		gltfLoader.setDRACOLoader( dracoLoader );
		gltfLoader.load(
			RECTANGLE_GLB_MODEL_URL,
			gltf => {
				const modelScene = gltf.scene;
				prepareRectangleGlbModel( modelScene );
				modelScene.visible = true;
				rectangleGlbAnchor.add( modelScene );
				rectangleGlbScene = modelScene;
				rectangleGlbStatus = 'loaded';
				updateRectangleGlbAnchorTransform();
				dracoLoader.dispose();
				requestRender();
			},
			event => {
				if ( event.lengthComputable && event.total > 0 ) {
					const progress = Math.round( event.loaded / event.total * 100.0 );
					rectangleGlbStatus = `loading ${ progress }%`;
					requestRender();
				}
			},
			error => {
				rectangleGlbStatus = 'error';
				rectangleGlbError =
					error instanceof ErrorEvent
						? error.message
						: error instanceof Error
							? error.message
							: String( error );
				console.error( '[model-clamp] Failed to load rectangle GLB model:', error );
				dracoLoader.dispose();
				requestRender();
			},
		);
	}

	function placeRectangleGlbAtPlotRectangle(
		centerLon: number,
		centerLat: number,
		centerHeight: number,
		unit: number,
	): void {
		const rectangleCenter = rectangleCenterFromPlotCenter( centerLon, centerLat, unit );
		rectangleGlbLon = rectangleCenter.longitude;
		rectangleGlbLat = rectangleCenter.latitude;
		rectangleGlbHeight = centerHeight;
		updateRectangleGlbAnchorTransform();
	}

	function onModelReady(
		centerLon: number,
		centerLat: number,
		centerHeight: number,
		unit: number,
		dist: number,
	): void {
		if ( plotsBuilt ) return;
		plotsBuilt = true;

		buildPlotsAround( decals, centerLon, centerLat, unit, currentType );
		applyPlotsVisibility();
		placeRectangleGlbAtPlotRectangle( centerLon, centerLat, centerHeight, unit );

		modelCenterEcef = wgs84PositionFromDegrees( centerLon, centerLat, centerHeight );
		modelUp = wgs84NormalFromDegrees( centerLon, centerLat );
		flyDistance = dist;
		flyToModel();
	}

	loadRectangleGlbModel();

	// buildings 源：中心固定、无需等包围球，立即摆标绘 + 飞。
	if ( resolvedSource === 'buildings' ) {
		onModelReady( BUILDINGS_LON, BUILDINGS_LAT, 0.0, 14.0, 360.0 );
	}

	// ── GUI ──
	const params = {
		classificationType: 'BOTH' as 'TERRAIN' | 'CESIUM_3D_TILE' | 'BOTH',
		buildingsVisible: true,
		modelVisible: true,
		baseMapVisible: true,
		plotsVisible: true,
		rectangleGlbVisible: true,
		flyToModel,
		flyToRectangleGlb,
	};
	const gui = new GUI( { title: '标绘贴倾斜 / 贴模型 Demo' } );
	gui.add( params, 'plotsVisible' ).name( '显示标绘图形' ).onChange( ( v: boolean ) => {
		plotsVisible = v;
		applyPlotsVisibility();
		requestRender();
	} );
	gui.add( params, 'classificationType', [ 'TERRAIN', 'CESIUM_3D_TILE', 'BOTH' ] )
		.name( '分类目标' )
		.onChange( ( v: string ) => {
			currentType = TYPE_MAP[ v ];
			for ( const id of decals.getAllIds() ) {
				decals.setStyle( id, { classificationType: currentType } );
			}
			requestRender();
		} );
	if ( modelTiles ) {
		gui.add( params, 'modelVisible' ).name( '显示倾斜模型' ).onChange( ( v: boolean ) => {
			if ( modelTiles ) {
				modelTilesActive = v;
				modelTiles.group.visible = v;
				if ( ! v ) {
					unloadTilesRendererContent( modelTiles );
				}
				requestRender();
			}
		} );
	}
	if ( hasBaseMap ) {
		gui.add( params, 'baseMapVisible' ).name( '显示底图' ).onChange( ( v: boolean ) => {
			baseTilesActive = v;
			baseTiles.group.visible = v;
			if ( ! v ) {
				unloadTilesRendererContent( baseTiles );
			}
			requestRender();
		} );
	}
	if ( resolvedSource === 'buildings' ) {
		gui.add( params, 'buildingsVisible' ).name( '显示楼群' ).onChange( ( v: boolean ) => {
			if ( buildingCluster ) {
				buildingCluster.visible = v;
				requestRender();
			}
		} );
	}
	gui.add( params, 'rectangleGlbVisible' ).name( '显示矩形 GLB' ).onChange( ( v: boolean ) => {
		rectangleGlbVisible = v;
		updateRectangleGlbAnchorTransform();
		requestRender();
	} );
	gui.add( params, 'flyToRectangleGlb' ).name( '定位矩形 GLB' );
	gui.add( params, 'flyToModel' ).name( '回到模型' );

	// ── resize ──
	function resize(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setSize( width, height );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
		if ( baseTilesActive ) {
			baseTiles.setResolutionFromRenderer( camera, renderer );
		}
		if ( modelTiles && modelTilesActive ) {
			modelTiles.setResolutionFromRenderer( camera, renderer );
		}
		depthManager.resize( renderer.domElement.width, renderer.domElement.height );
		requestRender();
	}
	window.addEventListener( 'resize', resize );

	// ── 渲染循环 ──
	// 单帧逻辑抽成 step()，renderFrame 负责 rAF 调度。step 也挂到 __demo 上，方便在
	// 隐藏标签页（rAF 被节流）的无头环境里手动逐帧驱动做验证。
	function step(): void {
		controls.update();
		camera.updateMatrixWorld();

		if ( baseTilesActive ) {
			baseTiles.setResolutionFromRenderer( camera, renderer );
			baseTiles.update();
		}
		if ( modelTiles && modelTilesActive ) {
			modelTiles.setResolutionFromRenderer( camera, renderer );
			modelTiles.update();
		}

		// tileset 源（oblique / ion）：等包围球就绪 → 反算中心 → 摆标绘 + 飞过去。
		if ( modelTiles && modelTilesActive && ! plotsBuilt && modelTiles.getBoundingSphere( scratchSphere ) ) {
			const carto = cartesianToCartographic( scratchSphere.center, scratchCarto );
			if ( carto ) {
				const lon = ( carto.longitude * 180.0 ) / Math.PI;
				const lat = ( carto.latitude * 180.0 ) / Math.PI;
				const r = scratchSphere.radius;
				// 基准长度随模型体量缩放（标绘铺在 ±6 单位内），相机高度同理。
				// 放大基准让标绘铺满倾斜模型「周围」更大范围，远观也清晰可见。
				const unit = clamp( r * 0.05, 120.0, 700.0 );
				// 俯视高度：让 ±6 单位的标绘簇舒适落在竖直 FOV 内（约 ±0.52·高度）。
				const dist = clamp( r * 0.6, 2500.0, 12000.0 );
				onModelReady( lon, lat, carto.height, unit, dist );
			}
		}

		// A. 刷新共享 log-depth uniform（renderDepth 之前）。
		depthManager.update( camera );

		// B. 本帧需要哪些分类目标纹理。
		if ( plotsVisible ) {
			const requestedTypes = decals.collectActiveClassificationTypes();
			if ( requestedTypes.size === 0 ) {
				requestedTypes.add( ClassificationType.BOTH );
			}

			// C. 渲染所需深度纹理（懒创建，只渲请求目标）。
			depthManager.renderDepth( renderer, camera, scene, requestedTypes );

			// D. 选默认 depthTexture + 附多纹理集，透传给标绘。
			const defaultTex =
				depthManager.getTexture( currentType ) ??
				depthManager.getTexture( ClassificationType.BOTH ) ??
				depthManager.getTexture( ClassificationType.TERRAIN ) ??
				depthManager.getTexture( ClassificationType.CESIUM_3D_TILE );

			if ( defaultTex ) {
				decals.update( depthManager.buildFrameState( {
					depthTexture: defaultTex,
					width: renderer.domElement.width,
					height: renderer.domElement.height,
					camera,
					pixelRatio: renderer.getPixelRatio(),
				} ) );
			}
		}

		// E. 主场景渲染。
		const previousCameraLayerMask = camera.layers.mask;
		camera.layers.disable( RECTANGLE_GLB_RENDER_LAYER );
		renderer.render( scene, camera );
		if ( rectangleGlbAnchor.visible && rectangleGlbAnchor.children.length > 0 ) {
			const previousAutoClear = renderer.autoClear;
			const previousBackground = scene.background;
			renderer.autoClear = false;
			scene.background = null;
			try {
				renderer.clearDepth();
				camera.layers.set( RECTANGLE_GLB_RENDER_LAYER );
				renderer.render( scene, camera );
			} finally {
				scene.background = previousBackground;
				renderer.autoClear = previousAutoClear;
			}
		}
		camera.layers.mask = previousCameraLayerMask;

		const centerLine = modelCenterEcef
			? `中心: ${ ( ( cartesianToCartographic( modelCenterEcef, scratchCarto )?.longitude ?? 0 ) * 180 / Math.PI ).toFixed( 4 ) }, ` +
				`${ ( ( cartesianToCartographic( modelCenterEcef, scratchCarto )?.latitude ?? 0 ) * 180 / Math.PI ).toFixed( 4 ) }`
			: '中心: 等待模型包围球…';
		const rectangleGlbLine =
			Number.isFinite( rectangleGlbLon ) && Number.isFinite( rectangleGlbLat )
				? `Rectangle GLB: ${ rectangleGlbStatus } / center ${ rectangleGlbLon.toFixed( 4 ) }, ${ rectangleGlbLat.toFixed( 4 ) } / size ${ rectangleGlbLocalSize.x.toFixed( 1 ) } x ${ rectangleGlbLocalSize.y.toFixed( 1 ) } x ${ rectangleGlbLocalSize.z.toFixed( 1 ) } m`
				: `Rectangle GLB: ${ rectangleGlbStatus } / waiting for rectangle center`;

		infoBody.textContent =
			`贴倾斜 / 贴模型 Demo（ClassificationDepthManager）\n` +
			`模型来源: ${ modelSourceLabel }\n` +
			`当前分类目标: ${ params.classificationType }（切 CESIUM_3D_TILE 看纯贴模型）\n` +
			`标绘已就位: ${ plotsBuilt ? '是' : '否（等待模型加载）' }\n` +
			`${ centerLine }\n` +
			`${ rectangleGlbLine }\n` +
			( rectangleGlbError ? `Rectangle GLB error: ${ rectangleGlbError }\n` : '' ) +
			( tileLoadError ? `瓦片加载错误: ${ tileLoadError }\n` : '' ) +
			`Drawing buffer: ${ renderer.domElement.width } x ${ renderer.domElement.height }`;
	}

	function renderFrame( now: number ): void {
		renderQueued = false;
		const shouldRender =
			renderRequested ||
			now <= continuousRenderUntil ||
			now - lastRenderAt >= IDLE_RENDER_INTERVAL_MS;

		if ( shouldRender ) {
			renderRequested = false;
			lastRenderAt = now;
			step();
		}

		if ( ! renderQueued ) {
			renderQueued = true;
			requestAnimationFrame( renderFrame );
		}
	}

	( window as unknown as { __demo?: unknown } ).__demo = {
		renderer,
		scene,
		camera,
		controls,
		depthManager,
		decals,
		modelTiles,
		baseTiles,
		hasBaseMap,
		rectangleGlbAnchor,
		step,
		get buildingCluster() {
			return buildingCluster;
		},
		get rectangleGlbScene() {
			return rectangleGlbScene;
		},
		get rectangleGlbStatus() {
			return rectangleGlbStatus;
		},
		get rectangleGlbLocalSize() {
			return rectangleGlbLocalSize;
		},
	};

	requestRender();
}
