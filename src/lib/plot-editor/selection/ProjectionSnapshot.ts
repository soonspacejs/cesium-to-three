import type { Position3D } from '../document/types';
import type { ScreenPoint } from '../state/types';

export interface ProjectedEditorPoint extends ScreenPoint {
	readonly depth: number;
	readonly visible: boolean;
	readonly occluded?: boolean;
}

/** 一次手势复用同一投影快照，避免相机更新造成框选边界抖动。 */
export interface EditorProjectionSnapshot {
	project( position: Position3D ): ProjectedEditorPoint | null;
}
