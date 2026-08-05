import { Group, Mesh, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CESIUM_GROUND_NON_PICKABLE_LAYER } from '../../../src/lib/ground';
import {
	EditorCameraLayerLease,
	EditorOverlayLayer,
	editorOverlayLayerMask,
	isolateOverlayObjects,
} from '../../../src/lib/plot-editor/render/layers';

describe( 'editor overlay layers', () => {
	it( '租约开启内部 Ground 与四个 Overlay layer，释放时精确恢复原有位', () => {
		const camera = new PerspectiveCamera();
		camera.layers.enable( EditorOverlayLayer.PLOT_HANDLE );
		camera.layers.enable( 7 );
		const lease = new EditorCameraLayerLease( camera );
		for ( const layer of [
			CESIUM_GROUND_NON_PICKABLE_LAYER,
			EditorOverlayLayer.PLOT_CONTENT,
			EditorOverlayLayer.PLOT_HANDLE,
			EditorOverlayLayer.PLOT_GIZMO,
			EditorOverlayLayer.PLOT_FEEDBACK,
		] ) expect( camera.layers.isEnabled( layer ) ).toBe( true );

		// 宿主在租约期间新开的非管理 layer 必须保留。
		camera.layers.enable( 8 );
		lease.release();
		lease.release();
		expect( camera.layers.isEnabled( 7 ) ).toBe( true );
		expect( camera.layers.isEnabled( 8 ) ).toBe( true );
		expect( camera.layers.isEnabled( EditorOverlayLayer.PLOT_HANDLE ) ).toBe( true );
		expect( camera.layers.isEnabled( EditorOverlayLayer.PLOT_CONTENT ) ).toBe( false );
		expect( camera.layers.isEnabled( CESIUM_GROUND_NON_PICKABLE_LAYER ) ).toBe( false );
	} );

	it( '把默认图元隔离到目标 layer，但不破坏 Ground layer 1', () => {
		const root = new Group();
		const plain = new Mesh();
		const ground = new Mesh();
		ground.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		root.add( plain, ground );
		isolateOverlayObjects( root, EditorOverlayLayer.PLOT_CONTENT );
		expect( root.layers.isEnabled( EditorOverlayLayer.PLOT_CONTENT ) ).toBe( true );
		expect( plain.layers.isEnabled( EditorOverlayLayer.PLOT_CONTENT ) ).toBe( true );
		expect( ground.layers.isEnabled( CESIUM_GROUND_NON_PICKABLE_LAYER ) ).toBe( true );
		expect( ground.layers.isEnabled( EditorOverlayLayer.PLOT_CONTENT ) ).toBe( false );
		expect( editorOverlayLayerMask() ).not.toBe( 0 );
	} );
} );
