import { describe, expect, it } from 'vitest';

import {
	createEnuFrame,
	ecefToEnu,
	ecefToGeodetic,
	enuToEcef,
	geodesicDistanceMeters,
	geodeticToEcef,
	WGS84_SEMI_MAJOR_AXIS,
	WGS84_SEMI_MINOR_AXIS,
} from '../../../src/lib/plot-editor/document/geodesy';
import type { Position3D } from '../../../src/lib/plot-editor/document/types';

describe( 'WGS84 地理数学', () => {
	it.each( [
		[ [ 0, 0, 0 ], [ WGS84_SEMI_MAJOR_AXIS, 0, 0 ] ],
		[ [ 90, 0, 0 ], [ 0, WGS84_SEMI_MAJOR_AXIS, 0 ] ],
		[ [ 37, 90, 0 ], [ 0, 0, WGS84_SEMI_MINOR_AXIS ] ],
		[ [ -120, -90, 25 ], [ 0, 0, -( WGS84_SEMI_MINOR_AXIS + 25 ) ] ],
	] as const )( '将地理坐标 %j 稳定转换为 ECEF', ( position, expected ) => {
		const actual = geodeticToEcef( position );
		expect( actual[ 0 ] ).toBeCloseTo( expected[ 0 ], 6 );
		expect( actual[ 1 ] ).toBeCloseTo( expected[ 1 ], 6 );
		expect( actual[ 2 ] ).toBeCloseTo( expected[ 2 ], 6 );
	} );

	it.each( ( [
		[ 116.391, 39.907, 123.45 ],
		[ 179.999, 89.999, -35 ],
		[ -179.999, -89.999, 1_000 ],
	] as Position3D[] ).map( ( position ) => [ position ] as const ) )(
		'ECEF 往返保留 %j',
		( position ) => {
		const roundTrip = ecefToGeodetic( geodeticToEcef( position ) );
		expect( roundTrip[ 0 ] ).toBeCloseTo( position[ 0 ], 8 );
		expect( roundTrip[ 1 ] ).toBeCloseTo( position[ 1 ], 8 );
		expect( roundTrip[ 2 ] ).toBeCloseTo( position[ 2 ], 4 );
		},
	);

	it( '精确极点使用调用方给定的稳定经度', () => {
		expect( ecefToGeodetic( [ 0, 0, WGS84_SEMI_MINOR_AXIS ], 73 ) ).toEqual(
			[ 73, 90, 0 ],
		);
	} );

	it.each( ( [
		[ 0, 0, 0 ],
		[ 179.9, 45, 100 ],
		[ -42, 90, 0 ],
		[ 137, -90, 0 ],
	] as Position3D[] ).map( ( anchor ) => [ anchor ] as const ) )(
		'ENU 基底在 %j 保持正交并可逆',
		( anchor ) => {
		const frame = createEnuFrame( anchor );
		const local = [ 25, -40, 8 ] as const;
		const roundTrip = ecefToEnu( enuToEcef( local, frame ), frame );
		expect( roundTrip[ 0 ] ).toBeCloseTo( local[ 0 ], 7 );
		expect( roundTrip[ 1 ] ).toBeCloseTo( local[ 1 ], 7 );
		expect( roundTrip[ 2 ] ).toBeCloseTo( local[ 2 ], 7 );
		for ( const value of [ ...frame.east, ...frame.north, ...frame.up ] ) {
			expect( Number.isFinite( value ) ).toBe( true );
		}
		},
	);

	it( 'Vincenty 距离走日期变更线短弧', () => {
		const distance = geodesicDistanceMeters(
			[ 179.9, 0, 0 ],
			[ -179.9, 0, 0 ],
		);
		expect( distance ).toBeGreaterThan( 22_000 );
		expect( distance ).toBeLessThan( 22_400 );
	} );

	it( '近对跖输入仍返回有限距离', () => {
		const distance = geodesicDistanceMeters( [ 0, 0, 0 ], [ 179.999999, 0, 0 ] );
		expect( Number.isFinite( distance ) ).toBe( true );
		expect( distance ).toBeGreaterThan( 20_000_000 );
	} );
} );
