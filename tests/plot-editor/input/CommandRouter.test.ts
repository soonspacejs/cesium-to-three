import { describe, expect, it } from 'vitest';
import { CommandRouter, type RouterContext } from '../../../src/lib/plot-editor/input/CommandRouter';
import type {
	ModifierState,
	NormalizedKeyboardInput,
	NormalizedPointerInput,
	PointerDispatch,
} from '../../../src/lib/plot-editor/input/types';

const modifiers: ModifierState = Object.freeze( {
	shift: false, ctrl: false, alt: false, meta: false,
	primary: false, altGraph: false, space: false,
} );

function context( patch: Partial<RouterContext> = {} ): RouterContext {
	return {
		lifecycle: 'ready', mode: 'select', interaction: 'idle',
		draftPointCount: 0, draftRedoCount: 0, selectionCount: 0, selectedText: false,
		transformSupportsScale: true,
		transformAxisEnabled: { east: true, north: true, up: true },
		saveHandlerAvailable: true, nudgeStepMeters: 1,
		...patch,
	};
}

function pointer(
	phase: NormalizedPointerInput[ 'phase' ],
	patch: Partial<NormalizedPointerInput> = {},
	dispatchPatch: Partial<PointerDispatch> = {},
): PointerDispatch {
	const input = {
		phase, pointerId: 1, device: 'mouse', button: 'primary', buttons: 1,
		canvasX: 12, canvasY: 34, clientX: 12, clientY: 34,
		movementX: 0, movementY: 0, pressure: 0.5, tiltX: 0, tiltY: 0,
		modifiers, timeStamp: 1, originalEvent: {} as PointerEvent,
		...patch,
	} satisfies NormalizedPointerInput;
	return {
		input, owner: 'editor', gesture: 'click', startModifiers: modifiers,
		...dispatchPatch,
	};
}

function key(
	code: string,
	patch: Partial<NormalizedKeyboardInput> = {},
): Pick<NormalizedKeyboardInput, 'phase' | 'code' | 'modifiers'> {
	return { phase: 'keydown', code, modifiers, ...patch };
}

describe( 'CommandRouter pointer', () => {
	it( '绘制 click、move、双击和右键 click 进入统一意图', () => {
		const router = new CommandRouter( context( { mode: 'draw', interaction: 'drawing' } ) );
		expect( router.routePointer( pointer( 'down', {}, { gesture: 'pending' } ) ) ).toHaveLength( 0 );
		expect( router.routePointer( pointer( 'up' ) )[ 0 ]?.type ).toBe( 'beginDrawingAt' );
		router.setContext( context( { mode: 'draw', interaction: 'drawing', draftPointCount: 1 } ) );
		expect( router.routePointer( pointer( 'move' ) )[ 0 ] ).toMatchObject( {
			type: 'updateDraftPointer', screen: { x: 12, y: 34 },
		} );
		expect( router.routePointer( pointer( 'up' ) )[ 0 ]?.type ).toBe( 'appendDraftPoint' );
		expect( router.routePointer( pointer( 'double-click' ) )[ 0 ]?.type ).toBe( 'commitDrawing' );
		expect( router.routePointer( pointer( 'up', { button: 'secondary' }, {
			owner: 'navigation', gesture: 'click',
		} ) )[ 0 ]?.type ).toBe( 'commitDrawing' );
		expect( router.routePointer( pointer( 'up', { button: 'secondary' }, {
			owner: 'navigation', gesture: 'dragging',
		} ) ) ).toHaveLength( 0 );
	} );

	it( 'handle、entity 和 Primary+空白分别启动正确 session', () => {
		const router = new CommandRouter( context() );
		expect( router.routePointer( pointer( 'down' ), {
			kind: 'vertex', entityId: 'a', handleId: 'vertex:0', distanceCssPixels: 1,
		} )[ 0 ] ).toMatchObject( { type: 'beginHandleDrag', entityId: 'a' } );
		expect( router.routePointer( pointer( 'down' ), {
			kind: 'entity', entityId: 'a', distanceCssPixels: 1,
		} )[ 0 ]?.type ).toBe( 'beginPointerPending' );
		expect( router.routePointer( pointer( 'down', {
			modifiers: { ...modifiers, primary: true, ctrl: true },
		} ) )[ 0 ] ).toMatchObject( { type: 'beginBoxSelection', additive: false } );
	} );

	it( 'click 选择严格区分 replace、add、toggle', () => {
		const router = new CommandRouter( context() );
		const hit = { kind: 'entity' as const, entityId: 'a', distanceCssPixels: 1 };
		expect( router.routePointer( pointer( 'up' ), hit )[ 0 ] ).toMatchObject( { operation: 'replace' } );
		expect( router.routePointer( pointer( 'up', {
			modifiers: { ...modifiers, shift: true },
		} ), hit )[ 0 ] ).toMatchObject( { operation: 'add' } );
		expect( router.routePointer( pointer( 'up', {
			modifiers: { ...modifiers, primary: true, ctrl: true },
		} ), hit )[ 0 ] ).toMatchObject( { operation: 'toggle' } );
	} );

	it( '相机拥有的空白 click 清选，但 drag 与 Space override 不进入选择', () => {
		const router = new CommandRouter( context( { selectionCount: 1 } ) );
		expect( router.routePointer( pointer( 'up', {}, {
			owner: 'navigation', gesture: 'click',
		} ) )[ 0 ] ).toMatchObject( {
			type: 'selectAt', hit: null, operation: 'replace',
		} );
		expect( router.routePointer( pointer( 'up', {}, {
			owner: 'navigation', gesture: 'dragging',
		} ) ) ).toHaveLength( 0 );
		const spaceModifiers = Object.freeze( { ...modifiers, space: true } );
		expect( router.routePointer( pointer( 'up', { modifiers: spaceModifiers }, {
			owner: 'navigation', gesture: 'click', startModifiers: spaceModifiers,
		} ) ) ).toHaveLength( 0 );
	} );

	it( 'entity pointer-pending 只在越过阈值后升级为拖动', () => {
		const pendingHit = { kind: 'entity' as const, entityId: 'a', distanceCssPixels: 1 };
		const router = new CommandRouter( context( {
			interaction: 'pointer-pending', pendingHit,
		} ) );
		expect( router.routePointer( pointer( 'move', {}, { gesture: 'pending' } ) ) ).toHaveLength( 0 );
		expect( router.routePointer( pointer( 'move', {}, { gesture: 'dragging' } ) )[ 0 ] )
			.toMatchObject( { type: 'beginEntityDrag', pointerId: 1, entityId: 'a' } );
		expect( router.routePointer( pointer( 'up' ), null )[ 0 ] )
			.toMatchObject( { type: 'selectAt', hit: pendingHit } );
	} );

	it( 'Primary 从实体可见面起步时 click 保持 toggle，越阈值则升级为框选', () => {
		const pendingHit = { kind: 'entity' as const, entityId: 'text', distanceCssPixels: 0 };
		const router = new CommandRouter( context( {
			interaction: 'pointer-pending', pendingHit,
		} ) );
		const primary = { ...modifiers, primary: true, ctrl: true, shift: true };
		expect( router.routePointer( pointer( 'up', { modifiers: primary } ), null )[ 0 ] )
			.toMatchObject( { type: 'selectAt', operation: 'toggle', hit: pendingHit } );
		expect( router.routePointer( pointer( 'move', { modifiers: primary }, {
			gesture: 'dragging',
		} ) )[ 0 ] ).toEqual( {
			type: 'beginBoxSelection', pointerId: 1,
			screen: { x: 12, y: 34 }, additive: true,
		} );
	} );

	it( '活动拖拽的 move/up 携带当帧 Shift/Alt，不沿用 pointerdown 快照', () => {
		const router = new CommandRouter( context( { interaction: 'dragging-handle' } ) );
		const current = { ...modifiers, shift: true, alt: true };
		expect( router.routePointer( pointer( 'move', { modifiers: current }, {
			gesture: 'dragging', startModifiers: modifiers,
		} ) )[ 0 ] ).toEqual( {
			type: 'updatePointerTransaction', pointerId: 1, screen: { x: 12, y: 34 },
			modifiers: { shift: true, alt: true },
		} );
		expect( router.routePointer( pointer( 'up', { modifiers: current }, {
			gesture: 'dragging', startModifiers: modifiers,
		} ) )[ 0 ] ).toEqual( {
			type: 'finishPointerTransaction', pointerId: 1, screen: { x: 12, y: 34 },
			modifiers: { shift: true, alt: true },
		} );
	} );

	it( 'cancel/lost capture 统一生成回滚意图，disposed 永远忽略', () => {
		const router = new CommandRouter( context() );
		expect( router.routePointer( pointer( 'cancel' ) )[ 0 ] ).toEqual( {
			type: 'cancelCurrentOperation', reason: 'pointercancel',
		} );
		expect( router.routePointer( pointer( 'lost-capture' ) )[ 0 ] ).toEqual( {
			type: 'cancelCurrentOperation', reason: 'lost-capture',
		} );
		router.setContext( context( { lifecycle: 'disposed' } ) );
		expect( router.routePointer( pointer( 'up' ) ) ).toHaveLength( 0 );
	} );
} );

describe( 'CommandRouter keyboard commands', () => {
	it( '固定映射 history、selectAll、save 与 transform', () => {
		const router = new CommandRouter( context( { selectionCount: 1 } ) );
		expect( router.routeCommand( 'history.undo', key( 'KeyZ' ) ).intents[ 0 ]?.type ).toBe( 'undo' );
		expect( router.routeCommand( 'selection.selectAll', key( 'KeyA' ) ).intents[ 0 ]?.type ).toBe( 'selectAll' );
		expect( router.routeCommand( 'document.save', key( 'KeyS' ) ).intents[ 0 ]?.type ).toBe( 'save' );
		expect( router.routeCommand( 'transform.translate', key( 'KeyG' ) ).intents[ 0 ] )
			.toEqual( { type: 'beginTransform', mode: 'translate' } );
	} );

	it( 'ENU nudge 使用方向、keyup phase 与 Shift/Alt 固定倍率', () => {
		const router = new CommandRouter( context( {
			mode: 'transform', interaction: 'transforming', selectionCount: 1,
			transformMode: 'translate', nudgeStepMeters: 2,
		} ) );
		expect( router.routeCommand( 'transform.nudgeEast', key( 'ArrowLeft', {
			modifiers: { ...modifiers, shift: true },
		} ) ).intents[ 0 ] ).toMatchObject( { axis: 'east', amountMeters: -20, phase: 'keydown', code: 'ArrowLeft' } );
		expect( router.routeCommand( 'transform.nudgeNorth', key( 'ArrowUp', {
			phase: 'keyup', modifiers: { ...modifiers, shift: true, alt: true },
		} ) ).intents[ 0 ] ).toMatchObject( { axis: 'north', amountMeters: 2, phase: 'keyup' } );
	} );

	it( '当前模式的禁用轴、无选择 scale、非文本 F2 和未知命令均 blocked', () => {
		const router = new CommandRouter( context( {
			mode: 'transform', interaction: 'transforming', selectionCount: 1,
			transformMode: 'translate',
			transformAxisEnabled: { east: true, north: true, up: false },
		} ) );
		expect( router.routeCommand( 'transform.nudgeUp', key( 'PageUp' ) ).result ).toBe( 'blocked' );
		expect( router.routeCommand( 'transform.constrainAxis', key( 'KeyZ' ) ).result ).toBe( 'blocked' );
		expect( router.routeCommand( 'transform.constrainAxis', key( 'KeyX' ) ).intents[ 0 ] )
			.toEqual( { type: 'constrainTransform', axis: 'east' } );
		router.setContext( context( {
			mode: 'transform', interaction: 'transforming', selectionCount: 1,
			transformMode: 'rotate',
			transformAxisEnabled: { east: false, north: false, up: true },
		} ) );
		expect( router.routeCommand( 'transform.constrainAxis', key( 'KeyX' ) ).result ).toBe( 'blocked' );
		expect( router.routeCommand( 'transform.constrainAxis', key( 'KeyZ' ) ).intents[ 0 ] )
			.toEqual( { type: 'constrainTransform', axis: 'up' } );
		expect( router.routeCommand( 'transform.nudgeEast', key( 'ArrowRight' ) ).result )
			.toBe( 'blocked' );
		router.setContext( context( { selectionCount: 0 } ) );
		expect( router.routeCommand( 'transform.scale', key( 'KeyS' ) ).result ).toBe( 'blocked' );
		expect( router.routeCommand( 'text.beginEdit', key( 'F2' ) ).result ).toBe( 'blocked' );
		expect( router.routeCommand( 'unknown', key( 'KeyQ' ) ).result ).toBe( 'blocked' );
	} );

	it( '缺少宿主保存处理器时 save 命令 blocked', () => {
		const router = new CommandRouter( context( { saveHandlerAvailable: false } ) );
		expect( router.canExecuteCommand( 'document.save', {
			focus: 'canvas', mode: 'select', transaction: 'none', selectionCount: 0,
			keyboard: {} as never,
		} ) ).toBe( 'blocked' );
		expect( router.routeCommand( 'document.save', key( 'KeyS' ) ) ).toMatchObject( {
			result: 'blocked', intents: [],
		} );
	} );

	it( 'active transaction 阻止全局 undo，outside 焦点 ignored', () => {
		const router = new CommandRouter( context( { mode: 'draw', interaction: 'drawing' } ) );
		expect( router.routeCommand( 'history.undo', key( 'KeyZ' ) ).result ).toBe( 'blocked' );
		router.setContext( context( {
			mode: 'draw', interaction: 'drawing', draftPointCount: 2, draftRedoCount: 1,
		} ) );
		expect( router.routeCommand( 'history.undo', key( 'KeyZ' ) ).intents[ 0 ]?.type ).toBe( 'undoDraft' );
		expect( router.routeCommand( 'history.redo', key( 'KeyY' ) ).intents[ 0 ]?.type ).toBe( 'redoDraft' );
		expect( router.canExecuteCommand( 'history.undo', {
			focus: 'outside', mode: 'draw', transaction: 'draft', selectionCount: 0,
			keyboard: {} as never,
		} ) ).toBe( 'ignored' );
	} );
} );
