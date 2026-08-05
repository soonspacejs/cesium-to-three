import { geodesicDistanceMeters } from '../../document/geodesy';
import type { LineFeature } from '../../document/types';
import type {
	DrawToolContext,
	DrawingDraft,
	DrawingValidation,
	DraftPreviewGeometry,
	EditHandle,
	FinishFeatureOptions,
	GeometryAdapter,
	HandleMovement,
} from '../types';
import {
	GEOMETRY_EPSILON_METERS,
	canonicalFeature,
	cloneJson,
	commonFeatureFields,
	freezeDraft,
	geographicCenter,
	geographicMidpoint,
	headingDegreesFrom,
	invalidDrawing,
	mergeStyle,
	normalizeAuthorPosition,
	positionAtEnuOffset,
	requireHandleIndex,
	rotatePositionsAroundCenter,
	translatePositionsToCenter,
	validateDistinctAdjacent,
} from './shared';

const MAX_LINE_POINTS = 10_000;

interface LineParameters {
	readonly strokeStyle?: 'solid' | 'dashed';
	readonly showArrow?: boolean;
	readonly startArrowStyle?: 'filledArrow' | 'unfilledArrow' | null;
	readonly endArrowStyle?: 'filledArrow' | 'unfilledArrow' | null;
}

export type LineDrawingDraft = DrawingDraft<LineParameters> & { readonly type: 'line' };

export class LineGeometryAdapter implements GeometryAdapter<LineDrawingDraft, LineFeature> {
	public readonly kind = 'line' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: true,
		insertVertices: true,
		removeVertices: true,
		translate: true,
		rotateHeading: true,
		scaleHorizontal: true,
		parameterHandles: Object.freeze( [ 'vertex', 'midpoint', 'center', 'rotation' ] as const ),
	} );

	public begin( context: DrawToolContext<LineParameters> ): LineDrawingDraft {
		return this._withValidation( freezeDraft( {
			type: 'line' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( { ...( context.options ?? {} ) } ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '线至少需要两个折点。' ),
		} ) );
	}

	public addPoint( draft: LineDrawingDraft, point: readonly [ number, number, number ] ): LineDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const last = draft.points.at( -1 );
		// 双击第二个 click 或设备抖动产生的重复终点不进入 source points。
		const points = last !== undefined
			&& geodesicDistanceMeters( last, normalized ) <= GEOMETRY_EPSILON_METERS
			? draft.points
			: Object.freeze( [ ...draft.points, normalized ] );
		return this._withValidation( freezeDraft( {
			...draft,
			phase: points.length >= 2 ? 'ready' : 'drawing',
			points,
			previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: LineDrawingDraft, point: readonly [ number, number, number ] ): LineDrawingDraft {
		return freezeDraft( {
			...draft,
			previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: LineDrawingDraft ): LineDrawingDraft {
		if ( draft.points.length <= 2 ) return draft;
		const points = Object.freeze( draft.points.slice( 0, -1 ) );
		return this._withValidation( freezeDraft( {
			...draft,
			phase: 'ready',
			points,
			previewPoint: undefined,
		} ) );
	}

	public validateDraft( draft: LineDrawingDraft ): DrawingValidation {
		if ( draft.points.length > MAX_LINE_POINTS ) {
			return invalidDrawing( 'DRAW_POINT_LIMIT', `线最多允许 ${ MAX_LINE_POINTS } 个点。` );
		}
		return validateDistinctAdjacent( draft.points, 2 );
	}

	public canFinish( draft: LineDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: LineDrawingDraft, options: FinishFeatureOptions ): LineFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<LineFeature>( {
			...commonFeatureFields( draft, options ),
			type: 'line',
			geometry: { positions: draft.points },
			style: mergeStyle( draft.style, {
				strokeStyle: draft.parameters.strokeStyle ?? 'solid',
				showArrow: draft.parameters.showArrow ?? false,
				startArrowStyle: draft.parameters.startArrowStyle ?? null,
				endArrowStyle: draft.parameters.endArrowStyle ?? null,
			} ),
		} );
	}

	public cancel(): void {}

	public preview( draft: LineDrawingDraft ): DraftPreviewGeometry {
		const positions = [ ...draft.points ];
		if ( draft.previewPoint !== undefined ) {
			const last = positions.at( -1 );
			if ( last === undefined
				|| geodesicDistanceMeters( last, draft.previewPoint ) > GEOMETRY_EPSILON_METERS ) {
				positions.push( draft.previewPoint );
			}
		}
		return Object.freeze( {
			primitive: 'polyline', positions: Object.freeze( positions ),
			closed: false, sourceType: 'line', generated: false,
		} );
	}

	public listHandles( feature: LineFeature ): readonly EditHandle[] {
		const positions = feature.geometry.positions;
		const handles: EditHandle[] = positions.map( ( position, index ) => ( {
			id: `vertex:${ index }`, entityId: feature.id, kind: 'vertex',
			position, vertexIndex: index, priority: 100,
		} ) );
		for ( let index = 0; index < positions.length - 1; index++ ) {
			handles.push( {
				id: `midpoint:${ index }`, entityId: feature.id, kind: 'midpoint',
				position: geographicMidpoint( positions[ index ], positions[ index + 1 ], feature.heightReference ),
				segmentIndex: index, priority: 90,
			} );
		}
		const center = geographicCenter( positions );
		handles.push( {
			id: 'center', entityId: feature.id, kind: 'center', position: center, priority: 80,
		} );
		const radius = Math.max( 20, ...positions.map(
			( position ) => geodesicDistanceMeters( center, position ),
		) );
		handles.push( {
			id: 'rotation', entityId: feature.id, kind: 'rotation', priority: 70,
			position: positionAtEnuOffset( center, 0, radius * 1.2, feature.heightReference ),
		} );
		return Object.freeze( handles.map( ( handle ) => Object.freeze( handle ) ) );
	}

	public applyHandle(
		feature: LineFeature,
		handleId: string,
		movement: HandleMovement,
	): LineFeature {
		let positions: readonly ( readonly [ number, number, number ] )[];
		if ( handleId.startsWith( 'vertex:' ) ) {
			const index = requireHandleIndex( handleId, 'vertex' );
			if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			positions = feature.geometry.positions.map( ( position, current ) => current === index
				? normalizeAuthorPosition( movement.authorPosition, feature.heightReference )
				: position );
		} else if ( handleId.startsWith( 'midpoint:' ) ) {
			const index = requireHandleIndex( handleId, 'midpoint' );
			if ( index >= feature.geometry.positions.length - 1 ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			const inserted = [ ...feature.geometry.positions ];
			inserted.splice( index + 1, 0, normalizeAuthorPosition(
				movement.authorPosition,
				feature.heightReference,
			) );
			positions = inserted;
		} else if ( handleId === 'center' ) {
			positions = translatePositionsToCenter(
				feature.geometry.positions,
				movement.authorPosition,
				feature.heightReference,
			);
		} else if ( handleId === 'rotation' ) {
			const center = geographicCenter( feature.geometry.positions );
			const currentHeading = headingDegreesFrom( center, feature.geometry.positions[ 0 ] );
			const targetHeading = headingDegreesFrom( center, movement.authorPosition );
			let delta = targetHeading - currentHeading;
			if ( movement.shift ) delta = Math.round( delta / 15 ) * 15;
			positions = rotatePositionsAroundCenter(
				feature.geometry.positions, delta, feature.heightReference,
			);
		} else {
			throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		}
		return canonicalFeature<LineFeature>( {
			...feature,
			geometry: { positions },
			revision: feature.revision + 1,
		} );
	}

	public removeVertex( feature: LineFeature, handleId: string ): LineFeature {
		const index = requireHandleIndex( handleId, 'vertex' );
		if ( feature.geometry.positions.length <= 2 ) {
			throw new Error( 'EDIT_MIN_VERTICES：line 至少保留两个顶点。' );
		}
		if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		return canonicalFeature<LineFeature>( {
			...feature,
			geometry: {
				positions: feature.geometry.positions.filter( ( _, current ) => current !== index ),
			},
			revision: feature.revision + 1,
		} );
	}

	public toRenderDescription( feature: LineFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polyline', positions: feature.geometry.positions,
			closed: false, sourceType: 'line', generated: false,
		} );
	}

	public toJSON( feature: LineFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: LineDrawingDraft ): LineDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}
