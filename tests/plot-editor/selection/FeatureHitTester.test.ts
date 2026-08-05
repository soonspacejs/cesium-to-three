import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import {
	FeatureHitTester,
	type EditorProjectionSnapshot,
} from '../../../src/lib/plot-editor/selection/FeatureHitTester';

const STYLE = Object.freeze( {
	strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#3388ff', fillOpacity: 30,
} );

function feature(
	id: string,
	type: PlotFeature[ 'type' ],
	geometry: object,
	patch: Record<string, unknown> = {},
): PlotFeature {
	const style = type === 'point'
		? { ...STYLE, pointStyle: 'circle', size: 12 }
		: type === 'text'
			? {
				...STYLE, content: '测试', fontColor: '#fff', fontSize: 16, scale: 1,
				textAlign: 'center', verticalAlign: 'middle', anchorX: 'center',
				anchorY: 'middle', padding: 2, layoutDirection: 'horizontal',
				rotation: 0, offsetX: 0, offsetY: 0, showBorder: false,
			}
			: type === 'line'
				? {
					...STYLE, strokeStyle: 'solid', showArrow: false,
					startArrowStyle: null, endArrowStyle: null,
				}
				: STYLE;
	return normalizeFeature( {
		id, type, geometry, style,
		heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0,
		...patch,
	} );
}

function projection(
	options: { readonly occludeHeight?: number } = {},
): EditorProjectionSnapshot {
	return Object.freeze( {
		project: ( position: readonly [ number, number, number ] ) => Object.freeze( {
			x: position[ 0 ] * 100,
			y: position[ 1 ] * 100,
			depth: 1 + position[ 2 ] / 1000,
			visible: true,
			occluded: options.occludeHeight === position[ 2 ],
		} ),
	} );
}

function setup( features: readonly PlotFeature[] ) {
	const document = createPlotDocumentStore( { id: 'hit-test', features } );
	return {
		document,
		tester: new FeatureHitTester( document, createBuiltinGeometryAdapterRegistry() ),
	};
}

describe( 'FeatureHitTester.hitTest', () => {
	it( '活动控制点、Gizmo、普通控制点、proxy、CPU 按固定层级决胜', () => {
		const line = feature( 'line', 'line', { positions: [ [ 0, 0, 0 ], [ 1, 0, 0 ] ] } );
		const { tester } = setup( [ line ] );
		const overlayHits = [ {
			layer: 'gizmo' as const,
			target: {
				kind: 'gizmo' as const, entityId: 'line', handleId: 'east',
				distanceCssPixels: 7, depth: 0.5,
			},
		} ];

		expect( tester.hitTest( { x: 1, y: 0 }, projection(), {
			selectedIds: [ 'line' ], overlayHits,
		} ) ).toMatchObject( { kind: 'gizmo', handleId: 'east' } );
		expect( tester.hitTest( { x: 1, y: 0 }, projection(), {
			selectedIds: [ 'line' ], activeHandleId: 'vertex:0', overlayHits,
		} ) ).toMatchObject( { kind: 'vertex', handleId: 'vertex:0' } );
	} );

	it( '控制点使用 CSS 像素半径，触摸命中区域为 14px', () => {
		const line = feature( 'line', 'line', { positions: [ [ 0, 0, 0 ], [ 1, 0, 0 ] ] } );
		const { tester } = setup( [ line ] );
		expect( tester.hitTest( { x: 13, y: 0 }, projection(), {
			selectedIds: [ 'line' ], pointerType: 'mouse', entityToleranceCssPixels: 0,
		} )?.kind ).toBe( 'entity' );
		expect( tester.hitTest( { x: 13, y: 0 }, projection(), {
			selectedIds: [ 'line' ], pointerType: 'touch', entityToleranceCssPixels: 0,
		} ) ).toMatchObject( { kind: 'vertex', handleId: 'vertex:0' } );
	} );

	it( 'point/text 使用 anchor，线使用屏幕线段，polygon/circle 使用填充区域', () => {
		const features = [
			feature( 'point', 'point', { position: [ -2, 0, 0 ] } ),
			feature( 'text', 'text', { position: [ -1, 0, 0 ] } ),
			feature( 'line', 'line', { positions: [ [ 0, 0, 0 ], [ 1, 0, 0 ] ] } ),
			feature( 'polygon', 'polygon', {
				positions: [ [ 2, 0, 0 ], [ 3, 0, 0 ], [ 2.5, 1, 0 ] ],
			} ),
			feature( 'circle', 'circle', { center: [ 4, 0, 0 ], radius: 50_000 } ),
		];
		const { tester } = setup( features );
		expect( tester.hitTest( { x: -200, y: 0 }, projection() )?.entityId ).toBe( 'point' );
		expect( tester.hitTest( { x: -100, y: 0 }, projection() )?.entityId ).toBe( 'text' );
		expect( tester.hitTest( { x: 50, y: 3 }, projection() )?.entityId ).toBe( 'line' );
		expect( tester.hitTest( { x: 250, y: 30 }, projection() )?.entityId ).toBe( 'polygon' );
		expect( tester.hitTest( { x: 400, y: 0 }, projection() )?.entityId ).toBe( 'circle' );
	} );

	it( 'CPU 深度标记 approximate；显式 proxy 保留精确深度', () => {
		const point = feature( 'point', 'point', { position: [ 0, 0, 0 ] } );
		const { tester } = setup( [ point ] );
		expect( tester.hitTest( { x: 0, y: 0 }, projection() ) ).toMatchObject( {
			entityId: 'point', depthApproximate: true,
		} );
		expect( tester.hitTest( { x: 0, y: 0 }, projection(), {
			overlayHits: [ {
				layer: 'entity-proxy',
				target: {
					kind: 'entity', entityId: 'point', distanceCssPixels: 0, depth: 0.2,
				},
			} ],
		} ) ).toMatchObject( { entityId: 'point', depthApproximate: false } );
	} );

	it( '默认排除 hidden/locked/readonly/occluded，selectThrough 仅显式开启', () => {
		const features = [
			feature( 'hidden', 'point', { position: [ 0, 0, 0 ] }, { visible: false } ),
			feature( 'locked', 'point', { position: [ 0, 0, 0 ] }, { properties: { locked: true } } ),
			feature( 'readonly', 'point', { position: [ 0, 0, 0 ] }, { properties: { editable: false } } ),
			feature( 'occluded', 'point', { position: [ 0, 0, 5 ] } ),
		];
		const { tester } = setup( features );
		expect( tester.hitTest( { x: 0, y: 0 }, projection( { occludeHeight: 5 } ) ) ).toBeNull();
		expect( tester.hitTest( { x: 0, y: 0 }, projection( { occludeHeight: 5 } ), {
			filter: { selectThrough: true },
		} )?.entityId ).toBe( 'occluded' );
	} );
} );

describe( 'FeatureHitTester.selectBox', () => {
	it( 'intersects 支持反向拖拽、穿过矩形的线和包围框选框的面', () => {
		const features = [
			feature( 'crossing-line', 'line', { positions: [ [ -2, 0, 0 ], [ 2, 0, 0 ] ] } ),
			feature( 'surrounding-polygon', 'polygon', {
				positions: [ [ -2, -2, 0 ], [ 2, -2, 0 ], [ 2, 2, 0 ], [ -2, 2, 0 ] ],
			} ),
			feature( 'outside', 'point', { position: [ 5, 5, 0 ] } ),
		];
		const { tester } = setup( features );
		expect( tester.selectBox(
			{ x: 50, y: 50 }, { x: -50, y: -50 }, projection(),
		).ids ).toEqual( [ 'crossing-line', 'surrounding-polygon' ] );
		expect( tester.selectBox(
			{ x: 50, y: 50 }, { x: -50, y: -50 }, projection(), { mode: 'contains' },
		).ids ).toEqual( [] );
	} );

	it( 'contains 要求全部投影点在框内，并遵守遮挡过滤', () => {
		const features = [
			feature( 'inside', 'line', { positions: [ [ 0, 0, 0 ], [ 0.5, 0.5, 0 ] ] } ),
			feature( 'partial', 'line', { positions: [ [ 0, 0, 0 ], [ 2, 2, 0 ] ] } ),
			feature( 'occluded', 'point', { position: [ 0.25, 0.25, 5 ] } ),
		];
		const { tester } = setup( features );
		expect( tester.selectBox(
			{ x: -10, y: -10 }, { x: 100, y: 100 }, projection( { occludeHeight: 5 } ),
			{ mode: 'contains' },
		).ids ).toEqual( [ 'inside' ] );
		expect( tester.selectBox(
			{ x: -10, y: -10 }, { x: 100, y: 100 }, projection( { occludeHeight: 5 } ),
			{ mode: 'contains', filter: { selectThrough: true } },
		).ids ).toEqual( [ 'inside', 'occluded' ] );
	} );

	it( '超过上限按 document order 截断并报告 BOX_SELECTION_LIMIT', () => {
		const features = [ 'a', 'b', 'c' ].map(
			( id, index ) => feature( id, 'point', { position: [ index, 0, 0 ] } ),
		);
		const { tester } = setup( features );
		const onDiagnostic = vi.fn();
		const result = tester.selectBox(
			{ x: -10, y: -10 }, { x: 500, y: 10 }, projection(),
			{ maxCandidates: 2, onDiagnostic },
		);
		expect( result ).toEqual( {
			ids: [ 'a', 'b' ], truncated: true, examinedCandidates: 2,
		} );
		expect( onDiagnostic ).toHaveBeenCalledWith( expect.objectContaining( {
			code: 'BOX_SELECTION_LIMIT', candidateCount: 3, maxCandidates: 2,
		} ) );
	} );
} );
