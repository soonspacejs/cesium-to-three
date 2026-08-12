import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { MarqueeSelectionProjector } from '../../../src/lib/plot-editor/selection/MarqueeSelectionProjector';

const STYLE = { strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40 };

function feature( id: string, type: 'point' | 'line' | 'polygon', geometry: object ): PlotFeature {
	return normalizeFeature( { id, type, geometry, style: type === 'point'
		? { ...STYLE, pointStyle: 'circle', size: 20 } : type === 'line'
			? { ...STYLE, strokeStyle: 'solid', showArrow: false, startArrowStyle: null, endArrowStyle: null }
			: STYLE, heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0 } );
}

function setup( features: readonly PlotFeature[] ) {
	const document = createPlotDocumentStore( { id: 'marquee', features } );
	const projector = new MarqueeSelectionProjector( document, createBuiltinGeometryAdapterRegistry() );
	const projection = { project: ( position: readonly [ number, number, number ] ) => ( {
		x: position[ 0 ] * 100, y: position[ 1 ] * 100, depth: 0.5,
		visible: true, ...( position[ 2 ] === 5 ? { occluded: true } : {} ),
	} ) };
	return { projector, projection };
}

describe( 'MarqueeSelectionProjector', () => {
	it( 'intersects 支持反向拖拽、穿过矩形的线和包围选框的面', () => {
		const { projector, projection } = setup( [
			feature( 'line', 'line', { positions: [ [ -2, 0, 0 ], [ 2, 0, 0 ] ] } ),
			feature( 'polygon', 'polygon', { positions: [ [ -2, -2, 0 ], [ 2, -2, 0 ], [ 2, 2, 0 ], [ -2, 2, 0 ] ] } ),
			feature( 'outside', 'point', { position: [ 5, 5, 0 ] } ),
		] );
		expect( projector.select( { x: 50, y: 50 }, { x: -50, y: -50 }, projection ).ids )
			.toEqual( [ 'line', 'polygon' ] );
		expect( projector.select( { x: 50, y: 50 }, { x: -50, y: -50 }, projection,
			{ mode: 'contains' } ).ids ).toEqual( [] );
	} );

	it( 'contains 遵守遮挡与 selectThrough，超限按文档顺序诊断', () => {
		const { projector, projection } = setup( [
			feature( 'a', 'point', { position: [ 0, 0, 0 ] } ),
			feature( 'b', 'point', { position: [ 0.25, 0.25, 5 ] } ),
			feature( 'c', 'point', { position: [ 0.5, 0.5, 0 ] } ),
		] );
		expect( projector.select( { x: -10, y: -10 }, { x: 100, y: 100 }, projection,
			{ mode: 'contains' } ).ids ).toEqual( [ 'a', 'c' ] );
		const diagnostic = vi.fn();
		const result = projector.select( { x: -10, y: -10 }, { x: 100, y: 100 }, projection,
			{ mode: 'contains', filter: { selectThrough: true }, maxCandidates: 2,
				onDiagnostic: diagnostic } );
		expect( result ).toEqual( { ids: [ 'a', 'b' ], truncated: true, examinedCandidates: 2 } );
		expect( diagnostic ).toHaveBeenCalledWith( expect.objectContaining( {
			code: 'BOX_SELECTION_LIMIT', candidateCount: 3, maxCandidates: 2,
		} ) );
	} );
} );
