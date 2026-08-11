import type { PlotDocumentStore } from '../document/PlotDocument';
import { PlotEditorValidationError } from '../document/diagnostics';
import type {
	JsonValue,
	PlotFeature,
	PlotFeatureId,
} from '../document/types';
import type { CommandExecutor } from './CommandExecutor';
import type {
	CommandResult,
	EditorCommand,
} from './types';

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface HistoryLimits {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

export interface HistoryState {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly undoCount: number;
	readonly redoCount: number;
	readonly estimatedBytes: number;
}

export interface HistoryTransaction {
	readonly id: number;
	readonly label: string;
	readonly mergeKey?: string;
	readonly sourceRevision: number;
	readonly closed: boolean;
}

interface MutableHistoryTransaction extends HistoryTransaction {
	closed: boolean;
}

interface DocumentState {
	readonly revision: number;
	readonly features: ReadonlyMap<PlotFeatureId, PlotFeature>;
	readonly order: readonly PlotFeatureId[];
	readonly metadata: Readonly<Record<string, JsonValue>>;
}

interface HistoryDelta {
	readonly id: PlotFeatureId;
	readonly before: PlotFeature | null;
	readonly after: PlotFeature | null;
}

interface HistoryEntry {
	readonly label: string;
	readonly mergeKey?: string;
	readonly commandType: string;
	readonly deltas: readonly HistoryDelta[];
	readonly orderBefore: readonly PlotFeatureId[];
	readonly orderAfter: readonly PlotFeatureId[];
	readonly metadataBefore: Readonly<Record<string, JsonValue>>;
	readonly metadataAfter: Readonly<Record<string, JsonValue>>;
	readonly estimatedBytes: number;
}

interface ActiveTransaction {
	readonly token: MutableHistoryTransaction;
	readonly before: DocumentState;
	readonly affectedIds: Set<PlotFeatureId>;
	readonly commandTypes: Set<string>;
}

export type HistoryListener = ( state: HistoryState ) => void;

/** 文档 delta 历史；草稿和每帧 pointer move 不应调用本类。 */
export class HistoryManager {
	private readonly _document: PlotDocumentStore;
	private readonly _maxEntries: number;
	private readonly _maxBytes: number;
	private readonly _undo: HistoryEntry[] = [];
	private readonly _redo: HistoryEntry[] = [];
	private readonly _listeners = new Set<HistoryListener>();
	private _active: ActiveTransaction | null = null;
	private _nextTransactionId = 1;
	private _estimatedBytes = 0;

	public constructor(
		document: PlotDocumentStore,
		limits: HistoryLimits = {},
	) {
		this._document = document;
		this._maxEntries = validateLimit(
			limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
			'maxEntries',
		);
		this._maxBytes = validateLimit(
			limits.maxBytes ?? DEFAULT_MAX_BYTES,
			'maxBytes',
		);
	}

	public get canUndo(): boolean {
		return this._undo.length > 0;
	}

	public get canRedo(): boolean {
		return this._redo.length > 0;
	}

	public get hasActiveTransaction(): boolean {
		return this._active !== null;
	}

	public get state(): HistoryState {
		return Object.freeze( {
			canUndo: this.canUndo,
			canRedo: this.canRedo,
			undoCount: this._undo.length,
			redoCount: this._redo.length,
			estimatedBytes: this._estimatedBytes,
		} );
	}

	public subscribe( listener: HistoryListener ): () => void {
		this._listeners.add( listener );
		let active = true;
		return () => {
			if ( active ) {
				active = false;
				this._listeners.delete( listener );
			}
		};
	}

	public begin( label: string, mergeKey?: string ): HistoryTransaction {
		if ( this._active !== null ) {
			throw historyValidationError( 'TRANSACTION_CLOSED', '已有未结束的 history transaction。' );
		}
		if ( typeof label !== 'string' || label.trim().length === 0 ) {
			throw historyValidationError( 'INVALID_COMMAND', 'transaction label 必须是非空字符串。' );
		}
		const token: MutableHistoryTransaction = {
			id: this._nextTransactionId++,
			label,
			...( mergeKey === undefined ? {} : { mergeKey } ),
			sourceRevision: this._document.revision,
			closed: false,
		};
		this._active = {
			token,
			before: captureState( this._document ),
			affectedIds: new Set(),
			commandTypes: new Set(),
		};
		return token;
	}

	/**
	 * 执行命令并记录历史。未传 transaction 时自动建立并提交一个事务；
	 * 已传 transaction 时可连续执行多条命令，最后由调用方 commit/rollback。
	 */
	public execute(
		executor: CommandExecutor,
		command: EditorCommand,
		transaction?: HistoryTransaction,
		label = labelForCommand( command ),
	): CommandResult {
		if ( transaction === undefined ) {
			const automatic = this.begin( label );
			const result = this.execute( executor, command, automatic, label );
			if ( ! result.ok ) {
				this._closeWithoutHistory( automatic );
				return result;
			}
			const committed = this.commit( automatic );
			return result.diagnostics === undefined
				? committed
				: Object.freeze( { ...committed, diagnostics: result.diagnostics } );
		}

		const active = this._requireActive( transaction );
		const result = executor.execute( command );
		if ( result.ok && result.changed ) {
			for ( const id of result.affectedIds ) {
				active.affectedIds.add( id );
			}
			active.commandTypes.add( command.type );
		}
		return result;
	}

	public commit( transaction: HistoryTransaction ): CommandResult {
		const active = this._requireActive( transaction );
		const after = captureState( this._document );
		const entry = createEntry( active, after );
		this._closeActive( active );
		if ( entry === null ) {
			return successResult( this._document.revision, false, [] );
		}

		this._redo.length = 0;
		const previous = this._undo.at( -1 );
		if ( previous !== undefined && canMerge( previous, entry ) ) {
			this._estimatedBytes -= previous.estimatedBytes;
			const merged = mergeEntries( previous, entry );
			this._undo[ this._undo.length - 1 ] = merged;
			this._estimatedBytes += merged.estimatedBytes;
		} else {
			this._undo.push( entry );
			this._estimatedBytes += entry.estimatedBytes;
		}
		this._enforceLimits();
		this._emit();
		return successResult(
			this._document.revision,
			true,
			entry.deltas.map( ( delta ) => delta.id ),
		);
	}

	public rollback( transaction: HistoryTransaction ): void {
		const active = this._requireActive( transaction );
		const current = captureState( this._document );
		this._closeActive( active );
		if ( statesEqual( active.before, current ) ) {
			return;
		}
		this._document.commitCandidate( {
			features: active.before.order.map(
				( id ) => active.before.features.get( id ) as PlotFeature,
			),
			order: active.before.order,
			label: `取消：${ active.token.label }`,
			commandType: 'history.rollback',
			affectedIds: changedIds( active.before, current ),
			metadata: active.before.metadata,
		} );
	}

	public undo(): CommandResult {
		if ( this._active !== null ) {
			return failureResult(
				this._document.revision,
				'TRANSACTION_CLOSED',
				'活动事务结束前不能撤销。',
			);
		}
		const entry = this._undo.at( -1 );
		if ( entry === undefined ) {
			return successResult( this._document.revision, false, [] );
		}
		const conflict = verifyEntrySide( this._document, entry, 'after' );
		if ( conflict !== undefined ) {
			return failureResult( this._document.revision, 'REVISION_CONFLICT', conflict );
		}
		this._applyEntry( entry, 'before', `撤销：${ entry.label }`, 'history.undo' );
		this._undo.pop();
		this._redo.push( entry );
		this._estimatedBytes -= entry.estimatedBytes;
		this._emit();
		return successResult(
			this._document.revision,
			true,
			entry.deltas.map( ( delta ) => delta.id ),
		);
	}

	public redo(): CommandResult {
		if ( this._active !== null ) {
			return failureResult(
				this._document.revision,
				'TRANSACTION_CLOSED',
				'活动事务结束前不能重做。',
			);
		}
		const entry = this._redo.at( -1 );
		if ( entry === undefined ) {
			return successResult( this._document.revision, false, [] );
		}
		const conflict = verifyEntrySide( this._document, entry, 'before' );
		if ( conflict !== undefined ) {
			return failureResult( this._document.revision, 'REVISION_CONFLICT', conflict );
		}
		this._applyEntry( entry, 'after', `重做：${ entry.label }`, 'history.redo' );
		this._redo.pop();
		this._undo.push( entry );
		this._estimatedBytes += entry.estimatedBytes;
		this._emit();
		return successResult(
			this._document.revision,
			true,
			entry.deltas.map( ( delta ) => delta.id ),
		);
	}

	public clear(): void {
		if ( this._active !== null ) {
			throw historyValidationError( 'TRANSACTION_CLOSED', '活动事务结束前不能清空 history。' );
		}
		if ( this._undo.length === 0 && this._redo.length === 0 ) {
			return;
		}
		this._undo.length = 0;
		this._redo.length = 0;
		this._estimatedBytes = 0;
		this._emit();
	}

	private _applyEntry(
		entry: HistoryEntry,
		side: 'before' | 'after',
		label: string,
		commandType: string,
	): void {
		const features = new Map(
			this._document.getAll().map( ( feature ) => [ feature.id, feature as PlotFeature ] ),
		);
		for ( const delta of entry.deltas ) {
			const target = delta[ side ];
			if ( target === null ) {
				features.delete( delta.id );
			} else {
				features.set( delta.id, target );
			}
		}
		const order = side === 'before' ? entry.orderBefore : entry.orderAfter;
		this._document.commitCandidate( {
			features: order.map( ( id ) => features.get( id ) as PlotFeature ),
			order,
			label,
			commandType,
			affectedIds: entry.deltas.map( ( delta ) => delta.id ),
			metadata: side === 'before' ? entry.metadataBefore : entry.metadataAfter,
		} );
	}

	private _requireActive( transaction: HistoryTransaction ): ActiveTransaction {
		if ( transaction.closed || this._active?.token !== transaction ) {
			throw historyValidationError( 'TRANSACTION_CLOSED', 'history transaction 已结束或不属于当前 manager。' );
		}
		return this._active;
	}

	private _closeWithoutHistory( transaction: HistoryTransaction ): void {
		const active = this._requireActive( transaction );
		this._closeActive( active );
	}

	private _closeActive( active: ActiveTransaction ): void {
		active.token.closed = true;
		this._active = null;
	}

	private _enforceLimits(): void {
		while ( this._undo.length > 1 && (
			this._undo.length > this._maxEntries
			|| this._estimatedBytes > this._maxBytes
		) ) {
			const removed = this._undo.shift() as HistoryEntry;
			this._estimatedBytes -= removed.estimatedBytes;
		}
	}

	private _emit(): void {
		const state = this.state;
		for ( const listener of [ ...this._listeners ] ) {
			listener( state );
		}
	}
}

function captureState( document: PlotDocumentStore ): DocumentState {
	const ordered = document.getAll() as readonly PlotFeature[];
	return {
		revision: document.revision,
		features: new Map( ordered.map( ( feature ) => [ feature.id, feature ] ) ),
		order: Object.freeze( ordered.map( ( feature ) => feature.id ) ),
		metadata: document.snapshot().metadata ?? Object.freeze( {} ),
	};
}

function createEntry(
	active: ActiveTransaction,
	after: DocumentState,
): HistoryEntry | null {
	const ids = new Set( [
		...active.before.features.keys(),
		...after.features.keys(),
		...active.affectedIds,
	] );
	const deltas: HistoryDelta[] = [];
	for ( const id of ids ) {
		const before = active.before.features.get( id ) ?? null;
		const next = after.features.get( id ) ?? null;
		if ( ! featureSidesEqual( before, next ) ) {
			deltas.push( Object.freeze( { id, before, after: next } ) );
		}
	}
	const orderChanged = ! arraysEqual( active.before.order, after.order );
	const metadataChanged = ! jsonEqual( active.before.metadata, after.metadata );
	if ( deltas.length === 0 && ! orderChanged && ! metadataChanged ) {
		return null;
	}
	const commandType = active.commandTypes.size === 1
		? [ ...active.commandTypes ][ 0 ]
		: 'transaction.batch';
	return createHistoryEntry( {
		label: active.token.label,
		mergeKey: active.token.mergeKey,
		commandType,
		deltas,
		orderBefore: active.before.order,
		orderAfter: after.order,
		metadataBefore: active.before.metadata,
		metadataAfter: after.metadata,
	} );
}

function createHistoryEntry(
	input: Omit<HistoryEntry, 'estimatedBytes'>,
): HistoryEntry {
	const estimatedBytes = estimateEntryBytes( input );
	return Object.freeze( {
		...input,
		deltas: Object.freeze( [ ...input.deltas ] ),
		orderBefore: Object.freeze( [ ...input.orderBefore ] ),
		orderAfter: Object.freeze( [ ...input.orderAfter ] ),
		metadataBefore: input.metadataBefore,
		metadataAfter: input.metadataAfter,
		estimatedBytes,
	} );
}

function canMerge( previous: HistoryEntry, next: HistoryEntry ): boolean {
	return previous.mergeKey !== undefined
		&& previous.mergeKey === next.mergeKey
		&& arraysEqual(
			previous.deltas.map( ( delta ) => delta.id ).sort(),
			next.deltas.map( ( delta ) => delta.id ).sort(),
		);
}

function mergeEntries( previous: HistoryEntry, next: HistoryEntry ): HistoryEntry {
	const previousById = new Map( previous.deltas.map( ( delta ) => [ delta.id, delta ] ) );
	return createHistoryEntry( {
		label: next.label,
		mergeKey: next.mergeKey,
		commandType: next.commandType,
		deltas: next.deltas.map( ( delta ) => Object.freeze( {
			id: delta.id,
			before: previousById.get( delta.id )?.before ?? delta.before,
			after: delta.after,
		} ) ),
		orderBefore: previous.orderBefore,
		orderAfter: next.orderAfter,
		metadataBefore: previous.metadataBefore,
		metadataAfter: next.metadataAfter,
	} );
}

function verifyEntrySide(
	document: PlotDocumentStore,
	entry: HistoryEntry,
	side: 'before' | 'after',
): string | undefined {
	const expectedOrder = side === 'before' ? entry.orderBefore : entry.orderAfter;
	const currentOrder = document.getAll().map( ( feature ) => feature.id );
	if ( ! arraysEqual( expectedOrder, currentOrder ) ) {
		return '当前 document order 与 history 预期不一致。';
	}
	const expectedMetadata = side === 'before' ? entry.metadataBefore : entry.metadataAfter;
	const currentMetadata = document.snapshot().metadata ?? Object.freeze( {} );
	if ( ! jsonEqual( expectedMetadata, currentMetadata ) ) {
		return '当前 document metadata 与 history 预期不一致。';
	}
	for ( const delta of entry.deltas ) {
		const expected = delta[ side ];
		const current = document.get( delta.id ) as PlotFeature | undefined;
		if ( expected === null ? current !== undefined : ! featureSidesEqual( expected, current ?? null ) ) {
			return `feature ${ delta.id } 已被外部修改，不能安全应用 history。`;
		}
	}
	return undefined;
}

function statesEqual( left: DocumentState, right: DocumentState ): boolean {
	if ( ! arraysEqual( left.order, right.order ) ) {
		return false;
	}
	return jsonEqual( left.metadata, right.metadata ) && left.order.every( ( id ) => featureSidesEqual(
		left.features.get( id ) ?? null,
		right.features.get( id ) ?? null,
	) );
}

function changedIds( left: DocumentState, right: DocumentState ): PlotFeatureId[] {
	const result: PlotFeatureId[] = [];
	for ( const id of new Set( [ ...left.features.keys(), ...right.features.keys() ] ) ) {
		if ( ! featureSidesEqual(
			left.features.get( id ) ?? null,
			right.features.get( id ) ?? null,
		) ) {
			result.push( id );
		}
	}
	return result;
}

function featureSidesEqual(
	left: PlotFeature | null,
	right: PlotFeature | null,
): boolean {
	if ( left === right ) {
		return true;
	}
	if ( left === null || right === null
		|| left.id !== right.id
		|| left.type !== right.type
		|| left.revision !== right.revision ) {
		return false;
	}
	// undo/redo 重新校验时会生成新的冻结对象；只对受影响 feature 做确定性比较。
	return JSON.stringify( left ) === JSON.stringify( right );
}

function estimateEntryBytes(
	entry: Omit<HistoryEntry, 'estimatedBytes'>,
): number {
	let bytes = 0;
	for ( const delta of entry.deltas ) {
		bytes += delta.id.length * 2;
		if ( delta.before !== null ) bytes += JSON.stringify( delta.before ).length * 2;
		if ( delta.after !== null ) bytes += JSON.stringify( delta.after ).length * 2;
	}
	bytes += ( entry.orderBefore.join( '\0' ).length + entry.orderAfter.join( '\0' ).length ) * 2;
	bytes += ( JSON.stringify( entry.metadataBefore ).length
		+ JSON.stringify( entry.metadataAfter ).length ) * 2;
	return bytes;
}

function jsonEqual( left: unknown, right: unknown ): boolean {
	return left === right || JSON.stringify( left ) === JSON.stringify( right );
}

function arraysEqual<T>( left: readonly T[], right: readonly T[] ): boolean {
	return left.length === right.length && left.every( ( value, index ) => value === right[ index ] );
}

function validateLimit( value: number, name: string ): number {
	if ( ! Number.isSafeInteger( value ) || value <= 0 ) {
		throw new RangeError( `${ name } 必须是正安全整数。` );
	}
	return value;
}

function successResult(
	revision: number,
	changed: boolean,
	affectedIds: readonly PlotFeatureId[],
): CommandResult {
	return Object.freeze( {
		ok: true,
		changed,
		revision,
		affectedIds: Object.freeze( [ ...affectedIds ] ),
	} );
}

function failureResult(
	revision: number,
	code: string,
	message: string,
): CommandResult {
	return Object.freeze( {
		ok: false,
		changed: false,
		revision,
		affectedIds: Object.freeze( [] ),
		error: Object.freeze( { code, message } ),
	} );
}

function labelForCommand( command: EditorCommand ): string {
	switch ( command.type ) {
		case 'feature.add': return '添加图形';
		case 'feature.remove': return '删除图形';
		case 'feature.patch': return '修改图形';
		case 'feature.transform': return '变换图形';
		case 'vertex.insert': return '插入顶点';
		case 'vertex.remove': return '删除顶点';
		case 'document.replace': return '替换文档';
	}
}

function historyValidationError( code: string, message: string ): PlotEditorValidationError {
	return new PlotEditorValidationError( { code, severity: 'error', message } );
}
