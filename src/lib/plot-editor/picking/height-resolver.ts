import type { PlotDocument } from '../document/PlotDocument';
import { PlotEditorValidationError } from '../document/diagnostics';
import { isHeightReferenceRelative } from '../document/height-reference';
import { wrappedLongitudeDistanceDegrees } from '../document/normalize';
import { HeightReference } from '../document/types';
import type {
	PlotFeature,
	PlotFeatureId,
	Position3D,
	ResolvedPlotGeometry,
} from '../document/types';
import { getSurfaceTarget } from './EditorPicker';
import type {
	HeightSample,
	PickSurface,
	PlotSurfaceHeightProvider,
	SurfaceTarget,
} from './types';

const POSITION_MATCH_EPSILON_DEGREES = 1e-8;

export interface HeightResolutionOutcome {
	readonly accepted: boolean;
	readonly result?: ResolvedPlotGeometry;
}

export interface HeightResolutionManagerOptions {
	readonly provider: PlotSurfaceHeightProvider;
	readonly document: PlotDocument;
	readonly onResolved?: ( result: ResolvedPlotGeometry ) => void;
	readonly onInvalidate?: ( surfaceRevision: number ) => void;
	readonly onError?: ( error: unknown, plotId: PlotFeatureId ) => void;
}

interface ActiveRequest {
	readonly generation: number;
	readonly featureRevision: number;
	readonly heightReference: HeightReference;
	readonly surfaceRevision: number;
	readonly controller: AbortController;
}

/**
 * 把作者高度解析为运行时绝对高度，不写回 PlotDocument。
 * 负责 generation、surface revision、AbortSignal 与 dispose 的竞态守卫。
 */
export class HeightResolutionManager {
	private readonly _provider: PlotSurfaceHeightProvider;
	private readonly _document: PlotDocument;
	private readonly _onResolved?: ( result: ResolvedPlotGeometry ) => void;
	private readonly _onInvalidate?: ( surfaceRevision: number ) => void;
	private readonly _onError?: ( error: unknown, plotId: PlotFeatureId ) => void;
	private readonly _active = new Map<PlotFeatureId, ActiveRequest>();
	private readonly _ready = new Map<PlotFeatureId, ResolvedPlotGeometry>();
	private readonly _unsubscribe: () => void;
	private _generation = 0;
	private _surfaceRevision = 0;
	private _disposed = false;

	public constructor( options: HeightResolutionManagerOptions ) {
		this._provider = options.provider;
		this._document = options.document;
		this._onResolved = options.onResolved;
		this._onInvalidate = options.onInvalidate;
		this._onError = options.onError;
		this._unsubscribe = this._provider.subscribe( () => this._invalidateSurface() );
	}

	public get surfaceRevision(): number {
		return this._surfaceRevision;
	}

	public getCached( id: PlotFeatureId ): ResolvedPlotGeometry | undefined {
		return this._ready.get( id );
	}

	public async resolve( feature: Readonly<PlotFeature> ): Promise<HeightResolutionOutcome> {
		if ( this._disposed ) {
			return Object.freeze( { accepted: false } );
		}
		this.cancel( feature.id );
		const controller = new AbortController();
		const request: ActiveRequest = {
			generation: ++this._generation,
			featureRevision: feature.revision,
			heightReference: feature.heightReference,
			surfaceRevision: this._surfaceRevision,
			controller,
		};
		this._active.set( feature.id, request );
		try {
			const result = await resolveFeatureHeights(
				feature,
				this._provider,
				controller.signal,
				this._ready.get( feature.id ),
			);
			if ( ! this._isCurrent( feature.id, request ) ) {
				return Object.freeze( { accepted: false } );
			}
			this._active.delete( feature.id );
			if ( result.status === 'ready' ) {
				this._ready.set( feature.id, result );
			}
			this._onResolved?.( result );
			return Object.freeze( { accepted: true, result } );
		} catch ( error ) {
			if ( this._active.get( feature.id ) === request ) {
				this._active.delete( feature.id );
			}
			if ( ! isAbortError( error ) && this._isFeatureStillCurrent( feature.id, request ) ) {
				this._onError?.( error, feature.id );
			}
			return Object.freeze( { accepted: false } );
		}
	}

	public cancel( id: PlotFeatureId ): void {
		const active = this._active.get( id );
		if ( active !== undefined ) {
			this._active.delete( id );
			active.controller.abort();
		}
	}

	public dispose(): void {
		if ( this._disposed ) {
			return;
		}
		this._disposed = true;
		this._unsubscribe();
		for ( const request of this._active.values() ) {
			request.controller.abort();
		}
		this._active.clear();
		this._ready.clear();
	}

	private _invalidateSurface(): void {
		if ( this._disposed ) {
			return;
		}
		this._surfaceRevision++;
		for ( const request of this._active.values() ) {
			request.controller.abort();
		}
		this._active.clear();
		this._onInvalidate?.( this._surfaceRevision );
	}

	private _isCurrent( id: PlotFeatureId, request: ActiveRequest ): boolean {
		return ! this._disposed
			&& ! request.controller.signal.aborted
			&& this._active.get( id ) === request
			&& request.surfaceRevision === this._surfaceRevision
			&& this._isFeatureStillCurrent( id, request );
	}

	private _isFeatureStillCurrent( id: PlotFeatureId, request: ActiveRequest ): boolean {
		const current = this._document.get( id );
		return current !== undefined
			&& current.revision === request.featureRevision
			&& current.heightReference === request.heightReference;
	}
}

/** 纯解析函数，便于 provider 契约和缺失表面策略独立测试。 */
export async function resolveFeatureHeights(
	feature: Readonly<PlotFeature>,
	provider: PlotSurfaceHeightProvider,
	signal: AbortSignal,
	previous?: ResolvedPlotGeometry,
): Promise<ResolvedPlotGeometry> {
	const positions = getFeaturePositions( feature );
	const target = getSurfaceTarget( feature.heightReference );
	if ( target === undefined ) {
		return freezeResolved( {
			plotId: feature.id,
			sourceRevision: feature.revision,
			effectivePositions: positions,
			status: 'ready',
		} );
	}
	const samples = await provider.sampleHeights( {
		positions,
		target,
		signal,
	} );
	if ( signal.aborted ) {
		throw createAbortError();
	}
	validateSamples( positions, samples, target );

	const hasMissing = samples.some( ( sample ) => sample.surfaceHeight === null );
	const hasFallback = samples.some( ( sample ) => sample.source === 'ellipsoid' );
	if ( hasMissing && canReusePreviousResolution( feature, positions, previous ) ) {
		return freezeResolved( {
			plotId: feature.id,
			sourceRevision: feature.revision,
			effectivePositions: previous.effectivePositions,
			status: 'pending',
		} );
	}
	if ( hasMissing && target === '3d-tile' ) {
		return freezeResolved( {
			plotId: feature.id,
			sourceRevision: feature.revision,
			effectivePositions: [],
			status: 'unavailable',
		} );
	}

	const effectivePositions = positions.map( ( position, index ) => {
		const sample = samples[ index ];
		const surfaceHeight = sample.surfaceHeight ?? 0;
		const authorOffset = isHeightReferenceRelative( feature.heightReference )
			? position[ 2 ]
			: 0;
		return Object.freeze( [
			position[ 0 ],
			position[ 1 ],
			surfaceHeight + authorOffset,
		] as Position3D );
	} );
	return freezeResolved( {
		plotId: feature.id,
		sourceRevision: feature.revision,
		effectivePositions,
		status: hasMissing || hasFallback ? 'pending' : 'ready',
	} );
}

/** 只允许同一作者快照复用旧 surface，防止编辑后的 feature 借用旧顶点高度。 */
function canReusePreviousResolution(
	feature: Readonly<PlotFeature>,
	positions: readonly Position3D[],
	previous: ResolvedPlotGeometry | undefined,
): previous is ResolvedPlotGeometry {
	return previous !== undefined
		&& previous.status === 'ready'
		&& previous.plotId === feature.id
		&& previous.sourceRevision === feature.revision
		&& previous.effectivePositions.length === positions.length
		&& previous.effectivePositions.every( ( effective, index ) =>
			wrappedLongitudeDistanceDegrees( effective[ 0 ], positions[ index ][ 0 ] )
				<= POSITION_MATCH_EPSILON_DEGREES
			&& Math.abs( effective[ 1 ] - positions[ index ][ 1 ] )
				<= POSITION_MATCH_EPSILON_DEGREES,
		);
}

export function getFeaturePositions(
	feature: Readonly<PlotFeature>,
): readonly Position3D[] {
	switch ( feature.type ) {
		case 'point':
		case 'text':
			return Object.freeze( [ feature.geometry.position ] );
		case 'circle':
		case 'sector':
			return Object.freeze( [ feature.geometry.center ] );
		case 'line':
		case 'polygon':
		case 'rectangle':
		case 'arrow':
			return feature.geometry.positions;
	}
}

function validateSamples(
	positions: readonly Position3D[],
	samples: readonly HeightSample[],
	target: SurfaceTarget,
): void {
	if ( ! Array.isArray( samples ) || samples.length !== positions.length ) {
		throw resolverError( 'provider 返回的 sample 数量必须与请求坐标数量一致。' );
	}
	for ( let index = 0; index < samples.length; index++ ) {
		const sample = samples[ index ];
		const position = positions[ index ];
		if ( sample === null || typeof sample !== 'object'
			|| ! Number.isFinite( sample.longitude )
			|| ! Number.isFinite( sample.latitude )
			|| wrappedLongitudeDistanceDegrees( sample.longitude, position[ 0 ] )
				> POSITION_MATCH_EPSILON_DEGREES
			|| Math.abs( sample.latitude - position[ 1 ] ) > POSITION_MATCH_EPSILON_DEGREES ) {
			throw resolverError( `provider sample[${ index }] 与请求坐标不匹配。` );
		}
		if ( sample.surfaceHeight !== null && ! Number.isFinite( sample.surfaceHeight ) ) {
			throw resolverError( `provider sample[${ index }] 高度必须有限或为 null。` );
		}
		if ( sample.surfaceHeight === null && sample.source !== null ) {
			throw resolverError( `provider sample[${ index }] 缺失高度时 source 必须为 null。` );
		}
		if ( sample.surfaceHeight !== null && ! isSourceAllowed( target, sample.source ) ) {
			throw resolverError( `provider sample[${ index }] 返回了错误的 surface source。` );
		}
	}
}

function isSourceAllowed(
	target: SurfaceTarget,
	source: PickSurface | null,
): boolean {
	if ( source === null ) return false;
	if ( target === 'ground' ) {
		return source === 'terrain' || source === '3d-tile' || source === 'ellipsoid';
	}
	if ( target === 'terrain' ) {
		return source === 'terrain' || source === 'ellipsoid';
	}
	return source === '3d-tile';
}

function freezeResolved( input: ResolvedPlotGeometry ): ResolvedPlotGeometry {
	return Object.freeze( {
		...input,
		effectivePositions: Object.freeze(
			input.effectivePositions.map( ( position ) => Object.freeze( [ ...position ] ) as Position3D ),
		),
	} );
}

function resolverError( message: string ): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code: 'SURFACE_UNAVAILABLE',
		severity: 'error',
		message,
	} );
}

function createAbortError(): Error {
	if ( typeof DOMException !== 'undefined' ) {
		return new DOMException( 'The operation was aborted.', 'AbortError' );
	}
	const error = new Error( 'The operation was aborted.' );
	error.name = 'AbortError';
	return error;
}

function isAbortError( error: unknown ): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
