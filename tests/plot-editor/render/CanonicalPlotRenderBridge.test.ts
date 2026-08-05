import { Group, type Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature, type ResolvedPlotGeometry } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { CanonicalPlotRenderBridge } from '../../../src/lib/plot-editor/render/CanonicalPlotRenderBridge';
import { PlotRenderProjection } from '../../../src/lib/plot-editor/render/RenderProjection';
import { createVariableHeightRtePrimitive } from '../../../src/lib/plot-editor/render/VariableHeightRtePrimitive';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );

function circle(
	revision = 0,
	heightReference = HeightReference.NONE,
): PlotFeature {
	return normalizeFeature( {
		id: 'circle', type: 'circle', geometry: { center: [ 0, 0, heightReference === HeightReference.NONE ? 10 : 5 ], radius: 100 },
		style: STYLE, heightReference, visible: true, properties: {}, revision,
	} );
}

function variableLine( revision = 0 ): PlotFeature {
	return normalizeFeature( {
		id: 'line', type: 'line', geometry: { positions: [ [ 0, 0, 1 ], [ 0.01, 0, 2 ] ] },
		style: {
			...STYLE, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null,
		},
		heightReference: HeightReference.RELATIVE_TO_TERRAIN,
		visible: true, properties: {}, revision,
	} );
}

function lineResolved(
	revision: number,
	firstHeight: number,
	secondHeight: number,
): ResolvedPlotGeometry {
	return Object.freeze( {
		plotId: 'line', sourceRevision: revision,
		effectivePositions: Object.freeze( [
			[ 0, 0, firstHeight ], [ 0.01, 0, secondHeight ],
		] ),
		status: 'ready',
	} );
}

function createBridge( options: {
	readonly root?: Group;
	readonly requestRender?: ReturnType<typeof vi.fn>;
	readonly onRenderError?: ReturnType<typeof vi.fn>;
	readonly createVariablePrimitive?: typeof createVariableHeightRtePrimitive;
} = {} ) {
	const root = options.root ?? new Group();
	const requestRender = options.requestRender ?? vi.fn();
	const onRenderError = options.onRenderError ?? vi.fn();
	const bridge = new CanonicalPlotRenderBridge( {
		root,
		projection: new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() ),
		requestRender,
		onRenderError,
		...( options.createVariablePrimitive === undefined ? {} : {
			createVariablePrimitive: options.createVariablePrimitive,
		} ),
	} );
	return { root, bridge, requestRender, onRenderError };
}

function allRenderOrders( object: Object3D ): readonly number[] {
	const orders: number[] = [];
	object.traverse( ( child ) => {
		if ( child !== object && ( child as { material?: unknown } ).material !== undefined ) {
			orders.push( child.renderOrder );
		}
	} );
	return orders;
}

describe( 'CanonicalPlotRenderBridge', () => {
	it( '统一高度走现有 Plain bridge，相同 revision 帧保持 GPU 对象身份', () => {
		const { root, bridge, requestRender } = createBridge();
		const first = bridge.sync( [ circle() ], 0 );
		expect( first ).toMatchObject( {
			changedIds: [ 'circle' ], removedIds: [], failedIds: [], renderedCount: 1,
		} );
		expect( root.children ).toHaveLength( 1 );
		const group = root.children[ 0 ];
		const second = bridge.sync( [ circle() ], 0 );
		expect( second.changedIds ).toEqual( [] );
		expect( root.children[ 0 ] ).toBe( group );
		expect( requestRender ).toHaveBeenCalledTimes( 1 );
		expect( requestRender ).toHaveBeenCalledWith( 'document' );
	} );

	it( '逐顶点高度自动走 variable RTE，mixed root 使用 canonical order', () => {
		const { root, bridge } = createBridge();
		const line = variableLine();
		const result = bridge.sync( [ line, circle() ], 0, new Map( [
			[ 'line', lineResolved( 0, 101, 202 ) ],
		] ) );
		expect( result.failedIds ).toEqual( [] );
		expect( root.children ).toHaveLength( 2 );
		const variable = root.children.find( ( child ) => child.name === 'PlotVariableHeight:line' )!;
		const legacy = root.children.find( ( child ) => child !== variable )!;
		expect( Math.max( ...allRenderOrders( variable ) ) )
			.toBeLessThan( Math.min( ...allRenderOrders( legacy ) ) );
	} );

	it( 'surface 重采样在 document revision 不变时重建 variable 并请求 surface 帧', () => {
		const { root, bridge, requestRender } = createBridge();
		const line = variableLine();
		bridge.sync( [ line ], 3, new Map( [ [ 'line', lineResolved( 0, 101, 202 ) ] ] ) );
		const previous = root.children[ 0 ];
		bridge.sync( [ line ], 3, new Map( [ [ 'line', lineResolved( 0, 111, 222 ) ] ] ) );
		expect( root.children ).toHaveLength( 1 );
		expect( root.children[ 0 ] ).not.toBe( previous );
		expect( requestRender ).toHaveBeenLastCalledWith( 'surface' );
	} );

	it( '候选构建失败保留上一成功图元和 RenderFeature，并报告 feature id', () => {
		let builds = 0;
		const createVariablePrimitive: typeof createVariableHeightRtePrimitive = ( render, order ) => {
			builds++;
			if ( builds > 1 ) throw new Error( '模拟 shader 编译失败' );
			return createVariableHeightRtePrimitive( render, order );
		};
		const { root, bridge, onRenderError } = createBridge( { createVariablePrimitive } );
		const line = variableLine();
		bridge.sync( [ line ], 0, new Map( [ [ 'line', lineResolved( 0, 101, 202 ) ] ] ) );
		const previousGroup = root.children[ 0 ];
		const previousRender = bridge.getRenderFeature( 'line' );
		const result = bridge.sync( [ line ], 0, new Map( [ [ 'line', lineResolved( 0, 301, 402 ) ] ] ) );
		expect( result.failedIds ).toEqual( [ 'line' ] );
		expect( root.children[ 0 ] ).toBe( previousGroup );
		expect( bridge.getRenderFeature( 'line' ) ).toBe( previousRender );
		expect( onRenderError ).toHaveBeenCalledWith( expect.objectContaining( {
			code: 'RENDER_BUILD_FAILED', featureId: 'line',
		} ) );
	} );

	it( '删除、surface unavailable 与 dispose 都移除自有资源，且幂等', () => {
		const { root, bridge, requestRender } = createBridge();
		const line = variableLine();
		bridge.sync( [ line ], 0, new Map( [ [ 'line', lineResolved( 0, 101, 202 ) ] ] ) );
		expect( root.children ).toHaveLength( 1 );
		expect( bridge.sync( [], 1 ).removedIds ).toEqual( [ 'line' ] );
		expect( root.children ).toHaveLength( 0 );

		const unavailable = circle( 0, HeightReference.RELATIVE_TO_3D_TILE );
		bridge.sync( [ unavailable ], 2 );
		expect( root.children ).toHaveLength( 0 );
		bridge.dispose();
		bridge.dispose();
		expect( root.children ).toHaveLength( 0 );
		expect( requestRender ).toHaveBeenLastCalledWith( 'dispose' );
		expect( () => bridge.sync( [], 3 ) ).toThrow( /已销毁/ );
	} );
} );
