import { describe, expect, it, vi } from 'vitest';

import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

function circle( id: string, longitude: number ) {
	return {
		id,
		type: 'circle',
		geometry: { center: [ longitude, 30, 0 ], radius: 100 },
		style: {
			strokeColor: '#ffffff',
			strokeWidth: 2,
			strokeOpacity: 100,
			fillColor: '#3388ff',
			fillOpacity: 50,
		},
		heightReference: HeightReference.CLAMP_TO_GROUND,
		visible: true,
		properties: { group: 'test' },
		revision: 0,
	};
}

describe( 'PlotDocument 只读视图', () => {
	it( '按显式 order 返回深冻结 feature 和确定性快照', () => {
		const document = createPlotDocumentStore( {
			id: 'document-1',
			features: [ circle( 'a', 120 ), circle( 'b', 121 ) ],
			order: [ 'b', 'a' ],
			metadata: { locale: 'zh-CN' },
		} );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'b', 'a' ] );
		expect( document.get( 'missing' ) ).toBeUndefined();
		expect( document.has( 'a' ) ).toBe( true );
		expect( document.snapshot() ).toEqual( {
			schema: 'cesium-to-three/plot-document',
			version: 1,
			documentId: 'document-1',
			revision: 0,
			features: document.getAll(),
			order: [ 'b', 'a' ],
			metadata: { locale: 'zh-CN' },
		} );
		expect( Object.isFrozen( document.get( 'a' ) ) ).toBe( true );
		expect( Object.isFrozen( document.get( 'a' )?.geometry ) ).toBe( true );
		expect( Object.isFrozen( document.snapshot().order ) ).toBe( true );
	} );

	it.each( [
		[ '重复 feature id', {
			id: 'document', features: [ circle( 'a', 0 ), circle( 'a', 1 ) ],
		} ],
		[ '重复 order id', {
			id: 'document', features: [ circle( 'a', 0 ), circle( 'b', 1 ) ], order: [ 'a', 'a' ],
		} ],
		[ '缺少 order id', {
			id: 'document', features: [ circle( 'a', 0 ), circle( 'b', 1 ) ], order: [ 'a' ],
		} ],
		[ '未知 order id', {
			id: 'document', features: [ circle( 'a', 0 ) ], order: [ 'missing' ],
		} ],
	] )( '拒绝%s', ( _name, options ) => {
		expect( () => createPlotDocumentStore( options ) ).toThrowError();
	} );
} );

describe( 'PlotDocument 原子提交与事件', () => {
	it( '一次候选提交只递增一次 revision 并同步通知', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a', 0 ) ],
		} );
		const listener = vi.fn();
		const unsubscribe = document.subscribe( listener );
		const changed = document.commitCandidate( {
			features: [ document.get( 'a' )!, circle( 'b', 1 ) as never ],
			order: [ 'a', 'b' ],
			label: '添加圆',
			commandType: 'feature.add',
			affectedIds: [ 'b' ],
		} );
		expect( changed ).toBe( true );
		expect( document.revision ).toBe( 1 );
		expect( listener ).toHaveBeenCalledOnce();
		expect( listener ).toHaveBeenCalledWith( {
			previousRevision: 0,
			revision: 1,
			label: '添加圆',
			commandType: 'feature.add',
			affectedIds: [ 'b' ],
		} );
		unsubscribe();
		document.commitCandidate( {
			features: [ document.get( 'a' )!, document.get( 'b' )! ],
			order: [ 'b', 'a' ],
			label: '重排',
			commandType: 'feature.reorder',
			affectedIds: [ 'a', 'b' ],
		} );
		expect( listener ).toHaveBeenCalledOnce();
	} );

	it( '空候选提交不改变 revision 或发送事件', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a', 0 ) ],
		} );
		const listener = vi.fn();
		document.subscribe( listener );
		expect( document.commitCandidate( {
			features: document.getAll() as never,
			order: [ 'a' ],
			label: '空事务',
			commandType: 'noop',
			affectedIds: [],
		} ) ).toBe( false );
		expect( document.revision ).toBe( 0 );
		expect( listener ).not.toHaveBeenCalled();
	} );

	it( '候选中任一 feature 非法时整个文档保持不变', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a', 0 ) ],
		} );
		const before = document.snapshot();
		const invalid = circle( 'b', 1 );
		invalid.geometry.radius = 0;
		expect( () => document.commitCandidate( {
			features: [ document.get( 'a' )!, invalid as never ],
			order: [ 'a', 'b' ],
			label: '非法批量',
			commandType: 'feature.add',
			affectedIds: [ 'b' ],
		} ) ).toThrowError();
		expect( document.snapshot() ).toEqual( before );
		expect( document.revision ).toBe( 0 );
	} );

	it( '单个 listener 抛错不阻止其他 listener，并异步交给错误处理器', async () => {
		const onListenerError = vi.fn();
		const document = createPlotDocumentStore( {
			id: 'document',
			features: [],
			onListenerError,
		} );
		const second = vi.fn();
		document.subscribe( () => {
			throw new Error( 'listener failed' );
		} );
		document.subscribe( second );
		document.commitCandidate( {
			features: [ circle( 'a', 0 ) as never ],
			order: [ 'a' ],
			label: '添加',
			commandType: 'feature.add',
			affectedIds: [ 'a' ],
		} );
		expect( second ).toHaveBeenCalledOnce();
		expect( onListenerError ).not.toHaveBeenCalled();
		await new Promise<void>( ( resolve ) => queueMicrotask( resolve ) );
		expect( onListenerError ).toHaveBeenCalledOnce();
	} );
} );
