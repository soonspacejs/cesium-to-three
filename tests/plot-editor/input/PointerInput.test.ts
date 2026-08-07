import { describe, expect, it, vi } from 'vitest';

import { GlobeControlsNavigationAdapter } from '../../../src/lib/plot-editor/input/NavigationAdapter';
import { PointerInput } from '../../../src/lib/plot-editor/input/PointerInput';
import type { PointerClaim } from '../../../src/lib/plot-editor/input/types';

class FakeEventHub {
	public readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	public addEventListener( type: string, listener: EventListenerOrEventListenerObject | null ): void {
		if ( listener !== null ) {
			const values = this.listeners.get( type ) ?? new Set();
			values.add( listener );
			this.listeners.set( type, values );
		}
	}
	public removeEventListener( type: string, listener: EventListenerOrEventListenerObject | null ): void {
		if ( listener !== null ) this.listeners.get( type )?.delete( listener );
	}
	public dispatch( type: string, event: unknown ): void {
		for ( const listener of [ ...( this.listeners.get( type ) ?? [] ) ] ) {
			if ( typeof listener === 'function' ) listener( event as Event );
			else listener.handleEvent( event as Event );
		}
	}
}

function createEnvironment() {
	const windowHub = new FakeEventHub() as FakeEventHub & Window;
	Object.assign( windowHub, { navigator: { platform: 'Win32' } } );
	const documentHub = new FakeEventHub() as FakeEventHub & Document;
	Object.assign( documentHub, {
		defaultView: windowHub,
		visibilityState: 'visible',
	} );
	const captures = new Set<number>();
	const canvasHub = new FakeEventHub() as FakeEventHub & HTMLCanvasElement;
	const focus = vi.fn();
	const setPointerCapture = vi.fn( ( id: number ) => captures.add( id ) );
	const releasePointerCapture = vi.fn( ( id: number ) => captures.delete( id ) );
	Object.assign( canvasHub, {
		ownerDocument: documentHub,
		focus,
		getBoundingClientRect: () => ( { left: 100, top: 50, width: 800, height: 600 } ),
		setPointerCapture,
		releasePointerCapture,
		hasPointerCapture: ( id: number ) => captures.has( id ),
	} );
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 1;
	const requestAnimationFrame = vi.fn( ( callback: FrameRequestCallback ) => {
		const id = nextFrame++;
		frames.set( id, callback );
		return id;
	} );
	const cancelAnimationFrame = vi.fn( ( id: number ) => frames.delete( id ) );
	const flushFrames = () => {
		const pending = [ ...frames.entries() ];
		frames.clear();
		for ( const [ , callback ] of pending ) callback( 0 );
	};
	return {
		window: windowHub,
		document: documentHub,
		canvas: canvasHub,
		focus,
		captures,
		setPointerCapture,
		releasePointerCapture,
		requestAnimationFrame,
		cancelAnimationFrame,
		flushFrames,
	};
}

function pointerEvent(
	canvas: HTMLCanvasElement,
	type: string,
	patch: Record<string, unknown> = {},
) {
	const preventDefault = vi.fn();
	const stopPropagation = vi.fn();
	return {
		type,
		target: canvas,
		view: canvas.ownerDocument.defaultView,
		pointerId: 1,
		pointerType: 'mouse',
		button: type === 'pointermove' ? -1 : 0,
		buttons: type === 'pointerup' ? 0 : 1,
		clientX: 110,
		clientY: 70,
		movementX: 0,
		movementY: 0,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		timeStamp: 10,
		getModifierState: () => false,
		preventDefault,
		stopPropagation,
		...patch,
	} as unknown as PointerEvent & {
		preventDefault: ReturnType<typeof vi.fn>;
		stopPropagation: ReturnType<typeof vi.fn>;
	};
}

function createPointerInput(
	claim?: ( event: any ) => PointerClaim,
) {
	const environment = createEnvironment();
	const controls = { enabled: true };
	const navigation = new GlobeControlsNavigationAdapter( controls );
	let space = false;
	const onCancelOperation = vi.fn();
	const onError = vi.fn();
	const onCaptureChange = vi.fn();
	const input = new PointerInput( {
		canvas: environment.canvas,
		navigation,
		claim: claim ?? ( ( event ) => event.button === 'secondary' || event.modifiers.space
			? {
				owner: 'navigation', reason: 'camera-override', capture: false, preventDefault: false,
			}
			: { owner: 'editor', reason: 'handle', capture: true, preventDefault: true } ),
		getKeyboardModifiers: () => ( { space } ),
		onCancelOperation,
		onError,
		onCaptureChange,
		requestAnimationFrame: environment.requestAnimationFrame,
		cancelAnimationFrame: environment.cancelAnimationFrame,
	} );
	return {
		...environment,
		controls,
		navigation,
		input,
		onCancelOperation,
		onError,
		onCaptureChange,
		setSpace: ( next: boolean ) => { space = next; },
	};
}

describe( 'PointerInput editor session', () => {
	it( 'capture 阶段建立唯一 lease/capture，并用 CSS 像素判断拖拽', () => {
		const env = createPointerInput();
		const events: any[] = [];
		env.input.subscribe( ( value ) => events.push( value ) );
		env.input.attach();
		const down = pointerEvent( env.canvas, 'pointerdown', { clientX: 110, clientY: 70 } );
		env.canvas.dispatch( 'pointerdown', down );
		expect( env.controls.enabled ).toBe( false );
		expect( env.setPointerCapture ).toHaveBeenCalledWith( 1 );
		expect( env.focus ).toHaveBeenCalledWith( { preventScroll: true } );
		expect( down.preventDefault ).toHaveBeenCalledOnce();
		expect( events[ 0 ] ).toMatchObject( {
			owner: 'editor', gesture: 'pending',
			input: { canvasX: 10, canvasY: 20, device: 'mouse', button: 'primary' },
		} );

		env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', {
			clientX: 114, clientY: 73,
		} ) );
		env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', {
			clientX: 120, clientY: 70,
		} ) );
		expect( events ).toHaveLength( 1 );
		env.flushFrames();
		expect( events ).toHaveLength( 2 );
		expect( events[ 1 ] ).toMatchObject( {
			gesture: 'dragging', input: { canvasX: 20, canvasY: 20 },
		} );

		const up = pointerEvent( env.canvas, 'pointerup', { clientX: 120, clientY: 70 } );
		env.canvas.dispatch( 'pointerup', up );
		expect( events.at( -1 ) ).toMatchObject( { gesture: 'dragging', input: { phase: 'up' } } );
		expect( env.releasePointerCapture ).toHaveBeenCalledWith( 1 );
		expect( env.controls.enabled ).toBe( true );
		expect( env.input.activePointerId ).toBeNull();
		expect( env.onCaptureChange.mock.calls ).toEqual( [ [ true ], [ false ] ] );
	} );

	it( 'pointerup 前同步 flush 最终 pending move', () => {
		const env = createPointerInput();
		const phases: string[] = [];
		env.input.subscribe( ( value ) => phases.push( `${ value.input.phase }:${ value.input.canvasX }` ) );
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', { clientX: 130 } ) );
		env.canvas.dispatch( 'pointerup', pointerEvent( env.canvas, 'pointerup', { clientX: 130 } ) );
		expect( phases ).toEqual( [ 'down:10', 'move:30', 'up:30' ] );
		expect( env.cancelAnimationFrame ).toHaveBeenCalledOnce();
		env.flushFrames();
		expect( phases ).toHaveLength( 3 );
	} );

	it( 'active editor drag 中途按 Space 不改变 owner，只更新当前 modifiers', () => {
		const env = createPointerInput();
		const events: any[] = [];
		env.input.subscribe( ( value ) => events.push( value ) );
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		env.setSpace( true );
		env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', { clientX: 120 } ) );
		env.flushFrames();
		expect( events[ 1 ].owner ).toBe( 'editor' );
		expect( events[ 1 ].startModifiers.space ).toBe( false );
		expect( events[ 1 ].input.modifiers.space ).toBe( true );
	} );

	it( 'setPointerCapture 失败时释放 lease、报告错误且不建立 session', () => {
		const env = createPointerInput();
		env.canvas.setPointerCapture = vi.fn( () => {
			throw new Error( 'capture failed' );
		} );
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		expect( env.controls.enabled ).toBe( true );
		expect( env.input.activePointerId ).toBeNull();
		expect( env.onError ).toHaveBeenCalledWith(
			'POINTER_CAPTURE_FAILED', expect.any( Error ),
		);
		expect( env.onCancelOperation ).toHaveBeenCalledWith( 'pointercancel' );
	} );
} );

describe( 'PointerInput navigation、click 与 move 合并', () => {
	it( '右键与 Space down 归 navigation，不 acquire lease 或阻止事件', () => {
		const env = createPointerInput();
		const events: any[] = [];
		env.input.subscribe( ( value ) => events.push( value ) );
		env.input.attach();
		const rightDown = pointerEvent( env.canvas, 'pointerdown', { button: 2, buttons: 2 } );
		env.canvas.dispatch( 'pointerdown', rightDown );
		env.canvas.dispatch( 'pointerup', pointerEvent( env.canvas, 'pointerup', {
			button: 2, buttons: 0,
		} ) );
		expect( events.at( -1 ) ).toMatchObject( { owner: 'navigation', gesture: 'click' } );
		expect( rightDown.preventDefault ).not.toHaveBeenCalled();
		expect( env.setPointerCapture ).not.toHaveBeenCalled();
		expect( env.controls.enabled ).toBe( true );

		events.length = 0;
		env.setSpace( true );
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		expect( events[ 0 ] ).toMatchObject( { owner: 'navigation' } );
	} );

	it( '右键 up 位移越过容差后永久判为 dragging', () => {
		const env = createPointerInput();
		const events: any[] = [];
		env.input.subscribe( ( value ) => events.push( value ) );
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown', {
			button: 2, buttons: 2,
		} ) );
		env.canvas.dispatch( 'pointerup', pointerEvent( env.canvas, 'pointerup', {
			button: 2, buttons: 0, clientX: 130,
		} ) );
		expect( events.at( -1 ).gesture ).toBe( 'dragging' );
	} );

	it( '1000 次无 capture hover 每帧只发布最后一条 move', () => {
		const env = createPointerInput();
		const listener = vi.fn();
		env.input.subscribe( listener );
		env.input.attach();
		for ( let index = 0; index < 1000; index++ ) {
			env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', {
				clientX: 111 + index,
			} ) );
		}
		expect( listener ).not.toHaveBeenCalled();
		env.flushFrames();
		expect( listener ).toHaveBeenCalledOnce();
		expect( listener ).toHaveBeenCalledWith( expect.objectContaining( {
			owner: 'navigation', input: expect.objectContaining( { canvasX: 1010 } ),
		} ) );
	} );
} );

describe( 'PointerInput 取消与生命周期', () => {
	it.each( [
		[ 'pointercancel', 'pointercancel', 'cancel' ],
		[ 'lostpointercapture', 'lost-capture', 'lost-capture' ],
	] )( '%s 回滚并释放导航 lease', ( domType, reason, phase ) => {
		const env = createPointerInput();
		const events: any[] = [];
		env.input.subscribe( ( value ) => events.push( value ) );
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		env.canvas.dispatch( domType, pointerEvent( env.canvas, domType ) );
		expect( env.onCancelOperation ).toHaveBeenCalledWith( reason );
		expect( events.at( -1 ) ).toMatchObject( { gesture: 'ended', input: { phase } } );
		expect( env.controls.enabled ).toBe( true );
		expect( env.input.activePointerId ).toBeNull();
	} );

	it.each( [ 'blur', 'hidden' ] )( '%s 统一取消 active session', ( reason ) => {
		const env = createPointerInput();
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		if ( reason === 'blur' ) {
			env.window.dispatch( 'blur', {} );
		} else {
			Object.assign( env.document, { visibilityState: 'hidden' } );
			env.document.dispatch( 'visibilitychange', {} );
		}
		expect( env.onCancelOperation ).toHaveBeenCalledWith( reason );
		expect( env.controls.enabled ).toBe( true );
	} );

	it( 'canvas 向原生输入转移焦点时不误判为 window blur', () => {
		const env = createPointerInput();
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		env.window.dispatch( 'blur', { target: env.canvas } );
		expect( env.onCancelOperation ).not.toHaveBeenCalled();
		expect( env.input.activePointerId ).toBe( 1 );
		expect( env.controls.enabled ).toBe( false );
	} );

	it( '第二个 touch pointer 回滚当前 editor session', () => {
		const env = createPointerInput();
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown', {
			pointerId: 1, pointerType: 'touch', pressure: 1,
		} ) );
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown', {
			pointerId: 2, pointerType: 'touch', pressure: 1,
		} ) );
		expect( env.onCancelOperation ).toHaveBeenCalledWith( 'second-pointer' );
		expect( env.input.activePointerId ).toBeNull();
		expect( env.controls.enabled ).toBe( true );
	} );

	it( 'dispose 幂等，取消 RAF/session 并移除全部 listener', () => {
		const env = createPointerInput();
		env.input.attach();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		env.canvas.dispatch( 'pointermove', pointerEvent( env.canvas, 'pointermove', { clientX: 130 } ) );
		env.input.dispose();
		env.input.dispose();
		expect( env.onCancelOperation ).toHaveBeenCalledWith( 'dispose' );
		expect( env.cancelAnimationFrame ).toHaveBeenCalledOnce();
		expect( env.controls.enabled ).toBe( true );
		expect( () => env.input.attach() ).toThrowError( /已销毁/ );
	} );
} );

describe( '双击、菜单与滚轮边界', () => {
	it( 'dblclick 归一化为 mouse double-click 并交给 claim', () => {
		const claim = vi.fn( () => ( {
			owner: 'editor', reason: 'draw', capture: false, preventDefault: true,
		} as const ) );
		const env = createPointerInput( claim );
		const listener = vi.fn();
		env.input.subscribe( listener );
		env.input.attach();
		const doubleClick = pointerEvent( env.canvas, 'dblclick', { button: 0 } );
		env.canvas.dispatch( 'dblclick', doubleClick );
		expect( listener ).toHaveBeenCalledWith( expect.objectContaining( {
			gesture: 'click', input: expect.objectContaining( {
				phase: 'double-click', pointerId: -1, device: 'mouse',
			} ),
		} ) );
		expect( doubleClick.preventDefault ).toHaveBeenCalledOnce();
	} );

	it( 'contextmenu 仅在 editor scope 阻止，wheel 永远放行 navigation', () => {
		const env = createPointerInput();
		env.input.attach();
		const outsideMenu = pointerEvent( env.canvas, 'contextmenu' );
		env.canvas.dispatch( 'contextmenu', outsideMenu );
		expect( outsideMenu.preventDefault ).not.toHaveBeenCalled();
		env.canvas.dispatch( 'pointerdown', pointerEvent( env.canvas, 'pointerdown' ) );
		const editorMenu = pointerEvent( env.canvas, 'contextmenu' );
		env.canvas.dispatch( 'contextmenu', editorMenu );
		expect( editorMenu.preventDefault ).toHaveBeenCalledOnce();
		const wheel = pointerEvent( env.canvas, 'wheel' );
		env.canvas.dispatch( 'wheel', wheel );
		expect( wheel.preventDefault ).not.toHaveBeenCalled();
	} );
} );
