import { describe, expect, it } from 'vitest';
import { geodesicDestination } from '../../../src/lib/plot-editor/document/geodesy';
import { wrappedLongitudeDistanceDegrees } from '../../../src/lib/plot-editor/document/normalize';
import { HeightReference, type ArrowType } from '../../../src/lib/plot-editor/document/types';
import { ArrowGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/ArrowAdapter';
import { TextGeometryAdapter } from '../../../src/lib/plot-editor/adapters/builtins/TextAdapter';

describe( 'ArrowGeometryAdapter', () => {
	it.each( [
		[ 'fine', 2 ],
		[ 'assaultDirection', 2 ],
		[ 'attack', 3 ],
		[ 'swallowtailAttack', 3 ],
		[ 'curved', 2 ],
	] as const )( '%s 使用规定的最小 source control points 并生成派生 polygon', ( arrowType, minimum ) => {
		const adapter = new ArrowGeometryAdapter();
		let draft = adapter.begin( {
			type: 'arrow', heightReference: HeightReference.NONE,
			options: { arrowType, sizeScale: 1 },
		} );
		for ( let index = 0; index < minimum; index++ ) {
			draft = adapter.addPoint( draft, [ index * 0.01, index % 2 * 0.01, index * 10 ] );
		}
		expect( draft.validation.valid ).toBe( true );
		const feature = adapter.finish( draft, { id: arrowType } );
		expect( feature.geometry.positions ).toHaveLength( minimum );
		const render = adapter.toRenderDescription( feature );
		expect( render ).toMatchObject( {
			primitive: 'polygon', closed: true, generated: true,
		} );
		expect( render.positions.length ).toBeGreaterThanOrEqual( 3 );
		expect( render.positions.length ).toBeLessThanOrEqual( 120 );
		const json = adapter.toJSON( feature ) as any;
		expect( json.generatedCoords ).toBeUndefined();
		expect( json.geometry.positions ).toHaveLength( minimum );
	} );

	it( 'attack/swallow 最少三点，曲线体型与 sizeScale 必须为正有限数', () => {
		const adapter = new ArrowGeometryAdapter();
		let draft = adapter.begin( {
			type: 'arrow', heightReference: HeightReference.NONE,
			options: { arrowType: 'attack', sizeScale: -1 },
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		draft = adapter.addPoint( draft, [ 1, 0, 0 ] );
		expect( draft.validation.code ).toBe( 'DRAW_TOO_FEW_POINTS' );
		draft = adapter.addPoint( draft, [ 1, 1, 0 ] );
		expect( draft.validation.code ).toBe( 'DRAW_INVALID_PARAMETER' );
	} );

	it( '跨 IDL 先连续展开，生成轮廓不绕全球且派生高度按 source segment 插值', () => {
		const adapter = new ArrowGeometryAdapter();
		let draft = adapter.begin( {
			type: 'arrow', heightReference: HeightReference.NONE,
			options: { arrowType: 'curved', sizeScale: 1 },
		} );
		for ( const point of [ [ 179.8, 10, 10 ], [ -179.9, 10.1, 20 ], [ -179.6, 10.2, 40 ] ] as const ) {
			draft = adapter.addPoint( draft, point );
		}
		const feature = adapter.finish( draft, { id: 'idl-arrow' } );
		const generated = adapter.toRenderDescription( feature ).positions;
		expect( generated.every( ( point ) => point.every( Number.isFinite ) ) ).toBe( true );
		expect( generated.every(
			( point ) => wrappedLongitudeDistanceDegrees( point[ 0 ], 180 ) < 2,
		) ).toBe( true );
		expect( generated.every( ( point ) => point[ 2 ] >= 10 && point[ 2 ] <= 40 ) ).toBe( true );
	} );

	it( 'clamp 派生轮廓和 source 高度都严格为零', () => {
		const adapter = new ArrowGeometryAdapter();
		let draft = adapter.begin( {
			type: 'arrow', heightReference: HeightReference.CLAMP_TO_3D_TILE,
			options: { arrowType: 'fine' },
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 100 ] );
		draft = adapter.addPoint( draft, [ 0.1, 0.1, 200 ] );
		const feature = adapter.finish( draft, { id: 'clamp' } );
		expect( feature.geometry.positions.every( ( point ) => point[ 2 ] === 0 ) ).toBe( true );
		expect( adapter.toRenderDescription( feature ).positions.every(
			( point ) => point[ 2 ] === 0,
		) ).toBe( true );
	} );

	it( 'handles 仅来自 control points；派生 ring 拒绝编辑，拓扑依 arrowType', () => {
		const adapter = new ArrowGeometryAdapter();
		const create = ( arrowType: ArrowType, points: readonly ( readonly [ number, number, number ] )[] ) => {
			let draft = adapter.begin( {
				type: 'arrow', heightReference: HeightReference.NONE,
				options: { arrowType },
			} );
			for ( const point of points ) draft = adapter.addPoint( draft, point );
			return adapter.finish( draft, { id: arrowType } );
		};
		const fine = create( 'fine', [ [ 0, 0, 0 ], [ 1, 1, 0 ] ] );
		expect( adapter.listHandles( fine ).map( ( handle ) => handle.id ) ).toEqual( [
			'vertex:0', 'vertex:1', 'center', 'rotation',
		] );
		expect( () => adapter.applyHandle( fine, 'generated:4', {
			authorPosition: [ 0, 0, 0 ],
		} ) ).toThrow( /EDIT_DERIVED_GEOMETRY_READONLY/ );
		expect( () => adapter.removeVertex( fine, 'vertex:0' ) ).toThrow( /EDIT_MIN_VERTICES/ );

		let curved = create( 'curved', [ [ 0, 0, 0 ], [ 1, 0, 1 ], [ 2, 1, 2 ] ] );
		expect( adapter.listHandles( curved ).some( ( handle ) => handle.id === 'midpoint:1' ) ).toBe( true );
		curved = adapter.applyHandle( curved, 'midpoint:1', {
			authorPosition: [ 1.5, 0.2, 1.5 ],
		} );
		expect( curved.geometry.positions ).toHaveLength( 4 );
		curved = adapter.removeVertex( curved, 'vertex:2' );
		expect( curved.geometry.positions ).toHaveLength( 3 );
	} );
} );

describe( 'TextGeometryAdapter', () => {
	it( 'anchor 与 native 文本内容分别推进，空内容保持 DRAW_TEXT_INPUT_REQUIRED', () => {
		const adapter = new TextGeometryAdapter();
		let draft = adapter.begin( {
			type: 'text', heightReference: HeightReference.CLAMP_TO_TERRAIN,
			options: { content: '', fontSize: 30 },
		} );
		draft = adapter.addPoint( draft, [ 120, 30, 999 ] );
		expect( draft ).toMatchObject( {
			phase: 'drawing', points: [ [ 120, 30, 0 ] ],
			validation: { code: 'DRAW_TEXT_INPUT_REQUIRED' },
		} );
		draft = adapter.setText( draft, '中文\nGIS' );
		expect( draft ).toMatchObject( { phase: 'ready', validation: { valid: true } } );
		const feature = adapter.finish( draft, { id: 'text' } );
		expect( feature ).toMatchObject( {
			geometry: { position: [ 120, 30, 0 ] },
			style: {
				content: '中文\nGIS', fontSize: 30, layoutDirection: 'horizontal',
				anchorX: 'center', anchorY: 'middle',
			},
		} );
	} );

	it( '非法字号、box 与 padding 经 canonical validator 结构化拒绝', () => {
		const adapter = new TextGeometryAdapter();
		let draft = adapter.begin( {
			type: 'text', heightReference: HeightReference.NONE,
			options: { content: 'bad', fontSize: 0, boxWidth: -1, padding: -2 },
		} );
		draft = adapter.addPoint( draft, [ 0, 0, 0 ] );
		expect( draft.validation ).toMatchObject( {
			valid: false, code: 'DRAW_INVALID_PARAMETER',
		} );
	} );

	it( '自适应文本不显示 box handles，显式 box 使用屏幕像素偏移', () => {
		const adapter = new TextGeometryAdapter();
		const finish = ( box: boolean ) => {
			let draft = adapter.begin( {
				type: 'text', heightReference: HeightReference.NONE,
				options: { content: 'label', ...( box ? { boxWidth: 100, boxHeight: 40 } : {} ) },
			} );
			draft = adapter.addPoint( draft, [ 0, 0, 5 ] );
			return adapter.finish( draft, { id: box ? 'fixed' : 'auto' } );
		};
		expect( adapter.listHandles( finish( false ) ).map( ( handle ) => handle.id ) ).toEqual( [
			'center', 'rotation',
		] );
		const fixed = adapter.listHandles( finish( true ) );
		expect( fixed.map( ( handle ) => handle.id ) ).toEqual( [
			'center', 'width', 'height', 'rotation',
		] );
		expect( fixed.find( ( handle ) => handle.id === 'width' )?.screenOffsetCssPixels )
			.toEqual( [ 50, 0 ] );
	} );

	it( 'box 用 CSS 像素 delta，rotation 用 WGS84 heading，center 保持 content', () => {
		const adapter = new TextGeometryAdapter();
		let draft = adapter.begin( {
			type: 'text', heightReference: HeightReference.RELATIVE_TO_TERRAIN,
			options: { content: 'edit', boxWidth: 100, boxHeight: 40 },
		} );
		draft = adapter.addPoint( draft, [ 10, 80, 7 ] );
		let feature = adapter.finish( draft, { id: 'editable', revision: 3 } );
		feature = adapter.applyHandle( feature, 'width', {
			authorPosition: feature.geometry.position, screenDeltaCssPixels: [ 10, 0 ],
		} );
		expect( feature.style.boxWidth ).toBe( 120 );
		feature = adapter.applyHandle( feature, 'height', {
			authorPosition: feature.geometry.position, parameterValue: 55,
		} );
		expect( feature.style.boxHeight ).toBe( 55 );
		feature = adapter.applyHandle( feature, 'rotation', {
			authorPosition: geodesicDestination( feature.geometry.position, 135, 1_000 ),
		} );
		expect( feature.style.rotation ).toBeCloseTo( 135, 6 );
		feature = adapter.applyHandle( feature, 'center', {
			authorPosition: [ 11, 81, 8 ],
		} );
		expect( feature ).toMatchObject( {
			geometry: { position: [ 11, 81, 8 ] }, style: { content: 'edit' }, revision: 7,
		} );
	} );
} );
