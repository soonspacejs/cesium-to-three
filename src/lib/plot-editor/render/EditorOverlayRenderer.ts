import {
	Group,
	Matrix4,
	Vector3,
	type Camera,
	type Object3D,
	type Vector2,
} from 'three';
import type { CesiumGroundFrameState } from '../../ground';
import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { EditHandle } from '../adapters/types';
import type {
	PlotFeature,
	PlotFeatureId,
	Position3D,
	ResolvedPlotGeometry,
} from '../document/types';
import type { SelectionState } from '../state/SelectionModel';
import { PlotEntityRaycaster, type PlotEntityHit } from '../picking/PlotEntityRaycaster';
import {
	PlotPickAdapterRegistry,
	type PlotPickBuildError,
} from '../picking/PlotPickAdapterRegistry';
import { PlotPickRegistry } from '../picking/PlotPickRegistry';
import type { HitTarget, ScreenPoint, TransformMode } from '../state/types';
import type {
	EditorProjectionSnapshot,
} from '../selection/ProjectionSnapshot';

export interface OverlayHitCandidate {
	readonly layer: 'active-handle' | 'gizmo' | 'handle';
	readonly target: HitTarget;
}
import {
	computeSelectionPivot,
	createGizmoHandleDescriptions,
	getSelectionGizmoCapabilities,
} from '../transform/gizmo';
import type { GizmoHandleDescription } from '../transform/types';
import {
	BoxSelectionFeedbackLayer,
	type BoxSelectionFeedback,
} from './BoxSelectionFeedbackLayer';
import {
	CanonicalPlotRenderBridge,
	type PlotRenderError,
	type RenderSyncResult,
} from './CanonicalPlotRenderBridge';
import {
	DrawingDraftLayer,
	type DrawingDraftOverlay,
} from './DrawingDraftLayer';
import { PlotRenderProjection } from './RenderProjection';
import {
	ScreenSpaceMarkerLayer,
	type MarkerViewportState,
	type ScreenSpaceMarkerDescription,
} from './ScreenSpaceMarkerLayer';
import {
	EditorCameraLayerLease,
	EditorOverlayLayer,
	isolateOverlayObjects,
} from './layers';

export type EditorRenderReason =
	| 'document'
	| 'surface'
	| 'draft'
	| 'selection'
	| 'camera'
	| 'viewport'
	| 'dispose';

export interface OverlayRenderError extends PlotRenderError {
	readonly pass: 'committed' | 'draft' | 'selection' | 'picking';
}

export interface EditorOverlayRendererOptions {
	readonly scene: Object3D;
	readonly camera: Camera;
	readonly adapters: GeometryAdapterRegistry;
	readonly requestRender?: ( reason: EditorRenderReason ) => void;
	readonly onRenderError?: ( error: OverlayRenderError ) => void;
	readonly onPickBuildError?: ( error: PlotPickBuildError ) => void;
	/** 默认使用 Canvas2D 实测；无 DOM 测试环境可注入等价字体测量器。 */
	readonly measureText?: ( text: string, fontSize: number ) => number;
	readonly requireResolvedGroundSurfaces?: boolean;
}

export interface EditorOverlaySyncInput {
	readonly features: readonly Readonly<PlotFeature>[];
	readonly documentRevision: number;
	readonly sessionRevision: number;
	readonly resolved?: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry>;
	/** working copy；提交或取消后传空数组即可，不进入 document/history。 */
	readonly draftFeatures?: readonly Readonly<PlotFeature>[];
	/** 尚不满足 canonical 最小拓扑的绘制预览。 */
	readonly drawingDraft?: DrawingDraftOverlay | null;
	readonly draftValid?: boolean;
	readonly selection?: SelectionState;
	/** 只有显式进入 vertex edit 时才显示单图形控制点。 */
	readonly showHandles?: boolean;
	readonly transformMode?: TransformMode;
	readonly activeGizmoHandleId?: string;
	readonly occludedHandleIds?: ReadonlySet<string>;
	readonly boxSelection?: BoxSelectionFeedback | null;
}

export interface EditorOverlaySyncResult {
	readonly committed: RenderSyncResult;
	readonly draft: RenderSyncResult;
	readonly selection: RenderSyncResult;
	readonly handleCount: number;
	readonly gizmoCount: number;
	readonly drawingDraftVisible: boolean;
	readonly boxSelectionVisible: boolean;
}

/**
 * 每 viewport 一个实例的 Overlay 协调器。宿主拥有唯一 RAF；本类只响应 sync/update，
 * 不缓存 canonical 写引用，也不处置 scene/camera/depth texture 等 borrowed 资源。
 */
export class EditorOverlayRenderer {
	public readonly plotCommittedRoot = namedRoot( 'plotCommittedRoot' );
	public readonly plotDraftRoot = namedRoot( 'plotDraftRoot' );
	public readonly plotSelectionRoot = namedRoot( 'plotSelectionRoot' );
	public readonly plotEntityPickRoot: Group;
	public readonly plotHandleRoot: Group;
	public readonly plotGizmoRoot: Group;

	private readonly _scene: Object3D;
	private readonly _camera: Camera;
	private readonly _cameraLease: EditorCameraLayerLease;
	private readonly _adapters: GeometryAdapterRegistry;
	private readonly _requestRender?: EditorOverlayRendererOptions[ 'requestRender' ];
	private readonly _committed: CanonicalPlotRenderBridge;
	private readonly _draft: CanonicalPlotRenderBridge;
	private readonly _selection: CanonicalPlotRenderBridge;
	private readonly _drawingDraft = new DrawingDraftLayer();
	private readonly _handles: ScreenSpaceMarkerLayer;
	private readonly _gizmo: ScreenSpaceMarkerLayer;
	private readonly _feedbackMarkers: ScreenSpaceMarkerLayer;
	private readonly _boxSelection = new BoxSelectionFeedbackLayer();
	private readonly _pickRegistry: PlotPickRegistry;
	private readonly _pickAdapters: PlotPickAdapterRegistry;
	private readonly _entityRaycaster: PlotEntityRaycaster;
	private _sessionRevision = -1;
	private _disposed = false;

	public constructor( options: EditorOverlayRendererOptions ) {
		this._scene = options.scene;
		this._camera = options.camera;
		this._adapters = options.adapters;
		this._requestRender = options.requestRender;
		this._cameraLease = new EditorCameraLayerLease( options.camera );
		this._pickRegistry = new PlotPickRegistry();
		this.plotEntityPickRoot = this._pickRegistry.root;
		this._pickAdapters = new PlotPickAdapterRegistry( {
			registry: this._pickRegistry,
			adapters: options.adapters,
			measureText: options.measureText ?? createCanvasTextMeasure(),
			requireResolvedGroundSurfaces: options.requireResolvedGroundSurfaces,
			onBuildError: options.onPickBuildError,
		} );
		this._entityRaycaster = new PlotEntityRaycaster( this._pickRegistry );
		this._handles = new ScreenSpaceMarkerLayer(
			'plotHandleRoot', EditorOverlayLayer.PLOT_HANDLE,
		);
		this._gizmo = new ScreenSpaceMarkerLayer(
			'plotGizmoRoot', EditorOverlayLayer.PLOT_GIZMO,
		);
		this._feedbackMarkers = new ScreenSpaceMarkerLayer(
			'plotSelectionMarkerRoot', EditorOverlayLayer.PLOT_FEEDBACK,
		);
		this.plotHandleRoot = this._handles.root;
		this.plotGizmoRoot = this._gizmo.root;
		this.plotSelectionRoot.add( this._feedbackMarkers.root );
		this.plotSelectionRoot.add( this._boxSelection.root );
		this.plotDraftRoot.add( this._drawingDraft.root );

		const projection = new PlotRenderProjection( options.adapters );
		this._committed = createBridge(
			this.plotCommittedRoot, projection, 'committed', options,
			OVERLAY_PLOT_ORDER_OFFSETS.committed,
		);
		this._draft = createBridge(
			this.plotDraftRoot, projection, 'draft', options,
			OVERLAY_PLOT_ORDER_OFFSETS.draft,
		);
		this._selection = createBridge(
			this.plotSelectionRoot, projection, 'selection', options,
			OVERLAY_PLOT_ORDER_OFFSETS.selection,
		);

		isolateOverlayObjects( this.plotCommittedRoot, EditorOverlayLayer.PLOT_CONTENT );
		isolateOverlayObjects( this.plotDraftRoot, EditorOverlayLayer.PLOT_CONTENT );
		isolateOverlayObjects( this.plotSelectionRoot, EditorOverlayLayer.PLOT_FEEDBACK );
		this._scene.add(
			this.plotCommittedRoot,
			this.plotDraftRoot,
			this.plotSelectionRoot,
			this.plotHandleRoot,
			this.plotGizmoRoot,
			this.plotEntityPickRoot,
		);
	}

	public sync( input: EditorOverlaySyncInput ): EditorOverlaySyncResult {
		this._assertOpen();
		validateRevision( input.documentRevision, 'documentRevision' );
		validateRevision( input.sessionRevision, 'sessionRevision' );
		const resolved = input.resolved ?? EMPTY_RESOLVED;
		const selectionState = input.selection ?? EMPTY_SELECTION;
		const sourceById = new Map( input.features.map( ( feature ) => [ feature.id, feature ] ) );
		for ( const feature of input.draftFeatures ?? [] ) sourceById.set( feature.id, feature );

		const committed = this._committed.sync(
			input.features, input.documentRevision, resolved,
		);
		this._pickAdapters.sync( input.features, resolved );
		const drafts = ( input.draftFeatures ?? [] ).map( ( feature ) =>
			cloneTransientFeature(
				feature,
				feature.id,
				input.sessionRevision,
				draftStyle( feature, input.draftValid !== false ),
			) );
		const draftResolved = remapResolved( drafts, input.draftFeatures ?? [], resolved );
		const draft = this._draft.sync( drafts, input.sessionRevision, draftResolved );
		this._drawingDraft.sync( input.drawingDraft ?? null );

		const selected = selectionState.ids
			.map( ( id ) => sourceById.get( id ) )
			.filter( ( feature ): feature is Readonly<PlotFeature> => feature !== undefined );
		const hovered = selectionState.hoverTarget?.entityId === undefined
			|| selectionState.ids.includes( selectionState.hoverTarget.entityId )
			? undefined
			: sourceById.get( selectionState.hoverTarget.entityId );
		const selectionFeatures = [
			...selected
			.map( ( feature ) => cloneTransientFeature(
				feature,
				selectionRenderId( feature.id ),
				input.sessionRevision,
				selectionStyle( feature, false ),
			) ),
			...( hovered === undefined
				? []
				: [ cloneTransientFeature(
					hovered,
					hoverRenderId( hovered.id ),
					input.sessionRevision,
					selectionStyle( hovered, true ),
				) ] ),
		];
		const selectionResolved = remapResolved(
			selectionFeatures,
			hovered === undefined ? selected : [ ...selected, hovered ],
			resolved,
		);
		const selection = this._selection.sync(
			selectionFeatures, input.sessionRevision, selectionResolved,
		);

		this._feedbackMarkers.sync( selectionFeedbackMarkers( selected, hovered ) );
		this._boxSelection.sync( input.boxSelection ?? null );
		this._handles.sync( input.showHandles === true && selected.length === 1
			? editHandleMarkers(
				selected[ 0 ], this._adapters,
				selectionState.activeHandleId,
				input.occludedHandleIds,
			)
			: [] );
		this._gizmo.sync( input.transformMode !== undefined && selected.length > 0
			? gizmoMarkers(
				selected,
				selectionState.primaryId ?? selected[ 0 ].id,
				input.transformMode,
				this._adapters,
				input.activeGizmoHandleId,
			)
			: [] );

		// bridge 可能在本次 sync 内新建子树，必须在同一帧把默认 layer 隔离掉。
		isolateOverlayObjects( this.plotCommittedRoot, EditorOverlayLayer.PLOT_CONTENT );
		isolateOverlayObjects( this.plotDraftRoot, EditorOverlayLayer.PLOT_CONTENT );
		isolateOverlayObjects( this.plotSelectionRoot, EditorOverlayLayer.PLOT_FEEDBACK );
		if ( input.sessionRevision !== this._sessionRevision ) {
			this._sessionRevision = input.sessionRevision;
			this._requestRender?.( drafts.length > 0 ? 'draft' : 'selection' );
		}
		return Object.freeze( {
			committed,
			draft,
			selection,
			handleCount: this._handles.size,
			gizmoCount: this._gizmo.size,
			drawingDraftVisible: this._drawingDraft.visible,
			boxSelectionVisible: this._boxSelection.visible,
		} );
	}

	/** 每个宿主帧在 depth/surface 结果交付与 sync 后调用一次。 */
	public update( frameState: CesiumGroundFrameState ): void {
		if ( this._disposed ) return;
		this._committed.update( frameState );
		this._draft.update( frameState );
		this._selection.update( frameState );
		const viewport = markerViewport( frameState );
		this._drawingDraft.update( frameState, viewport );
		this._handles.update( viewport );
		this._gizmo.update( viewport );
		this._feedbackMarkers.update( viewport );
		this._boxSelection.updateViewport(
			frameState.width,
			frameState.height,
			frameState.pixelRatio ?? 1,
		);
	}

	/** 业务拾取使用 marker 的 CSS 几何，不调用 Three Raycaster。 */
	public hitTestOverlayMarkers(
		screen: ScreenPoint,
		projection: EditorProjectionSnapshot,
	): readonly OverlayHitCandidate[] {
		if ( this._disposed ) return Object.freeze( [] );
		const hits = [
			...markerHitCandidates( this._handles.getDescriptions(), screen, projection, false ),
			...markerHitCandidates( this._gizmo.getDescriptions(), screen, projection, true ),
		];
		hits.sort( ( left, right ) => overlayLayerPriority( right.layer )
			- overlayLayerPriority( left.layer )
			|| left.target.distanceCssPixels - right.target.distanceCssPixels
			|| ( right.target.zOrder ?? 0 ) - ( left.target.zOrder ?? 0 ) );
		return Object.freeze( hits );
	}

	/** entity hit 只消费一次事件产生的 NDC 快照，返回原生 Raycaster 交点。 */
	public hitTestEntity( ndc: Readonly<Vector2> ): PlotEntityHit | null {
		if ( this._disposed ) return null;
		return this._entityRaycaster.hitTest( ndc, this._cameraLeaseCamera() );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		// 先摘根，保证后续 GPU dispose 过程中宿主 render 不会访问半销毁对象。
		this._scene.remove(
			this.plotCommittedRoot,
			this.plotDraftRoot,
			this.plotSelectionRoot,
			this.plotHandleRoot,
			this.plotGizmoRoot,
			this.plotEntityPickRoot,
		);
		this._committed.dispose();
		this._draft.dispose();
		this._selection.dispose();
		this._drawingDraft.dispose();
		this._handles.dispose();
		this._gizmo.dispose();
		this._feedbackMarkers.dispose();
		this._boxSelection.dispose();
		this._entityRaycaster.dispose();
		this._pickAdapters.dispose();
		this._pickRegistry.dispose();
		this._cameraLease.release();
		this._requestRender?.( 'dispose' );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'EditorOverlayRenderer 已销毁。' );
	}

	private _cameraLeaseCamera(): Camera {
		return this._camera;
	}
}

const EMPTY_RESOLVED: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry> = new Map();
const EMPTY_SELECTION: SelectionState = Object.freeze( { ids: Object.freeze( [] ) } );

// classification 表面占用三个连续 renderOrder。旧实现的三个 bridge 都从零开始，
// 拖动贴地圆时 committed、draft、selection 的 stencil 命令会交错，进而暴露本应
// 隐藏的 shadow volume。每段预留一百万个序位，使命令块全局连续且不依赖 feature id。
const OVERLAY_PLOT_ORDER_BAND_SIZE = 1_000_000;
const OVERLAY_PLOT_ORDER_OFFSETS = Object.freeze( {
	committed: 0,
	draft: OVERLAY_PLOT_ORDER_BAND_SIZE,
	selection: OVERLAY_PLOT_ORDER_BAND_SIZE * 2,
} );

function createBridge(
	root: Group,
	projection: PlotRenderProjection,
	pass: OverlayRenderError[ 'pass' ],
	options: EditorOverlayRendererOptions,
	plotOrderOffset: number,
): CanonicalPlotRenderBridge {
	return new CanonicalPlotRenderBridge( {
		root,
		projection,
		plotOrderOffset,
		requestRender: ( reason ) => options.requestRender?.(
			pass === 'committed' ? reason : pass === 'draft' ? 'draft' : 'selection',
		),
		onRenderError: ( error ) => options.onRenderError?.( Object.freeze( {
			...error, pass,
		} ) ),
	} );
}

function namedRoot( name: string ): Group {
	const root = new Group();
	root.name = name;
	root.matrixAutoUpdate = false;
	return root;
}

function createCanvasTextMeasure(): ( text: string, fontSize: number ) => number {
	if ( typeof document === 'undefined' ) {
		// 纯 Node 测试不会显示文本；生产浏览器始终走下方 Canvas2D 实测。
		return ( text, fontSize ) => Array.from( text ).length * fontSize;
	}
	const canvas = document.createElement( 'canvas' );
	const context = canvas.getContext( '2d' );
	if ( context === null ) throw new Error( '浏览器不支持 Canvas2D 文本测量。' );
	return ( text, fontSize ) => {
		context.font = `${ Math.max( fontSize, 1 ) }px sans-serif`;
		return context.measureText( text ).width;
	};
}

function cloneTransientFeature(
	feature: Readonly<PlotFeature>,
	id: PlotFeatureId,
	revision: number,
	style: Readonly<PlotFeature[ 'style' ]>,
): PlotFeature {
	return Object.freeze( {
		...feature,
		id,
		revision,
		style: Object.freeze( style ),
		properties: feature.properties,
	} ) as PlotFeature;
}

function draftStyle(
	feature: Readonly<PlotFeature>,
	valid: boolean,
): PlotFeature[ 'style' ] {
	return {
		...feature.style,
		strokeColor: valid ? '#27c2ff' : '#ff3344',
		strokeOpacity: 100,
		fillColor: valid ? '#27c2ff' : '#ff3344',
		fillOpacity: Math.min( feature.style.fillOpacity, valid ? 28 : 20 ),
	} as PlotFeature[ 'style' ];
}

function selectionStyle(
	feature: Readonly<PlotFeature>,
	hover: boolean,
): PlotFeature[ 'style' ] {
	return {
		...feature.style,
		strokeColor: hover ? '#ffd43b' : '#00e5ff',
		strokeWidth: Math.max( feature.style.strokeWidth + ( hover ? 2 : 3 ), hover ? 4 : 5 ),
		strokeOpacity: 100,
		fillOpacity: 0,
	} as PlotFeature[ 'style' ];
}

function selectionRenderId( id: PlotFeatureId ): PlotFeatureId {
	return `__editor_selection__:${ id }`;
}

function hoverRenderId( id: PlotFeatureId ): PlotFeatureId {
	return `__editor_hover__:${ id }`;
}

function remapResolved(
	targets: readonly Readonly<PlotFeature>[],
	sources: readonly Readonly<PlotFeature>[],
	resolved: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry>,
): ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry> {
	const sourceByOriginalId = new Map( sources.map( ( feature ) => [ feature.id, feature ] ) );
	const result = new Map<PlotFeatureId, ResolvedPlotGeometry>();
	for ( const target of targets ) {
		const originalId = transientOriginalId( target.id );
		const source = sourceByOriginalId.get( originalId );
		const value = source === undefined ? undefined : resolved.get( source.id );
		if ( value === undefined || value.sourceRevision !== source?.revision ) continue;
		result.set( target.id, Object.freeze( {
			...value,
			plotId: target.id,
			sourceRevision: target.revision,
		} ) );
	}
	return result;
}

function transientOriginalId( id: PlotFeatureId ): PlotFeatureId {
	for ( const prefix of [ '__editor_selection__:', '__editor_hover__:' ] ) {
		if ( id.startsWith( prefix ) ) return id.slice( prefix.length );
	}
	return id;
}

function selectionFeedbackMarkers(
	selected: readonly Readonly<PlotFeature>[],
	hovered?: Readonly<PlotFeature>,
): readonly ScreenSpaceMarkerDescription[] {
	const entries = [
		...selected.map( ( feature ) => ( { feature, hover: false } ) ),
		...( hovered === undefined ? [] : [ { feature: hovered, hover: true } ] ),
	];
	return entries
		.filter( ( entry ) => entry.feature.visible
			&& ( entry.feature.type === 'point' || entry.feature.type === 'text' ) )
		.map( ( { feature, hover } ) => {
			const position = featureAnchorPosition( feature );
			return Object.freeze( {
				id: `${ hover ? 'hover' : 'selection' }-marker:${ feature.id }`,
				entityId: feature.id,
				position,
				shape: 'diamond' as const,
				fillColor: '#00131a',
				borderColor: hover ? '#ffd43b' : '#00e5ff',
				sizeCssPixels: hover ? 16 : 18,
				pickRadiusCssPixels: 8,
				priority: 200,
				visible: true,
			} );
		} );
}

function editHandleMarkers(
	feature: Readonly<PlotFeature>,
	adapters: GeometryAdapterRegistry,
	activeHandleId?: string,
	occludedIds?: ReadonlySet<string>,
): readonly ScreenSpaceMarkerDescription[] {
	if ( ! feature.visible ) return [];
	return adapters.require( feature.type ).listHandles( feature as never )
		.map( ( handle ) => handleMarker(
			handle,
			handle.id === activeHandleId,
			occludedIds?.has( `${ feature.id }:${ handle.id }` ) === true
				|| occludedIds?.has( handle.id ) === true,
		) );
}

function handleMarker(
	handle: EditHandle,
	active: boolean,
	occluded: boolean,
): ScreenSpaceMarkerDescription {
	const midpoint = handle.kind === 'midpoint';
	const parameter = ! midpoint && handle.kind !== 'vertex' && handle.kind !== 'text-anchor';
	return Object.freeze( {
		id: `${ handle.entityId }:${ handle.id }`,
		entityId: handle.entityId,
		handleId: handle.id,
		position: handle.position,
		...( handle.screenOffsetCssPixels === undefined ? {} : {
			screenOffsetCssPixels: handle.screenOffsetCssPixels,
		} ),
		shape: midpoint ? 'diamond' : parameter ? 'square' : 'circle',
		fillColor: active ? '#fff5a8' : midpoint ? '#0b2530' : '#ffffff',
		borderColor: active ? '#ff9d00' : parameter ? '#d946ef' : '#1473e6',
		sizeCssPixels: active ? 16 : midpoint ? 9 : parameter ? 14 : 12,
		pickRadiusCssPixels: active ? 14 : 8,
		priority: active ? Math.max( 1000, handle.priority ) : handle.priority,
		visible: true,
		active,
		occluded,
	} );
}

function gizmoMarkers(
	features: readonly Readonly<PlotFeature>[],
	primaryId: PlotFeatureId,
	mode: TransformMode,
	adapters: GeometryAdapterRegistry,
	activeHandleId?: string,
): readonly ScreenSpaceMarkerDescription[] {
	const pivot = computeSelectionPivot( features, adapters, { primaryId } );
	const capabilities = getSelectionGizmoCapabilities( features, adapters );
	return createGizmoHandleDescriptions( mode, capabilities )
		.filter( ( handle ) => handle.visible )
		.map( ( handle ) => gizmoMarker( handle, pivot.position, primaryId, activeHandleId ) );
}

function gizmoMarker(
	handle: GizmoHandleDescription,
	position: Position3D,
	entityId: PlotFeatureId,
	activeHandleId?: string,
): ScreenSpaceMarkerDescription {
	const active = handle.id === activeHandleId;
	const visual = gizmoVisual( handle );
	return Object.freeze( {
		id: `gizmo:${ handle.id }`,
		entityId,
		handleId: handle.id,
		position,
		screenOffsetCssPixels: visual.offset,
		shape: visual.shape,
		fillColor: active ? '#fff5a8' : visual.color,
		borderColor: '#111827',
		sizeCssPixels: visual.size,
		pickRadiusCssPixels: active ? 14 : handle.pickRadiusCssPixels,
		priority: active ? handle.priority + 1000 : handle.priority,
		visible: handle.visible,
		active,
	} );
}

function gizmoVisual( handle: GizmoHandleDescription ): Pick<
	ScreenSpaceMarkerDescription,
	'shape' | 'sizeCssPixels' | 'fillColor'
> & { readonly offset: readonly [ number, number ]; readonly size: number; readonly color: string } {
	if ( handle.kind === 'rotate-ring' ) {
		const size = handle.rotation === 'heading' ? 96 : handle.rotation === 'pitch' ? 78 : 60;
		return { shape: 'ring', sizeCssPixels: size, fillColor: axisColor( handle ), offset: [ 0, 0 ], size, color: axisColor( handle ) };
	}
	if ( handle.kind === 'translate-plane' || handle.kind === 'scale-uniform' ) {
		return { shape: 'square', sizeCssPixels: 20, fillColor: '#ffd43b', offset: [ 16, -16 ], size: 20, color: '#ffd43b' };
	}
	const axis = handle.axis ?? 'uniform';
	const shape = `${ handle.kind === 'scale-axis' ? 'scale' : 'axis' }-${ axis }` as
		ScreenSpaceMarkerDescription[ 'shape' ];
	const offset: readonly [ number, number ] = axis === 'east'
		? [ 36, 0 ]
		: axis === 'north' ? [ 0, -36 ] : [ -25, -25 ];
	return {
		shape,
		sizeCssPixels: handle.screenSizeCssPixels,
		fillColor: axisColor( handle ),
		offset,
		size: handle.screenSizeCssPixels,
		color: axisColor( handle ),
	};
}

function axisColor( handle: GizmoHandleDescription ): string {
	if ( handle.axis === 'east' || handle.rotation === 'roll' ) return '#ef4444';
	if ( handle.axis === 'north' || handle.rotation === 'pitch' ) return '#22c55e';
	if ( handle.axis === 'up' || handle.rotation === 'heading' ) return '#3b82f6';
	return '#ffd43b';
}

function markerViewport( frameState: CesiumGroundFrameState ): MarkerViewportState {
	const camera = frameState.camera;
	camera.updateMatrixWorld();
	camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
	const position = camera.getWorldPosition( new Vector3() );
	const viewRotation = new Matrix4().copy( camera.matrixWorldInverse );
	viewRotation.elements[ 12 ] = 0;
	viewRotation.elements[ 13 ] = 0;
	viewRotation.elements[ 14 ] = 0;
	return Object.freeze( {
		widthDevicePixels: frameState.width,
		heightDevicePixels: frameState.height,
		devicePixelRatio: frameState.pixelRatio ?? 1,
		cameraPositionEcef: [ position.x, position.y, position.z ] as const,
		viewProjectionRotation: viewRotation.toArray(),
		projectionMatrix: camera.projectionMatrix.toArray(),
	} );
}

function featureAnchorPosition( feature: Readonly<PlotFeature> ): Position3D {
	if ( feature.type === 'point' ) return feature.geometry.position;
	if ( feature.type === 'text' ) return feature.geometry.position;
	throw new Error( `feature ${ feature.id } 不是点或文本。` );
}

function validateRevision( value: number, name: string ): void {
	if ( ! Number.isSafeInteger( value ) || value < 0 ) {
		throw new RangeError( `${ name } 必须是非负安全整数。` );
	}
}

function markerHitCandidates(
	descriptions: readonly ScreenSpaceMarkerDescription[],
	screen: ScreenPoint,
	projection: EditorProjectionSnapshot,
	gizmo: boolean,
): OverlayHitCandidate[] {
	const results: OverlayHitCandidate[] = [];
	for ( const description of descriptions ) {
		if ( ! description.visible || description.entityId === undefined
			|| description.handleId === undefined ) continue;
		const projected = projection.project( description.position );
		if ( projected === null || ! projected.visible ) continue;
		const offset = description.screenOffsetCssPixels ?? [ 0, 0 ];
		const center = { x: projected.x + offset[ 0 ], y: projected.y + offset[ 1 ] };
		const distance = markerDistance( screen, projected, center, description );
		if ( distance > description.pickRadiusCssPixels ) continue;
		const kind: HitTarget[ 'kind' ] = gizmo
			? 'gizmo'
			: description.handleId.startsWith( 'vertex:' ) ? 'vertex'
				: description.handleId.startsWith( 'midpoint:' ) ? 'midpoint' : 'gizmo';
		results.push( Object.freeze( {
			layer: description.active ? 'active-handle' : gizmo ? 'gizmo' : 'handle',
			target: Object.freeze( {
				kind,
				entityId: description.entityId,
				handleId: description.handleId,
				distanceCssPixels: distance,
				depth: projected.depth,
				zOrder: description.priority,
				depthApproximate: true,
			} ),
		} ) );
	}
	return results;
}

function overlayLayerPriority( layer: OverlayHitCandidate[ 'layer' ] ): number {
	return layer === 'active-handle' ? 3 : layer === 'gizmo' ? 2 : 1;
}

function markerDistance(
	screen: ScreenPoint,
	anchor: ScreenPoint,
	center: ScreenPoint,
	description: ScreenSpaceMarkerDescription,
): number {
	const distanceToCenter = Math.hypot( screen.x - center.x, screen.y - center.y );
	if ( description.shape === 'ring' ) {
		return Math.abs( distanceToCenter - description.sizeCssPixels / 2 );
	}
	if ( description.shape.startsWith( 'axis-' ) || description.shape.startsWith( 'scale-' ) ) {
		const end = {
			x: anchor.x + ( description.screenOffsetCssPixels?.[ 0 ] ?? 0 ) * 2,
			y: anchor.y + ( description.screenOffsetCssPixels?.[ 1 ] ?? 0 ) * 2,
		};
		return distanceToSegment( screen, anchor, end );
	}
	const visibleRadius = description.sizeCssPixels / 2;
	return Math.max( 0, distanceToCenter - visibleRadius );
}

function distanceToSegment( point: ScreenPoint, start: ScreenPoint, end: ScreenPoint ): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	if ( lengthSquared <= 1e-12 ) return Math.hypot( point.x - start.x, point.y - start.y );
	const t = Math.max( 0, Math.min( 1,
		( ( point.x - start.x ) * dx + ( point.y - start.y ) * dy ) / lengthSquared,
	) );
	return Math.hypot( point.x - ( start.x + dx * t ), point.y - ( start.y + dy * t ) );
}
