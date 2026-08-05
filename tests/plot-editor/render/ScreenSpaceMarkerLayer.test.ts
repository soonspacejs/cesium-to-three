import {
	BufferGeometry,
	Matrix4,
	Mesh,
	RawShaderMaterial,
	Vector2,
	Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
	ScreenSpaceMarkerLayer,
	type MarkerViewportState,
	type ScreenSpaceMarkerDescription,
} from '../../../src/lib/plot-editor/render/ScreenSpaceMarkerLayer';

const BASE_MARKER: ScreenSpaceMarkerDescription = Object.freeze( {
	id: 'handle:0',
	entityId: 'feature-a',
	handleId: 'vertex:0',
	position: [ 116.3913, 39.9075, 35 ],
	shape: 'circle',
	fillColor: '#ffffff',
	borderColor: '#1473e6',
	sizeCssPixels: 12,
	pickRadiusCssPixels: 8,
	priority: 300,
	visible: true,
} );

function viewport( devicePixelRatio = 1 ): MarkerViewportState {
	return {
		widthDevicePixels: 1280 * devicePixelRatio,
		heightDevicePixels: 720 * devicePixelRatio,
		devicePixelRatio,
		cameraPositionEcef: [ 6378137, 1000, 2000 ],
		viewProjectionRotation: new Matrix4().makeRotationX( 0.2 ).toArray(),
		projectionMatrix: new Matrix4().makePerspective( -1, 1, 1, -1, 1, 1e8 ).toArray(),
	};
}

function onlyMesh( layer: ScreenSpaceMarkerLayer ): Mesh<BufferGeometry, RawShaderMaterial> {
	return layer.root.children[ 0 ] as Mesh<BufferGeometry, RawShaderMaterial>;
}

describe( 'ScreenSpaceMarkerLayer', () => {
	it( '使用 RTE 锚点与 CSS 像素 uniform，不把大地坐标写入普通 position', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotHandleRoot', 25 );
		layer.sync( [ BASE_MARKER ] );
		const mesh = onlyMesh( layer );
		expect( mesh.geometry.getAttribute( 'position' ) ).toBeUndefined();
		expect( mesh.geometry.getAttribute( 'position3DHigh' ) ).toBeDefined();
		expect( mesh.geometry.getAttribute( 'position3DLow' ) ).toBeDefined();
		expect( mesh.geometry.getAttribute( 'corner' ).count ).toBe( 4 );

		layer.update( viewport( 2 ) );
		expect( mesh.material.uniforms.u_sizeCss.value ).toBe( 12 );
		expect( mesh.material.uniforms.u_devicePixelRatio.value ).toBe( 2 );
		expect( mesh.material.uniforms.u_viewportDevice.value ).toEqual( new Vector2( 2560, 1440 ) );
		expect( mesh.material.uniforms.u_cameraHigh.value ).toBeInstanceOf( Vector3 );
	} );

	it( '写入稳定业务拾取代理并隔离到专用 layer', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotHandleRoot', 25 );
		layer.sync( [ BASE_MARKER ] );
		const mesh = onlyMesh( layer );
		expect( mesh.layers.test( layer.root.layers ) ).toBe( true );
		expect( mesh.userData.editorPickProxy ).toEqual( {
			entityId: 'feature-a', handleId: 'vertex:0', priority: 300, pickRadiusCssPixels: 8,
			screenOffsetCssPixels: [ 0, 0 ],
			shape: 'circle', sizeCssPixels: 12,
		} );
	} );

	it( '为平移轴、缩放轴和旋转环生成独立 shader 形状', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotGizmoRoot', 26 );
		layer.sync( [
			{ ...BASE_MARKER, id: 'east', shape: 'axis-east' },
			{ ...BASE_MARKER, id: 'scale-up', shape: 'scale-up' },
			{ ...BASE_MARKER, id: 'heading', shape: 'ring' },
		] );
		expect( layer.root.children.map( ( child ) =>
			( child as Mesh<BufferGeometry, RawShaderMaterial> ).material.uniforms.u_shape.value,
		) ).toEqual( [ 4, 9, 3 ] );
	} );

	it( '普通遮挡控制点淡化，活动控制点始终置顶可见', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotHandleRoot', 25 );
		layer.sync( [ { ...BASE_MARKER, occluded: true } ] );
		let mesh = onlyMesh( layer );
		const sameMesh = mesh;
		const sameGeometry = mesh.geometry;
		const sameMaterial = mesh.material;
		expect( mesh.material.uniforms.u_fill.value.w ).toBe( 0.35 );
		expect( mesh.material.depthTest ).toBe( true );
		expect( mesh.material.transparent ).toBe( true );

		layer.sync( [ { ...BASE_MARKER, occluded: true, active: true } ] );
		mesh = onlyMesh( layer );
		expect( mesh ).toBe( sameMesh );
		expect( mesh.geometry ).toBe( sameGeometry );
		expect( mesh.material ).toBe( sameMaterial );
		expect( mesh.material.uniforms.u_fill.value.w ).toBe( 1 );
		expect( mesh.material.depthTest ).toBe( false );
	} );

	it( '相同描述保留对象；变化时先建候选再释放旧 GPU 资源', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotHandleRoot', 25 );
		layer.sync( [ BASE_MARKER ] );
		const previous = onlyMesh( layer );
		const geometryDispose = vi.spyOn( previous.geometry, 'dispose' );
		const materialDispose = vi.spyOn( previous.material, 'dispose' );
		layer.sync( [ { ...BASE_MARKER } ] );
		expect( onlyMesh( layer ) ).toBe( previous );
		expect( geometryDispose ).not.toHaveBeenCalled();

		layer.sync( [ { ...BASE_MARKER, position: [ 116.4, 39.9, 40 ] } ] );
		expect( onlyMesh( layer ) ).not.toBe( previous );
		expect( geometryDispose ).toHaveBeenCalledOnce();
		expect( materialDispose ).toHaveBeenCalledOnce();
	} );

	it( '拒绝重复 id 与非法 viewport；dispose 幂等且禁止再次写入', () => {
		const layer = new ScreenSpaceMarkerLayer( 'plotHandleRoot', 25 );
		layer.sync( [ BASE_MARKER ] );
		const previous = onlyMesh( layer );
		expect( () => layer.sync( [
			{ ...BASE_MARKER, fillColor: '#ff0000' },
			BASE_MARKER,
		] ) ).toThrow( /MARKER_ID_CONFLICT/ );
		expect( onlyMesh( layer ) ).toBe( previous );
		expect( previous.material.uniforms.u_fill.value.y ).toBeCloseTo( 1 );
		expect( () => layer.update( { ...viewport(), widthDevicePixels: 0 } ) ).toThrow( /MARKER_VIEWPORT_INVALID/ );
		layer.dispose();
		layer.dispose();
		expect( layer.root.children ).toHaveLength( 0 );
		expect( () => layer.sync( [] ) ).toThrow( /已销毁/ );
	} );
} );
