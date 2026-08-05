import { isNativeEditableTarget, resolveFocusDomain } from './focus-policy';
import type {
	FocusDomain,
	KeyboardInputOptions,
	KeyboardStateSnapshot,
	ModifierState,
	NormalizedKeyboardInput,
} from './types';

type KeyboardListener = ( input: NormalizedKeyboardInput ) => void;

/** 独立的键盘归一化、held-state、焦点与命令执行层。 */
export class KeyboardInput {
	private readonly _root: HTMLElement;
	private readonly _document: Document;
	private readonly _window: Window;
	private readonly _options: KeyboardInputOptions;
	private readonly _isMac: boolean;
	private readonly _pressedCodes = new Set<string>();
	private readonly _pressedKeys = new Set<string>();
	private readonly _listeners = new Set<KeyboardListener>();
	private _attached = false;
	private _disposed = false;
	private _composing = false;
	private _explicitlyFocused = false;
	private _pointerCaptureActive = false;
	private _originalTabIndex: number | undefined;

	public constructor( options: KeyboardInputOptions ) {
		this._options = options;
		this._root = options.root;
		this._document = options.root.ownerDocument;
		const ownerWindow = this._document.defaultView;
		if ( ownerWindow === null ) {
			throw new Error( 'KeyboardInput root 必须属于有 defaultView 的 Document。' );
		}
		this._window = ownerWindow;
		this._isMac = resolveMacPlatform( options.platform ?? 'auto', ownerWindow.navigator );
		const conflicts = options.keymap.validate();
		if ( conflicts.length > 0 ) {
			throw new Error( `EditorKeymap 存在 ${ conflicts.length } 个同 scope 冲突。` );
		}
	}

	public attach(): void {
		if ( this._disposed ) {
			throw new Error( 'KeyboardInput 已销毁。' );
		}
		if ( this._attached ) return;
		this._attached = true;
		if ( this._root.tabIndex < 0 ) {
			this._originalTabIndex = this._root.tabIndex;
			this._root.tabIndex = 0;
		}
		this._root.addEventListener( 'keydown', this._onKeyDown, true );
		this._root.addEventListener( 'keyup', this._onKeyUp, true );
		this._root.addEventListener( 'compositionstart', this._onCompositionStart, true );
		this._root.addEventListener( 'compositionend', this._onCompositionEnd, true );
		this._window.addEventListener( 'blur', this._onBlur, true );
		this._window.addEventListener( 'pagehide', this._onPageHide, true );
		this._document.addEventListener( 'visibilitychange', this._onVisibilityChange, true );
	}

	public detach(): void {
		if ( ! this._attached ) return;
		this._attached = false;
		this._root.removeEventListener( 'keydown', this._onKeyDown, true );
		this._root.removeEventListener( 'keyup', this._onKeyUp, true );
		this._root.removeEventListener( 'compositionstart', this._onCompositionStart, true );
		this._root.removeEventListener( 'compositionend', this._onCompositionEnd, true );
		this._window.removeEventListener( 'blur', this._onBlur, true );
		this._window.removeEventListener( 'pagehide', this._onPageHide, true );
		this._document.removeEventListener( 'visibilitychange', this._onVisibilityChange, true );
		if ( this._originalTabIndex !== undefined ) {
			this._root.tabIndex = this._originalTabIndex;
			this._originalTabIndex = undefined;
		}
		this._cancelHeld( 'detach' );
	}

	public subscribe( listener: KeyboardListener ): () => void {
		this._listeners.add( listener );
		return () => this._listeners.delete( listener );
	}

	public getSnapshot(): KeyboardStateSnapshot {
		const shift = this._pressedCodes.has( 'ShiftLeft' )
			|| this._pressedCodes.has( 'ShiftRight' );
		const ctrl = this._pressedCodes.has( 'ControlLeft' )
			|| this._pressedCodes.has( 'ControlRight' );
		const alt = this._pressedCodes.has( 'AltLeft' )
			|| this._pressedCodes.has( 'AltRight' );
		const meta = this._pressedCodes.has( 'MetaLeft' )
			|| this._pressedCodes.has( 'MetaRight' );
		return Object.freeze( {
			pressedCodes: new ReadonlySetView( this._pressedCodes ),
			pressedKeys: new ReadonlySetView( this._pressedKeys ),
			shift,
			ctrl,
			alt,
			meta,
			primary: this._isMac ? meta : ctrl,
			space: this._pressedCodes.has( 'Space' ),
			altGraph: this._pressedKeys.has( 'AltGraph' ),
			composing: this._composing,
			focused: this.getFocusDomain() !== 'outside',
		} );
	}

	public getFocusDomain( target: EventTarget | null = null ): FocusDomain {
		return resolveFocusDomain(
			this._root,
			target,
			this._explicitlyFocused,
			this._pointerCaptureActive,
		);
	}

	public focus(): void {
		this._explicitlyFocused = true;
		this._root.focus( { preventScroll: true } );
	}

	public blur(): void {
		this._explicitlyFocused = false;
		this._root.blur();
		this._cancelHeld( 'blur' );
	}

	public setPointerCaptureActive( active: boolean ): void {
		this._pointerCaptureActive = active;
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this.detach();
		this._disposed = true;
		this._listeners.clear();
	}

	private readonly _onKeyDown = ( event: KeyboardEvent ): void => {
		this._handleKey( event, 'keydown' );
	};

	private readonly _onKeyUp = ( event: KeyboardEvent ): void => {
		this._handleKey( event, 'keyup' );
	};

	private readonly _onCompositionStart = (): void => {
		this._composing = true;
	};

	private readonly _onCompositionEnd = (): void => {
		this._composing = false;
	};

	private readonly _onBlur = (): void => this._cancelHeld( 'blur' );
	private readonly _onPageHide = (): void => this._cancelHeld( 'pagehide' );
	private readonly _onVisibilityChange = (): void => {
		if ( this._document.visibilityState === 'hidden' ) {
			this._cancelHeld( 'hidden' );
		}
	};

	private _handleKey( event: KeyboardEvent, phase: 'keydown' | 'keyup' ): void {
		const focus = this.getFocusDomain( event.target );
		const altGraph = event.getModifierState?.( 'AltGraph' ) === true;
		const ime = event.isComposing || this._composing
			|| event.key === 'Process' || event.keyCode === 229;
		if ( focus === 'native-editable' || isNativeEditableTarget( event.target )
			|| ime || altGraph || focus === 'outside' ) {
			return;
		}

		if ( phase === 'keydown' ) {
			this._pressedCodes.add( event.code );
			this._pressedKeys.add( event.key );
		} else {
			this._pressedCodes.delete( event.code );
			this._pressedKeys.delete( event.key );
		}
		const snapshot = this.getSnapshot();
		const context = this._options.getCommandContext( snapshot, focus );
		const command = this._options.keymap.resolve( event, context );
		let commandResult: 'consumed' | 'blocked' | 'ignored' | undefined;
		if ( command !== undefined ) {
			try {
				commandResult = command.execute( context );
			} catch ( error ) {
				this._options.onCommandError?.( error, command.id );
				this._cancelHeld( 'blur' );
				commandResult = 'blocked';
			}
			if ( commandResult === 'consumed' || commandResult === 'blocked' ) {
				event.preventDefault();
				event.stopPropagation();
			}
		}
		const input = Object.freeze( {
			phase,
			key: event.key,
			code: event.code,
			repeat: event.repeat,
			focus,
			modifiers: modifiersFromEvent( event, snapshot, this._isMac ),
			state: snapshot,
			...( command === undefined ? {} : { commandId: command.id } ),
			...( commandResult === undefined ? {} : { commandResult } ),
			originalEvent: event,
		} satisfies NormalizedKeyboardInput );
		for ( const listener of [ ...this._listeners ] ) {
			listener( input );
		}
	}

	private _cancelHeld( reason: 'blur' | 'hidden' | 'pagehide' | 'detach' ): void {
		const hadHeld = this._pressedCodes.size > 0 || this._pressedKeys.size > 0;
		this._pressedCodes.clear();
		this._pressedKeys.clear();
		this._composing = false;
		if ( hadHeld ) {
			this._options.onCancelHeld?.( reason );
		}
	}
}

/** 只读 Set 包装，避免调用方通过类型断言修改内部 held 集合。 */
class ReadonlySetView<T> implements ReadonlySet<T> {
	private readonly _snapshot: Set<T>;
	public constructor( source: ReadonlySet<T> ) { this._snapshot = new Set( source ); }
	public get size(): number { return this._snapshot.size; }
	public has( value: T ): boolean { return this._snapshot.has( value ); }
	public entries(): IterableIterator<[ T, T ]> { return this._snapshot.entries(); }
	public keys(): IterableIterator<T> { return this._snapshot.keys(); }
	public values(): IterableIterator<T> { return this._snapshot.values(); }
	public forEach( callbackfn: ( value: T, value2: T, set: ReadonlySet<T> ) => void, thisArg?: unknown ): void {
		this._snapshot.forEach( ( value ) => callbackfn.call( thisArg, value, value, this ) );
	}
	public [ Symbol.iterator ](): IterableIterator<T> { return this.values(); }
	public readonly [ Symbol.toStringTag ] = 'ReadonlySet';
}

function modifiersFromEvent(
	event: KeyboardEvent,
	snapshot: KeyboardStateSnapshot,
	isMac: boolean,
): ModifierState {
	return Object.freeze( {
		shift: event.shiftKey,
		ctrl: event.ctrlKey,
		alt: event.altKey,
		meta: event.metaKey,
		primary: isMac ? event.metaKey : event.ctrlKey,
		altGraph: event.getModifierState?.( 'AltGraph' ) === true,
		space: snapshot.space,
	} );
}

function resolveMacPlatform(
	platform: 'auto' | 'windows-linux' | 'macos',
	navigatorValue: Navigator,
): boolean {
	if ( platform !== 'auto' ) return platform === 'macos';
	const userAgentPlatform = ( navigatorValue as Navigator & {
		userAgentData?: { platform?: string };
	} ).userAgentData?.platform;
	return /mac/i.test( userAgentPlatform ?? navigatorValue.platform );
}
