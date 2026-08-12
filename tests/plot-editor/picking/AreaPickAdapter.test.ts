import { Box3, DoubleSide, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { AreaPickAdapter } from '../../../src/lib/plot-editor/picking/adapters/AreaPickAdapter';
import { PlotRenderProjection } from '../../../src/lib/plot-editor/render/RenderProjection';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#765432', fillOpacity: 80,
} );

function feature( type: 'polygon' | 'rectangle' | 'circle' | 'sector' | 'arrow' ): PlotFeature {
	const base = { id: type, type, style: STYLE, heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0 };
	if ( type === 'polygon' ) return normalizeFeature( { ...base,
		geometry: { positions: [ [ 116, 39, 100 ], [ 116.002, 39, 100 ], [ 116.002, 39.002, 100 ], [ 116, 39.002, 100 ] ] } } );
	if ( type === 'rectangle' ) return normalizeFeature( { ...base,
		geometry: { positions: [ [ 116, 39, 100 ], [ 116.002, 39, 100 ], [ 116.002, 39.002, 100 ], [ 116, 39.002, 100 ] ] } } );
	if ( type === 'circle' ) return normalizeFeature( { ...base, geometry: { center: [ 116, 39, 100 ], radius: 100 } } );
	if ( type === 'sector' ) return normalizeFeature( { ...base, geometry: { center: [ 116, 39, 100 ], radius: 100, startAngle: 330, sectorAngle: 80 } } );
	return normalizeFeature( { ...base, geometry: { positions: [ [ 116, 39, 100 ], [ 116.002, 39.001, 100 ] ], arrowType: 'fine', sizeScale: 1 } } );
}

describe( 'AreaPickAdapter', () => {
	it.each( [ 'polygon', 'rectangle', 'circle', 'sector', 'arrow' ] as const )(
		'%s 生成标准 position/index 表面并可被原生 Raycaster 命中', ( type ) => {
			const projection = new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() );
			const render = projection.projectFeature( feature( type ) );
			const result = new AreaPickAdapter().build(
				render, new MeshBasicMaterial( { side: DoubleSide } ),
			);
			expect( result ).not.toBeNull();
			const geometry = result!.geometries[ 0 ];
			expect( geometry.getAttribute( 'position' ) ).toBeDefined();
			expect( geometry.index!.count ).toBeGreaterThanOrEqual( 3 );
			expect( Math.max( ...Array.from( geometry.getAttribute( 'position' ).array )
				.map( Math.abs ) ) ).toBeLessThan( 100_000 );

			result!.root.updateWorldMatrix( true, true );
			const center = new Box3().setFromObject( result!.root ).getCenter( new Vector3() );
			const camera = new PerspectiveCamera( 45, 1, 1, 10_000 );
			camera.position.copy( center ).addScaledVector( center.clone().normalize(), 2_000 );
			camera.lookAt( center );
			camera.updateMatrixWorld();
			const raycaster = new Raycaster();
			raycaster.setFromCamera( new Vector2(), camera );
			expect( raycaster.intersectObject( result!.root, true ).length ).toBeGreaterThan( 0 );
		},
	);
} );
