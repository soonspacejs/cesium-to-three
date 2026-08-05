import { describe, expect, it } from 'vitest';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { PlotDocumentImporter } from '../../../src/lib/plot-editor/persistence/PlotDocumentImporter';

const STYLE = {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
};

function circle( id: string, longitude = 0, properties: Record<string, unknown> = {} ) {
	return {
		id, type: 'circle', geometry: { center: [ longitude, 30, 10 ], radius: 100 },
		style: STYLE, heightReference: HeightReference.NONE, visible: true,
		properties, revision: 0,
	};
}

function setup( ids: string[] = [ 'a' ] ) {
	const document = createPlotDocumentStore( {
		id: 'current', features: ids.map( ( id, index ) => circle( id, index ) ),
		metadata: { source: 'current' },
	} );
	const executor = new CommandExecutor( document );
	const history = new HistoryManager( document );
	let generated = 1;
	const importer = new PlotDocumentImporter( {
		document, executor, history, idGenerator: () => `generated-${ generated++ }`,
	} );
	return { document, executor, history, importer };
}

function incoming( features: any[], metadata: Record<string, unknown> = {} ) {
	return createPlotDocumentStore( {
		id: 'external', features, metadata: metadata as never,
	} ).snapshot();
}

describe( 'PlotDocumentImporter', () => {
	it( 'replace 保留当前 documentId，一次提交 feature/order/metadata 并可整体 undo', () => {
		const { document, history, importer } = setup( [ 'a', 'b' ] );
		const result = importer.import( incoming(
			[ circle( 'x', 10 ), circle( 'y', 20 ) ], { source: 'incoming' },
		) );
		expect( result ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( document.id ).toBe( 'current' );
		expect( document.getAll().map( ( feature ) => feature.id ) ).toEqual( [ 'x', 'y' ] );
		expect( document.snapshot().metadata ).toEqual( { source: 'incoming' } );
		expect( history.state.undoCount ).toBe( 1 );
		history.undo();
		expect( document.getAll().map( ( feature ) => feature.id ) ).toEqual( [ 'a', 'b' ] );
		expect( document.snapshot().metadata ).toEqual( { source: 'current' } );
	} );

	it( 'merge/reject 遇到任一 id 冲突时整批不变', () => {
		const { document, history, importer } = setup( [ 'a', 'b' ] );
		const before = document.snapshot();
		const result = importer.import( incoming( [ circle( 'b', 99 ), circle( 'c', 3 ) ] ), {
			mode: 'merge', onIdConflict: 'reject',
		} );
		expect( result ).toMatchObject( { ok: false, changed: false, error: { code: 'ID_CONFLICT' } } );
		expect( document.snapshot() ).toEqual( before );
		expect( history.state.undoCount ).toBe( 0 );
	} );

	it( 'merge/replace 原位替换冲突 feature，新 id 按导入 order 追加', () => {
		const { document, importer } = setup( [ 'a', 'b' ] );
		const result = importer.import( incoming( [ circle( 'b', 99 ), circle( 'c', 3 ) ] ), {
			mode: 'merge', onIdConflict: 'replace', mergeMetadata: 'preserve',
		} );
		expect( result.ok ).toBe( true );
		expect( document.getAll().map( ( feature ) => feature.id ) ).toEqual( [ 'a', 'b', 'c' ] );
		const replaced = document.get( 'b' );
		if ( replaced?.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( replaced.geometry.center[ 0 ] ).toBe( 99 );
		expect( document.snapshot().metadata ).toEqual( { source: 'current' } );
	} );

	it( 'merge/regenerate 返回 old->new idMap，不猜测性改写 properties 引用', () => {
		const { document, importer } = setup( [ 'a' ] );
		const result = importer.import( incoming( [
			circle( 'a', 10, { relatedFeatureId: 'a' } ), circle( 'c', 20 ),
		] ), { mode: 'merge', onIdConflict: 'regenerate' } );
		expect( result.idMap ).toEqual( { a: 'generated-1' } );
		expect( document.getAll().map( ( feature ) => feature.id ) )
			.toEqual( [ 'a', 'generated-1', 'c' ] );
		expect( document.get( 'generated-1' )?.properties.relatedFeatureId ).toBe( 'a' );
	} );

	it( '非法输入与活动事务都在修改文档前失败', () => {
		const { document, history, importer } = setup();
		const before = document.snapshot();
		expect( importer.import( '{bad json' ).ok ).toBe( false );
		expect( document.snapshot() ).toEqual( before );
		const transaction = history.begin( '当前拖拽' );
		const result = importer.import( incoming( [ circle( 'x' ) ] ) );
		expect( result.error?.code ).toBe( 'TRANSACTION_CLOSED' );
		expect( document.snapshot() ).toEqual( before );
		history.commit( transaction );
	} );

	it( 'recordHistory=false 把导入作为新基线并清空旧 undo/redo', () => {
		const { document, executor, history, importer } = setup();
		history.execute( executor, { type: 'feature.add', feature: circle( 'old-history' ) as never } );
		expect( history.canUndo ).toBe( true );
		const result = importer.import( incoming( [ circle( 'fresh' ) ] ), {
			recordHistory: false,
		} );
		expect( result.ok ).toBe( true );
		expect( history.state.undoCount ).toBe( 0 );
		expect( history.state.redoCount ).toBe( 0 );
		expect( document.getAll().map( ( feature ) => feature.id ) ).toEqual( [ 'fresh' ] );
	} );
} );
