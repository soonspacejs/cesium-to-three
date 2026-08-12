import {
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
} from 'three';
import { TilesRenderer } from 'um-3d-tiles-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TilesTerrainHeightProvider } from '../../../src/lib/plot-editor/picking/TilesTerrainHeightProvider';

const LONGITUDE = 116;
const LATITUDE = 39;
const DEG_TO_RAD = Math.PI / 180;

function terrainPlane( tiles: TilesRenderer, height: number ): Mesh {
	const mesh = new Mesh(
		new PlaneGeometry( 2_000, 2_000 ),
		new MeshBasicMaterial( { side: 2 } ),
	);
	mesh.matrix.copy( tiles.ellipsoid.getEastNorthUpFrame(
		LATITUDE * DEG_TO_RAD,
		LONGITUDE * DEG_TO_RAD,
		height,
		new Matrix4(),
	) );
	mesh.matrixAutoUpdate = false;
	mesh.updateMatrixWorld( true );
	return mesh;
}

describe( 'TilesTerrainHeightProvider', () => {
	it( '沿经纬度法线命中已加载地形，并返回相对 WGS84 椭球的真实高度', async () => {
		const tiles = new TilesRenderer( '' );
		tiles.group.add( terrainPlane( tiles, 126.5 ) );
		( tiles as unknown as { _optimizeRaycast: boolean } )._optimizeRaycast = false;
		const provider = new TilesTerrainHeightProvider( tiles );
		const samples = await provider.sampleHeights( {
			positions: [ [ LONGITUDE, LATITUDE, 0 ] ],
			target: 'ground',
			signal: new AbortController().signal,
		} );
		expect( samples[ 0 ] ).toMatchObject( {
			longitude: LONGITUDE,
			latitude: LATITUDE,
			source: 'terrain',
		} );
		expect( samples[ 0 ].surfaceHeight ).toBeCloseTo( 126.5, 3 );
	} );

	it( '未加载地形时 ground 回退椭球，3d-tile 目标保持不可用', async () => {
		const provider = new TilesTerrainHeightProvider( new TilesRenderer( '' ) );
		const signal = new AbortController().signal;
		const ground = await provider.sampleHeights( {
			positions: [ [ LONGITUDE, LATITUDE, 0 ] ], target: 'ground', signal,
		} );
		const tile = await provider.sampleHeights( {
			positions: [ [ LONGITUDE, LATITUDE, 0 ] ], target: '3d-tile', signal,
		} );
		expect( ground[ 0 ] ).toMatchObject( { surfaceHeight: 0, source: 'ellipsoid' } );
		expect( tile[ 0 ] ).toMatchObject( { surfaceHeight: null, source: null } );
	} );

	it( '真实地形模式下漏采样返回空洞，不把单个顶点降到椭球零高', async () => {
		const provider = new TilesTerrainHeightProvider( new TilesRenderer( '' ), {
			allowEllipsoidFallback: false,
		} );
		const samples = await provider.sampleHeights( {
			positions: [ [ LONGITUDE, LATITUDE, 0 ] ],
			target: 'ground',
			signal: new AbortController().signal,
		} );
		expect( samples[ 0 ] ).toMatchObject( { surfaceHeight: null, source: null } );
	} );

	it( '瓦片批次完成和模型释放会通知重采样，取消订阅后不再通知', () => {
		const tiles = new TilesRenderer( '' );
		const provider = new TilesTerrainHeightProvider( tiles );
		const listener = vi.fn();
		const unsubscribe = provider.subscribe( listener );
		tiles.dispatchEvent( { type: 'tiles-load-end' } );
		tiles.dispatchEvent( { type: 'dispose-model', scene: tiles.group, tile: {} as never } );
		expect( listener ).toHaveBeenCalledTimes( 2 );
		unsubscribe();
		tiles.dispatchEvent( { type: 'tiles-load-end' } );
		expect( listener ).toHaveBeenCalledTimes( 2 );
	} );

	it( '请求已取消时不执行任何地形相交', async () => {
		const provider = new TilesTerrainHeightProvider( new TilesRenderer( '' ) );
		const controller = new AbortController();
		controller.abort();
		await expect( provider.sampleHeights( {
			positions: [ [ LONGITUDE, LATITUDE, 0 ] ],
			target: 'ground',
			signal: controller.signal,
		} ) ).rejects.toMatchObject( { name: 'AbortError' } );
	} );
} );
