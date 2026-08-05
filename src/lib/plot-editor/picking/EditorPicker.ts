import {
	getHeightMode,
	getHeightSurface,
} from '../document/height-reference';
import { normalizePosition } from '../document/normalize';
import { HeightReference } from '../document/types';
import type {
	PickOptions,
	PlotPickResult,
	PlotSurfacePicker,
	ScreenPosition,
	SurfaceHit,
	SurfaceRaycastPort,
	SurfaceTarget,
} from './types';

/** 将 HeightReference 映射为异步采样目标；NONE 不需要表面采样。 */
export function getSurfaceTarget(
	heightReference: HeightReference,
): SurfaceTarget | undefined {
	switch ( getHeightSurface( heightReference ) ) {
		case 'ellipsoid': return undefined;
		case 'ground': return 'ground';
		case 'terrain': return 'terrain';
		case '3d-tile': return '3d-tile';
	}
}

/** 按七值高度参考过滤目标并选择离相机最近的合法可见表面。 */
export class EditorSurfacePicker implements PlotSurfacePicker {
	private readonly _raycast: SurfaceRaycastPort;
	private _disposed = false;

	public constructor( raycast: SurfaceRaycastPort ) {
		this._raycast = raycast;
	}

	public pick( screen: ScreenPosition, options: PickOptions ): PlotPickResult | null {
		if ( this._disposed || ! isFiniteScreenPosition( screen ) ) {
			return null;
		}
		const target = getHeightSurface( options.heightReference );
		const candidates: SurfaceHit[] = [];
		if ( target === 'ellipsoid' || target === 'ground' ) {
			candidates.push( ...this._validHits(
				this._raycast.pickTerrain( screen ),
				'terrain',
			) );
			candidates.push( ...this._validHits(
				this._raycast.pickTiles( screen ),
				'3d-tile',
			) );
		} else if ( target === 'terrain' ) {
			candidates.push( ...this._validHits(
				this._raycast.pickTerrain( screen ),
				'terrain',
			) );
		} else {
			candidates.push( ...this._validHits(
				this._raycast.pickTiles( screen ),
				'3d-tile',
			) );
		}

		let hit: SurfaceHit | undefined = candidates.sort(
			( left, right ) => left.distanceFromCamera - right.distanceFromCamera,
		)[ 0 ];
		const allowEllipsoid = target !== '3d-tile'
			&& options.allowEllipsoidFallback !== false;
		if ( hit === undefined && allowEllipsoid ) {
			const fallback = this._raycast.pickEllipsoid( screen );
			if ( fallback !== null ) {
				hit = this._validHit( fallback, 'ellipsoid' ) ?? undefined;
			}
		}
		if ( hit === undefined ) {
			return null;
		}

		const surfacePosition = normalizePosition(
			hit.surfacePosition,
			HeightReference.NONE,
			{ path: '/surfacePosition' },
		);
		const mode = getHeightMode( options.heightReference );
		const authorHeight = mode === 'clamp'
			? 0
			: mode === 'relative'
				? options.relativeOffset ?? 0
				: options.absoluteHeight ?? surfacePosition[ 2 ];
		const authorPosition = normalizePosition(
			[ surfacePosition[ 0 ], surfacePosition[ 1 ], authorHeight ],
			options.heightReference,
			{ path: '/authorPosition' },
		);
		return Object.freeze( {
			authorPosition: Object.freeze( authorPosition ),
			surfacePosition: Object.freeze( surfacePosition ),
			surface: hit.surface,
			heightReference: options.heightReference,
		} );
	}

	public dispose(): void {
		this._disposed = true;
	}

	private _validHits(
		hits: readonly SurfaceHit[],
		expectedSurface: SurfaceHit[ 'surface' ],
	): SurfaceHit[] {
		return hits.map( ( hit ) => this._validHit( hit, expectedSurface ) )
			.filter( ( hit ): hit is SurfaceHit => hit !== null );
	}

	private _validHit(
		hit: SurfaceHit,
		expectedSurface: SurfaceHit[ 'surface' ],
	): SurfaceHit | null {
		if ( hit.surface !== expectedSurface
			|| ! Number.isFinite( hit.distanceFromCamera )
			|| hit.distanceFromCamera <= 0 ) {
			return null;
		}
		try {
			return Object.freeze( {
				...hit,
				surfacePosition: Object.freeze( normalizePosition(
					hit.surfacePosition,
					HeightReference.NONE,
					{ path: '/surfaceHit/surfacePosition' },
				) ),
			} );
		} catch {
			return null;
		}
	}
}

function isFiniteScreenPosition( screen: ScreenPosition ): boolean {
	return screen !== null
		&& typeof screen === 'object'
		&& Number.isFinite( screen.clientX )
		&& Number.isFinite( screen.clientY );
}
