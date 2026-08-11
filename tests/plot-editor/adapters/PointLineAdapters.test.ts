import { describe, expect, it } from 'vitest';
import {
	geodesicDestination,
	geodesicDistanceMeters,
} from '../../../src/lib/plot-editor/document/geodesy';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { LineGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/LineAdapter';
import { PointGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/PointAdapter';

describe( 'PointGeometryAdapter', () => {
	it( '一次命中 ready，clamp 作者高度归零并完成 canonical point', () => {
		const adapter = new PointGeometryAdapter();
		let draft = adapter.begin( {
			type: 'point', heightReference: HeightReference.CLAMP_TO_3D_TILE,
			options: { pointStyle: 'circle', size: 12 },
		} );
		expect( draft.validation.code ).toBe( 'DRAW_TOO_FEW_POINTS' );
		draft = adapter.addPoint( draft, [ 181, 30, 999 ] );
		expect( draft ).toMatchObject( {
			phase: 'ready', points: [ [ -179, 30, 0 ] ], validation: { valid: true },
		} );
		const feature = adapter.finish( draft, { id: 'point-a' } );
		expect( feature ).toMatchObject( {
			id: 'point-a', type: 'point', geometry: { position: [ -179, 30, 0 ] },
			style: { pointStyle: 'circle', size: 12 }, revision: 0,
		} );
		expect( Object.isFrozen( feature ) ).toBe( true );
	} );

	it( '图片点严格校验 URL/宽高，且只暴露 source 参数手柄', () => {
		const adapter = new PointGeometryAdapter();
		let invalid = adapter.begin( {
			type: 'point', heightReference: HeightReference.NONE,
			options: {
				pointStyle: 'image', imageUrl: '', imageWidth: 0, imageHeight: 10,
			},
		} );
		invalid = adapter.addPoint( invalid, [ 0, 0, 25 ] );
		expect( invalid.validation.code ).toBe( 'DRAW_INVALID_PARAMETER' );

		let draft = adapter.begin( {
			type: 'point', heightReference: HeightReference.NONE,
			options: {
				pointStyle: 'image', imageUrl: '/pin.png', imageWidth: 20,
				imageHeight: 30, rotation: 0,
			},
		} );
		draft = adapter.addPoint( draft, [ 0, 89.9, 25 ] );
		let feature = adapter.finish( draft, { id: 'image' } );
		expect( adapter.listHandles( feature ).map( ( handle ) => handle.id ) ).toEqual( [
			'center', 'width', 'height', 'rotation',
		] );
		feature = adapter.applyHandle( feature, 'width', { authorPosition: [ 0.001, 89.9, 25 ] } );
		expect( feature.style.pointStyle ).toBe( 'image' );
		if ( feature.style.pointStyle === 'image' ) expect( feature.style.imageWidth ).toBeGreaterThan( 0 );
		feature = adapter.applyHandle( feature, 'rotation', {
			authorPosition: geodesicDestination( feature.geometry.position, 22, 1_000, 25 ),
		} );
		if ( feature.style.pointStyle === 'image' ) expect( feature.style.rotation ).toBe( 15 );
		feature = adapter.applyHandle( feature, 'rotation', {
			authorPosition: geodesicDestination( feature.geometry.position, 22, 1_000, 25 ),
			alt: true,
		} );
		if ( feature.style.pointStyle === 'image' ) expect( feature.style.rotation ).toBeCloseTo( 22, 3 );
		expect( () => adapter.applyHandle( feature, 'derived:0', {
			authorPosition: [ 0, 0, 0 ],
		} ) ).toThrow( /EDIT_HANDLE_NOT_FOUND/ );
	} );

	it( 'point 不支持删除 anchor，center drag 保留 id 并递增 revision', () => {
		const adapter = new PointGeometryAdapter();
		let draft = adapter.begin( {
			type: 'point', heightReference: HeightReference.RELATIVE_TO_TERRAIN,
			options: { pointStyle: 'square', size: 4 },
		} );
		draft = adapter.addPoint( draft, [ 10, 20, 7 ] );
		const source = adapter.finish( draft, { id: 'p', revision: 4 } );
		const moved = adapter.applyHandle( source, 'center', { authorPosition: [ 11, 21, 8 ] } );
		expect( moved ).toMatchObject( {
			id: 'p', revision: 5, geometry: { position: [ 11, 21, 8 ] },
		} );
		expect( () => adapter.removeVertex( moved, 'center' ) ).toThrow( /UNSUPPORTED/ );
	} );
} );

describe( 'LineGeometryAdapter', () => {
	it( '去掉重复双击终点，至少两个不同控制点才能完成', () => {
		const adapter = new LineGeometryAdapter();
		let draft = adapter.begin( {
			type: 'line', heightReference: HeightReference.CLAMP_TO_GROUND,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 5 ] );
		expect( draft.validation.code ).toBe( 'DRAW_TOO_FEW_POINTS' );
		draft = adapter.addPoint( draft, [ 1, 0, 5 ] );
		draft = adapter.addPoint( draft, [ 1, 0, 999 ] );
		expect( draft.points ).toEqual( [ [ 0, 0, 0 ], [ 1, 0, 0 ] ] );
		expect( adapter.canFinish( draft ) ).toBe( true );
		expect( adapter.finish( draft, { id: 'line' } ) ).toMatchObject( {
			geometry: { positions: [ [ 0, 0, 0 ], [ 1, 0, 0 ] ] },
			style: { strokeStyle: 'solid', showArrow: false },
		} );
	} );

	it( 'preview 的 floating point 不写入 source，Backspace 不越过拓扑下限', () => {
		const adapter = new LineGeometryAdapter();
		let draft = adapter.begin( {
			type: 'line', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 10 ] );
		draft = adapter.movePointer( draft, [ 0.5, 0, 11 ] );
		expect( adapter.preview( draft ).positions ).toHaveLength( 2 );
		expect( draft.points ).toHaveLength( 1 );
		draft = adapter.addPoint( draft, [ 1, 0, 12 ] );
		draft = adapter.removeLastPoint( draft );
		expect( draft ).toMatchObject( {
			phase: 'ready', points: [ [ 0, 0, 10 ], [ 1, 0, 12 ] ],
		} );
	} );

	it( 'handles 只来自 source：vertex、segment midpoint、center、rotation', () => {
		const adapter = new LineGeometryAdapter();
		let draft = adapter.begin( {
			type: 'line', heightReference: HeightReference.NONE,
		} );
		for ( const point of [ [ 179, 0, 2 ], [ -179, 0, 4 ], [ -178, 1, 6 ] ] as const ) {
			draft = adapter.addPoint( draft, point );
		}
		const feature = adapter.finish( draft, { id: 'idl-line' } );
		const handles = adapter.listHandles( feature );
		expect( handles.map( ( handle ) => handle.id ) ).toEqual( [
			'vertex:0', 'vertex:1', 'vertex:2',
			'midpoint:0', 'midpoint:1', 'center', 'rotation',
		] );
		const midpoint = handles.find( ( handle ) => handle.id === 'midpoint:0' )!;
		expect( Math.abs( Math.abs( midpoint.position[ 0 ] ) - 180 ) ).toBeLessThan( 0.01 );
		expect( midpoint.position[ 2 ] ).toBeCloseTo( 3 );
	} );

	it( 'midpoint drag 插入 source，vertex 删除遵守 2 点下限', () => {
		const adapter = new LineGeometryAdapter();
		let draft = adapter.begin( {
			type: 'line', heightReference: HeightReference.RELATIVE_TO_GROUND,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 1 ] );
		draft = adapter.addPoint( draft, [ 2, 0, 3 ] );
		let feature = adapter.finish( draft, { id: 'line', revision: 2 } );
		feature = adapter.applyHandle( feature, 'midpoint:0', {
			authorPosition: [ 1, 0.2, 2 ],
		} );
		expect( feature.geometry.positions ).toEqual( [
			[ 0, 0, 1 ], [ 1, 0.2, 2 ], [ 2, 0, 3 ],
		] );
		expect( feature.revision ).toBe( 3 );
		feature = adapter.removeVertex( feature, 'vertex:1' );
		expect( feature.geometry.positions ).toHaveLength( 2 );
		expect( () => adapter.removeVertex( feature, 'vertex:0' ) ).toThrow( /EDIT_MIN_VERTICES/ );
	} );

	it( 'center ENU 平移跨 IDL 不绕全球，并大致保持 segment 长度', () => {
		const adapter = new LineGeometryAdapter();
		let draft = adapter.begin( {
			type: 'line', heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} );
		draft = adapter.addPoint( draft, [ 179.8, 10, 99 ] );
		draft = adapter.addPoint( draft, [ -179.8, 10, 99 ] );
		const source = adapter.finish( draft, { id: 'move' } );
		const beforeLength = geodesicDistanceMeters(
			source.geometry.positions[ 0 ], source.geometry.positions[ 1 ],
		);
		const moved = adapter.applyHandle( source, 'center', {
			authorPosition: [ -179.5, 11, 1000 ],
		} );
		const afterLength = geodesicDistanceMeters(
			moved.geometry.positions[ 0 ], moved.geometry.positions[ 1 ],
		);
		expect( moved.geometry.positions.every( ( point ) => point[ 2 ] === 0 ) ).toBe( true );
		expect( Math.abs( afterLength - beforeLength ) / beforeLength ).toBeLessThan( 0.01 );
	} );
} );
