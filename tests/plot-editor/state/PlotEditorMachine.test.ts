import { describe, expect, it } from 'vitest';
import { HeightReference, type Position3D } from '../../../src/lib/plot-editor/document/types';
import {
	createInitialEditorState,
	reduceEditor,
	type EditorEvent,
	type EditorState,
	type EditorTransition,
} from '../../../src/lib/plot-editor/state/PlotEditorMachine';

function ready( selectionIds: readonly string[] = [] ): EditorState {
	const primaryId = selectionIds.at( -1 );
	return reduceEditor( createInitialEditorState( 3, {
		ids: Object.freeze( [ ...selectionIds ] ),
		...( primaryId === undefined ? {} : { primaryId } ),
	} ), { type: 'INITIALIZE' } ).state;
}

function step( state: EditorState, event: EditorEvent ): EditorTransition {
	return reduceEditor( state, event );
}

function drawing( state = ready() ): EditorTransition {
	return step( state, {
		type: 'SET_TOOL',
		tool: {
			kind: 'draw', graphicsType: 'line',
			heightReference: HeightReference.CLAMP_TO_TERRAIN,
		},
	} );
}

function drawingText( state = ready() ): EditorTransition {
	return step( state, {
		type: 'SET_TOOL',
		tool: {
			kind: 'draw', graphicsType: 'text', heightReference: HeightReference.NONE,
		},
	} );
}

function requestId( state: EditorState, index = 0 ): string {
	if ( state.interaction.kind !== 'drawing' ) throw new Error( '不是 drawing。' );
	return state.interaction.pendingRequests[ index ].requestId;
}

function sessionId( state: EditorState ): string {
	if ( state.interaction.kind !== 'drawing' ) throw new Error( '不是 drawing。' );
	return state.interaction.sessionId;
}

function draftRevision( state: EditorState ): number {
	if ( state.interaction.kind !== 'drawing' ) throw new Error( '不是 drawing。' );
	return state.interaction.draftRevision;
}

function resolve(
	state: EditorState,
	request: string,
	position: Position3D,
): EditorTransition {
	return step( state, {
		type: 'SURFACE_RESOLVED', requestId: request,
		sessionId: sessionId( state ), revision: state.documentRevision, position,
	} );
}

describe( 'PlotEditorMachine lifecycle', () => {
	it( 'created 只接受初始化；disposed 是幂等终态', () => {
		const created = createInitialEditorState();
		expect( step( created, { type: 'selectAll' } ).state ).toBe( created );
		const initialized = step( created, { type: 'INITIALIZE' } );
		expect( initialized.state.lifecycle ).toBe( 'ready' );
		const disposed = step( initialized.state, { type: 'DISPOSE' } );
		expect( disposed.state.lifecycle ).toBe( 'disposed' );
		expect( disposed.effects.at( -1 )?.type ).toBe( 'DISPOSE_RESOURCES' );
		expect( step( disposed.state, { type: 'DISPOSE' } ).effects ).toEqual( [] );
		expect( step( disposed.state, { type: 'selectAll' } ).state ).toBe( disposed.state );
	} );

	it( 'idle Escape 清 selection，blur 只清 interaction 不清 selection', () => {
		const state = ready( [ 'a' ] );
		expect( step( state, {
			type: 'cancelCurrentOperation', reason: 'escape',
		} ).effects ).toContainEqual( {
			type: 'APPLY_SELECTION', operation: 'replace', ids: [],
		} );
		expect( step( state, { type: 'FOCUS_LOST', reason: 'blur' } ).effects ).toEqual( [] );
	} );
} );

describe( 'PlotEditorMachine drawing', () => {
	it( 'text 首个 anchor resolve 后请求原生 draft 输入，并阻止追加第二个 anchor', () => {
		let state = drawingText().state;
		state = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } ).state;
		const first = requestId( state );
		const resolved = resolve( state, first, [ 116, 39, 0 ] );
		expect( resolved.effects.map( ( effect ) => effect.type ) ).toEqual( [
			'VALIDATE_DRAFT', 'RENDER_DRAFT', 'FOCUS_DRAFT_TEXT_INPUT',
		] );
		state = resolved.state;
		const second = step( state, { type: 'appendDraftPoint', screen: { x: 2, y: 2 } } );
		expect( second.effects ).toEqual( [] );
		expect( second.state.interaction ).toMatchObject( {
			draft: { coordinates: [ [ 116, 39, 0 ] ] },
		} );
	} );

	it( '点请求按发出顺序落入草稿，乱序结果不改变作者顺序', () => {
		let state = drawing().state;
		let transition = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } );
		state = transition.state;
		const first = requestId( state );
		expect( transition.effects[ 0 ] ).toMatchObject( {
			type: 'PICK_SURFACE', heightReference: HeightReference.CLAMP_TO_TERRAIN,
			request: { purpose: 'point', documentRevision: 3 },
		} );
		state = step( state, { type: 'appendDraftPoint', screen: { x: 2, y: 2 } } ).state;
		const second = requestId( state, 1 );
		state = resolve( state, second, [ 20, 2, 0 ] ).state;
		expect( state.interaction ).toMatchObject( { draft: { coordinates: [] } } );
		transition = resolve( state, first, [ 10, 1, 0 ] );
		state = transition.state;
		expect( state.interaction ).toMatchObject( {
			draft: { coordinates: [ [ 10, 1, 0 ], [ 20, 2, 0 ] ] },
			pendingRequests: [],
		} );
		expect( transition.effects.map( ( effect ) => effect.type ) ).toEqual( [
			'VALIDATE_DRAFT', 'RENDER_DRAFT',
		] );
	} );

	it( 'preview 只保留最后请求，stale session/revision 结果被丢弃', () => {
		let state = drawing().state;
		state = step( state, { type: 'updateDraftPointer', screen: { x: 1, y: 1 } } ).state;
		const stale = requestId( state );
		const nextRequest = step( state, {
			type: 'updateDraftPointer', screen: { x: 2, y: 2 },
		} );
		state = nextRequest.state;
		expect( nextRequest.effects[ 0 ] ).toEqual( {
			type: 'CANCEL_SURFACE_REQUEST', requestId: stale,
		} );
		const current = requestId( state );
		expect( resolve( state, stale, [ 1, 1, 0 ] ).state ).toBe( state );
		expect( step( state, {
			type: 'SURFACE_RESOLVED', requestId: current,
			sessionId: sessionId( state ), revision: 999, position: [ 2, 2, 0 ],
		} ).state ).toBe( state );
		state = resolve( state, current, [ 2, 2, 0 ] ).state;
		expect( state.interaction ).toMatchObject( {
			draft: { previewCoordinate: [ 2, 2, 0 ] }, pendingRequests: [],
		} );
	} );

	it( '前序 surface 失败会释放后续已解析点，不永久阻塞 commit', () => {
		let state = drawing().state;
		state = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } ).state;
		const first = requestId( state );
		state = step( state, { type: 'appendDraftPoint', screen: { x: 2, y: 2 } } ).state;
		const second = requestId( state, 1 );
		state = resolve( state, second, [ 2, 2, 0 ] ).state;
		const failed = step( state, {
			type: 'SURFACE_FAILED', requestId: first,
			sessionId: sessionId( state ), revision: 3, error: new Error( 'terrain' ),
		} );
		expect( failed.state.interaction ).toMatchObject( {
			draft: { coordinates: [ [ 2, 2, 0 ] ] }, pendingRequests: [],
		} );
		expect( failed.effects.at( -1 ) ).toMatchObject( {
			type: 'REPORT_ERROR', code: 'SURFACE_PICK_FAILED',
		} );
	} );

	it( '草稿 undo/redo 是本地 journal，不触发 document history', () => {
		let state = drawing().state;
		state = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } ).state;
		state = resolve( state, requestId( state ), [ 1, 1, 0 ] ).state;
		state = step( state, { type: 'appendDraftPoint', screen: { x: 2, y: 2 } } ).state;
		state = resolve( state, requestId( state ), [ 2, 2, 0 ] ).state;
		let transition = step( state, { type: 'undoDraft' } );
		state = transition.state;
		expect( transition.effects.some( ( effect ) => effect.type.startsWith( 'HISTORY_' ) ) ).toBe( false );
		expect( state.interaction ).toMatchObject( {
			draft: { coordinates: [ [ 1, 1, 0 ] ] }, redoCoordinates: [ [ 2, 2, 0 ] ],
		} );
		state = step( state, { type: 'redoDraft' } ).state;
		expect( state.interaction ).toMatchObject( {
			draft: { coordinates: [ [ 1, 1, 0 ], [ 2, 2, 0 ] ] }, redoCoordinates: [],
		} );
	} );

	it( '旧 draftRevision 的异步 validation 不覆盖新草稿', () => {
		let state = drawing().state;
		state = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } ).state;
		state = resolve( state, requestId( state ), [ 1, 1, 0 ] ).state;
		const staleRevision = draftRevision( state );
		state = step( state, { type: 'undoDraft' } ).state;
		const ignored = step( state, {
			type: 'DRAFT_VALIDATED', sessionId: sessionId( state ),
			draftRevision: staleRevision, valid: true, errors: [],
		} );
		expect( ignored.state ).toBe( state );
		expect( state.interaction ).toMatchObject( { draft: { valid: false } } );
	} );

	it( 'pending/invalid 不提交；验证通过只发一次 COMMIT_DRAFT', () => {
		let state = drawing().state;
		state = step( state, { type: 'beginDrawingAt', screen: { x: 1, y: 1 } } ).state;
		expect( step( state, { type: 'commitDrawing' } ).effects[ 0 ] ).toMatchObject( {
			code: 'SURFACE_PICK_PENDING',
		} );
		state = resolve( state, requestId( state ), [ 1, 1, 0 ] ).state;
		expect( step( state, { type: 'commitDrawing' } ).effects[ 0 ] ).toMatchObject( {
			code: 'INVALID_GEOMETRY',
		} );
		state = step( state, {
			type: 'DRAFT_VALIDATED', sessionId: sessionId( state ),
			draftRevision: draftRevision( state ), valid: true, errors: [],
		} ).state;
		const committed = step( state, { type: 'commitDrawing' } );
		expect( committed.effects ).toHaveLength( 1 );
		expect( committed.effects[ 0 ]?.type ).toBe( 'COMMIT_DRAFT' );
		expect( step( committed.state, { type: 'commitDrawing' } ).effects ).toEqual( [] );
		const done = step( committed.state, {
			type: 'DRAFT_COMMITTED', sessionId: sessionId( committed.state ), documentRevision: 4,
		} );
		expect( done.state ).toMatchObject( {
			tool: { kind: 'select' }, interaction: { kind: 'idle' }, documentRevision: 4,
		} );
	} );
} );

describe( 'PlotEditorMachine selection and transactions', () => {
	it( 'entity click pending 与越阈值 drag 是不同路径', () => {
		let state = ready();
		state = step( state, {
			type: 'beginPointerPending', pointerId: 7, screen: { x: 1, y: 2 },
			hit: { kind: 'entity', entityId: 'a', distanceCssPixels: 1 }, operation: 'replace',
		} ).state;
		expect( state.interaction.kind ).toBe( 'pointer-pending' );
		const click = step( state, {
			type: 'selectAt', screen: { x: 1, y: 2 },
			hit: { kind: 'entity', entityId: 'a', distanceCssPixels: 1 }, operation: 'replace',
		} );
		expect( click.effects[ 0 ] ).toEqual( {
			type: 'APPLY_SELECTION', operation: 'replace', ids: [ 'a' ],
		} );

		state = step( state, {
			type: 'beginEntityDrag', pointerId: 7, entityId: 'a', screen: { x: 9, y: 9 },
		} ).state;
		expect( state.interaction.kind ).toBe( 'dragging-entity' );
		expect( state.activeTransaction?.kind ).toBe( 'pointer-drag' );
		expect( step( state, {
			type: 'updatePointerTransaction', pointerId: 99, screen: { x: 10, y: 10 },
		} ).effects ).toEqual( [] );
		let transition = step( state, {
			type: 'updatePointerTransaction', pointerId: 7, screen: { x: 10, y: 10 },
		} );
		expect( transition.effects[ 0 ]?.type ).toBe( 'UPDATE_POINTER_TRANSACTION' );
		state = transition.state;
		transition = step( state, {
			type: 'finishPointerTransaction', pointerId: 7, screen: { x: 10, y: 10 },
		} );
		expect( transition.effects[ 0 ]?.type ).toBe( 'COMMIT_TRANSACTION' );
	} );

	it( '框选只更新选择，反向拖动的矩形由 effect runner 统一计算', () => {
		let state = ready();
		state = step( state, {
			type: 'beginBoxSelection', pointerId: 1, screen: { x: 100, y: 90 }, additive: true,
		} ).state;
		state = step( state, {
			type: 'updatePointerTransaction', pointerId: 1, screen: { x: 10, y: 20 },
		} ).state;
		const finished = step( state, {
			type: 'finishPointerTransaction', pointerId: 1, screen: { x: 10, y: 20 },
		} );
		expect( finished.state.interaction.kind ).toBe( 'idle' );
		expect( finished.effects[ 0 ] ).toEqual( {
			type: 'APPLY_BOX_SELECTION',
			start: { x: 100, y: 90 }, end: { x: 10, y: 20 }, additive: true,
		} );
	} );

	it( 'G/R/S 复用事务；多键 nudge 在最后一个 keyup 才提交', () => {
		let transition = step( ready( [ 'a' ] ), { type: 'beginTransform', mode: 'translate' } );
		let state = transition.state;
		const transactionId = state.activeTransaction?.id as string;
		expect( transition.effects[ 0 ]?.type ).toBe( 'BEGIN_TRANSACTION' );
		transition = step( state, { type: 'beginTransform', mode: 'rotate' } );
		state = transition.state;
		expect( transition.effects ).toEqual( [] );
		expect( state.activeTransaction?.id ).toBe( transactionId );
		state = step( state, {
			type: 'nudgeSelection', axis: 'east', amountMeters: 1,
			phase: 'keydown', code: 'ArrowRight',
		} ).state;
		state = step( state, {
			type: 'nudgeSelection', axis: 'north', amountMeters: 1,
			phase: 'keydown', code: 'ArrowUp',
		} ).state;
		transition = step( state, {
			type: 'nudgeSelection', axis: 'east', amountMeters: 1,
			phase: 'keyup', code: 'ArrowRight',
		} );
		state = transition.state;
		expect( transition.effects ).toEqual( [] );
		transition = step( state, {
			type: 'nudgeSelection', axis: 'north', amountMeters: 1,
			phase: 'keyup', code: 'ArrowUp',
		} );
		expect( transition.effects ).toEqual( [ {
			type: 'COMMIT_TRANSACTION', transactionId,
		} ] );
	} );

	it( '已开启的 G/R/S 事务可以切换为 Gizmo 指针拖拽且复用同一事务', () => {
		const transforming = step(
			ready( [ 'a' ] ),
			{ type: 'beginTransform', mode: 'translate' },
		).state;
		const transactionId = transforming.activeTransaction?.id as string;
		const transition = step( transforming, {
			type: 'beginHandleDrag',
			pointerId: 7,
			entityId: 'a',
			handleId: 'translate:east',
			screen: { x: 10, y: 20 },
		} );

		expect( transition.state.interaction ).toMatchObject( {
			kind: 'dragging-handle',
			transactionId,
			handleId: 'translate:east',
		} );
		expect( transition.state.activeTransaction?.id ).toBe( transactionId );
		expect( transition.effects.map( ( effect ) => effect.type ) ).toEqual( [
			'SET_ACTIVE_HANDLE',
			'BEGIN_TRANSACTION',
		] );
	} );

	it( '外部 revision 冲突原子 rollback 并报告 STALE_TRANSACTION', () => {
		let state = step( ready( [ 'a' ] ), { type: 'beginTransform', mode: 'translate' } ).state;
		const id = state.activeTransaction?.id as string;
		const transition = step( state, { type: 'DOCUMENT_CHANGED', revision: 4 } );
		expect( transition.state ).toMatchObject( {
			documentRevision: 4, interaction: { kind: 'idle' },
		} );
		expect( transition.state.activeTransaction ).toBeUndefined();
		expect( transition.effects ).toEqual( [
			{ type: 'ROLLBACK_TRANSACTION', transactionId: id, reason: 'external-change' },
			{ type: 'REPORT_ERROR', code: 'STALE_TRANSACTION', detail: { revision: 4 } },
		] );
	} );

	it( 'text edit 获取 focus，Escape/blur/dispose 都回滚同一 transaction', () => {
		let transition = step( ready( [ 'text-a' ] ), { type: 'beginTextEdit' } );
		let state = transition.state;
		const id = state.activeTransaction?.id as string;
		expect( transition.effects.map( ( effect ) => effect.type ) ).toEqual( [
			'BEGIN_TRANSACTION', 'FOCUS_TEXT_INPUT',
		] );
		transition = step( state, { type: 'cancelTextEdit' } );
		expect( transition.effects ).toContainEqual( {
			type: 'ROLLBACK_TRANSACTION', transactionId: id, reason: 'escape',
		} );

		state = step( ready( [ 'text-a' ] ), { type: 'beginTextEdit' } ).state;
		transition = step( state, { type: 'DISPOSE' } );
		expect( transition.effects.map( ( effect ) => effect.type ) ).toEqual( [
			'ROLLBACK_TRANSACTION', 'DISPOSE_RESOURCES',
		] );
	} );

	it( 'active transaction 中的迟到 hover 不覆盖交互状态', () => {
		const state = step( ready( [ 'a' ] ), { type: 'beginTransform', mode: 'translate' } ).state;
		expect( step( state, {
			type: 'HOVER_RESOLVED', hit: { kind: 'entity', entityId: 'b', distanceCssPixels: 1 },
		} ).state ).toBe( state );
	} );
} );
