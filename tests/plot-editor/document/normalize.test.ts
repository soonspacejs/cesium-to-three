import { describe, expect, it, vi } from 'vitest';

import {
	normalizePosition,
	normalizePositions,
	unwrapLongitudeDegrees,
	unwrapPositions,
	wrappedLongitudeDistanceDegrees,
	wrapLongitudeDegrees,
} from '../../../src/lib/plot-editor/document/normalize';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

describe( '规范坐标', () => {
	it( '在 API 边界把二维坐标补为高度 0', () => {
		expect( normalizePosition( [ 120, 30 ], HeightReference.NONE ) ).toEqual(
			[ 120, 30, 0 ],
		);
	} );

	it( '保留 NONE 与 RELATIVE 的作者高度并消除负零', () => {
		expect( normalizePosition( [ 120, -0, 15 ], HeightReference.NONE ) ).toEqual(
			[ 120, 0, 15 ],
		);
		expect( normalizePosition(
			[ 120, 30, -12.5 ],
			HeightReference.RELATIVE_TO_TERRAIN,
		) ).toEqual( [ 120, 30, -12.5 ] );
	} );

	it( '实时 API 将 CLAMP 非零高度归零并报告 warning', () => {
		const onDiagnostic = vi.fn();
		expect( normalizePosition(
			[ 120, 30, 15 ],
			HeightReference.CLAMP_TO_GROUND,
			{ onDiagnostic },
		) ).toEqual( [ 120, 30, 0 ] );
		expect( onDiagnostic ).toHaveBeenCalledWith( expect.objectContaining( {
			code: 'INVALID_COORDINATE',
			severity: 'warning',
			path: '/position/2',
		} ) );
	} );

	it( '严格文档解析拒绝 CLAMP 非零高度', () => {
		expect( () => normalizePosition(
			[ 120, 30, 15 ],
			HeightReference.CLAMP_TO_TERRAIN,
			{ clampHeightPolicy: 'reject', path: '/features/0/geometry/position' },
		) ).toThrowError( /作者高度必须为 0/ );
	} );

	it.each( [
		[ [ Number.NaN, 0, 0 ], '/0' ],
		[ [ 0, Number.POSITIVE_INFINITY, 0 ], '/1' ],
		[ [ 0, 91, 0 ], '/1' ],
		[ [ 0, -91, 0 ], '/1' ],
		[ [ '120', 30, 0 ], '/0' ],
		[ [ 0 ], '/position' ],
		[ [ 0, 0, 0, 0 ], '/position' ],
	] )( '拒绝非法输入 %#', ( input, path ) => {
		try {
			normalizePosition( input as never, HeightReference.NONE );
			expect.fail( '应当抛出坐标校验错误' );
		} catch ( error ) {
			expect( error ).toMatchObject( {
				diagnostic: expect.objectContaining( { path: expect.stringContaining( path ) } ),
			} );
		}
	} );

	it( '批量归一化不会复用调用方 tuple', () => {
		const source: [ number, number, number ][] = [ [ 181, 30, 8 ] ];
		const result = normalizePositions( source, HeightReference.NONE );
		source[ 0 ][ 0 ] = 0;
		expect( result ).toEqual( [ [ -179, 30, 8 ] ] );
	} );
} );

describe( '全球经度边界', () => {
	it.each( [
		[ -540, -180 ],
		[ -180, -180 ],
		[ 180, -180 ],
		[ 540, -180 ],
		[ 181, -179 ],
		[ -181, 179 ],
	] )( '将 %s 规范为 %s', ( input, expected ) => {
		expect( wrapLongitudeDegrees( input ) ).toBe( expected );
	} );

	it( '跨日期变更线时保持短弧连续', () => {
		expect( unwrapLongitudeDegrees( [ 179.5, -179.8, -179, 178 ] ) ).toEqual(
			[ 179.5, 180.2, 181, 178 ],
		);
		expect( wrappedLongitudeDistanceDegrees( 179.9, -180.1 ) ).toBeCloseTo( 0 );
	} );

	it( '正好相差 180 度时选择较小的展开倍数', () => {
		expect( unwrapLongitudeDegrees( [ 0, 180 ] ) ).toEqual( [ 0, -180 ] );
	} );

	it( '展开位置时保持纬度和高度逐点不变', () => {
		expect( unwrapPositions( [
			[ 179, 89.999, 10 ],
			[ -179, 90, 20 ],
		] ) ).toEqual( [
			[ 179, 89.999, 10 ],
			[ 181, 90, 20 ],
		] );
	} );
} );
