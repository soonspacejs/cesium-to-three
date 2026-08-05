import type {
	HeightReference,
	JsonValue,
	PlotFeature,
	PlotFeatureId,
	PlotFeatureType,
	PlotStyle,
	Position3D,
} from '../document/types';
import type { PlotPickResult } from '../picking/types';

export type DrawingPhase = 'armed' | 'drawing' | 'ready' | 'committing';

export type DrawingErrorCode =
	| 'DRAW_PICK_MISS'
	| 'DRAW_TOO_FEW_POINTS'
	| 'DRAW_DEGENERATE_GEOMETRY'
	| 'DRAW_SELF_INTERSECTION'
	| 'DRAW_INVALID_HEIGHT'
	| 'DRAW_INVALID_PARAMETER'
	| 'DRAW_POINT_LIMIT'
	| 'DRAW_SURFACE_UNAVAILABLE'
	| 'DRAW_TEXT_INPUT_REQUIRED';

export interface DrawingValidation {
	readonly valid: boolean;
	readonly code?: DrawingErrorCode;
	readonly message?: string;
	readonly pointIndex?: number;
}

export interface DrawToolContext<TOptions extends object = object> {
	readonly type: PlotFeatureType;
	readonly heightReference: HeightReference;
	readonly style?: Readonly<Partial<PlotStyle> & Record<string, unknown>>;
	readonly options?: Readonly<TOptions>;
}

export interface DrawingDraft<TParameters extends object = object> {
	readonly type: PlotFeatureType;
	readonly heightReference: HeightReference;
	readonly phase: DrawingPhase;
	readonly points: readonly Position3D[];
	readonly previewPoint?: Position3D;
	readonly parameters: Readonly<TParameters>;
	readonly style: Readonly<Record<string, unknown>>;
	readonly validation: DrawingValidation;
}

export type PreviewPrimitive = 'point' | 'polyline' | 'polygon' | 'text';

/** adapter 产生的纯数据预览；overlay 决定实际 Three 资源。 */
export interface DraftPreviewGeometry {
	readonly primitive: PreviewPrimitive;
	readonly positions: readonly Position3D[];
	readonly closed: boolean;
	readonly sourceType: PlotFeatureType;
	readonly generated: boolean;
	readonly text?: string;
}

export type EditHandleKind =
	| 'vertex'
	| 'midpoint'
	| 'center'
	| 'radius'
	| 'start-angle'
	| 'end-angle'
	| 'size'
	| 'width'
	| 'height'
	| 'rotation'
	| 'text-anchor';

export interface EditHandle {
	readonly id: string;
	readonly entityId: PlotFeatureId;
	readonly kind: EditHandleKind;
	readonly position: Position3D;
	readonly vertexIndex?: number;
	readonly segmentIndex?: number;
	readonly parameter?: string;
	readonly priority: number;
}

export interface GeometryAdapterCapabilities {
	readonly editable: true;
	readonly editVertices: boolean;
	readonly insertVertices: boolean;
	readonly removeVertices: boolean;
	readonly translate: boolean;
	readonly rotateHeading: boolean;
	readonly scaleHorizontal: boolean;
	readonly parameterHandles: readonly EditHandleKind[];
}

export interface FinishFeatureOptions {
	readonly id: PlotFeatureId;
	readonly revision?: number;
	readonly visible?: boolean;
	readonly properties?: Readonly<Record<string, JsonValue>>;
}

export interface HandleMovement {
	readonly authorPosition: Position3D;
	readonly shift?: boolean;
	readonly alt?: boolean;
}

/** 八类图形共用的无 DOM、无 Three 策略接口。 */
export interface GeometryAdapter<
	TDraft extends DrawingDraft = DrawingDraft,
	TFeature extends PlotFeature = PlotFeature,
> {
	readonly kind: TFeature[ 'type' ];
	readonly capabilities: GeometryAdapterCapabilities;
	begin( context: DrawToolContext<any> ): TDraft;
	addPoint( draft: TDraft, point: Position3D, hit?: PlotPickResult ): TDraft;
	movePointer( draft: TDraft, point: Position3D, hit?: PlotPickResult ): TDraft;
	removeLastPoint( draft: TDraft ): TDraft;
	validateDraft( draft: TDraft ): DrawingValidation;
	canFinish( draft: TDraft ): boolean;
	finish( draft: TDraft, options: FinishFeatureOptions ): TFeature;
	cancel( draft: TDraft ): void;
	preview( draft: TDraft ): DraftPreviewGeometry;
	listHandles( feature: TFeature ): readonly EditHandle[];
	applyHandle( feature: TFeature, handleId: string, movement: HandleMovement ): TFeature;
	removeVertex( feature: TFeature, handleId: string ): TFeature;
	toRenderDescription( feature: TFeature ): DraftPreviewGeometry;
	toJSON( feature: TFeature ): unknown;
}
