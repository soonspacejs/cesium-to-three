import { describe, expect, it } from 'vitest';
import {
	geodesicDestination,
	geodesicDistanceMeters,
} from '../../../src/lib/plot-editor/document/geodesy';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { CircleGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/CircleAdapter';
import { SectorGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/SectorAdapter';

describe( 'CircleGeometryAdapter', () => {
	it( '中心+半径点用 WGS84 米制距离完成，source 不保存圆周采样点', () => {
		const adapter = new CircleGeometryAdapter();
		const center = [ 179.95, 60, 12 ] as const;
		const radiusPoint = geodesicDestination( center, 90, 20_000, 12 );
		let draft = adapter.begin( {
			type: 'circle', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, center );
		draft = adapter.addPoint( draft, radiusPoint );
		const feature = adapter.finish( draft, { id: 'circle' } );
		expect( feature.geometry.center[ 0 ] ).toBeCloseTo( center[ 0 ], 10 );
		expect( feature.geometry.center.slice( 1 ) ).toEqual( center.slice( 1 ) );
		expect( feature.geometry.radius ).toBeCloseTo( 20_000, 5 );
		const json = adapter.toJSON( feature ) as any;
		expect( json.geometry.positions ).toBeUndefined();
		expect( adapter.toRenderDescription( feature ) ).toMatchObject( {
			primitive: 'polygon', closed: true, generated: true,
		} );
		expect( adapter.toRenderDescription( feature ).positions.length ).toBeGreaterThanOrEqual( 32 );
	} );

	it( '零半径结构化失败，preview 退化时保留中心', () => {
		const adapter = new CircleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'circle', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		draft = adapter.movePointer( draft, [ 0, 0, 0 ] );
		expect( adapter.preview( draft ).positions ).toEqual( [ [ 0, 0, 0 ] ] );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		expect( draft.validation ).toMatchObject( {
			valid: false, code: 'DRAW_DEGENERATE_GEOMETRY',
		} );
	} );

	it( 'center/radius handles 只改作者参数，clamp 中心高度恒为零', () => {
		const adapter = new CircleGeometryAdapter();
		let draft = adapter.begin( {
			type: 'circle', heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} );
		draft = adapter.addPoint( draft, [ 10, 80, 500 ] );
		draft = adapter.addPoint( draft, geodesicDestination( [ 10, 80, 0 ], 45, 1_000 ) );
		let feature = adapter.finish( draft, { id: 'clamp', revision: 1 } );
		expect( adapter.listHandles( feature ).map( ( handle ) => handle.id ) ).toEqual( [
			'center', 'radius',
		] );
		feature = adapter.applyHandle( feature, 'center', {
			authorPosition: [ 11, 81, 999 ],
		} );
		expect( feature.geometry.center ).toEqual( [ 11, 81, 0 ] );
		const target = geodesicDestination( feature.geometry.center, 180, 2_500 );
		feature = adapter.applyHandle( feature, 'radius', { authorPosition: target } );
		expect( feature.geometry.radius ).toBeCloseTo( 2_500, 5 );
		expect( () => adapter.removeVertex( feature, 'center' ) ).toThrow( /UNSUPPORTED/ );
	} );
} );

describe( 'SectorGeometryAdapter', () => {
	it( '三次命中得到北起顺时针 sweep，角度/半径均为 canonical 参数', () => {
		const adapter = new SectorGeometryAdapter();
		const center = [ 0, 70, 5 ] as const;
		const start = geodesicDestination( center, 350, 10_000, 5 );
		const end = geodesicDestination( center, 20, 8_000, 5 );
		let draft = adapter.begin( {
			type: 'sector', heightReference: HeightReference.NONE,
		} );
		for ( const point of [ center, start, end ] ) draft = adapter.addPoint( draft, point );
		const feature = adapter.finish( draft, { id: 'sector' } );
		expect( feature.geometry.radius ).toBeCloseTo( 10_000, 5 );
		expect( feature.geometry.startAngle ).toBeCloseTo( 350, 6 );
		expect( feature.geometry.sectorAngle ).toBeCloseTo( 30, 6 );
		expect( adapter.toRenderDescription( feature ).positions[ 0 ] ).toEqual( center );
	} );

	it( '同方向终点规范成 360°，不产生 0 或负 sweep', () => {
		const adapter = new SectorGeometryAdapter();
		const center = [ 30, 20, 0 ] as const;
		let draft = adapter.begin( {
			type: 'sector', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, center );
		draft = adapter.addPoint( draft, geodesicDestination( center, 90, 1_000 ) );
		draft = adapter.addPoint( draft, geodesicDestination( center, 90, 2_000 ) );
		expect( adapter.finish( draft, { id: 'full' } ).geometry.sectorAngle ).toBe( 360 );
	} );

	it( 'radius/start/end handles 独立更新，end 跨 0° 不发生负跳变', () => {
		const adapter = new SectorGeometryAdapter();
		const center = [ -179.9, 10, 0 ] as const;
		let draft = adapter.begin( {
			type: 'sector', heightReference: HeightReference.CLAMP_TO_3D_TILE,
		} );
		draft = adapter.addPoint( draft, center );
		draft = adapter.addPoint( draft, geodesicDestination( center, 350, 5_000 ) );
		draft = adapter.addPoint( draft, geodesicDestination( center, 10, 5_000 ) );
		let feature = adapter.finish( draft, { id: 'edit', revision: 2 } );
		expect( adapter.listHandles( feature ).map( ( handle ) => handle.id ) ).toEqual( [
			'center', 'radius', 'start-angle', 'end-angle',
		] );
		feature = adapter.applyHandle( feature, 'radius', {
			authorPosition: geodesicDestination( center, 0, 8_000 ),
		} );
		expect( feature.geometry.radius ).toBeCloseTo( 8_000, 5 );
		feature = adapter.applyHandle( feature, 'start-angle', {
			authorPosition: geodesicDestination( center, 355, 8_000 ),
		} );
		expect( feature.geometry.startAngle ).toBeCloseTo( 355, 6 );
		feature = adapter.applyHandle( feature, 'end-angle', {
			authorPosition: geodesicDestination( center, 5, 8_000 ),
		} );
		expect( feature.geometry.sectorAngle ).toBeCloseTo( 10, 6 );
		expect( feature.geometry.center[ 2 ] ).toBe( 0 );
	} );

	it( '起始/终止方向点与中心重合时拒绝，不创建非法角度', () => {
		const adapter = new SectorGeometryAdapter();
		let draft = adapter.begin( {
			type: 'sector', heightReference: HeightReference.NONE,
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		draft = adapter.addPoint( draft, [ 1, 0, 0 ] );
		expect( draft.validation.code ).toBe( 'DRAW_DEGENERATE_GEOMETRY' );
	} );

	it( 'derived arc 的每点距中心等于作者 radius', () => {
		const adapter = new SectorGeometryAdapter();
		const center = [ 45, 89, 0 ] as const;
		let draft = adapter.begin( {
			type: 'sector', heightReference: HeightReference.RELATIVE_TO_TERRAIN,
		} );
		draft = adapter.addPoint( draft, center );
		draft = adapter.addPoint( draft, geodesicDestination( center, 0, 3_000 ) );
		draft = adapter.addPoint( draft, geodesicDestination( center, 120, 3_000 ) );
		const feature = adapter.finish( draft, { id: 'polar' } );
		const ring = adapter.toRenderDescription( feature ).positions.slice( 1 );
		for ( const point of ring ) {
			expect( geodesicDistanceMeters( center, point ) ).toBeCloseTo( 3_000, 4 );
		}
	} );
} );
