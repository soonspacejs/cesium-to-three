import { describe, expect, it, vi } from 'vitest';

import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { WorkingCopy } from '../../../src/lib/plot-editor/state/working-copy';

const style = {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
};

function circle( id: string, longitude = 0 ) {
	return {
		id,
		type: 'circle',
		geometry: { center: [ longitude, 30, 0 ], radius: 100 },
		style,
		heightReference: HeightReference.NONE,
		visible: true,
		properties: {},
		revision: 0,
	};
}

function moveCircle( longitude: number ) {
	return ( current: any ) => ( {
		...current,
		geometry: { ...current.geometry, center: [ longitude, 30, 0 ] },
	} );
}

describe( 'WorkingCopy', () => {
	it( '多帧 preview 不改文档，commit 只发送一次 document change', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const listener = vi.fn();
		document.subscribe( listener );
		const working = new WorkingCopy( document, [ 'a' ] );

		for ( const longitude of [ 1, 2, 3 ] ) {
			expect( working.update( 'a', moveCircle( longitude ) ).ok ).toBe( true );
			expect( document.revision ).toBe( 0 );
			expect( listener ).not.toHaveBeenCalled();
		}
		const preview = working.get( 'a' );
		if ( preview?.type !== 'circle' ) expect.fail( '应当保留 circle' );
		expect( preview.geometry.center ).toEqual( [ 3, 30, 0 ] );
		expect( preview.revision ).toBe( 1 );

		expect( working.commit( executor, history, '拖动圆心' ) ).toMatchObject( {
			ok: true, changed: true,
		} );
		expect( listener ).toHaveBeenCalledOnce();
		expect( document.revision ).toBe( 1 );
		expect( history.state.undoCount ).toBe( 1 );
		expect( working.closed ).toBe( true );
		history.undo();
		const restored = document.get( 'a' );
		if ( restored?.type !== 'circle' ) expect.fail( '应当保留 circle' );
		expect( restored.geometry.center ).toEqual( [ 0, 30, 0 ] );
	} );

	it( '多选候选通过一次原子 replace 提交', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ), circle( 'b', 10 ) ],
		} );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const listener = vi.fn();
		document.subscribe( listener );
		const working = new WorkingCopy( document, [ 'a', 'b' ] );
		working.update( 'a', moveCircle( 1 ) );
		working.update( 'b', moveCircle( 11 ) );
		working.commit( executor, history, '组平移' );
		expect( listener ).toHaveBeenCalledOnce();
		expect( listener ).toHaveBeenCalledWith( expect.objectContaining( {
			commandType: 'document.replace',
		} ) );
		expect( history.state.undoCount ).toBe( 1 );
		history.undo();
		const a = document.get( 'a' );
		const b = document.get( 'b' );
		if ( a?.type !== 'circle' || b?.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( a.geometry.center[ 0 ] ).toBe( 0 );
		expect( b.geometry.center[ 0 ] ).toBe( 10 );
	} );

	it( '非法 preview 保留上一次合法候选', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const working = new WorkingCopy( document, [ 'a' ] );
		expect( working.update( 'a', moveCircle( 1 ) ).ok ).toBe( true );
		const invalid = working.update( 'a', ( current: any ) => ( {
			...current,
			geometry: { ...current.geometry, radius: 0 },
		} ) );
		expect( invalid.ok ).toBe( false );
		const preview = working.get( 'a' );
		if ( preview?.type !== 'circle' ) expect.fail( '应当保留 circle' );
		expect( preview.geometry.center[ 0 ] ).toBe( 1 );
		expect( preview.geometry.radius ).toBe( 100 );
		expect( document.revision ).toBe( 0 );
	} );

	it( '外部 document revision 改变时拒绝提交并关闭候选', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ), circle( 'external', 10 ) ],
		} );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const working = new WorkingCopy( document, [ 'a' ] );
		working.update( 'a', moveCircle( 1 ) );
		executor.execute( {
			type: 'feature.patch', id: 'external', beforeRevision: 0, patch: { visible: false },
		} );
		const result = working.commit( executor, history );
		expect( result.error?.code ).toBe( 'REVISION_CONFLICT' );
		expect( working.closed ).toBe( true );
		const a = document.get( 'a' );
		if ( a?.type !== 'circle' ) expect.fail( '应当保留 circle' );
		expect( a.geometry.center[ 0 ] ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( 'cancel 幂等且不写文档，关闭后禁止更新', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const working = new WorkingCopy( document, [ 'a' ] );
		working.update( 'a', moveCircle( 1 ) );
		working.cancel();
		working.cancel();
		expect( document.revision ).toBe( 0 );
		expect( () => working.update( 'a', moveCircle( 2 ) ) ).toThrowError( /已结束/ );
	} );

	it( '创建时拒绝空选择和不存在的 id', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		expect( () => new WorkingCopy( document, [] ) ).toThrowError( /至少需要/ );
		expect( () => new WorkingCopy( document, [ 'missing' ] ) ).toThrowError( /不存在/ );
	} );
} );
