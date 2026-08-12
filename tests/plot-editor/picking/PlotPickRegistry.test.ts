import {
	BufferGeometry,
	Float32BufferAttribute,
	Group,
	Mesh,
	MeshBasicMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
	PlotPickRegistry,
	resolvePlotPickMetadata,
	type PlotPickMetadata,
} from '../../../src/lib/plot-editor/picking';
import { EditorOverlayLayer } from '../../../src/lib/plot-editor/render/layers';

function metadata(
	featureId: string,
	source: PlotPickMetadata[ 'source' ],
): PlotPickMetadata {
	return Object.freeze( {
		kind: 'plot-entity', featureId, featureType: 'polygon', source,
		part: 'fill', pickPriority: 0, plotOrder: 0,
	} );
}

function geometry(): BufferGeometry {
	return new BufferGeometry().setAttribute(
		'position',
		new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ),
	);
}

describe( 'PlotPickRegistry', () => {
	it( '子 Mesh 可沿父链解析 feature 元数据，代理只启用 PLOT_PICK', () => {
		const registry = new PlotPickRegistry();
		const root = new Group();
		const child = new Mesh( geometry(), new MeshBasicMaterial() );
		root.add( child );
		registry.replace( {
			metadata: metadata( 'polygon-a', 'proxy' ),
			revision: { featureRevision: 0, resolvedGeometryRevision: 0 },
			targets: [ root ], ownedGeometries: [ child.geometry ],
		} );

		expect( registry.root.children ).toEqual( [ root ] );
		expect( child.layers.isEnabled( EditorOverlayLayer.PLOT_PICK ) ).toBe( true );
		expect( child.layers.isEnabled( 0 ) ).toBe( false );
		expect( resolvePlotPickMetadata( child )?.featureId ).toBe( 'polygon-a' );
		registry.dispose();
	} );

	it( '直接复用显示对象保留原 layer，注销后精确恢复且不释放显示资源', () => {
		const registry = new PlotPickRegistry();
		const root = new Group();
		root.layers.set( 7 );
		const visualGeometry = geometry();
		const dispose = vi.spyOn( visualGeometry, 'dispose' );
		const child = new Mesh( visualGeometry, new MeshBasicMaterial() );
		child.layers.set( 9 );
		root.add( child );
		registry.replace( {
			metadata: metadata( 'visual-a', 'visual' ),
			revision: { featureRevision: 0, resolvedGeometryRevision: 0 },
			targets: [ root ],
		} );

		expect( root.layers.isEnabled( 7 ) ).toBe( true );
		expect( root.layers.isEnabled( EditorOverlayLayer.PLOT_PICK ) ).toBe( true );
		expect( child.layers.isEnabled( 9 ) ).toBe( true );
		expect( registry.remove( 'visual-a' ) ).toBe( true );
		expect( root.layers.mask ).toBe( 1 << 7 );
		expect( child.layers.mask ).toBe( 1 << 9 );
		expect( resolvePlotPickMetadata( root ) ).toBeNull();
		expect( dispose ).not.toHaveBeenCalled();
	} );

	it( '原子替换只保留当前目标，并恰好释放一次旧代理 geometry', () => {
		const registry = new PlotPickRegistry();
		const firstGeometry = geometry();
		const firstDispose = vi.spyOn( firstGeometry, 'dispose' );
		const first = new Mesh( firstGeometry, new MeshBasicMaterial() );
		registry.replace( {
			metadata: metadata( 'same', 'proxy' ),
			revision: { featureRevision: 0, resolvedGeometryRevision: 0 },
			targets: [ first ], ownedGeometries: [ firstGeometry ],
		} );
		const secondGeometry = geometry();
		const secondDispose = vi.spyOn( secondGeometry, 'dispose' );
		const second = new Mesh( secondGeometry, new MeshBasicMaterial() );
		registry.replace( {
			metadata: metadata( 'same', 'proxy' ),
			revision: { featureRevision: 1, resolvedGeometryRevision: 0 },
			targets: [ second ], ownedGeometries: [ secondGeometry ],
		} );

		expect( registry.targets ).toEqual( [ second ] );
		expect( registry.root.children ).toEqual( [ second ] );
		expect( firstDispose ).toHaveBeenCalledOnce();
		registry.dispose();
		registry.dispose();
		expect( secondDispose ).toHaveBeenCalledOnce();
	} );

	it( '共享材质只在 registry 销毁时释放一次', () => {
		const registry = new PlotPickRegistry();
		const material = new MeshBasicMaterial();
		const dispose = vi.spyOn( material, 'dispose' );
		registry.registerSharedMaterial( material );
		registry.registerSharedMaterial( material );
		registry.dispose();
		registry.dispose();
		expect( dispose ).toHaveBeenCalledOnce();
	} );
} );
