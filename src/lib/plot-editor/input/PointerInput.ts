import type {
	ModifierState,
	NavigationLease,
	NavigationLeaseKind,
	NormalizedPointerInput,
	PointerButton,
	PointerClaim,
	PointerDevice,
	PointerDispatch,
	PointerGesturePhase,
	PointerInputOptions,
	PointerOwner,
} from './types';

interface PointerSession {
	readonly pointerId: number;
	readonly owner: PointerOwner;
	readonly down: NormalizedPointerInput;
	readonly startModifiers: ModifierState;
	readonly claim: PointerClaim;
	currentModifiers: ModifierState;
	gesture: PointerGesturePhase;
	lease?: NavigationLease;
}

type PointerListener = ( event: PointerDispatch ) => void;

/** DOM Pointer Events 的 capture-phase 归一化与 session 仲裁器。 */
export class PointerInput {
	private readonly _options: PointerInputOptions;
	private readonly _canvas: HTMLCanvasElement;
	private readonly _window: Window;
	private readonly _document: Document;
	private readonly _listeners = new Set<PointerListener>();
	private readonly _requestAnimationFrame: ( callback: FrameRequestCallback ) => number;
	private readonly _cancelAnimationFrame: ( handle: number ) => void;
	private _session: PointerSession | null = null;
	private _pendingMove: PointerDispatch | null = null;
	private _frameHandle: number | null = null;
	private _attached = false;
	private _disposed = false;

	public constructor( options: PointerInputOptions ) {
		this._options = options;
		this._canvas = options.canvas;
		this._document = options.canvas.ownerDocument;
		const ownerWindow = this._document.defaultView;
		if ( ownerWindow === null ) {
			throw new Error( 'PointerInput canvas 必须属于有 defaultView 的 Document。' );
		}
		this._window = ownerWindow;
		this._requestAnimationFrame = options.requestAnimationFrame
			?? ownerWindow.requestAnimationFrame.bind( ownerWindow );
		this._cancelAnimationFrame = options.cancelAnimationFrame
			?? ownerWindow.cancelAnimationFrame.bind( ownerWindow );
		validateTolerance( options.clickToleranceCssPixels ?? 6, 'clickToleranceCssPixels' );
		validateTolerance( options.touchClickToleranceCssPixels ?? 10, 'touchClickToleranceCssPixels' );
	}

	public attach(): void {
		if ( this._disposed ) throw new Error( 'PointerInput 已销毁。' );
		if ( this._attached ) return;
		this._attached = true;
		const listenerOptions = { capture: true, passive: false } as const;
		this._canvas.addEventListener( 'pointerdown', this._onPointerDown, listenerOptions );
		this._canvas.addEventListener( 'pointermove', this._onPointerMove, listenerOptions );
		this._canvas.addEventListener( 'pointerup', this._onPointerUp, listenerOptions );
		this._canvas.addEventListener( 'pointercancel', this._onPointerCancel, listenerOptions );
		this._canvas.addEventListener( 'lostpointercapture', this._onLostPointerCapture, listenerOptions );
		this._canvas.addEventListener( 'dblclick', this._onDoubleClick, listenerOptions );
		this._canvas.addEventListener( 'contextmenu', this._onContextMenu, listenerOptions );
		this._canvas.addEventListener( 'wheel', this._onWheel, listenerOptions );
		// 元素间焦点迁移也会在 capture 阶段经过 window；这里只监听浏览器窗口自身失焦。
		this._window.addEventListener( 'blur', this._onBlur );
		this._document.addEventListener( 'visibilitychange', this._onVisibilityChange, true );
	}

	public detach(): void {
		if ( ! this._attached ) return;
		this._attached = false;
		this._canvas.removeEventListener( 'pointerdown', this._onPointerDown, true );
		this._canvas.removeEventListener( 'pointermove', this._onPointerMove, true );
		this._canvas.removeEventListener( 'pointerup', this._onPointerUp, true );
		this._canvas.removeEventListener( 'pointercancel', this._onPointerCancel, true );
		this._canvas.removeEventListener( 'lostpointercapture', this._onLostPointerCapture, true );
		this._canvas.removeEventListener( 'dblclick', this._onDoubleClick, true );
		this._canvas.removeEventListener( 'contextmenu', this._onContextMenu, true );
		this._canvas.removeEventListener( 'wheel', this._onWheel, true );
		this._window.removeEventListener( 'blur', this._onBlur );
		this._document.removeEventListener( 'visibilitychange', this._onVisibilityChange, true );
		this._cancelSession( 'dispose', false );
	}

	public subscribe( listener: PointerListener ): () => void {
		this._listeners.add( listener );
		return () => this._listeners.delete( listener );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._cancelSession( 'dispose', true );
		this.detach();
		this._disposed = true;
		this._listeners.clear();
	}

	public get activePointerId(): number | null {
		return this._session?.pointerId ?? null;
	}

	private readonly _onPointerDown = ( event: PointerEvent ): void => {
		if ( this._session !== null ) {
			if ( event.pointerType === 'touch' && event.pointerId !== this._session.pointerId ) {
				this._cancelSession( 'second-pointer', true );
			}
			return;
		}
		const input = this._normalizePointer( event, 'down' );
		const claim = this._options.claim( input );
		const session: PointerSession = {
			pointerId: event.pointerId,
			owner: claim.owner,
			down: input,
			startModifiers: input.modifiers,
			currentModifiers: input.modifiers,
			claim,
			gesture: 'pending',
		};
		if ( claim.owner === 'editor' && claim.capture ) {
			try {
				session.lease = this._options.navigation.acquire( {
					owner: 'plot-editor',
					kind: leaseKindForClaim( claim ),
					pointerId: event.pointerId,
				} );
				this._canvas.setPointerCapture( event.pointerId );
				this._options.onCaptureChange?.( true );
			} catch ( error ) {
				session.lease?.release();
				this._options.onError?.( 'POINTER_CAPTURE_FAILED', error );
				this._options.onCancelOperation?.( 'pointercancel' );
				return;
			}
		}
		this._session = session;
		if ( claim.owner === 'editor'
			&& ( this._options.focusCanvasOnPrimaryDown ?? true )
			&& input.button === 'primary' ) {
			this._canvas.focus( { preventScroll: true } );
		}
		this._consumeIfClaimed( event, claim );
		this._emit( { input, owner: claim.owner, gesture: 'pending', startModifiers: input.modifiers } );
	};

	private readonly _onPointerMove = ( event: PointerEvent ): void => {
		const input = this._normalizePointer( event, 'move' );
		const session = this._session;
		if ( session === null || session.pointerId !== event.pointerId ) {
			this._scheduleMove( {
				input,
				owner: 'navigation',
				gesture: 'pending',
				startModifiers: input.modifiers,
			} );
			return;
		}
		session.currentModifiers = input.modifiers;
		const tolerance = input.device === 'touch'
			? this._options.touchClickToleranceCssPixels ?? 10
			: this._options.clickToleranceCssPixels ?? 6;
		if ( session.gesture !== 'dragging'
			&& Math.hypot(
				input.canvasX - session.down.canvasX,
				input.canvasY - session.down.canvasY,
			) > tolerance ) {
			session.gesture = 'dragging';
		}
		this._consumeIfClaimed( event, session.claim );
		this._scheduleMove( {
			input,
			owner: session.owner,
			gesture: session.gesture,
			startModifiers: session.startModifiers,
		} );
	};

	private readonly _onPointerUp = ( event: PointerEvent ): void => {
		const session = this._session;
		if ( session === null || session.pointerId !== event.pointerId ) return;
		this._flushPendingMove();
		const input = this._normalizePointer( event, 'up' );
		const tolerance = input.device === 'touch'
			? this._options.touchClickToleranceCssPixels ?? 10
			: this._options.clickToleranceCssPixels ?? 6;
		if ( session.gesture !== 'dragging'
			&& Math.hypot(
				input.canvasX - session.down.canvasX,
				input.canvasY - session.down.canvasY,
			) > tolerance ) {
			session.gesture = 'dragging';
		}
		const gesture = session.gesture === 'dragging' ? 'dragging' : 'click';
		this._consumeIfClaimed( event, session.claim );
		this._emit( {
			input,
			owner: session.owner,
			gesture,
			startModifiers: session.startModifiers,
		} );
		this._endSession( session, true );
	};

	private readonly _onPointerCancel = ( event: PointerEvent ): void => {
		this._cancelFromPointerEvent( event, 'cancel', 'pointercancel' );
	};

	private readonly _onLostPointerCapture = ( event: PointerEvent ): void => {
		this._cancelFromPointerEvent( event, 'lost-capture', 'lost-capture' );
	};

	private readonly _onDoubleClick = ( event: MouseEvent ): void => {
		const input = this._normalizePointer( event, 'double-click' );
		const claim = this._options.claim( input );
		this._consumeIfClaimed( event, claim );
		this._emit( {
			input,
			owner: claim.owner,
			gesture: 'click',
			startModifiers: input.modifiers,
		} );
	};

	private readonly _onContextMenu = ( event: MouseEvent ): void => {
		if ( this._session?.owner === 'editor' || this._options.shouldPreventContextMenu?.() ) {
			event.preventDefault();
		}
	};

	private readonly _onWheel = (): void => {
		// v1 滚轮完整交给 navigation；保留 capture listener 只为固定仲裁顺序。
	};

	private readonly _onBlur = ( event: Event ): void => {
		// 测试替身可能没有 target；真实 DOM 只接受 window 自身的 blur。
		if ( event.target !== null && event.target !== undefined && event.target !== this._window ) return;
		this._cancelSession( 'blur', true );
	};
	private readonly _onVisibilityChange = (): void => {
		if ( this._document.visibilityState === 'hidden' ) {
			this._cancelSession( 'hidden', true );
		}
	};

	private _cancelFromPointerEvent(
		event: PointerEvent,
		phase: 'cancel' | 'lost-capture',
		reason: 'pointercancel' | 'lost-capture',
	): void {
		const session = this._session;
		if ( session === null || session.pointerId !== event.pointerId ) return;
		this._clearPendingMove();
		const input = this._normalizePointer( event, phase );
		this._consumeIfClaimed( event, session.claim );
		this._emit( {
			input,
			owner: session.owner,
			gesture: 'ended',
			startModifiers: session.startModifiers,
		} );
		this._options.onCancelOperation?.( reason );
		this._endSession( session, phase !== 'lost-capture' );
	}

	private _cancelSession(
		reason: 'pointercancel' | 'lost-capture' | 'blur' | 'hidden' | 'dispose' | 'second-pointer',
		notify: boolean,
	): void {
		const session = this._session;
		this._clearPendingMove();
		if ( session === null ) return;
		if ( notify ) this._options.onCancelOperation?.( reason );
		this._endSession( session, true );
	}

	private _endSession( session: PointerSession, releaseCapture: boolean ): void {
		if ( this._session !== session ) return;
		this._session = null;
		session.gesture = 'ended';
		if ( releaseCapture && session.claim.owner === 'editor' && session.claim.capture ) {
			try {
				if ( this._canvas.hasPointerCapture( session.pointerId ) ) {
					this._canvas.releasePointerCapture( session.pointerId );
				}
			} catch {
				// capture 已由浏览器释放时无需再次报告业务错误。
			}
		}
		session.lease?.release();
		if ( session.claim.owner === 'editor' && session.claim.capture ) {
			this._options.onCaptureChange?.( false );
		}
	}

	private _scheduleMove( dispatch: PointerDispatch ): void {
		this._pendingMove = dispatch;
		if ( this._frameHandle !== null ) return;
		this._frameHandle = this._requestAnimationFrame( () => {
			this._frameHandle = null;
			this._flushPendingMove();
		} );
	}

	private _flushPendingMove(): void {
		// pointerup 会同步冲刷最后一次 move；此时取消已排队的空 RAF，避免残留回调。
		if ( this._frameHandle !== null ) {
			this._cancelAnimationFrame( this._frameHandle );
			this._frameHandle = null;
		}
		const pending = this._pendingMove;
		this._pendingMove = null;
		if ( pending !== null ) this._emit( pending );
	}

	private _clearPendingMove(): void {
		this._pendingMove = null;
		if ( this._frameHandle !== null ) {
			this._cancelAnimationFrame( this._frameHandle );
			this._frameHandle = null;
		}
	}

	private _emit( dispatch: PointerDispatch ): void {
		const frozen = Object.freeze( {
			...dispatch,
			startModifiers: Object.freeze( { ...dispatch.startModifiers } ),
		} );
		for ( const listener of [ ...this._listeners ] ) listener( frozen );
	}

	private _normalizePointer(
		event: PointerEvent | MouseEvent,
		phase: NormalizedPointerInput[ 'phase' ],
	): NormalizedPointerInput {
		const rect = this._canvas.getBoundingClientRect();
		const modifiers = modifiersFromMouseEvent(
			event,
			this._options.getKeyboardModifiers?.().space ?? false,
		);
		const pointerEvent = 'pointerId' in event ? event : undefined;
		return Object.freeze( {
			phase,
			pointerId: pointerEvent?.pointerId ?? -1,
			device: normalizeDevice( pointerEvent?.pointerType ?? 'mouse' ),
			button: normalizeButton( event.button ),
			buttons: event.buttons,
			canvasX: event.clientX - rect.left,
			canvasY: event.clientY - rect.top,
			clientX: event.clientX,
			clientY: event.clientY,
			movementX: finiteOrZero( event.movementX ),
			movementY: finiteOrZero( event.movementY ),
			pressure: finiteOrZero( pointerEvent?.pressure ?? 0 ),
			tiltX: finiteOrZero( pointerEvent?.tiltX ?? 0 ),
			tiltY: finiteOrZero( pointerEvent?.tiltY ?? 0 ),
			modifiers: Object.freeze( modifiers ),
			timeStamp: event.timeStamp,
			originalEvent: event,
		} );
	}

	private _consumeIfClaimed( event: Event, claim: PointerClaim ): void {
		if ( claim.owner === 'editor' && claim.preventDefault ) {
			event.preventDefault();
			event.stopPropagation();
		}
	}
}

function modifiersFromMouseEvent( event: MouseEvent, space: boolean ): ModifierState {
	const targetDocument = ( event.target as { ownerDocument?: Document } | null )
		?.ownerDocument;
	const platform = event.view?.navigator.platform
		?? targetDocument?.defaultView?.navigator.platform
		?? '';
	const isMac = /mac/i.test( platform );
	const altGraph = event.getModifierState?.( 'AltGraph' ) === true;
	return {
		shift: event.shiftKey,
		ctrl: event.ctrlKey,
		alt: event.altKey,
		meta: event.metaKey,
		primary: isMac ? event.metaKey : event.ctrlKey,
		altGraph,
		space,
	};
}

function normalizeDevice( pointerType: string ): PointerDevice {
	return pointerType === 'touch' || pointerType === 'pen' ? pointerType : 'mouse';
}

function normalizeButton( button: number ): PointerButton | null {
	switch ( button ) {
		case 0: return 'primary';
		case 1: return 'auxiliary';
		case 2: return 'secondary';
		case 5: return 'eraser';
		default: return null;
	}
}

function leaseKindForClaim( claim: PointerClaim ): NavigationLeaseKind {
	switch ( claim.reason ) {
		case 'draw': return 'draw';
		case 'handle': return 'handle-drag';
		case 'entity': return 'entity-drag';
		case 'box-select': return 'box-select';
		default: return 'gizmo';
	}
}

function finiteOrZero( value: number ): number {
	return Number.isFinite( value ) ? value : 0;
}

function validateTolerance( value: number, name: string ): void {
	if ( ! Number.isFinite( value ) || value < 0 ) {
		throw new RangeError( `${ name } 必须是非负有限数。` );
	}
}
