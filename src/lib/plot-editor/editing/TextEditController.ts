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
	readonly onDraftChange?: ( content: string ) => void;
	readonly onCommitRequest?: () => void;
	readonly onCancelRequest?: () => void;
	readonly onDraftCommitRequest?: () => void;
	readonly onDraftCancelRequest?: () => void;
}

export interface TextEditSession {
	readonly kind: 'feature';
	readonly entityId: PlotFeatureId;
	readonly sourceRevision: number;
	readonly content: string;
}

export interface TextDraftInputSession {
	readonly kind: 'draft';
	readonly content: string;
}

export type TextInputSession = TextEditSession | TextDraftInputSession;

interface ActiveTextSessionBase {
	readonly textarea: HTMLTextAreaElement;
	composing: boolean;
	closing: boolean;
}

interface ActiveFeatureTextSession extends ActiveTextSessionBase {
	readonly kind: 'feature';
	readonly entityId: PlotFeatureId;
	readonly source: TextFeature;
}

interface ActiveDraftTextSession extends ActiveTextSessionBase {
	readonly kind: 'draft';
}

type ActiveTextSession = ActiveFeatureTextSession | ActiveDraftTextSession;

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

	public get session(): TextInputSession | null {
		const session = this._session;
		if ( session === null ) return null;
		return session.kind === 'draft'
			? Object.freeze( { kind: 'draft', content: session.textarea.value } )
			: Object.freeze( {
				kind: 'feature',
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
		const textarea = this._createTextarea( feature.style.content, placement );
		const session: ActiveTextSession = {
			kind: 'feature',
			entityId,
			source: feature,
			textarea,
			composing: false,
			closing: false,
		};
		this._open( session );
		return true;
	}

	/** 新建 text 时复用同一原生输入控件，正文只写入 transient drawing draft。 */
	public beginDraft( content = '', placement?: TextInputPlacement ): void {
		this._assertOpen();
		this.cancel();
		const textarea = this._createTextarea( content, placement );
		this._open( {
			kind: 'draft', textarea, composing: false, closing: false,
		} );
	}

	public commit( label = '编辑文本' ): CommandResult {
		this._assertOpen();
		const session = this._session;
		if ( session === null ) return failure( this._options.document, 'TEXT_TRANSACTION_MISSING', '没有活动文本事务。' );
		if ( session.kind !== 'feature' ) {
			return failure( this._options.document, 'TEXT_TRANSACTION_MISSING', '当前是新建文本输入，不是已有文本事务。' );
		}
		const source = session.source;
		const entityId = session.entityId;
		const current = this._options.document.get( entityId );
		if ( current?.type !== 'text' || current.revision !== source.revision ) {
			this._close( session );
			return failure( this._options.document, 'REVISION_CONFLICT', '文本编辑期间图形已被外部修改。' );
		}
		const content = session.textarea.value;
		if ( content === source.style.content ) {
			this._close( session );
			return success( this._options.document.revision, false, [] );
		}
		const result = this._options.history.execute(
			this._options.executor,
			{
				type: 'feature.patch',
				id: entityId,
				beforeRevision: source.revision,
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

	/** 绘制事务已成功写入文档后关闭 draft 输入，不触发额外命令。 */
	public closeDraft(): void {
		if ( this._session?.kind === 'draft' ) this._close( this._session );
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
			if ( session.kind === 'draft' ) this._options.onDraftCancelRequest?.();
			else this._options.onCancelRequest?.();
			return;
		}
		if ( event.key === 'Enter' && ( event.ctrlKey || event.metaKey ) ) {
			event.preventDefault();
			event.stopPropagation();
			if ( session.kind === 'draft' ) this._options.onDraftCommitRequest?.();
			else this._options.onCommitRequest?.();
		}
	};
	private readonly _onBlur = (): void => {
		const session = this._session;
		if ( session === null || session.closing ) return;
		if ( session.kind === 'draft' ) this._options.onDraftCommitRequest?.();
		else this._options.onCommitRequest?.();
	};

	private _emitPreview(): void {
		const session = this._session;
		if ( session === null ) return;
		if ( session.kind === 'draft' ) {
			this._options.onDraftChange?.( session.textarea.value );
			return;
		}
		const source = session.source;
		this._options.onPreviewChange?.( Object.freeze( {
			...source,
			style: Object.freeze( {
				...source.style,
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
		if ( session.kind === 'feature' ) this._options.onPreviewChange?.( null );
	}

	private _createTextarea( content: string, placement?: TextInputPlacement ): HTMLTextAreaElement {
		const textarea = this._options.root.ownerDocument.createElement( 'textarea' );
		textarea.className = 'plot-editor-text-input';
		textarea.value = content;
		textarea.spellcheck = false;
		textarea.setAttribute( 'aria-label', '编辑标绘文本' );
		textarea.setAttribute( 'data-plot-editor-native-input', 'true' );
		applyTextareaStyle( textarea, placement );
		return textarea;
	}

	private _open( session: ActiveTextSession ): void {
		this._session = session;
		const textarea = session.textarea;
		textarea.addEventListener( 'input', this._onInput );
		textarea.addEventListener( 'keydown', this._onKeyDown );
		textarea.addEventListener( 'compositionstart', this._onCompositionStart );
		textarea.addEventListener( 'compositionend', this._onCompositionEnd );
		textarea.addEventListener( 'blur', this._onBlur );
		this._options.root.appendChild( textarea );
		this._emitPreview();
		textarea.focus( { preventScroll: true } );
		textarea.setSelectionRange( textarea.value.length, textarea.value.length );
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
