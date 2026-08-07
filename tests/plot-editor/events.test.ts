import { describe, expect, it, vi } from 'vitest';
import { PlotEditorEventDispatcher } from '../../src/lib/plot-editor/events';

describe( 'PlotEditorEventDispatcher', () => {
	it( '按注册顺序同步分发冻结事件，重复 listener 只保留一份', () => {
		const dispatcher = new PlotEditorEventDispatcher();
		const order: number[] = [];
		const first = vi.fn( ( event ) => {
			order.push( 1 );
			expect( event ).toMatchObject( { type: 'selectionchange' } );
			expect( Object.isFrozen( event ) ).toBe( true );
		} );
		const second = vi.fn( () => order.push( 2 ) );
		dispatcher.addEventListener( 'selectionchange', first );
		dispatcher.addEventListener( 'selectionchange', first );
		dispatcher.addEventListener( 'selectionchange', second );
		dispatcher.dispatch( 'selectionchange', { selection: { ids: [] } } );
		expect( order ).toEqual( [ 1, 2 ] );
		expect( first ).toHaveBeenCalledOnce();
	} );

	it( '单个 listener 异常不阻断其余 listener，异步报告错误', async () => {
		const onListenerError = vi.fn();
		const dispatcher = new PlotEditorEventDispatcher( { onListenerError } );
		const next = vi.fn();
		dispatcher.addEventListener( 'modechange', () => { throw new Error( 'boom' ); } );
		dispatcher.addEventListener( 'modechange', next );
		dispatcher.dispatch( 'modechange', { previousMode: 'select', mode: 'transform' } );
		expect( next ).toHaveBeenCalledOnce();
		expect( onListenerError ).not.toHaveBeenCalled();
		await Promise.resolve();
		expect( onListenerError ).toHaveBeenCalledWith( expect.any( Error ), 'modechange' );
	} );

	it( 'remove 与 dispose 幂等，销毁后不再分发', () => {
		const dispatcher = new PlotEditorEventDispatcher();
		const listener = vi.fn();
		expect( dispatcher.hasListeners( 'historystatechange' ) ).toBe( false );
		dispatcher.addEventListener( 'historystatechange', listener );
		expect( dispatcher.hasListeners( 'historystatechange' ) ).toBe( true );
		dispatcher.removeEventListener( 'historystatechange', listener );
		expect( dispatcher.hasListeners( 'historystatechange' ) ).toBe( false );
		dispatcher.dispatch( 'historystatechange', {
			canUndo: false, canRedo: false, undoCount: 0, redoCount: 0, estimatedBytes: 0,
		} );
		expect( listener ).not.toHaveBeenCalled();
		dispatcher.dispose();
		dispatcher.dispose();
		expect( dispatcher.hasListeners( 'historystatechange' ) ).toBe( false );
		expect( () => dispatcher.addEventListener( 'historystatechange', listener ) ).toThrow( /已销毁/ );
	} );
} );
