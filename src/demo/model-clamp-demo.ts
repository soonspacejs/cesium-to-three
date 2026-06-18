// ============================================================
// model-clamp-demo.ts
// 层级：贴模型 / 倾斜摄影 demo（标绘贴 3D Tiles 模型）。
// 职责：直观验证"标绘贴模型"，并能切换 classificationType 对比
//      TERRAIN / CESIUM_3D_TILE / BOTH 三种效果。两种模型来源：
//        1. 合成楼房盒子（零依赖，必做）——在标绘中心附近用 BoxGeometry 拼一组
//           高度各异、留有空地的"楼群"，登记为 tileset 深度贡献者。证明贴模型
//           算法独立于具体数据源，是最佳可复现验证。
//        2. 可选 Ion 倾斜 / 3D Tiles 模型——配置 VITE_CESIUM_ION_MODEL_ASSET_ID
//           且有 token 时，另起一个 TilesRenderer 加载该资产作 tileset 贡献者。
// 依赖：three、um-3d-tiles-renderer、lil-gui、lib/ground（ClassificationDepthManager
//      / ClassificationType / ENU / WGS84 / log 深度）、lib/plot（GroundDecalManager）、
//      demo/dom、demo/env、demo/tiles。
// 被消费：main.ts（?demo=model 或 VITE_DEMO=model）。
//
// ── 三种 classificationType 的视觉预期（合成楼房 + 中心留空地）──────────
//   | 类型           | 楼顶/立面 | 楼间空地（中心） | 远处无模型     |
//   | TERRAIN        | 不显示    | 贴地面/椭球面    | 贴地面/椭球面  |
//   | CESIUM_3D_TILE | 贴模型    | 不着色（哨兵掩掉）| 不着色         |
//   | BOTH           | 贴模型    | 贴地面/椭球面    | 贴地面/椭球面  |
//   切 GUI"分类目标"三档应能明显看出差异——这就是贴模型功能的最终验收。
// ============================================================

import GUI from 'lil-gui';
import {
	AmbientLight,
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
	Vector3,
	WebGLRenderer,
} from 'three';
import { GlobeControls, TilesRenderer } from 'um-3d-tiles-renderer';
import { CesiumIonAuthPlugin } from 'um-3d-tiles-renderer/core/plugins';

import {
	applyCesiumLogDepthToMaterial,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	ClassificationDepthManager,
	ClassificationType,
	eastNorthUpToFixedFrame,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
} from '../lib/ground';
import { GroundDecalManager } from '../lib/plot';

import { createInfoPanel, installPageStyle } from './dom';
import { readStringEnv } from './env';
import { configureLoadedTileScene } from './tiles';

/** 楼群中心（示例：可对准 Ion 模型或随意一处）。 */
const CENTER_LON = 120.0;
const CENTER_LAT = 30.0;

/** classificationType 字面量 ↔ 枚举值映射（GUI 下拉用）。 */
const TYPE_MAP: Record<string, ClassificationType> = {
	TERRAIN: ClassificationType.TERRAIN,
	CESIUM_3D_TILE: ClassificationType.CESIUM_3D_TILE,
	BOTH: ClassificationType.BOTH,
};

/**
 * 在 (lon°, lat°) 处生成一栋"楼"：底面贴椭球面，沿椭球法线向上挤出 heightMeters。
 *
 * @param lonDeg 经度（度）。
 * @param latDeg 纬度（度）。
 * @param footprint 平面足迹边长（米，正方形）。
 * @param heightMeters 楼高（米）。
 * @param color 楼体颜色。
 * @returns 配置好（log 深度 / 不剔除）的 Mesh，ENU 摆放，局部 +Z 朝天。
 */
function makeBuilding(
	lonDeg: number,
	latDeg: number,
	footprint: number,
	heightMeters: number,
	color: number,
): Mesh {
	// 盒子：X/Y 为足迹、Z 为高度；平移 +Z 半高，使底面落在 z=0（即椭球面）。
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
	mesh.frustumCulled = false; // 防止视锥剔除把贡献深度的网格剔掉

	// ENU 基底：把局部 (E, N, U) 映射到 ECEF；U(+Z) = 椭球法线（朝天）。
	const origin = wgs84PositionFromDegrees( lonDeg, latDeg, 0.0 );
	const enu = eastNorthUpToFixedFrame( origin, new Matrix4() );
	mesh.matrixAutoUpdate = false;
	mesh.matrix.copy( enu );
	mesh.matrixWorldNeedsUpdate = true;

	return mesh;
}

/**
 * 在中心点附近生成一组高度各异、留有空地的"楼群"。
 * 高度差异 + 楼间空地用于直观验证：
 *   - 楼顶 / 立面贴模型；
 *   - 楼间空地贴地形（BOTH）或不着色（CESIUM_3D_TILE）。
 *
 * @param centerLon 中心经度（度）。
 * @param centerLat 中心纬度（度）。
 * @returns 含全部楼体的 Group（登记为 tileset 贡献者）。
 */
function makeBuildingCluster( centerLon: number, centerLat: number ): Group {
	const group = new Group();
	group.name = 'synthetic-buildings';

	// 经纬度步进：约 0.0006° ≈ 60–70m（够拉开楼间距）。
	const step = 0.0006;
	const layout: Array<{ dx: number; dy: number; h: number; c: number }> = [
		{ dx: -1, dy: -1, h: 20, c: 0xb24a4a },
		{ dx: 0, dy: -1, h: 50, c: 0x4a78b2 },
		{ dx: 1, dy: -1, h: 35, c: 0x4ab27a },
		{ dx: -1, dy: 1, h: 120, c: 0xb2a14a }, // 高楼，验证 ±55km 阴影体覆盖
		{ dx: 1, dy: 1, h: 80, c: 0x7a4ab2 },
		// 中心 (0,0) 留空地：用来看"楼间空地"的贴地形 / 掩掉对比
	];
	for ( const b of layout ) {
		group.add( makeBuilding(
			centerLon + b.dx * step,
			centerLat + b.dy * step,
			40, // 足迹 40m
			b.h,
			b.c,
		) );
	}
	return group;
}

/**
 * 若配置了 VITE_CESIUM_ION_MODEL_ASSET_ID，加载该 Ion 3D Tiles 模型作 tileset 贡献者。
 * 未配置（或无 token）时返回 null（退回合成楼房）。
 *
 * @param ionToken Ion 访问令牌（VITE_CESIUM_ION_TOKEN）。
 * @returns 配置好的 TilesRenderer 或 null。
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
	// 模型瓦片与地形同样配置：log 深度 + 不剔除 + 同 renderOrder。
	tiles.addEventListener( 'load-model', ( { scene: modelScene }: { scene: Object3D } ) => {
		configureLoadedTileScene( modelScene );
	} );
	return tiles;
}

/**
 * 运行"标绘贴模型 / 倾斜摄影" demo。
 */
export function runModelClampDemo(): void {
	installPageStyle();
	const infoBody = createInfoPanel();

	const app = document.getElementById( 'app' );
	if ( ! app ) {
		throw new Error( 'Missing #app container.' );
	}
	app.innerHTML = '';

	// ── 场景 / 灯光 ──
	const scene = new Scene();
	scene.background = new Color( 0x05070a );
	scene.add( new AmbientLight( 0xffffff, 0.55 ) );
	const sun = new DirectionalLight( 0xffffff, 1.6 );
	sun.position.set( 0.35, -0.45, 0.82 ).normalize();
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

	// 相机预设：楼群中心上方约 360m，向东 + 抬高俯视，让楼群与中心空地完整可见。
	const target = wgs84PositionFromDegrees( CENTER_LON, CENTER_LAT, 0.0 );
	const up = wgs84NormalFromDegrees( CENTER_LON, CENTER_LAT );
	const eastBias = new Vector3( -up.y, up.x, 0.0 ).normalize();
	function flyToCluster(): void {
		camera.position
			.copy( target )
			.addScaledVector( up, 360.0 )
			.addScaledVector( eastBias, 220.0 );
		camera.lookAt( target );
		camera.updateMatrixWorld();
	}
	flyToCluster();

	// ── 椭球参考瓦片（无地形：空 TilesRenderer，仅提供 ellipsoid + group 给
	//    GlobeControls；不需要 token）。它的 group 始终为空，整个屏幕处于"无地形"，
	//    由 ClassificationDepthManager 的椭球兜底承担 terrain/both 的地面深度。──
	const ellipsoidTiles = new TilesRenderer( '' );
	ellipsoidTiles.group.name = 'CesiumEllipsoidReferenceGroup';
	ellipsoidTiles.registerPlugin( {
		name: 'NO_TERRAIN_PLUGIN',
		loadRootTileset: () => Promise.resolve( null ),
	} );
	ellipsoidTiles.setCamera( camera );
	ellipsoidTiles.setResolutionFromRenderer( camera, renderer );
	scene.add( ellipsoidTiles.group );

	const controls = new GlobeControls( scene, camera, renderer.domElement );
	controls.setEllipsoid( ellipsoidTiles.ellipsoid, ellipsoidTiles.group );
	controls.enableDamping = true;
	controls.dampingFactor = 0.14;
	controls.minDistance = 0.1;
	controls.maxDistance = 30000000.0;
	controls.adjustHeight = true;

	// ── 深度管理器（兜底默认开启）+ 椭球兜底主网格接入主场景 ──
	const depthManager = new ClassificationDepthManager(
		renderer.domElement.width,
		renderer.domElement.height,
	);
	depthManager.attach( scene );

	// ── 模型来源：优先 Ion 模型，否则合成楼房（始终可跑）──
	const ionToken = readStringEnv( 'VITE_CESIUM_ION_TOKEN' );
	const ionModel = createIonModelTiles( ionToken );
	let buildingCluster: Group | null = null;
	let modelSourceLabel = '';
	if ( ionModel ) {
		ionModel.setCamera( camera );
		ionModel.setResolutionFromRenderer( camera, renderer );
		scene.add( ionModel.group );
		depthManager.addContributor( ionModel.group, 'tileset' );
		modelSourceLabel = `Ion model asset ${ readStringEnv( 'VITE_CESIUM_ION_MODEL_ASSET_ID' ) }`;
	} else {
		buildingCluster = makeBuildingCluster( CENTER_LON, CENTER_LAT );
		scene.add( buildingCluster );
		depthManager.addContributor( buildingCluster, 'tileset' );
		modelSourceLabel = 'synthetic buildings (5 boxes, center gap)';
	}

	// ── 标绘管理器：不传 globeDepth，兜底唯一归 depthManager（避免双重兜底）──
	const decals = new GroundDecalManager( { scene } );

	// 在楼群上画标绘（覆盖中心空地 + 楼顶）。初始 BOTH。
	decals.addPlot( {
		type: 'circle',
		points: [ [ CENTER_LON, CENTER_LAT ] ],
		radius: 120,
		strokeColor: '#ffcc00',
		strokeWidth: 3,
		strokeOpacity: 100,
		fillColor: '#ffcc00',
		fillOpacity: 30,
		visible: true,
		classificationType: ClassificationType.BOTH,
	} );
	decals.addPlot( {
		type: 'polygon',
		points: [
			[ CENTER_LON - 0.0009, CENTER_LAT - 0.0009 ],
			[ CENTER_LON + 0.0009, CENTER_LAT - 0.0009 ],
			[ CENTER_LON + 0.0009, CENTER_LAT + 0.0009 ],
			[ CENTER_LON - 0.0009, CENTER_LAT + 0.0009 ],
		],
		strokeColor: '#00e5ff',
		strokeWidth: 2,
		strokeOpacity: 100,
		fillColor: '#00e5ff',
		fillOpacity: 20,
		visible: true,
		classificationType: ClassificationType.BOTH,
	} );
	decals.addPlot( {
		type: 'text',
		points: [ [ CENTER_LON, CENTER_LAT ] ],
		content: '贴模型',
		fontColor: '#ffffff',
		fontSize: 64,
		fillColor: '#1e3a8a',
		fillOpacity: 70,
		strokeColor: '#ffffff',
		strokeWidth: 4,
		strokeOpacity: 100,
		scale: 0.6, // 桥接器映射为 metersPerPixel（每纹素 0.6m 足迹）
		visible: true,
		classificationType: ClassificationType.BOTH,
	} );

	let currentType: ClassificationType = ClassificationType.BOTH;

	// ── GUI ──
	const params = {
		classificationType: 'BOTH' as 'TERRAIN' | 'CESIUM_3D_TILE' | 'BOTH',
		buildingsVisible: true,
		flyToCluster,
	};
	const gui = new GUI( { title: '标绘贴模型 Demo' } );
	gui.add( params, 'classificationType', [ 'TERRAIN', 'CESIUM_3D_TILE', 'BOTH' ] )
		.name( '分类目标' )
		.onChange( ( v: string ) => {
			currentType = TYPE_MAP[ v ];
			// 联动：所有标绘切到新目标（setStyle 浅合并 → 重建图元）。
			for ( const id of decals.getAllIds() ) {
				decals.setStyle( id, { classificationType: currentType } );
			}
		} );
	if ( buildingCluster ) {
		gui.add( params, 'buildingsVisible' ).name( '显示楼群' ).onChange( ( v: boolean ) => {
			if ( buildingCluster ) {
				buildingCluster.visible = v;
			}
		} );
	}
	gui.add( params, 'flyToCluster' ).name( '回到楼群' );

	// ── resize ──
	function resize(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setSize( width, height );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld();
		ellipsoidTiles.setResolutionFromRenderer( camera, renderer );
		ionModel?.setResolutionFromRenderer( camera, renderer );
		depthManager.resize( renderer.domElement.width, renderer.domElement.height );
	}
	window.addEventListener( 'resize', resize );

	// ── 渲染循环 ──
	function renderFrame(): void {
		controls.update();
		camera.updateMatrixWorld();

		ellipsoidTiles.setResolutionFromRenderer( camera, renderer );
		ellipsoidTiles.update();
		ionModel?.setResolutionFromRenderer( camera, renderer );
		ionModel?.update();

		// A. 刷新共享 log-depth uniform（renderDepth 之前）。
		depthManager.update( camera );

		// B. 本帧需要哪些分类目标纹理：从活跃标绘收集（多数为单一 currentType）。
		const requestedTypes = decals.collectActiveClassificationTypes();
		if ( requestedTypes.size === 0 ) {
			requestedTypes.add( ClassificationType.BOTH ); // 防御：避免无纹理可用
		}

		// C. 渲染所需深度纹理（懒创建，只渲请求目标）。
		depthManager.renderDepth( renderer, camera, scene, requestedTypes );

		// D. 选默认 depthTexture（resolve 的回退）+ 附多纹理集，透传给标绘。
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

		// E. 主场景渲染。
		renderer.render( scene, camera );

		infoBody.textContent =
			`贴模型 / 倾斜摄影 Demo（ClassificationDepthManager）\n` +
			`模型来源: ${ modelSourceLabel }\n` +
			`当前分类目标: ${ params.classificationType }\n` +
			`活跃目标数（本帧渲染纹理数）: ${ requestedTypes.size }\n` +
			`中心: ${ CENTER_LON.toFixed( 4 ) }, ${ CENTER_LAT.toFixed( 4 ) }\n` +
			`TERRAIN=楼下地面 / CESIUM_3D_TILE=贴楼面(空地掩掉) / BOTH=楼面+空地\n` +
			`Drawing buffer: ${ renderer.domElement.width } x ${ renderer.domElement.height }`;

		requestAnimationFrame( renderFrame );
	}

	( window as unknown as { __demo?: unknown } ).__demo = {
		renderer,
		scene,
		camera,
		controls,
		depthManager,
		decals,
		ionModel,
		get buildingCluster() {
			return buildingCluster;
		},
	};

	renderFrame();
}
