import {
	Raycaster,
	Vector3,
} from 'three';
import type { TilesRenderer } from 'um-3d-tiles-renderer';
import type {
	HeightSample,
	HeightSampleRequest,
	PlotSurfaceHeightProvider,
} from './types';

const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_RAY_START_HEIGHT_METERS = 100_000;
const DEFAULT_RAY_END_HEIGHT_METERS = -10_000;

/**
 * 使用已经加载到 Three 场景中的地形瓦片解析 WGS84 表面高程。
 *
 * 贴地 classification 的可见位置来自瓦片深度；编辑器的 Raycaster 代理也必须使用
 * 同一表面高程，否则斜视时两者会在屏幕上产生明显错位。该实现只读取已加载瓦片，
 * 瓦片尚不可用时对 ground/terrain 返回椭球高程 0，等待下一次瓦片批次完成后重采样。
 */
export class TilesTerrainHeightProvider implements PlotSurfaceHeightProvider {
	private readonly _tilesRenderer: TilesRenderer;
	private readonly _rayStartHeight: number;
	private readonly _rayEndHeight: number;
	private readonly _allowEllipsoidFallback: boolean;
	private readonly _raycaster = new Raycaster();
	private readonly _listeners = new Set<() => void>();
	private readonly _localOrigin = new Vector3();
	private readonly _localEnd = new Vector3();
	private readonly _worldOrigin = new Vector3();
	private readonly _worldEnd = new Vector3();
	private readonly _localHit = new Vector3();
	private _eventsAttached = false;

	public constructor(
		tilesRenderer: TilesRenderer,
		options: {
			readonly rayStartHeightMeters?: number;
			readonly rayEndHeightMeters?: number;
			/** 无地形模式才应启用；真实地形加载期间禁止把漏采样顶点写成 0 高。 */
			readonly allowEllipsoidFallback?: boolean;
		} = {},
	) {
		this._tilesRenderer = tilesRenderer;
		this._rayStartHeight = requireFinite(
			options.rayStartHeightMeters ?? DEFAULT_RAY_START_HEIGHT_METERS,
			'rayStartHeightMeters',
		);
		this._rayEndHeight = requireFinite(
			options.rayEndHeightMeters ?? DEFAULT_RAY_END_HEIGHT_METERS,
			'rayEndHeightMeters',
		);
		this._allowEllipsoidFallback = options.allowEllipsoidFallback !== false;
		if ( this._rayStartHeight <= this._rayEndHeight ) {
			throw new RangeError( 'rayStartHeightMeters 必须大于 rayEndHeightMeters。' );
		}
		this._raycaster.near = 0;
		this._raycaster.far = this._rayStartHeight - this._rayEndHeight;
	}

	public async sampleHeights(
		request: HeightSampleRequest,
	): Promise<readonly HeightSample[]> {
		throwIfAborted( request.signal );
		this._tilesRenderer.group.updateWorldMatrix( true, true );
		const samples = request.positions.map( ( position ) => {
			throwIfAborted( request.signal );
			if ( request.target === '3d-tile' ) {
				return missingSample( position );
			}
			const height = this._sampleTerrainHeight( position[ 0 ], position[ 1 ] );
			if ( height === null && ! this._allowEllipsoidFallback ) {
				return missingSample( position );
			}
			return Object.freeze( {
				longitude: position[ 0 ],
				latitude: position[ 1 ],
				surfaceHeight: height ?? 0,
				source: height === null ? 'ellipsoid' as const : 'terrain' as const,
			} );
		} );
		return Object.freeze( samples );
	}

	public subscribe( listener: () => void ): () => void {
		this._listeners.add( listener );
		this._attachEvents();
		let active = true;
		return () => {
			if ( ! active ) return;
			active = false;
			this._listeners.delete( listener );
			if ( this._listeners.size === 0 ) this._detachEvents();
		};
	}

	private _sampleTerrainHeight( longitudeDegrees: number, latitudeDegrees: number ): number | null {
		const latitude = latitudeDegrees * DEG_TO_RAD;
		const longitude = longitudeDegrees * DEG_TO_RAD;
		const ellipsoid = this._tilesRenderer.ellipsoid;
		ellipsoid.getCartographicToPosition(
			latitude, longitude, this._rayStartHeight, this._localOrigin,
		);
		ellipsoid.getCartographicToPosition(
			latitude, longitude, this._rayEndHeight, this._localEnd,
		);
		this._worldOrigin.copy( this._localOrigin );
		this._worldEnd.copy( this._localEnd );
		this._tilesRenderer.group.localToWorld( this._worldOrigin );
		this._tilesRenderer.group.localToWorld( this._worldEnd );
		const rayLength = this._worldOrigin.distanceTo( this._worldEnd );
		if ( rayLength <= 0 ) return null;
		this._raycaster.far = rayLength;
		this._raycaster.set(
			this._worldOrigin,
			this._worldEnd.sub( this._worldOrigin ).normalize(),
		);
		const hit = this._raycaster.intersectObject( this._tilesRenderer.group, true )[ 0 ];
		if ( hit === undefined ) return null;
		this._localHit.copy( hit.point );
		this._tilesRenderer.group.worldToLocal( this._localHit );
		const cartographic = ellipsoid.getPositionToCartographic(
			this._localHit,
			{ lat: 0, lon: 0, height: 0 },
		);
		return Number.isFinite( cartographic.height ) ? cartographic.height : null;
	}

	private readonly _notifySurfaceChanged = (): void => {
		for ( const listener of [ ...this._listeners ] ) listener();
	};

	private _attachEvents(): void {
		if ( this._eventsAttached ) return;
		this._eventsAttached = true;
		this._tilesRenderer.addEventListener( 'tiles-load-end', this._notifySurfaceChanged );
		this._tilesRenderer.addEventListener( 'dispose-model', this._notifySurfaceChanged );
	}

	private _detachEvents(): void {
		if ( ! this._eventsAttached ) return;
		this._eventsAttached = false;
		this._tilesRenderer.removeEventListener( 'tiles-load-end', this._notifySurfaceChanged );
		this._tilesRenderer.removeEventListener( 'dispose-model', this._notifySurfaceChanged );
	}
}

function missingSample( position: readonly [ number, number, number ] ): HeightSample {
	return Object.freeze( {
		longitude: position[ 0 ],
		latitude: position[ 1 ],
		surfaceHeight: null,
		source: null,
	} );
}

function requireFinite( value: number, name: string ): number {
	if ( ! Number.isFinite( value ) ) throw new TypeError( `${ name } 必须是有限数。` );
	return value;
}

function throwIfAborted( signal: AbortSignal ): void {
	if ( ! signal.aborted ) return;
	if ( typeof DOMException !== 'undefined' ) {
		throw new DOMException( 'The operation was aborted.', 'AbortError' );
	}
	const error = new Error( 'The operation was aborted.' );
	error.name = 'AbortError';
	throw error;
}
