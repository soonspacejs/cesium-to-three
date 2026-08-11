import { PerspectiveCamera, Raycaster } from 'three';
import { describe, expect, it } from 'vitest';
import {
	closestRayAxisParameterMeters,
	rayPlaneDirection,
	rayPlaneOffsetMeters,
	screenRayAxisParameterMeters,
	signedPlaneAngleDegrees,
	unwrapAngleDegrees,
} from '../../../src/lib/plot-editor/transform/pointer-axis';

describe( 'pointer axis projection', () => {
	it( '相机射线与 Up 轴相交时返回交点的有符号米制参数', () => {
		expect( closestRayAxisParameterMeters(
			[ 10, 0, 5 ], [ -1, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 1 ],
		) ).toBeCloseTo( 5, 12 );
		expect( closestRayAxisParameterMeters(
			[ 10, 0, -3 ], [ -2, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 4 ],
		) ).toBeCloseTo( -3, 12 );
	} );

	it( '平行、退化、非有限或射线背向时拒绝不稳定结果', () => {
		expect( closestRayAxisParameterMeters(
			[ 0, 0, 10 ], [ 0, 0, -1 ], [ 0, 0, 0 ], [ 0, 0, 1 ],
		) ).toBeNull();
		expect( closestRayAxisParameterMeters(
			[ 10, 0, 5 ], [ 1, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 1 ],
		) ).toBeNull();
		expect( closestRayAxisParameterMeters(
			[ 10, 0, 5 ], [ 0, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 1 ],
		) ).toBeNull();
		expect( closestRayAxisParameterMeters(
			[ Number.NaN, 0, 0 ], [ -1, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 1 ],
		) ).toBeNull();
	} );

	it( '屏幕垂直拖动通过当前相机射线改变轴参数，不依赖 surface hit', () => {
		const camera = new PerspectiveCamera( 60, 4 / 3, 0.1, 1_000 );
		camera.position.set( 10, 10, 10 );
		camera.lookAt( 0, 0, 0 );
		camera.updateProjectionMatrix();
		const canvas = {
			clientWidth: 800,
			clientHeight: 600,
			getBoundingClientRect: () => ( {
				left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
				x: 0, y: 0, toJSON: () => ( {} ),
			} ),
		} as unknown as HTMLCanvasElement;
		const raycaster = new Raycaster();
		const common = {
			raycaster, camera, canvas,
			axisOrigin: [ 0, 0, 0 ] as const,
			axisDirection: [ 0, 0, 1 ] as const,
		};
		const start = screenRayAxisParameterMeters( {
			...common, screen: { x: 400, y: 300 },
		} );
		const raised = screenRayAxisParameterMeters( {
			...common, screen: { x: 400, y: 240 },
		} );
		expect( start ).toBeCloseTo( 0, 10 );
		expect( raised ).not.toBeNull();
		expect( Math.abs( raised! - start! ) ).toBeGreaterThan( 0.5 );
	} );

	it( '射线与旋转平面相交后返回 pivot 径向单位向量', () => {
		const offset = rayPlaneOffsetMeters(
			[ 10, 2, 3 ], [ -1, 0, 0 ], [ 0, 0, 0 ], [ 1, 0, 0 ],
		);
		expect( offset ).toEqual( [ 0, 2, 3 ] );
		const direction = rayPlaneDirection(
			[ 10, 2, 3 ], [ -1, 0, 0 ], [ 0, 0, 0 ], [ 1, 0, 0 ],
		);
		expect( direction ).not.toBeNull();
		expect( direction?.[ 0 ] ).toBeCloseTo( 0, 12 );
		expect( direction?.[ 1 ] ).toBeCloseTo( 2 / Math.sqrt( 13 ), 12 );
		expect( direction?.[ 2 ] ).toBeCloseTo( 3 / Math.sqrt( 13 ), 12 );
		expect( rayPlaneDirection(
			[ 10, 2, 3 ], [ 0, 1, 0 ], [ 0, 0, 0 ], [ 1, 0, 0 ],
		) ).toBeNull();
		expect( rayPlaneOffsetMeters(
			[ 10, 2, 3 ], [ 1, 0, 0 ], [ 0, 0, 0 ], [ 1, 0, 0 ],
		) ).toBeNull();
	} );

	it( '平面有符号角按 normal 定向，并在跨 ±180° 时连续 unwrap', () => {
		expect( signedPlaneAngleDegrees(
			[ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ],
		) ).toBeCloseTo( 90, 12 );
		expect( signedPlaneAngleDegrees(
			[ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, -1 ],
		) ).toBeCloseTo( -90, 12 );
		expect( unwrapAngleDegrees( 179, 179, -179 ) ).toBe( 181 );
		expect( unwrapAngleDegrees( -179, -179, 179 ) ).toBe( -181 );
	} );
} );
