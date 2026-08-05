import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { createCameraProjectionSnapshot } from '../../../src/lib/plot-editor/selection/CameraProjectionSnapshot';

describe( 'CameraProjectionSnapshot', () => {
	it( '把世界点稳定投影到 CSS viewport 中心', () => {
		const camera = new PerspectiveCamera( 60, 2, 0.1, 100 );
		camera.position.set( 0, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		camera.updateProjectionMatrix();
		const canvas = {
			clientWidth: 800,
			clientHeight: 400,
			getBoundingClientRect: () => ( { width: 800, height: 400 } ),
		} as HTMLCanvasElement;
		const snapshot = createCameraProjectionSnapshot( {
			camera,
			canvas,
			toWorldPosition: ( position ) => position,
		} );

		const center = snapshot.project( [ 0, 0, 0 ] );
		expect( center ).toMatchObject( { x: 400, y: 200, visible: true } );
		expect( center?.depth ).toBeGreaterThan( 0 );
		expect( center?.depth ).toBeLessThan( 1 );
	} );

	it( '快照不受捕获后的相机和 viewport 修改影响', () => {
		const camera = new PerspectiveCamera( 60, 1, 0.1, 100 );
		camera.position.set( 0, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		camera.updateProjectionMatrix();
		let width = 300;
		const canvas = {
			clientWidth: 300,
			clientHeight: 300,
			getBoundingClientRect: () => ( { width, height: 300 } ),
		} as HTMLCanvasElement;
		const snapshot = createCameraProjectionSnapshot( {
			camera,
			canvas,
			toWorldPosition: ( position ) => position,
		} );
		const before = snapshot.project( [ 1, 0, 0 ] );

		width = 900;
		camera.position.set( 20, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		camera.updateMatrixWorld();

		expect( snapshot.project( [ 1, 0, 0 ] ) ).toEqual( before );
	} );

	it( '拒绝相机后方点并保留遮挡诊断', () => {
		const camera = new PerspectiveCamera( 60, 1, 0.1, 100 );
		camera.position.set( 0, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		camera.updateProjectionMatrix();
		const canvas = {
			clientWidth: 100,
			clientHeight: 100,
			getBoundingClientRect: () => ( { width: 100, height: 100 } ),
		} as HTMLCanvasElement;
		const snapshot = createCameraProjectionSnapshot( {
			camera,
			canvas,
			toWorldPosition: ( position ) => position,
			isOccluded: () => true,
		} );

		expect( snapshot.project( [ 0, 0, 20 ] ) ).toBeNull();
		expect( snapshot.project( [ 0, 0, 0 ] )?.occluded ).toBe( true );
	} );
} );
