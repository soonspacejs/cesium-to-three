import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { EditorError } from '../commands/types';
import type { PlotDocumentStore } from '../document/PlotDocument';
import type { EditorDiagnostic } from '../document/diagnostics';
import type {
	JsonValue,
	PlotDocumentSnapshot,
	PlotFeature,
	PlotFeatureId,
} from '../document/types';
import { normalizeFeature } from '../document/validate';
import {
	decodePlotDocument,
	stringifyPlotDocument,
	type DecodePlotDocumentOptions,
} from './codec';

export interface ImportPlotDocumentOptions extends DecodePlotDocumentOptions {
	readonly mode?: 'replace' | 'merge';
	readonly onIdConflict?: 'reject' | 'replace' | 'regenerate';
	readonly recordHistory?: boolean;
	readonly mergeMetadata?: 'preserve' | 'replace' | 'merge';
}

export interface ImportPlotDocumentResult {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly revision: number;
	readonly affectedIds: readonly PlotFeatureId[];
	readonly diagnostics: readonly EditorDiagnostic[];
	readonly idMap: Readonly<Record<PlotFeatureId, PlotFeatureId>>;
	readonly error?: EditorError;
}

export interface PlotDocumentImporterOptions {
	readonly document: PlotDocumentStore;
	readonly executor: CommandExecutor;
	readonly history: HistoryManager;
	readonly idGenerator?: () => PlotFeatureId;
}

/** 全量构造候选 snapshot 后只执行一次 document.replace，保证导入/merge 原子。 */
export class PlotDocumentImporter {
	private readonly _document: PlotDocumentStore;
	private readonly _executor: CommandExecutor;
	private readonly _history: HistoryManager;
	private readonly _idGenerator: () => PlotFeatureId;
	private _nextGeneratedId = 1;

	public constructor( options: PlotDocumentImporterOptions ) {
		this._document = options.document;
		this._executor = options.executor;
		this._history = options.history;
		this._idGenerator = options.idGenerator ?? ( () => `imported-${ this._nextGeneratedId++ }` );
	}

	public import(
		input: unknown,
		options: ImportPlotDocumentOptions = {},
	): ImportPlotDocumentResult {
		let decoded: ReturnType<typeof decodePlotDocument>;
		try {
			decoded = decodePlotDocument( input, {
				...( options.limits === undefined ? {} : { limits: options.limits } ),
				idGenerator: options.idGenerator ?? this._idGenerator,
			} );
		} catch ( error ) {
			return failureFromUnknown( this._document.revision, error );
		}
		if ( this._history.hasActiveTransaction ) {
			const failed = failureFromUnknown( this._document.revision, importError(
				'TRANSACTION_CLOSED', '/import', '活动事务结束前不能导入文档。',
			) );
			return Object.freeze( {
				...failed,
				diagnostics: Object.freeze( [ ...decoded.diagnostics, ...failed.diagnostics ] ),
			} );
		}

		let prepared: PreparedImport;
		try {
			prepared = prepareImport(
				this._document.snapshot(),
				decoded.snapshot,
				options,
				this._idGenerator,
			);
		} catch ( error ) {
			const failed = failureFromUnknown( this._document.revision, error );
			return Object.freeze( {
				...failed,
				diagnostics: Object.freeze( [ ...decoded.diagnostics, ...failed.diagnostics ] ),
			} );
		}

		if ( snapshotsEquivalent( this._document.snapshot(), prepared.snapshot ) ) {
			return Object.freeze( {
				ok: true,
				changed: false,
				revision: this._document.revision,
				affectedIds: Object.freeze( [] ),
				diagnostics: decoded.diagnostics,
				idMap: prepared.idMap,
			} );
		}

		const command = { type: 'document.replace' as const, snapshot: prepared.snapshot };
		const result = options.recordHistory === false
			? this._executor.execute( command )
			: this._history.execute( this._executor, command, undefined, '导入标绘文档' );
		if ( result.ok && result.changed && options.recordHistory === false ) {
			// 无历史导入改变了整个基线，旧 undo/redo 已不再安全。
			this._history.clear();
		}
		return Object.freeze( {
			ok: result.ok,
			changed: result.changed,
			revision: result.revision,
			affectedIds: result.affectedIds,
			diagnostics: Object.freeze( [
				...decoded.diagnostics,
				...( result.diagnostics ?? [] ),
			] ),
			idMap: prepared.idMap,
			...( result.error === undefined ? {} : { error: result.error } ),
		} );
	}
}

interface PreparedImport {
	readonly snapshot: PlotDocumentSnapshot;
	readonly idMap: Readonly<Record<PlotFeatureId, PlotFeatureId>>;
}

function prepareImport(
	current: PlotDocumentSnapshot,
	incoming: PlotDocumentSnapshot,
	options: ImportPlotDocumentOptions,
	idGenerator: () => PlotFeatureId,
): PreparedImport {
	if ( ( options.mode ?? 'replace' ) === 'replace' ) {
		return Object.freeze( {
			snapshot: snapshotForCurrentDocument(
				current,
				incoming.features,
				incoming.order,
				incoming.metadata ?? Object.freeze( {} ),
			),
			idMap: Object.freeze( {} ),
		} );
	}

	const conflictPolicy = options.onIdConflict ?? 'reject';
	const currentById = new Map( current.features.map( ( feature ) => [ feature.id, feature ] ) );
	const used = new Set( currentById.keys() );
	const incomingById = new Map( incoming.features.map( ( feature ) => [ feature.id, feature ] ) );
	const mappedIncoming: PlotFeature[] = [];
	const idMap: Record<PlotFeatureId, PlotFeatureId> = Object.create( null ) as Record<PlotFeatureId, PlotFeatureId>;

	for ( const id of incoming.order ) {
		const source = incomingById.get( id ) as PlotFeature;
		if ( ! used.has( id ) ) {
			mappedIncoming.push( source );
			used.add( id );
			continue;
		}
		if ( conflictPolicy === 'reject' ) {
			throw importError( 'ID_CONFLICT', `/features/${ id }/id`, `merge feature id 冲突：${ id }。` );
		}
		if ( conflictPolicy === 'replace' ) {
			mappedIncoming.push( source );
			continue;
		}
		const generated = generateUniqueId( idGenerator, used );
		idMap[ id ] = generated;
		used.add( generated );
		mappedIncoming.push( normalizeFeature( {
			...source,
			id: generated,
		}, { path: `/features/${ id }` } ) );
	}

	const mappedByOriginal = new Map<string, PlotFeature>();
	for ( let index = 0; index < incoming.order.length; index++ ) {
		mappedByOriginal.set( incoming.order[ index ], mappedIncoming[ index ] );
	}
	let features: PlotFeature[];
	let order: PlotFeatureId[];
	if ( conflictPolicy === 'replace' ) {
		const replacements = new Map( mappedIncoming.map( ( feature ) => [ feature.id, feature ] ) );
		features = current.order.map( ( id ) => replacements.get( id )
			?? currentById.get( id ) as PlotFeature );
		const appended = incoming.order
			.map( ( id ) => mappedByOriginal.get( id ) as PlotFeature )
			.filter( ( feature ) => ! currentById.has( feature.id ) );
		features.push( ...appended );
		order = [ ...current.order, ...appended.map( ( feature ) => feature.id ) ];
	} else {
		features = [ ...current.features, ...mappedIncoming ];
		order = [ ...current.order, ...mappedIncoming.map( ( feature ) => feature.id ) ];
	}
	const metadata = mergeMetadata(
		current.metadata ?? Object.freeze( {} ),
		incoming.metadata ?? Object.freeze( {} ),
		options.mergeMetadata ?? 'preserve',
	);
	return Object.freeze( {
		snapshot: snapshotForCurrentDocument( current, features, order, metadata ),
		idMap: Object.freeze( { ...idMap } ),
	} );
}

function snapshotForCurrentDocument(
	current: PlotDocumentSnapshot,
	features: readonly PlotFeature[],
	order: readonly PlotFeatureId[],
	metadata: Readonly<Record<string, JsonValue>>,
): PlotDocumentSnapshot {
	return Object.freeze( {
		schema: 'cesium-to-three/plot-document' as const,
		version: 1 as const,
		documentId: current.documentId,
		revision: current.revision,
		features: Object.freeze( [ ...features ] ),
		order: Object.freeze( [ ...order ] ),
		metadata,
	} );
}

function mergeMetadata(
	current: Readonly<Record<string, JsonValue>>,
	incoming: Readonly<Record<string, JsonValue>>,
	policy: NonNullable<ImportPlotDocumentOptions[ 'mergeMetadata' ]>,
): Readonly<Record<string, JsonValue>> {
	if ( policy === 'preserve' ) return current;
	if ( policy === 'replace' ) return incoming;
	return Object.freeze( { ...current, ...incoming } );
}

function generateUniqueId(
	generator: () => PlotFeatureId,
	used: ReadonlySet<PlotFeatureId>,
): PlotFeatureId {
	for ( let attempt = 0; attempt < 10_000; attempt++ ) {
		const candidate = generator();
		if ( typeof candidate !== 'string' || candidate.trim().length === 0 ) {
			throw importError( 'INVALID_SCHEMA', '/idGenerator', 'idGenerator 必须返回非空字符串。' );
		}
		if ( ! used.has( candidate ) ) return candidate;
	}
	throw importError( 'ID_CONFLICT', '/idGenerator', 'idGenerator 连续返回冲突 id。' );
}

function snapshotsEquivalent(
	left: PlotDocumentSnapshot,
	right: PlotDocumentSnapshot,
): boolean {
	return stringifyPlotDocument( left ) === stringifyPlotDocument( right );
}

function failureFromUnknown(
	revision: number,
	error: unknown,
): ImportPlotDocumentResult {
	const diagnostic: EditorDiagnostic = error !== null && typeof error === 'object' && 'diagnostic' in error
		? ( error as { diagnostic: EditorDiagnostic } ).diagnostic
		: Object.freeze( {
			code: 'INVALID_SCHEMA', severity: 'error' as const,
			message: error instanceof Error ? error.message : '导入失败。',
		} );
	const publicError = Object.freeze( {
		code: diagnostic.code,
		message: diagnostic.message,
		...( diagnostic.path === undefined ? {} : { path: diagnostic.path } ),
	} );
	return Object.freeze( {
		ok: false,
		changed: false,
		revision,
		affectedIds: Object.freeze( [] ),
		diagnostics: Object.freeze( [ Object.freeze( { ...diagnostic } ) ] ),
		idMap: Object.freeze( {} ),
		error: publicError,
	} );
}

function importError( code: string, path: string, message: string ): Error {
	const error = new Error( message ) as Error & { diagnostic: EditorDiagnostic };
	error.diagnostic = Object.freeze( { code, severity: 'error', path, message } );
	return error;
}
