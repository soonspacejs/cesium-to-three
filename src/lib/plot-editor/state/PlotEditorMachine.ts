import type { HeightReference, PlotFeatureId, PlotFeatureType, Position3D } from '../document/types';
import type { SelectionState } from './SelectionModel';
import type {
	CancelReason,
	DraftState,
	EditorIntent,
	EnuAxis,
	HitTarget,
	ScreenPoint,
	SelectionOperation,
	TransformMode,
} from './types';

export type EditorLifecycle = 'created' | 'ready' | 'disposed';
export type EditorTool =
	| { readonly kind: 'select' }
	| {
		readonly kind: 'draw';
		readonly graphicsType: PlotFeatureType;
		readonly heightReference: HeightReference;
	};

export interface PendingSurfaceRequest {
	readonly requestId: string;
	readonly sessionId: string;
	readonly documentRevision: number;
	readonly sequence: number;
	readonly purpose: 'point' | 'preview';
	readonly screen: ScreenPoint;
	readonly position?: Position3D;
	readonly failed?: boolean;
}

export type EditorInteraction =
	| { readonly kind: 'idle' }
	| { readonly kind: 'hovering'; readonly hit: HitTarget | null }
	| {
		readonly kind: 'drawing';
		readonly sessionId: string;
		readonly draft: DraftState;
		readonly draftRevision: number;
		readonly redoCoordinates: readonly Position3D[];
		readonly pendingRequests: readonly PendingSurfaceRequest[];
		readonly committing: boolean;
	}
	| {
		readonly kind: 'pointer-pending';
		readonly pointerId: number;
		readonly start: ScreenPoint;
		readonly current: ScreenPoint;
		readonly hit: HitTarget;
		readonly operation: SelectionOperation;
	}
	| {
		readonly kind: 'box-selecting';
		readonly pointerId: number;
		readonly start: ScreenPoint;
		readonly current: ScreenPoint;
		readonly additive: boolean;
	}
	| {
		readonly kind: 'dragging-handle';
		readonly pointerId: number;
		readonly entityId: PlotFeatureId;
		readonly handleId: string;
		readonly start: ScreenPoint;
		readonly current: ScreenPoint;
		readonly transactionId: string;
	}
	| {
		readonly kind: 'dragging-entity';
		readonly pointerId: number;
		readonly entityId: PlotFeatureId;
		readonly start: ScreenPoint;
		readonly current: ScreenPoint;
		readonly transactionId: string;
	}
	| {
		readonly kind: 'transforming';
		readonly mode: TransformMode;
		readonly axis?: EnuAxis;
		readonly heldNudgeCodes: readonly string[];
		readonly transactionId: string;
	}
	| {
		readonly kind: 'text-editing';
		readonly entityId: PlotFeatureId;
		readonly transactionId: string;
	}
	| {
		readonly kind: 'error';
		readonly code: string;
		readonly recoverable: boolean;
	};

export interface EditorTransactionState {
	readonly id: string;
	readonly kind: 'pointer-drag' | 'keyboard-nudge' | 'text';
	readonly documentRevisionAtBegin: number;
	readonly selectionBefore: SelectionState;
	readonly dirty: boolean;
}

export interface EditorState {
	readonly lifecycle: EditorLifecycle;
	readonly tool: EditorTool;
	readonly interaction: EditorInteraction;
	readonly selection: SelectionState;
	readonly documentRevision: number;
	readonly activeTransaction?: EditorTransactionState;
	readonly nextSequence: number;
}

export type EditorSystemEvent =
	| { readonly type: 'INITIALIZE' }
	| { readonly type: 'SET_TOOL'; readonly tool: EditorTool }
	| {
		readonly type: 'SURFACE_RESOLVED';
		readonly requestId: string;
		readonly sessionId: string;
		readonly revision: number;
		readonly position: Position3D;
	}
	| {
		readonly type: 'SURFACE_FAILED';
		readonly requestId: string;
		readonly sessionId: string;
		readonly revision: number;
		readonly error: unknown;
	}
	| {
		readonly type: 'DRAFT_VALIDATED';
		readonly sessionId: string;
		readonly draftRevision: number;
		readonly valid: boolean;
		readonly errors: readonly string[];
	}
	| {
		readonly type: 'DRAFT_COMMITTED';
		readonly sessionId: string;
		readonly documentRevision: number;
	}
	| { readonly type: 'TRANSACTION_UPDATED'; readonly transactionId: string }
	| {
		readonly type: 'TRANSACTION_COMMITTED';
		readonly transactionId: string;
		readonly documentRevision: number;
	}
	| {
		readonly type: 'TRANSACTION_FAILED';
		readonly transactionId: string;
		readonly code: string;
		readonly recoverable: boolean;
		readonly detail?: unknown;
	}
	| { readonly type: 'SELECTION_SYNC'; readonly selection: SelectionState }
	| { readonly type: 'HOVER_RESOLVED'; readonly hit: HitTarget | null }
	| { readonly type: 'DOCUMENT_CHANGED'; readonly revision: number }
	| { readonly type: 'FOCUS_LOST'; readonly reason: 'blur' | 'hidden' }
	| { readonly type: 'DISPOSE' };

export type EditorEvent = EditorIntent | EditorSystemEvent;

export type EditorEffect =
	| {
		readonly type: 'PICK_SURFACE';
		readonly request: PendingSurfaceRequest;
		readonly heightReference: HeightReference;
	}
	| { readonly type: 'CANCEL_SURFACE_REQUEST'; readonly requestId: string }
	| {
		readonly type: 'VALIDATE_DRAFT';
		readonly sessionId: string;
		readonly draftRevision: number;
		readonly draft: DraftState;
	}
	| { readonly type: 'RENDER_DRAFT'; readonly sessionId: string; readonly draft: DraftState }
	| { readonly type: 'COMMIT_DRAFT'; readonly sessionId: string; readonly draft: DraftState }
	| { readonly type: 'FOCUS_DRAFT_TEXT_INPUT'; readonly sessionId: string; readonly position: Position3D }
	| { readonly type: 'ROLLBACK_PREVIEW'; readonly transactionId: string }
	| {
		readonly type: 'APPLY_SELECTION';
		readonly operation: SelectionOperation;
		readonly ids: readonly PlotFeatureId[];
	}
	| {
		readonly type: 'APPLY_BOX_SELECTION';
		readonly start: ScreenPoint;
		readonly end: ScreenPoint;
		readonly additive: boolean;
	}
	| { readonly type: 'SET_ACTIVE_HANDLE'; readonly entityId: PlotFeatureId; readonly handleId: string }
	| { readonly type: 'HIT_TEST_HOVER'; readonly screen: ScreenPoint }
	| { readonly type: 'SELECT_ALL' }
	| { readonly type: 'DELETE_SELECTION'; readonly selection: SelectionState }
	| { readonly type: 'HISTORY_UNDO' }
	| { readonly type: 'HISTORY_REDO' }
	| { readonly type: 'REQUEST_SAVE' }
	| {
		readonly type: 'BEGIN_TRANSACTION';
		readonly transaction: EditorTransactionState;
		readonly selectedIds: readonly PlotFeatureId[];
		readonly entityId?: PlotFeatureId;
		readonly handleId?: string;
	}
	| {
		readonly type: 'UPDATE_POINTER_TRANSACTION';
		readonly transactionId: string;
		readonly screen: ScreenPoint;
	}
	| {
		readonly type: 'UPDATE_KEYBOARD_TRANSACTION';
		readonly transactionId: string;
		readonly mode: TransformMode;
		readonly axis: EnuAxis;
		readonly amountMeters: number;
	}
	| { readonly type: 'COMMIT_TRANSACTION'; readonly transactionId: string }
	| { readonly type: 'ROLLBACK_TRANSACTION'; readonly transactionId: string; readonly reason: CancelReason | string }
	| { readonly type: 'FOCUS_TEXT_INPUT'; readonly entityId: PlotFeatureId }
	| { readonly type: 'REPORT_ERROR'; readonly code: string; readonly detail?: unknown }
	| { readonly type: 'DISPOSE_RESOURCES' };

export interface EditorTransition {
	readonly state: EditorState;
	readonly effects: readonly EditorEffect[];
}

export function createInitialEditorState(
	documentRevision = 0,
	selection: SelectionState = Object.freeze( { ids: Object.freeze( [] ) } ),
): EditorState {
	if ( ! Number.isSafeInteger( documentRevision ) || documentRevision < 0 ) {
		throw new RangeError( 'documentRevision 必须是非负安全整数。' );
	}
	return freezeState( {
		lifecycle: 'created',
		tool: Object.freeze( { kind: 'select' } ),
		interaction: Object.freeze( { kind: 'idle' } ),
		selection: freezeSelection( selection ),
		documentRevision,
		nextSequence: 1,
	} );
}

/** 同一 state + event 始终返回同一 transition；副作用只以描述值返回。 */
export function reduceEditor( state: EditorState, event: EditorEvent ): EditorTransition {
	if ( state.lifecycle === 'disposed' ) return transition( state );
	if ( event.type === 'DISPOSE' ) return disposeTransition( state );
	if ( event.type === 'INITIALIZE' ) {
		return state.lifecycle === 'created'
			? transition( withState( state, { lifecycle: 'ready' } ) )
			: transition( state );
	}
	if ( state.lifecycle !== 'ready' ) return transition( state );

	switch ( event.type ) {
		case 'SET_TOOL': return setTool( state, event.tool );
		case 'SURFACE_RESOLVED': return resolveSurface( state, event );
		case 'SURFACE_FAILED': return failSurface( state, event );
		case 'DRAFT_VALIDATED': return updateDraftValidation( state, event );
		case 'DRAFT_COMMITTED': return finishDraftCommit( state, event );
		case 'TRANSACTION_UPDATED': return markTransactionDirty( state, event.transactionId );
		case 'TRANSACTION_COMMITTED': return finishTransaction( state, event );
		case 'TRANSACTION_FAILED': return failTransaction( state, event );
		case 'SELECTION_SYNC': return transition( withState( state, {
			selection: freezeSelection( event.selection ),
		} ) );
		case 'HOVER_RESOLVED': return state.interaction.kind !== 'idle'
			&& state.interaction.kind !== 'hovering'
			? transition( state )
			: transition( withState( state, {
				interaction: event.hit === null
					? Object.freeze( { kind: 'idle' } )
					: Object.freeze( { kind: 'hovering', hit: freezeHit( event.hit ) } ),
			} ) );
		case 'DOCUMENT_CHANGED': return documentChanged( state, event.revision );
		case 'FOCUS_LOST': return cancelOperation( state, event.reason );
		case 'hoverAt': return transition( state, {
			type: 'HIT_TEST_HOVER', screen: freezeScreen( event.screen ),
		} );
		case 'beginDrawingAt':
		case 'appendDraftPoint': return requestDraftSurface( state, event.screen, 'point' );
		case 'updateDraftPointer': return requestDraftSurface( state, event.screen, 'preview' );
		case 'removeLastDraftPoint':
		case 'undoDraft': return undoDraft( state );
		case 'redoDraft': return redoDraft( state );
		case 'commitDrawing': return commitDraft( state );
		case 'selectAt': return selectAt( state, event.hit, event.operation );
		case 'beginPointerPending': return beginPointerPending( state, event );
		case 'beginHandleDrag': return beginHandleDrag( state, event );
		case 'beginEntityDrag': return beginEntityDrag( state, event );
		case 'beginBoxSelection': return beginBoxSelection( state, event );
		case 'updatePointerTransaction': return updatePointerTransaction( state, event.pointerId, event.screen );
		case 'finishPointerTransaction': return finishPointerTransaction( state, event.pointerId );
		case 'cancelCurrentOperation': return cancelOperation( state, event.reason );
		case 'deleteSelection': return state.selection.ids.length === 0
			? transition( state, { type: 'REPORT_ERROR', code: 'EMPTY_SELECTION' } )
			: transition( state, { type: 'DELETE_SELECTION', selection: state.selection } );
		case 'selectAll': return transition( state, { type: 'SELECT_ALL' } );
		case 'undo': return transactionGuard( state, { type: 'HISTORY_UNDO' } );
		case 'redo': return transactionGuard( state, { type: 'HISTORY_REDO' } );
		case 'save': return transition( state, { type: 'REQUEST_SAVE' } );
		case 'beginTransform': return beginTransform( state, event.mode );
		case 'constrainTransform': return constrainTransform( state, event.axis );
		case 'nudgeSelection': return nudgeSelection( state, event );
		case 'commitTransform': return commitTransform( state );
		case 'beginTextEdit': return beginTextEdit( state );
		case 'commitTextEdit': return commitTextEdit( state );
		case 'cancelTextEdit': return cancelOperation( state, 'escape' );
	}
}

function setTool( state: EditorState, tool: EditorTool ): EditorTransition {
	const cancelled = cancellationEffects( state, 'external-change' );
	if ( tool.kind === 'select' ) {
		return transition( withState( state, {
			tool: Object.freeze( { kind: 'select' } ),
			interaction: Object.freeze( { kind: 'idle' } ),
			activeTransaction: undefined,
		} ), ...cancelled );
	}
	const sessionId = `draw-${ state.nextSequence }`;
	const interaction = createDrawingInteraction( sessionId, tool.graphicsType );
	return transition( withState( state, {
		tool: Object.freeze( { ...tool } ),
		interaction,
		activeTransaction: undefined,
		nextSequence: state.nextSequence + 1,
	} ), ...cancelled, { type: 'RENDER_DRAFT', sessionId, draft: interaction.draft } );
}

function requestDraftSurface(
	state: EditorState,
	screenInput: ScreenPoint,
	purpose: 'point' | 'preview',
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || state.tool.kind !== 'draw' || interaction.committing ) {
		return transition( state );
	}
	if ( purpose === 'point' && interaction.draft.graphicsType === 'text'
		&& interaction.draft.coordinates.length > 0 ) {
		return transition( state );
	}
	const screen = freezeScreen( screenInput );
	const request: PendingSurfaceRequest = Object.freeze( {
		requestId: `${ interaction.sessionId }:surface-${ state.nextSequence }`,
		sessionId: interaction.sessionId,
		documentRevision: state.documentRevision,
		sequence: state.nextSequence,
		purpose,
		screen,
	} );
	const retained = purpose === 'preview'
		? interaction.pendingRequests.filter( ( pending ) => pending.purpose !== 'preview' )
		: interaction.pendingRequests;
	const cancelled = purpose === 'preview'
		? interaction.pendingRequests
			.filter( ( pending ) => pending.purpose === 'preview' )
			.map( ( pending ) => Object.freeze( {
				type: 'CANCEL_SURFACE_REQUEST' as const,
				requestId: pending.requestId,
			} ) )
		: [];
	const next = updateDrawing( state, {
		...interaction,
		...( purpose === 'point' ? { redoCoordinates: Object.freeze( [] ) } : {} ),
		pendingRequests: Object.freeze( [ ...retained, request ] ),
	}, state.nextSequence + 1 );
	return transition( next, ...cancelled, {
		type: 'PICK_SURFACE', request, heightReference: state.tool.heightReference,
	} );
}

function resolveSurface(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'SURFACE_RESOLVED' }>,
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing'
		|| event.sessionId !== interaction.sessionId
		|| event.revision !== state.documentRevision ) return transition( state );
	const target = interaction.pendingRequests.find( ( item ) => item.requestId === event.requestId );
	if ( target === undefined || target.documentRevision !== event.revision ) return transition( state );
	const position = freezePosition( event.position );
	if ( target.purpose === 'preview' ) {
		const draft = freezeDraft( { ...interaction.draft, previewCoordinate: position } );
		const next = updateDrawing( state, {
			...interaction,
			draft,
			pendingRequests: Object.freeze(
				interaction.pendingRequests.filter( ( item ) => item.requestId !== target.requestId ),
			),
		} );
		return transition( next, { type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft } );
	}

	const marked = interaction.pendingRequests.map( ( item ) => item.requestId === target.requestId
		? Object.freeze( { ...item, position } )
		: item );
	const pointRequests = marked.filter( ( item ) => item.purpose === 'point' )
		.sort( ( left, right ) => left.sequence - right.sequence );
	const applied = new Set<string>();
	const coordinates = [ ...interaction.draft.coordinates ];
	for ( const item of pointRequests ) {
		if ( item.position === undefined && item.failed !== true ) break;
		applied.add( item.requestId );
		if ( item.position !== undefined ) coordinates.push( item.position );
	}
	const draft = freezeDraft( {
		...interaction.draft,
		coordinates: Object.freeze( coordinates ),
		valid: false,
		validationErrors: Object.freeze( [] ),
	} );
	const next = updateDrawing( state, {
		...interaction,
		draft,
		draftRevision: interaction.draftRevision + 1,
		redoCoordinates: Object.freeze( [] ),
		pendingRequests: Object.freeze( marked.filter( ( item ) => ! applied.has( item.requestId ) ) ),
	} );
	const effects: EditorEffect[] = [
		{
			type: 'VALIDATE_DRAFT', sessionId: interaction.sessionId,
			draftRevision: interaction.draftRevision + 1, draft,
		},
		{ type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft },
	];
	if ( state.tool.kind === 'draw' && state.tool.graphicsType === 'text'
		&& interaction.draft.coordinates.length === 0 && coordinates.length === 1 ) {
		effects.push( {
			type: 'FOCUS_DRAFT_TEXT_INPUT',
			sessionId: interaction.sessionId,
			position: coordinates[ 0 ],
		} );
	}
	return transition( next, ...effects );
}

function failSurface(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'SURFACE_FAILED' }>,
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing'
		|| event.sessionId !== interaction.sessionId
		|| event.revision !== state.documentRevision ) return transition( state );
	const target = interaction.pendingRequests.find( ( item ) => item.requestId === event.requestId );
	if ( target === undefined ) return transition( state );
	let pendingRequests = target.purpose === 'preview'
		? interaction.pendingRequests.filter( ( item ) => item.requestId !== target.requestId )
		: interaction.pendingRequests.map( ( item ) => item.requestId === target.requestId
			? Object.freeze( { ...item, failed: true } )
			: item );
	let draft = interaction.draft;
	const effects: EditorEffect[] = [
		{ type: 'REPORT_ERROR', code: 'SURFACE_PICK_FAILED', detail: event.error },
	];
	if ( target.purpose === 'point' ) {
		const pointRequests = pendingRequests.filter( ( item ) => item.purpose === 'point' )
			.sort( ( left, right ) => left.sequence - right.sequence );
		const applied = new Set<string>();
		const coordinates = [ ...draft.coordinates ];
		for ( const item of pointRequests ) {
			if ( item.position === undefined && item.failed !== true ) break;
			applied.add( item.requestId );
			if ( item.position !== undefined ) coordinates.push( item.position );
		}
		pendingRequests = pendingRequests.filter( ( item ) => ! applied.has( item.requestId ) );
		if ( coordinates.length !== draft.coordinates.length ) {
			draft = freezeDraft( {
				...draft, coordinates: Object.freeze( coordinates ), valid: false,
			} );
			effects.unshift(
				{
					type: 'VALIDATE_DRAFT', sessionId: interaction.sessionId,
					draftRevision: interaction.draftRevision + 1, draft,
				},
				{ type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft },
			);
		}
	}
	const next = updateDrawing( state, {
		...interaction, draft,
		draftRevision: draft === interaction.draft
			? interaction.draftRevision
			: interaction.draftRevision + 1,
		pendingRequests: Object.freeze( pendingRequests ),
	} );
	return transition( next, ...effects );
}

function updateDraftValidation(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'DRAFT_VALIDATED' }>,
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || interaction.sessionId !== event.sessionId
		|| interaction.draftRevision !== event.draftRevision ) {
		return transition( state );
	}
	const draft = freezeDraft( {
		...interaction.draft,
		valid: event.valid,
		validationErrors: Object.freeze( [ ...event.errors ] ),
	} );
	return transition( updateDrawing( state, { ...interaction, draft } ), {
		type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft,
	} );
}

function undoDraft( state: EditorState ): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || interaction.committing ) return transition( state );
	if ( interaction.draft.coordinates.length === 0 ) {
		const pending = [ ...interaction.pendingRequests ].reverse()
			.find( ( request ) => request.purpose === 'point' );
		if ( pending === undefined ) return transition( state );
		return transition( updateDrawing( state, {
			...interaction,
			pendingRequests: Object.freeze(
				interaction.pendingRequests.filter( ( item ) => item.requestId !== pending.requestId ),
			),
		} ), { type: 'CANCEL_SURFACE_REQUEST', requestId: pending.requestId } );
	}
	const coordinates = [ ...interaction.draft.coordinates ];
	const removed = coordinates.pop() as Position3D;
	const draft = freezeDraft( {
		...interaction.draft,
		coordinates: Object.freeze( coordinates ),
		valid: false,
	} );
	const next = updateDrawing( state, {
		...interaction,
		draft,
		draftRevision: interaction.draftRevision + 1,
		redoCoordinates: Object.freeze( [ ...interaction.redoCoordinates, removed ] ),
	} );
	return transition( next,
		{
			type: 'VALIDATE_DRAFT', sessionId: interaction.sessionId,
			draftRevision: interaction.draftRevision + 1, draft,
		},
		{ type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft },
	);
}

function redoDraft( state: EditorState ): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || interaction.committing
		|| interaction.redoCoordinates.length === 0 ) return transition( state );
	const redo = [ ...interaction.redoCoordinates ];
	const restored = redo.pop() as Position3D;
	const draft = freezeDraft( {
		...interaction.draft,
		coordinates: Object.freeze( [ ...interaction.draft.coordinates, restored ] ),
		valid: false,
	} );
	const next = updateDrawing( state, {
		...interaction,
		draft,
		draftRevision: interaction.draftRevision + 1,
		redoCoordinates: Object.freeze( redo ),
	} );
	return transition( next,
		{
			type: 'VALIDATE_DRAFT', sessionId: interaction.sessionId,
			draftRevision: interaction.draftRevision + 1, draft,
		},
		{ type: 'RENDER_DRAFT', sessionId: interaction.sessionId, draft },
	);
}

function commitDraft( state: EditorState ): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || interaction.committing ) return transition( state );
	if ( interaction.pendingRequests.some( ( request ) => request.purpose === 'point' ) ) {
		return transition( state, { type: 'REPORT_ERROR', code: 'SURFACE_PICK_PENDING' } );
	}
	if ( ! interaction.draft.valid ) {
		return transition( state, {
			type: 'REPORT_ERROR',
			code: 'INVALID_GEOMETRY',
			detail: interaction.draft.validationErrors,
		} );
	}
	const next = updateDrawing( state, { ...interaction, committing: true } );
	return transition( next, {
		type: 'COMMIT_DRAFT', sessionId: interaction.sessionId, draft: interaction.draft,
	} );
}

function finishDraftCommit(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'DRAFT_COMMITTED' }>,
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'drawing' || interaction.sessionId !== event.sessionId
		|| ! interaction.committing ) return transition( state );
	return transition( withState( state, {
		tool: Object.freeze( { kind: 'select' } ),
		interaction: Object.freeze( { kind: 'idle' } ),
		documentRevision: event.documentRevision,
	} ) );
}

function selectAt(
	state: EditorState,
	hit: HitTarget | null,
	operation: SelectionOperation,
): EditorTransition {
	const ids = hit?.entityId === undefined ? Object.freeze( [] ) : Object.freeze( [ hit.entityId ] );
	return transition( withState( state, { interaction: Object.freeze( { kind: 'idle' } ) } ), {
		type: 'APPLY_SELECTION', operation: ids.length === 0 ? 'replace' : operation, ids,
	} );
}

function beginPointerPending(
	state: EditorState,
	event: Extract<EditorIntent, { type: 'beginPointerPending' }>,
): EditorTransition {
	if ( state.interaction.kind !== 'idle' && state.interaction.kind !== 'hovering' ) return transition( state );
	return transition( withState( state, {
		interaction: Object.freeze( {
			kind: 'pointer-pending', pointerId: event.pointerId,
			start: freezeScreen( event.screen ), current: freezeScreen( event.screen ),
			hit: freezeHit( event.hit ) as HitTarget, operation: event.operation,
		} ),
	} ) );
}

function beginHandleDrag(
	state: EditorState,
	event: Extract<EditorIntent, { type: 'beginHandleDrag' }>,
): EditorTransition {
	const continuingTransform = state.interaction.kind === 'transforming'
		&& state.activeTransaction !== undefined;
	if ( state.activeTransaction !== undefined && ! continuingTransform ) {
		return transactionBusy( state );
	}
	const begun = continuingTransform
		? { transaction: state.activeTransaction as EditorTransactionState, nextSequence: state.nextSequence }
		: beginTransactionState( state, 'pointer-drag' );
	const interaction = Object.freeze( {
		kind: 'dragging-handle' as const,
		pointerId: event.pointerId,
		entityId: event.entityId,
		handleId: event.handleId,
		start: freezeScreen( event.screen ),
		current: freezeScreen( event.screen ),
		transactionId: begun.transaction.id,
	} );
	return transition( withState( state, {
		interaction, activeTransaction: begun.transaction, nextSequence: begun.nextSequence,
	} ),
		{ type: 'SET_ACTIVE_HANDLE', entityId: event.entityId, handleId: event.handleId },
		{
			type: 'BEGIN_TRANSACTION', transaction: begun.transaction,
			selectedIds: Object.freeze( [ ...state.selection.ids ] ),
			entityId: event.entityId, handleId: event.handleId,
		},
	);
}

function beginEntityDrag(
	state: EditorState,
	event: Extract<EditorIntent, { type: 'beginEntityDrag' }>,
): EditorTransition {
	if ( state.activeTransaction !== undefined ) return transactionBusy( state );
	if ( state.interaction.kind === 'pointer-pending'
		&& state.interaction.pointerId !== event.pointerId ) return transition( state );
	const begun = beginTransactionState( state, 'pointer-drag' );
	const selectedIds = state.selection.ids.includes( event.entityId )
		? state.selection.ids
		: Object.freeze( [ event.entityId ] );
	const effects: EditorEffect[] = [];
	if ( ! state.selection.ids.includes( event.entityId ) ) {
		effects.push( {
			type: 'APPLY_SELECTION', operation: 'replace', ids: Object.freeze( [ event.entityId ] ),
		} );
	}
	effects.push( {
		type: 'BEGIN_TRANSACTION', transaction: begun.transaction,
		selectedIds: Object.freeze( [ ...selectedIds ] ), entityId: event.entityId,
	} );
	return transition( withState( state, {
		interaction: Object.freeze( {
			kind: 'dragging-entity', pointerId: event.pointerId, entityId: event.entityId,
			start: freezeScreen( event.screen ), current: freezeScreen( event.screen ),
			transactionId: begun.transaction.id,
		} ),
		activeTransaction: begun.transaction,
		nextSequence: begun.nextSequence,
	} ), ...effects );
}

function beginBoxSelection(
	state: EditorState,
	event: Extract<EditorIntent, { type: 'beginBoxSelection' }>,
): EditorTransition {
	if ( state.activeTransaction !== undefined ) return transactionBusy( state );
	return transition( withState( state, {
		interaction: Object.freeze( {
			kind: 'box-selecting', pointerId: event.pointerId,
			start: freezeScreen( event.screen ), current: freezeScreen( event.screen ),
			additive: event.additive,
		} ),
	} ) );
}

function updatePointerTransaction(
	state: EditorState,
	pointerId: number,
	screenInput: ScreenPoint,
): EditorTransition {
	const interaction = state.interaction;
	const screen = freezeScreen( screenInput );
	if ( interaction.kind === 'box-selecting' ) {
		return interaction.pointerId !== pointerId ? transition( state ) : transition(
			withState( state, { interaction: Object.freeze( { ...interaction, current: screen } ) } ),
		);
	}
	if ( interaction.kind !== 'dragging-handle' && interaction.kind !== 'dragging-entity' ) {
		return transition( state );
	}
	if ( interaction.pointerId !== pointerId ) return transition( state );
	return transition( withState( state, {
		interaction: Object.freeze( { ...interaction, current: screen } ),
	} ), {
		type: 'UPDATE_POINTER_TRANSACTION', transactionId: interaction.transactionId, screen,
	} );
}

function finishPointerTransaction( state: EditorState, pointerId: number ): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind === 'box-selecting' ) {
		if ( interaction.pointerId !== pointerId ) return transition( state );
		return transition( withState( state, { interaction: Object.freeze( { kind: 'idle' } ) } ), {
			type: 'APPLY_BOX_SELECTION', start: interaction.start, end: interaction.current,
			additive: interaction.additive,
		} );
	}
	if ( interaction.kind !== 'dragging-handle' && interaction.kind !== 'dragging-entity' ) {
		return transition( state );
	}
	if ( interaction.pointerId !== pointerId ) return transition( state );
	return transition( state, {
		type: 'COMMIT_TRANSACTION', transactionId: interaction.transactionId,
	} );
}

function beginTransform( state: EditorState, mode: TransformMode ): EditorTransition {
	if ( state.selection.ids.length === 0 ) {
		return transition( state, { type: 'REPORT_ERROR', code: 'EMPTY_SELECTION' } );
	}
	if ( state.interaction.kind === 'transforming' && state.activeTransaction !== undefined ) {
		return transition( withState( state, {
			interaction: Object.freeze( { ...state.interaction, mode } ),
		} ) );
	}
	if ( state.activeTransaction !== undefined ) return transactionBusy( state );
	const begun = beginTransactionState( state, 'keyboard-nudge' );
	return transition( withState( state, {
		tool: Object.freeze( { kind: 'select' } ),
		interaction: Object.freeze( {
			kind: 'transforming', mode, heldNudgeCodes: Object.freeze( [] ),
			transactionId: begun.transaction.id,
		} ),
		activeTransaction: begun.transaction,
		nextSequence: begun.nextSequence,
	} ), {
		type: 'BEGIN_TRANSACTION', transaction: begun.transaction,
		selectedIds: Object.freeze( [ ...state.selection.ids ] ),
	} );
}

function constrainTransform( state: EditorState, axis: EnuAxis ): EditorTransition {
	return state.interaction.kind !== 'transforming'
		? transition( state )
		: transition( withState( state, {
			interaction: Object.freeze( { ...state.interaction, axis } ),
		} ) );
}

function nudgeSelection(
	state: EditorState,
	event: Extract<EditorIntent, { type: 'nudgeSelection' }>,
): EditorTransition {
	const interaction = state.interaction;
	if ( interaction.kind !== 'transforming' ) return transition( state );
	const held = new Set( interaction.heldNudgeCodes );
	if ( event.phase === 'keydown' ) {
		held.add( event.code );
		return transition( withState( state, {
			interaction: Object.freeze( {
				...interaction, heldNudgeCodes: Object.freeze( [ ...held ].sort() ),
			} ),
		} ), {
			type: 'UPDATE_KEYBOARD_TRANSACTION',
			transactionId: interaction.transactionId,
			mode: interaction.mode,
			axis: event.axis,
			amountMeters: event.amountMeters,
		} );
	}
	held.delete( event.code );
	const next = withState( state, {
		interaction: Object.freeze( {
			...interaction, heldNudgeCodes: Object.freeze( [ ...held ].sort() ),
		} ),
	} );
	return held.size === 0
		? transition( next, { type: 'COMMIT_TRANSACTION', transactionId: interaction.transactionId } )
		: transition( next );
}

function commitTransform( state: EditorState ): EditorTransition {
	return state.interaction.kind === 'transforming'
		? transition( state, {
			type: 'COMMIT_TRANSACTION', transactionId: state.interaction.transactionId,
		} )
		: transition( state );
}

function beginTextEdit( state: EditorState ): EditorTransition {
	const entityId = state.selection.primaryId;
	if ( entityId === undefined || state.activeTransaction !== undefined ) {
		return transition( state, { type: 'REPORT_ERROR', code: 'TEXT_SELECTION_REQUIRED' } );
	}
	const begun = beginTransactionState( state, 'text' );
	return transition( withState( state, {
		interaction: Object.freeze( {
			kind: 'text-editing', entityId, transactionId: begun.transaction.id,
		} ),
		activeTransaction: begun.transaction,
		nextSequence: begun.nextSequence,
	} ),
		{
			type: 'BEGIN_TRANSACTION', transaction: begun.transaction,
			selectedIds: Object.freeze( [ entityId ] ), entityId,
		},
		{ type: 'FOCUS_TEXT_INPUT', entityId },
	);
}

function commitTextEdit( state: EditorState ): EditorTransition {
	return state.interaction.kind !== 'text-editing'
		? transition( state )
		: transition( state, {
			type: 'COMMIT_TRANSACTION', transactionId: state.interaction.transactionId,
		} );
}

function markTransactionDirty( state: EditorState, id: string ): EditorTransition {
	if ( state.activeTransaction?.id !== id ) return transition( state );
	return transition( withState( state, {
		activeTransaction: Object.freeze( { ...state.activeTransaction, dirty: true } ),
	} ) );
}

function finishTransaction(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'TRANSACTION_COMMITTED' }>,
): EditorTransition {
	if ( state.activeTransaction?.id !== event.transactionId ) return transition( state );
	return transition( withState( state, {
		interaction: Object.freeze( { kind: 'idle' } ),
		activeTransaction: undefined,
		documentRevision: event.documentRevision,
	} ) );
}

function failTransaction(
	state: EditorState,
	event: Extract<EditorSystemEvent, { type: 'TRANSACTION_FAILED' }>,
): EditorTransition {
	if ( state.activeTransaction?.id !== event.transactionId ) return transition( state );
	if ( event.recoverable ) {
		return transition( state, { type: 'REPORT_ERROR', code: event.code, detail: event.detail } );
	}
	return transition( withState( state, {
		interaction: Object.freeze( { kind: 'idle' } ), activeTransaction: undefined,
	} ),
		{ type: 'ROLLBACK_TRANSACTION', transactionId: event.transactionId, reason: event.code },
		{ type: 'REPORT_ERROR', code: event.code, detail: event.detail },
	);
}

function documentChanged( state: EditorState, revision: number ): EditorTransition {
	if ( ! Number.isSafeInteger( revision ) || revision < 0 ) {
		return transition( state, { type: 'REPORT_ERROR', code: 'INVALID_DOCUMENT_REVISION', detail: revision } );
	}
	const active = state.activeTransaction;
	if ( active !== undefined && revision !== active.documentRevisionAtBegin ) {
		return transition( withState( state, {
			documentRevision: revision,
			interaction: Object.freeze( { kind: 'idle' } ),
			activeTransaction: undefined,
		} ),
			{ type: 'ROLLBACK_TRANSACTION', transactionId: active.id, reason: 'external-change' },
			{ type: 'REPORT_ERROR', code: 'STALE_TRANSACTION', detail: { revision } },
		);
	}
	return transition( withState( state, { documentRevision: revision } ) );
}

function cancelOperation( state: EditorState, reason: CancelReason | 'blur' | 'hidden' ): EditorTransition {
	const effects = cancellationEffects( state, reason );
	if ( state.interaction.kind === 'idle' || state.interaction.kind === 'hovering' ) {
		const cleared = withState( state, { interaction: Object.freeze( { kind: 'idle' } ) } );
		return reason === 'escape'
			? transition( cleared, ...effects, {
				type: 'APPLY_SELECTION', operation: 'replace', ids: Object.freeze( [] ),
			} )
			: transition( cleared, ...effects );
	}
	return transition( withState( state, {
		tool: state.interaction.kind === 'drawing'
			? Object.freeze( { kind: 'select' } )
			: state.tool,
		interaction: Object.freeze( { kind: 'idle' } ),
		activeTransaction: undefined,
	} ), ...effects );
}

function cancellationEffects(
	state: EditorState,
	reason: CancelReason | string,
): EditorEffect[] {
	const effects: EditorEffect[] = [];
	if ( state.interaction.kind === 'drawing' ) {
		for ( const request of state.interaction.pendingRequests ) {
			effects.push( { type: 'CANCEL_SURFACE_REQUEST', requestId: request.requestId } );
		}
		effects.push( { type: 'ROLLBACK_PREVIEW', transactionId: state.interaction.sessionId } );
	}
	if ( state.activeTransaction !== undefined ) {
		effects.push( {
			type: 'ROLLBACK_TRANSACTION', transactionId: state.activeTransaction.id, reason,
		} );
	}
	if ( state.interaction.kind === 'box-selecting' ) {
		effects.push( { type: 'ROLLBACK_PREVIEW', transactionId: `box:${ state.interaction.pointerId }` } );
	}
	return effects;
}

function disposeTransition( state: EditorState ): EditorTransition {
	return transition( withState( state, {
		lifecycle: 'disposed',
		tool: Object.freeze( { kind: 'select' } ),
		interaction: Object.freeze( { kind: 'idle' } ),
		activeTransaction: undefined,
	} ), ...cancellationEffects( state, 'dispose' ), { type: 'DISPOSE_RESOURCES' } );
}

function transactionGuard( state: EditorState, effect: EditorEffect ): EditorTransition {
	return state.activeTransaction === undefined
		? transition( state, effect )
		: transition( state, { type: 'REPORT_ERROR', code: 'TRANSACTION_ACTIVE' } );
}

function transactionBusy( state: EditorState ): EditorTransition {
	return transition( state, { type: 'REPORT_ERROR', code: 'TRANSACTION_ACTIVE' } );
}

function beginTransactionState(
	state: EditorState,
	kind: EditorTransactionState[ 'kind' ],
): { transaction: EditorTransactionState; nextSequence: number } {
	return {
		transaction: Object.freeze( {
			id: `editor-tx-${ state.nextSequence }`,
			kind,
			documentRevisionAtBegin: state.documentRevision,
			selectionBefore: state.selection,
			dirty: false,
		} ),
		nextSequence: state.nextSequence + 1,
	};
}

function createDrawingInteraction(
	sessionId: string,
	graphicsType: PlotFeatureType,
): Extract<EditorInteraction, { kind: 'drawing' }> {
	return Object.freeze( {
		kind: 'drawing',
		sessionId,
		draft: freezeDraft( {
			graphicsType,
			coordinates: Object.freeze( [] ),
			valid: false,
			validationErrors: Object.freeze( [] ),
		} ),
		draftRevision: 0,
		redoCoordinates: Object.freeze( [] ),
		pendingRequests: Object.freeze( [] ),
		committing: false,
	} );
}

function updateDrawing(
	state: EditorState,
	interaction: Extract<EditorInteraction, { kind: 'drawing' }>,
	nextSequence = state.nextSequence,
): EditorState {
	return withState( state, {
		interaction: Object.freeze( interaction ),
		nextSequence,
	} );
}

function freezeDraft( draft: DraftState ): DraftState {
	return Object.freeze( {
		...draft,
		coordinates: Object.freeze( draft.coordinates.map( freezePosition ) ),
		...( draft.previewCoordinate === undefined
			? { previewCoordinate: undefined }
			: { previewCoordinate: freezePosition( draft.previewCoordinate ) } ),
		validationErrors: Object.freeze( [ ...draft.validationErrors ] ),
	} );
}

function freezeSelection( selection: SelectionState ): SelectionState {
	return Object.freeze( {
		...selection,
		ids: Object.freeze( [ ...selection.ids ] ),
		...( selection.hoverTarget === undefined
			? {}
			: { hoverTarget: freezeHit( selection.hoverTarget ) as HitTarget } ),
	} );
}

function freezeHit( hit: HitTarget | null ): HitTarget | null {
	return hit === null ? null : Object.freeze( { ...hit } );
}

function freezeScreen( screen: ScreenPoint ): ScreenPoint {
	return Object.freeze( { x: screen.x, y: screen.y } );
}

function freezePosition( position: Position3D ): Position3D {
	return Object.freeze( [ position[ 0 ], position[ 1 ], position[ 2 ] ] ) as Position3D;
}

function withState(
	state: EditorState,
	patch: Partial<EditorState> & { readonly activeTransaction?: EditorTransactionState | undefined },
): EditorState {
	const candidate = { ...state, ...patch };
	if ( patch.activeTransaction === undefined && 'activeTransaction' in patch ) {
		delete ( candidate as { activeTransaction?: EditorTransactionState } ).activeTransaction;
	}
	return freezeState( candidate );
}

function freezeState( state: EditorState ): EditorState {
	return Object.freeze( state );
}

function transition( state: EditorState, ...effects: EditorEffect[] ): EditorTransition {
	return Object.freeze( { state, effects: Object.freeze( effects.map( ( effect ) => Object.freeze( effect ) ) ) } );
}
