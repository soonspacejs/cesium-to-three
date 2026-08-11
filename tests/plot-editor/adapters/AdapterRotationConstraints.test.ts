import { describe, expect, it } from 'vitest';
import {
	constrainHeadingDegrees,
	constrainHeadingDeltaDegrees,
} from '../../../src/lib/plot-editor/adapters/builtins/shared';

describe( 'adapter rotation constraints', () => {
	it( 'heading 默认按 15° 吸附，Alt 保留精确角度并规范化范围', () => {
		expect( constrainHeadingDegrees( 22 ) ).toBe( 15 );
		expect( constrainHeadingDegrees( 359 ) ).toBe( 0 );
		expect( constrainHeadingDegrees( 22, true ) ).toBe( 22 );
		expect( constrainHeadingDegrees( -1, true ) ).toBe( 359 );
	} );

	it( '整体旋转先取最短有符号角差，再按 Alt 决定是否吸附', () => {
		expect( constrainHeadingDeltaDegrees( 358 ) ).toBe( 0 );
		expect( constrainHeadingDeltaDegrees( 358, true ) ).toBe( -2 );
		expect( constrainHeadingDeltaDegrees( -337 ) ).toBe( 30 );
		expect( constrainHeadingDeltaDegrees( -337, true ) ).toBe( 23 );
	} );
} );
