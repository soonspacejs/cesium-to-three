import { Group } from 'three';
import type { CesiumGroundFrameState } from '../../ground';
import type { DraftPreviewGeometry } from '../adapters/types';
import type {
	HeightReference,
	PlotStyle,
	Position3D,
} from '../document/types';
import { HeightReference as HeightReferenceValue } from '../document/types';
import type { RenderFeature, RenderVertex } from './RenderProjection';
import {
	ScreenSpaceMarkerLayer,
	type MarkerViewportState,
	type ScreenSpaceMarkerDescription,
} from './ScreenSpaceMarkerLayer';
import {
	VariableHeightRtePrimitive,
	createVariableHeightRtePrimitive,
} from './VariableHeightRtePrimitive';
import { EditorOverlayLayer, isolateOverlayObjects } from './layers';

export interface DrawingDraftOverlay {
	readonly id: string;
	readonly revision: number;
	readonly preview: DraftPreviewGeometry;
	readonly heightReference: HeightReference;
	readonly valid: boolean;
	/** 已解析的世界高度；缺省时明确使用 author/椭球 fallback，绝不写回 draft。 */
	readonly resolvedPositions?: readonly Position3D[];
	readonly style?: Readonly<Partial<PlotStyle>>;
}

/** adapter 原始 DraftPreviewGeometry 的 RTE 覆盖层，非法草稿同样保持可见。 */
export class DrawingDraftLayer {
	public readonly root = new Group();
	private readonly _markers = new ScreenSpaceMarkerLayer(
		'drawingDraftMarkerRoot', EditorOverlayLayer.PLOT_CONTENT,
	);
	private _description: DrawingDraftOverlay | null = null;
	private _primitive: VariableHeightRtePrimitive | null = null;
	private _disposed = false;

	public constructor() {
		this.root.name = 'drawingDraftPreviewRoot';
		this.root.layers.set( EditorOverlayLayer.PLOT_CONTENT );
		this.root.add( this._markers.root );
	}

	public get visible(): boolean {
		return this._description !== null
			&& ( this._primitive !== null || this._markers.size > 0 );
	}

	public sync( description: DrawingDraftOverlay | null ): void {
		this._assertOpen();
		if ( description === null ) {
			this._replacePrimitive( null );
			this._markers.sync( [] );
			this._description = null;
			return;
		}
		validateDraftOverlay( description );
		if ( this._description?.id === description.id
			&& this._description.revision === description.revision
			&& draftDescriptionsEqual( this._description, description ) ) return;

		const render = draftRenderFeature( description );
		let candidate: VariableHeightRtePrimitive | null = null;
		try {
			candidate = createVariableHeightRtePrimitive( render, 9_000 );
			this._markers.sync( draftMarkers( description ) );
		} catch ( error ) {
			candidate?.dispose();
			throw error;
		}
		this._replacePrimitive( candidate );
		this._description = freezeDescription( description );
		isolateOverlayObjects( this.root, EditorOverlayLayer.PLOT_CONTENT );
	}

	public update( frameState: CesiumGroundFrameState, viewport: MarkerViewportState ): void {
		if ( this._disposed ) return;
		this._primitive?.update( frameState );
		this._markers.update( viewport );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this._replacePrimitive( null );
		this._markers.dispose();
		this.root.clear();
		this._description = null;
	}

	private _replacePrimitive( candidate: VariableHeightRtePrimitive | null ): void {
		if ( candidate !== null ) this.root.add( candidate.group );
		const previous = this._primitive;
		this._primitive = candidate;
		if ( previous === null ) return;
		this.root.remove( previous.group );
		previous.dispose();
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'DrawingDraftLayer 已销毁。' );
	}
}

function draftRenderFeature( description: DrawingDraftOverlay ): RenderFeature {
	const style = draftStyle( description );
	const resolved = description.resolvedPositions;
	const vertices = description.preview.positions.map( ( position, index ) =>
		draftVertex( position, resolved?.[ index ]?.[ 2 ] ?? fallbackHeight(
			position, description.heightReference,
		) ) );
	return Object.freeze( {
		id: description.id,
		type: description.preview.sourceType,
		heightReference: description.heightReference,
		primitive: description.preview.primitive,
		closed: description.preview.closed,
		generated: description.preview.generated,
		vertices: Object.freeze( vertices ),
		sourceVertices: Object.freeze( vertices ),
		style,
		properties: Object.freeze( {} ),
		revision: description.revision,
		visible: true,
		path: 'plain-rte',
		surfaceStatus: resolved === undefined && description.heightReference !== HeightReferenceValue.NONE
			? 'pending'
			: 'ready',
		surfacePending: resolved === undefined && description.heightReference !== HeightReferenceValue.NONE,
	} );
}

function draftStyle(
	description: DrawingDraftOverlay,
): Readonly<PlotStyle & Record<string, unknown>> {
	const color = description.valid ? '#27c2ff' : '#ff3344';
	return Object.freeze( {
		strokeColor: description.style?.strokeColor ?? color,
		strokeWidth: description.style?.strokeWidth ?? 3,
		strokeOpacity: description.style?.strokeOpacity ?? 100,
		fillColor: description.style?.fillColor ?? color,
		fillOpacity: description.style?.fillOpacity ?? ( description.valid ? 22 : 14 ),
	} );
}

function draftVertex( position: Position3D, worldHeight: number ): RenderVertex {
	return Object.freeze( {
		longitude: position[ 0 ],
		latitude: position[ 1 ],
		authorHeight: position[ 2 ],
		resolvedWorldHeight: worldHeight,
	} );
}

function fallbackHeight( position: Position3D, reference: HeightReference ): number {
	return reference === HeightReferenceValue.NONE
		|| reference === HeightReferenceValue.RELATIVE_TO_GROUND
		|| reference === HeightReferenceValue.RELATIVE_TO_TERRAIN
		|| reference === HeightReferenceValue.RELATIVE_TO_3D_TILE
		? position[ 2 ]
		: 0;
}

function draftMarkers(
	description: DrawingDraftOverlay,
): readonly ScreenSpaceMarkerDescription[] {
	const positions = description.preview.positions;
	const color = description.valid ? '#27c2ff' : '#ff3344';
	return positions.map( ( position, index ) => Object.freeze( {
		id: `${ description.id }:draft-vertex:${ index }`,
		handleId: `draft-vertex:${ index }`,
		position: description.resolvedPositions?.[ index ] ?? position,
		shape: description.preview.primitive === 'text' ? 'diamond' as const : 'circle' as const,
		fillColor: '#ffffff',
		borderColor: color,
		sizeCssPixels: description.preview.primitive === 'text' ? 16 : 9,
		pickRadiusCssPixels: 8,
		priority: 400,
		visible: true,
	} ) );
}

function validateDraftOverlay( value: DrawingDraftOverlay ): void {
	if ( value.id.trim().length === 0 ) throw new TypeError( 'drawing draft id 不能为空。' );
	if ( ! Number.isSafeInteger( value.revision ) || value.revision < 0 ) {
		throw new RangeError( 'drawing draft revision 必须是非负安全整数。' );
	}
	for ( const position of value.preview.positions ) validatePosition( position );
	if ( value.resolvedPositions !== undefined ) {
		if ( value.resolvedPositions.length !== value.preview.positions.length ) {
			throw new Error( 'DRAFT_RESOLVED_LENGTH_MISMATCH：resolvedPositions 必须与 preview positions 等长。' );
		}
		for ( const position of value.resolvedPositions ) validatePosition( position );
	}
}

function validatePosition( value: Position3D ): void {
	if ( value.length !== 3
		|| value.some( ( component ) => ! Number.isFinite( component ) )
		|| value[ 1 ] < -90 || value[ 1 ] > 90 ) {
		throw new Error( 'DRAFT_POSITION_INVALID：preview position 非法。' );
	}
}

function freezeDescription( value: DrawingDraftOverlay ): DrawingDraftOverlay {
	return Object.freeze( {
		...value,
		preview: Object.freeze( {
			...value.preview,
			positions: Object.freeze( [ ...value.preview.positions ] ),
		} ),
		...( value.resolvedPositions === undefined ? {} : {
			resolvedPositions: Object.freeze( [ ...value.resolvedPositions ] ),
		} ),
		...( value.style === undefined ? {} : { style: Object.freeze( { ...value.style } ) } ),
	} );
}

function draftDescriptionsEqual(
	left: DrawingDraftOverlay,
	right: DrawingDraftOverlay,
): boolean {
	return left.heightReference === right.heightReference
		&& left.valid === right.valid
		&& left.preview.primitive === right.preview.primitive
		&& left.preview.closed === right.preview.closed
		&& left.preview.sourceType === right.preview.sourceType
		&& left.preview.generated === right.preview.generated
		&& left.preview.text === right.preview.text
		&& positionsEqual( left.preview.positions, right.preview.positions )
		&& optionalPositionsEqual( left.resolvedPositions, right.resolvedPositions )
		&& recordsEqual( left.style, right.style );
}

function optionalPositionsEqual(
	left: readonly Position3D[] | undefined,
	right: readonly Position3D[] | undefined,
): boolean {
	return left === undefined || right === undefined
		? left === right
		: positionsEqual( left, right );
}

function positionsEqual(
	left: readonly Position3D[],
	right: readonly Position3D[],
): boolean {
	return left.length === right.length && left.every( ( position, index ) =>
		position[ 0 ] === right[ index ][ 0 ]
		&& position[ 1 ] === right[ index ][ 1 ]
		&& position[ 2 ] === right[ index ][ 2 ] );
}

function recordsEqual(
	left: Readonly<Partial<PlotStyle>> | undefined,
	right: Readonly<Partial<PlotStyle>> | undefined,
): boolean {
	if ( left === undefined || right === undefined ) return left === right;
	const leftEntries = Object.entries( left );
	const rightKeys = Object.keys( right );
	return leftEntries.length === rightKeys.length
		&& leftEntries.every( ( [ key, value ] ) =>
			value === ( right as Readonly<Record<string, unknown>> )[ key ] );
}
