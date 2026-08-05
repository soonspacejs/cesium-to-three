import { Group, PerspectiveCamera, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlotEditor } from '../../src/lib/plot-editor/PlotEditor';
import { HeightReference } from '../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../src/lib/plot-editor/document/validate';
import type { NavigationAdapter, NavigationLease } from '../../src/lib/plot-editor/input/types';

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
	const root = new FakeEventHub() as FakeEventHub & HTMLElement;
	Object.assign( root, {
		ownerDocument: documentHub,
		tabIndex: -1,
		contains: ( node: unknown ) => node === root,
		focus: () => Object.assign( documentHub, { activeElement: root } ),
		blur: () => Object.assign( documentHub, { activeElement: null } ),
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
	return { root, canvas, window: windowHub };
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

function createEditor( options: { autoAttachInputs?: boolean; pick?: () => any } = {} ) {
	const { root, canvas, window } = createDom();
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
		autoAttachInputs: options.autoAttachInputs ?? false,
	} );
	return { editor, scene, requestRender, navigation, canvas, window };
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

	it( 'dispose 幂等地摘除 overlay 并归还导航资源', () => {
		const { editor, scene, navigation } = createEditor();
		expect( scene.children ).toHaveLength( 5 );

		editor.dispose();
		editor.dispose();

		expect( scene.children ).toHaveLength( 0 );
		expect( navigation.disposed ).toBe( true );
	} );
} );
