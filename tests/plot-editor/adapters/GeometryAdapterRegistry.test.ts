import { describe, expect, it } from 'vitest';
import { GeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/GeometryAdapterRegistry';
import type { GeometryAdapter } from '../../../src/lib/plot-editor/adapters/types';

function adapter( kind: 'point' | 'line' ): GeometryAdapter {
	return {
		kind,
		capabilities: {
			editable: true, editVertices: true, insertVertices: false,
			removeVertices: false, translate: true, rotateHeading: false,
			rotatePitchRoll: false, scaleHorizontal: false, scaleVertical: false,
			parameterHandles: [],
		},
		begin: () => ( {} as never ), addPoint: () => ( {} as never ),
		movePointer: () => ( {} as never ), removeLastPoint: () => ( {} as never ),
		validateDraft: () => ( { valid: false } ), canFinish: () => false,
		finish: () => ( {} as never ), cancel: () => undefined,
		preview: () => ( {} as never ), listHandles: () => [],
		applyHandle: () => ( {} as never ), removeVertex: () => ( {} as never ),
		toRenderDescription: () => ( {} as never ), toJSON: () => ( {} ),
	};
}

describe( 'GeometryAdapterRegistry', () => {
	it( '按八类稳定顺序注册、查询和移除', () => {
		const registry = new GeometryAdapterRegistry();
		const line = adapter( 'line' );
		const point = adapter( 'point' );
		registry.register( line );
		registry.register( point );
		expect( registry.kinds ).toEqual( [ 'point', 'line' ] );
		expect( registry.require( 'line' ) ).toBe( line );
		expect( registry.size ).toBe( 2 );
		expect( registry.unregister( 'point' ) ).toBe( true );
		expect( registry.has( 'point' ) ).toBe( false );
	} );

	it( '拒绝重复、未注册和 model/3D Tiles reference kind', () => {
		const registry = new GeometryAdapterRegistry();
		registry.register( adapter( 'point' ) );
		expect( () => registry.register( adapter( 'point' ) ) ).toThrow( /已注册/ );
		expect( () => registry.require( 'circle' ) ).toThrow( /UNSUPPORTED_GRAPHICS_KIND/ );
		expect( () => registry.register( {
			...adapter( 'point' ), kind: 'model',
		} as unknown as GeometryAdapter ) ).toThrow( /UNSUPPORTED_GRAPHICS_KIND/ );
	} );
} );
