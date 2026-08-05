import { BufferGeometry, Mesh, RawShaderMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BoxSelectionFeedbackLayer } from '../../../src/lib/plot-editor/render/BoxSelectionFeedbackLayer';

function meshes( layer: BoxSelectionFeedbackLayer ) {
	return layer.root.children as Mesh<BufferGeometry, RawShaderMaterial>[];
}

describe( 'BoxSelectionFeedbackLayer', () => {
	it( '把 CSS 框选坐标转为 clip-space 填充与四边三角形', () => {
		const layer = new BoxSelectionFeedbackLayer();
		layer.sync( {
			start: { x: 100, y: 50 }, current: { x: 300, y: 250 },
			additive: false, valid: true,
		} );
		layer.updateViewport( 800, 600, 1 );
		const [ fill, border ] = meshes( layer );
		expect( Array.from( fill.geometry.getAttribute( 'position' ).array ) ).toEqual( [
			-0.75, 0.8333333134651184, -0.25, 0.8333333134651184, -0.25, 0.1666666716337204,
			-0.75, 0.8333333134651184, -0.25, 0.1666666716337204, -0.75, 0.1666666716337204,
		] );
		expect( border.geometry.getAttribute( 'position' ).count ).toBe( 24 );
		expect( layer.visible ).toBe( true );
	} );

	it( 'DPR 只改变 viewport 换算，同步状态热更新不替换 GPU 对象', () => {
		const layer = new BoxSelectionFeedbackLayer();
		const [ fill, border ] = meshes( layer );
		layer.updateViewport( 1600, 1200, 2 );
		layer.sync( {
			start: { x: 100, y: 50 }, current: { x: 300, y: 250 }, additive: true, valid: true,
		} );
		const additiveColor = border.material.uniforms.u_color.value.clone();
		layer.sync( {
			start: { x: 100, y: 50 }, current: { x: 300, y: 250 }, additive: false, valid: false,
		} );
		expect( meshes( layer )[ 0 ] ).toBe( fill );
		expect( meshes( layer )[ 1 ] ).toBe( border );
		expect( border.material.uniforms.u_color.value ).not.toEqual( additiveColor );
		expect( fill.material.uniforms.u_color.value.w ).toBe( 0.14 );
	} );

	it( '隐藏与 dispose 幂等，并释放自有 geometry/material', () => {
		const layer = new BoxSelectionFeedbackLayer();
		const [ fill, border ] = meshes( layer );
		const dispose = [
			vi.spyOn( fill.geometry, 'dispose' ), vi.spyOn( border.geometry, 'dispose' ),
			vi.spyOn( fill.material, 'dispose' ), vi.spyOn( border.material, 'dispose' ),
		];
		layer.sync( null );
		expect( layer.visible ).toBe( false );
		layer.dispose();
		layer.dispose();
		expect( dispose.every( ( spy ) => spy.mock.calls.length === 1 ) ).toBe( true );
		expect( layer.root.children ).toHaveLength( 0 );
		expect( () => layer.sync( null ) ).toThrow( /已销毁/ );
	} );
} );
