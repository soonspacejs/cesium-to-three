import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { EditHandle } from '../adapters/types';
import type { PlotDocument } from '../document/PlotDocument';
import type {
	PlotFeature,
	PlotFeatureId,
	Position3D,
} from '../document/types';
import type { SelectionFilter } from '../state/SelectionModel';
import type { HitTarget, ScreenPoint } from '../state/types';

export interface ProjectedEditorPoint extends ScreenPoint {
	/** 归一化或相机空间深度；数值越小越靠前。 */
	readonly depth: number;
	readonly visible: boolean;
	/** 宿主有深度信息时标记遮挡；框选 selectThrough 可显式忽略它。 */
	readonly occluded?: boolean;
}

/** 一次命中/框选必须复用同一投影快照，避免相机变化导致边界抖动。 */
export interface EditorProjectionSnapshot {
	project( position: Position3D ): ProjectedEditorPoint | null;
}

export type OverlayHitLayer =
	| 'active-handle'
	| 'gizmo'
	| 'handle'
	| 'entity-proxy';

export interface OverlayHitCandidate {
	readonly layer: OverlayHitLayer;
	readonly target: HitTarget;
}

export interface PointHitTestOptions {
	readonly pointerType?: 'mouse' | 'pen' | 'touch';
	readonly selectedIds?: readonly PlotFeatureId[];
	readonly activeHandleId?: string;
	readonly overlayHits?: readonly OverlayHitCandidate[];
	readonly filter?: SelectionFilter;
	readonly entityToleranceCssPixels?: number;
}

export interface BoxSelectionOptions {
	readonly mode?: 'intersects' | 'contains';
	readonly filter?: SelectionFilter;
	readonly maxCandidates?: number;
	readonly onDiagnostic?: ( diagnostic: BoxSelectionDiagnostic ) => void;
}

export interface ScreenRectangle {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export interface BoxSelectionDiagnostic {
	readonly code: 'BOX_SELECTION_LIMIT';
	readonly severity: 'warning';
	readonly message: string;
	readonly candidateCount: number;
	readonly maxCandidates: number;
}

export interface BoxSelectionResult {
	readonly ids: readonly PlotFeatureId[];
	readonly truncated: boolean;
	readonly examinedCandidates: number;
}

interface Candidate {
	readonly target: HitTarget;
	readonly priority: number;
	readonly documentOrder: number;
	readonly stableId: string;
}

interface ProjectedGeometry {
	readonly points: readonly ProjectedEditorPoint[];
	readonly primitive: 'point' | 'polyline' | 'polygon' | 'text';
	readonly closed: boolean;
}

const DEFAULT_ENTITY_TOLERANCE = 6;
const DEFAULT_BOX_LIMIT = 10_000;
const OVERLAY_PRIORITY: Readonly<Record<OverlayHitLayer, number>> = Object.freeze( {
	'active-handle': 600,
	gizmo: 500,
	handle: 400,
	'entity-proxy': 300,
} );

/**
 * 选择专用的纯 CPU 命中器。
 *
 * classification mesh、模型和 3D Tiles 不进入此模块；它们只能由 surface picker
 * 提供地表点。实体身份来自 canonical feature、控制点或显式 editor proxy。
 */
export class FeatureHitTester {
	private readonly _document: PlotDocument;
	private readonly _registry: GeometryAdapterRegistry;

	public constructor(
		document: PlotDocument,
		registry: GeometryAdapterRegistry,
	) {
		this._document = document;
		this._registry = registry;
	}

	public hitTest(
		screen: ScreenPoint,
		projection: EditorProjectionSnapshot,
		options: PointHitTestOptions = {},
	): HitTarget | null {
		assertScreenPoint( screen );
		const candidates: Candidate[] = [];
		const order = new Map(
			this._document.getAll().map( ( feature, index ) => [ feature.id, index ] ),
		);

		for ( const overlay of options.overlayHits ?? [] ) {
			if ( overlay.target.kind === 'none' || overlay.target.kind === 'surface' ) continue;
			if ( overlay.target.entityId !== undefined ) {
				const feature = this._document.get( overlay.target.entityId );
				if ( feature === undefined || ! eligibleFeature( feature, options.filter ?? {} ) ) continue;
			}
			candidates.push( {
				target: freezeHit( overlay.target, false ),
				priority: OVERLAY_PRIORITY[ overlay.layer ],
				documentOrder: overlay.target.entityId === undefined
					? Number.MAX_SAFE_INTEGER
					: order.get( overlay.target.entityId ) ?? Number.MAX_SAFE_INTEGER,
				stableId: stableTargetId( overlay.target ),
			} );
		}

		const selected = new Set( options.selectedIds ?? [] );
		const handleRadius = options.pointerType === 'touch' ? 14 : 8;
		for ( const id of selected ) {
			const feature = this._document.get( id );
			if ( feature === undefined || ! eligibleFeature( feature, options.filter ?? {} ) ) continue;
			const adapter = this._registry.require( feature.type );
			for ( const handle of adapter.listHandles( feature as never ) ) {
				const projected = projectHandle( handle, projection );
				if ( ! isSelectableProjection( projected, options.filter ) ) continue;
				const distance = distance2D( screen, projected );
				if ( distance > handleRadius ) continue;
				const active = handle.id === options.activeHandleId;
				const kind = handle.kind === 'vertex'
					? 'vertex'
					: handle.kind === 'midpoint' ? 'midpoint' : 'gizmo';
				const target = freezeHit( {
					kind,
					entityId: feature.id,
					handleId: handle.id,
					distanceCssPixels: distance,
					depth: projected.depth,
					zOrder: handle.priority,
				}, false );
				candidates.push( {
					target,
					priority: active ? OVERLAY_PRIORITY[ 'active-handle' ] : OVERLAY_PRIORITY.handle,
					documentOrder: order.get( feature.id ) ?? Number.MAX_SAFE_INTEGER,
					stableId: stableTargetId( target ),
				} );
			}
		}

		const tolerance = finiteNonNegative(
			options.entityToleranceCssPixels ?? DEFAULT_ENTITY_TOLERANCE,
			'entityToleranceCssPixels',
		);
		for ( const [ documentOrder, feature ] of this._document.getAll().entries() ) {
			if ( ! eligibleFeature( feature, options.filter ?? {} ) ) continue;
			const hit = hitFeature( feature, screen, projection, this._registry, tolerance, options.filter );
			if ( hit === null ) continue;
			const target = freezeHit( {
				kind: 'entity',
				entityId: feature.id,
				distanceCssPixels: hit.distance,
				depth: hit.depth,
				zOrder: featureZOrder( feature ),
			}, true );
			candidates.push( {
				target,
				priority: selected.has( feature.id ) ? 220 : 200,
				documentOrder,
				stableId: feature.id,
			} );
		}

		candidates.sort( compareCandidates );
		return candidates[ 0 ]?.target ?? null;
	}

	public selectBox(
		start: ScreenPoint,
		end: ScreenPoint,
		projection: EditorProjectionSnapshot,
		options: BoxSelectionOptions = {},
	): BoxSelectionResult {
		assertScreenPoint( start );
		assertScreenPoint( end );
		const rectangle = normalizeRectangle( start, end );
		const maximum = positiveSafeInteger(
			options.maxCandidates ?? DEFAULT_BOX_LIMIT,
			'maxCandidates',
		);
		const eligible = this._document.getAll().filter(
			( feature ) => eligibleFeature( feature, options.filter ?? {} ),
		);
		const truncated = eligible.length > maximum;
		if ( truncated ) {
			options.onDiagnostic?.( Object.freeze( {
				code: 'BOX_SELECTION_LIMIT',
				severity: 'warning',
				message: `框选候选 ${ eligible.length } 个，已按文档顺序截断到 ${ maximum } 个。`,
				candidateCount: eligible.length,
				maxCandidates: maximum,
			} ) );
		}
		const examined = eligible.slice( 0, maximum );
		const ids = examined
			.filter( ( feature ) => featureMatchesRectangle(
				feature,
				rectangle,
				projection,
				this._registry,
				options.mode ?? 'intersects',
				options.filter,
			) )
			.map( ( feature ) => feature.id );
		return Object.freeze( {
			ids: Object.freeze( ids ),
			truncated,
			examinedCandidates: examined.length,
		} );
	}
}

function hitFeature(
	feature: Readonly<PlotFeature>,
	screen: ScreenPoint,
	projection: EditorProjectionSnapshot,
	registry: GeometryAdapterRegistry,
	baseTolerance: number,
	filter?: SelectionFilter,
): { readonly distance: number; readonly depth: number } | null {
	const geometry = projectFeature( feature, projection, registry, filter );
	if ( geometry === null || geometry.points.length === 0 ) return null;
	const strokeWidth = Number.isFinite( feature.style.strokeWidth )
		? Math.max( 0, feature.style.strokeWidth )
		: 0;
	const tolerance = Math.max( baseTolerance, strokeWidth / 2 );
	let distance = Number.POSITIVE_INFINITY;
	if ( geometry.primitive === 'point' || geometry.primitive === 'text' ) {
		distance = distance2D( screen, geometry.points[ 0 ] );
		if ( feature.type === 'point' ) {
			const styleRadius = feature.style.pointStyle === 'image'
				? Math.max( feature.style.imageWidth, feature.style.imageHeight ) / 2
				: feature.style.size / 2;
			if ( distance <= Math.max( tolerance, styleRadius ) ) distance = 0;
		}
	} else if ( geometry.primitive === 'polygon'
		&& pointInPolygon( screen, geometry.points ) ) {
		distance = 0;
	} else {
		distance = distanceToPath( screen, geometry.points, geometry.closed );
	}
	if ( distance > tolerance ) return null;
	return {
		distance,
		depth: minimumDepth( geometry.points ),
	};
}

function featureMatchesRectangle(
	feature: Readonly<PlotFeature>,
	rectangle: ScreenRectangle,
	projection: EditorProjectionSnapshot,
	registry: GeometryAdapterRegistry,
	mode: 'intersects' | 'contains',
	filter?: SelectionFilter,
): boolean {
	const geometry = projectFeature( feature, projection, registry, filter );
	if ( geometry === null || geometry.points.length === 0 ) return false;
	if ( mode === 'contains' ) {
		return geometry.points.every( ( point ) => pointInRectangle( point, rectangle ) );
	}
	if ( geometry.points.some( ( point ) => pointInRectangle( point, rectangle ) ) ) return true;
	if ( geometry.primitive === 'polygon' ) {
		const corners = rectangleCorners( rectangle );
		if ( corners.some( ( corner ) => pointInPolygon( corner, geometry.points ) ) ) return true;
	}
	return pathIntersectsRectangle( geometry.points, geometry.closed, rectangle );
}

function projectFeature(
	feature: Readonly<PlotFeature>,
	projection: EditorProjectionSnapshot,
	registry: GeometryAdapterRegistry,
	filter?: SelectionFilter,
): ProjectedGeometry | null {
	const adapter = registry.require( feature.type );
	let description = adapter.toRenderDescription( feature as never );
	// 箭头命中只使用 source control line，绝不反向选择派生轮廓点。
	if ( feature.type === 'arrow' ) {
		description = {
			...description,
			primitive: 'polyline',
			positions: feature.geometry.positions,
			closed: false,
		};
	}
	const points: ProjectedEditorPoint[] = [];
	for ( const position of description.positions ) {
		const projected = projection.project( position );
		if ( ! isSelectableProjection( projected, filter ) ) return null;
		points.push( projected );
	}
	return { points, primitive: description.primitive, closed: description.closed };
}

function projectHandle(
	handle: EditHandle,
	projection: EditorProjectionSnapshot,
): ProjectedEditorPoint | null {
	const projected = projection.project( handle.position );
	if ( projected === null || handle.screenOffsetCssPixels === undefined ) return projected;
	return Object.freeze( {
		...projected,
		x: projected.x + handle.screenOffsetCssPixels[ 0 ],
		y: projected.y + handle.screenOffsetCssPixels[ 1 ],
	} );
}

function eligibleFeature(
	feature: Readonly<PlotFeature>,
	filter: SelectionFilter,
): boolean {
	if ( ( filter.visibleOnly ?? true ) && ! feature.visible ) return false;
	if ( ( filter.editableOnly ?? true ) && feature.properties.editable === false ) return false;
	const locked = feature.properties.locked === true;
	if ( filter.lockedOnly === true ? ! locked : locked ) return false;
	return filter.typeAllowList === undefined || filter.typeAllowList.includes( feature.type );
}

function featureZOrder( feature: Readonly<PlotFeature> ): number {
	const value = feature.properties.zOrder;
	return typeof value === 'number' && Number.isFinite( value ) ? value : 0;
}

function isSelectableProjection(
	point: ProjectedEditorPoint | null,
	filter?: SelectionFilter,
): point is ProjectedEditorPoint {
	return point !== null
		&& point.visible
		&& Number.isFinite( point.x )
		&& Number.isFinite( point.y )
		&& Number.isFinite( point.depth )
		&& ( filter?.selectThrough === true || point.occluded !== true );
}

function compareCandidates( left: Candidate, right: Candidate ): number {
	return right.priority - left.priority
		|| left.target.distanceCssPixels - right.target.distanceCssPixels
		|| ( left.target.depth ?? Number.POSITIVE_INFINITY )
			- ( right.target.depth ?? Number.POSITIVE_INFINITY )
		|| ( right.target.zOrder ?? 0 ) - ( left.target.zOrder ?? 0 )
		|| left.documentOrder - right.documentOrder
		|| left.stableId.localeCompare( right.stableId );
}

function freezeHit( target: HitTarget, depthApproximate: boolean ): HitTarget {
	return Object.freeze( {
		...target,
		...( target.depth === undefined ? {} : { depthApproximate } ),
	} );
}

function stableTargetId( target: HitTarget ): string {
	return `${ target.entityId ?? '' }/${ target.handleId ?? '' }/${ target.kind }`;
}

function minimumDepth( points: readonly ProjectedEditorPoint[] ): number {
	return Math.min( ...points.map( ( point ) => point.depth ) );
}

function distance2D( left: ScreenPoint, right: ScreenPoint ): number {
	return Math.hypot( left.x - right.x, left.y - right.y );
}

function distanceToPath(
	point: ScreenPoint,
	positions: readonly ScreenPoint[],
	closed: boolean,
): number {
	if ( positions.length === 1 ) return distance2D( point, positions[ 0 ] );
	let minimum = Number.POSITIVE_INFINITY;
	const segments = closed ? positions.length : positions.length - 1;
	for ( let index = 0; index < segments; index++ ) {
		minimum = Math.min(
			minimum,
			distanceToSegment( point, positions[ index ], positions[ ( index + 1 ) % positions.length ] ),
		);
	}
	return minimum;
}

function distanceToSegment(
	point: ScreenPoint,
	start: ScreenPoint,
	end: ScreenPoint,
): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	if ( lengthSquared === 0 ) return distance2D( point, start );
	const amount = Math.max( 0, Math.min( 1,
		( ( point.x - start.x ) * dx + ( point.y - start.y ) * dy ) / lengthSquared,
	) );
	return Math.hypot(
		point.x - ( start.x + amount * dx ),
		point.y - ( start.y + amount * dy ),
	);
}

function pointInPolygon(
	point: ScreenPoint,
	polygon: readonly ScreenPoint[],
): boolean {
	let inside = false;
	for ( let current = 0, previous = polygon.length - 1;
		current < polygon.length;
		previous = current++ ) {
		const a = polygon[ current ];
		const b = polygon[ previous ];
		if ( distanceToSegment( point, a, b ) <= 1e-9 ) return true;
		const crosses = ( a.y > point.y ) !== ( b.y > point.y )
			&& point.x < ( b.x - a.x ) * ( point.y - a.y ) / ( b.y - a.y ) + a.x;
		if ( crosses ) inside = ! inside;
	}
	return inside;
}

function normalizeRectangle( start: ScreenPoint, end: ScreenPoint ): ScreenRectangle {
	return Object.freeze( {
		minX: Math.min( start.x, end.x ),
		minY: Math.min( start.y, end.y ),
		maxX: Math.max( start.x, end.x ),
		maxY: Math.max( start.y, end.y ),
	} );
}

function pointInRectangle( point: ScreenPoint, rectangle: ScreenRectangle ): boolean {
	return point.x >= rectangle.minX && point.x <= rectangle.maxX
		&& point.y >= rectangle.minY && point.y <= rectangle.maxY;
}

function rectangleCorners( rectangle: ScreenRectangle ): readonly ScreenPoint[] {
	return [
		{ x: rectangle.minX, y: rectangle.minY },
		{ x: rectangle.maxX, y: rectangle.minY },
		{ x: rectangle.maxX, y: rectangle.maxY },
		{ x: rectangle.minX, y: rectangle.maxY },
	];
}

function pathIntersectsRectangle(
	points: readonly ScreenPoint[],
	closed: boolean,
	rectangle: ScreenRectangle,
): boolean {
	if ( points.length < 2 ) return false;
	const corners = rectangleCorners( rectangle );
	const edges = corners.map( ( corner, index ) => [
		corner,
		corners[ ( index + 1 ) % corners.length ],
	] as const );
	const segmentCount = closed ? points.length : points.length - 1;
	for ( let index = 0; index < segmentCount; index++ ) {
		const start = points[ index ];
		const end = points[ ( index + 1 ) % points.length ];
		if ( edges.some( ( edge ) => segmentsIntersect( start, end, edge[ 0 ], edge[ 1 ] ) ) ) {
			return true;
		}
	}
	return false;
}

function segmentsIntersect(
	a: ScreenPoint,
	b: ScreenPoint,
	c: ScreenPoint,
	d: ScreenPoint,
): boolean {
	const orientation = ( p: ScreenPoint, q: ScreenPoint, r: ScreenPoint ) =>
		( q.x - p.x ) * ( r.y - p.y ) - ( q.y - p.y ) * ( r.x - p.x );
	const abC = orientation( a, b, c );
	const abD = orientation( a, b, d );
	const cdA = orientation( c, d, a );
	const cdB = orientation( c, d, b );
	const epsilon = 1e-9;
	if ( Math.abs( abC ) <= epsilon && distanceToSegment( c, a, b ) <= epsilon ) return true;
	if ( Math.abs( abD ) <= epsilon && distanceToSegment( d, a, b ) <= epsilon ) return true;
	if ( Math.abs( cdA ) <= epsilon && distanceToSegment( a, c, d ) <= epsilon ) return true;
	if ( Math.abs( cdB ) <= epsilon && distanceToSegment( b, c, d ) <= epsilon ) return true;
	return ( abC > 0 ) !== ( abD > 0 ) && ( cdA > 0 ) !== ( cdB > 0 );
}

function assertScreenPoint( point: ScreenPoint ): void {
	if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) ) {
		throw new TypeError( '屏幕坐标必须是有限数。' );
	}
}

function finiteNonNegative( value: number, name: string ): number {
	if ( ! Number.isFinite( value ) || value < 0 ) {
		throw new RangeError( `${ name } 必须是非负有限数。` );
	}
	return value;
}

function positiveSafeInteger( value: number, name: string ): number {
	if ( ! Number.isSafeInteger( value ) || value <= 0 ) {
		throw new RangeError( `${ name } 必须是正安全整数。` );
	}
	return value;
}
