import { describe, expect, it, vi } from 'vitest';

import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import {
	HeightReference,
	type PlotFeature,
	type PlotFeatureType,
	type Position3D,
} from '../../../src/lib/plot-editor/document/types';

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

function allBuiltinFeatures(): readonly PlotFeature[] {
	const registry = createBuiltinGeometryAdapterRegistry();
	const cases: readonly {
		readonly type: PlotFeatureType;
		readonly heightReference: HeightReference;
		readonly points: readonly Position3D[];
		readonly text?: string;
	}[] = [
		{ type: 'point', heightReference: HeightReference.NONE, points: [ [ 0, 0, 11 ] ] },
		{ type: 'line', heightReference: HeightReference.CLAMP_TO_GROUND, points: [ [ 1, 0, 50 ], [ 1.01, 0, 60 ] ] },
		{ type: 'polygon', heightReference: HeightReference.RELATIVE_TO_GROUND, points: [ [ 2, 0, 12 ], [ 2.01, 0, 13 ], [ 2.01, 0.01, 14 ] ] },
		{ type: 'rectangle', heightReference: HeightReference.CLAMP_TO_TERRAIN, points: [ [ 3, 0, 70 ], [ 3.01, 0.01, 80 ] ] },
		{ type: 'sector', heightReference: HeightReference.RELATIVE_TO_TERRAIN, points: [ [ 4, 0, 15 ], [ 4.01, 0, 16 ], [ 4, 0.01, 17 ] ] },
		{ type: 'arrow', heightReference: HeightReference.CLAMP_TO_3D_TILE, points: [ [ 5, 0, 90 ], [ 5.01, 0.01, 100 ] ] },
		{ type: 'text', heightReference: HeightReference.RELATIVE_TO_3D_TILE, points: [ [ 6, 0, 18 ] ], text: '七值高度参考' },
		{ type: 'circle', heightReference: HeightReference.NONE, points: [ [ 7, 0, 19 ], [ 7.01, 0, 19 ] ] },
	];

	return cases.map( ( item, index ) => {
		const adapter = registry.require( item.type );
		let draft = adapter.begin( {
			type: item.type,
			heightReference: item.heightReference,
		} );
		for ( const point of item.points ) draft = adapter.addPoint( draft, point );
		if ( item.text !== undefined ) draft = adapter.setText?.( draft, item.text ) ?? draft;
		return adapter.finish( draft, {
			id: `shape-${ index }-${ item.type }`,
			properties: { matrixIndex: index },
		} );
	} );
}

describe( 'HistoryManager 基本撤销与重做', () => {
	it( 'add/undo/redo 保留原 id、order 和完整 feature', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const states: unknown[] = [];
		history.subscribe( ( state ) => states.push( state ) );

		expect( history.execute( executor, {
			type: 'feature.add', feature: circle( 'a' ) as never,
		} ) ).toMatchObject( { ok: true, changed: true } );
		expect( history.state ).toMatchObject( { canUndo: true, canRedo: false, undoCount: 1 } );
		expect( history.undo() ).toMatchObject( { ok: true, changed: true } );
		expect( document.has( 'a' ) ).toBe( false );
		expect( history.state ).toMatchObject( { canUndo: false, canRedo: true } );
		expect( history.redo() ).toMatchObject( { ok: true, changed: true } );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'a' ] );
		expect( document.get( 'a' ) ).toMatchObject( circle( 'a' ) );
		expect( states ).toHaveLength( 3 );
	} );

	it( '八类图形与七值高度参考跨完整 undo/redo 保留逐值数据和顺序', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const features = allBuiltinFeatures();
		for ( const feature of features ) {
			expect( history.execute( executor, {
				type: 'feature.add', feature,
			} ) ).toMatchObject( { ok: true, changed: true } );
		}
		const committed = document.getAll();
		expect( committed.map( ( feature ) => feature.heightReference ) ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 0 ] );

		for ( let index = 0; index < features.length; index++ ) {
			expect( history.undo() ).toMatchObject( { ok: true, changed: true } );
		}
		expect( document.getAll() ).toEqual( [] );
		for ( let index = 0; index < features.length; index++ ) {
			expect( history.redo() ).toMatchObject( { ok: true, changed: true } );
		}
		expect( document.getAll() ).toEqual( committed );
		expect( document.getAll().map( ( feature ) => feature.id ) )
			.toEqual( features.map( ( feature ) => feature.id ) );
	} );

	it( '批量删除一次 undo 恢复原顺序', () => {
		const document = createPlotDocumentStore( {
			id: 'document',
			features: [ circle( 'a' ), circle( 'b', 1 ), circle( 'c', 2 ) ],
			order: [ 'c', 'a', 'b' ],
		} );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		history.execute( executor, { type: 'feature.remove', ids: [ 'a', 'c' ] } );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'b' ] );
		history.undo();
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'c', 'a', 'b' ] );
		expect( document.get( 'a' )?.revision ).toBe( 0 );
		expect( document.get( 'c' )?.revision ).toBe( 0 );
	} );

	it( '失败命令和成功 no-op 都不进入历史', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		expect( history.execute( executor, {
			type: 'feature.remove', ids: [ 'missing' ],
		} ).ok ).toBe( false );
		expect( history.execute( executor, {
			type: 'feature.remove', ids: [],
		} ).changed ).toBe( false );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( 'document.replace 的 metadata 与 feature/order 一样参与 undo/redo', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ) ], metadata: { phase: 'before' },
		} );
		const replacement = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'b' ) ], metadata: { phase: 'after', count: 2 },
		} ).snapshot();
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		expect( history.execute( executor, {
			type: 'document.replace', snapshot: replacement,
		} ).ok ).toBe( true );
		expect( document.snapshot().metadata ).toEqual( { phase: 'after', count: 2 } );
		history.undo();
		expect( document.snapshot().metadata ).toEqual( { phase: 'before' } );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'a' ] );
		history.redo();
		expect( document.snapshot().metadata ).toEqual( { phase: 'after', count: 2 } );
	} );

	it( '仅替换 metadata 也生成可撤销的历史条目', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ) ], metadata: { phase: 'before' },
		} );
		const replacement = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ) ], metadata: { phase: 'after' },
		} ).snapshot();
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );

		expect( history.execute( executor, {
			type: 'document.replace', snapshot: replacement,
		} ) ).toMatchObject( { ok: true, changed: true, affectedIds: [] } );
		expect( history.state.undoCount ).toBe( 1 );
		expect( document.snapshot().metadata ).toEqual( { phase: 'after' } );

		expect( history.undo() ).toMatchObject( { ok: true, changed: true, affectedIds: [] } );
		expect( document.snapshot().metadata ).toEqual( { phase: 'before' } );
		expect( history.redo() ).toMatchObject( { ok: true, changed: true, affectedIds: [] } );
		expect( document.snapshot().metadata ).toEqual( { phase: 'after' } );
	} );
} );

describe( '连续事务、回滚与合并', () => {
	it( '多次 working 命令只生成一条历史', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const transaction = history.begin( '连续拖拽', 'drag:a' );
		expect( history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 0,
			patch: { geometry: { center: [ 1, 30, 0 ] } },
		}, transaction ).ok ).toBe( true );
		expect( history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 1,
			patch: { geometry: { center: [ 2, 30, 0 ] } },
		}, transaction ).ok ).toBe( true );
		expect( history.commit( transaction ).changed ).toBe( true );
		expect( history.state.undoCount ).toBe( 1 );
		expect( document.get( 'a' )?.revision ).toBe( 2 );
		history.undo();
		const restored = document.get( 'a' );
		if ( restored?.type !== 'circle' ) expect.fail( '应当保留 circle' );
		expect( restored.geometry.center ).toEqual( [ 0, 30, 0 ] );
		expect( restored.revision ).toBe( 0 );
	} );

	it( 'rollback 恢复事务前逐值状态且不增加 history', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const beforeFeature = document.get( 'a' );
		const transaction = history.begin( '取消属性修改' );
		history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 0,
			patch: { visible: false, style: { fillOpacity: 1 } },
		}, transaction );
		history.rollback( transaction );
		expect( document.get( 'a' ) ).toEqual( beforeFeature );
		expect( history.state.undoCount ).toBe( 0 );
		expect( transaction.closed ).toBe( true );
	} );

	it( '相同 mergeKey 和 feature 集合合并，独立 key 不合并', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );

		const first = history.begin( '方向键微调', 'held-key:a:east' );
		history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 0,
			patch: { geometry: { center: [ 1, 30, 0 ] } },
		}, first );
		history.commit( first );
		const second = history.begin( '方向键微调', 'held-key:a:east' );
		history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 1,
			patch: { geometry: { center: [ 2, 30, 0 ] } },
		}, second );
		history.commit( second );
		expect( history.state.undoCount ).toBe( 1 );

		const independent = history.begin( '鼠标拖拽', 'pointer-drag:2' );
		history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 2,
			patch: { geometry: { center: [ 3, 30, 0 ] } },
		}, independent );
		history.commit( independent );
		expect( history.state.undoCount ).toBe( 2 );
	} );

	it( '活动或已关闭 transaction 的非法操作被拒绝', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const history = new HistoryManager( document );
		const transaction = history.begin( '活动事务' );
		expect( history.undo().error?.code ).toBe( 'TRANSACTION_CLOSED' );
		expect( () => history.begin( '嵌套事务' ) ).toThrowError();
		history.commit( transaction );
		expect( () => history.commit( transaction ) ).toThrowError();
	} );
} );

describe( 'redo 分支、冲突与容量限制', () => {
	it( 'undo 后提交新命令会清空 redo', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		history.execute( executor, { type: 'feature.add', feature: circle( 'a' ) as never } );
		history.undo();
		expect( history.canRedo ).toBe( true );
		history.execute( executor, { type: 'feature.add', feature: circle( 'b' ) as never } );
		expect( history.canRedo ).toBe( false );
	} );

	it( 'undo 后执行成功 no-op 不会清空 redo', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		history.execute( executor, { type: 'feature.add', feature: circle( 'a' ) as never } );
		history.undo();

		expect( history.execute( executor, {
			type: 'feature.remove', ids: [],
		} ) ).toMatchObject( { ok: true, changed: false } );
		expect( history.state ).toMatchObject( { undoCount: 0, redoCount: 1, canRedo: true } );
		expect( history.redo() ).toMatchObject( { ok: true, changed: true } );
		expect( document.getAll().map( ( feature ) => feature.id ) ).toEqual( [ 'a' ] );
	} );

	it( '外部直接修改目标后拒绝覆盖式 undo', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		history.execute( executor, {
			type: 'feature.patch', id: 'a', beforeRevision: 0, patch: { visible: false },
		} );
		executor.execute( {
			type: 'feature.patch', id: 'a', beforeRevision: 1, patch: { visible: true },
		} );
		expect( history.undo().error?.code ).toBe( 'REVISION_CONFLICT' );
		expect( document.get( 'a' )?.revision ).toBe( 2 );
	} );

	it( '同时执行条目上限和字节估算，并至少保留最新一条', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document, { maxEntries: 2, maxBytes: 1 } );
		for ( const id of [ 'a', 'b', 'c' ] ) {
			history.execute( executor, { type: 'feature.add', feature: circle( id ) as never } );
		}
		expect( history.state.undoCount ).toBe( 1 );
		expect( history.state.estimatedBytes ).toBeGreaterThan( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.has( 'c' ) ).toBe( false );
	} );

	it( 'clear 清空双栈并发送状态事件', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const history = new HistoryManager( document );
		const listener = vi.fn();
		history.subscribe( listener );
		history.execute( executor, { type: 'feature.add', feature: circle( 'a' ) as never } );
		history.undo();
		history.clear();
		expect( history.state ).toMatchObject( {
			canUndo: false, canRedo: false, undoCount: 0, redoCount: 0, estimatedBytes: 0,
		} );
		expect( listener ).toHaveBeenCalledTimes( 3 );
	} );
} );
