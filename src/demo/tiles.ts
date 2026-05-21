// ============================================================
// tiles.ts
// Layer: 3d-tiles-renderer demo integration.
// Role: configure Cesium Ion terrain, normalize loaded tile materials, and
//       inject Cesium-compatible log depth into every terrain shader so the
//       main framebuffer depth values are coherent with the ground
//       classification shadow-volume color pass.
// Dependencies: Three.js, 3d-tiles-renderer, demo env helpers, ground adapter.
// Consumed by: ground-demo.ts.
// ============================================================

import {
	Color,
	FrontSide,
	type Material,
	type Object3D,
} from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { QuantizedMeshPlugin } from '3d-tiles-renderer/three/plugins';

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
 * Applies stable render state to every model that 3d-tiles-renderer loads.
 *
 * @param modelScene Root object created for a loaded tile.
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
 * Creates a Cesium Ion backed 3D Tiles renderer. Terrain assets are handled by
 * QuantizedMeshPlugin so the surface is real terrain geometry, not an ellipsoid.
 *
 * @returns Configured TilesRenderer instance.
 */
export function createCesiumTilesRenderer(): TilesRenderer {
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

	if ( configuredAssetId === '1' ) {
		console.warn( 'VITE_CESIUM_ION_ASSET_ID=1 is treated as 96188 for Cesium World Terrain.' );
	}

	return tilesRenderer;
}
