import { describe, expect, it } from 'vitest';

import { ClassificationType } from '../../../src/lib/ground/types';
import {
	getClassificationType,
	getHeightMode,
	getHeightReferenceName,
	getHeightSurface,
	isHeightReference,
	isHeightReferenceClamp,
	isHeightReferenceRelative,
	parseHeightReference,
} from '../../../src/lib/plot-editor/document/height-reference';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

describe( 'HeightReference', () => {
	it( '与 Cesium 的七个数值和稳定名称逐项对齐', () => {
		expect( HeightReference ).toEqual( {
			NONE: 0,
			CLAMP_TO_GROUND: 1,
			RELATIVE_TO_GROUND: 2,
			CLAMP_TO_TERRAIN: 3,
			RELATIVE_TO_TERRAIN: 4,
			CLAMP_TO_3D_TILE: 5,
			RELATIVE_TO_3D_TILE: 6,
		} );
		for ( const [ name, value ] of Object.entries( HeightReference ) ) {
			expect( parseHeightReference( name ) ).toBe( value );
			expect( parseHeightReference( value ) ).toBe( value );
			expect( getHeightReferenceName( value ) ).toBe( name );
		}
	} );

	it.each( [
		[ HeightReference.NONE, 'absolute', 'ellipsoid', undefined ],
		[ HeightReference.CLAMP_TO_GROUND, 'clamp', 'ground', ClassificationType.BOTH ],
		[ HeightReference.RELATIVE_TO_GROUND, 'relative', 'ground', ClassificationType.BOTH ],
		[ HeightReference.CLAMP_TO_TERRAIN, 'clamp', 'terrain', ClassificationType.TERRAIN ],
		[ HeightReference.RELATIVE_TO_TERRAIN, 'relative', 'terrain', ClassificationType.TERRAIN ],
		[ HeightReference.CLAMP_TO_3D_TILE, 'clamp', '3d-tile', ClassificationType.CESIUM_3D_TILE ],
		[ HeightReference.RELATIVE_TO_3D_TILE, 'relative', '3d-tile', ClassificationType.CESIUM_3D_TILE ],
	] as const )(
		'正确解析值 %s 的模式、表面和 classification',
		( value, mode, surface, classification ) => {
			expect( getHeightMode( value ) ).toBe( mode );
			expect( getHeightSurface( value ) ).toBe( surface );
			expect( getClassificationType( value ) ).toBe( classification );
		},
	);

	it( '区分 clamp、relative 与非法运行时输入', () => {
		expect( isHeightReferenceClamp( HeightReference.CLAMP_TO_TERRAIN ) ).toBe( true );
		expect( isHeightReferenceClamp( HeightReference.RELATIVE_TO_TERRAIN ) ).toBe( false );
		expect( isHeightReferenceRelative( HeightReference.RELATIVE_TO_3D_TILE ) ).toBe( true );
		expect( isHeightReferenceRelative( HeightReference.NONE ) ).toBe( false );
		expect( isHeightReference( 6 ) ).toBe( true );
		expect( isHeightReference( 7 ) ).toBe( false );
		expect( isHeightReference( 'NONE' ) ).toBe( false );
		expect( () => parseHeightReference( 'unknown' ) ).toThrowError(
			/heightReference/,
		);
	} );
} );
