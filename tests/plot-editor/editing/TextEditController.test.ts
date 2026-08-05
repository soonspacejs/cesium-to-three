import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { TextEditController } from '../../../src/lib/plot-editor/editing/TextEditController';

class FakeTextarea {
	public className = '';
	public value = '';
	public spellcheck = true;
	public readonly style: Record<string, string> = {};
	public readonly attributes = new Map<string, string>();
	public removed = false;
	private readonly _listeners = new Map<string, Set<EventListener>>();
	public setAttribute( name: string, value: string ): void { this.attributes.set( name, value ); }
	public addEventListener( type: string, listener: EventListener ): void {
		const values = this._listeners.get( type ) ?? new Set();
		values.add( listener );
		this._listeners.set( type, values );
	}
	public removeEventListener( type: string, listener: EventListener ): void {
		this._listeners.get( type )?.delete( listener );
	}
	public dispatch( type: string, event: unknown = {} ): void {
		for ( const listener of [ ...this._listeners.get( type ) ?? [] ] ) listener( event as Event );
	}
	public focus(): void {}
	public setSelectionRange(): void {}
	public remove(): void { this.removed = true; }
}

function textFeature() {
	return normalizeFeature( {
		id: 'text-a',
		type: 'text',
		geometry: { position: [ 116, 39, 0 ] },
		style: {
			strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#000', fillOpacity: 0,
			content: '初始', fontColor: '#fff', fontSize: 14, scale: 1,
			textAlign: 'left', verticalAlign: 'top', anchorX: 'left', anchorY: 'top',
			padding: 0, layoutDirection: 'horizontal', rotation: 0,
			offsetX: 0, offsetY: 0, showBorder: false,
		},
		heightReference: HeightReference.NONE,
		visible: true,
		properties: {},
		revision: 0,
	} );
}

function createController() {
	const textarea = new FakeTextarea();
	const root = {
		ownerDocument: { createElement: () => textarea },
		appendChild: vi.fn(),
	} as unknown as HTMLElement;
	const document = createPlotDocumentStore( { id: 'doc', features: [ textFeature() ] } );
	const executor = new CommandExecutor( document );
	const history = new HistoryManager( document );
	const onPreviewChange = vi.fn();
	const onCommitRequest = vi.fn();
	const onCancelRequest = vi.fn();
	const controller = new TextEditController( {
		root,
		document,
		executor,
		history,
		onPreviewChange,
		onCommitRequest,
		onCancelRequest,
	} );
	return {
		controller, textarea, document, history,
		onPreviewChange, onCommitRequest, onCancelRequest,
	};
}

function keyEvent( key: string, patch: Record<string, unknown> = {} ) {
	return {
		key,
		keyCode: 0,
		isComposing: false,
		ctrlKey: false,
		metaKey: false,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		...patch,
	};
}

describe( 'TextEditController', () => {
	it( '使用 native textarea 保留 Enter 换行并正确保护中文 composition', () => {
		const value = createController();
		expect( value.controller.begin( 'text-a', { x: 30, y: 40 } ) ).toBe( true );
		expect( value.textarea.value ).toBe( '初始' );
		expect( value.textarea.style.left ).toBe( '30px' );

		value.textarea.dispatch( 'keydown', keyEvent( 'Enter' ) );
		expect( value.onCommitRequest ).not.toHaveBeenCalled();
		value.textarea.dispatch( 'compositionstart' );
		value.textarea.value = '中文输入';
		value.textarea.dispatch( 'input' );
		value.textarea.dispatch( 'keydown', keyEvent( 'Enter', { ctrlKey: true } ) );
		expect( value.onCommitRequest ).not.toHaveBeenCalled();
		value.textarea.dispatch( 'compositionend' );
		value.textarea.dispatch( 'keydown', keyEvent( 'Enter', { ctrlKey: true } ) );
		expect( value.onCommitRequest ).toHaveBeenCalledOnce();
		expect( value.onPreviewChange ).toHaveBeenLastCalledWith( expect.objectContaining( {
			style: expect.objectContaining( { content: '中文输入' } ),
		} ) );
	} );

	it( 'commit 只写一次 patch/history，cancel 完全不写文档', () => {
		const value = createController();
		value.controller.begin( 'text-a' );
		value.textarea.value = '第一行\n第二行';
		value.textarea.dispatch( 'input' );
		const result = value.controller.commit();

		expect( result ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( value.document.get( 'text-a' )?.style ).toMatchObject( {
			content: '第一行\n第二行',
		} );
		expect( value.history.canUndo ).toBe( true );
		expect( value.textarea.removed ).toBe( true );

		const second = createController();
		second.controller.begin( 'text-a' );
		second.textarea.value = '不会提交';
		second.controller.cancel();
		expect( second.document.revision ).toBe( 0 );
		expect( second.document.get( 'text-a' )?.style ).toMatchObject( { content: '初始' } );
	} );

	it( 'Escape 请求取消，blur 请求提交且 close 时不会递归提交', () => {
		const value = createController();
		value.controller.begin( 'text-a' );
		value.textarea.dispatch( 'keydown', keyEvent( 'Escape' ) );
		expect( value.onCancelRequest ).toHaveBeenCalledOnce();
		value.textarea.dispatch( 'blur' );
		expect( value.onCommitRequest ).toHaveBeenCalledOnce();
		value.controller.cancel();
		value.textarea.dispatch( 'blur' );
		expect( value.onCommitRequest ).toHaveBeenCalledOnce();
	} );
} );
