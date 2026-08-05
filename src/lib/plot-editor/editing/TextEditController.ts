import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { CommandResult } from '../commands/types';
import type { PlotDocument } from '../document/PlotDocument';
import type { PlotFeatureId, TextFeature } from '../document/types';

export interface TextInputPlacement {
	readonly x: number;
	readonly y: number;
}

export interface TextEditControllerOptions {
	readonly root: HTMLElement;
	readonly document: PlotDocument;
	readonly executor: CommandExecutor;
	readonly history: HistoryManager;
	readonly onPreviewChange?: ( feature: Readonly<TextFeature> | null ) => void;
	readonly onCommitRequest?: () => void;
	readonly onCancelRequest?: () => void;
}

export interface TextEditSession {
	readonly entityId: PlotFeatureId;
	readonly sourceRevision: number;
	readonly content: string;
}

interface ActiveTextSession {
	readonly entityId: PlotFeatureId;
	readonly source: TextFeature;
	readonly textarea: HTMLTextAreaElement;
	composing: boolean;
	closing: boolean;
}

/**
 * 真实 textarea 文本事务。浏览器负责 IME/composition 和换行，本控制器只拦截
 * Primary+Enter 与 Escape；input 热路径仅产生 transient preview，不写文档/history。
 */
export class TextEditController {
	private readonly _options: TextEditControllerOptions;
	private _session: ActiveTextSession | null = null;
	private _disposed = false;

	public constructor( options: TextEditControllerOptions ) {
		this._options = options;
	}

	public get session(): TextEditSession | null {
		const session = this._session;
		return session === null ? null : Object.freeze( {
			entityId: session.entityId,
			sourceRevision: session.source.revision,
			content: session.textarea.value,
		} );
	}

	public begin( entityId: PlotFeatureId, placement?: TextInputPlacement ): boolean {
		this._assertOpen();
		this.cancel();
		const feature = this._options.document.get( entityId );
		if ( feature?.type !== 'text'
			|| feature.visible === false
			|| feature.properties.editable === false
			|| feature.properties.locked === true ) {
			return false;
		}
		const textarea = this._options.root.ownerDocument.createElement( 'textarea' );
		textarea.className = 'plot-editor-text-input';
		textarea.value = feature.style.content;
		textarea.spellcheck = false;
		textarea.setAttribute( 'aria-label', '编辑标绘文本' );
		textarea.setAttribute( 'data-plot-editor-native-input', 'true' );
		applyTextareaStyle( textarea, placement );
		const session: ActiveTextSession = {
			entityId,
			source: feature,
			textarea,
			composing: false,
			closing: false,
		};
		this._session = session;
		textarea.addEventListener( 'input', this._onInput );
		textarea.addEventListener( 'keydown', this._onKeyDown );
		textarea.addEventListener( 'compositionstart', this._onCompositionStart );
		textarea.addEventListener( 'compositionend', this._onCompositionEnd );
		textarea.addEventListener( 'blur', this._onBlur );
		this._options.root.appendChild( textarea );
		this._emitPreview();
		textarea.focus( { preventScroll: true } );
		textarea.setSelectionRange( textarea.value.length, textarea.value.length );
		return true;
	}

	public commit( label = '编辑文本' ): CommandResult {
		this._assertOpen();
		const session = this._session;
		if ( session === null ) return failure( this._options.document, 'TEXT_TRANSACTION_MISSING', '没有活动文本事务。' );
		const current = this._options.document.get( session.entityId );
		if ( current?.type !== 'text' || current.revision !== session.source.revision ) {
			this._close( session );
			return failure( this._options.document, 'REVISION_CONFLICT', '文本编辑期间图形已被外部修改。' );
		}
		const content = session.textarea.value;
		if ( content === session.source.style.content ) {
			this._close( session );
			return success( this._options.document.revision, false, [] );
		}
		const result = this._options.history.execute(
			this._options.executor,
			{
				type: 'feature.patch',
				id: session.entityId,
				beforeRevision: session.source.revision,
				patch: { style: { content } },
			},
			undefined,
			label,
		);
		this._close( session );
		return result;
	}

	public cancel(): void {
		const session = this._session;
		if ( session !== null ) this._close( session );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this.cancel();
		this._disposed = true;
	}

	private readonly _onInput = (): void => this._emitPreview();
	private readonly _onCompositionStart = (): void => {
		if ( this._session !== null ) this._session.composing = true;
	};
	private readonly _onCompositionEnd = (): void => {
		if ( this._session !== null ) {
			this._session.composing = false;
			this._emitPreview();
		}
	};
	private readonly _onKeyDown = ( event: KeyboardEvent ): void => {
		const session = this._session;
		if ( session === null || session.composing || event.isComposing || event.keyCode === 229 ) return;
		if ( event.key === 'Escape' ) {
			event.preventDefault();
			event.stopPropagation();
			this._options.onCancelRequest?.();
			return;
		}
		if ( event.key === 'Enter' && ( event.ctrlKey || event.metaKey ) ) {
			event.preventDefault();
			event.stopPropagation();
			this._options.onCommitRequest?.();
		}
	};
	private readonly _onBlur = (): void => {
		const session = this._session;
		if ( session !== null && ! session.closing ) this._options.onCommitRequest?.();
	};

	private _emitPreview(): void {
		const session = this._session;
		if ( session === null ) return;
		this._options.onPreviewChange?.( Object.freeze( {
			...session.source,
			style: Object.freeze( {
				...session.source.style,
				content: session.textarea.value,
			} ),
		} ) );
	}

	private _close( session: ActiveTextSession ): void {
		if ( this._session !== session ) return;
		session.closing = true;
		this._session = null;
		session.textarea.removeEventListener( 'input', this._onInput );
		session.textarea.removeEventListener( 'keydown', this._onKeyDown );
		session.textarea.removeEventListener( 'compositionstart', this._onCompositionStart );
		session.textarea.removeEventListener( 'compositionend', this._onCompositionEnd );
		session.textarea.removeEventListener( 'blur', this._onBlur );
		session.textarea.remove();
		this._options.onPreviewChange?.( null );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'TextEditController 已销毁。' );
	}
}

function applyTextareaStyle(
	textarea: HTMLTextAreaElement,
	placement?: TextInputPlacement,
): void {
	const style = textarea.style;
	style.position = 'absolute';
	style.left = `${ placement?.x ?? 12 }px`;
	style.top = `${ placement?.y ?? 12 }px`;
	style.zIndex = '28';
	style.minWidth = '12rem';
	style.minHeight = '4.5rem';
	style.padding = '8px 10px';
	style.border = '1px solid #00e5ff';
	style.borderRadius = '4px';
	style.background = 'rgba(0, 19, 26, 0.92)';
	style.color = '#ffffff';
	style.font = '14px/1.5 sans-serif';
	style.resize = 'both';
	style.outline = 'none';
	style.whiteSpace = 'pre-wrap';
}

function success(
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

function failure( document: PlotDocument, code: string, message: string ): CommandResult {
	return Object.freeze( {
		ok: false,
		changed: false,
		revision: document.revision,
		affectedIds: Object.freeze( [] ),
		error: Object.freeze( { code, message } ),
	} );
}
