import { Box3, DoubleSide, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { HeightReference, type PointFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { PointPickAdapter } from '../../../src/lib/plot-editor/picking/adapters/PointPickAdapter';

const BASE = { id: 'point', type: 'point', heightReference: HeightReference.NONE,
	visible: true, properties: {}, revision: 0,
	geometry: { position: [ 116, 39, 100 ] },
	style: { strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
		fillColor: '#765432', fillOpacity: 100 } } as const;

function rayHits( result: NonNullable<ReturnType<PointPickAdapter[ 'build' ]>>, ndcX = 0 ): number {
	result.root.updateWorldMatrix( true, true );
	const center = new Box3().setFromObject( result.root ).getCenter( new Vector3() );
	const camera = new PerspectiveCamera( 20, 1, 1, 10_000 );
	camera.position.copy( center ).addScaledVector( center.clone().normalize(), 2_000 );
	camera.lookAt( center );
	camera.updateMatrixWorld();
	const raycaster = new Raycaster();
	raycaster.setFromCamera( new Vector2( ndcX, 0 ), camera );
	return raycaster.intersectObject( result.root, true ).length;
}

describe( 'PointPickAdapter', () => {
	it( '小圆中心命中、明显外部不命中，尺寸变化同步到 geometry', () => {
		const adapter = new PointPickAdapter();
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const small = adapter.build( normalizeFeature( { ...BASE,
			style: { ...BASE.style, pointStyle: 'circle', size: 20 } } ) as PointFeature,
			[ 116, 39, 100 ], material )!;
		const large = adapter.build( normalizeFeature( { ...BASE,
			style: { ...BASE.style, pointStyle: 'circle', size: 80 } } ) as PointFeature,
			[ 116, 39, 100 ], material )!;
		expect( rayHits( small ) ).toBeGreaterThan( 0 );
		expect( rayHits( small, 0.5 ) ).toBe( 0 );
		expect( new Box3().setFromObject( large.root ).getSize( new Vector3() ).length() )
			.toBeGreaterThan( new Box3().setFromObject( small.root ).getSize( new Vector3() ).length() * 3 );
	} );

	it( '图片点按实际宽高和旋转生成非轴对齐平面', () => {
		const feature = normalizeFeature( { ...BASE, style: { ...BASE.style,
			pointStyle: 'image', imageUrl: 'data:image/png;base64,AA==',
			imageWidth: 120, imageHeight: 20, rotation: 45 } } ) as PointFeature;
		const result = new PointPickAdapter().build(
			feature, [ 116, 39, 100 ], new MeshBasicMaterial( { side: DoubleSide } ),
		)!;
		const size = new Box3().setFromObject( result.root ).getSize( new Vector3() );
		expect( rayHits( result ) ).toBeGreaterThan( 0 );
		expect( Math.max( size.x, size.y, size.z ) ).toBeGreaterThan( 70 );
	} );
} );
