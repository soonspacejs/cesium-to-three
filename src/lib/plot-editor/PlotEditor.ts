import type { Object3D, PerspectiveCamera } from 'three';
import type { CesiumGroundFrameState } from '../ground';
import { createBuiltinGeometryAdapterRegistry } from './adapters/builtins';
import type { GeometryAdapterRegistry } from './adapters/GeometryAdapterRegistry';
import type { DrawToolContext } from './adapters/types';
import { CommandExecutor } from './commands/CommandExecutor';
import { HistoryManager, type HistoryLimits } from './commands/HistoryManager';
import type { CommandResult, EditorCommand } from './commands/types';
import {
	createPlotDocumentStore,
	type PlotDocument,
	type PlotDocumentChange,
	type PlotDocumentStore,
} from './document/PlotDocument';
import type {
	HeightReference,
	PlotFeature,
	PlotDocumentSnapshot,
	PlotFeatureId,
	PlotFeatureType,
	Position3D,
	ResolvedPlotGeometry,
} from './document/types';
import { createEnuFrame, ecefToEnu, geodeticToEcef } from './document/geodesy';
import {
	PlotDrawingController,
	type DrawingControllerResult,
	type DrawingSession,
} from './drawing/PlotDrawingController';
import {
	ShapeEditController,
	type ShapeEditPreview,
} from './editing/ShapeEditController';
import { TextEditController } from './editing/TextEditController';
import {
	PlotEditorEventDispatcher,
	type PlotEditorEventListener,
	type PlotEditorEventMap,
	type PlotEditorEventType,
	type PlotEditorMode,
} from './events';
import type { EditorKeymap, EditorKeymapOverrides, NavigationAdapter } from './input/types';
import { createEditorKeymap } from './input/Keymap';
import { KeyboardInput } from './input/KeyboardInput';
import { PointerInput } from './input/PointerInput';
import { CommandRouter, type RouterContext } from './input/CommandRouter';
import type {
	CommandContext,
	FocusDomain,
	KeyboardStateSnapshot,
	NormalizedPointerInput,
	PointerClaim,
	PointerDispatch,
} from './input/types';
import {
	PlotDocumentImporter,
	type ImportPlotDocumentOptions,
	type ImportPlotDocumentResult,
} from './persistence/PlotDocumentImporter';
import { decodePlotDocument, type DecodePlotDocumentOptions } from './persistence/codec';
import { SaveCoordinator } from './persistence/SaveCoordinator';
import {
	HeightResolutionManager,
} from './picking/height-resolver';
import type {
	PlotSurfaceHeightProvider,
	PlotSurfacePicker,
} from './picking/types';
import {
	EditorOverlayRenderer,
	type EditorRenderReason,
} from './render/EditorOverlayRenderer';
import {
	FeatureHitTester,
	type EditorProjectionSnapshot,
} from './selection/FeatureHitTester';
import { createCameraProjectionSnapshot } from './selection/CameraProjectionSnapshot';
import {
	SelectionController,
	createAdapterAwareSelectionModel,
} from './selection/SelectionController';
import type { SelectionState } from './state/SelectionModel';
import {
	createInitialEditorState,
	reduceEditor,
	type EditorEffect,
	type EditorEvent,
	type EditorState,
} from './state/PlotEditorMachine';
import type { HitTarget, ScreenPoint, TransformMode } from './state/types';
import { EnuTransformController } from './transform/EnuTransformController';
import { createEnuFeatureTransform } from './transform/feature-transform';
import { getSelectionGizmoCapabilities } from './transform/gizmo';
import type { GizmoCapabilities, TransformPreview } from './transform/types';

export interface EditorRenderHost {
	readonly scene: Object3D;
	readonly camera: PerspectiveCamera;
	getFrameState(): CesiumGroundFrameState;
	requestRender( reason: EditorRenderReason ): void;
}

export interface PlotEditorOptions {
	readonly root: HTMLElement;
	readonly canvas: HTMLCanvasElement;
	readonly document?: unknown;
	readonly documentId?: string;
	readonly renderHost: EditorRenderHost;
	readonly surfacePicker: PlotSurfacePicker;
	readonly surfaceProvider?: PlotSurfaceHeightProvider;
	readonly cameraController: NavigationAdapter;
	readonly keymap?: EditorKeymap | EditorKeymapOverrides;
	readonly idGenerator?: () => PlotFeatureId;
	readonly requestSave?: ( snapshot: PlotDocumentSnapshot ) => void | Promise<void>;
	readonly historyLimits?: HistoryLimits;
	readonly decodeOptions?: DecodePlotDocumentOptions;
	readonly autoAttachInputs?: boolean;
}

export type SelectionMode = 'replace' | 'add' | 'toggle';

export type DrawTool = PlotFeatureType | DrawToolContext<any>;

/**
 * 标绘编辑器的单一公共入口。
 *
 * facade 持有全部可变子系统，宿主只能通过命令和明确的编辑 API 写入文档；
 * document、selection 与导出结果都只暴露不可变快照。
 */
export class PlotEditor {
	public readonly document: PlotDocument;

	private readonly _canvas: HTMLCanvasElement;
	private readonly _renderHost: EditorRenderHost;
	private readonly _cameraController: NavigationAdapter;
	private readonly _surfacePicker: PlotSurfacePicker;
	private readonly _adapters: GeometryAdapterRegistry;
	private readonly _store: PlotDocumentStore;
	private readonly _executor: CommandExecutor;
	private readonly _history: HistoryManager;
	private readonly _events = new PlotEditorEventDispatcher();
	private readonly _selectionModel;
	private readonly _hitTester: FeatureHitTester;
	private readonly _selectionController: SelectionController;
	private readonly _drawing: PlotDrawingController;
	private readonly _shapeEditor: ShapeEditController;
	private readonly _transform: EnuTransformController;
	private readonly _textEditor: TextEditController;
	private readonly _overlay: EditorOverlayRenderer;
	private readonly _importer: PlotDocumentImporter;
	private readonly _save?: SaveCoordinator;
	private readonly _heightResolver?: HeightResolutionManager;
	private readonly _router: CommandRouter;
	private readonly _keyboard: KeyboardInput;
	private readonly _pointer: PointerInput;
	private readonly _resolved = new Map<PlotFeatureId, ResolvedPlotGeometry>();
	private readonly _unsubscribers: Array<() => void> = [];
	private _drawingSession: DrawingSession | null = null;
	private _shapePreview: ShapeEditPreview | null = null;
	private _transformPreview: TransformPreview | null = null;
	private _textPreview: Readonly<Extract<PlotFeature, { type: 'text' }>> | null = null;
	private _mode: PlotEditorMode = 'select';
	private _state: EditorState;
	private _vertexEditId: PlotFeatureId | undefined;
	private _pointerTransactionStart: PointerTransactionStart | null = null;
	private _internalCommandDepth = 0;
	private _pendingDocumentRevision: number | undefined;
	private _sessionRevision = 0;
	private _disposed = false;

	public constructor( options: PlotEditorOptions ) {
		assertOptions( options );
		this._canvas = options.canvas;
		this._renderHost = options.renderHost;
		this._cameraController = options.cameraController;
		this._surfacePicker = options.surfacePicker;

		const initial = options.document === undefined
			? createEmptySnapshot( options.documentId ?? 'plot-document' )
			: decodePlotDocument( options.document, options.decodeOptions ).snapshot;
		this._store = createPlotDocumentStore( {
			id: initial.documentId,
			revision: initial.revision,
			features: initial.features,
			order: initial.order,
			metadata: initial.metadata,
		} );
		this.document = this._store;

		const adapters = createBuiltinGeometryAdapterRegistry();
		this._adapters = adapters;
		this._executor = new CommandExecutor( this._store, {
			transformFeature: createEnuFeatureTransform( adapters ),
		} );
		this._history = new HistoryManager( this._store, options.historyLimits );
		this._selectionModel = createAdapterAwareSelectionModel( this._store, adapters );
		this._shapeEditor = new ShapeEditController( {
			document: this._store,
			executor: this._executor,
			history: this._history,
			adapters,
			onPreviewChange: ( preview ) => {
				this._shapePreview = preview;
				this._invalidateTransient( 'draft' );
			},
		} );
		this._transform = new EnuTransformController( {
			document: this._store,
			executor: this._executor,
			history: this._history,
			adapters,
			onPreviewChange: ( preview ) => {
				this._transformPreview = preview;
				this._invalidateTransient( 'draft' );
			},
			onDiagnostic: ( diagnostic ) => this._events.dispatch( 'validationerror', {
				diagnostic: Object.freeze( {
					code: diagnostic.code,
					severity: 'warning',
					message: diagnostic.message,
				} ),
			} ),
		} );
		this._textEditor = new TextEditController( {
			root: options.root,
			document: this._store,
			executor: this._executor,
			history: this._history,
			onPreviewChange: ( preview ) => {
				this._textPreview = preview;
				this._invalidateTransient( 'draft' );
			},
			onDraftChange: ( content ) => this._updateDraftText( content ),
			onCommitRequest: () => this._dispatch( { type: 'commitTextEdit' } ),
			onCancelRequest: () => this._dispatch( { type: 'cancelTextEdit' } ),
			onDraftCommitRequest: () => this._dispatch( { type: 'commitDrawing' } ),
			onDraftCancelRequest: () => this._dispatch( {
				type: 'cancelCurrentOperation', reason: 'escape',
			} ),
		} );
		this._hitTester = new FeatureHitTester( this._store, adapters );
		this._selectionController = new SelectionController( {
			model: this._selectionModel,
			hitTester: this._hitTester,
			shapeEditor: this._shapeEditor,
		} );
		this._drawing = new PlotDrawingController( {
			registry: adapters,
			document: this._store,
			executor: this._executor,
			history: this._history,
			createFeatureId: options.idGenerator,
			onDraftChange: ( session ) => {
				this._drawingSession = session;
				this._invalidateTransient( 'draft' );
			},
		} );
		this._overlay = new EditorOverlayRenderer( {
			scene: options.renderHost.scene,
			camera: options.renderHost.camera,
			adapters,
			requestRender: ( reason ) => options.renderHost.requestRender( reason ),
			onRenderError: ( error ) => this._events.dispatch( 'rendererror', error ),
		} );
		this._importer = new PlotDocumentImporter( {
			document: this._store,
			executor: this._executor,
			history: this._history,
			idGenerator: options.idGenerator,
		} );
		this._save = options.requestSave === undefined
			? undefined
			: new SaveCoordinator( options.requestSave );

		this._state = createInitialEditorState(
			this._store.revision,
			this._selectionModel.state,
		);
		this._router = new CommandRouter( this._createRouterContext() );
		const keymap = createEditorKeymap(
			( id, context ) => {
				const result = this._router.canExecuteCommand( id, context );
				if ( id === 'document.save' && result === 'blocked'
					&& ! this._hasSaveHandler() ) {
					this._reportMissingSaveHandler();
				} else if ( id.startsWith( 'transform.' ) && result === 'blocked' ) {
					this._reportBlockedTransformCommand( id );
				}
				return result;
			},
			options.keymap,
		);
		this._keyboard = new KeyboardInput( {
			root: options.root,
			keymap,
			getCommandContext: ( keyboard, focus ) => this._createCommandContext( keyboard, focus ),
			onCommandError: ( error, id ) => this._reportError(
				'KEYBOARD_COMMAND_FAILED', `键盘命令 ${ id } 执行失败。`, error,
			),
			onCancelHeld: ( reason ) => this._dispatch( {
				type: 'FOCUS_LOST', reason: reason === 'hidden' ? 'hidden' : 'blur',
			} ),
		} );
		this._pointer = new PointerInput( {
			canvas: options.canvas,
			navigation: options.cameraController,
			claim: ( input ) => this._claimPointer( input ),
			getKeyboardModifiers: () => ( { space: this._keyboard.getSnapshot().space } ),
			onCancelOperation: ( reason ) => this._dispatch( {
				type: 'cancelCurrentOperation', reason,
			} ),
			onError: ( code, error ) => this._reportError( code, '指针 capture 失败。', error ),
			onCaptureChange: ( active ) => this._keyboard.setPointerCaptureActive( active ),
			shouldPreventContextMenu: () => this._state.interaction.kind === 'drawing',
		} );
		this._unsubscribers.push(
			this._keyboard.subscribe( ( input ) => {
				if ( input.commandId === undefined || input.commandResult !== 'consumed' ) return;
				const routed = this._router.routeCommand( input.commandId, input );
				if ( routed.result === 'blocked' ) {
					if ( input.commandId.startsWith( 'transform.' ) ) {
						this._reportBlockedTransformCommand( input.commandId );
					}
					return;
				}
				for ( const intent of routed.intents ) this._dispatch( intent );
			} ),
			this._pointer.subscribe( ( dispatch ) => this._onPointerDispatch( dispatch ) ),
		);

		this._unsubscribers.push(
			this._store.subscribe( ( change ) => this._onDocumentChange( change ) ),
			this._selectionModel.subscribe( ( selection ) => this._onSelectionChange( selection ) ),
			this._history.subscribe( ( state ) => this._events.dispatch( 'historystatechange', state ) ),
		);

		if ( options.surfaceProvider !== undefined ) {
			this._heightResolver = new HeightResolutionManager( {
				provider: options.surfaceProvider,
				document: this._store,
				onResolved: ( result ) => {
					this._resolved.set( result.plotId, result );
					this._events.dispatch( 'surfacechange', {
						featureIds: Object.freeze( [ result.plotId ] ),
						status: result.status,
					} );
					this._syncOverlay();
					this._renderHost.requestRender( 'surface' );
				},
				onInvalidate: () => {
					this._resolved.clear();
					this._resolveAllHeights();
				},
				onError: ( error, id ) => this._reportError(
					'SURFACE_UNAVAILABLE',
					`图形 ${ id } 的高度解析失败。`,
					error,
				),
			} );
		}

		this._syncOverlay();
		this._resolveAllHeights();
		this._dispatch( { type: 'INITIALIZE' } );
		if ( options.autoAttachInputs !== false ) {
			this._keyboard.attach();
			this._pointer.attach();
		}
	}

	public get selection(): ReadonlySet<PlotFeatureId> {
		return new Set( this._selectionModel.state.ids );
	}

	public get selectionState(): SelectionState {
		return this._selectionModel.state;
	}

	public get mode(): PlotEditorMode {
		return this._mode;
	}

	public get canUndo(): boolean {
		return this._history.canUndo;
	}

	public get canRedo(): boolean {
		return this._history.canRedo;
	}

	public activateTool( tool: DrawTool | 'select' ): void {
		this._assertOpen();
		this._cancelPreviews();
		if ( tool === 'select' ) {
			this._dispatch( { type: 'SET_TOOL', tool: { kind: 'select' } } );
			return;
		}
		const context: DrawToolContext<any> = typeof tool === 'string'
			? { type: tool, heightReference: 0 as HeightReference }
			: tool;
		this._dispatch( {
			type: 'SET_TOOL',
			tool: {
				kind: 'draw',
				graphicsType: context.type,
				heightReference: context.heightReference,
			},
		} );
		this._drawing.arm( context );
	}

	public execute( command: EditorCommand ): CommandResult {
		this._assertOpen();
		if ( this._hasActivePreview() ) {
			return commandFailure( this._store.revision, 'TRANSACTION_ACTIVE', '活动编辑事务结束前不能执行外部命令。' );
		}
		return this._reportCommandResult(
			this._history.execute( this._executor, command ),
		);
	}

	public undo(): CommandResult {
		this._assertOpen();
		if ( this._hasActivePreview() ) {
			return commandFailure( this._store.revision, 'TRANSACTION_ACTIVE', '活动编辑事务结束前不能撤销。' );
		}
		return this._reportCommandResult( this._history.undo() );
	}

	public redo(): CommandResult {
		this._assertOpen();
		if ( this._hasActivePreview() ) {
			return commandFailure( this._store.revision, 'TRANSACTION_ACTIVE', '活动编辑事务结束前不能重做。' );
		}
		return this._reportCommandResult( this._history.redo() );
	}

	public select( ids: Iterable<PlotFeatureId>, mode: SelectionMode = 'replace' ): void {
		this._assertOpen();
		const values = [ ...ids ];
		if ( mode === 'toggle' ) {
			for ( const id of values ) this._selectionModel.apply( { kind: 'toggle', id } );
		} else {
			this._selectionModel.apply( { kind: mode, ids: values } );
		}
	}

	public clearSelection(): void {
		this._assertOpen();
		this._vertexEditId = undefined;
		this._selectionController.clear();
	}

	/** 顶点控制点只在显式编辑态出现，避免“选中即满屏控制点”。 */
	public enterVertexEdit( id: PlotFeatureId ): void {
		this._assertOpen();
		if ( ! this._store.has( id ) ) throw new Error( `图形不存在：${ id }。` );
		this._selectionModel.apply( { kind: 'replace', ids: [ id ] } );
		this._vertexEditId = id;
		this._invalidateTransient( 'selection' );
	}

	public exitVertexEdit(): void {
		this._assertOpen();
		if ( this._vertexEditId === undefined ) return;
		this._vertexEditId = undefined;
		this._selectionModel.setActiveHandle( undefined );
		this._invalidateTransient( 'selection' );
	}

	public focus(): void {
		this._assertOpen();
		this._keyboard.focus();
	}

	public blur(): void {
		if ( this._disposed ) return;
		this._keyboard.blur();
		this._dispatch( { type: 'FOCUS_LOST', reason: 'blur' } );
	}

	public export(): PlotDocumentSnapshot {
		this._assertOpen();
		return this._store.snapshot();
	}

	public import(
		input: unknown,
		options: ImportPlotDocumentOptions = {},
	): ImportPlotDocumentResult {
		this._assertOpen();
		if ( this._hasActivePreview() ) this._cancelPreviews();
		const result = this._importer.import( input, options );
		if ( ! result.ok ) this._reportImportFailure( result );
		return result;
	}

	/** 由宿主唯一 RAF 调用；编辑器自身绝不创建第二条动画循环。 */
	public update( frameState: CesiumGroundFrameState = this._renderHost.getFrameState() ): void {
		if ( this._disposed ) return;
		this._syncOverlay();
		this._overlay.update( frameState );
	}

	public requestSave(): void {
		this._assertOpen();
		if ( ! this._hasSaveHandler() ) {
			this._reportMissingSaveHandler();
			return;
		}
		const snapshot = this._store.snapshot();
		this._events.dispatch( 'saverequest', { snapshot, revision: snapshot.revision } );
		void this._save?.request( snapshot ).catch( ( error ) => this._reportError(
			'SAVE_FAILED', '保存标绘文档失败。', error,
		) );
	}

	public addEventListener<K extends PlotEditorEventType>(
		type: K,
		listener: PlotEditorEventListener<K>,
	): void {
		this._events.addEventListener( type, listener );
		if ( type === 'saverequest' ) this._refreshDerivedState();
	}

	public removeEventListener<K extends PlotEditorEventType>(
		type: K,
		listener: PlotEditorEventListener<K>,
	): void {
		this._events.removeEventListener( type, listener );
		if ( type === 'saverequest' && ! this._disposed ) this._refreshDerivedState();
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._dispatch( { type: 'DISPOSE' } );
		this._disposed = true;
		this._cancelPreviews();
		for ( const unsubscribe of this._unsubscribers.splice( 0 ) ) unsubscribe();
		this._heightResolver?.dispose();
		this._save?.dispose();
		this._pointer.dispose();
		this._keyboard.dispose();
		this._drawing.dispose();
		this._shapeEditor.dispose();
		this._transform.dispose();
		this._textEditor.dispose();
		this._selectionController.dispose();
		this._selectionModel.dispose();
		this._executor.dispose();
		this._overlay.dispose();
		this._cameraController.dispose();
		this._events.dispose();
	}

	private _dispatch( event: EditorEvent ): void {
		if ( this._disposed && event.type !== 'DISPOSE' ) return;
		const previous = this._state;
		const transition = reduceEditor( previous, event );
		this._state = transition.state;

		// 轴约束和事务内模式切换是纯状态变化，没有单独 effect；在这里同步控制器。
		if ( event.type === 'constrainTransform' && this._transform.session !== null ) {
			const result = this._transform.constrain( event.axis );
			if ( ! result.ok ) this._reportControllerError( result.error );
		}
		if ( event.type === 'beginTransform'
			&& previous.interaction.kind === 'transforming'
			&& previous.interaction.mode !== event.mode ) {
			this._transform.cancel();
			this._beginTransformController( event.mode );
		}

		this._refreshDerivedState();
		for ( const effect of transition.effects ) this._executeEffect( effect );
		this._syncOverlay();
	}

	private _executeEffect( effect: EditorEffect ): void {
		switch ( effect.type ) {
			case 'PICK_SURFACE': this._resolveDrawingSurface( effect ); break;
			case 'CANCEL_SURFACE_REQUEST': break; // v1 picker 为同步端口，没有悬挂 Promise。
			case 'VALIDATE_DRAFT': this._validateAndSynchronizeDraft( effect ); break;
			case 'RENDER_DRAFT': this._invalidateTransient( 'draft' ); break;
			case 'COMMIT_DRAFT': this._commitDrawing( effect.sessionId ); break;
			case 'FOCUS_DRAFT_TEXT_INPUT': this._focusDraftTextInput( effect ); break;
			case 'ROLLBACK_PREVIEW':
				this._drawing.cancel( effect.transactionId );
				this._shapeEditor.cancel();
				this._transform.cancel();
				this._textEditor.cancel();
				this._pointerTransactionStart = null;
				break;
			case 'APPLY_SELECTION':
				this._selectionController.applyHit(
					effect.ids[ 0 ] === undefined ? null : Object.freeze( {
						kind: 'entity', entityId: effect.ids[ 0 ], distanceCssPixels: 0,
					} ),
					effect.operation,
				);
				if ( effect.ids.length > 1 ) {
					this.select( effect.ids.slice( 1 ), effect.operation === 'replace' ? 'add' : effect.operation );
				}
				break;
			case 'APPLY_BOX_SELECTION':
				this._selectionController.selectBox(
					effect.start,
					effect.end,
					this._createProjectionSnapshot(),
					effect.additive ? 'add' : 'replace',
					{
						onDiagnostic: ( diagnostic ) => this._events.dispatch( 'validationerror', {
							diagnostic,
						} ),
					},
				);
				break;
			case 'SET_ACTIVE_HANDLE':
				try {
					this._selectionModel.setActiveHandle( effect.handleId, effect.entityId );
				} catch {
					// Gizmo id 不是 adapter 的 shape handle，由 transform controller 持有。
				}
				break;
			case 'HIT_TEST_HOVER': {
				const hit = this._hitTest( effect.screen, 'mouse' );
				this._selectionModel.setHover( hit );
				this._dispatch( { type: 'HOVER_RESOLVED', hit } );
				break;
			}
			case 'SELECT_ALL': this._selectionController.selectAll(); break;
			case 'DELETE_SELECTION': this._runInternalCommand( () => {
				const result = this._selectionController.deleteContext();
				this._reportCommandResult( result );
				if ( result.ok ) this._selectionController.clear();
				return result;
			} ); break;
			case 'HISTORY_UNDO': this._reportCommandResult( this._history.undo() ); break;
			case 'HISTORY_REDO': this._reportCommandResult( this._history.redo() ); break;
			case 'REQUEST_SAVE': this.requestSave(); break;
			case 'BEGIN_TRANSACTION': this._beginEditorTransaction( effect ); break;
			case 'UPDATE_POINTER_TRANSACTION': this._updatePointerTransaction(
				effect.transactionId,
				effect.screen,
				effect.modifiers,
			); break;
			case 'UPDATE_KEYBOARD_TRANSACTION': {
				const result = this._transform.nudge( effect.axis, effect.amountMeters );
				if ( result.changed ) this._dispatch( {
					type: 'TRANSACTION_UPDATED', transactionId: effect.transactionId,
				} );
				else if ( ! result.ok ) this._reportControllerError( result.error );
				break;
			}
			case 'COMMIT_TRANSACTION': this._commitEditorTransaction( effect.transactionId ); break;
			case 'ROLLBACK_TRANSACTION':
				this._shapeEditor.cancel();
				this._transform.cancel();
				this._textEditor.cancel();
				this._pointerTransactionStart = null;
				break;
			case 'FOCUS_TEXT_INPUT': this._focusTextInput( effect.entityId ); break;
			case 'REPORT_ERROR': this._reportError(
				effect.code,
				detailMessage( effect.detail, '编辑操作失败。' ),
				effect.detail,
			); break;
			case 'DISPOSE_RESOURCES': break;
		}
	}

	private _resolveDrawingSurface(
		effect: Extract<EditorEffect, { type: 'PICK_SURFACE' }>,
	): void {
		try {
			const hit = this._pickSurface( effect.request.screen, effect.heightReference );
			if ( hit === null ) {
				this._dispatch( {
					type: 'SURFACE_FAILED',
					requestId: effect.request.requestId,
					sessionId: effect.request.sessionId,
					revision: effect.request.documentRevision,
					error: new Error( '当前指针未命中可用 surface。' ),
				} );
				return;
			}
			if ( effect.request.purpose === 'point' ) this._drawing.addPick( hit );
			else this._drawing.movePick( hit );
			this._dispatch( {
				type: 'SURFACE_RESOLVED',
				requestId: effect.request.requestId,
				sessionId: effect.request.sessionId,
				revision: effect.request.documentRevision,
				position: hit.authorPosition,
			} );
		} catch ( error ) {
			this._dispatch( {
				type: 'SURFACE_FAILED',
				requestId: effect.request.requestId,
				sessionId: effect.request.sessionId,
				revision: effect.request.documentRevision,
				error,
			} );
		}
	}

	private _validateAndSynchronizeDraft(
		effect: Extract<EditorEffect, { type: 'VALIDATE_DRAFT' }>,
	): void {
		let session = this._drawing.session;
		if ( session === null ) return;
		while ( session.draft.points.length > effect.draft.coordinates.length ) {
			this._drawing.removeLastPoint();
			session = this._drawing.session as DrawingSession;
		}
		for ( let index = session.draft.points.length; index < effect.draft.coordinates.length; index++ ) {
			this._drawing.addPick( draftPick(
				effect.draft.coordinates[ index ],
				session.draft.heightReference,
			) );
		}
		const validation = this._drawing.session?.draft.validation;
		this._dispatch( {
			type: 'DRAFT_VALIDATED',
			sessionId: effect.sessionId,
			draftRevision: effect.draftRevision,
			valid: validation?.valid === true,
			errors: validation?.message === undefined
				? Object.freeze( [] )
				: Object.freeze( [ validation.message ] ),
		} );
	}

	private _commitDrawing( sessionId: string ): void {
		const textDraft = this._textEditor.session?.kind === 'draft'
			? this._textEditor.session.content
			: undefined;
		if ( textDraft !== undefined ) {
			const update = this._drawing.updateText( textDraft );
			if ( ! update.ok ) {
				this._dispatchDraftCommitFailed(
					sessionId,
					update.validation?.code ?? 'DRAW_TEXT_INPUT_REQUIRED',
					update.validation?.message ?? '文本内容不能提交。',
				);
				return;
			}
		}
		let result: DrawingControllerResult;
		try {
			result = this._runInternalCommand( () => this._drawing.finish() );
		} catch ( error ) {
			this._dispatchDraftCommitFailed(
				sessionId,
				'DRAW_COMMIT_FAILED',
				detailMessage( error, '绘制提交发生未预期错误。' ),
			);
			return;
		}
		if ( result.ok ) {
			this._textEditor.closeDraft();
			this._dispatch( {
				type: 'DRAFT_COMMITTED',
				sessionId,
				documentRevision: this._store.revision,
			} );
			this._flushPendingDocumentRevision();
			return;
		}
		this._dispatchDraftCommitFailed(
			sessionId,
			result.validation?.code ?? result.command?.error?.code ?? 'DRAW_INVALID_PARAMETER',
			result.validation?.message ?? result.command?.error?.message ?? '绘制草稿不能提交。',
		);
	}

	private _dispatchDraftCommitFailed( sessionId: string, code: string, message: string ): void {
		this._dispatch( {
			type: 'DRAFT_COMMIT_FAILED',
			sessionId,
			code,
			detail: Object.freeze( { message } ),
		} );
	}

	private _beginEditorTransaction(
		effect: Extract<EditorEffect, { type: 'BEGIN_TRANSACTION' }>,
	): void {
		const interaction = this._state.interaction;
		const start = interaction.kind === 'dragging-handle'
			|| interaction.kind === 'dragging-entity'
			? interaction.start
			: undefined;
		let ok = false;
		if ( interaction.kind === 'text-editing' ) {
			return;
		} else if ( effect.handleId !== undefined && isGizmoHandleId( effect.handleId ) ) {
			const mode = transformModeForHandle( effect.handleId );
			const active = this._transform.session;
			let begun = active?.mode === mode;
			if ( ! begun ) {
				if ( active !== null ) this._transform.cancel();
				begun = this._beginTransformController( mode, effect.selectedIds );
			}
			if ( begun ) {
				const axis = transformAxisForHandle( effect.handleId );
				if ( axis !== undefined ) this._transform.constrain( axis );
				ok = true;
			}
		} else if ( effect.handleId !== undefined && effect.entityId !== undefined ) {
			this._vertexEditId = effect.entityId;
			ok = this._shapeEditor.begin( effect.entityId, effect.handleId ).ok;
		} else {
			ok = this._beginTransformController(
				effect.transformMode ?? 'translate',
				effect.selectedIds,
			);
		}
		if ( ok && start !== undefined ) {
			const feature = effect.entityId === undefined
				? this._store.get( this._selectionModel.state.primaryId ?? '' )
				: this._store.get( effect.entityId );
			this._pointerTransactionStart = Object.freeze( {
				screen: start,
				surface: feature === undefined
					? undefined
					: this._pickSurface( start, feature.heightReference )?.authorPosition,
			} );
			return;
		}
		if ( ! ok ) this._dispatch( {
			type: 'TRANSACTION_FAILED',
			transactionId: effect.transaction.id,
			code: 'TRANSACTION_BEGIN_FAILED',
			recoverable: false,
		} );
	}

	private _beginTransformController(
		mode: TransformMode,
		ids = this._selectionModel.state.ids,
	): boolean {
		const primary = this._selectionModel.state.primaryId ?? ids[ 0 ];
		if ( primary === undefined ) return false;
		const result = this._transform.begin( ids, primary, mode );
		if ( ! result.ok ) this._reportControllerError( result.error );
		return result.ok;
	}

	private _updatePointerTransaction(
		transactionId: string,
		screen: ScreenPoint,
		modifiers: { readonly shift: boolean; readonly alt: boolean },
	): void {
		if ( this._shapeEditor.session !== null ) {
			const feature = this._store.get( this._shapeEditor.session.entityId );
			const hit = feature === undefined ? null : this._pickSurface( screen, feature.heightReference );
			const start = this._pointerTransactionStart?.screen ?? screen;
			const result = this._shapeEditor.update( hit === null ? null : {
				authorPosition: hit.authorPosition,
				screenDeltaCssPixels: [ screen.x - start.x, screen.y - start.y ],
				shift: modifiers.shift,
				alt: modifiers.alt,
			} );
			if ( result.changed ) this._dispatch( { type: 'TRANSACTION_UPDATED', transactionId } );
			else if ( ! result.ok ) this._reportControllerError( result.error );
			return;
		}
		const session = this._transform.session;
		if ( session === null ) return;
		const start = this._pointerTransactionStart;
		let result;
		if ( session.mode === 'translate' ) {
			const primary = this._store.get( this._selectionModel.state.primaryId ?? '' );
			const current = primary === undefined ? null : this._pickSurface( screen, primary.heightReference );
			if ( current === null || start?.surface === undefined ) return;
			const frame = createEnuFrame( session.pivot.position );
			const origin = ecefToEnu( geodeticToEcef( start.surface ), frame );
			const target = ecefToEnu( geodeticToEcef( current.authorPosition ), frame );
			result = this._transform.update( {
				translationMeters: [
					target[ 0 ] - origin[ 0 ],
					target[ 1 ] - origin[ 1 ],
					target[ 2 ] - origin[ 2 ],
				],
			} );
		} else if ( session.mode === 'rotate' ) {
			const dx = screen.x - ( start?.screen.x ?? screen.x );
			const dy = screen.y - ( start?.screen.y ?? screen.y );
			result = this._transform.update( { rotationDegrees: [ dx, -dy, dx ] } );
		} else {
			const dx = screen.x - ( start?.screen.x ?? screen.x );
			const factor = Math.max( 0.01, Math.exp( dx * 0.01 ) );
			result = this._transform.update( { scale: [ factor, factor, factor ] } );
		}
		if ( result.changed ) this._dispatch( { type: 'TRANSACTION_UPDATED', transactionId } );
		else if ( ! result.ok ) this._reportControllerError( result.error );
	}

	private _commitEditorTransaction( transactionId: string ): void {
		const result = this._runInternalCommand( () => this._textEditor.session !== null
			? this._textEditor.commit()
			: this._shapeEditor.session !== null
				? this._shapeEditor.commit()
				: this._transform.commit() );
		this._pointerTransactionStart = null;
		if ( result.ok || result.error?.code === 'EDIT_NO_VALID_PREVIEW'
			|| result.error?.code === 'TRANSFORM_EMPTY' ) {
			this._dispatch( {
				type: 'TRANSACTION_COMMITTED',
				transactionId,
				documentRevision: this._store.revision,
			} );
			this._flushPendingDocumentRevision();
			return;
		}
		this._dispatch( {
			type: 'TRANSACTION_FAILED',
			transactionId,
			code: result.error?.code ?? 'TRANSACTION_COMMIT_FAILED',
			recoverable: false,
			detail: result.error,
		} );
		this._flushPendingDocumentRevision();
	}

	private _focusDraftTextInput(
		effect: Extract<EditorEffect, { type: 'FOCUS_DRAFT_TEXT_INPUT' }>,
	): void {
		const interaction = this._state.interaction;
		const session = this._drawing.session;
		if ( interaction.kind !== 'drawing' || interaction.sessionId !== effect.sessionId
			|| session?.type !== 'text' ) return;
		let placement: { x: number; y: number } | undefined;
		try {
			const projected = this._createProjectionSnapshot().project( effect.position );
			if ( projected !== null ) placement = { x: projected.x, y: projected.y };
		} catch {
			// viewport 尚未稳定时沿用 textarea 默认位置，不能阻断文本事务。
		}
		this._textEditor.beginDraft( session.preview.text ?? '', placement );
	}

	private _updateDraftText( content: string ): void {
		const interaction = this._state.interaction;
		const session = this._drawing.session;
		if ( interaction.kind !== 'drawing' || session?.type !== 'text' ) return;
		try {
			this._drawing.updateText( content );
		} catch ( error ) {
			this._reportError( 'DRAW_TEXT_INPUT_REQUIRED', '文本输入更新失败。', error );
			return;
		}
		const validation = this._drawing.session?.draft.validation;
		this._dispatch( {
			type: 'DRAFT_VALIDATED',
			sessionId: interaction.sessionId,
			draftRevision: interaction.draftRevision,
			valid: validation?.valid === true,
			errors: validation?.message === undefined
				? Object.freeze( [] )
				: Object.freeze( [ validation.message ] ),
		} );
	}

	private _focusTextInput( entityId: PlotFeatureId ): void {
		const feature = this._store.get( entityId );
		let placement: { x: number; y: number } | undefined;
		if ( feature?.type === 'text' ) {
			try {
				const projected = this._createProjectionSnapshot().project( feature.geometry.position );
				if ( projected !== null ) placement = { x: projected.x, y: projected.y };
			} catch {
				// 隐藏或零尺寸 viewport 时回退到编辑器左上角，文本事务仍可用。
			}
		}
		if ( this._textEditor.begin( entityId, placement ) ) return;
		const transactionId = this._state.activeTransaction?.id;
		if ( transactionId !== undefined ) this._dispatch( {
			type: 'TRANSACTION_FAILED',
			transactionId,
			code: 'TEXT_SELECTION_REQUIRED',
			recoverable: false,
		} );
	}

	private _onPointerDispatch( dispatch: PointerDispatch ): void {
		const screen = Object.freeze( {
			x: dispatch.input.canvasX,
			y: dispatch.input.canvasY,
		} );
		const needsHit = dispatch.input.phase === 'down'
			|| dispatch.input.phase === 'up'
			|| dispatch.input.phase === 'double-click';
		const hit = needsHit ? this._hitTest( screen, dispatch.input.device ) : null;
		if ( dispatch.input.phase === 'double-click'
			&& this._state.interaction.kind !== 'drawing'
			&& hit?.kind === 'entity'
			&& hit.entityId !== undefined ) {
			this.enterVertexEdit( hit.entityId );
			return;
		}
		const intents = this._router.routePointer( dispatch, hit );
		for ( const intent of intents ) this._dispatch( intent );
	}

	private _claimPointer( input: NormalizedPointerInput ): PointerClaim {
		if ( input.modifiers.space ) return pointerClaim( 'navigation', 'camera-override', false, false );
		if ( input.button !== 'primary' ) return pointerClaim( 'navigation', 'empty-surface', false, false );
		if ( this._state.interaction.kind === 'drawing' ) {
			return pointerClaim( 'editor', 'draw', true, true );
		}
		const hit = this._hitTest( { x: input.canvasX, y: input.canvasY }, input.device );
		if ( hit?.kind === 'vertex' || hit?.kind === 'midpoint' ) {
			return pointerClaim( 'editor', 'handle', true, true );
		}
		if ( hit?.kind === 'gizmo' ) return pointerClaim( 'editor', 'handle', true, true );
		if ( hit?.kind === 'entity' ) return pointerClaim( 'editor', 'entity', true, true );
		if ( input.modifiers.primary ) return pointerClaim( 'editor', 'box-select', true, true );
		return pointerClaim( 'navigation', 'empty-surface', false, false );
	}

	private _hitTest(
		screen: ScreenPoint,
		pointerType: 'mouse' | 'pen' | 'touch',
	): HitTarget | null {
		let projection: EditorProjectionSnapshot;
		try {
			projection = this._createProjectionSnapshot();
		} catch {
			return null;
		}
		const selectedIds = this._vertexEditId === undefined
			? Object.freeze( [] )
			: Object.freeze( [ this._vertexEditId ] );
		const overlayHits = this._overlay.hitTestOverlayMarkers( screen, projection );
		return this._hitTester.hitTest( screen, projection, {
			pointerType,
			selectedIds,
			activeHandleId: this._vertexEditId === undefined
				? undefined
				: this._selectionModel.state.activeHandleId,
			overlayHits,
		} );
	}

	private _createProjectionSnapshot(): EditorProjectionSnapshot {
		return createCameraProjectionSnapshot( {
			camera: this._renderHost.camera,
			canvas: this._canvas,
		} );
	}

	private _pickSurface( screen: ScreenPoint, heightReference: HeightReference ) {
		const rect = this._canvas.getBoundingClientRect();
		return this._surfacePicker.pick( {
			clientX: rect.left + screen.x,
			clientY: rect.top + screen.y,
		}, { heightReference } );
	}

	private _createCommandContext(
		keyboard: KeyboardStateSnapshot,
		focus: FocusDomain,
	): CommandContext {
		const primary = this._selectionModel.state.primaryId;
		const interaction = this._state.interaction;
		const transaction: CommandContext[ 'transaction' ] = interaction.kind === 'drawing'
			? 'draft'
			: interaction.kind === 'dragging-handle' || interaction.kind === 'dragging-entity'
				? 'pointer-drag'
				: interaction.kind === 'transforming'
					? 'keyboard-nudge'
					: interaction.kind === 'text-editing' ? 'text' : 'none';
		return Object.freeze( {
			focus,
			mode: interaction.kind === 'transforming'
				? 'transform'
				: interaction.kind === 'text-editing'
					? 'text-edit'
					: this._state.tool.kind === 'draw' ? 'draw' : 'select',
			transaction,
			selectionCount: this._selectionModel.state.ids.length,
			...( primary === undefined ? {} : { primarySelectionId: primary } ),
			...( this._selectionModel.state.activeHandleId === undefined ? {} : {
				activeHandleId: this._selectionModel.state.activeHandleId,
			} ),
			...( this._state.tool.kind === 'draw' ? {
				heightReference: this._state.tool.heightReference,
			} : {} ),
			keyboard,
		} );
	}

	private _createRouterContext(): RouterContext {
		const interaction = this._state.interaction;
		const selection = this._selectionModel.state;
		const selectedFeatures = selection.ids
			.map( ( id ) => this._store.get( id ) )
			.filter( ( feature ): feature is Readonly<PlotFeature> => feature !== undefined );
		const routerInteraction = routerInteractionForState( interaction.kind );
		const transformMode = interaction.kind === 'transforming' ? interaction.mode : undefined;
		const gizmoCapabilities = getSelectionGizmoCapabilities( selectedFeatures, this._adapters );
		return Object.freeze( {
			lifecycle: this._state.lifecycle,
			mode: interaction.kind === 'transforming'
				? 'transform'
				: interaction.kind === 'text-editing'
					? 'text-edit'
					: this._state.tool.kind === 'draw' ? 'draw' : 'select',
			interaction: routerInteraction,
			draftPointCount: interaction.kind === 'drawing'
				? interaction.draft.coordinates.length
				: 0,
			draftRedoCount: interaction.kind === 'drawing'
				? interaction.redoCoordinates.length
				: 0,
			selectionCount: selection.ids.length,
			selectedText: selectedFeatures.length === 1 && selectedFeatures[ 0 ].type === 'text',
			...( interaction.kind === 'pointer-pending' ? { pendingHit: interaction.hit } : {} ),
			transformSupportsScale: selectedFeatures.length > 0 && selectedFeatures.every(
				( feature ) => this._adapters.require( feature.type ).capabilities.scaleHorizontal,
			),
			...( transformMode === undefined ? {} : { transformMode } ),
			...( interaction.kind === 'transforming' && interaction.axis !== undefined
				? { transformAxis: interaction.axis }
				: {} ),
			transformAxisEnabled: routerTransformAxisCapabilities(
				transformMode,
				gizmoCapabilities,
			),
			saveHandlerAvailable: this._hasSaveHandler(),
			nudgeStepMeters: 1,
		} );
	}

	private _refreshDerivedState(): void {
		this._router.setContext( this._createRouterContext() );
		const interaction = this._state.interaction;
		this._setMode(
			interaction.kind === 'transforming'
				? 'transform'
				: interaction.kind === 'text-editing'
					? 'text-edit'
					: this._state.tool.kind === 'draw'
						? `draw:${ this._state.tool.graphicsType }`
						: 'select',
		);
	}

	private _runInternalCommand<T>( operation: () => T ): T {
		this._internalCommandDepth++;
		try {
			return operation();
		} finally {
			this._internalCommandDepth--;
		}
	}

	private _flushPendingDocumentRevision(): void {
		if ( this._internalCommandDepth > 0 ) return;
		const revision = this._pendingDocumentRevision;
		this._pendingDocumentRevision = undefined;
		if ( revision !== undefined ) this._dispatch( { type: 'DOCUMENT_CHANGED', revision } );
	}

	private _reportControllerError( error: Readonly<{ code: string; message: string }> | undefined ): void {
		if ( error !== undefined ) this._reportError( error.code, error.message );
	}

	private _onDocumentChange( change: PlotDocumentChange ): void {
		const current = new Set( this._store.getAll().map( ( feature ) => feature.id ) );
		for ( const id of this._resolved.keys() ) {
			if ( ! current.has( id ) ) this._resolved.delete( id );
		}
		this._events.dispatch( 'documentchange', change );
		if ( this._internalCommandDepth > 0 ) {
			this._pendingDocumentRevision = change.revision;
		} else {
			this._dispatch( { type: 'DOCUMENT_CHANGED', revision: change.revision } );
		}
		this._syncOverlay();
		this._resolveAllHeights();
		this._renderHost.requestRender( 'document' );
	}

	private _onSelectionChange( selection: SelectionState ): void {
		if ( this._vertexEditId !== undefined && ! selection.ids.includes( this._vertexEditId ) ) {
			this._vertexEditId = undefined;
		}
		this._events.dispatch( 'selectionchange', { selection } );
		this._dispatch( { type: 'SELECTION_SYNC', selection } );
		this._invalidateTransient( 'selection' );
	}

	private _syncOverlay(): void {
		if ( this._disposed ) return;
		const draftFeatures = this._shapePreview !== null
			? [ this._shapePreview.feature ]
			: this._transformPreview !== null
				? this._transformPreview.features
				: this._textPreview === null ? [] : [ this._textPreview ];
		const drawingDraft = this._drawingSession === null
			? null
			: Object.freeze( {
				id: this._drawingSession.id,
				revision: this._sessionRevision,
				preview: this._drawingSession.preview,
				heightReference: this._drawingSession.draft.heightReference,
				valid: this._drawingSession.draft.validation.valid,
			} );
		const interaction = this._state.interaction;
		const transformMode = interaction.kind === 'transforming'
			? interaction.mode
			: interaction.kind === 'dragging-entity'
				? 'translate'
				: interaction.kind === 'dragging-handle'
					&& isGizmoHandleId( interaction.handleId )
						? transformModeForHandle( interaction.handleId )
						: this._transformPreview?.mode;
		this._overlay.sync( {
			features: this._store.getAll(),
			documentRevision: this._store.revision,
			sessionRevision: this._sessionRevision,
			resolved: this._resolved,
			draftFeatures,
			drawingDraft,
			draftValid: this._shapePreview?.committable
				?? this._transformPreview?.committable
				?? ( this._textPreview !== null )
				?? true,
			selection: this._selectionModel.state,
			showHandles: this._vertexEditId !== undefined
				&& this._selectionModel.state.ids.length === 1,
			transformMode,
			activeGizmoHandleId: interaction.kind === 'dragging-handle'
				&& isGizmoHandleId( interaction.handleId )
					? interaction.handleId
					: undefined,
			boxSelection: interaction.kind === 'box-selecting'
				? Object.freeze( {
					start: interaction.start,
					current: interaction.current,
					additive: interaction.additive,
					valid: Math.hypot(
						interaction.current.x - interaction.start.x,
						interaction.current.y - interaction.start.y,
					) >= 3,
				} )
				: null,
		} );
	}

	private _resolveAllHeights(): void {
		if ( this._heightResolver === undefined || this._disposed ) return;
		for ( const feature of this._store.getAll() ) void this._heightResolver.resolve( feature );
	}

	private _invalidateTransient( reason: 'draft' | 'selection' ): void {
		if ( this._disposed ) return;
		this._sessionRevision++;
		this._syncOverlay();
		this._renderHost.requestRender( reason );
	}

	private _setMode( mode: PlotEditorMode ): void {
		if ( mode === this._mode ) return;
		const previousMode = this._mode;
		this._mode = mode;
		this._events.dispatch( 'modechange', { previousMode, mode } );
	}

	private _cancelPreviews(): void {
		this._drawing.cancel( 'mode-change' );
		this._shapeEditor.cancel();
		this._transform.cancel();
		this._textEditor.cancel();
	}

	private _hasActivePreview(): boolean {
		return this._drawing.session !== null
			|| this._shapeEditor.session !== null
			|| this._transform.session !== null
			|| this._textEditor.session !== null;
	}

	private _reportCommandResult( result: CommandResult ): CommandResult {
		if ( result.error !== undefined ) {
			this._events.dispatch( 'validationerror', {
				diagnostic: Object.freeze( {
					code: result.error.code,
					severity: 'error',
					message: result.error.message,
					...( result.error.path === undefined ? {} : { path: result.error.path } ),
				} ),
				result,
			} );
		}
		return result;
	}

	private _reportImportFailure( result: ImportPlotDocumentResult ): void {
		for ( const diagnostic of result.diagnostics ) {
			if ( diagnostic.severity === 'error' ) {
				this._events.dispatch( 'validationerror', { diagnostic } );
			}
		}
	}

	private _reportError( code: string, message: string, detail?: unknown ): void {
		this._events.dispatch( 'validationerror', {
			diagnostic: Object.freeze( {
				code,
				severity: 'error',
				message: detail instanceof Error ? `${ message } ${ detail.message }` : message,
			} ),
		} );
	}

	private _hasSaveHandler(): boolean {
		return this._save !== undefined || this._events.hasListeners( 'saverequest' );
	}

	private _reportMissingSaveHandler(): void {
		this._reportError(
			'SAVE_HANDLER_MISSING',
			'未配置保存回调，也没有 saverequest 事件监听器。',
		);
	}

	private _reportBlockedTransformCommand( commandId: string ): void {
		this._reportError(
			'TRANSFORM_CAPABILITY_BLOCKED',
			`当前选择不支持键盘变换命令 ${ commandId }。`,
		);
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'PlotEditor 已销毁。' );
	}
}

export function createPlotEditor( options: PlotEditorOptions ): PlotEditor {
	return new PlotEditor( options );
}

function createEmptySnapshot( documentId: string ): PlotDocumentSnapshot {
	return Object.freeze( {
		schema: 'cesium-to-three/plot-document' as const,
		version: 1 as const,
		documentId,
		revision: 0,
		features: Object.freeze( [] ),
		order: Object.freeze( [] ),
		metadata: Object.freeze( {} ),
	} );
}

function commandFailure( revision: number, code: string, message: string ): CommandResult {
	return Object.freeze( {
		ok: false,
		changed: false,
		revision,
		affectedIds: Object.freeze( [] ),
		error: Object.freeze( { code, message } ),
	} );
}

function assertOptions( options: PlotEditorOptions ): void {
	if ( options.root.ownerDocument !== options.canvas.ownerDocument ) {
		throw new Error( 'PlotEditor root 与 canvas 必须属于同一个 Document。' );
	}
	if ( options.documentId !== undefined && options.documentId.trim().length === 0 ) {
		throw new TypeError( 'documentId 不能为空。' );
	}
}

interface PointerTransactionStart {
	readonly screen: ScreenPoint;
	readonly surface?: Position3D;
}

function draftPick( position: Position3D, heightReference: HeightReference ) {
	return Object.freeze( {
		authorPosition: position,
		surfacePosition: position,
		surface: 'ellipsoid' as const,
		heightReference,
	} );
}

function pointerClaim(
	owner: PointerClaim[ 'owner' ],
	reason: PointerClaim[ 'reason' ],
	capture: boolean,
	preventDefault: boolean,
): PointerClaim {
	return Object.freeze( { owner, reason, capture, preventDefault } );
}

function isGizmoHandleId( id: string ): boolean {
	return id.startsWith( 'translate:' )
		|| id.startsWith( 'rotate:' )
		|| id.startsWith( 'scale:' );
}

function transformModeForHandle( id: string ): TransformMode {
	if ( id.startsWith( 'translate:' ) ) return 'translate';
	if ( id.startsWith( 'rotate:' ) ) return 'rotate';
	if ( id.startsWith( 'scale:' ) ) return 'scale';
	throw new Error( `未知 Gizmo handle：${ id }。` );
}

function transformAxisForHandle( id: string ): 'east' | 'north' | 'up' | 'uniform' | undefined {
	const value = id.slice( id.indexOf( ':' ) + 1 );
	if ( value === 'east' || value === 'north' || value === 'up' || value === 'uniform' ) {
		return value;
	}
	if ( value === 'east-north' ) return 'uniform';
	if ( value === 'heading' ) return 'up';
	if ( value === 'pitch' ) return 'east';
	if ( value === 'roll' ) return 'north';
	return undefined;
}

function routerInteractionForState(
	kind: EditorState[ 'interaction' ][ 'kind' ],
): RouterContext[ 'interaction' ] {
	if ( kind === 'hovering' || kind === 'error' ) return 'idle';
	return kind;
}

function routerTransformAxisCapabilities(
	mode: TransformMode | undefined,
	capabilities: GizmoCapabilities,
): Readonly<Record<'east' | 'north' | 'up', boolean>> {
	if ( mode === 'translate' ) return Object.freeze( {
		east: capabilities.translateEast,
		north: capabilities.translateNorth,
		up: capabilities.translateUp,
	} );
	if ( mode === 'rotate' ) return Object.freeze( {
		east: capabilities.rotatePitch,
		north: capabilities.rotateRoll,
		up: capabilities.rotateHeading,
	} );
	if ( mode === 'scale' ) return Object.freeze( {
		east: capabilities.scaleHorizontal,
		north: capabilities.scaleHorizontal,
		up: capabilities.scaleVertical,
	} );
	return Object.freeze( { east: false, north: false, up: false } );
}

function detailMessage( detail: unknown, fallback: string ): string {
	if ( detail instanceof Error ) return detail.message;
	if ( detail !== null && typeof detail === 'object'
		&& typeof ( detail as { message?: unknown } ).message === 'string' ) {
		return ( detail as { message: string } ).message;
	}
	return fallback;
}

export type { PlotEditorEventMap };
