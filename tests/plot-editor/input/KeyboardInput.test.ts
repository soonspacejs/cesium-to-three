import { describe, expect, it, vi } from 'vitest';

import { KeyboardInput } from '../../../src/lib/plot-editor/input/KeyboardInput';
import { createDefaultEditorKeymap } from '../../../src/lib/plot-editor/input/Keymap';
import type { CommandContext } from '../../../src/lib/plot-editor/input/types';

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
	public dispatch( type: string, event: unknown = {} ): void {
		for ( const listener of [ ...( this.listeners.get( type ) ?? [] ) ] ) {
			if ( typeof listener === 'function' ) listener( event as Event );
			else listener.handleEvent( event as Event );
		}
	}
}

function createDom( platform = 'Win32' ) {
	const windowHub = new FakeEventHub() as FakeEventHub & Window;
	Object.assign( windowHub, { navigator: { platform } } );
	const documentHub = new FakeEventHub() as FakeEventHub & Document;
	Object.assign( documentHub, {
		defaultView: windowHub,
		activeElement: null,
		visibilityState: 'visible',
	} );
	const rootHub = new FakeEventHub() as FakeEventHub & HTMLElement;
	Object.assign( rootHub, {
		ownerDocument: documentHub,
		tabIndex: -1,
		contains: ( node: unknown ) => node === rootHub,
		focus: () => Object.assign( documentHub, { activeElement: rootHub } ),
		blur: () => Object.assign( documentHub, { activeElement: null } ),
	} );
	Object.assign( documentHub, { activeElement: rootHub } );
	return { root: rootHub, document: documentHub, window: windowHub };
}

function event(
	root: HTMLElement,
	key: string,
	code: string,
	patch: Record<string, unknown> = {},
) {
	const preventDefault = vi.fn();
	const stopPropagation = vi.fn();
	return {
		type: 'keydown',
		target: root,
		key,
		code,
		repeat: false,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		isComposing: false,
		keyCode: 0,
		getModifierState: () => false,
		preventDefault,
		stopPropagation,
		...patch,
	} as unknown as KeyboardEvent & {
		preventDefault: ReturnType<typeof vi.fn>;
		stopPropagation: ReturnType<typeof vi.fn>;
	};
}

function createInput(
	platform: 'windows-linux' | 'macos' = 'windows-linux',
	execute = vi.fn( () => 'consumed' as const ),
) {
	const dom = createDom( platform === 'macos' ? 'MacIntel' : 'Win32' );
	const context = ( keyboard: any, focus: any ): CommandContext => ( {
		focus,
		mode: 'select',
		transaction: 'none',
		selectionCount: 1,
		keyboard,
	} );
	const keymap = createDefaultEditorKeymap( execute );
	const onCancelHeld = vi.fn();
	const onCommandError = vi.fn();
	const input = new KeyboardInput( {
		root: dom.root,
		keymap,
		platform,
		getCommandContext: context,
		onCancelHeld,
		onCommandError,
	} );
	return { ...dom, input, execute, onCancelHeld, onCommandError };
}

describe( 'KeyboardInput held state 与命令消费', () => {
	it( 'Windows/Linux 用 Ctrl 作为 Primary，命令输入被消费', () => {
		const { root, input, execute } = createInput();
		input.attach();
		root.dispatch( 'keydown', event( root, 'Control', 'ControlLeft', { ctrlKey: true } ) );
		const undo = event( root, 'z', 'KeyZ', { ctrlKey: true } );
		root.dispatch( 'keydown', undo );
		expect( execute ).toHaveBeenCalledWith( 'history.undo', expect.objectContaining( {
			keyboard: expect.objectContaining( { primary: true, ctrl: true } ),
		} ) );
		expect( undo.preventDefault ).toHaveBeenCalledOnce();
		expect( undo.stopPropagation ).toHaveBeenCalledOnce();
		expect( input.getSnapshot().pressedCodes.has( 'KeyZ' ) ).toBe( true );
		root.dispatch( 'keyup', event( root, 'z', 'KeyZ', {
			type: 'keyup', ctrlKey: true,
		} ) );
		expect( input.getSnapshot().pressedCodes.has( 'KeyZ' ) ).toBe( false );
	} );

	it( 'macOS 用 Meta 作为 Primary', () => {
		const { root, input, execute } = createInput( 'macos' );
		input.attach();
		root.dispatch( 'keydown', event( root, 'Meta', 'MetaLeft', { metaKey: true } ) );
		root.dispatch( 'keydown', event( root, 's', 'KeyS', { metaKey: true } ) );
		expect( execute ).toHaveBeenCalledWith( 'document.save', expect.anything() );
		expect( input.getSnapshot() ).toMatchObject( { primary: true, meta: true, ctrl: false } );
	} );

	it( 'blocked 也阻止浏览器默认行为，ignored 完全放行', () => {
		const blocked = vi.fn( () => 'blocked' as const );
		const { root, input } = createInput( 'windows-linux', blocked );
		input.attach();
		const escape = event( root, 'Escape', 'Escape' );
		root.dispatch( 'keydown', escape );
		expect( escape.preventDefault ).toHaveBeenCalledOnce();
		const letter = event( root, 'q', 'KeyQ' );
		root.dispatch( 'keydown', letter );
		expect( letter.preventDefault ).not.toHaveBeenCalled();
	} );

	it( 'one-shot repeat 不重复执行，但仍更新并发布归一化事实', () => {
		const { root, input, execute } = createInput();
		const listener = vi.fn();
		input.subscribe( listener );
		input.attach();
		root.dispatch( 'keydown', event( root, 'Delete', 'Delete', { repeat: true } ) );
		expect( execute ).not.toHaveBeenCalled();
		expect( listener ).toHaveBeenCalledWith( expect.objectContaining( {
			phase: 'keydown', key: 'Delete', repeat: true,
		} ) );
	} );
} );

describe( '焦点、editable、IME 与 AltGraph', () => {
	it( '原生输入目标的 Enter/Backspace/Primary+Z 全部放行', () => {
		const { root, input, execute } = createInput();
		input.attach();
		const textarea = {
			tagName: 'TEXTAREA',
			isContentEditable: false,
			getAttribute: () => null,
		};
		const enter = event( root, 'Enter', 'Enter', { target: textarea } );
		root.dispatch( 'keydown', enter );
		expect( execute ).not.toHaveBeenCalled();
		expect( enter.preventDefault ).not.toHaveBeenCalled();
		expect( input.getSnapshot().pressedCodes.size ).toBe( 0 );
	} );

	it( 'composition、Process、229 和 AltGraph 均不进入 keymap', () => {
		const { root, input, execute } = createInput();
		input.attach();
		root.dispatch( 'compositionstart' );
		root.dispatch( 'keydown', event( root, 'Escape', 'Escape' ) );
		root.dispatch( 'compositionend' );
		root.dispatch( 'keydown', event( root, 'Process', 'KeyA' ) );
		root.dispatch( 'keydown', event( root, 'a', 'KeyA', { keyCode: 229 } ) );
		root.dispatch( 'keydown', event( root, 'z', 'KeyZ', {
			ctrlKey: true,
			altKey: true,
			getModifierState: ( name: string ) => name === 'AltGraph',
		} ) );
		expect( execute ).not.toHaveBeenCalled();
	} );

	it( '焦点在 editor 外时不路由，显式 focus 后恢复', () => {
		const { root, document, input, execute } = createInput();
		input.attach();
		Object.assign( document, { activeElement: null } );
		root.dispatch( 'keydown', event( root, 'Escape', 'Escape' ) );
		expect( execute ).not.toHaveBeenCalled();
		input.focus();
		root.dispatch( 'keydown', event( root, 'Escape', 'Escape' ) );
		expect( execute ).toHaveBeenCalledWith( 'interaction.cancel', expect.anything() );
	} );
} );

describe( '异常清理与生命周期', () => {
	it( '焦点从画布转入原生输入时不把元素 blur 误判为窗口失焦', () => {
		const { root, window, input, onCancelHeld } = createInput();
		input.attach();
		root.dispatch( 'keydown', event( root, 'F2', 'F2' ) );
		expect( input.getSnapshot().pressedCodes.has( 'F2' ) ).toBe( true );

		window.dispatch( 'blur', { target: root } );

		expect( input.getSnapshot().pressedCodes.has( 'F2' ) ).toBe( true );
		expect( onCancelHeld ).not.toHaveBeenCalled();
	} );

	it.each( [ 'blur', 'pagehide' ] )( '%s 清空 held keys 并通知取消', ( reason ) => {
		const { root, window, input, onCancelHeld } = createInput();
		input.attach();
		root.dispatch( 'keydown', event( root, ' ', 'Space' ) );
		expect( input.getSnapshot().space ).toBe( true );
		window.dispatch( reason );
		expect( input.getSnapshot().pressedCodes.size ).toBe( 0 );
		expect( onCancelHeld ).toHaveBeenCalledWith( reason );
	} );

	it( 'document hidden 清空 held，迟到 keyup 是安全 no-op', () => {
		const { root, document, input, onCancelHeld } = createInput();
		input.attach();
		root.dispatch( 'keydown', event( root, 'Shift', 'ShiftLeft', { shiftKey: true } ) );
		Object.assign( document, { visibilityState: 'hidden' } );
		document.dispatch( 'visibilitychange' );
		root.dispatch( 'keyup', event( root, 'Shift', 'ShiftLeft', {
			type: 'keyup', shiftKey: false,
		} ) );
		expect( input.getSnapshot().shift ).toBe( false );
		expect( onCancelHeld ).toHaveBeenCalledWith( 'hidden' );
	} );

	it( 'command 抛错时报告 command id、清 held 并阻止默认行为', () => {
		const execute = vi.fn( () => {
			throw new Error( 'command failed' );
		} );
		const { root, input, onCommandError } = createInput(
			'windows-linux',
			execute as never,
		);
		input.attach();
		const escape = event( root, 'Escape', 'Escape' );
		root.dispatch( 'keydown', escape );
		expect( onCommandError ).toHaveBeenCalledWith( expect.any( Error ), 'interaction.cancel' );
		expect( input.getSnapshot().pressedCodes.size ).toBe( 0 );
		expect( escape.preventDefault ).toHaveBeenCalledOnce();
	} );

	it( 'attach/detach/dispose 幂等并恢复宿主 tabIndex', () => {
		const { root, input, execute } = createInput();
		input.attach();
		input.attach();
		expect( root.tabIndex ).toBe( 0 );
		input.detach();
		input.detach();
		expect( root.tabIndex ).toBe( -1 );
		root.dispatch( 'keydown', event( root, 'Escape', 'Escape' ) );
		expect( execute ).not.toHaveBeenCalled();
		input.dispose();
		input.dispose();
		expect( () => input.attach() ).toThrowError( /已销毁/ );
	} );
} );
