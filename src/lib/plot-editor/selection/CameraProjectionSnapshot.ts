import {
	Matrix4,
	Vector4,
	type Camera,
} from 'three';
import { geodeticToEcef, type Vector3Tuple } from '../document/geodesy';
import type { Position3D } from '../document/types';
import type {
	EditorProjectionSnapshot,
	ProjectedEditorPoint,
} from './FeatureHitTester';

export interface CameraProjectionSnapshotOptions {
	readonly camera: Camera;
	readonly canvas: HTMLCanvasElement;
	/** 默认采用 WGS84 ECEF；测试或局部坐标宿主可显式替换。 */
	readonly toWorldPosition?: ( position: Position3D ) => Vector3Tuple;
	readonly isOccluded?: (
		position: Position3D,
		projected: Omit<ProjectedEditorPoint, 'occluded'>,
	) => boolean;
}

/**
 * 捕获相机矩阵和 CSS viewport，后续所有 point/box hit-test 都复用该不可变快照。
 * 这样一次手势不会因宿主在中途更新 camera 而得到互相矛盾的投影结果。
 */
export function createCameraProjectionSnapshot(
	options: CameraProjectionSnapshotOptions,
): EditorProjectionSnapshot {
	const rect = options.canvas.getBoundingClientRect();
	const width = positiveViewportSize( rect.width || options.canvas.clientWidth, 'canvas width' );
	const height = positiveViewportSize( rect.height || options.canvas.clientHeight, 'canvas height' );
	options.camera.updateMatrixWorld();
	const viewProjection = new Matrix4().multiplyMatrices(
		options.camera.projectionMatrix,
		options.camera.matrixWorldInverse,
	);
	const toWorld = options.toWorldPosition ?? geodeticToEcef;
	const occlusion = options.isOccluded;

	return Object.freeze( {
		project( position: Position3D ): ProjectedEditorPoint | null {
			const world = toWorld( position );
			if ( ! world.every( Number.isFinite ) ) return null;
			const clip = new Vector4( world[ 0 ], world[ 1 ], world[ 2 ], 1 )
				.applyMatrix4( viewProjection );
			if ( ! Number.isFinite( clip.w ) || clip.w <= 0 ) return null;
			const inverseW = 1 / clip.w;
			const ndcX = clip.x * inverseW;
			const ndcY = clip.y * inverseW;
			const ndcZ = clip.z * inverseW;
			if ( ! [ ndcX, ndcY, ndcZ ].every( Number.isFinite ) ) return null;
			const projected = Object.freeze( {
				x: ( ndcX + 1 ) * width / 2,
				y: ( 1 - ndcY ) * height / 2,
				depth: ( ndcZ + 1 ) / 2,
				visible: ndcZ >= -1 && ndcZ <= 1,
			} );
			const occluded = occlusion?.( position, projected );
			return Object.freeze( {
				...projected,
				...( occluded === undefined ? {} : { occluded } ),
			} );
		},
	} );
}

function positiveViewportSize( value: number, name: string ): number {
	if ( ! Number.isFinite( value ) || value <= 0 ) {
		throw new RangeError( `${ name } 必须是正有限数。` );
	}
	return value;
}
