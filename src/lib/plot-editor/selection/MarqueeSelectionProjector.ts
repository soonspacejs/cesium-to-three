import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { PlotDocument } from '../document/PlotDocument';
import type { PlotFeature, PlotFeatureId } from '../document/types';
import type { SelectionFilter } from '../state/SelectionModel';
import type { ScreenPoint } from '../state/types';
import type { EditorProjectionSnapshot, ProjectedEditorPoint } from './ProjectionSnapshot';

export interface MarqueeSelectionOptions {
	readonly mode?: 'intersects' | 'contains';
	readonly filter?: SelectionFilter;
	readonly maxCandidates?: number;
	readonly onDiagnostic?: ( diagnostic: MarqueeSelectionDiagnostic ) => void;
}

export interface MarqueeSelectionDiagnostic {
	readonly code: 'BOX_SELECTION_LIMIT';
	readonly severity: 'warning';
	readonly message: string;
	readonly candidateCount: number;
	readonly maxCandidates: number;
}

export interface MarqueeSelectionResult {
	readonly ids: readonly PlotFeatureId[];
	readonly truncated: boolean;
	readonly examinedCandidates: number;
}

interface ScreenRectangle {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

interface ProjectedGeometry {
	readonly points: readonly ProjectedEditorPoint[];
	readonly primitive: 'point' | 'polyline' | 'polygon' | 'text';
	readonly closed: boolean;
}

const DEFAULT_BOX_LIMIT = 10_000;

/**
 * 专职框选投影器。它判断投影几何与矩形的区域关系，不参与任何单点实体命中，
 * 也不允许被 click、hover、drag candidate 或双击流程调用。
 */
export class MarqueeSelectionProjector {
	private readonly _document: PlotDocument;
	private readonly _adapters: GeometryAdapterRegistry;

	public constructor( document: PlotDocument, adapters: GeometryAdapterRegistry ) {
		this._document = document;
		this._adapters = adapters;
	}

	public select(
		start: ScreenPoint,
		end: ScreenPoint,
		projection: EditorProjectionSnapshot,
		options: MarqueeSelectionOptions = {},
	): MarqueeSelectionResult {
		assertScreenPoint( start );
		assertScreenPoint( end );
		const rectangle = normalizeRectangle( start, end );
		const maximum = positiveSafeInteger( options.maxCandidates ?? DEFAULT_BOX_LIMIT );
		const eligible = this._document.getAll().filter( ( feature ) =>
			eligibleFeature( feature, options.filter ?? {} ) );
		const truncated = eligible.length > maximum;
		if ( truncated ) options.onDiagnostic?.( Object.freeze( {
			code: 'BOX_SELECTION_LIMIT', severity: 'warning',
			message: `框选候选 ${ eligible.length } 个，已按文档顺序截断到 ${ maximum } 个。`,
			candidateCount: eligible.length, maxCandidates: maximum,
		} ) );
		const examined = eligible.slice( 0, maximum );
		const ids = examined.filter( ( feature ) => featureMatchesRectangle(
			projectFeature( feature, projection, this._adapters, options.filter ),
			rectangle,
			options.mode ?? 'intersects',
		) ).map( ( feature ) => feature.id );
		return Object.freeze( {
			ids: Object.freeze( ids ), truncated, examinedCandidates: examined.length,
		} );
	}
}

function projectFeature(
	feature: Readonly<PlotFeature>,
	projection: EditorProjectionSnapshot,
	adapters: GeometryAdapterRegistry,
	filter?: SelectionFilter,
): ProjectedGeometry | null {
	const description = adapters.require( feature.type ).toRenderDescription( feature as never );
	const points: ProjectedEditorPoint[] = [];
	for ( const position of description.positions ) {
		const projected = projection.project( position );
		if ( ! selectableProjection( projected, filter ) ) return null;
		points.push( projected );
	}
	return Object.freeze( {
		points: Object.freeze( points ),
		primitive: description.primitive,
		closed: description.closed,
	} );
}

function featureMatchesRectangle(
	geometry: ProjectedGeometry | null,
	rectangle: ScreenRectangle,
	mode: 'intersects' | 'contains',
): boolean {
	if ( geometry === null || geometry.points.length === 0 ) return false;
	if ( mode === 'contains' ) return geometry.points.every( ( point ) => inRectangle( point, rectangle ) );
	if ( geometry.points.some( ( point ) => inRectangle( point, rectangle ) ) ) return true;
	if ( geometry.primitive === 'polygon'
		&& rectangleCorners( rectangle ).some( ( corner ) => inPolygon( corner, geometry.points ) ) ) return true;
	return pathIntersectsRectangle( geometry.points, geometry.closed, rectangle );
}

function eligibleFeature( feature: Readonly<PlotFeature>, filter: SelectionFilter ): boolean {
	if ( ( filter.visibleOnly ?? true ) && ! feature.visible ) return false;
	if ( ( filter.editableOnly ?? true ) && feature.properties.editable === false ) return false;
	const locked = feature.properties.locked === true;
	if ( filter.lockedOnly === true ? ! locked : locked ) return false;
	return filter.typeAllowList === undefined || filter.typeAllowList.includes( feature.type );
}

function selectableProjection(
	point: ProjectedEditorPoint | null,
	filter?: SelectionFilter,
): point is ProjectedEditorPoint {
	return point !== null && point.visible && Number.isFinite( point.x )
		&& Number.isFinite( point.y ) && Number.isFinite( point.depth )
		&& ( filter?.selectThrough === true || point.occluded !== true );
}

function normalizeRectangle( start: ScreenPoint, end: ScreenPoint ): ScreenRectangle {
	return Object.freeze( { minX: Math.min( start.x, end.x ), minY: Math.min( start.y, end.y ),
		maxX: Math.max( start.x, end.x ), maxY: Math.max( start.y, end.y ) } );
}

function inRectangle( point: ScreenPoint, rectangle: ScreenRectangle ): boolean {
	return point.x >= rectangle.minX && point.x <= rectangle.maxX
		&& point.y >= rectangle.minY && point.y <= rectangle.maxY;
}

function rectangleCorners( rectangle: ScreenRectangle ): readonly ScreenPoint[] {
	return [ { x: rectangle.minX, y: rectangle.minY }, { x: rectangle.maxX, y: rectangle.minY },
		{ x: rectangle.maxX, y: rectangle.maxY }, { x: rectangle.minX, y: rectangle.maxY } ];
}

function pathIntersectsRectangle(
	points: readonly ScreenPoint[],
	closed: boolean,
	rectangle: ScreenRectangle,
): boolean {
	if ( points.length < 2 ) return false;
	const corners = rectangleCorners( rectangle );
	const edges = corners.map( ( corner, index ) => [ corner, corners[ ( index + 1 ) % 4 ] ] as const );
	const count = closed ? points.length : points.length - 1;
	for ( let index = 0; index < count; index++ ) {
		const start = points[ index ];
		const end = points[ ( index + 1 ) % points.length ];
		if ( edges.some( ( edge ) => segmentsIntersect( start, end, edge[ 0 ], edge[ 1 ] ) ) ) return true;
	}
	return false;
}

function inPolygon( point: ScreenPoint, polygon: readonly ScreenPoint[] ): boolean {
	let inside = false;
	for ( let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++ ) {
		const a = polygon[ current ];
		const b = polygon[ previous ];
		if ( distanceToSegment( point, a, b ) <= 1e-9 ) return true;
		if ( ( a.y > point.y ) !== ( b.y > point.y )
			&& point.x < ( b.x - a.x ) * ( point.y - a.y ) / ( b.y - a.y ) + a.x ) inside = ! inside;
	}
	return inside;
}

function segmentsIntersect( a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, d: ScreenPoint ): boolean {
	const orientation = ( p: ScreenPoint, q: ScreenPoint, r: ScreenPoint ) =>
		( q.x - p.x ) * ( r.y - p.y ) - ( q.y - p.y ) * ( r.x - p.x );
	const abC = orientation( a, b, c ); const abD = orientation( a, b, d );
	const cdA = orientation( c, d, a ); const cdB = orientation( c, d, b );
	const epsilon = 1e-9;
	if ( Math.abs( abC ) <= epsilon && distanceToSegment( c, a, b ) <= epsilon ) return true;
	if ( Math.abs( abD ) <= epsilon && distanceToSegment( d, a, b ) <= epsilon ) return true;
	if ( Math.abs( cdA ) <= epsilon && distanceToSegment( a, c, d ) <= epsilon ) return true;
	if ( Math.abs( cdB ) <= epsilon && distanceToSegment( b, c, d ) <= epsilon ) return true;
	return ( abC > 0 ) !== ( abD > 0 ) && ( cdA > 0 ) !== ( cdB > 0 );
}

function distanceToSegment( point: ScreenPoint, start: ScreenPoint, end: ScreenPoint ): number {
	const dx = end.x - start.x; const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	if ( lengthSquared === 0 ) return Math.hypot( point.x - start.x, point.y - start.y );
	const amount = Math.max( 0, Math.min( 1,
		( ( point.x - start.x ) * dx + ( point.y - start.y ) * dy ) / lengthSquared ) );
	return Math.hypot( point.x - start.x - amount * dx, point.y - start.y - amount * dy );
}

function assertScreenPoint( point: ScreenPoint ): void {
	if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) ) throw new TypeError( '屏幕坐标必须是有限数。' );
}

function positiveSafeInteger( value: number ): number {
	if ( ! Number.isSafeInteger( value ) || value <= 0 ) throw new RangeError( 'maxCandidates 必须是正安全整数。' );
	return value;
}
