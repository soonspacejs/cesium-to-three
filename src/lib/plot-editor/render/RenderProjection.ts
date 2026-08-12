import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { DraftPreviewGeometry } from '../adapters/types';
import { getClassificationType, isHeightReferenceRelative } from '../document/height-reference';
import type {
	HeightReference,
	PlotFeature,
	PlotFeatureId,
	PlotFeatureType,
	PlotStyle,
	Position3D,
	ResolvedPlotGeometry,
} from '../document/types';
import { HeightReference as HeightReferenceValue } from '../document/types';
import { getFeaturePositions } from '../picking/height-resolver';
import type { ClassificationType } from '../../ground/types';

export const enum RenderDirtyFlag {
	None = 0,
	Transform = 1 << 0,
	Geometry = 1 << 1,
	Topology = 1 << 2,
	Style = 1 << 3,
	HeightResolution = 1 << 4,
	Visibility = 1 << 5,
	Picking = 1 << 6,
}

export interface RenderVertex {
	readonly longitude: number;
	readonly latitude: number;
	readonly authorHeight: number;
	readonly resolvedWorldHeight: number;
}

export type RenderPath = 'ground-classification' | 'plain-rte';

export interface RenderFeature {
	readonly id: PlotFeatureId;
	readonly type: PlotFeatureType;
	readonly heightReference: HeightReference;
	readonly primitive: DraftPreviewGeometry[ 'primitive' ];
	readonly closed: boolean;
	readonly generated: boolean;
	readonly vertices: readonly RenderVertex[];
	readonly sourceVertices: readonly RenderVertex[];
	readonly style: Readonly<PlotStyle & Record<string, unknown>>;
	readonly properties: Readonly<PlotFeature[ 'properties' ]>;
	readonly revision: number;
	readonly visible: boolean;
	readonly path: RenderPath;
	readonly classificationType?: ClassificationType;
	readonly surfaceStatus: 'ready' | 'pending' | 'unavailable';
	readonly surfacePending: boolean;
}

export interface RenderProjectionContext {
	readonly resolved?: ReadonlyMap<PlotFeatureId, ResolvedPlotGeometry>;
}

/**
 * canonical document 到渲染 DTO 的单向纯投影。
 * authorHeight 与 resolvedWorldHeight 始终分栏，renderer 没有反向写文档的入口。
 */
export class PlotRenderProjection {
	private readonly _adapters: GeometryAdapterRegistry;

	public constructor( adapters: GeometryAdapterRegistry ) {
		this._adapters = adapters;
	}

	public projectFeature(
		feature: Readonly<PlotFeature>,
		context: RenderProjectionContext = {},
	): RenderFeature {
		const adapter = this._adapters.require( feature.type );
		const geometry = adapter.toRenderDescription( feature as never );
		const sourcePositions = getFeaturePositions( feature );
		const resolved = validResolved( feature, context.resolved?.get( feature.id ) );
		const surfaceStatus = resolveSurfaceStatus( feature.heightReference, resolved );
		const effectiveRenderPositions = resolved?.effectiveRenderPositions;
		const sourceVertices = sourcePositions.map( ( position, index ) =>
			toRenderVertex(
				position,
				resolved?.effectivePositions[ index ]?.[ 2 ] ?? fallbackWorldHeight( feature, position ),
			) );
		const vertices = geometry.positions.map( ( position, renderIndex ) => {
			const resolvedRenderPosition = effectiveRenderPositions?.[ renderIndex ];
			if ( resolvedRenderPosition !== undefined ) {
				return toRenderVertex( position, resolvedRenderPosition[ 2 ] );
			}
			const sourceIndex = closestSourceIndex( position, sourcePositions );
			const source = sourcePositions[ sourceIndex ];
			const effective = resolved?.effectivePositions[ sourceIndex ];
			let worldHeight = fallbackWorldHeight( feature, position );
			if ( effective !== undefined ) {
				const surfaceHeight = isHeightReferenceRelative( feature.heightReference )
					? effective[ 2 ] - source[ 2 ]
					: effective[ 2 ];
				worldHeight = isHeightReferenceRelative( feature.heightReference )
					? surfaceHeight + position[ 2 ]
					: surfaceHeight;
			}
			return toRenderVertex( position, worldHeight );
		} );
		const ground = isClampReference( feature.heightReference );
		return Object.freeze( {
			id: feature.id,
			type: feature.type,
			heightReference: feature.heightReference,
			primitive: geometry.primitive,
			closed: geometry.closed,
			generated: geometry.generated,
			vertices: Object.freeze( vertices ),
			sourceVertices: Object.freeze( sourceVertices ),
			style: feature.style as PlotStyle & Record<string, unknown>,
			properties: feature.properties,
			revision: feature.revision,
			visible: feature.visible && surfaceStatus !== 'unavailable',
			path: ground ? 'ground-classification' : 'plain-rte',
			...( ground ? { classificationType: getClassificationType( feature.heightReference ) } : {} ),
			surfaceStatus,
			surfacePending: surfaceStatus === 'pending',
		} );
	}
}

/** revision 之外单独比较 surface/status，支持 surface 重采样不改 document revision。 */
export function diffRenderFeature(
	previous: RenderFeature | undefined,
	next: RenderFeature,
): RenderDirtyFlag {
	if ( previous === undefined || previous.type !== next.type || previous.path !== next.path ) {
		return RenderDirtyFlag.Topology
			| RenderDirtyFlag.Geometry
			| RenderDirtyFlag.Style
			| RenderDirtyFlag.HeightResolution
			| RenderDirtyFlag.Visibility
			| RenderDirtyFlag.Picking;
	}
	let flags = RenderDirtyFlag.None;
	if ( previous.revision !== next.revision ) {
		if ( previous.vertices.length !== next.vertices.length
			|| previous.closed !== next.closed
			|| previous.primitive !== next.primitive ) flags |= RenderDirtyFlag.Topology;
		else flags |= RenderDirtyFlag.Geometry;
		if ( previous.style !== next.style ) flags |= RenderDirtyFlag.Style;
		flags |= RenderDirtyFlag.Picking;
	}
	if ( ! renderWorldHeightsEqual( previous, next )
		|| previous.surfaceStatus !== next.surfaceStatus ) flags |= RenderDirtyFlag.HeightResolution;
	if ( previous.visible !== next.visible ) flags |= RenderDirtyFlag.Visibility;
	return flags;
}

function validResolved(
	feature: Readonly<PlotFeature>,
	resolved: ResolvedPlotGeometry | undefined,
): ResolvedPlotGeometry | undefined {
	return resolved?.plotId === feature.id && resolved.sourceRevision === feature.revision
		? resolved
		: undefined;
}

function resolveSurfaceStatus(
	heightReference: HeightReference,
	resolved: ResolvedPlotGeometry | undefined,
): 'ready' | 'pending' | 'unavailable' {
	if ( heightReference === HeightReferenceValue.NONE ) return 'ready';
	if ( resolved !== undefined ) return resolved.status;
	return isThreeDTileReference( heightReference ) ? 'unavailable' : 'pending';
}

function fallbackWorldHeight(
	feature: Readonly<PlotFeature>,
	position: Position3D,
): number {
	if ( feature.heightReference === HeightReferenceValue.NONE ) return position[ 2 ];
	// ground/terrain 首帧允许明确的 ellipsoid fallback；relative 仍保留 offset。
	return isHeightReferenceRelative( feature.heightReference ) ? position[ 2 ] : 0;
}

function toRenderVertex( position: Position3D, worldHeight: number ): RenderVertex {
	return Object.freeze( {
		longitude: position[ 0 ],
		latitude: position[ 1 ],
		authorHeight: position[ 2 ],
		resolvedWorldHeight: worldHeight,
	} );
}

function closestSourceIndex(
	position: Position3D,
	source: readonly Position3D[],
): number {
	let closest = 0;
	let distance = Number.POSITIVE_INFINITY;
	for ( let index = 0; index < source.length; index++ ) {
		const longitude = wrappedDelta( position[ 0 ], source[ index ][ 0 ] );
		const latitude = position[ 1 ] - source[ index ][ 1 ];
		const candidate = longitude * longitude + latitude * latitude;
		if ( candidate < distance ) {
			distance = candidate;
			closest = index;
		}
	}
	return closest;
}

function wrappedDelta( left: number, right: number ): number {
	return ( ( left - right + 540 ) % 360 ) - 180;
}

function isClampReference( value: HeightReference ): boolean {
	return value === HeightReferenceValue.CLAMP_TO_GROUND
		|| value === HeightReferenceValue.CLAMP_TO_TERRAIN
		|| value === HeightReferenceValue.CLAMP_TO_3D_TILE;
}

function isThreeDTileReference( value: HeightReference ): boolean {
	return value === HeightReferenceValue.CLAMP_TO_3D_TILE
		|| value === HeightReferenceValue.RELATIVE_TO_3D_TILE;
}

function renderWorldHeightsEqual( left: RenderFeature, right: RenderFeature ): boolean {
	return left.vertices.length === right.vertices.length
		&& left.vertices.every( ( vertex, index ) =>
			vertex.resolvedWorldHeight === right.vertices[ index ].resolvedWorldHeight );
}
