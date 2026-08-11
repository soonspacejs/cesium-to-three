import { describe, expect, it } from 'vitest';
import {
	constrainPointerTranslation,
	pointerModifierMultiplier,
	pointerRotationDegrees,
	pointerScaleFactor,
} from '../../../src/lib/plot-editor/transform/pointer-constraints';

const NONE = Object.freeze( { shift: false, alt: false } );
const SHIFT = Object.freeze( { shift: true, alt: false } );
const ALT = Object.freeze( { shift: false, alt: true } );
const SHIFT_ALT = Object.freeze( { shift: true, alt: true } );

describe( 'pointer transform modifiers', () => {
	it( 'Shift/Alt 与键盘微调使用相同倍率，组合时回到一倍', () => {
		expect( pointerModifierMultiplier( NONE ) ).toBe( 1 );
		expect( pointerModifierMultiplier( SHIFT ) ).toBe( 10 );
		expect( pointerModifierMultiplier( ALT ) ).toBe( 0.1 );
		expect( pointerModifierMultiplier( SHIFT_ALT ) ).toBe( 1 );
		expect( constrainPointerTranslation( [ 2, -3, 4 ], SHIFT ) )
			.toEqual( [ 20, -30, 40 ] );
	} );

	it( '旋转默认吸附 15°，Alt 临时关闭吸附且保留精细倍率', () => {
		expect( pointerRotationDegrees( 8, 7, NONE ) ).toEqual( [ 15, 0, 15 ] );
		const precise = pointerRotationDegrees( 8, 7, ALT );
		expect( precise[ 0 ] ).toBeCloseTo( 0.8 );
		expect( precise[ 1 ] ).toBeCloseTo( -0.7 );
		expect( precise[ 2 ] ).toBeCloseTo( 0.8 );
		expect( pointerRotationDegrees( 2, -1, SHIFT ) ).toEqual( [ 15, 15, 15 ] );
	} );

	it( '缩放使用正指数曲线，Shift/Alt 实时改变灵敏度', () => {
		expect( pointerScaleFactor( 10, NONE ) ).toBeCloseTo( Math.exp( 0.1 ) );
		expect( pointerScaleFactor( 10, SHIFT ) ).toBeCloseTo( Math.exp( 1 ) );
		expect( pointerScaleFactor( 10, ALT ) ).toBeCloseTo( Math.exp( 0.01 ) );
		expect( pointerScaleFactor( -10_000, NONE ) ).toBe( 0.01 );
	} );
} );
