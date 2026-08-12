import type { Camera, Object3D } from 'three';
import { CESIUM_GROUND_NON_PICKABLE_LAYER } from '../../ground';

/**
 * 编辑 Overlay 的专用 Three layer。
 *
 * 数值集中在一个模块，避免 renderer、业务拾取器和宿主相机各自硬编码。
 */
export const EditorOverlayLayer = Object.freeze( {
	PLOT_CONTENT: 24,
	PLOT_HANDLE: 25,
	PLOT_GIZMO: 26,
	PLOT_FEEDBACK: 27,
	/** 仅供实体 Raycaster 使用；渲染相机租约绝不能启用此层。 */
	PLOT_PICK: 28,
} as const );

export type EditorOverlayLayer =
	typeof EditorOverlayLayer[ keyof typeof EditorOverlayLayer ];

const MANAGED_CAMERA_LAYERS = Object.freeze( [
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	EditorOverlayLayer.PLOT_CONTENT,
	EditorOverlayLayer.PLOT_HANDLE,
	EditorOverlayLayer.PLOT_GIZMO,
	EditorOverlayLayer.PLOT_FEEDBACK,
] );

/** 只记录编辑器管理位，dispose 时不会覆盖宿主运行期修改的其它 camera layer。 */
export class EditorCameraLayerLease {
	private readonly _camera: Camera;
	private readonly _previousBits: number;
	private _released = false;

	public constructor( camera: Camera ) {
		this._camera = camera;
		this._previousBits = camera.layers.mask & managedMask();
		for ( const layer of MANAGED_CAMERA_LAYERS ) camera.layers.enable( layer );
	}

	public release(): void {
		if ( this._released ) return;
		this._released = true;
		this._camera.layers.mask = ( this._camera.layers.mask & ~managedMask() )
			| this._previousBits;
	}
}

/**
 * 将默认 layer 0 的普通/RTE 图元迁入编辑 layer；Ground 内部 layer 1 保持不变，
 * 因为 classification 图元依赖该既有隔离契约。
 */
export function isolateOverlayObjects( root: Object3D, target: EditorOverlayLayer ): void {
	root.layers.set( target );
	root.traverse( ( object ) => {
		if ( object === root ) return;
		if ( object.layers.mask === 1 || isEditorLayerMask( object.layers.mask ) ) {
			object.layers.set( target );
		}
	} );
}

export function editorOverlayLayerMask(): number {
	return managedMask() & ~ ( 1 << CESIUM_GROUND_NON_PICKABLE_LAYER );
}

function managedMask(): number {
	let mask = 0;
	for ( const layer of MANAGED_CAMERA_LAYERS ) mask |= 1 << layer;
	return mask;
}

function isEditorLayerMask( mask: number ): boolean {
	return ( mask & editorOverlayLayerMask() ) !== 0;
}
