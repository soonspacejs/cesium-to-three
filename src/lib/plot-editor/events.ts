import type { HistoryState } from './commands/HistoryManager';
import type { CommandResult } from './commands/types';
import type { EditorDiagnostic } from './document/diagnostics';
import type { PlotDocumentChange } from './document/PlotDocument';
import type {
	PlotDocumentSnapshot,
	PlotFeatureId,
} from './document/types';
import type { OverlayRenderError } from './render/EditorOverlayRenderer';
import type { SelectionState } from './state/SelectionModel';

export type PlotEditorMode = 'select' | `draw:${ string }` | 'transform' | 'text-edit';

export interface EditorDocumentChangeEvent extends PlotDocumentChange {
	readonly type: 'documentchange';
}

export interface EditorSelectionChangeEvent {
	readonly type: 'selectionchange';
	readonly selection: SelectionState;
}

export interface EditorModeChangeEvent {
	readonly type: 'modechange';
	readonly previousMode: PlotEditorMode;
	readonly mode: PlotEditorMode;
}

export interface EditorHistoryStateEvent extends HistoryState {
	readonly type: 'historystatechange';
}

export interface EditorSaveRequestEvent {
	readonly type: 'saverequest';
	readonly snapshot: PlotDocumentSnapshot;
	readonly revision: number;
}

export interface EditorValidationErrorEvent {
	readonly type: 'validationerror';
	readonly diagnostic: EditorDiagnostic;
	readonly result?: CommandResult;
}

export interface EditorSurfaceChangeEvent {
	readonly type: 'surfacechange';
	readonly featureIds: readonly PlotFeatureId[];
	readonly status: 'ready' | 'pending' | 'unavailable';
}

export interface EditorRenderErrorEvent extends OverlayRenderError {
	readonly type: 'rendererror';
}

export interface PlotEditorEventMap {
	readonly documentchange: EditorDocumentChangeEvent;
	readonly selectionchange: EditorSelectionChangeEvent;
	readonly modechange: EditorModeChangeEvent;
	readonly historystatechange: EditorHistoryStateEvent;
	readonly saverequest: EditorSaveRequestEvent;
	readonly validationerror: EditorValidationErrorEvent;
	readonly surfacechange: EditorSurfaceChangeEvent;
	readonly rendererror: EditorRenderErrorEvent;
}

export type PlotEditorEventType = keyof PlotEditorEventMap;
export type PlotEditorEventListener<K extends PlotEditorEventType> = (
	event: PlotEditorEventMap[ K ],
) => void;

export interface PlotEditorEventDispatcherOptions {
	readonly onListenerError?: (
		error: unknown,
		type: PlotEditorEventType,
	) => void;
}

/** 同步稳定顺序分发；单个 listener 抛错不阻断其余 listener 或已完成命令。 */
export class PlotEditorEventDispatcher {
	private readonly _listeners = new Map<PlotEditorEventType, Set<( event: never ) => void>>();
	private readonly _onListenerError: NonNullable<PlotEditorEventDispatcherOptions[ 'onListenerError' ]>;
	private _disposed = false;

	public constructor( options: PlotEditorEventDispatcherOptions = {} ) {
		this._onListenerError = options.onListenerError ?? ( ( error, type ) => {
			console.error( `PlotEditor ${ type } listener error:`, error );
		} );
	}

	public addEventListener<K extends PlotEditorEventType>(
		type: K,
		listener: PlotEditorEventListener<K>,
	): void {
		this._assertOpen();
		if ( typeof listener !== 'function' ) throw new TypeError( 'PlotEditor listener 必须是函数。' );
		let listeners = this._listeners.get( type );
		if ( listeners === undefined ) {
			listeners = new Set();
			this._listeners.set( type, listeners );
		}
		listeners.add( listener as ( event: never ) => void );
	}

	public removeEventListener<K extends PlotEditorEventType>(
		type: K,
		listener: PlotEditorEventListener<K>,
	): void {
		this._listeners.get( type )?.delete( listener as ( event: never ) => void );
	}

	/** 供 facade 判断可选宿主协议是否已有消费者，不暴露 listener 集合。 */
	public hasListeners( type: PlotEditorEventType ): boolean {
		return ! this._disposed && ( this._listeners.get( type )?.size ?? 0 ) > 0;
	}

	public dispatch<K extends PlotEditorEventType>(
		type: K,
		event: Omit<PlotEditorEventMap[ K ], 'type'>,
	): void {
		if ( this._disposed ) return;
		const frozen = deepFreezeEvent( { ...event, type } ) as unknown as PlotEditorEventMap[ K ];
		for ( const listener of [ ...this._listeners.get( type ) ?? [] ] ) {
			try {
				listener( frozen as never );
			} catch ( error ) {
				queueMicrotask( () => this._onListenerError( error, type ) );
			}
		}
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this._listeners.clear();
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'PlotEditorEventDispatcher 已销毁。' );
	}
}

function deepFreezeEvent<T extends object>( event: T ): Readonly<T> {
	for ( const value of Object.values( event ) ) {
		if ( value !== null && typeof value === 'object' && ! Object.isFrozen( value ) ) {
			Object.freeze( value );
		}
	}
	return Object.freeze( event );
}
