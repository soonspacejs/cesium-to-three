import { PerspectiveCamera, type BufferGeometry, type RawShaderMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { PlotRenderProjection } from '../../../src/lib/plot-editor/render/RenderProjection';
import { createVariableHeightRtePrimitive } from '../../../src/lib/plot-editor/render/VariableHeightRtePrimitive';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 4, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );
const projection = new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() );

function polygonRender() {
	const feature = normalizeFeature( {
		id: 'polygon', type: 'polygon',
		geometry: { positions: [ [ 179.9, 0, 1 ], [ -179.9, 0, 2 ], [ -179.9, 0.1, 3 ], [ 179.9, 0.1, 4 ] ] },
		style: STYLE, heightReference: HeightReference.RELATIVE_TO_TERRAIN,
		visible: true, properties: {}, revision: 0,
	} );
	return projection.projectFeature( feature, {
		resolved: new Map( [ [ feature.id, {
			plotId: feature.id, sourceRevision: 0,
			effectivePositions: [
				[ 179.9, 0, 101 ], [ -179.9, 0, 202 ],
				[ -179.9, 0.1, 303 ], [ 179.9, 0.1, 404 ],
			],
			status: 'ready' as const,
		} ] ] ),
	} );
}

describe( 'VariableHeightRtePrimitive', () => {
	it( '跨日期变更线逐顶点高度 polygon 生成 fill/stroke RTE geometry', () => {
		const primitive = createVariableHeightRtePrimitive( polygonRender(), 123 );
		expect( primitive ).not.toBeNull();
		expect( primitive?.group.name ).toBe( 'PlotVariableHeight:polygon' );
		expect( primitive?.group.children.length ).toBeGreaterThanOrEqual( 2 );
		primitive?.group.traverse( ( object ) => {
			const geometry = ( object as { geometry?: BufferGeometry } ).geometry;
			if ( geometry === undefined ) return;
			expect( geometry.getAttribute( 'position' ) ).toBeUndefined();
			expect( geometry.getAttribute( 'position3DHigh' ) ).toBeDefined();
			expect( geometry.getAttribute( 'position3DLow' ) ).toBeDefined();
			expect( Array.from( geometry.getAttribute( 'position3DHigh' ).array )
				.every( Number.isFinite ) ).toBe( true );
			expect( object.renderOrder ).toBe( 123 );
		} );
	} );

	it( 'variable-height dashed line 与首尾箭头均由三角形 proxy 渲染', () => {
		const feature = normalizeFeature( {
			id: 'line', type: 'line',
			geometry: { positions: [ [ 0, 0, 1 ], [ 0.02, 0, 2 ] ] },
			style: {
				...STYLE, strokeStyle: 'dashed', showArrow: true,
				startArrowStyle: 'unfilledArrow', endArrowStyle: 'filledArrow',
			},
			heightReference: HeightReference.RELATIVE_TO_GROUND,
			visible: true, properties: {}, revision: 0,
		} );
		const render = projection.projectFeature( feature, {
			resolved: new Map( [ [ feature.id, {
				plotId: feature.id, sourceRevision: 0,
				effectivePositions: [ [ 0, 0, 51 ], [ 0.02, 0, 102 ] ],
				status: 'ready' as const,
			} ] ] ),
		} );
		const primitive = createVariableHeightRtePrimitive( render, 5 );
		expect( primitive?.group.children.length ).toBeGreaterThan( 3 );
	} );

	it( 'update 刷新相机 RTE uniforms，visible/renderOrder 可热更新', () => {
		const primitive = createVariableHeightRtePrimitive( polygonRender(), 1 )!;
		const camera = new PerspectiveCamera( 60, 1, 1, 20_000_000 );
		camera.position.set( 7_000_000, 0, 0 );
		expect( () => primitive.update( { camera } as never ) ).not.toThrow();
		primitive.setVisible( false );
		primitive.setRenderOrder( 9 );
		expect( primitive.group.visible ).toBe( false );
		expect( primitive.group.children.every( ( child ) => child.renderOrder === 9 ) ).toBe( true );
	} );

	it( 'dispose 幂等并释放自有 geometry/material，不处理 point/text', () => {
		const primitive = createVariableHeightRtePrimitive( polygonRender(), 1 )!;
		const disposers: ReturnType<typeof vi.spyOn>[] = [];
		primitive.group.traverse( ( object ) => {
			const renderable = object as { geometry?: BufferGeometry; material?: RawShaderMaterial };
			if ( renderable.geometry !== undefined ) disposers.push( vi.spyOn( renderable.geometry, 'dispose' ) );
			if ( renderable.material !== undefined ) disposers.push( vi.spyOn( renderable.material, 'dispose' ) );
		} );
		primitive.dispose();
		primitive.dispose();
		expect( disposers.every( ( spy ) => spy.mock.calls.length === 1 ) ).toBe( true );
		expect( primitive.group.children ).toHaveLength( 0 );

		const point = normalizeFeature( {
			id: 'point', type: 'point', geometry: { position: [ 0, 0, 1 ] },
			style: { ...STYLE, pointStyle: 'circle', size: 10 },
			heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0,
		} );
		expect( createVariableHeightRtePrimitive( projection.projectFeature( point ), 0 ) ).toBeNull();
	} );
} );
