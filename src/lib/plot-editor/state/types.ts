import type { PlotFeatureId, PlotFeatureType, Position3D } from '../document/types';

export interface ScreenPoint {
	readonly x: number;
	readonly y: number;
}

export type HitTargetKind =
	| 'entity'
	| 'vertex'
	| 'midpoint'
	| 'gizmo'
	| 'surface'
	| 'none';

/** 命中结果只携带稳定领域 ID，不把 Three 对象泄漏进状态机。 */
export interface HitTarget {
	readonly kind: HitTargetKind;
	readonly entityId?: PlotFeatureId;
	readonly handleId?: string;
	readonly distanceCssPixels: number;
	readonly depth?: number;
	readonly zOrder?: number;
	readonly depthApproximate?: boolean;
}

export type SelectionOperation = 'replace' | 'add' | 'toggle';
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type EnuAxis = 'east' | 'north' | 'up';
export type CancelReason =
	| 'escape'
	| 'pointercancel'
	| 'lost-capture'
	| 'blur'
	| 'hidden'
	| 'dispose'
	| 'second-pointer'
	| 'external-change';

/**
 * 输入路由后的不可变语义动作。
 *
 * 该联合是 Pointer/Keyboard 到 PlotEditor 的唯一写入协议；意图本身不执行
 * DOM、拾取、文档或 GPU 副作用，因此可以记录并在纯单元测试中重放。
 */
export type EditorIntent =
	| { readonly type: 'hoverAt'; readonly screen: ScreenPoint }
	| { readonly type: 'beginDrawingAt'; readonly screen: ScreenPoint }
	| { readonly type: 'appendDraftPoint'; readonly screen: ScreenPoint }
	| { readonly type: 'updateDraftPointer'; readonly screen: ScreenPoint }
	| { readonly type: 'removeLastDraftPoint' }
	| { readonly type: 'undoDraft' }
	| { readonly type: 'redoDraft' }
	| { readonly type: 'commitDrawing' }
	| {
		readonly type: 'selectAt';
		readonly screen: ScreenPoint;
		readonly hit: HitTarget | null;
		readonly operation: SelectionOperation;
	}
	| {
		readonly type: 'beginPointerPending';
		readonly pointerId: number;
		readonly screen: ScreenPoint;
		readonly hit: HitTarget;
		readonly operation: SelectionOperation;
	}
	| {
		readonly type: 'beginHandleDrag';
		readonly pointerId: number;
		readonly entityId: PlotFeatureId;
		readonly handleId: string;
		readonly screen: ScreenPoint;
	}
	| {
		readonly type: 'beginEntityDrag';
		readonly pointerId: number;
		readonly entityId: PlotFeatureId;
		readonly screen: ScreenPoint;
	}
	| {
		readonly type: 'beginBoxSelection';
		readonly pointerId: number;
		readonly screen: ScreenPoint;
		readonly additive: boolean;
	}
	| {
		readonly type: 'updatePointerTransaction';
		readonly pointerId: number;
		readonly screen: ScreenPoint;
	}
	| {
		readonly type: 'finishPointerTransaction';
		readonly pointerId: number;
		readonly screen: ScreenPoint;
	}
	| { readonly type: 'cancelCurrentOperation'; readonly reason: CancelReason }
	| { readonly type: 'deleteSelection' }
	| { readonly type: 'selectAll' }
	| { readonly type: 'undo' }
	| { readonly type: 'redo' }
	| { readonly type: 'save' }
	| { readonly type: 'beginTransform'; readonly mode: TransformMode }
	| { readonly type: 'commitTransform' }
	| { readonly type: 'constrainTransform'; readonly axis: EnuAxis }
	| {
		readonly type: 'nudgeSelection';
		readonly axis: EnuAxis;
		readonly amountMeters: number;
		readonly phase: 'keydown' | 'keyup';
	}
	| { readonly type: 'beginTextEdit' }
	| { readonly type: 'commitTextEdit' }
	| { readonly type: 'cancelTextEdit' };

export interface DraftState {
	readonly graphicsType: PlotFeatureType;
	readonly coordinates: readonly Position3D[];
	readonly previewCoordinate?: Position3D;
	readonly valid: boolean;
	readonly validationErrors: readonly string[];
}
