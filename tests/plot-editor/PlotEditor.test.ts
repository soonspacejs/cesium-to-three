import { Group, PerspectiveCamera, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlotEditor, type PlotEditorOptions } from '../../src/lib/plot-editor/PlotEditor';
import { HeightReference } from '../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../src/lib/plot-editor/document/validate';
import type {
	EditorKeymapOverrides,
	NavigationAdapter,
	NavigationLease,
} from '../../src/lib/plot-editor/input/types';

class FakeEventHub {
	public readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	public addEventListener( type: string, listener: EventListenerOrEventListenerObject | null ): void {
		if ( listener === null ) return;
		const values = this.listeners.get( type ) ?? new Set();
		values.add( listener );
		this.listeners.set( type, values );
	}
	public removeEventListener( type: string, listener: EventListenerOrEventListenerObject | null ): void {
		if ( listener !== null ) this.listeners.get( type )?.delete( listener );
	}
	public dispatch( type: string, event: Event ): void {
		for ( const listener of [ ...this.listeners.get( type ) ?? [] ] ) {
			if ( typeof listener === 'function' ) listener( event );
			else listener.handleEvent( event );
		}
	}
}

class NavigationStub implements NavigationAdapter {
	public enabled = true;
	public disposed = false;
	public acquire(): NavigationLease {
		let released = false;
		return {
			id: 'lease',
			get released() { return released; },
			release() { released = true; },
		};
	}
	public dispose(): void { this.disposed = true; }
}

class FakeTextarea extends FakeEventHub {
	public readonly tagName = 'TEXTAREA';
	public className = '';
	public value = '';
	public spellcheck = true;
	public readonly style: Record<string, string> = {};
	public readonly attributes = new Map<string, string>();
	public removed = false;
	public constructor( private readonly _document: Document ) { super(); }
	public setAttribute( name: string, value: string ): void { this.attributes.set( name, value ); }
	public getAttribute( name: string ): string | null { return this.attributes.get( name ) ?? null; }
	public focus(): void { Object.assign( this._document, { activeElement: this } ); }
	public setSelectionRange(): void {}
	public remove(): void { this.removed = true; }
}

function createDom() {
	const windowHub = new FakeEventHub() as FakeEventHub & Window;
	Object.assign( windowHub, {
		navigator: { platform: 'Win32' },
		requestAnimationFrame: ( callback: FrameRequestCallback ) => {
			callback( 0 );
			return 1;
		},
		cancelAnimationFrame: () => undefined,
	} );
	const documentHub = new FakeEventHub() as FakeEventHub & Document;
	Object.assign( documentHub, {
		defaultView: windowHub,
		activeElement: null,
		visibilityState: 'visible',
	} );
	const textareas: FakeTextarea[] = [];
	Object.assign( documentHub, {
		createElement: ( tag: string ) => {
			if ( tag !== 'textarea' ) throw new Error( `不支持的测试元素：${ tag }。` );
			const textarea = new FakeTextarea( documentHub );
			textareas.push( textarea );
			return textarea;
		},
	} );
	const root = new FakeEventHub() as FakeEventHub & HTMLElement;
	Object.assign( root, {
		ownerDocument: documentHub,
		tabIndex: -1,
		contains: ( node: unknown ) => node === root || textareas.includes( node as FakeTextarea ),
		focus: () => Object.assign( documentHub, { activeElement: root } ),
		blur: () => Object.assign( documentHub, { activeElement: null } ),
		appendChild: vi.fn(),
	} );
	const canvas = new FakeEventHub() as FakeEventHub & HTMLCanvasElement;
	Object.assign( canvas, {
		ownerDocument: documentHub,
		clientWidth: 800,
		clientHeight: 600,
		focus: () => Object.assign( documentHub, { activeElement: canvas } ),
		getBoundingClientRect: () => ( {
			left: 0, top: 0, width: 800, height: 600,
		} ),
		setPointerCapture: () => undefined,
		releasePointerCapture: () => undefined,
		hasPointerCapture: () => false,
	} );
	return { root, canvas, window: windowHub, document: documentHub, textareas };
}

function point( id: string ) {
	return normalizeFeature( {
		id,
		type: 'point',
		geometry: { position: [ 0, 0, 0 ] },
		style: {
			strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
			fillColor: '#08f', fillOpacity: 50,
			pointStyle: 'circle', size: 12,
		},
		heightReference: HeightReference.NONE,
		visible: true,
		properties: {},
		revision: 0,
	} );
}

function createEditor( options: {
	autoAttachInputs?: boolean;
	pick?: () => any;
	keymap?: EditorKeymapOverrides;
	idGenerator?: () => string;
	requestSave?: PlotEditorOptions[ 'requestSave' ];
} = {} ) {
	const { root, canvas, window, document, textareas } = createDom();
	const scene = new Group();
	const camera = new PerspectiveCamera( 60, 4 / 3, 1, 1e8 );
	camera.position.set( 6_379_137, 0, 0 );
	camera.lookAt( 0, 0, 0 );
	const requestRender = vi.fn();
	const navigation = new NavigationStub();
	const depthTexture = new Texture();
	const editor = new PlotEditor( {
		root,
		canvas,
		renderHost: {
			scene,
			camera,
			requestRender,
			getFrameState: () => ( {
				depthTexture,
				width: 800,
				height: 600,
				camera,
			} ),
		},
		surfacePicker: { pick: options.pick ?? ( () => null ) },
		cameraController: navigation,
		keymap: options.keymap,
		idGenerator: options.idGenerator,
		requestSave: options.requestSave,
		autoAttachInputs: options.autoAttachInputs ?? false,
	} );
	return {
		editor, scene, camera, requestRender, navigation, canvas, window, document, root, textareas,
	};
}

function pointerEvent(
	canvas: HTMLCanvasElement,
	window: Window,
	button: number,
	type: 'pointerdown' | 'pointerup',
): PointerEvent {
	return {
		type,
		target: canvas,
		view: window,
		pointerId: 1,
		pointerType: 'mouse',
		button,
		buttons: type === 'pointerdown' ? button === 0 ? 1 : 2 : 0,
		clientX: 400,
		clientY: 300,
		movementX: 0,
		movementY: 0,
		pressure: 0,
		tiltX: 0,
		tiltY: 0,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		timeStamp: 1,
		getModifierState: () => false,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as PointerEvent;
}

function keyboardEvent( target: EventTarget, key: string, code: string, primary = false ): KeyboardEvent {
	return {
		type: 'keydown', target, key, code, repeat: false,
		shiftKey: false, ctrlKey: primary, altKey: false, metaKey: false,
		isComposing: false, keyCode: 0,
		getModifierState: () => false,
		preventDefault: vi.fn(), stopPropagation: vi.fn(),
	} as unknown as KeyboardEvent;
}

function text( id: string ) {
	return normalizeFeature( {
		id, type: 'text', geometry: { position: [ 0, 0, 0 ] },
		style: {
			strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#000', fillOpacity: 0,
			content: '旧文本', fontColor: '#fff', fontSize: 14, scale: 1,
			textAlign: 'left', verticalAlign: 'top', anchorX: 'left', anchorY: 'top',
			padding: 0, layoutDirection: 'horizontal', rotation: 0,
			offsetX: 0, offsetY: 0, showBorder: false,
		},
		heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0,
	} );
}

describe( 'PlotEditor facade', () => {
	it( '命令、selection、history 和事件都经公共入口协调', () => {
		const { editor } = createEditor();
		const documentChanges = vi.fn();
		const historyChanges = vi.fn();
		const selectionChanges = vi.fn();
		editor.addEventListener( 'documentchange', documentChanges );
		editor.addEventListener( 'historystatechange', historyChanges );
		editor.addEventListener( 'selectionchange', selectionChanges );

		expect( editor.execute( { type: 'feature.add', feature: point( 'p' ) } ) ).toMatchObject( {
			ok: true, changed: true, revision: 1,
		} );
		editor.select( [ 'p' ] );
		expect( [ ...editor.selection ] ).toEqual( [ 'p' ] );
		expect( editor.canUndo ).toBe( true );
		expect( editor.undo() ).toMatchObject( { ok: true, changed: true } );
		expect( editor.document.has( 'p' ) ).toBe( false );
		expect( editor.redo() ).toMatchObject( { ok: true, changed: true } );
		expect( editor.document.has( 'p' ) ).toBe( true );
		expect( documentChanges ).toHaveBeenCalledTimes( 3 );
		expect( historyChanges ).toHaveBeenCalledTimes( 3 );
		expect( selectionChanges ).toHaveBeenCalled();
		editor.dispose();
	} );

	it( 'facade 的部分 keymap 覆盖保留未修改的默认命令', () => {
		const { editor, root } = createEditor( {
			autoAttachInputs: true,
			keymap: { 'document.save': [ { key: 'p', primary: true } ] },
		} );
		const save = vi.fn();
		editor.addEventListener( 'saverequest', save );
		editor.execute( { type: 'feature.add', feature: point( 'keymap-point' ) } );
		editor.focus();

		root.dispatch( 'keydown', keyboardEvent( root, 'Control', 'ControlLeft' ) );
		root.dispatch( 'keydown', keyboardEvent( root, 'p', 'KeyP', true ) );
		root.dispatch( 'keydown', keyboardEvent( root, 's', 'KeyS', true ) );
		expect( save ).toHaveBeenCalledOnce();
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ', true ) );
		expect( editor.document.has( 'keymap-point' ) ).toBe( false );
		editor.dispose();
	} );

	it( 'Primary+S 缺少宿主处理器时 blocked 并报告稳定诊断', () => {
		const { editor, root } = createEditor( { autoAttachInputs: true } );
		const validation = vi.fn();
		editor.addEventListener( 'validationerror', validation );
		editor.focus();

		root.dispatch( 'keydown', keyboardEvent( root, 'Control', 'ControlLeft' ) );
		const saveKey = keyboardEvent( root, 's', 'KeyS', true );
		root.dispatch( 'keydown', saveKey );

		expect( saveKey.preventDefault ).toHaveBeenCalledOnce();
		expect( saveKey.stopPropagation ).toHaveBeenCalledOnce();
		expect( validation ).toHaveBeenCalledOnce();
		expect( validation.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( {
			diagnostic: { code: 'SAVE_HANDLER_MISSING', severity: 'error' },
		} );
		editor.dispose();
	} );

	it( 'requestSave 回调与 saverequest 事件共享同一 revision 快照', () => {
		const requestSave = vi.fn();
		const { editor } = createEditor( { requestSave } );
		const saveEvent = vi.fn();
		editor.addEventListener( 'saverequest', saveEvent );
		editor.execute( { type: 'feature.add', feature: point( 'save-point' ) } );

		editor.requestSave();

		expect( saveEvent ).toHaveBeenCalledOnce();
		expect( saveEvent.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( { revision: 1 } );
		expect( requestSave ).toHaveBeenCalledOnce();
		expect( requestSave.mock.calls[ 0 ]?.[ 0 ] ).toEqual(
			saveEvent.mock.calls[ 0 ]?.[ 0 ].snapshot,
		);
		editor.dispose();
	} );

	it( '移除最后一个 saverequest listener 后直接保存报告处理器缺失', () => {
		const { editor } = createEditor();
		const save = vi.fn();
		const validation = vi.fn();
		editor.addEventListener( 'saverequest', save );
		editor.addEventListener( 'validationerror', validation );
		editor.removeEventListener( 'saverequest', save );

		editor.requestSave();

		expect( save ).not.toHaveBeenCalled();
		expect( validation.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( {
			diagnostic: { code: 'SAVE_HANDLER_MISSING' },
		} );
		editor.dispose();
	} );

	it( '贴地选择按 G/R/S 模式精确门禁 X/Y/Z 并报告 blocked 诊断', () => {
		const { editor, root } = createEditor( { autoAttachInputs: true } );
		const clampPoint = normalizeFeature( {
			...point( 'clamp-axis' ),
			heightReference: HeightReference.CLAMP_TO_GROUND,
		} );
		editor.execute( { type: 'feature.add', feature: clampPoint } );
		editor.select( [ clampPoint.id ] );
		const diagnostics: string[] = [];
		editor.addEventListener( 'validationerror', ( event ) => {
			diagnostics.push( event.diagnostic.code );
		} );
		editor.focus();
		const transformSession = () => ( editor as unknown as {
			_transform: { session: { axis?: string; mode: string } | null };
		} )._transform.session;

		root.dispatch( 'keydown', keyboardEvent( root, 'r', 'KeyR' ) );
		expect( transformSession()?.mode ).toBe( 'rotate' );
		root.dispatch( 'keydown', keyboardEvent( root, 'x', 'KeyX' ) );
		expect( transformSession()?.axis ).toBeUndefined();
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ' ) );
		expect( transformSession()?.axis ).toBe( 'up' );
		root.dispatch( 'keydown', keyboardEvent( root, 'Escape', 'Escape' ) );

		root.dispatch( 'keydown', keyboardEvent( root, 'g', 'KeyG' ) );
		expect( transformSession()?.mode ).toBe( 'translate' );
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ' ) );
		expect( transformSession()?.axis ).toBeUndefined();
		root.dispatch( 'keydown', keyboardEvent( root, 'x', 'KeyX' ) );
		expect( transformSession()?.axis ).toBe( 'east' );
		root.dispatch( 'keydown', keyboardEvent( root, 'Escape', 'Escape' ) );

		root.dispatch( 'keydown', keyboardEvent( root, 's', 'KeyS' ) );
		expect( transformSession()?.mode ).toBe( 'scale' );
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ' ) );
		expect( transformSession()?.axis ).toBeUndefined();
		root.dispatch( 'keydown', keyboardEvent( root, 'y', 'KeyY' ) );
		expect( transformSession()?.axis ).toBe( 'north' );
		expect( diagnostics ).toEqual( [
			'TRANSFORM_CAPABILITY_BLOCKED',
			'TRANSFORM_CAPABILITY_BLOCKED',
			'TRANSFORM_CAPABILITY_BLOCKED',
		] );
		editor.dispose();
	} );

	it( 'G 键释放后窗口失焦仍回滚无 held key 的活动变换事务', () => {
		const { editor, root, window } = createEditor( { autoAttachInputs: true } );
		const feature = point( 'blur-transform' );
		editor.execute( { type: 'feature.add', feature } );
		editor.select( [ feature.id ] );
		editor.focus();
		const transformSession = () => ( editor as unknown as {
			_transform: { session: { mode: string } | null };
		} )._transform.session;

		root.dispatch( 'keydown', keyboardEvent( root, 'g', 'KeyG' ) );
		root.dispatch( 'keyup', {
			...keyboardEvent( root, 'g', 'KeyG' ), type: 'keyup',
		} as KeyboardEvent );
		expect( transformSession()?.mode ).toBe( 'translate' );

		window.dispatch( 'blur', { target: window } as unknown as Event );

		expect( transformSession() ).toBeNull();
		editor.dispose();
	} );

	it( 'Up 指针变换使用相机射线轴参数，不依赖 surface picker 高度', () => {
		const pick = vi.fn( () => null );
		const { editor, root, camera } = createEditor( { autoAttachInputs: true, pick } );
		const feature = point( 'ray-axis-up' );
		editor.execute( { type: 'feature.add', feature } );
		editor.select( [ feature.id ] );
		editor.focus();
		camera.position.set( 6_379_137, 1_000, 1_000 );
		camera.lookAt( 6_378_137, 0, 0 );
		camera.updateMatrixWorld();

		root.dispatch( 'keydown', keyboardEvent( root, 'g', 'KeyG' ) );
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ' ) );
		const internals = editor as unknown as {
			_state: { activeTransaction?: { id: string } };
			_pointerTransactionStart: { screen: { x: number; y: number } } | null;
			_transformPreview: { features: readonly ReturnType<typeof point>[] } | null;
			_updatePointerTransaction(
				transactionId: string,
				screen: { x: number; y: number },
				modifiers: { shift: boolean; alt: boolean },
			): void;
		};
		const transactionId = internals._state.activeTransaction?.id;
		expect( transactionId ).toBeDefined();
		internals._pointerTransactionStart = { screen: { x: 400, y: 300 } };
		internals._updatePointerTransaction(
			transactionId!, { x: 400, y: 240 }, { shift: false, alt: false },
		);

		const preview = internals._transformPreview?.features[ 0 ];
		expect( preview?.type ).toBe( 'point' );
		if ( preview?.type !== 'point' ) expect.fail( '应生成 point Up 变换预览。' );
		expect( Math.abs( preview.geometry.position[ 2 ] ) ).toBeGreaterThan( 1 );
		expect( pick ).not.toHaveBeenCalled();
		editor.dispose();
	} );

	it( 'heading ring 使用射线旋转平面与连续角度更新整组 working preview', () => {
		const pick = vi.fn( () => null );
		const { editor, root, camera } = createEditor( { autoAttachInputs: true, pick } );
		const west = normalizeFeature( {
			...point( 'rotate-west' ), geometry: { position: [ -0.01, 0, 0 ] },
		} );
		const east = normalizeFeature( {
			...point( 'rotate-east' ), geometry: { position: [ 0.01, 0, 0 ] },
		} );
		editor.execute( { type: 'feature.add', feature: west } );
		editor.execute( { type: 'feature.add', feature: east } );
		editor.select( [ west.id, east.id ] );
		editor.focus();
		camera.position.set( 6_379_137, 1_000, 1_000 );
		camera.lookAt( 6_378_137, 0, 0 );
		camera.updateMatrixWorld();

		root.dispatch( 'keydown', keyboardEvent( root, 'r', 'KeyR' ) );
		root.dispatch( 'keydown', keyboardEvent( root, 'z', 'KeyZ' ) );
		const internals = editor as unknown as {
			_state: { activeTransaction?: { id: string } };
			_pointerTransactionStart: { screen: { x: number; y: number } } | null;
			_pointerRotationAccumulator: { unwrapped: number } | null;
			_transformPreview: { features: readonly ReturnType<typeof point>[] } | null;
			_updatePointerTransaction(
				transactionId: string,
				screen: { x: number; y: number },
				modifiers: { shift: boolean; alt: boolean },
			): void;
		};
		const transactionId = internals._state.activeTransaction?.id;
		expect( transactionId ).toBeDefined();
		internals._pointerTransactionStart = { screen: { x: 460, y: 300 } };
		internals._updatePointerTransaction(
			transactionId!, { x: 400, y: 240 }, { shift: false, alt: true },
		);

		expect( Math.abs( internals._pointerRotationAccumulator?.unwrapped ?? 0 ) )
			.toBeGreaterThan( 1 );
		const preview = internals._transformPreview?.features;
		expect( preview ).toHaveLength( 2 );
		expect( preview?.map( ( feature ) => feature.geometry ) )
			.not.toEqual( [ west.geometry, east.geometry ] );
		expect( pick ).not.toHaveBeenCalled();
		editor.dispose();
	} );

	it( '连续切换绘制工具不会让旧 session 的回滚取消新工具', () => {
		const { editor } = createEditor();
		const modes: string[] = [];
		editor.addEventListener( 'modechange', ( event ) => modes.push( event.mode ) );

		editor.activateTool( {
			type: 'line',
			heightReference: HeightReference.CLAMP_TO_GROUND,
		} );
		editor.activateTool( {
			type: 'polygon',
			heightReference: HeightReference.CLAMP_TO_GROUND,
		} );

		expect( editor.mode ).toBe( 'draw:polygon' );
		expect( modes ).toEqual( [ 'draw:line', 'draw:polygon' ] );
		editor.dispose();
	} );

	it( 'DOM pointer 经过 input、router 和状态机完成一次 point 原子提交', () => {
		const authorPosition = Object.freeze( [ 0, 0, 0 ] as const );
		const { editor, canvas, window } = createEditor( {
			autoAttachInputs: true,
			pick: () => Object.freeze( {
				authorPosition,
				surfacePosition: authorPosition,
				surface: 'ellipsoid' as const,
				heightReference: HeightReference.NONE,
			} ),
		} );
		editor.activateTool( 'point' );

		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 0, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 0, 'pointerup' ) );
		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 2, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 2, 'pointerup' ) );

		expect( editor.document.getAll() ).toHaveLength( 1 );
		expect( editor.document.getAll()[ 0 ] ).toMatchObject( {
			id: 'plot-1', type: 'point', geometry: { position: authorPosition },
		} );
		expect( editor.canUndo ).toBe( true );
		expect( editor.mode ).toBe( 'select' );
		editor.dispose();
	} );

	it( '绘制 add 失败保留 draft，并允许原 session 再次提交', () => {
		const authorPosition = Object.freeze( [ 0, 0, 0 ] as const );
		const idGenerator = vi.fn()
			.mockReturnValueOnce( 'existing' )
			.mockReturnValueOnce( 'retried' );
		const { editor, canvas, window } = createEditor( {
			autoAttachInputs: true,
			idGenerator,
			pick: () => Object.freeze( {
				authorPosition,
				surfacePosition: authorPosition,
				surface: 'ellipsoid' as const,
				heightReference: HeightReference.NONE,
			} ),
		} );
		const validationErrors = vi.fn();
		editor.addEventListener( 'validationerror', validationErrors );
		editor.execute( { type: 'feature.add', feature: point( 'existing' ) } );
		editor.activateTool( 'point' );

		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 0, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 0, 'pointerup' ) );
		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 2, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 2, 'pointerup' ) );

		expect( editor.mode ).toBe( 'draw:point' );
		expect( editor.document.getAll() ).toHaveLength( 1 );
		expect( validationErrors ).toHaveBeenLastCalledWith( expect.objectContaining( {
			diagnostic: expect.objectContaining( { code: 'DRAW_INVALID_PARAMETER' } ),
		} ) );

		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 2, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 2, 'pointerup' ) );

		expect( idGenerator ).toHaveBeenCalledTimes( 2 );
		expect( editor.document.getAll().map( ( feature ) => feature.id ) ).toEqual( [
			'existing', 'retried',
		] );
		expect( editor.mode ).toBe( 'select' );
		editor.dispose();
	} );

	it( 'DOM pointer 使用 ECEF/CSS 投影命中 canonical entity 并更新 selection', () => {
		const { editor, canvas, window } = createEditor( { autoAttachInputs: true } );
		editor.execute( { type: 'feature.add', feature: point( 'center-point' ) } );

		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 0, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 0, 'pointerup' ) );

		expect( [ ...editor.selection ] ).toEqual( [ 'center-point' ] );
		editor.dispose();
	} );

	it( 'text 首次命中自动进入 native draft，中文提交只产生一次 add history', () => {
		const authorPosition = Object.freeze( [ 116, 39, 0 ] as const );
		const { editor, canvas, window, textareas } = createEditor( {
			autoAttachInputs: true,
			pick: () => Object.freeze( {
				authorPosition,
				surfacePosition: authorPosition,
				surface: 'ellipsoid' as const,
				heightReference: HeightReference.NONE,
			} ),
		} );
		editor.activateTool( 'text' );
		canvas.dispatch( 'pointerdown', pointerEvent( canvas, window, 0, 'pointerdown' ) );
		canvas.dispatch( 'pointerup', pointerEvent( canvas, window, 0, 'pointerup' ) );

		expect( textareas ).toHaveLength( 1 );
		expect( editor.document.getAll() ).toHaveLength( 0 );
		const textarea = textareas[ 0 ];
		textarea.value = '现场中文';
		textarea.dispatch( 'input', { type: 'input', target: textarea } as Event );
		textarea.dispatch( 'keydown', keyboardEvent( textarea, 'Enter', 'Enter', true ) );

		expect( editor.document.getAll() ).toHaveLength( 1 );
		expect( editor.document.getAll()[ 0 ] ).toMatchObject( {
			type: 'text', style: { content: '现场中文' },
		} );
		expect( editor.mode ).toBe( 'select' );
		expect( editor.canUndo ).toBe( true );
		expect( textarea.removed ).toBe( true );
		editor.dispose();
	} );

	it( 'F2 与 native textarea 经状态机提交中文文本且只形成一次 history', () => {
		const { editor, root, textareas } = createEditor( { autoAttachInputs: true } );
		editor.execute( { type: 'feature.add', feature: text( 'label-a' ) } );
		editor.select( [ 'label-a' ] );
		editor.focus();

		root.dispatch( 'keydown', keyboardEvent( root, 'F2', 'F2' ) );
		expect( editor.mode ).toBe( 'text-edit' );
		expect( textareas ).toHaveLength( 1 );
		const textarea = textareas[ 0 ];
		textarea.value = '中文\n第二行';
		textarea.dispatch( 'input', { type: 'input', target: textarea } as Event );
		textarea.dispatch( 'keydown', keyboardEvent( textarea, 'Enter', 'Enter', true ) );

		expect( editor.document.get( 'label-a' )?.style ).toMatchObject( {
			content: '中文\n第二行',
		} );
		expect( editor.mode ).toBe( 'select' );
		expect( textarea.removed ).toBe( true );
		editor.dispose();
	} );

	it( 'dispose 幂等地摘除 overlay 并归还导航资源', () => {
		const { editor, scene, navigation } = createEditor();
		expect( scene.children ).toHaveLength( 5 );

		editor.dispose();
		editor.dispose();

		expect( scene.children ).toHaveLength( 0 );
		expect( navigation.disposed ).toBe( true );
	} );

	it( '连续 mount/dispose 100 次后 DOM listener、overlay root 与导航资源回到基线', () => {
		for ( let iteration = 0; iteration < 100; iteration++ ) {
			const { editor, scene, navigation, root, canvas, window, document } = createEditor( {
				autoAttachInputs: true,
			} );
			editor.dispose();

			expect( scene.children, `第 ${ iteration + 1 } 轮残留 overlay root` ).toHaveLength( 0 );
			expect( navigation.disposed, `第 ${ iteration + 1 } 轮未释放导航 adapter` ).toBe( true );
			for ( const hub of [ root, canvas, window, document ] ) {
				const listenerCount = [ ...hub.listeners.values() ].reduce(
					( total, listeners ) => total + listeners.size,
					0,
				);
				expect( listenerCount, `第 ${ iteration + 1 } 轮残留 DOM listener` ).toBe( 0 );
			}
		}
	} );
} );
