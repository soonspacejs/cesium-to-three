import { describe, expect, it } from 'vitest';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import {
	decodePlotDocument,
	encodePlotDocument,
	stringifyPlotDocument,
	tryDecodePlotDocument,
} from '../../../src/lib/plot-editor/persistence/codec';

const STYLE = {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
};

function circle( id: string, heightReference = HeightReference.NONE ) {
	return {
		id, type: 'circle', geometry: { center: [ 116, 39, 10 ], radius: 100 },
		style: STYLE, heightReference, visible: true,
		properties: { z: 1, a: { y: 2, x: 3 } }, revision: 2,
	};
}

describe( 'plot document codec', () => {
	it( 'v1 确定性输出按 order 排列 feature，HeightReference 使用稳定名称', () => {
		const document = createPlotDocumentStore( {
			id: 'doc', revision: 7,
			features: [ circle( 'a' ), circle( 'b', HeightReference.RELATIVE_TO_TERRAIN ) ],
			order: [ 'b', 'a' ], metadata: { z: 1, a: 2 },
		} );
		const encoded = encodePlotDocument( document.snapshot() );
		expect( encoded.features.map( ( feature ) => feature.id ) ).toEqual( [ 'b', 'a' ] );
		expect( encoded.features[ 0 ].heightReference ).toBe( 'RELATIVE_TO_TERRAIN' );
		expect( Object.keys( encoded.features[ 0 ].properties ) ).toEqual( [ 'a', 'z' ] );
		expect( stringifyPlotDocument( document.snapshot() ) )
			.toBe( stringifyPlotDocument( document.snapshot() ) );
	} );

	it( 'canonical JSON 往返保留三元坐标、id、order、revision 和 metadata', () => {
		const source = createPlotDocumentStore( {
			id: 'roundtrip', revision: 3, features: [ circle( 'circle' ) ],
			metadata: { owner: '测试' },
		} ).snapshot();
		const result = decodePlotDocument( stringifyPlotDocument( source ) );
		expect( result.migrated ).toBe( false );
		expect( result.snapshot ).toEqual( source );
	} );

	it( '严格 v1 拒绝二维坐标与 CLAMP 非零 author height', () => {
		const base = JSON.parse( stringifyPlotDocument(
			createPlotDocumentStore( { id: 'doc', features: [ circle( 'a' ) ] } ).snapshot(),
		) ) as any;
		base.features[ 0 ].geometry.center = [ 116, 39 ];
		expect( () => decodePlotDocument( base ) ).toThrow( /三元坐标/ );
		base.features[ 0 ].geometry.center = [ 116, 39, 10 ];
		base.features[ 0 ].heightReference = 'CLAMP_TO_TERRAIN';
		expect( tryDecodePlotDocument( base ) ).toMatchObject( {
			ok: false,
			diagnostics: [ { code: 'INVALID_COORDINATE', path: '/features/0/geometry/center/2' } ],
		} );
	} );

	it( '旧 {type, options} 数组在 codec 边界迁移二维坐标和 heightMeters', () => {
		const result = decodePlotDocument( [ {
			type: 'line',
			options: {
				points: [ [ 116, 39 ], [ 117, 40 ] ], clampToGround: false,
				heightMeters: 88, visible: true,
			},
		} ], { idGenerator: () => 'legacy-line' } );
		expect( result.migrated ).toBe( true );
		expect( result.snapshot.features[ 0 ] ).toMatchObject( {
			id: 'legacy-line', heightReference: HeightReference.NONE,
			geometry: { positions: [ [ 116, 39, 88 ], [ 117, 40, 88 ] ] },
		} );
		expect( result.diagnostics.map( ( item ) => item.code ) ).toEqual( expect.arrayContaining( [
			'LEGACY_INPUT_MIGRATED', 'LEGACY_2D_POSITION_MIGRATED', 'LEGACY_HEIGHT_METERS_MIGRATED',
		] ) );
	} );

	it( '未来 version、NaN、循环、原型污染键和安全限制都有结构化失败', () => {
		const future = {
			schema: 'cesium-to-three/plot-document', version: 2,
			documentId: 'doc', revision: 0, features: [], order: [],
		};
		expect( tryDecodePlotDocument( future ) ).toMatchObject( {
			ok: false, diagnostics: [ { code: 'UNSUPPORTED_VERSION', path: '/version' } ],
		} );
		expect( tryDecodePlotDocument( { ...future, version: 1, revision: Number.NaN } ) )
			.toMatchObject( { ok: false, diagnostics: [ { code: 'INVALID_SCHEMA' } ] } );

		const cyclic: any = { items: [] };
		cyclic.self = cyclic;
		expect( tryDecodePlotDocument( cyclic ).ok ).toBe( false );
		expect( tryDecodePlotDocument( '{"items":[],"__proto__":{"polluted":true}}' ) )
			.toMatchObject( { ok: false, diagnostics: [ { code: 'INVALID_PROPERTIES' } ] } );
		expect( tryDecodePlotDocument( [], { limits: { maxFeatures: 1, maxNodes: 1 } } ).ok )
			.toBe( true );
		expect( tryDecodePlotDocument( [], { limits: { maxBytes: 1 } } ) ).toMatchObject( {
			ok: false, diagnostics: [ { code: 'INVALID_SCHEMA', path: '/' } ],
		} );
		expect( tryDecodePlotDocument( [], { limits: { maxBytes: 2 } } ).ok ).toBe( true );
		expect( tryDecodePlotDocument( [ {}, {} ], { limits: { maxFeatures: 1 } } ).ok )
			.toBe( false );
	} );
} );
