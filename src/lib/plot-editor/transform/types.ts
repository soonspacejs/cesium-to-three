import type { EnuTransform } from '../commands/types';
import type { PlotFeature, PlotFeatureId, Position3D } from '../document/types';
import type { EnuFrame, Vector3Tuple } from '../document/geodesy';
import type { TransformMode } from '../state/types';

export type GizmoAxis = 'east' | 'north' | 'up' | 'uniform';
export type GizmoRotation = 'heading' | 'pitch' | 'roll';

export type GizmoHandleKind =
	| 'translate-axis'
	| 'translate-plane'
	| 'rotate-ring'
	| 'scale-axis'
	| 'scale-uniform';

export interface GizmoCapabilities {
	readonly translateEast: boolean;
	readonly translateNorth: boolean;
	readonly translateUp: boolean;
	readonly rotateHeading: boolean;
	readonly rotatePitch: boolean;
	readonly rotateRoll: boolean;
	readonly scaleHorizontal: boolean;
	readonly scaleVertical: boolean;
	readonly editVertices: boolean;
}

export interface GizmoHandleDescription {
	readonly id: string;
	readonly kind: GizmoHandleKind;
	readonly axis?: GizmoAxis;
	readonly rotation?: GizmoRotation;
	readonly visible: boolean;
	readonly enabled: boolean;
	readonly pickable: boolean;
	readonly cursor: 'move' | 'crosshair' | 'rotate' | 'ew-resize' | 'ns-resize';
	readonly screenSizeCssPixels: number;
	readonly pickRadiusCssPixels: number;
	readonly priority: number;
	readonly disabledReason?: string;
}

export interface SelectionPivot {
	readonly position: Position3D;
	readonly ecef: Vector3Tuple;
	readonly frame: EnuFrame;
	readonly fallbackToPrimary: boolean;
}

export interface PivotDiagnostic {
	readonly code: 'PIVOT_FALLBACK_PRIMARY';
	readonly severity: 'warning';
	readonly message: string;
	readonly primaryId: PlotFeatureId;
}

export interface TransformDelta {
	readonly translationMeters?: EnuTransform[ 'translationMeters' ];
	readonly rotationDegrees?: EnuTransform[ 'rotationDegrees' ];
	readonly scale?: EnuTransform[ 'scale' ];
}

export interface TransformPreview {
	readonly transactionId: string;
	readonly mode: TransformMode;
	readonly selectedIds: readonly PlotFeatureId[];
	readonly pivot: SelectionPivot;
	readonly capabilities: GizmoCapabilities;
	readonly axis?: GizmoAxis;
	readonly features: readonly Readonly<PlotFeature>[];
	readonly committable: boolean;
	readonly error?: Readonly<{ code: string; message: string }>;
}

export interface TransformSessionState {
	readonly transactionId: string;
	readonly mode: TransformMode;
	readonly selectedIds: readonly PlotFeatureId[];
	readonly sourceDocumentRevision: number;
	readonly pivot: SelectionPivot;
	readonly capabilities: GizmoCapabilities;
	readonly axis?: GizmoAxis;
	readonly dirty: boolean;
	readonly committable: boolean;
}
