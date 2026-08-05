import {
	PlotEditorValidationError,
	summarizeDiagnosticValue,
} from './diagnostics';
import { normalizeProperties, normalizeFeature } from './validate';
import type {
	JsonValue,
	PlotDocumentSnapshot,
	PlotFeature,
	PlotFeatureId,
} from './types';

export interface PlotDocumentChange {
	readonly previousRevision: number;
	readonly revision: number;
	readonly label: string;
	readonly commandType: string;
	readonly affectedIds: readonly PlotFeatureId[];
}

export type PlotDocumentListener = ( change: PlotDocumentChange ) => void;

/** 对宿主公开的只读文档接口。所有写入只能经 CommandExecutor。 */
export interface PlotDocument {
	readonly id: string;
	readonly revision: number;
	get( id: PlotFeatureId ): Readonly<PlotFeature> | undefined;
	getAll(): readonly Readonly<PlotFeature>[];
	has( id: PlotFeatureId ): boolean;
	snapshot(): PlotDocumentSnapshot;
	subscribe( listener: PlotDocumentListener ): () => void;
}

export interface PlotDocumentStoreOptions {
	readonly id: string;
	readonly revision?: number;
	readonly features?: readonly unknown[];
	readonly order?: readonly PlotFeatureId[];
	readonly metadata?: Readonly<Record<string, JsonValue>>;
	readonly onListenerError?: ( error: unknown ) => void;
}

export interface DocumentCommit {
	readonly features: readonly PlotFeature[];
	readonly order: readonly PlotFeatureId[];
	readonly label: string;
	readonly commandType: string;
	readonly affectedIds: readonly PlotFeatureId[];
}

/**
 * PlotDocument 的内部存储实现。
 *
 * `commitCandidate` 只供命令层使用，公共 barrel 不会导出本类；宿主持有的
 * `PlotDocument` 视图没有写方法，从类型和运行时职责上隔离直接 mutation。
 */
export class PlotDocumentStore implements PlotDocument {
	public readonly id: string;

	private _revision: number;
	private _features: Map<PlotFeatureId, PlotFeature>;
	private _order: readonly PlotFeatureId[];
	private readonly _metadata: Readonly<Record<string, JsonValue>>;
	private readonly _listeners = new Set<PlotDocumentListener>();
	private readonly _onListenerError: ( error: unknown ) => void;

	public constructor( options: PlotDocumentStoreOptions ) {
		this.id = validateDocumentId( options.id );
		this._revision = validateRevision( options.revision ?? 0 );
		const normalized = normalizeInitialFeatures( options.features ?? [] );
		this._order = validateOrder(
			options.order ?? normalized.map( ( feature ) => feature.id ),
			normalized,
		);
		this._features = new Map(
			normalized.map( ( feature ) => [ feature.id, feature ] ),
		);
		this._metadata = normalizeProperties( options.metadata ?? {}, '/metadata' );
		this._onListenerError = options.onListenerError ?? ( ( error ) => {
			console.error( 'PlotDocument listener error:', error );
		} );
	}

	public get revision(): number {
		return this._revision;
	}

	public get( id: PlotFeatureId ): Readonly<PlotFeature> | undefined {
		return this._features.get( id );
	}

	public getAll(): readonly Readonly<PlotFeature>[] {
		return Object.freeze(
			this._order.map( ( id ) => this._features.get( id ) as PlotFeature ),
		);
	}

	public has( id: PlotFeatureId ): boolean {
		return this._features.has( id );
	}

	public snapshot(): PlotDocumentSnapshot {
		return Object.freeze( {
			schema: 'cesium-to-three/plot-document' as const,
			version: 1 as const,
			documentId: this.id,
			revision: this._revision,
			features: this.getAll(),
			order: Object.freeze( [ ...this._order ] ),
			metadata: this._metadata,
		} );
	}

	public subscribe( listener: PlotDocumentListener ): () => void {
		if ( typeof listener !== 'function' ) {
			throw new TypeError( 'PlotDocument listener 必须是函数。' );
		}
		this._listeners.add( listener );
		let subscribed = true;
		return () => {
			if ( ! subscribed ) {
				return;
			}
			subscribed = false;
			this._listeners.delete( listener );
		};
	}

	/** @internal 仅由 CommandExecutor 在全量预验证成功后调用。 */
	public commitCandidate( commit: DocumentCommit ): boolean {
		const normalized = normalizeCandidateFeatures( commit.features, this._features );
		const order = validateOrder( commit.order, normalized );
		if ( documentsEqual( this._features, this._order, normalized, order ) ) {
			return false;
		}
		const previousRevision = this._revision;
		this._features = new Map(
			normalized.map( ( feature ) => [ feature.id, feature ] ),
		);
		this._order = order;
		this._revision++;
		const change = Object.freeze( {
			previousRevision,
			revision: this._revision,
			label: commit.label,
			commandType: commit.commandType,
			affectedIds: Object.freeze( [ ...new Set( commit.affectedIds ) ] ),
		} satisfies PlotDocumentChange );
		this._emit( change );
		return true;
	}

	private _emit( change: PlotDocumentChange ): void {
		for ( const listener of [ ...this._listeners ] ) {
			try {
				listener( change );
			} catch ( error ) {
				queueMicrotask( () => this._onListenerError( error ) );
			}
		}
	}
}

/** 创建内部文档存储；PlotEditor facade 会只暴露其只读接口。 */
export function createPlotDocumentStore(
	options: PlotDocumentStoreOptions,
): PlotDocumentStore {
	return new PlotDocumentStore( options );
}

function normalizeInitialFeatures( inputs: readonly unknown[] ): PlotFeature[] {
	return normalizeCandidateFeatures( inputs );
}

function normalizeCandidateFeatures(
	inputs: readonly unknown[],
	current?: ReadonlyMap<PlotFeatureId, PlotFeature>,
): PlotFeature[] {
	const result = inputs.map( ( feature, index ) => {
		if ( feature !== null && typeof feature === 'object' ) {
			const id = ( feature as { id?: unknown } ).id;
			if ( typeof id === 'string' && current?.get( id ) === feature ) {
				return feature as PlotFeature;
			}
		}
		return normalizeFeature( feature, {
		path: `/features/${ index }`,
		clampHeightPolicy: 'reject',
		} );
	} );
	const ids = new Set<string>();
	for ( let index = 0; index < result.length; index++ ) {
		const id = result[ index ].id;
		if ( ids.has( id ) ) {
			throw new PlotEditorValidationError( {
				code: 'ID_CONFLICT',
				severity: 'error',
				message: `feature id 重复：${ id }。`,
				path: `/features/${ index }/id`,
				valueSummary: summarizeDiagnosticValue( id ),
			} );
		}
		ids.add( id );
	}
	return result;
}

function validateOrder(
	input: readonly PlotFeatureId[],
	features: readonly PlotFeature[],
): readonly PlotFeatureId[] {
	if ( ! Array.isArray( input ) ) {
		throw new PlotEditorValidationError( {
			code: 'INVALID_SCHEMA',
			severity: 'error',
			message: 'document order 必须是 feature id 数组。',
			path: '/order',
			valueSummary: summarizeDiagnosticValue( input ),
		} );
	}
	const expected = new Set( features.map( ( feature ) => feature.id ) );
	const actual = new Set<string>();
	for ( let index = 0; index < input.length; index++ ) {
		const id = input[ index ];
		if ( typeof id !== 'string' || ! expected.has( id ) || actual.has( id ) ) {
			throw new PlotEditorValidationError( {
				code: actual.has( id ) ? 'ORDER_CONFLICT' : 'INVALID_SCHEMA',
				severity: 'error',
				message: 'order 必须且只能包含每个 feature id 一次。',
				path: `/order/${ index }`,
				valueSummary: summarizeDiagnosticValue( id ),
			} );
		}
		actual.add( id );
	}
	if ( actual.size !== expected.size ) {
		const missing = [ ...expected ].find( ( id ) => ! actual.has( id ) );
		throw new PlotEditorValidationError( {
			code: 'INVALID_SCHEMA',
			severity: 'error',
			message: 'order 缺少 feature id。',
			path: '/order',
			valueSummary: summarizeDiagnosticValue( missing ),
		} );
	}
	return Object.freeze( [ ...input ] );
}

function documentsEqual(
	current: ReadonlyMap<PlotFeatureId, PlotFeature>,
	currentOrder: readonly PlotFeatureId[],
	next: readonly PlotFeature[],
	nextOrder: readonly PlotFeatureId[],
): boolean {
	if ( currentOrder.length !== nextOrder.length
		|| currentOrder.some( ( id, index ) => id !== nextOrder[ index ] ) ) {
		return false;
	}
	return next.every( ( feature ) => current.get( feature.id ) === feature );
}

function validateDocumentId( id: unknown ): string {
	if ( typeof id !== 'string' || id.trim().length === 0 ) {
		throw new PlotEditorValidationError( {
			code: 'INVALID_SCHEMA',
			severity: 'error',
			message: 'documentId 必须是非空字符串。',
			path: '/documentId',
			valueSummary: summarizeDiagnosticValue( id ),
		} );
	}
	return id;
}

function validateRevision( revision: unknown ): number {
	if ( ! Number.isSafeInteger( revision ) || ( revision as number ) < 0 ) {
		throw new PlotEditorValidationError( {
			code: 'INVALID_SCHEMA',
			severity: 'error',
			message: 'document revision 必须是非负安全整数。',
			path: '/revision',
			valueSummary: summarizeDiagnosticValue( revision ),
		} );
	}
	return revision as number;
}
