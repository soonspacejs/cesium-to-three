// ============================================================
// tiles.ts
// 层级:3d-tiles-renderer demo 集成。
// 职责:配置 Cesium Ion 地形、统一已加载瓦片材质，并给每个地形 shader 注入
//      Cesium 兼容的对数深度，使主帧缓冲深度与贴地 classification 的
//      shadow-volume color pass 保持一致。
// 依赖:Three.js、3d-tiles-renderer、demo env helpers、ground adapter。
// 被消费:ground-demo.ts。
// ============================================================

import {
	Color,
	FrontSide,
	type Material,
	type Object3D,
	type WebGLRenderer,
} from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins';
import {
	CesiumIonOverlay,
	ImageOverlayPlugin,
	QuantizedMeshPlugin,
} from '3d-tiles-renderer/three/plugins';

import { applyCesiumLogDepthToMaterial } from '../lib/ground';
import { readStringEnv } from './env';

export interface TilesRuntimeStats {
	inCache: number;
	visible: number;
	loaded: number;
	queued: number;
	downloading: number;
	parsing: number;
	failed: number;
}

export interface TileRuntimeCounters {
	modelsLoaded: number;
	modelsVisible: number;
	rootLoaded: boolean;
	rootUrl: string;
}

/**
 * 为 3d-tiles-renderer 加载的每个模型设置稳定渲染状态。
 *
 * @param modelScene 已加载瓦片创建的根对象。
 */
export function configureLoadedTileScene( modelScene: Object3D ): void {
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

				applyCesiumLogDepthToMaterial( material );
			}
		}
	} );
}

/**
 * 创建由 Cesium Ion 驱动的 3D Tiles 渲染器。地形资产由 QuantizedMeshPlugin 处理，
 * 表面是真实地形几何而非椭球体。同时通过 ImageOverlayPlugin + CesiumIonOverlay
 * 把 Cesium 世界影像服务(asset id = 2)叠加到地形之上,瓦片表面才有真实影像而不是
 * 纯色着色。
 *
 * 参考实现:3DTilesRendererJS/example/three/plot/touchGround.js 的 reinstantiateTiles。
 *
 * @param renderer 主 WebGLRenderer,ImageOverlayPlugin 用它把瓦片纹理渲染到 RT。
 * @returns 配置完成的 TilesRenderer 实例。
 */
export function createCesiumTilesRenderer( renderer: WebGLRenderer ): TilesRenderer {
	const apiToken = readStringEnv( 'VITE_CESIUM_ION_TOKEN' );
	const configuredAssetId = readStringEnv( 'VITE_CESIUM_ION_ASSET_ID', '1' );
	const assetId = configuredAssetId;

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

	// Cesium 世界影像服务(Cesium World Imagery,asset id = 2)。和 touchGround.js
	// 一样通过 ImageOverlayPlugin 注入,renderer 必填,resolution 沿用 512 保证近景清晰。
	const worldImageryOverlay = new CesiumIonOverlay( {
		assetId: 2,
		apiToken,
		opacity: 1.0,
		color: 0xffffff,
	} );

	tilesRenderer.registerPlugin( new ImageOverlayPlugin( {
		renderer,
		overlays: [ worldImageryOverlay ],
		resolution: 512,
	} ) );

	if ( configuredAssetId === '1' ) {
		console.warn( 'VITE_CESIUM_ION_ASSET_ID=1 is treated as 96188 for Cesium World Terrain.' );
	}

	return tilesRenderer;
}
