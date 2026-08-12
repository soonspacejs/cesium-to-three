// 标绘编辑器公共入口：只导出稳定 API、不可变数据协议和宿主适配端口。
export {
	PlotEditor,
	createPlotEditor,
	type DrawTool,
	type EditorRenderHost,
	type PlotEditorOptions,
	type SelectionMode,
} from './PlotEditor';

export {
	HeightReference,
	type ArrowFeature,
	type ArrowGeometry,
	type ArrowType,
	type CircleFeature,
	type CircleGeometry,
	type GeoPosition,
	type HeightMode,
	type HeightReferenceName,
	type HeightSurface,
	type JsonPrimitive,
	type JsonValue,
	type LineFeature,
	type LineGeometry,
	type LineStyle,
	type PlotDocumentSnapshot,
	type PlotFeature,
	type PlotFeatureId,
	type PlotFeatureType,
	type PlotGeometry,
	type PlotStyle,
	type PointFeature,
	type PointGeometry,
	type PointStyle,
	type PolygonFeature,
	type PolygonGeometry,
	type Position3D,
	type RectangleFeature,
	type RectangleGeometry,
	type ResolvedPlotGeometry,
	type SectorFeature,
	type SectorGeometry,
	type TextFeature,
	type TextGeometry,
	type TextStyle,
	type VertexId,
} from './document/types';
export type {
	PlotDocument,
	PlotDocumentChange,
	PlotDocumentListener,
} from './document/PlotDocument';
export {
	PlotEditorValidationError,
	type DiagnosticSeverity,
	type EditorDiagnostic,
	type EditorErrorCode,
} from './document/diagnostics';
export {
	getHeightMode,
	getHeightReferenceName,
	getHeightSurface,
	isHeightReferenceClamp,
	isHeightReferenceRelative,
	isHeightReference,
	parseHeightReference,
} from './document/height-reference';

export type {
	CommandResult,
	EditorCommand,
	EditorError,
	EnuTransform,
	PlotPatch,
} from './commands/types';
export type { HistoryLimits, HistoryState } from './commands/HistoryManager';
export type {
	DrawToolContext,
	DrawingErrorCode,
	DrawingValidation,
	EditHandle,
	EditHandleKind,
	GeometryAdapterCapabilities,
} from './adapters/types';

export {
	EditorSurfacePicker,
	getSurfaceTarget,
} from './picking/EditorPicker';
export type {
	HeightSample,
	HeightSampleRequest,
	PickOptions,
	PickSurface,
	PlotPickResult,
	PlotSurfaceHeightProvider,
	PlotSurfacePicker,
	ScreenPosition,
	SurfaceHit,
	SurfaceRaycastPort,
	SurfaceTarget,
} from './picking/types';

export {
	ConfigurableEditorKeymap,
	createEditorKeymap,
	createDefaultEditorKeymap,
} from './input/Keymap';
export { GlobeControlsNavigationAdapter } from './input/NavigationAdapter';
export type {
	CommandContext,
	EditorCommandDefinition,
	EditorKeymap,
	EditorKeymapOverrides,
	FocusDomain,
	KeyboardCommandResult,
	KeyboardStateSnapshot,
	KeyStroke,
	KeymapConflict,
	ModifierState,
	NavigationAdapter,
	NavigationLease,
	NavigationLeaseKind,
	PointerButton,
	PointerClaim,
	PointerDevice,
	PointerOwner,
} from './input/types';

export {
	decodePlotDocument,
	encodePlotDocument,
	stringifyPlotDocument,
	tryDecodePlotDocument,
} from './persistence/codec';
export type {
	DecodePlotDocumentOptions,
	DecodePlotDocumentResult,
	PlotCodecLimits,
	SerializedPlotDocumentV1,
	SerializedPlotFeatureV1,
	TryDecodePlotDocumentResult,
} from './persistence/codec';
export type {
	ImportPlotDocumentOptions,
	ImportPlotDocumentResult,
} from './persistence/PlotDocumentImporter';

export {
	clientPointToNdc,
	PlotEntityRaycaster,
	PlotPickAdapterRegistry,
	PlotPickRegistry,
	TilesTerrainHeightProvider,
	resolvePlotPickMetadata,
	type CssViewportRect,
	type PlotEntityHit,
	type PlotEntityRaycasterOptions,
	type PlotPickBuildError,
	type PlotPickEntry,
	type PlotPickMetadata,
	type PlotPickPart,
	type PlotPickRegistration,
	type PlotPickRevision,
	type PlotPickSource,
} from './picking';

export {
	createCameraProjectionSnapshot,
	type CameraProjectionSnapshotOptions,
} from './selection/CameraProjectionSnapshot';
export type {
	EditorProjectionSnapshot,
	ProjectedEditorPoint,
} from './selection/ProjectionSnapshot';
export type {
	SelectionFilter,
	SelectionState,
} from './state/SelectionModel';
export type {
	EditorIntent,
	HitTarget,
	HitTargetKind,
	ScreenPoint,
	SelectionOperation,
	TransformMode,
} from './state/types';
export type {
	PlotEditorEventListener,
	PlotEditorEventMap,
	PlotEditorEventType,
	PlotEditorMode,
} from './events';

// 旧 PlotBridge 的兼容是显式、单向且可诊断的，不会污染 canonical 文档。
export {
	adaptRenderFeatureToLegacyPlot,
	type LegacyPlotAdaptResult,
	type LegacyPlotUnsupportedReason,
} from './render/LegacyPlotAdapter';
