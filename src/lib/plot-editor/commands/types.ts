import type { EditorDiagnostic, EditorErrorCode } from '../document/diagnostics';
import type {
	HeightReference,
	JsonValue,
	PlotDocumentSnapshot,
	PlotFeature,
	PlotFeatureId,
	Position3D,
	PositionInput,
	VertexId,
} from '../document/types';

export interface PlotPatch {
	readonly geometry?: Readonly<Record<string, unknown>>;
	readonly style?: Readonly<Record<string, unknown>>;
	readonly heightReference?: HeightReference | string;
	readonly visible?: boolean;
	readonly properties?: Readonly<Record<string, JsonValue>>;
}

/** 以同一个 WGS84 ENU pivot 描述一组可重放变换。 */
export interface EnuTransform {
	readonly pivot: Position3D;
	readonly translationMeters?: readonly [ east: number, north: number, up: number ];
	readonly rotationDegrees?: readonly [ heading: number, pitch: number, roll: number ];
	readonly scale?: readonly [ east: number, north: number, up: number ];
}

export type EditorCommand =
	| { readonly type: 'feature.add'; readonly feature: PlotFeature }
	| { readonly type: 'feature.remove'; readonly ids: readonly PlotFeatureId[] }
	| {
		readonly type: 'feature.patch';
		readonly id: PlotFeatureId;
		readonly beforeRevision: number;
		readonly patch: PlotPatch;
	}
	| {
		readonly type: 'feature.transform';
		readonly ids: readonly PlotFeatureId[];
		readonly beforeRevisions?: Readonly<Record<PlotFeatureId, number>>;
		readonly transform: EnuTransform;
	}
	| {
		readonly type: 'vertex.insert';
		readonly id: PlotFeatureId;
		readonly beforeRevision: number;
		readonly after: VertexId;
		readonly position: PositionInput;
	}
	| {
		readonly type: 'vertex.remove';
		readonly id: PlotFeatureId;
		readonly beforeRevision: number;
		readonly vertex: VertexId;
	}
	| { readonly type: 'document.replace'; readonly snapshot: PlotDocumentSnapshot };

export interface EditorError {
	readonly code: EditorErrorCode | string;
	readonly message: string;
	readonly path?: string;
}

export interface CommandResult {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly revision: number;
	readonly affectedIds: readonly PlotFeatureId[];
	readonly error?: EditorError;
	readonly diagnostics?: readonly EditorDiagnostic[];
}

export type FeatureTransform = (
	feature: Readonly<PlotFeature>,
	transform: EnuTransform,
) => PlotFeature;
