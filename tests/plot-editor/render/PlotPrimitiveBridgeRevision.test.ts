import { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlotPrimitiveBridge } from '../../../src/lib/plot/PlotPrimitiveBridge';
import { GisPlotBase } from '../../../src/lib/plot/plugins/base';
import { GisPlotCircle } from '../../../src/lib/plot/plugins/circle';

function circle() {
	return new GisPlotCircle( {
		points: [ [ 0, 0 ] ], radius: 100,
		strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
		fillColor: '#08f', fillOpacity: 40, visible: true,
		clampToGround: false, heightMeters: 10,
	} );
}

describe( 'PlotPrimitiveBridge revision/atomic rebuild', () => {
	it( '外部 revision 未变化时跳过大型 points JSON signature 并保留对象身份', () => {
		const root = new Group();
		const revisions = new Map( [ [ 'canonical', 1 ] ] );
		const plot = circle();
		const bridge = new PlotPrimitiveBridge( {
			scene: root, getRevision: ( id ) => revisions.get( id ),
		} );
		bridge.shapes = new Map( [ [ 'canonical', plot ] ] );
		bridge.redraw();
		const group = root.children[ 0 ];
		Object.defineProperty( plot.options.points, 'toJSON', {
			value: () => { throw new Error( '相同 revision 不应 stringify points' ); },
		} );
		expect( () => bridge.redraw() ).not.toThrow();
		expect( root.children[ 0 ] ).toBe( group );
	} );

	it( '新候选返回 null 时保留旧图元，报告错误且不产生空白帧', () => {
		const root = new Group();
		const revisions = new Map( [ [ 'canonical', 1 ] ] );
		const onBuildError = vi.fn();
		const bridge = new PlotPrimitiveBridge( {
			scene: root,
			getRevision: ( id ) => revisions.get( id ),
			onBuildError,
		} );
		bridge.shapes = new Map( [ [ 'canonical', circle() ] ] );
		bridge.redraw();
		const previous = root.children[ 0 ];

		const invalid = new GisPlotBase( {
			points: [], strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#fff', fillOpacity: 100, visible: true,
		} );
		invalid.category = '' as never;
		revisions.set( 'canonical', 2 );
		bridge.shapes = new Map( [ [ 'canonical', invalid ] ] );
		bridge.redraw();
		expect( root.children ).toEqual( [ previous ] );
		expect( bridge.hasRenderEntry( 'canonical' ) ).toBe( true );
		expect( onBuildError ).toHaveBeenCalledWith( expect.any( Error ), 'canonical' );
	} );
} );
