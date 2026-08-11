import { describe, expect, it, vi } from 'vitest';

import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

const commonStyle = {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
};

function feature( type: string, geometry: unknown, style: unknown = commonStyle ) {
	return {
		id: `feature-${ type }`,
		type,
		geometry,
		style,
		heightReference: HeightReference.NONE,
		visible: true,
		properties: { nested: { label: type }, values: [ 1, true, null ] },
		revision: 0,
	};
}

describe( '八类规范图形', () => {
	it.each( [
		[ 'point', { position: [ 116, 39, 10 ] }, {
			...commonStyle,
			pointStyle: 'circle',
			size: 12,
		} ],
		[ 'line', { positions: [ [ 179.9, 0, 1 ], [ -179.9, 0, 2 ] ] }, {
			...commonStyle,
			strokeStyle: 'dashed',
			showArrow: true,
			startArrowStyle: null,
			endArrowStyle: 'filledArrow',
		} ],
		[ 'polygon', { positions: [ [ 0, 0, 0 ], [ 0.01, 0, 0 ], [ 0, 0.01, 0 ] ] }, commonStyle ],
		[ 'rectangle', { positions: [
			[ 0, 0, 0 ],
			[ 0.01, 0, 0 ],
			[ 0.01, 0.01, 0 ],
			[ 0, 0.01, 0 ],
		] }, commonStyle ],
		[ 'sector', { center: [ 10, 20, 0 ], radius: 100, startAngle: 350, sectorAngle: 20 }, commonStyle ],
		[ 'arrow', {
			positions: [ [ 10, 20, 0 ], [ 10.01, 20.01, 0 ], [ 10.02, 20, 0 ] ],
			arrowType: 'attack',
			sizeScale: 1,
		}, commonStyle ],
		[ 'text', { position: [ 10, 20, 5 ] }, {
			...commonStyle,
			content: '中文标注',
			fontColor: '#000000',
			fontSize: 24,
			scale: 1,
			textAlign: 'center',
			verticalAlign: 'middle',
			anchorX: 'center',
			anchorY: 'middle',
			padding: [ 2, 4, 2, 4 ],
			layoutDirection: 'horizontal',
			rotation: 0,
			offsetX: 0,
			offsetY: 0,
			showBorder: true,
		} ],
		[ 'circle', { center: [ 10, 20, 0 ], radius: 500 }, commonStyle ],
	] )( '接受完整的 %s feature', ( type, geometry, style ) => {
		const normalized = normalizeFeature( feature( type, geometry, style ) );
		expect( normalized.type ).toBe( type );
		expect( normalized ).toEqual( expect.objectContaining( {
			id: `feature-${ type }`,
			revision: 0,
			visible: true,
		} ) );
		expect( Object.isFrozen( normalized ) ).toBe( true );
		expect( Object.isFrozen( normalized.geometry ) ).toBe( true );
		expect( Object.isFrozen( normalized.properties.nested ) ).toBe( true );
	} );

	it( '把二维兼容输入和 CLAMP 非零高度统一成三元零高坐标', () => {
		const onDiagnostic = vi.fn();
		const input = feature(
			'line',
			{ positions: [ [ 120, 30 ], [ 121, 31, 88 ] ] },
			{
				...commonStyle,
				strokeStyle: 'solid',
				showArrow: false,
				startArrowStyle: null,
				endArrowStyle: null,
			},
		);
		input.heightReference = HeightReference.CLAMP_TO_TERRAIN;
		const normalized = normalizeFeature( input, { onDiagnostic } );
		if ( normalized.type !== 'line' ) {
			expect.fail( '应当保留 line 判别类型' );
		}
		expect( normalized.geometry.positions ).toEqual( [
			[ 120, 30, 0 ],
			[ 121, 31, 0 ],
		] );
		expect( onDiagnostic ).toHaveBeenCalledOnce();
	} );

	it( '严格导入模式拒绝 CLAMP 非零作者高度', () => {
		const input = feature( 'circle', { center: [ 10, 20, 100 ], radius: 5 } );
		input.heightReference = HeightReference.CLAMP_TO_3D_TILE;
		expect( () => normalizeFeature( input, { clampHeightPolicy: 'reject' } ) )
			.toThrowError( /作者高度必须为 0/ );
	} );
} );

describe( '图形拓扑与参数失败路径', () => {
	it.each( [
		[ 'line 少于两个点', feature( 'line', { positions: [ [ 0, 0, 0 ] ] }, {
			...commonStyle,
			strokeStyle: 'solid',
			showArrow: false,
			startArrowStyle: null,
			endArrowStyle: null,
		} ) ],
		[ 'line 相邻点重合', feature( 'line', { positions: [ [ 0, 0, 0 ], [ 0, 0, 10 ] ] }, {
			...commonStyle,
			strokeStyle: 'solid',
			showArrow: false,
			startArrowStyle: null,
			endArrowStyle: null,
		} ) ],
		[ 'polygon 自交', feature( 'polygon', { positions: [
			[ 0, 0, 0 ],
			[ 1, 1, 0 ],
			[ 0, 1, 0 ],
			[ 1, 0, 0 ],
		] } ) ],
		[ 'polygon 重复闭合点', feature( 'polygon', { positions: [
			[ 0, 0, 0 ],
			[ 1, 0, 0 ],
			[ 0, 1, 0 ],
			[ 0, 0, 0 ],
		] } ) ],
		[ 'rectangle 非正交', feature( 'rectangle', { positions: [
			[ 0, 0, 0 ],
			[ 1, 0, 0 ],
			[ 0.8, 1, 0 ],
			[ 0, 1, 0 ],
		] } ) ],
		[ 'sector 零张角', feature( 'sector', {
			center: [ 0, 0, 0 ], radius: 1, startAngle: 0, sectorAngle: 0,
		} ) ],
		[ 'sector 起始角 360', feature( 'sector', {
			center: [ 0, 0, 0 ], radius: 1, startAngle: 360, sectorAngle: 20,
		} ) ],
		[ 'attack 控制点不足', feature( 'arrow', {
			positions: [ [ 0, 0, 0 ], [ 1, 1, 0 ] ], arrowType: 'attack', sizeScale: 1,
		} ) ],
		[ 'circle 半径非正', feature( 'circle', { center: [ 0, 0, 0 ], radius: 0 } ) ],
		[ 'point 尺寸非正', feature( 'point', { position: [ 0, 0, 0 ] }, {
			...commonStyle, pointStyle: 'square', size: -1,
		} ) ],
	] )( '拒绝 %s', ( _name, input ) => {
		expect( () => normalizeFeature( input ) ).toThrowError();
	} );
} );

describe( '样式、属性与身份验证', () => {
	it( '图片点只允许资源 URL，并规范化边界空白', () => {
		const imagePoint = ( imageUrl: string ) => feature(
			'point', { position: [ 0, 0, 0 ] }, {
				...commonStyle, pointStyle: 'image', imageUrl,
				imageWidth: 20, imageHeight: 30, rotation: 0,
			},
		);
		for ( const url of [ 'javascript:alert(1)', 'VBScript:msgbox(1)', 'data:text/html,x' ] ) {
			expect( () => normalizeFeature( imagePoint( url ) ) ).toThrowError( /imageUrl/ );
		}
		for ( const url of [ '/pin.png', 'https://example.test/pin.png', 'blob:https://example.test/id', 'data:image/png;base64,AA==' ] ) {
			expect( () => normalizeFeature( imagePoint( url ) ) ).not.toThrow();
		}
		const normalized = normalizeFeature( imagePoint( '  ./pin.png  ' ) );
		if ( normalized.type !== 'point' || normalized.style.pointStyle !== 'image' ) {
			expect.fail( '应为图片点。' );
		}
		expect( normalized.style.imageUrl ).toBe( './pin.png' );
	} );

	it( '拒绝空文本和负 padding', () => {
		const input = feature( 'text', { position: [ 0, 0, 0 ] }, {
			...commonStyle,
			content: '',
			fontColor: '#000000',
			fontSize: 16,
			scale: 1,
			textAlign: 'left',
			verticalAlign: 'middle',
			anchorX: 'center',
			anchorY: 'middle',
			padding: -1,
			layoutDirection: 'horizontal',
			rotation: 0,
			offsetX: 0,
			offsetY: 0,
			showBorder: false,
		} );
		expect( () => normalizeFeature( input ) ).toThrowError( /非空字符串/ );
	} );

	it( '深复制 JSON 属性并把负零规范为零', () => {
		const input = feature( 'circle', { center: [ 0, 0, 0 ], radius: 1 } );
		input.properties = { nested: { value: -0 } };
		const normalized = normalizeFeature( input );
		( input.properties.nested as { value: number } ).value = 8;
		expect( normalized.properties ).toEqual( { nested: { value: 0 } } );
	} );

	it.each( [
		[ 'NaN', { value: Number.NaN } ],
		[ 'undefined', { value: undefined } ],
		[ 'Map', { value: new Map() } ],
	] )( '拒绝 properties 中的 %s', ( _name, properties ) => {
		const input = feature( 'circle', { center: [ 0, 0, 0 ], radius: 1 } );
		input.properties = properties as never;
		expect( () => normalizeFeature( input ) ).toThrowError();
	} );

	it( '拒绝循环 properties、空 id 与负 revision', () => {
		const input = feature( 'circle', { center: [ 0, 0, 0 ], radius: 1 } );
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		input.properties = circular as never;
		expect( () => normalizeFeature( input ) ).toThrowError( /循环引用/ );

		input.properties = {};
		input.id = '';
		expect( () => normalizeFeature( input ) ).toThrowError( /非空字符串/ );
		input.id = 'valid';
		input.revision = -1;
		expect( () => normalizeFeature( input ) ).toThrowError( /安全整数/ );
	} );
} );
