import {
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	OrthographicCamera,
	PlaneGeometry,
	Vector2,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PointFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import {
	PlotEntityRaycaster,
	PlotPickAdapterRegistry,
	PlotPickRegistry,
	type PlotPickMetadata,
} from '../../../src/lib/plot-editor/picking';

const ENTITY_COUNT = 1_000;
const STATIC_POINTER_MOVES = 300;

function percentile95( values: readonly number[] ): number {
	const sorted = [ ...values ].sort( ( left, right ) => left - right );
	return sorted[ Math.ceil( sorted.length * 0.95 ) - 1 ];
}

function point( index: number, revision = 0 ): PointFeature {
	return normalizeFeature( {
		id: `point-${ index }`, type: 'point',
		geometry: { position: [ 116 + index * 0.00001, 39, 100 ] },
		style: { strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#ffffff', fillOpacity: 100, pointStyle: 'square', size: 4 },
		heightReference: HeightReference.NONE, visible: true, properties: {}, revision,
	} ) as PointFeature;
}

describe( 'Plot picking 性能契约', () => {
	it( '1,000 个标准 Mesh 的 pointermove Raycaster P95 小于 4ms', () => {
		const registry = new PlotPickRegistry();
		const geometry = new PlaneGeometry( 0.5, 0.5 );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		for ( let index = 0; index < ENTITY_COUNT; index++ ) {
			const mesh = new Mesh( geometry, material );
			mesh.position.set( index % 40 - 20, Math.floor( index / 40 ) - 12, 0 );
			registry.replace( {
				metadata: Object.freeze( { kind: 'plot-entity', featureId: `mesh-${ index }`,
					featureType: 'polygon', source: 'proxy', part: 'fill',
					pickPriority: 0, plotOrder: index } satisfies PlotPickMetadata ),
				revision: { featureRevision: 0, resolvedGeometryRevision: -1 },
				targets: [ mesh ],
			} );
		}
		const camera = new OrthographicCamera( -25, 25, 15, -15, 0.1, 100 );
		camera.position.set( 0, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		const raycaster = new PlotEntityRaycaster( registry );
		const ndc = new Vector2( 0.01, 0.01 );
		for ( let index = 0; index < 20; index++ ) raycaster.hitTest( ndc, camera );

		const samples: number[] = [];
		for ( let index = 0; index < STATIC_POINTER_MOVES; index++ ) {
			const started = performance.now();
			raycaster.hitTest( ndc, camera );
			samples.push( performance.now() - started );
		}
		const p95 = percentile95( samples );
		// 失败信息直接保留实测 P95，便于区分算法退化与 CI 机器波动。
		expect( p95, `实测 Raycaster P95=${ p95.toFixed( 3 ) }ms` ).toBeLessThan( 4 );
		raycaster.dispose();
		registry.dispose();
		geometry.dispose();
		material.dispose();
	}, 20_000 );

	it( '1,000 个静态 feature 连续 300 次同步零重建，单 revision 只替换一项', () => {
		const features = Array.from( { length: ENTITY_COUNT }, ( _, index ) => point( index ) );
		const registry = new PlotPickRegistry();
		const syncer = new PlotPickAdapterRegistry( {
			registry, adapters: createBuiltinGeometryAdapterRegistry(),
			measureText: ( value, size ) => value.length * size,
		} );
		const replace = vi.spyOn( registry, 'replace' );
		syncer.sync( features, new Map() );
		expect( replace ).toHaveBeenCalledTimes( ENTITY_COUNT );

		for ( let index = 0; index < STATIC_POINTER_MOVES; index++ ) {
			syncer.sync( features, new Map() );
		}
		expect( replace ).toHaveBeenCalledTimes( ENTITY_COUNT );

		const changed = [ ...features ];
		changed[ 417 ] = point( 417, 1 );
		syncer.sync( changed, new Map() );
		expect( replace ).toHaveBeenCalledTimes( ENTITY_COUNT + 1 );
		expect( registry.size ).toBe( ENTITY_COUNT );
		syncer.dispose();
		registry.dispose();
	}, 20_000 );
} );
