import type { Object3D } from 'three';
import type { CesiumGroundFrameState } from '../../ground';
import { PlotPrimitiveBridge } from '../../plot/PlotPrimitiveBridge';
import { plotOrderToRenderOrder, sanitizePlotOrder } from '../../plot/plot-order';
import { GisPlotBase } from '../../plot/plugins/base';
import {
	GisPlotArrow,
	GisPlotCircle,
	GisPlotLine,
	GisPlotPoint,
	GisPlotPolygon,
	GisPlotRectangle,
	GisPlotSector,
	GisPlotText,
} from '../../plot/plugins';
import type { PlotAddOptions } from '../../plot/plugins/types';
import type { PlotFeature, PlotFeatureId, ResolvedPlotGeometry } from '../document/types';
import { adaptRenderFeatureToLegacyPlot } from './LegacyPlotAdapter';
import {
	PlotRenderProjection,
	RenderDirtyFlag,
	diffRenderFeature,
	type RenderFeature,
} from './RenderProjection';
import {
	VariableHeightRtePrimitive,
	createVariableHeightRtePrimitive,
} from './VariableHeightRtePrimitive';

export interface PlotRenderError {
	readonly code: 'RENDER_BUILD_FAILED' | 'RENDER_UNSUPPORTED';
	readonly featureId: PlotFeatureId;
	readonly message: string;
	readonly cause?: unknown;
}

export interface CanonicalPlotRenderBridgeOptions {
	readonly root: Object3D;
	readonly projection: PlotRenderProjection;
	readonly requestRender?: ( reason: 'document' | 'surface' | 'dispose' ) => void;
	readonly onRenderError?: ( error: PlotRenderError ) => void;
	/**
	 * 为当前 bridge 预留 plot-order 分带。committed、draft 与 selection 不能
	 * 共用同一分带，因为每个贴地面都拥有不可拆分的前/后 stencil 与着色命令块。
	 */
	readonly plotOrderOffset?: number;
	/** 测试/宿主扩展点；默认使用内置 variable-height RTE primitive。 */
	readonly createVariablePrimitive?: (
		render: RenderFeature,
		renderOrder: number,
	) => VariableHeightRtePrimitive | null;
}

export interface RenderSyncResult {
	readonly changedIds: readonly PlotFeatureId[];
	readonly removedIds: readonly PlotFeatureId[];
	readonly failedIds: readonly PlotFeatureId[];
	readonly documentRevision: number;
	readonly renderedCount: number;
}

/**
 * canonical committed features 到现有 Ground/Plain 桥接器的增量协调层。
 * 支持旧二维+统一高度的图形继续走成熟图元，逐顶点高度自动转入新 RTE 路径。
 */
export class CanonicalPlotRenderBridge {
	private readonly _root: Object3D;
	private readonly _projection: PlotRenderProjection;
	private readonly _requestRender?: CanonicalPlotRenderBridgeOptions[ 'requestRender' ];
	private readonly _onRenderError?: CanonicalPlotRenderBridgeOptions[ 'onRenderError' ];
	private readonly _plotOrderOffset: number;
	private readonly _createVariablePrimitive: NonNullable<CanonicalPlotRenderBridgeOptions[ 'createVariablePrimitive' ]>;
	private readonly _legacyBridge: PlotPrimitiveBridge;
	private readonly _legacyPlots = new Map<PlotFeatureId, GisPlotBase>();
	private readonly _variable = new Map<PlotFeatureId, VariableHeightRtePrimitive>();
	private readonly _renderFeatures = new Map<PlotFeatureId, RenderFeature>();
	private readonly _renderVersions = new Map<PlotFeatureId, number>();
	private readonly _order = new Map<PlotFeatureId, number>();
	private readonly _legacyBuildFailures = new Map<PlotFeatureId, unknown>();
	private _disposed = false;
	private _documentRevision = -1;

	public constructor( options: CanonicalPlotRenderBridgeOptions ) {
		this._root = options.root;
		this._projection = options.projection;
		this._requestRender = options.requestRender;
		this._onRenderError = options.onRenderError;
		this._plotOrderOffset = sanitizePlotOrder( options.plotOrderOffset ?? 0 );
		this._createVariablePrimitive = options.createVariablePrimitive
			?? createVariableHeightRtePrimitive;
		this._legacyBridge = new PlotPrimitiveBridge( {
			scene: options.root,
			getRenderOrder: ( id, fallback ) => plotOrderToRenderOrder(
				this._plotOrderOffset + ( this._order.get( id ) ?? fallback ),
			),
			getRevision: ( id ) => this._renderVersions.get( id ),
			onBuildError: ( error, id ) => this._legacyBuildFailures.set( id, error ),
		} );
	}

	public get documentRevision(): number {
		return this._documentRevision;
	}

	public get renderedCount(): number {
		return this._renderFeatures.size;
	}

	public getRenderFeature( id: PlotFeatureId ): RenderFeature | undefined {
		return this._renderFeatures.get( id );
	}

	public sync(
		features: readonly Readonly<PlotFeature>[],
		documentRevision: number,
		resolved: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry> = new Map(),
	): RenderSyncResult {
		this._assertOpen();
		const documentChanged = documentRevision !== this._documentRevision;
		this._legacyBuildFailures.clear();
		const changed = new Set<PlotFeatureId>();
		const failed = new Set<PlotFeatureId>();
		const currentIds = new Set( features.map( ( feature ) => feature.id ) );
		const removed = [ ...this._renderFeatures.keys() ].filter( ( id ) => ! currentIds.has( id ) );
		for ( const id of removed ) this._removeEntry( id );

		this._order.clear();
		features.forEach( ( feature, index ) => this._order.set( feature.id, index ) );
		const nextRenders = new Map<PlotFeatureId, RenderFeature>();
		const pendingLegacyFromVariable = new Set<PlotFeatureId>();

		for ( const feature of features ) {
			const previous = this._renderFeatures.get( feature.id );
			let render: RenderFeature;
			try {
				render = this._projection.projectFeature( feature, { resolved } );
			} catch ( error ) {
				failed.add( feature.id );
				this._reportError( 'RENDER_BUILD_FAILED', feature.id, error );
				if ( previous !== undefined ) nextRenders.set( feature.id, previous );
				else nextRenders.delete( feature.id );
				continue;
			}
			const dirty = diffRenderFeature( previous, render );
			nextRenders.set( feature.id, render );
			if ( dirty === RenderDirtyFlag.None ) continue;
			changed.add( feature.id );

			const legacy = adaptRenderFeatureToLegacyPlot( feature, render );
			if ( legacy.supported ) {
				try {
					this._legacyPlots.set( feature.id, createLegacyPlot( legacy.options ) );
					this._bumpRenderVersion( feature.id );
					if ( this._variable.has( feature.id ) ) pendingLegacyFromVariable.add( feature.id );
				} catch ( error ) {
					failed.add( feature.id );
					this._reportError( 'RENDER_BUILD_FAILED', feature.id, error );
					if ( previous !== undefined ) nextRenders.set( feature.id, previous );
					else nextRenders.delete( feature.id );
				}
				continue;
			}

			if ( legacy.reason === 'SURFACE_UNAVAILABLE' ) {
				this._legacyPlots.delete( feature.id );
				this._removeVariable( feature.id );
				this._bumpRenderVersion( feature.id );
				continue;
			}
			try {
				const candidate = this._createVariablePrimitive(
					render,
					plotOrderToRenderOrder(
						this._plotOrderOffset + ( this._order.get( feature.id ) ?? 0 ),
					),
				);
				if ( candidate === null ) throw new Error( legacy.message );
				// 候选成功后再替换，旧 GPU 资源在此之前保持可见。
				this._root.add( candidate.group );
				const previousVariable = this._variable.get( feature.id );
				if ( previousVariable !== undefined ) {
					this._root.remove( previousVariable.group );
					previousVariable.dispose();
				}
				this._variable.set( feature.id, candidate );
				this._legacyPlots.delete( feature.id );
				this._bumpRenderVersion( feature.id );
			} catch ( error ) {
				failed.add( feature.id );
				this._reportError( 'RENDER_BUILD_FAILED', feature.id, error );
				if ( previous !== undefined ) nextRenders.set( feature.id, previous );
				else nextRenders.delete( feature.id );
			}
		}

		const orderedLegacy = new Map<PlotFeatureId, GisPlotBase>();
		for ( const feature of features ) {
			const plot = this._legacyPlots.get( feature.id );
			if ( plot !== undefined ) orderedLegacy.set( feature.id, plot );
		}
		this._legacyBridge.shapes = orderedLegacy;
		this._legacyBridge.redraw();
		for ( const [ id, error ] of this._legacyBuildFailures ) {
			failed.add( id );
			this._reportError( 'RENDER_BUILD_FAILED', id, error );
			const previous = this._renderFeatures.get( id );
			if ( previous !== undefined ) nextRenders.set( id, previous );
		}
		for ( const id of pendingLegacyFromVariable ) {
			if ( this._legacyBridge.hasRenderEntry( id ) && ! failed.has( id ) ) {
				this._removeVariable( id );
			}
		}

		this._renderFeatures.clear();
		for ( const [ id, render ] of nextRenders ) this._renderFeatures.set( id, render );
		this._documentRevision = documentRevision;
		if ( changed.size > 0 || removed.length > 0 ) {
			this._requestRender?.( documentChanged ? 'document' : 'surface' );
		}
		return Object.freeze( {
			changedIds: Object.freeze( [ ...changed ] ),
			removedIds: Object.freeze( removed ),
			failedIds: Object.freeze( [ ...failed ] ),
			documentRevision,
			renderedCount: this._renderFeatures.size,
		} );
	}

	public update( frameState: CesiumGroundFrameState ): void {
		if ( this._disposed ) return;
		this._legacyBridge.update( frameState );
		for ( const primitive of this._variable.values() ) primitive.update( frameState );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this._legacyBridge.dispose();
		for ( const primitive of this._variable.values() ) {
			this._root.remove( primitive.group );
			primitive.dispose();
		}
		this._variable.clear();
		this._legacyPlots.clear();
		this._renderFeatures.clear();
		this._renderVersions.clear();
		this._order.clear();
		this._requestRender?.( 'dispose' );
	}

	private _removeEntry( id: PlotFeatureId ): void {
		this._legacyPlots.delete( id );
		this._removeVariable( id );
		this._renderFeatures.delete( id );
		this._renderVersions.delete( id );
		this._order.delete( id );
	}

	private _removeVariable( id: PlotFeatureId ): void {
		const primitive = this._variable.get( id );
		if ( primitive === undefined ) return;
		this._variable.delete( id );
		this._root.remove( primitive.group );
		primitive.dispose();
	}

	private _bumpRenderVersion( id: PlotFeatureId ): void {
		this._renderVersions.set( id, ( this._renderVersions.get( id ) ?? 0 ) + 1 );
	}

	private _reportError(
		code: PlotRenderError[ 'code' ],
		featureId: PlotFeatureId,
		cause: unknown,
	): void {
		this._onRenderError?.( Object.freeze( {
			code,
			featureId,
			message: cause instanceof Error ? cause.message : '图元构建失败。',
			cause,
		} ) );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'CanonicalPlotRenderBridge 已销毁。' );
	}
}

function createLegacyPlot( options: PlotAddOptions ): GisPlotBase {
	switch ( options.type ) {
		case 'point': {
			const { type: _type, ...rest } = options;
			return new GisPlotPoint( rest );
		}
		case 'line': {
			const { type: _type, ...rest } = options;
			return new GisPlotLine( rest );
		}
		case 'polygon': {
			const { type: _type, ...rest } = options;
			return new GisPlotPolygon( rest );
		}
		case 'rectangle': {
			const { type: _type, ...rest } = options;
			return new GisPlotRectangle( rest );
		}
		case 'circle': {
			const { type: _type, ...rest } = options;
			return new GisPlotCircle( rest );
		}
		case 'sector': {
			const { type: _type, ...rest } = options;
			return new GisPlotSector( rest );
		}
		case 'arrow': {
			const { type: _type, ...rest } = options;
			return new GisPlotArrow( rest );
		}
		case 'text': {
			const { type: _type, ...rest } = options;
			return new GisPlotText( rest );
		}
	}
}
