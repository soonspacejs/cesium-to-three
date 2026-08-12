import { Box3, DoubleSide, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { LinePickAdapter } from '../../../src/lib/plot-editor/picking/adapters/LinePickAdapter';
import { PlotRenderProjection } from '../../../src/lib/plot-editor/render/RenderProjection';

function renderLine() {
	const feature = normalizeFeature( {
		id: 'line', type: 'line', geometry: { positions: [
			[ 116, 39, 100 ], [ 116.002, 39, 100 ], [ 116.002, 39.002, 100 ],
		] }, style: { strokeColor: '#fff', strokeWidth: 30, strokeOpacity: 100,
			fillColor: '#fff', fillOpacity: 0, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null },
		heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0,
	} );
	return new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() ).projectFeature( feature );
}

describe( 'LinePickAdapter', () => {
	it( '线带中心与折点可命中，明显带外不命中', () => {
		const result = new LinePickAdapter().build(
			renderLine(), new MeshBasicMaterial( { side: DoubleSide } ),
		)!;
		result.root.updateWorldMatrix( true, true );
		const box = new Box3().setFromObject( result.root );
		const position = result.geometries[ 0 ].getAttribute( 'position' );
		const firstLeft = new Vector3().fromBufferAttribute( position, 0 );
		const firstRight = new Vector3().fromBufferAttribute( position, 1 );
		const center = new Vector3();
		for ( let index = 0; index < 4; index++ ) {
			center.add( new Vector3().fromBufferAttribute( position, index ) );
		}
		center.multiplyScalar( 0.25 ).add( result.root.position );
		const camera = new PerspectiveCamera( 35, 1, 1, 10_000 );
		camera.position.copy( center ).addScaledVector( center.clone().normalize(), 2_000 );
		camera.lookAt( center );
		camera.updateMatrixWorld();
		const raycaster = new Raycaster();
		raycaster.setFromCamera( new Vector2(), camera );
		expect( raycaster.intersectObject( result.root, true ).length ).toBeGreaterThan( 0 );
		// 第一对左右顶点的世界距离严格表达 30m 视觉线宽。
		expect( firstLeft.distanceTo( firstRight ) ).toBeCloseTo( 30, 3 );
		raycaster.setFromCamera( new Vector2( 0.9, 0.9 ), camera );
		expect( raycaster.intersectObject( result.root, true ) ).toEqual( [] );
	} );

	it( '虚线按显示端世界尺度切段，不把间隙错误变成可选表面', () => {
		const render = renderLine();
		const dashed = { ...render, style: { ...render.style, strokeStyle: 'dashed' } };
		const result = new LinePickAdapter().build(
			dashed, new MeshBasicMaterial( { side: DoubleSide } ),
		)!;
		// 三段以上证明长折线已分割；每段仍是标准索引三角形。
		expect( result.geometries[ 0 ].index!.count ).toBeGreaterThan( 18 );
		expect( result.geometries[ 0 ].getAttribute( 'position' ).count ).toBeGreaterThan( 8 );
	} );
} );
