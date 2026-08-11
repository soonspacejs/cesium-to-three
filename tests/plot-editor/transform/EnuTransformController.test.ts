import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { geodesicDistanceMeters } from '../../../src/lib/plot-editor/document/geodesy';
import { isHeightReferenceClamp } from '../../../src/lib/plot-editor/document/height-reference';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { EnuTransformController } from '../../../src/lib/plot-editor/transform/EnuTransformController';
import { createEnuFeatureTransform } from '../../../src/lib/plot-editor/transform/feature-transform';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );

function circle(
	id: string,
	longitude: number,
	heightReference = HeightReference.NONE,
	height = 0,
): PlotFeature {
	return normalizeFeature( {
		id, type: 'circle', geometry: { center: [ longitude, 0, height ], radius: 100 },
		style: STYLE, heightReference, visible: true, properties: {}, revision: 0,
	} );
}

function line( id: string, latitude = 0 ): PlotFeature {
	return normalizeFeature( {
		id, type: 'line', geometry: { positions: [ [ 0, latitude, 0 ], [ 0.01, latitude, 0 ] ] },
		style: {
			...STYLE, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null,
		},
		heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0,
	} );
}

function setup( features: readonly PlotFeature[] ) {
	const document = createPlotDocumentStore( { id: 'transform-test', features } );
	const adapters = createBuiltinGeometryAdapterRegistry();
	const executor = new CommandExecutor( document, {
		transformFeature: createEnuFeatureTransform( adapters ),
	} );
	const history = new HistoryManager( document );
	const onPreviewChange = vi.fn();
	const controller = new EnuTransformController( {
		document, executor, history, adapters,
		createTransactionId: () => 'transform-fixed',
		onPreviewChange,
	} );
	return { document, executor, history, controller, onPreviewChange };
}

describe( 'EnuTransformController', () => {
	it.each( Object.values( HeightReference ) )(
		'heightReference=%s 的多选变换原子提交且保持作者高度策略',
		( heightReference ) => {
			const height = isHeightReferenceClamp( heightReference ) ? 0 : 25;
			const { document, history, controller } = setup( [
				circle( 'a', 0, heightReference, height ),
				circle( 'b', 0.02, heightReference, height + ( height === 0 ? 0 : 5 ) ),
			] );
			const before = document.getAll();
			expect( controller.begin( [ 'a', 'b' ], 'a', 'translate' ).ok ).toBe( true );
			expect( controller.update( { translationMeters: [ 100, 50, 0 ] } ).ok ).toBe( true );
			expect( controller.commit().ok ).toBe( true );
			expect( history.state.undoCount ).toBe( 1 );
			expect( document.getAll().map( ( feature ) => feature.heightReference ) )
				.toEqual( [ heightReference, heightReference ] );
			expect( document.getAll().map( ( feature ) =>
				feature.type === 'circle' ? feature.geometry.center[ 2 ] : Number.NaN ) )
				.toEqual( [ height, height + ( height === 0 ? 0 : 5 ) ] );
			expect( history.undo().ok ).toBe( true );
			expect( document.getAll() ).toEqual( before );
		},
	);

	it( '100 次 Gizmo move 只写 working copy，commit 产生一条 feature.transform history', () => {
		const { document, history, controller } = setup( [ circle( 'a', 0 ), circle( 'b', 0.02 ) ] );
		const listener = vi.fn();
		document.subscribe( listener );
		const before = document.snapshot();
		expect( controller.begin( [ 'a', 'b' ], 'a', 'translate' ) ).toMatchObject( {
			ok: true, preview: { transactionId: 'transform-fixed', selectedIds: [ 'a', 'b' ] },
		} );
		for ( let index = 1; index <= 100; index++ ) {
			expect( controller.update( { translationMeters: [ index, 0, 0 ] } ).ok ).toBe( true );
			expect( document.revision ).toBe( 0 );
			expect( history.state.undoCount ).toBe( 0 );
		}
		expect( controller.commit() ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( listener ).toHaveBeenCalledOnce();
		expect( listener ).toHaveBeenCalledWith( expect.objectContaining( {
			commandType: 'feature.transform', affectedIds: [ 'a', 'b' ],
		} ) );
		expect( history.state.undoCount ).toBe( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.snapshot().features ).toEqual( before.features );
	} );

	it( 'X/Y/Z 约束在 update 前裁剪 delta，禁用 clamp Up/pitch 直接 blocked', () => {
		const { controller } = setup( [ circle( 'clamp', 0, HeightReference.CLAMP_TO_GROUND ) ] );
		controller.begin( [ 'clamp' ], 'clamp', 'translate' );
		expect( controller.constrain( 'up' ).error?.code ).toBe( 'TRANSFORM_CAPABILITY_BLOCKED' );
		expect( controller.constrain( 'east' ).ok ).toBe( true );
		const result = controller.update( { translationMeters: [ 100, 200, 300 ] } );
		if ( result.preview?.features[ 0 ]?.type !== 'circle' ) expect.fail( '应预览 circle' );
		expect( Math.abs( result.preview.features[ 0 ].geometry.center[ 1 ] ) ).toBeLessThan( 1e-8 );
		expect( result.preview.features[ 0 ].geometry.center[ 2 ] ).toBe( 0 );
		controller.cancel();

		controller.begin( [ 'clamp' ], 'clamp', 'rotate' );
		expect( controller.constrain( 'east' ).error?.code ).toBe( 'TRANSFORM_CAPABILITY_BLOCKED' );
		expect( controller.constrain( 'up' ).ok ).toBe( true );
	} );

	it( 'held nudge 合并同一事务，十次 key repeat 只产生一个 history entry', () => {
		const { document, history, controller } = setup( [ circle( 'a', 0 ) ] );
		controller.begin( [ 'a' ], 'a', 'translate' );
		for ( let index = 0; index < 10; index++ ) {
			expect( controller.nudge( 'east', 2 ).ok ).toBe( true );
		}
		expect( document.revision ).toBe( 0 );
		expect( controller.commit( '键盘微调' ).ok ).toBe( true );
		const moved = document.get( 'a' );
		if ( moved?.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( geodesicDistanceMeters( [ 0, 0, 0 ], moved.geometry.center ) )
			.toBeCloseTo( 20, 2 );
		expect( history.state.undoCount ).toBe( 1 );
	} );

	it( '组内任一候选不兼容则保留上一整组 preview，非法末帧不可提交', () => {
		const { document, history, controller } = setup( [ circle( 'a', 0 ), circle( 'b', 1 ) ] );
		controller.begin( [ 'a', 'b' ], 'a', 'scale' );
		const valid = controller.update( { scale: [ 2, 2, 1 ] } );
		expect( valid.ok ).toBe( true );
		const invalid = controller.update( { scale: [ 3, 2, 1 ] } );
		expect( invalid ).toMatchObject( {
			ok: false,
			error: { code: 'TRANSFORM_INCOMPATIBLE_ADAPTER' },
			preview: { committable: false },
		} );
		for ( const feature of invalid.preview?.features ?? [] ) {
			if ( feature.type !== 'circle' ) expect.fail( '应为 circle' );
			expect( feature.geometry.radius ).toBe( 200 );
		}
		expect( controller.commit().ok ).toBe( false );
		expect( document.revision ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( '参数化圆形的 East/North 手柄驱动等比水平缩放', () => {
		const { controller } = setup( [ circle( 'uniform-circle', 0 ) ] );
		controller.begin( [ 'uniform-circle' ], 'uniform-circle', 'scale' );
		expect( controller.constrain( 'east' ).ok ).toBe( true );
		const east = controller.update( { scale: [ 2, 2, 2 ] } );
		expect( east.ok ).toBe( true );
		const eastFeature = east.preview?.features[ 0 ];
		if ( eastFeature?.type !== 'circle' ) expect.fail( '应为 circle。' );
		expect( eastFeature.geometry.radius ).toBe( 200 );

		expect( controller.constrain( 'north' ).ok ).toBe( true );
		const north = controller.update( { scale: [ 3, 3, 3 ] } );
		expect( north.ok ).toBe( true );
		const northFeature = north.preview?.features[ 0 ];
		if ( northFeature?.type !== 'circle' ) expect.fail( '应为 circle。' );
		expect( northFeature.geometry.radius ).toBe( 300 );
		controller.cancel();
	} );

	it( '相同值为空事务；Escape/dispose 回滚并清空 transient preview', () => {
		const { document, history, controller, onPreviewChange } = setup( [ circle( 'a', 0 ) ] );
		const before = document.snapshot();
		controller.begin( [ 'a' ], 'a', 'translate' );
		controller.update( { translationMeters: [ 0, 0, 0 ] } );
		expect( controller.commit().error?.code ).toBe( 'TRANSFORM_EMPTY' );
		controller.begin( [ 'a' ], 'a', 'translate' );
		controller.update( { translationMeters: [ 1_000, 0, 0 ] } );
		controller.cancel();
		controller.cancel();
		controller.dispose();
		controller.dispose();
		expect( document.snapshot() ).toEqual( before );
		expect( history.state.undoCount ).toBe( 0 );
		expect( onPreviewChange ).toHaveBeenLastCalledWith( null );
	} );

	it( '外部 document revision 改变后整组回滚，迟到 update 不能覆盖', () => {
		const { document, executor, history, controller } = setup( [ circle( 'a', 0 ), circle( 'b', 1 ) ] );
		controller.begin( [ 'a' ], 'a', 'translate' );
		controller.update( { translationMeters: [ 100, 0, 0 ] } );
		expect( executor.execute( {
			type: 'feature.patch', id: 'b', beforeRevision: 0, patch: { visible: false },
		} ).ok ).toBe( true );
		expect( controller.update( { translationMeters: [ 200, 0, 0 ] } ) ).toMatchObject( {
			ok: false, error: { code: 'REVISION_CONFLICT' },
		} );
		expect( controller.session ).toBeNull();
		const a = document.get( 'a' );
		if ( a?.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( a.geometry.center ).toEqual( [ 0, 0, 0 ] );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( '日期变更线与高纬多选变换保持 finite 并一次撤销', () => {
		const first = normalizeFeature( {
			...line( 'first', 89.9 ),
			geometry: { positions: [ [ 179.9, 89.9, 0 ], [ -179.9, 89.9, 0 ] ] },
		} );
		const second = circle( 'second', -179.8 );
		const { document, history, controller } = setup( [ first, second ] );
		controller.begin( [ 'first', 'second' ], 'first', 'translate' );
		expect( controller.update( { translationMeters: [ 500, 500, 0 ] } ).ok ).toBe( true );
		expect( controller.commit().ok ).toBe( true );
		for ( const feature of document.getAll() ) {
			expect( JSON.stringify( feature ) ).not.toMatch( /NaN|Infinity/ );
		}
		expect( history.undo().ok ).toBe( true );
	} );
} );
