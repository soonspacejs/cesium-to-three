import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { EditHandle, HandleMovement } from '../adapters/types';
import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { CommandResult, EditorError } from '../commands/types';
import type { PlotDocument } from '../document/PlotDocument';
import type { PlotFeature, PlotFeatureId } from '../document/types';
import { WorkingCopy } from '../state/working-copy';

export interface ShapeEditControllerOptions {
	readonly document: PlotDocument;
	readonly executor: CommandExecutor;
	readonly history: HistoryManager;
	readonly adapters: GeometryAdapterRegistry;
	readonly createTransactionId?: () => string;
	readonly onPreviewChange?: ( preview: ShapeEditPreview | null ) => void;
}

export interface ShapeEditPreview {
	readonly transactionId: string;
	readonly entityId: PlotFeatureId;
	readonly originalHandleId: string;
	readonly activeHandleId: string;
	readonly feature: Readonly<PlotFeature>;
	readonly handles: readonly EditHandle[];
	readonly committable: boolean;
	readonly error?: EditorError;
}

export interface ShapeEditSessionState {
	readonly transactionId: string;
	readonly entityId: PlotFeatureId;
	readonly sourceDocumentRevision: number;
	readonly sourceFeatureRevision: number;
	readonly originalHandleId: string;
	readonly activeHandleId: string;
	readonly dirty: boolean;
	readonly committable: boolean;
}

export interface ShapeEditResult {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly revision: number;
	readonly error?: EditorError;
	readonly preview?: ShapeEditPreview;
}

interface ActiveSession {
	readonly transactionId: string;
	readonly entityId: PlotFeatureId;
	readonly originalHandleId: string;
	readonly sourceDocumentRevision: number;
	readonly sourceFeature: PlotFeature;
	readonly working: WorkingCopy;
	baseFeature: PlotFeature;
	activeHandleId: string;
	dirty: boolean;
	committable: boolean;
	lastError?: EditorError;
}

/**
 * 八类图形共用的控制点编辑事务。
 *
 * pointermove 只更新 WorkingCopy 和 overlay preview；document/history 直到 pointerup
 * commit 才各写一次。任何失败都保留最后合法候选，取消则丢弃整个事务。
 */
export class ShapeEditController {
	private readonly _document: PlotDocument;
	private readonly _executor: CommandExecutor;
	private readonly _history: HistoryManager;
	private readonly _adapters: GeometryAdapterRegistry;
	private readonly _createTransactionId: () => string;
	private readonly _onPreviewChange?: ( preview: ShapeEditPreview | null ) => void;
	private _session: ActiveSession | undefined;
	private _disposed = false;

	public constructor( options: ShapeEditControllerOptions ) {
		this._document = options.document;
		this._executor = options.executor;
		this._history = options.history;
		this._adapters = options.adapters;
		this._createTransactionId = options.createTransactionId ?? defaultTransactionId;
		this._onPreviewChange = options.onPreviewChange;
	}

	public get session(): ShapeEditSessionState | null {
		const session = this._session;
		return session === undefined ? null : freezeSessionState( session );
	}

	public begin( entityId: PlotFeatureId, handleId: string ): ShapeEditResult {
		if ( this._disposed ) return this._failure( 'EDITOR_DISPOSED', '图形编辑控制器已销毁。' );
		if ( this._session !== undefined ) {
			return this._failure( 'EDIT_TRANSACTION_ACTIVE', '已有控制点编辑事务正在进行。' );
		}
		const feature = this._document.get( entityId );
		if ( feature === undefined ) {
			return this._failure( 'EDIT_HANDLE_NOT_FOUND', `图形不存在：${ entityId }。` );
		}
		if ( feature.visible === false
			|| feature.properties.editable === false
			|| feature.properties.locked === true ) {
			return this._failure( 'EDIT_ENTITY_NOT_EDITABLE', '隐藏、锁定或只读图形不能编辑。' );
		}
		if ( handleId.startsWith( 'generated:' ) || handleId.startsWith( 'derived:' ) ) {
			return this._failure(
				'EDIT_DERIVED_GEOMETRY_READONLY',
				'派生轮廓不是作者控制点，不能建立编辑事务。',
			);
		}
		const adapter = this._adapters.require( feature.type );
		const handle = adapter.listHandles( feature as never ).find(
			( candidate ) => candidate.id === handleId,
		);
		if ( handle === undefined ) {
			return this._failure( 'EDIT_HANDLE_NOT_FOUND', `控制点不存在：${ handleId }。` );
		}

		const sourceFeature = feature as PlotFeature;
		const working = new WorkingCopy( this._document, [ entityId ] );
		this._session = {
			transactionId: this._createTransactionId(),
			entityId,
			originalHandleId: handleId,
			activeHandleId: handleId,
			sourceDocumentRevision: this._document.revision,
			sourceFeature,
			baseFeature: sourceFeature,
			working,
			dirty: false,
			committable: false,
		};
		const preview = this._createPreview( this._session );
		this._emitPreview( preview );
		return Object.freeze( {
			ok: true, changed: false, revision: this._document.revision, preview,
		} );
	}

	/** 天空/无 surface 时传 null；候选保留，但本次 pointerup 不允许提交。 */
	public update( movement: HandleMovement | null ): ShapeEditResult {
		if ( this._disposed ) return this._failure( 'EDITOR_DISPOSED', '图形编辑控制器已销毁。' );
		const session = this._session;
		if ( session === undefined ) {
			return this._failure( 'EDIT_TRANSACTION_MISSING', '没有活动的控制点编辑事务。' );
		}
		if ( this._document.revision !== session.sourceDocumentRevision ) {
			return this._rollbackFailure(
				session,
				'REVISION_CONFLICT',
				'编辑期间文档被外部修改，工作副本已回滚。',
			);
		}
		if ( movement === null ) {
			session.committable = false;
			session.lastError = errorValue( 'EDIT_SURFACE_MISS', '当前指针没有可用地表命中。' );
			const preview = this._createPreview( session );
			this._emitPreview( preview );
			return Object.freeze( {
				ok: false, changed: false, revision: this._document.revision,
				error: session.lastError, preview,
			} );
		}

		const adapter = this._adapters.require( session.sourceFeature.type );
		const result = session.working.update( session.entityId, () =>
			adapter.applyHandle(
				session.baseFeature as never,
				session.activeHandleId,
				movement,
			) );
		if ( ! result.ok || result.feature === undefined ) {
			session.committable = false;
			session.lastError = editorErrorFromUnknown( result.error );
			const preview = this._createPreview( session );
			this._emitPreview( preview );
			return Object.freeze( {
				ok: false, changed: false, revision: this._document.revision,
				error: session.lastError, preview,
			} );
		}

		if ( session.activeHandleId.startsWith( 'midpoint:' ) ) {
			const edgeIndex = parseIndexedHandle( session.activeHandleId, 'midpoint' );
			// 中点首次拖动只插入一次；后续 move 固定编辑刚插入的 vertex。
			session.activeHandleId = `vertex:${ edgeIndex + 1 }`;
			session.baseFeature = result.feature as PlotFeature;
		}
		// 拖拽热路径不对大图形做逐帧 stringify；空事务只在 commit 时比较一次。
		session.dirty = true;
		session.committable = true;
		session.lastError = undefined;
		const preview = this._createPreview( session );
		this._emitPreview( preview );
		return Object.freeze( {
			ok: true, changed: session.dirty, revision: this._document.revision, preview,
		} );
	}

	public commit( label = '拖动控制点' ): CommandResult {
		if ( this._disposed ) return this._commandFailure( 'EDITOR_DISPOSED', '图形编辑控制器已销毁。' );
		const session = this._session;
		if ( session === undefined ) {
			return this._commandFailure( 'EDIT_TRANSACTION_MISSING', '没有活动的控制点编辑事务。' );
		}
		this._session = undefined;
		const candidate = session.working.get( session.entityId );
		const semanticallyEmpty = candidate === undefined
			|| featuresSemanticallyEqual( session.sourceFeature, candidate as PlotFeature );
		if ( ! session.committable || ! session.dirty || semanticallyEmpty ) {
			session.working.cancel();
			this._emitPreview( null );
			return this._commandFailure(
				session.lastError?.code ?? 'EDIT_NO_VALID_PREVIEW',
				session.lastError?.message ?? '控制点没有产生可提交的有效变化。',
			);
		}
		const result = session.working.commit( this._executor, this._history, label );
		if ( ! result.ok && ! session.working.closed ) session.working.cancel();
		this._emitPreview( null );
		return result;
	}

	public cancel(): void {
		const session = this._session;
		if ( session === undefined ) return;
		this._session = undefined;
		session.working.cancel();
		this._emitPreview( null );
	}

	/** 删除活动 source vertex；最小拓扑与自交校验仍由 adapter 统一执行。 */
	public removeVertex(
		entityId: PlotFeatureId,
		handleId: string,
		label = '删除顶点',
	): CommandResult {
		if ( this._disposed ) return this._commandFailure( 'EDITOR_DISPOSED', '图形编辑控制器已销毁。' );
		if ( this._session !== undefined ) {
			return this._commandFailure( 'EDIT_TRANSACTION_ACTIVE', '拖拽期间不能同时删除顶点。' );
		}
		const feature = this._document.get( entityId );
		if ( feature === undefined ) return this._commandFailure( 'FEATURE_NOT_FOUND', `图形不存在：${ entityId }。` );
		if ( feature.visible === false
			|| feature.properties.editable === false
			|| feature.properties.locked === true ) {
			return this._commandFailure( 'EDIT_ENTITY_NOT_EDITABLE', '隐藏、锁定或只读图形不能编辑。' );
		}
		const adapter = this._adapters.require( feature.type );
		const handle = adapter.listHandles( feature as never ).find(
			( candidate ) => candidate.id === handleId && candidate.kind === 'vertex',
		);
		if ( handle === undefined ) return this._commandFailure( 'EDIT_HANDLE_NOT_FOUND', '只能删除现存 source vertex。' );

		const working = new WorkingCopy( this._document, [ entityId ] );
		const update = working.update( entityId, () =>
			adapter.removeVertex( feature as never, handleId ) );
		if ( ! update.ok ) {
			working.cancel();
			const error = editorErrorFromUnknown( update.error );
			return this._commandFailure( error.code, error.message );
		}
		const result = working.commit( this._executor, this._history, label );
		if ( ! result.ok && ! working.closed ) working.cancel();
		return result;
	}

	/** 删除 selection 作为一个原子命令，undo 恢复原 id 与 document order。 */
	public deleteFeatures(
		ids: readonly PlotFeatureId[],
		label = '删除选中图形',
	): CommandResult {
		if ( this._disposed ) return this._commandFailure( 'EDITOR_DISPOSED', '图形编辑控制器已销毁。' );
		if ( this._session !== undefined ) {
			return this._commandFailure( 'EDIT_TRANSACTION_ACTIVE', '拖拽期间不能删除选择。' );
		}
		return this._history.execute(
			this._executor,
			{ type: 'feature.remove', ids: Object.freeze( [ ...new Set( ids ) ] ) },
			undefined,
			label,
		);
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this.cancel();
		this._disposed = true;
	}

	private _createPreview( session: ActiveSession ): ShapeEditPreview {
		const feature = session.working.get( session.entityId ) ?? session.sourceFeature;
		const adapter = this._adapters.require( feature.type );
		return Object.freeze( {
			transactionId: session.transactionId,
			entityId: session.entityId,
			originalHandleId: session.originalHandleId,
			activeHandleId: session.activeHandleId,
			feature,
			handles: Object.freeze( [ ...adapter.listHandles( feature as never ) ] ),
			committable: session.committable,
			...( session.lastError === undefined ? {} : { error: session.lastError } ),
		} );
	}

	private _rollbackFailure(
		session: ActiveSession,
		code: string,
		message: string,
	): ShapeEditResult {
		this._session = undefined;
		session.working.cancel();
		this._emitPreview( null );
		return this._failure( code, message );
	}

	private _failure( code: string, message: string ): ShapeEditResult {
		return Object.freeze( {
			ok: false,
			changed: false,
			revision: this._document.revision,
			error: errorValue( code, message ),
		} );
	}

	private _commandFailure( code: string, message: string ): CommandResult {
		return Object.freeze( {
			ok: false,
			changed: false,
			revision: this._document.revision,
			affectedIds: Object.freeze( [] ),
			error: errorValue( code, message ),
		} );
	}

	private _emitPreview( preview: ShapeEditPreview | null ): void {
		this._onPreviewChange?.( preview );
	}
}

function freezeSessionState( session: ActiveSession ): ShapeEditSessionState {
	return Object.freeze( {
		transactionId: session.transactionId,
		entityId: session.entityId,
		sourceDocumentRevision: session.sourceDocumentRevision,
		sourceFeatureRevision: session.sourceFeature.revision,
		originalHandleId: session.originalHandleId,
		activeHandleId: session.activeHandleId,
		dirty: session.dirty,
		committable: session.committable,
	} );
}

function editorErrorFromUnknown( error: unknown ): EditorError {
	if ( error !== null && typeof error === 'object' ) {
		const diagnostic = ( error as { diagnostic?: { code?: unknown; message?: unknown } } ).diagnostic;
		if ( diagnostic !== undefined
			&& typeof diagnostic.code === 'string'
			&& typeof diagnostic.message === 'string' ) {
			const nestedCode = /^([A-Z][A-Z0-9_]+)[：:]/.exec( diagnostic.message )?.[ 1 ];
			return errorValue(
				diagnostic.code === 'INVALID_COMMAND' && nestedCode !== undefined
					? nestedCode
					: diagnostic.code,
				diagnostic.message,
			);
		}
	}
	const message = error instanceof Error ? error.message : '控制点更新失败。';
	const code = /^([A-Z][A-Z0-9_]+)[：:]/.exec( message )?.[ 1 ] ?? 'EDIT_INVALID_GEOMETRY';
	return errorValue( code, message );
}

function errorValue( code: string, message: string ): EditorError {
	return Object.freeze( { code, message } );
}

function parseIndexedHandle( id: string, prefix: string ): number {
	const match = new RegExp( `^${ prefix }:(\\d+)$` ).exec( id );
	if ( match === null ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ id }。` );
	return Number( match[ 1 ] );
}

function featuresSemanticallyEqual( left: PlotFeature, right: PlotFeature ): boolean {
	const { revision: _leftRevision, ...leftValue } = left;
	const { revision: _rightRevision, ...rightValue } = right;
	return JSON.stringify( leftValue ) === JSON.stringify( rightValue );
}

let nextTransactionId = 1;

function defaultTransactionId(): string {
	return `shape-edit:${ nextTransactionId++ }`;
}
