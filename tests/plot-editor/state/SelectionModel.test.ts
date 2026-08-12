import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { SelectionModel } from '../../../src/lib/plot-editor/state/SelectionModel';

function feature(
	id: string,
	patch: Partial<PlotFeature> = {},
): PlotFeature {
	return {
		id,
		type: 'circle',
		geometry: { center: [ 0, 0, 0 ], radius: 10 },
		style: {
			strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#000', fillOpacity: 50,
		},
		heightReference: HeightReference.CLAMP_TO_GROUND,
		visible: true,
		properties: {},
		revision: 0,
		...patch,
	} as PlotFeature;
}

function setup() {
	const document = createPlotDocumentStore( {
		id: 'selection-test',
		features: [ feature( 'c' ), feature( 'a' ), feature( 'b' ) ],
		order: [ 'a', 'b', 'c' ],
	} );
	return { document, selection: new SelectionModel( document ), executor: new CommandExecutor( document ) };
}

describe( 'SelectionModel', () => {
	it( 'replace 去重并按 document order 排序，primary 使用最近请求项', () => {
		const { selection } = setup();
		expect( selection.apply( { kind: 'replace', ids: [ 'c', 'a', 'c' ] } ) ).toEqual( {
			ids: [ 'a', 'c' ], primaryId: 'c',
		} );
	} );

	it( 'add/toggle 保持顺序，移除 primary 后回退最后一项', () => {
		const { selection } = setup();
		selection.apply( { kind: 'replace', ids: [ 'a' ] } );
		expect( selection.apply( { kind: 'add', ids: [ 'c', 'b' ] } ) ).toEqual( {
			ids: [ 'a', 'b', 'c' ], primaryId: 'b',
		} );
		expect( selection.apply( { kind: 'toggle', id: 'b' } ) ).toEqual( {
			ids: [ 'a', 'c' ], primaryId: 'c',
		} );
		expect( selection.apply( { kind: 'toggle', id: 'a' } ) ).toEqual( {
			ids: [ 'c' ], primaryId: 'c',
		} );
	} );

	it( '默认排除 invisible 与 editable=false，但 locked 可选且不可编辑', () => {
		const document = createPlotDocumentStore( {
			id: 'filter',
			features: [
				feature( 'ok' ),
				feature( 'hidden', { visible: false } ),
				feature( 'locked', { properties: { locked: true } } ),
				feature( 'readonly', { properties: { editable: false } } ),
			],
		} );
		const selection = new SelectionModel( document );
		expect( selection.selectAll().ids ).toEqual( [ 'ok', 'locked' ] );
		expect( selection.selectAll( { lockedOnly: true } ).ids ).toEqual( [ 'locked' ] );
		expect( selection.selectAll( { typeAllowList: [ 'line' ] } ).ids ).toEqual( [] );
	} );

	it( 'active handle 必须属于 selection，hover/handle 不改变文档', () => {
		const { document, selection } = setup();
		selection.apply( { kind: 'replace', ids: [ 'a' ] } );
		selection.setActiveHandle( 'vertex:0', 'a' );
		selection.setHover( { kind: 'entity', entityId: 'b', distanceCssPixels: 2 } );
		expect( selection.state ).toMatchObject( {
			activeHandleId: 'vertex:0', hoverTarget: { entityId: 'b' },
		} );
		expect( document.revision ).toBe( 0 );
		expect( () => selection.setActiveHandle( 'vertex:1', 'missing' ) ).toThrow();
	} );

	it( '外部删除自动清理 selection/hover，且只通知一次', () => {
		const { selection, executor } = setup();
		selection.apply( { kind: 'replace', ids: [ 'a', 'b' ] } );
		selection.setActiveHandle( 'vertex:0', 'a' );
		selection.setHover( { kind: 'entity', entityId: 'a', distanceCssPixels: 2 } );
		const listener = vi.fn();
		selection.subscribe( listener );
		expect( executor.execute( { type: 'feature.remove', ids: [ 'a' ] } ).ok ).toBe( true );
		expect( selection.state ).toEqual( { ids: [ 'b' ], primaryId: 'b' } );
		expect( listener ).toHaveBeenCalledOnce();
	} );

	it( 'clear、重复 dispose 幂等，dispose 后拒绝写入', () => {
		const { selection } = setup();
		selection.apply( { kind: 'replace', ids: [ 'a' ] } );
		expect( selection.apply( { kind: 'clear' } ) ).toEqual( { ids: [] } );
		selection.dispose();
		selection.dispose();
		expect( () => selection.apply( { kind: 'clear' } ) ).toThrow( /已销毁/ );
	} );
} );
