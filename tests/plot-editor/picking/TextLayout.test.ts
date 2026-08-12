import { describe, expect, it } from 'vitest';
import { measurePlotTextLayout } from '../../../src/lib/plot/text-layout';

const measure = ( value: string, size: number ) => value.length * size;

describe( 'measurePlotTextLayout', () => {
	it( '横排逐字符累计宽度，竖排按列数与最长字符列计算宽高', () => {
		const horizontal = measurePlotTextLayout( {
			content: 'ABCD\n中文', fontSize: 20, padding: 4, layoutDirection: 'horizontal',
		}, measure );
		const vertical = measurePlotTextLayout( {
			content: 'ABCD\n中文', fontSize: 20, padding: 4, layoutDirection: 'vertical-rl',
		}, measure );
		expect( horizontal ).toMatchObject( { width: 88, height: 56, direction: 'horizontal' } );
		expect( vertical ).toMatchObject( { width: 56, height: 88, direction: 'vertical-rl' } );
		expect( vertical.columns ).toEqual( [ [ 'A', 'B', 'C', 'D' ], [ '中', '文' ] ] );
	} );

	it( '不使用整行 kerning 宽度，保持与逐字符绘制的贴地纹理一致', () => {
		const layout = measurePlotTextLayout( {
			content: 'AV', fontSize: 20, padding: 4, layoutDirection: 'horizontal',
		}, ( value ) => value === 'AV' ? 15 : 10 );
		expect( layout.width ).toBe( 28 );
	} );

	it( '固定 box 尺寸覆盖自动布局，但不会丢失竖排列序', () => {
		const layout = measurePlotTextLayout( {
			content: '甲乙\n丙', fontSize: 16, boxWidth: 120, boxHeight: 90,
			layoutDirection: 'vertical-lr',
		}, measure );
		expect( layout ).toMatchObject( { width: 120, height: 90, direction: 'vertical-lr' } );
	} );
} );
