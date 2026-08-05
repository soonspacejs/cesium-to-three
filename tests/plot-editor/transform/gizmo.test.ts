import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import {
	computeSelectionPivot,
	createGizmoHandleDescriptions,
	getSelectionGizmoCapabilities,
} from '../../../src/lib/plot-editor/transform/gizmo';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );
const adapters = createBuiltinGeometryAdapterRegistry();

function circle( id: string, center: readonly [ number, number, number ], heightReference = HeightReference.NONE ): PlotFeature {
	return normalizeFeature( {
		id, type: 'circle', geometry: { center, radius: 100 }, style: STYLE,
		heightReference, visible: true, properties: {}, revision: 0,
	} );
}

function line( id: string, heightReference = HeightReference.NONE ): PlotFeature {
	return normalizeFeature( {
		id, type: 'line', geometry: { positions: [ [ 0, 89.9, 0 ], [ 1, 89.9, 0 ] ] },
		style: {
			...STYLE, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null,
		},
		heightReference, visible: true, properties: {}, revision: 0,
	} );
}

describe( 'selection ENU gizmo', () => {
	it( '单选 pivot 使用 adapter center，极区 frame 三轴有限且正交', () => {
		const source = line( 'polar' );
		const pivot = computeSelectionPivot( [ source ], adapters, { primaryId: 'polar' } );
		for ( const axis of [ pivot.frame.east, pivot.frame.north, pivot.frame.up ] ) {
			expect( axis.every( Number.isFinite ) ).toBe( true );
			expect( Math.hypot( ...axis ) ).toBeCloseTo( 1, 12 );
		}
		const dot = ( a: readonly number[], b: readonly number[] ) =>
			a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
		expect( dot( pivot.frame.east, pivot.frame.north ) ).toBeCloseTo( 0, 12 );
		expect( dot( pivot.frame.north, pivot.frame.up ) ).toBeCloseTo( 0, 12 );
	} );

	it( '近似对跖多选回退 primary 并发出 PIVOT_FALLBACK_PRIMARY', () => {
		const first = circle( 'first', [ 0, 0, 5 ] );
		const opposite = circle( 'opposite', [ -180, 0, 9 ] );
		const onDiagnostic = vi.fn();
		const pivot = computeSelectionPivot( [ first, opposite ], adapters, {
			primaryId: 'opposite', onDiagnostic,
		} );
		expect( pivot.fallbackToPrimary ).toBe( true );
		expect( pivot.position ).toEqual( [ -180, 0, 9 ] );
		expect( onDiagnostic ).toHaveBeenCalledWith( expect.objectContaining( {
			code: 'PIVOT_FALLBACK_PRIMARY', primaryId: 'opposite',
		} ) );
	} );

	it( '多选能力取交集，clamp 禁用 Up/pitch/roll/vertical scale', () => {
		const capabilities = getSelectionGizmoCapabilities( [
			line( 'absolute' ), line( 'clamp', HeightReference.CLAMP_TO_3D_TILE ),
		], adapters );
		expect( capabilities ).toMatchObject( {
			translateEast: true, translateNorth: true, translateUp: false,
			rotateHeading: true, rotatePitch: false, rotateRoll: false,
			scaleHorizontal: true, scaleVertical: false, editVertices: false,
		} );
	} );

	it( '禁用 Gizmo handle 完全不可见/不可拾取，启用尺寸保持 CSS 常量', () => {
		const capabilities = getSelectionGizmoCapabilities( [
			line( 'clamp', HeightReference.CLAMP_TO_GROUND ),
		], adapters );
		const handles = createGizmoHandleDescriptions( 'translate', capabilities );
		const east = handles.find( ( handle ) => handle.id === 'translate:east' )!;
		const up = handles.find( ( handle ) => handle.id === 'translate:up' )!;
		expect( east ).toMatchObject( {
			visible: true, enabled: true, pickable: true,
			screenSizeCssPixels: 72, pickRadiusCssPixels: 8,
		} );
		expect( up ).toMatchObject( {
			visible: false, enabled: false, pickable: false,
		} );
		expect( up.disabledReason ).toContain( 'Up' );
	} );
} );
