import { Box3, DoubleSide, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { AreaPickAdapter } from '../../../src/lib/plot-editor/picking/adapters/AreaPickAdapter';
import { createTriangulatedSurface } from '../../../src/lib/plot-editor/picking/adapters/geometry';
import {
	createEnuFrame,
	geodeticToEcef,
	geodesicDestination,
} from '../../../src/lib/plot-editor/document/geodesy';
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

	it( '贴地代理沿 WGS84 法向精确抬高 2cm，且不改写文档坐标', () => {
		const positions = [
			[ 116, 39, 0 ], [ 116.001, 39, 0 ], [ 116, 39.001, 0 ],
		] as const;
		const snapshot = JSON.stringify( positions );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const base = createTriangulatedSurface( positions, material, 0 )!;
		const raised = createTriangulatedSurface( positions, material, 0.02 )!;
		const delta = raised.root.position.clone().sub( base.root.position );
		const up = new Vector3().fromArray( createEnuFrame( positions[ 0 ] ).up );

		expect( delta.dot( up ) ).toBeCloseTo( 0.02, 7 );
		expect( delta.clone().addScaledVector( up, -0.02 ).length() ).toBeLessThan( 1e-8 );
		expect( JSON.stringify( positions ) ).toBe( snapshot );
	} );

	it( '扇形只命中真实扇面，外包范围内但扇面外的空白不得命中', () => {
		const sector = feature( 'sector' );
		const projection = new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() );
		const derived = createBuiltinGeometryAdapterRegistry()
			.require( 'sector' ).toRenderDescription( sector as never ).positions;
		const render = projection.projectFeature( sector, { resolved: new Map( [ [ 'sector', {
			plotId: 'sector', sourceRevision: 0, status: 'ready',
			effectivePositions: [ [ 116, 39, 100 ] ],
			// 故意制造起伏表面，验证代理不是扇心高度的水平平板。
			effectiveRenderPositions: derived.map( ( position, index ) => [
				position[ 0 ], position[ 1 ], 100 + index * 0.4,
			] as const ),
		} ] ] ) } );
		const result = new AreaPickAdapter().build(
			render, new MeshBasicMaterial( { side: DoubleSide } ),
		)!;
		result.root.updateWorldMatrix( true, true );
		const frame = createEnuFrame( [ 116, 39, 100 ] );
		const raycaster = new Raycaster();
		const castAt = ( heading: number, distance: number ) => {
			const position = geodesicDestination( [ 116, 39, 100 ], heading, distance, 100 );
			const surface = geodeticToEcef( position );
			raycaster.set(
				new Vector3( ...surface ).addScaledVector( new Vector3( ...frame.up ), 200 ),
				new Vector3( ...frame.up ).negate(),
			);
			return raycaster.intersectObject( result.root, true );
		};
		// 当前扇形覆盖 330°→50°；正北在扇面内，正南虽在圆形外包范围内但不在扇面内。
		expect( castAt( 0, 50 ) ).toHaveLength( 1 );
		expect( castAt( 180, 50 ) ).toHaveLength( 0 );
	} );
} );
