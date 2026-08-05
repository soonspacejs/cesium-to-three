import type { Object3D, PerspectiveCamera } from 'three';
import type { CesiumGroundFrameState } from '../ground';
import { createBuiltinGeometryAdapterRegistry } from './adapters/builtins';
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
	PlotDocumentSnapshot,
	PlotFeatureId,
	PlotFeatureType,
	ResolvedPlotGeometry,
} from './document/types';
import { PlotDrawingController, type DrawingSession } from './drawing/PlotDrawingController';
import {
	ShapeEditController,
	type ShapeEditPreview,
} from './editing/ShapeEditController';
import {
	PlotEditorEventDispatcher,
	type PlotEditorEventListener,
	type PlotEditorEventMap,
	type PlotEditorEventType,
	type PlotEditorMode,
} from './events';
import type { EditorKeymap, NavigationAdapter } from './input/types';
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
import { FeatureHitTester } from './selection/FeatureHitTester';
import {
	SelectionController,
	createAdapterAwareSelectionModel,
} from './selection/SelectionController';
import type { SelectionState } from './state/SelectionModel';
import { EnuTransformController } from './transform/EnuTransformController';
import { createEnuFeatureTransform } from './transform/feature-transform';
import type { TransformPreview } from './transform/types';

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
	readonly keymap?: EditorKeymap;
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

	private readonly _root: HTMLElement;
	private readonly _renderHost: EditorRenderHost;
	private readonly _cameraController: NavigationAdapter;
	private readonly _store: PlotDocumentStore;
	private readonly _executor: CommandExecutor;
	private readonly _history: HistoryManager;
	private readonly _events = new PlotEditorEventDispatcher();
	private readonly _selectionModel;
	private readonly _selectionController: SelectionController;
	private readonly _drawing: PlotDrawingController;
	private readonly _shapeEditor: ShapeEditController;
	private readonly _transform: EnuTransformController;
	private readonly _overlay: EditorOverlayRenderer;
	private readonly _importer: PlotDocumentImporter;
	private readonly _save?: SaveCoordinator;
	private readonly _heightResolver?: HeightResolutionManager;
	private readonly _resolved = new Map<PlotFeatureId, ResolvedPlotGeometry>();
	private readonly _unsubscribers: Array<() => void> = [];
	private _drawingSession: DrawingSession | null = null;
	private _shapePreview: ShapeEditPreview | null = null;
	private _transformPreview: TransformPreview | null = null;
	private _mode: PlotEditorMode = 'select';
	private _vertexEditId: PlotFeatureId | undefined;
	private _sessionRevision = 0;
	private _disposed = false;

	public constructor( options: PlotEditorOptions ) {
		assertOptions( options );
		this._root = options.root;
		this._renderHost = options.renderHost;
		this._cameraController = options.cameraController;

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
		this._selectionController = new SelectionController( {
			model: this._selectionModel,
			hitTester: new FeatureHitTester( this._store, adapters ),
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
			this._setMode( 'select' );
			return;
		}
		const context: DrawToolContext<any> = typeof tool === 'string'
			? { type: tool, heightReference: 0 as HeightReference }
			: tool;
		this._drawing.arm( context );
		this._setMode( `draw:${ context.type }` );
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
		this._root.focus( { preventScroll: true } );
	}

	public blur(): void {
		if ( this._disposed ) return;
		this._root.blur();
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
	}

	public removeEventListener<K extends PlotEditorEventType>(
		type: K,
		listener: PlotEditorEventListener<K>,
	): void {
		this._events.removeEventListener( type, listener );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this._cancelPreviews();
		for ( const unsubscribe of this._unsubscribers.splice( 0 ) ) unsubscribe();
		this._heightResolver?.dispose();
		this._save?.dispose();
		this._drawing.dispose();
		this._shapeEditor.dispose();
		this._transform.dispose();
		this._selectionController.dispose();
		this._selectionModel.dispose();
		this._executor.dispose();
		this._overlay.dispose();
		this._cameraController.dispose();
		this._events.dispose();
	}

	private _onDocumentChange( change: PlotDocumentChange ): void {
		const current = new Set( this._store.getAll().map( ( feature ) => feature.id ) );
		for ( const id of this._resolved.keys() ) {
			if ( ! current.has( id ) ) this._resolved.delete( id );
		}
		this._events.dispatch( 'documentchange', change );
		this._syncOverlay();
		this._resolveAllHeights();
		this._renderHost.requestRender( 'document' );
	}

	private _onSelectionChange( selection: SelectionState ): void {
		if ( this._vertexEditId !== undefined && ! selection.ids.includes( this._vertexEditId ) ) {
			this._vertexEditId = undefined;
		}
		this._events.dispatch( 'selectionchange', { selection } );
		this._invalidateTransient( 'selection' );
	}

	private _syncOverlay(): void {
		if ( this._disposed ) return;
		const draftFeatures = this._shapePreview === null
			? this._transformPreview?.features ?? []
			: [ this._shapePreview.feature ];
		const drawingDraft = this._drawingSession === null
			? null
			: Object.freeze( {
				id: this._drawingSession.id,
				revision: this._sessionRevision,
				preview: this._drawingSession.preview,
				heightReference: this._drawingSession.draft.heightReference,
				valid: this._drawingSession.draft.validation.valid,
			} );
		this._overlay.sync( {
			features: this._store.getAll(),
			documentRevision: this._store.revision,
			sessionRevision: this._sessionRevision,
			resolved: this._resolved,
			draftFeatures,
			drawingDraft,
			draftValid: this._shapePreview?.committable
				?? this._transformPreview?.committable
				?? true,
			selection: this._selectionModel.state,
			showHandles: this._vertexEditId !== undefined
				&& this._selectionModel.state.ids.length === 1,
			transformMode: this._transformPreview?.mode,
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
	}

	private _hasActivePreview(): boolean {
		return this._drawing.session !== null
			|| this._shapeEditor.session !== null
			|| this._transform.session !== null;
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

export type { PlotEditorEventMap };
