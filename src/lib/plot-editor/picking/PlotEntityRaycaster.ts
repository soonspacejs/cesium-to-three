import {
	Raycaster,
	Vector2,
	type Camera,
	type Intersection,
	type Object3D,
	type Vector3,
} from 'three';
import type { PlotFeatureId } from '../document/types';
import { EditorOverlayLayer } from '../render/layers';
import {
	resolvePlotPickMetadata,
	type PlotPickMetadata,
} from './PlotPickMetadata';
import type { PlotPickRegistry } from './PlotPickRegistry';

export interface PlotEntityHit {
	readonly featureId: PlotFeatureId;
	readonly point: Vector3;
	readonly distance: number;
	readonly object: Object3D;
	readonly faceIndex?: number;
	readonly metadata: PlotPickMetadata;
}

export interface PlotEntityRaycasterOptions {
	readonly near?: number;
	readonly far?: number;
	readonly lineThreshold?: number;
	readonly pointsThreshold?: number;
	/** hidden/deleted 通常直接从 registry 移除；此过滤器处理锁定或临时禁选策略。 */
	readonly isSelectable?: ( metadata: PlotPickMetadata ) => boolean;
}

const DISTANCE_TIE_EPSILON = 1e-6;

/**
 * 标绘实体唯一的单点命中执行器。它只调用 Three Raycaster，不读取经纬度，
 * 也不包含任何圆、线、多边形或文本的自定义求交算法。
 */
export class PlotEntityRaycaster {
	private readonly _registry: PlotPickRegistry;
	private readonly _raycaster = new Raycaster();
	private readonly _isSelectable?: PlotEntityRaycasterOptions[ 'isSelectable' ];
	private _disposed = false;

	public constructor(
		registry: PlotPickRegistry,
		options: PlotEntityRaycasterOptions = {},
	) {
		this._registry = registry;
		this._isSelectable = options.isSelectable;
		this._raycaster.near = options.near ?? 0;
		this._raycaster.far = options.far ?? Number.POSITIVE_INFINITY;
		this._raycaster.params.Line = { threshold: options.lineThreshold ?? 1 };
		this._raycaster.params.Points = { threshold: options.pointsThreshold ?? 1 };
		this._raycaster.layers.set( EditorOverlayLayer.PLOT_PICK );
	}

	public get raycaster(): Readonly<Raycaster> { return this._raycaster; }

	public hitTest( ndc: Readonly<Vector2>, camera: Camera ): PlotEntityHit | null {
		return this.hitTestAll( ndc, camera )[ 0 ] ?? null;
	}

	public hitTestAll(
		ndc: Readonly<Vector2>,
		camera: Camera,
	): readonly PlotEntityHit[] {
		if ( this._disposed || ! isValidNdc( ndc ) || this._registry.targets.length === 0 ) {
			return Object.freeze( [] );
		}
		camera.updateMatrixWorld();
		// 代理共享同一 root，一次树遍历即可刷新全部 matrixWorld，避免 1,000 个
		// 实体逐个向上回溯父节点；直接复用的显示对象再单独刷新其所在场景树。
		this._registry.root.updateWorldMatrix( true, true );
		for ( const target of this._registry.targets ) {
			if ( target.parent !== this._registry.root ) target.updateWorldMatrix( true, true );
		}
		this._raycaster.setFromCamera( ndc, camera );
		const intersections = this._raycaster.intersectObjects(
			this._registry.targets as Object3D[], true,
		);
		return Object.freeze( normalizeIntersections(
			intersections,
			this._registry,
			this._isSelectable,
		) );
	}

	public dispose(): void {
		this._disposed = true;
	}
}

function normalizeIntersections(
	intersections: readonly Intersection<Object3D>[],
	registry: PlotPickRegistry,
	isSelectable?: PlotEntityRaycasterOptions[ 'isSelectable' ],
): PlotEntityHit[] {
	const closestByFeature = new Map<PlotFeatureId, PlotEntityHit>();
	for ( const intersection of intersections ) {
		const metadata = resolvePlotPickMetadata( intersection.object );
		if ( metadata === null || ! registry.has( metadata.featureId )
			|| isSelectable?.( metadata ) === false ) continue;
		const hit = Object.freeze( {
			featureId: metadata.featureId,
			point: intersection.point.clone(),
			distance: intersection.distance,
			object: intersection.object,
			...( intersection.faceIndex === undefined || intersection.faceIndex === null
				? {} : { faceIndex: intersection.faceIndex } ),
			metadata,
		} );
		const current = closestByFeature.get( hit.featureId );
		if ( current === undefined || compareHits( hit, current ) < 0 ) {
			closestByFeature.set( hit.featureId, hit );
		}
	}
	return [ ...closestByFeature.values() ].sort( compareHits );
}

function compareHits( left: PlotEntityHit, right: PlotEntityHit ): number {
	const distanceDelta = left.distance - right.distance;
	if ( Math.abs( distanceDelta ) > DISTANCE_TIE_EPSILON ) return distanceDelta;
	if ( left.metadata.pickPriority !== right.metadata.pickPriority ) {
		return right.metadata.pickPriority - left.metadata.pickPriority;
	}
	if ( left.metadata.plotOrder !== right.metadata.plotOrder ) {
		return right.metadata.plotOrder - left.metadata.plotOrder;
	}
	const partDelta = partRank( right.metadata.part ) - partRank( left.metadata.part );
	if ( partDelta !== 0 ) return partDelta;
	return left.featureId.localeCompare( right.featureId );
}

function partRank( part: PlotPickMetadata[ 'part' ] ): number {
	return part === 'label' || part === 'icon' ? 2
		: part === 'fill' || part === 'stroke' ? 1 : 0;
}

function isValidNdc( ndc: Readonly<Vector2> ): boolean {
	return Number.isFinite( ndc.x ) && Number.isFinite( ndc.y )
		&& ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
}
