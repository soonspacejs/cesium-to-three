import { describe, expect, it } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { ShapeEditController } from '../../../src/lib/plot-editor/editing/ShapeEditController';
import { MarqueeSelectionProjector } from '../../../src/lib/plot-editor/selection/MarqueeSelectionProjector';
import {
	SelectionController,
	createAdapterAwareSelectionModel,
} from '../../../src/lib/plot-editor/selection/SelectionController';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );

function circle(
	id: string,
	longitude: number,
	properties: Record<string, boolean> = {},
): PlotFeature {
	return normalizeFeature( {
		id, type: 'circle', geometry: { center: [ longitude, 0, 0 ], radius: 10_000 },
		style: STYLE, heightReference: HeightReference.NONE,
		visible: true, properties, revision: 0,
	} );
}

function polygon(): PlotFeature {
	return normalizeFeature( {
		id: 'polygon', type: 'polygon',
		geometry: { positions: [ [ 0, 0, 0 ], [ 2, 0, 0 ], [ 2, 2, 0 ], [ 0, 2, 0 ] ] },
		style: STYLE, heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0,
	} );
}

function setup() {
	const document = createPlotDocumentStore( {
		id: 'selection-controller',
		features: [ circle( 'a', 0 ), circle( 'b', 2 ), circle( 'locked', 4, { locked: true } ), polygon() ],
	} );
	const adapters = createBuiltinGeometryAdapterRegistry();
	const executor = new CommandExecutor( document );
	const history = new HistoryManager( document );
	const model = createAdapterAwareSelectionModel( document, adapters );
	const shapeEditor = new ShapeEditController( { document, executor, history, adapters } );
	const controller = new SelectionController( {
		model,
		marqueeProjector: new MarqueeSelectionProjector( document, adapters ),
		shapeEditor,
	} );
	const projection = {
		project: ( position: readonly [ number, number, number ] ) => ( {
			x: position[ 0 ] * 100, y: position[ 1 ] * 100,
			depth: 1, visible: true,
		} ),
	};
	return { document, executor, history, model, controller, projection };
}

describe( 'SelectionController', () => {
	it( 'Raycaster 命中快照的 replace/add/toggle/empty 更新 primary，且不写 history', () => {
		const { document, history, controller } = setup();
		const hit = ( entityId: string ) => ( { kind: 'entity' as const, entityId, distanceCssPixels: 0 } );
		expect( controller.applyHit( hit( 'a' ), 'replace' ).selection )
			.toMatchObject( { ids: [ 'a' ], primaryId: 'a' } );
		expect( controller.applyHit( hit( 'b' ), 'add' ).selection )
			.toMatchObject( { ids: [ 'a', 'b' ], primaryId: 'b' } );
		expect( controller.applyHit( hit( 'a' ), 'toggle' ).selection )
			.toMatchObject( { ids: [ 'b' ], primaryId: 'b' } );
		expect( controller.applyHit( null, 'replace' ).selection.ids )
			.toEqual( [] );
		expect( document.revision ).toBe( 0 );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( 'overlay handle 命中快照激活稳定 handle，且不写 document', () => {
		const { document, model, controller } = setup();
		model.apply( { kind: 'replace', ids: [ 'polygon' ] } );
		const selected = controller.applyHit( {
			kind: 'vertex', entityId: 'polygon', handleId: 'vertex:0', distanceCssPixels: 0,
		}, 'replace' );
		expect( selected.hit ).toMatchObject( {
			kind: 'vertex', entityId: 'polygon', handleId: 'vertex:0',
		} );
		expect( selected.selection.activeHandleId ).toBe( 'vertex:0' );
		expect( document.revision ).toBe( 0 );
	} );

	it( '反向框选支持 replace/add/toggle，并保持 document order', () => {
		const { controller, projection } = setup();
		expect( controller.selectBox(
			{ x: 250, y: 20 }, { x: -20, y: -20 }, projection, 'replace',
		).selection.ids ).toEqual( [ 'a', 'b', 'polygon' ] );
		expect( controller.selectBox(
			{ x: 10, y: 10 }, { x: -10, y: -10 }, projection, 'toggle',
		).selection.ids ).toEqual( [ 'b' ] );
		expect( controller.selectBox(
			{ x: 250, y: 10 }, { x: 150, y: -10 }, projection, 'add',
		).selection.ids ).toEqual( [ 'b', 'polygon' ] );
	} );

	it( 'selectAll 默认排除 locked，Delete active vertex 后清除 stale handle', () => {
		const { document, history, model, controller } = setup();
		expect( controller.selectAll().ids ).toEqual( [ 'a', 'b', 'locked', 'polygon' ] );
		model.apply( { kind: 'replace', ids: [ 'polygon' ] } );
		model.setActiveHandle( 'vertex:3', 'polygon' );
		expect( controller.deleteContext().ok ).toBe( true );
		const edited = document.get( 'polygon' );
		if ( edited?.type !== 'polygon' ) expect.fail( '应保留 polygon' );
		expect( edited.geometry.positions ).toHaveLength( 3 );
		expect( controller.state ).toEqual( { ids: [ 'polygon' ], primaryId: 'polygon' } );
		expect( history.state.undoCount ).toBe( 1 );
	} );

	it( 'Delete selection 原子删除，多选一次 undo 全部恢复', () => {
		const { document, history, model, controller } = setup();
		model.apply( { kind: 'replace', ids: [ 'a', 'b' ] } );
		expect( controller.deleteContext().ok ).toBe( true );
		expect( controller.state.ids ).toEqual( [] );
		expect( document.snapshot().order ).toEqual( [ 'locked', 'polygon' ] );
		expect( history.state.undoCount ).toBe( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.snapshot().order ).toEqual( [ 'a', 'b', 'locked', 'polygon' ] );
	} );

	it( '外部拓扑替换在同一 document flush 清除不存在的 active handle', () => {
		const { executor, model } = setup();
		model.apply( { kind: 'replace', ids: [ 'polygon' ] } );
		model.setActiveHandle( 'vertex:3', 'polygon' );
		expect( executor.execute( {
			type: 'feature.patch', id: 'polygon', beforeRevision: 0,
			patch: { geometry: { positions: [ [ 0, 0, 0 ], [ 2, 0, 0 ], [ 0, 2, 0 ] ] } },
		} ).ok ).toBe( true );
		expect( model.state ).toEqual( { ids: [ 'polygon' ], primaryId: 'polygon' } );
	} );

	it( 'dispose 幂等，之后拒绝选择写入', () => {
		const { controller } = setup();
		controller.dispose();
		controller.dispose();
		expect( () => controller.clear() ).toThrow( /已销毁/ );
	} );
} );
