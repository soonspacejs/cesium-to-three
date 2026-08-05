import { describe, expect, it } from 'vitest';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { PolygonGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/PolygonAdapter';
import { RectangleGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/RectangleAdapter';

describe( 'PolygonGeometryAdapter', () => {
	it( '简单环 ready，重复双击终点不保存闭合首点', () => {
		const adapter = new PolygonGeometryAdapter();
		let draft = adapter.begin( {
			type: 'polygon', heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} );
		for ( const point of [ [ 0, 0, 10 ], [ 1, 0, 20 ], [ 0, 1, 30 ], [ 0, 0, 40 ] ] as const ) {
			draft = adapter.addPoint( draft, point );
		}
		expect( draft ).toMatchObject( {
			phase: 'ready', validation: { valid: true },
			points: [ [ 0, 0, 0 ], [ 1, 0, 0 ], [ 0, 1, 0 ] ],
		} );
		const feature = adapter.finish( draft, { id: 'polygon' } );
		expect( feature.geometry.positions ).toHaveLength( 3 );
		expect( adapter.toRenderDescription( feature ) ).toMatchObject( {
			closed: true, generated: false,
		} );
	} );

	it( '自交、共线和相邻重复点返回稳定结构化错误', () => {
		const adapter = new PolygonGeometryAdapter();
		const make = ( points: readonly ( readonly [ number, number, number ] )[] ) => {
			let draft = adapter.begin( {
				type: 'polygon', heightReference: HeightReference.NONE,
			} );
			for ( const point of points ) draft = adapter.addPoint( draft, point );
			return draft;
		};
		expect( make( [
			[ 0, 0, 0 ], [ 1, 1, 0 ], [ 0, 1, 0 ], [ 1, 0, 0 ],
		] ).validation.code ).toBe( 'DRAW_SELF_INTERSECTION' );
		expect( make( [
			[ 0, 0, 0 ], [ 1, 0, 0 ], [ 2, 0, 0 ],
		] ).validation.code ).toBe( 'DRAW_DEGENERATE_GEOMETRY' );
	} );

	it( '闭合边 midpoint 可插入，删除遵守三点下限且非法拖动原子拒绝', () => {
		const adapter = new PolygonGeometryAdapter();
		let draft = adapter.begin( {
			type: 'polygon', heightReference: HeightReference.RELATIVE_TO_GROUND,
		} );
		for ( const point of [ [ 0, 0, 1 ], [ 2, 0, 2 ], [ 2, 2, 3 ], [ 0, 2, 4 ] ] as const ) {
			draft = adapter.addPoint( draft, point );
		}
		let feature = adapter.finish( draft, { id: 'editable', revision: 1 } );
		expect( adapter.listHandles( feature ).map( ( handle ) => handle.id ) ).toEqual( [
			'vertex:0', 'vertex:1', 'vertex:2', 'vertex:3',
			'midpoint:0', 'midpoint:1', 'midpoint:2', 'midpoint:3',
			'center', 'rotation',
		] );
		feature = adapter.applyHandle( feature, 'midpoint:3', {
			authorPosition: [ -0.2, 1, 2.5 ],
		} );
		expect( feature.geometry.positions ).toHaveLength( 5 );
		feature = adapter.removeVertex( feature, 'vertex:4' );
		expect( feature.geometry.positions ).toHaveLength( 4 );
		expect( () => adapter.applyHandle( feature, 'vertex:1', {
			authorPosition: [ 1, 3, 0 ],
		} ) ).toThrow();
		feature = adapter.removeVertex( feature, 'vertex:3' );
		expect( feature.geometry.positions ).toHaveLength( 3 );
		expect( () => adapter.removeVertex( feature, 'vertex:0' ) ).toThrow( /EDIT_MIN_VERTICES/ );
	} );
} );

describe( 'RectangleGeometryAdapter', () => {
	it( '两点在局部 ENU 构造固定四角，跨 IDL 走短弧且 clamp 高度全零', () => {
		const adapter = new RectangleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'rectangle', heightReference: HeightReference.CLAMP_TO_3D_TILE,
		} );
		draft = adapter.addPoint( draft, [ 179.9, 10, 100 ] );
		draft = adapter.movePointer( draft, [ -179.9, 10.1, 200 ] );
		expect( adapter.preview( draft ) ).toMatchObject( {
			positions: expect.any( Array ), closed: true, generated: true,
		} );
		draft = adapter.addPoint( draft, [ -179.9, 10.1, 200 ] );
		expect( draft.validation.valid ).toBe( true );
		const feature = adapter.finish( draft, { id: 'idl-rectangle' } );
		expect( feature.geometry.positions ).toHaveLength( 4 );
		expect( feature.geometry.positions.every( ( point ) => point[ 2 ] === 0 ) ).toBe( true );
		expect( feature.geometry.positions.some( ( point ) => point[ 0 ] > 179 ) ).toBe( true );
		expect( feature.geometry.positions.some( ( point ) => point[ 0 ] < -179 ) ).toBe( true );
	} );

	it( '相同 East 或 North 尺度退化时拒绝完成', () => {
		const adapter = new RectangleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'rectangle', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, [ 1, 1, 0 ] );
		draft = adapter.addPoint( draft, [ 1, 2, 0 ] );
		expect( draft.validation ).toMatchObject( {
			valid: false, code: 'DRAW_DEGENERATE_GEOMETRY',
		} );
	} );

	it( '四角/四边中点/center/rotation 全部 transient，禁止增删拓扑', () => {
		const adapter = new RectangleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'rectangle', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, [ 10, 20, 5 ] );
		draft = adapter.addPoint( draft, [ 10.02, 20.01, 7 ] );
		const feature = adapter.finish( draft, { id: 'rect' } );
		expect( adapter.listHandles( feature ).map( ( handle ) => handle.id ) ).toEqual( [
			'vertex:0', 'vertex:1', 'vertex:2', 'vertex:3',
			'midpoint:0', 'midpoint:1', 'midpoint:2', 'midpoint:3',
			'center', 'rotation',
		] );
		expect( () => adapter.removeVertex( feature, 'vertex:0' ) ).toThrow( /UNSUPPORTED/ );
	} );

	it( 'corner 和 side midpoint 拖动均重建合法正交四角', () => {
		const adapter = new RectangleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'rectangle', heightReference: HeightReference.RELATIVE_TO_TERRAIN,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 2 ] );
		draft = adapter.addPoint( draft, [ 0.02, 0.01, 4 ] );
		let feature = adapter.finish( draft, { id: 'resize', revision: 2 } );
		feature = adapter.applyHandle( feature, 'vertex:2', {
			authorPosition: [ 0.03, 0.02, 99 ],
		} );
		expect( feature ).toMatchObject( { id: 'resize', revision: 3 } );
		expect( feature.geometry.positions ).toHaveLength( 4 );
		feature = adapter.applyHandle( feature, 'midpoint:1', {
			authorPosition: [ 0.04, 0.01, 99 ],
		} );
		expect( feature.revision ).toBe( 4 );
		expect( feature.geometry.positions ).toHaveLength( 4 );
	} );
} );
