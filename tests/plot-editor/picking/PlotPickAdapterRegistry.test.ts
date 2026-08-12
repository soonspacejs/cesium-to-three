import { MeshBasicMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature, type ResolvedPlotGeometry } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { PlotPickAdapterRegistry, PlotPickRegistry } from '../../../src/lib/plot-editor/picking';

function circle( revision = 0, visible = true ): PlotFeature {
	return normalizeFeature( { id: 'circle', type: 'circle', geometry: { center: [ 116, 39, 0 ], radius: 100 },
		style: { strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
			fillColor: '#765432', fillOpacity: 80 }, heightReference: HeightReference.CLAMP_TO_GROUND,
		visible, properties: {}, revision } );
}

function createSyncer( registry: PlotPickRegistry, onBuildError = vi.fn() ) {
	return { syncer: new PlotPickAdapterRegistry( { registry,
		adapters: createBuiltinGeometryAdapterRegistry(), measureText: ( value, size ) => value.length * size,
		onBuildError } ), onBuildError };
}

describe( 'PlotPickAdapterRegistry', () => {
	it( '静止 sync 不重建，单 feature revision 只替换该代理', () => {
		const registry = new PlotPickRegistry();
		const { syncer } = createSyncer( registry );
		syncer.sync( [ circle() ], new Map() );
		const first = registry.targets[ 0 ];
		syncer.sync( [ circle() ], new Map() );
		expect( registry.targets[ 0 ] ).toBe( first );
		syncer.sync( [ circle( 1 ) ], new Map() );
		expect( registry.targets[ 0 ] ).not.toBe( first );
		expect( registry.size ).toBe( 1 );
	} );

	it( 'resolved surface height 变化替换旧代理，隐藏和删除立即注销', () => {
		const registry = new PlotPickRegistry();
		const { syncer } = createSyncer( registry );
		const resolved = ( height: number ): ResolvedPlotGeometry => Object.freeze( {
			plotId: 'circle', sourceRevision: 0, status: 'ready',
			effectivePositions: Object.freeze( [ [ 116, 39, height ] ] ),
		} );
		syncer.sync( [ circle() ], new Map( [ [ 'circle', resolved( 10 ) ] ] ) );
		const first = registry.targets[ 0 ];
		syncer.sync( [ circle() ], new Map( [ [ 'circle', resolved( 20 ) ] ] ) );
		expect( registry.targets[ 0 ] ).not.toBe( first );
		syncer.sync( [ circle( 0, false ) ], new Map() );
		expect( registry.targets ).toEqual( [] );
		syncer.sync( [], new Map() );
		expect( registry.size ).toBe( 0 );
	} );

	it( '候选构建失败保留上一版 entry 并上报诊断', () => {
		const registry = new PlotPickRegistry();
		const { syncer, onBuildError } = createSyncer( registry );
		syncer.sync( [ circle() ], new Map() );
		const first = registry.targets[ 0 ];
		// 人为处置共享材质不会让构建失败，因此通过非法零半径 revision 触发规范化前置失败不可行；
		// 这里替换 registry.replace，精确模拟候选完整后原子写入失败。
		const replace = vi.spyOn( registry, 'replace' ).mockImplementationOnce( () => { throw new Error( 'GPU failure' ); } );
		syncer.sync( [ circle( 1 ) ], new Map() );
		expect( registry.targets[ 0 ] ).toBe( first );
		expect( onBuildError ).toHaveBeenCalledOnce();
		replace.mockRestore();
	} );

	it( '共享代理材质由底层 registry 统一拥有', () => {
		const registry = new PlotPickRegistry();
		const dispose = vi.spyOn( MeshBasicMaterial.prototype, 'dispose' );
		createSyncer( registry );
		registry.dispose();
		expect( dispose ).toHaveBeenCalled();
		dispose.mockRestore();
	} );
} );
