import { DoubleSide, MeshBasicMaterial } from 'three';
import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { PlotFeature, PlotFeatureId, ResolvedPlotGeometry } from '../document/types';
import { PlotRenderProjection } from '../render/RenderProjection';
import { AreaPickAdapter } from './adapters/AreaPickAdapter';
import { LinePickAdapter } from './adapters/LinePickAdapter';
import { PointPickAdapter } from './adapters/PointPickAdapter';
import { TextPickAdapter, type TextPickAdapterOptions } from './adapters/TextPickAdapter';
import type { StandardPickObject } from './adapters/geometry';
import { PlotPickRegistry, type PlotPickRevision } from './PlotPickRegistry';

export interface PlotPickBuildError {
	readonly featureId: PlotFeatureId;
	readonly featureType: PlotFeature[ 'type' ];
	readonly revision: PlotPickRevision;
	readonly error: unknown;
}

export interface PlotPickAdapterRegistryOptions extends TextPickAdapterOptions {
	readonly adapters: GeometryAdapterRegistry;
	readonly registry: PlotPickRegistry;
	readonly onBuildError?: ( error: PlotPickBuildError ) => void;
}

/**
 * canonical feature 到标准拾取代理的增量同步器。
 * 颜色、hover 和 selection 不进入 revision；只有几何、高度与文本布局变化才重建。
 */
export class PlotPickAdapterRegistry {
	private readonly _registry: PlotPickRegistry;
	private readonly _projection: PlotRenderProjection;
	private readonly _area = new AreaPickAdapter();
	private readonly _line = new LinePickAdapter();
	private readonly _point = new PointPickAdapter();
	private readonly _text: TextPickAdapter;
	private readonly _material = new MeshBasicMaterial( { side: DoubleSide } );
	private readonly _onBuildError?: PlotPickAdapterRegistryOptions[ 'onBuildError' ];
	private _disposed = false;

	public constructor( options: PlotPickAdapterRegistryOptions ) {
		this._registry = options.registry;
		this._projection = new PlotRenderProjection( options.adapters );
		this._text = new TextPickAdapter( options );
		this._onBuildError = options.onBuildError;
		this._registry.registerSharedMaterial( this._material );
	}

	public sync(
		features: readonly Readonly<PlotFeature>[],
		resolved: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry>,
	): void {
		this._assertOpen();
		const activeIds = new Set<PlotFeatureId>();
		features.forEach( ( feature, plotOrder ) => {
			if ( ! feature.visible ) return;
			activeIds.add( feature.id );
			const surface = validResolved( feature, resolved.get( feature.id ) );
			const revision = pickRevision( feature, surface );
			const current = this._registry.get( feature.id );
			if ( current !== undefined && revisionsEqual( current.revision, revision )
				&& current.metadata.plotOrder === plotOrder ) return;
			try {
				const render = this._projection.projectFeature( feature, { resolved } );
				if ( ! render.visible ) {
					this._registry.remove( feature.id );
					return;
				}
				const candidate = this._build( feature, render );
				if ( candidate === null ) throw new Error( `无法为 ${ feature.type } 构建标准拾取几何。` );
				this._registry.replace( {
					metadata: Object.freeze( {
						kind: 'plot-entity', featureId: feature.id, featureType: feature.type,
						source: 'proxy', part: pickPart( feature ), pickPriority: 0, plotOrder,
					} ),
					revision,
					targets: [ candidate.root ], ownedGeometries: candidate.geometries,
				} );
			} catch ( error ) {
				// 候选失败时保留 current，不能让一次排版/三角化异常制造幽灵空洞。
				this._onBuildError?.( Object.freeze( {
					featureId: feature.id, featureType: feature.type, revision, error,
				} ) );
			}
		} );
		for ( const target of [ ...this._registry.targets ] ) {
			const id = target.userData.plotPick?.featureId as PlotFeatureId | undefined;
			if ( id !== undefined && ! activeIds.has( id ) ) this._registry.remove( id );
		}
	}

	public dispose(): void { this._disposed = true; }

	private _build(
		feature: Readonly<PlotFeature>,
		render: ReturnType<PlotRenderProjection[ 'projectFeature' ]>,
	): StandardPickObject | null {
		if ( feature.type === 'point' ) return this._point.build( feature, vertexPosition( render, 0 ), this._material );
		if ( feature.type === 'text' ) return this._text.build( feature, vertexPosition( render, 0 ), this._material );
		if ( feature.type === 'line' ) return this._line.build( render, this._material );
		return this._area.build( render, this._material );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'PlotPickAdapterRegistry 已销毁。' );
	}
}

function vertexPosition(
	render: ReturnType<PlotRenderProjection[ 'projectFeature' ]>,
	index: number,
) {
	const vertex = render.vertices[ index ];
	if ( vertex === undefined ) throw new Error( '拾取几何缺少锚点。' );
	return [ vertex.longitude, vertex.latitude, vertex.resolvedWorldHeight ] as const;
}

function validResolved(
	feature: Readonly<PlotFeature>,
	resolved: ResolvedPlotGeometry | undefined,
): ResolvedPlotGeometry | undefined {
	return resolved?.sourceRevision === feature.revision ? resolved : undefined;
}

function pickRevision(
	feature: Readonly<PlotFeature>,
	resolved: ResolvedPlotGeometry | undefined,
): PlotPickRevision {
	return Object.freeze( {
		featureRevision: feature.revision,
		resolvedGeometryRevision: resolved === undefined ? -1 : hashResolved( resolved ),
		...( feature.type === 'text' ? { layoutRevision: textLayoutRevision( feature ) } : {} ),
	} );
}

function hashResolved( resolved: ResolvedPlotGeometry ): number {
	let hash = resolved.status === 'ready' ? 17 : resolved.status === 'pending' ? 31 : 47;
	for ( const position of resolved.effectivePositions ) {
		hash = ( Math.imul( hash, 31 ) + Math.round( position[ 2 ] * 1000 ) ) | 0;
	}
	return hash;
}

function textLayoutRevision( feature: Extract<PlotFeature, { type: 'text' }> ): number {
	const style = feature.style;
	const value = [ style.content, style.fontSize, style.scale, style.boxWidth ?? '',
		style.boxHeight ?? '', Array.isArray( style.padding ) ? style.padding.join( ',' ) : style.padding,
		style.anchorX, style.anchorY, style.layoutDirection, style.rotation,
		style.offsetX, style.offsetY ].join( '|' );
	let hash = 2166136261;
	for ( let index = 0; index < value.length; index++ ) hash = Math.imul( hash ^ value.charCodeAt( index ), 16777619 );
	return hash | 0;
}

function revisionsEqual( left: PlotPickRevision, right: PlotPickRevision ): boolean {
	return left.featureRevision === right.featureRevision
		&& left.resolvedGeometryRevision === right.resolvedGeometryRevision
		&& left.layoutRevision === right.layoutRevision;
}

function pickPart( feature: Readonly<PlotFeature> ) {
	return feature.type === 'text' ? 'label' as const
		: feature.type === 'point' && feature.style.pointStyle === 'image' ? 'icon' as const
			: feature.type === 'line' ? 'stroke' as const : 'fill' as const;
}
