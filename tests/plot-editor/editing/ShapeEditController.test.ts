import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { isHeightReferenceClamp } from '../../../src/lib/plot-editor/document/height-reference';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { ShapeEditController } from '../../../src/lib/plot-editor/editing/ShapeEditController';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );

function line(
	id: string,
	points: readonly ( readonly [ number, number, number ] )[],
	heightReference = HeightReference.NONE,
): PlotFeature {
	return normalizeFeature( {
		id, type: 'line', geometry: { positions: points },
		style: {
			...STYLE, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null,
		},
		heightReference, visible: true, properties: {}, revision: 0,
	} );
}

function polygon( id: string ): PlotFeature {
	return normalizeFeature( {
		id, type: 'polygon',
		geometry: { positions: [ [ 0, 0, 0 ], [ 2, 0, 0 ], [ 2, 2, 0 ], [ 0, 2, 0 ] ] },
		style: STYLE,
		heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0,
	} );
}

function circle( id: string, longitude = 0 ): PlotFeature {
	return normalizeFeature( {
		id, type: 'circle', geometry: { center: [ longitude, 30, 0 ], radius: 100 },
		style: STYLE,
		heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0,
	} );
}

function setup( features: readonly PlotFeature[] ) {
	const document = createPlotDocumentStore( { id: 'edit-test', features } );
	const executor = new CommandExecutor( document );
	const history = new HistoryManager( document );
	const onPreviewChange = vi.fn();
	const controller = new ShapeEditController( {
		document, executor, history,
		adapters: createBuiltinGeometryAdapterRegistry(),
		createTransactionId: () => 'tx-fixed',
		onPreviewChange,
	} );
	return { document, executor, history, controller, onPreviewChange };
}

describe( 'ShapeEditController drag transaction', () => {
	it.each( Object.values( HeightReference ) )(
		'heightReference=%s 的 vertex 编辑保持对应作者高度策略并可撤销',
		( heightReference ) => {
			const initialHeight = isHeightReferenceClamp( heightReference ) ? 0 : 10;
			const { document, controller, history } = setup( [
				line( 'line', [ [ 0, 0, initialHeight ], [ 1, 0, initialHeight ] ], heightReference ),
			] );
			const before = document.get( 'line' );
			expect( controller.begin( 'line', 'vertex:1' ).ok ).toBe( true );
			expect( controller.update( { authorPosition: [ 1, 0.5, 999 ] } ).ok ).toBe( true );
			expect( controller.commit().ok ).toBe( true );
			const edited = document.get( 'line' );
			if ( edited?.type !== 'line' ) expect.fail( '应保留 line 类型' );
			expect( edited.heightReference ).toBe( heightReference );
			expect( edited.geometry.positions[ 1 ] ).toEqual( [
				1, 0.5, isHeightReferenceClamp( heightReference ) ? 0 : 999,
			] );
			expect( history.undo().ok ).toBe( true );
			expect( document.get( 'line' ) ).toEqual( before );
		},
	);

	it( '100 次 pointermove 不写文档，commit 只增加一个 revision/history', () => {
		const { document, history, controller } = setup( [ circle( 'circle' ) ] );
		const before = document.snapshot();
		expect( controller.begin( 'circle', 'center' ) ).toMatchObject( {
			ok: true, preview: { transactionId: 'tx-fixed', activeHandleId: 'center' },
		} );
		for ( let index = 1; index <= 100; index++ ) {
			expect( controller.update( {
				authorPosition: [ index / 100, 30, 0 ],
			} ).ok ).toBe( true );
			expect( document.revision ).toBe( before.revision );
			expect( history.state.undoCount ).toBe( 0 );
		}
		expect( controller.commit() ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( history.state.undoCount ).toBe( 1 );
		const edited = document.get( 'circle' );
		if ( edited?.type !== 'circle' ) expect.fail( '应保留 circle 类型' );
		expect( edited.geometry.center[ 0 ] ).toBeCloseTo( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.snapshot().features ).toEqual( before.features );
	} );

	it( 'cancel、surface miss、dispose 均回滚且清空 preview，调用幂等', () => {
		const { document, history, controller, onPreviewChange } = setup( [ circle( 'circle' ) ] );
		const before = document.snapshot();
		controller.begin( 'circle', 'center' );
		controller.update( { authorPosition: [ 1, 30, 0 ] } );
		expect( controller.update( null ) ).toMatchObject( {
			ok: false, error: { code: 'EDIT_SURFACE_MISS' },
			preview: { committable: false },
		} );
		expect( controller.commit() ).toMatchObject( {
			ok: false, error: { code: 'EDIT_SURFACE_MISS' },
		} );
		expect( document.snapshot() ).toEqual( before );
		expect( history.state.undoCount ).toBe( 0 );

		controller.begin( 'circle', 'center' );
		controller.update( { authorPosition: [ 2, 30, 0 ] } );
		controller.cancel();
		controller.cancel();
		controller.dispose();
		controller.dispose();
		expect( document.snapshot() ).toEqual( before );
		expect( onPreviewChange ).toHaveBeenLastCalledWith( null );
		expect( controller.begin( 'circle', 'center' ).error?.code ).toBe( 'EDITOR_DISPOSED' );
	} );

	it( 'midpoint 只在首次有效 move 插入一次，随后提升为新 vertex', () => {
		const { document, controller, history } = setup( [
			line( 'line', [ [ 0, 0, 0 ], [ 2, 0, 0 ] ] ),
		] );
		controller.begin( 'line', 'midpoint:0' );
		const first = controller.update( { authorPosition: [ 1, 0.1, 0 ] } );
		expect( first.preview ).toMatchObject( {
			originalHandleId: 'midpoint:0', activeHandleId: 'vertex:1',
		} );
		for ( const latitude of [ 0.2, 0.3, 0.4 ] ) {
			const result = controller.update( { authorPosition: [ 1, latitude, 0 ] } );
			if ( result.preview?.feature.type !== 'line' ) expect.fail( '应预览 line' );
			expect( result.preview.feature.geometry.positions ).toHaveLength( 3 );
		}
		expect( document.revision ).toBe( 0 );
		expect( controller.commit( '插入并拖动顶点' ).ok ).toBe( true );
		const edited = document.get( 'line' );
		if ( edited?.type !== 'line' ) expect.fail( '应保留 line 类型' );
		expect( edited.geometry.positions ).toEqual( [
			[ 0, 0, 0 ], [ 1, 0.4, 0 ], [ 2, 0, 0 ],
		] );
		expect( history.state.undoCount ).toBe( 1 );
	} );

	it( '非法 polygon 候选保留最后合法 preview，非法末帧不能提交', () => {
		const { document, controller, history } = setup( [ polygon( 'polygon' ) ] );
		controller.begin( 'polygon', 'vertex:1' );
		const valid = controller.update( { authorPosition: [ 2.2, 0, 0 ] } );
		expect( valid.ok ).toBe( true );
		const invalid = controller.update( { authorPosition: [ 0, 0, 0 ] } );
		expect( invalid.ok ).toBe( false );
		expect( invalid.preview?.committable ).toBe( false );
		if ( invalid.preview?.feature.type !== 'polygon' ) expect.fail( '应保留 polygon preview' );
		expect( invalid.preview.feature.geometry.positions[ 1 ][ 0 ] ).toBeCloseTo( 2.2 );
		expect( controller.commit().ok ).toBe( false );
		expect( document.revision ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( '外部 revision 变化立即回滚，迟到 update/commit 均不能覆盖文档', () => {
		const { document, executor, controller, history } = setup( [
			circle( 'edited' ), circle( 'external', 10 ),
		] );
		controller.begin( 'edited', 'center' );
		controller.update( { authorPosition: [ 1, 30, 0 ] } );
		expect( executor.execute( {
			type: 'feature.patch', id: 'external', beforeRevision: 0,
			patch: { visible: false },
		} ).ok ).toBe( true );
		expect( controller.update( { authorPosition: [ 2, 30, 0 ] } ) ).toMatchObject( {
			ok: false, error: { code: 'REVISION_CONFLICT' },
		} );
		expect( controller.session ).toBeNull();
		expect( controller.commit().error?.code ).toBe( 'EDIT_TRANSACTION_MISSING' );
		const edited = document.get( 'edited' );
		if ( edited?.type !== 'circle' ) expect.fail( '应保留 circle' );
		expect( edited.geometry.center[ 0 ] ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( '同位置拖动为空事务，不增加 revision/history', () => {
		const { document, controller, history } = setup( [ circle( 'circle' ) ] );
		controller.begin( 'circle', 'center' );
		expect( controller.update( { authorPosition: [ 0, 30, 0 ] } ) ).toMatchObject( {
			ok: true, changed: true, preview: { committable: true },
		} );
		expect( controller.commit().error?.code ).toBe( 'EDIT_NO_VALID_PREVIEW' );
		expect( document.revision ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( '拒绝 stale/derived/locked handle，且不建立 session', () => {
		const locked = normalizeFeature( {
			...circle( 'locked' ), properties: { locked: true },
		} );
		const { controller } = setup( [ circle( 'circle' ), locked ] );
		expect( controller.begin( 'missing', 'center' ).error?.code ).toBe( 'EDIT_HANDLE_NOT_FOUND' );
		expect( controller.begin( 'circle', 'generated:0' ).error?.code )
			.toBe( 'EDIT_DERIVED_GEOMETRY_READONLY' );
		expect( controller.begin( 'circle', 'vertex:99' ).error?.code ).toBe( 'EDIT_HANDLE_NOT_FOUND' );
		expect( controller.begin( 'locked', 'center' ).error?.code ).toBe( 'EDIT_ENTITY_NOT_EDITABLE' );
		expect( controller.session ).toBeNull();
	} );
} );

describe( 'ShapeEditController topology commands', () => {
	it( '删除 vertex 遵守最小拓扑；成功命令可一次 undo', () => {
		const { document, controller, history } = setup( [
			line( 'line', [ [ 0, 0, 0 ], [ 1, 0, 0 ], [ 2, 0, 0 ] ] ),
		] );
		expect( controller.removeVertex( 'line', 'vertex:1' ) ).toMatchObject( {
			ok: true, changed: true,
		} );
		const edited = document.get( 'line' );
		if ( edited?.type !== 'line' ) expect.fail( '应为 line' );
		expect( edited.geometry.positions ).toHaveLength( 2 );
		expect( history.state.undoCount ).toBe( 1 );
		expect( controller.removeVertex( 'line', 'vertex:0' ).error?.code )
			.toBe( 'EDIT_MIN_VERTICES' );
		expect( history.undo().ok ).toBe( true );
		const restored = document.get( 'line' );
		if ( restored?.type !== 'line' ) expect.fail( '应为 line' );
		expect( restored.geometry.positions ).toHaveLength( 3 );
	} );

	it( '批量删除是一个 history entry，undo 恢复稳定 id 与 order', () => {
		const { document, controller, history } = setup( [
			circle( 'a' ), circle( 'b', 1 ), circle( 'c', 2 ),
		] );
		expect( controller.deleteFeatures( [ 'c', 'a', 'c' ] ) ).toMatchObject( {
			ok: true, changed: true,
		} );
		expect( document.snapshot().order ).toEqual( [ 'b' ] );
		expect( history.state.undoCount ).toBe( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.snapshot().order ).toEqual( [ 'a', 'b', 'c' ] );
	} );
} );
