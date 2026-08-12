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
	readonly panel: HTMLDivElement;
	readonly textarea: HTMLTextAreaElement;
	readonly commitButton: HTMLButtonElement;
	readonly cancelButton: HTMLButtonElement;
	composing: boolean;
	closing: boolean;
}

interface TextEditorElements {
	readonly panel: HTMLDivElement;
	readonly textarea: HTMLTextAreaElement;
	readonly commitButton: HTMLButtonElement;
	readonly cancelButton: HTMLButtonElement;
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
		const elements = this._createEditor( feature.style.content );
		const session: ActiveTextSession = {
			kind: 'feature',
			entityId,
			source: feature,
			...elements,
			composing: false,
			closing: false,
		};
		this._open( session, placement );
		return true;
	}

	/** 新建 text 时复用同一原生输入控件，正文只写入 transient drawing draft。 */
	public beginDraft( content = '', placement?: TextInputPlacement ): void {
		this._assertOpen();
		this.cancel();
		const elements = this._createEditor( content );
		this._open( {
			kind: 'draft', ...elements, composing: false, closing: false,
		}, placement );
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
		this._handleSessionKeyDown( event );
	};
	private readonly _onDocumentKeyDown = ( event: KeyboardEvent ): void => {
		// textarea 正常持有焦点时会在元素监听器中处理；这里专门兜底宿主
		// canvas/controls 抢走焦点后的活动文本事务。
		if ( event.target === this._session?.textarea ) return;
		this._handleSessionKeyDown( event );
	};
	private readonly _onDocumentPointerDown = ( event: PointerEvent ): void => {
		const session = this._session;
		if ( session === null || session.panel.contains( event.target as Node | null ) ) return;
		// 点击编辑面板外部确认当前内容。捕获阶段先
		// 结束事务，随后 canvas 可以正常处理这次点击，不会残留 text-editing。
		if ( session.kind === 'draft' ) this._options.onDraftCommitRequest?.();
		else this._options.onCommitRequest?.();
	};

	private _handleSessionKeyDown( event: KeyboardEvent ): void {
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
	}
	private readonly _onCommitClick = (): void => {
		const session = this._session;
		if ( session === null ) return;
		if ( session.kind === 'draft' ) this._options.onDraftCommitRequest?.();
		else this._options.onCommitRequest?.();
	};
	private readonly _onCancelClick = (): void => {
		const session = this._session;
		if ( session === null ) return;
		if ( session.kind === 'draft' ) this._options.onDraftCancelRequest?.();
		else this._options.onCancelRequest?.();
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
		session.commitButton.removeEventListener( 'click', this._onCommitClick );
		session.cancelButton.removeEventListener( 'click', this._onCancelClick );
		this._options.root.ownerDocument.removeEventListener( 'keydown', this._onDocumentKeyDown, true );
		this._options.root.ownerDocument.removeEventListener( 'pointerdown', this._onDocumentPointerDown, true );
		session.textarea.remove();
		session.panel.remove();
		if ( session.kind === 'feature' ) this._options.onPreviewChange?.( null );
	}

	private _createEditor( content: string ): TextEditorElements {
		const ownerDocument = this._options.root.ownerDocument;
		const panel = ownerDocument.createElement( 'div' );
		panel.className = 'plot-editor-text-panel';
		panel.setAttribute( 'role', 'dialog' );
		panel.setAttribute( 'aria-label', '文本编辑器' );
		panel.setAttribute( 'data-plot-editor-text-panel', 'true' );
		applyPanelStyle( panel );

		const header = ownerDocument.createElement( 'div' );
		header.textContent = '编辑文本';
		applyHeaderStyle( header );
		panel.appendChild( header );

		const textarea = ownerDocument.createElement( 'textarea' );
		textarea.className = 'plot-editor-text-input';
		textarea.value = content;
		textarea.spellcheck = false;
		textarea.autocomplete = 'off';
		textarea.setAttribute( 'aria-label', '编辑标绘文本' );
		textarea.setAttribute( 'data-plot-editor-native-input', 'true' );
		textarea.title = '输入标绘文本';
		applyTextareaStyle( textarea );
		panel.appendChild( textarea );

		const footer = ownerDocument.createElement( 'div' );
		applyFooterStyle( footer );
		const hint = ownerDocument.createElement( 'span' );
		hint.textContent = 'Ctrl/⌘+Enter 保存 · Esc 取消';
		applyHintStyle( hint );
		footer.appendChild( hint );
		const actions = ownerDocument.createElement( 'div' );
		applyActionsStyle( actions );
		const cancelButton = ownerDocument.createElement( 'button' );
		cancelButton.type = 'button';
		cancelButton.textContent = '取消';
		cancelButton.setAttribute( 'data-plot-editor-text-cancel', 'true' );
		applyButtonStyle( cancelButton, false );
		actions.appendChild( cancelButton );
		const commitButton = ownerDocument.createElement( 'button' );
		commitButton.type = 'button';
		commitButton.textContent = '保存';
		commitButton.setAttribute( 'data-plot-editor-text-commit', 'true' );
		applyButtonStyle( commitButton, true );
		actions.appendChild( commitButton );
		footer.appendChild( actions );
		panel.appendChild( footer );
		return { panel, textarea, commitButton, cancelButton };
	}

	private _open( session: ActiveTextSession, placement?: TextInputPlacement ): void {
		this._session = session;
		const textarea = session.textarea;
		textarea.addEventListener( 'input', this._onInput );
		textarea.addEventListener( 'keydown', this._onKeyDown );
		textarea.addEventListener( 'compositionstart', this._onCompositionStart );
		textarea.addEventListener( 'compositionend', this._onCompositionEnd );
		session.commitButton.addEventListener( 'click', this._onCommitClick );
		session.cancelButton.addEventListener( 'click', this._onCancelClick );
		this._options.root.ownerDocument.addEventListener( 'keydown', this._onDocumentKeyDown, true );
		this._options.root.ownerDocument.addEventListener( 'pointerdown', this._onDocumentPointerDown, true );
		this._options.root.appendChild( session.panel );
		placePanelAwayFromAnchor( session.panel, this._options.root, placement );
		this._emitPreview();
		textarea.focus( { preventScroll: true } );
		// 新建文本中的默认提示只是占位内容；首次输入应直接替换它。
		if ( session.kind === 'draft' ) textarea.select();
		else textarea.setSelectionRange( textarea.value.length, textarea.value.length );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'TextEditController 已销毁。' );
	}
}

function applyTextareaStyle(
	textarea: HTMLTextAreaElement,
): void {
	const style = textarea.style;
	style.all = 'initial';
	style.display = 'block';
	style.boxSizing = 'border-box';
	style.width = '100%';
	style.height = '8rem';
	style.minWidth = '0';
	style.minHeight = '5rem';
	style.margin = '0';
	style.padding = '10px 12px';
	style.border = '1px solid rgba(143, 182, 200, 0.55)';
	style.borderRadius = '6px';
	style.background = '#071b25';
	style.color = '#ffffff';
	style.caretColor = '#ffffff';
	style.font = '14px/1.55 Inter, system-ui, sans-serif';
	style.resize = 'vertical';
	style.outline = 'none';
	style.whiteSpace = 'pre-wrap';
	style.pointerEvents = 'auto';
	style.userSelect = 'text';
	style.touchAction = 'auto';
	style.opacity = '1';
	style.visibility = 'visible';
	style.boxShadow = 'inset 0 1px 3px rgba(0, 0, 0, 0.35)';
}

function applyPanelStyle( panel: HTMLDivElement ): void {
	const style = panel.style;
	style.all = 'initial';
	style.position = 'absolute';
	style.zIndex = '2147483647';
	style.boxSizing = 'border-box';
	style.width = 'min(360px, calc(100% - 24px))';
	style.padding = '12px';
	style.border = '1px solid rgba(0, 229, 255, 0.75)';
	style.borderRadius = '10px';
	style.background = 'rgba(3, 17, 24, 0.98)';
	style.color = '#ffffff';
	style.font = '12px/1.45 Inter, system-ui, sans-serif';
	style.pointerEvents = 'auto';
	style.userSelect = 'none';
	style.isolation = 'isolate';
	style.boxShadow = '0 18px 55px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(0, 229, 255, 0.18)';
}

function applyHeaderStyle( header: HTMLDivElement ): void {
	header.style.all = 'initial';
	header.style.display = 'block';
	header.style.margin = '0 0 9px';
	header.style.font = '600 14px/1.4 Inter, system-ui, sans-serif';
	header.style.color = '#dff9ff';
}

function applyFooterStyle( footer: HTMLDivElement ): void {
	footer.style.all = 'initial';
	footer.style.display = 'flex';
	footer.style.alignItems = 'center';
	footer.style.justifyContent = 'space-between';
	footer.style.gap = '10px';
	footer.style.marginTop = '10px';
}

function applyHintStyle( hint: HTMLSpanElement ): void {
	hint.style.all = 'initial';
	hint.style.color = '#8fb6c8';
	hint.style.font = '11px/1.35 Inter, system-ui, sans-serif';
}

function applyActionsStyle( actions: HTMLDivElement ): void {
	actions.style.all = 'initial';
	actions.style.display = 'flex';
	actions.style.gap = '8px';
}

function applyButtonStyle( button: HTMLButtonElement, primary: boolean ): void {
	button.style.all = 'initial';
	button.style.display = 'inline-block';
	button.style.boxSizing = 'border-box';
	button.style.minWidth = '58px';
	button.style.margin = '0';
	button.style.padding = '6px 12px';
	button.style.border = primary ? '1px solid #00e5ff' : '1px solid rgba(255, 255, 255, 0.22)';
	button.style.borderRadius = '5px';
	button.style.background = primary ? '#00e5ff' : 'rgba(255, 255, 255, 0.08)';
	button.style.color = primary ? '#00131a' : '#ffffff';
	button.style.font = '600 12px/1.4 Inter, system-ui, sans-serif';
	button.style.cursor = 'pointer';
}

function placePanelAwayFromAnchor(
	panel: HTMLDivElement,
	root: HTMLElement,
	placement?: TextInputPlacement,
): void {
	const rootHeight = root.clientHeight;
	const anchorOnTop = placement === undefined || rootHeight <= 0 || placement.y <= rootHeight / 2;
	// 编辑器统一靠右，避免覆盖常见的左上信息区和左下工具栏；仅按锚点
	// 的上下半区切换垂直位置，让面板与正在编辑的地面文字保持分离。
	panel.style.left = '';
	panel.style.right = '12px';
	panel.style.top = anchorOnTop ? '' : '12px';
	panel.style.bottom = anchorOnTop ? '12px' : '';
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
