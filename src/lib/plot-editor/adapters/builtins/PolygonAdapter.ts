import { geodesicDistanceMeters } from '../../document/geodesy';
import type { PolygonFeature } from '../../document/types';
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
	drawingValidationFromError,
	freezeDraft,
	geographicMidpoint,
	headingDegreesFrom,
	invalidDrawing,
	mergeStyle,
	normalizeAuthorPosition,
	polygonCentroid,
	positionAtEnuOffset,
	requireHandleIndex,
	rotatePositionsAroundCenter,
	translatePositionsToCenter,
} from './shared';

const MAX_POLYGON_POINTS = 10_000;

export type PolygonDrawingDraft = DrawingDraft & { readonly type: 'polygon' };

export class PolygonGeometryAdapter implements GeometryAdapter<PolygonDrawingDraft, PolygonFeature> {
	public readonly kind = 'polygon' as const;
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

	public begin( context: DrawToolContext ): PolygonDrawingDraft {
		return this._withValidation( freezeDraft( {
			type: 'polygon' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( {} ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '多边形至少需要三个顶点。' ),
		} ) );
	}

	public addPoint( draft: PolygonDrawingDraft, point: readonly [ number, number, number ] ): PolygonDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const last = draft.points.at( -1 );
		const first = draft.points[ 0 ];
		const duplicateLast = last !== undefined
			&& geodesicDistanceMeters( last, normalized ) <= GEOMETRY_EPSILON_METERS;
		const duplicateClosure = draft.points.length >= 3 && first !== undefined
			&& geodesicDistanceMeters( first, normalized ) <= GEOMETRY_EPSILON_METERS;
		const points = duplicateLast || duplicateClosure
			? draft.points
			: Object.freeze( [ ...draft.points, normalized ] );
		return this._withValidation( freezeDraft( {
			...draft,
			phase: points.length >= 3 ? 'ready' : 'drawing',
			points,
			previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: PolygonDrawingDraft, point: readonly [ number, number, number ] ): PolygonDrawingDraft {
		return freezeDraft( {
			...draft,
			previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: PolygonDrawingDraft ): PolygonDrawingDraft {
		return draft.points.length <= 3
			? draft
			: this._withValidation( freezeDraft( {
				...draft,
				points: Object.freeze( draft.points.slice( 0, -1 ) ),
				previewPoint: undefined,
			} ) );
	}

	public validateDraft( draft: PolygonDrawingDraft ): DrawingValidation {
		if ( draft.points.length < 3 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '多边形至少需要三个顶点。' );
		}
		if ( draft.points.length > MAX_POLYGON_POINTS ) {
			return invalidDrawing( 'DRAW_POINT_LIMIT', `多边形最多允许 ${ MAX_POLYGON_POINTS } 个顶点。` );
		}
		try {
			canonicalFeature<PolygonFeature>( {
				id: '__draft_polygon__', type: 'polygon',
				geometry: { positions: draft.points },
				style: mergeStyle( draft.style ),
				heightReference: draft.heightReference,
				visible: true, properties: {}, revision: 0,
			} );
			return Object.freeze( { valid: true } );
		} catch ( error ) {
			return drawingValidationFromError( error );
		}
	}

	public canFinish( draft: PolygonDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: PolygonDrawingDraft, options: FinishFeatureOptions ): PolygonFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<PolygonFeature>( {
			...commonFeatureFields( draft, options ),
			type: 'polygon', geometry: { positions: draft.points },
			style: mergeStyle( draft.style ),
		} );
	}

	public cancel(): void {}

	public preview( draft: PolygonDrawingDraft ): DraftPreviewGeometry {
		const positions = [ ...draft.points ];
		if ( draft.previewPoint !== undefined ) {
			const last = positions.at( -1 );
			if ( last === undefined
				|| geodesicDistanceMeters( last, draft.previewPoint ) > GEOMETRY_EPSILON_METERS ) {
				positions.push( draft.previewPoint );
			}
		}
		return Object.freeze( {
			primitive: 'polygon', positions: Object.freeze( positions ),
			closed: positions.length >= 3, sourceType: 'polygon', generated: false,
		} );
	}

	public listHandles( feature: PolygonFeature ): readonly EditHandle[] {
		const positions = feature.geometry.positions;
		const handles: EditHandle[] = positions.map( ( position, index ) => ( {
			id: `vertex:${ index }`, entityId: feature.id, kind: 'vertex',
			position, vertexIndex: index, priority: 100,
		} ) );
		for ( let index = 0; index < positions.length; index++ ) {
			handles.push( {
				id: `midpoint:${ index }`, entityId: feature.id, kind: 'midpoint',
				position: geographicMidpoint(
					positions[ index ], positions[ ( index + 1 ) % positions.length ],
					feature.heightReference,
				),
				segmentIndex: index, priority: 90,
			} );
		}
		const center = polygonCentroid( positions );
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
		feature: PolygonFeature,
		handleId: string,
		movement: HandleMovement,
	): PolygonFeature {
		let positions: readonly ( readonly [ number, number, number ] )[];
		if ( handleId.startsWith( 'vertex:' ) ) {
			const index = requireHandleIndex( handleId, 'vertex' );
			if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			positions = feature.geometry.positions.map( ( position, current ) => current === index
				? normalizeAuthorPosition( movement.authorPosition, feature.heightReference )
				: position );
		} else if ( handleId.startsWith( 'midpoint:' ) ) {
			const index = requireHandleIndex( handleId, 'midpoint' );
			if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			const inserted = [ ...feature.geometry.positions ];
			inserted.splice( index + 1, 0, normalizeAuthorPosition(
				movement.authorPosition, feature.heightReference,
			) );
			positions = inserted;
		} else if ( handleId === 'center' ) {
			positions = translatePositionsToCenter(
				feature.geometry.positions, movement.authorPosition, feature.heightReference,
			);
		} else if ( handleId === 'rotation' ) {
			const center = polygonCentroid( feature.geometry.positions );
			const current = headingDegreesFrom( center, feature.geometry.positions[ 0 ] );
			const target = headingDegreesFrom( center, movement.authorPosition );
			let delta = target - current;
			if ( movement.shift ) delta = Math.round( delta / 15 ) * 15;
			positions = rotatePositionsAroundCenter(
				feature.geometry.positions, delta, feature.heightReference,
			);
		} else {
			throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		}
		return canonicalFeature<PolygonFeature>( {
			...feature, geometry: { positions }, revision: feature.revision + 1,
		} );
	}

	public removeVertex( feature: PolygonFeature, handleId: string ): PolygonFeature {
		const index = requireHandleIndex( handleId, 'vertex' );
		if ( feature.geometry.positions.length <= 3 ) {
			throw new Error( 'EDIT_MIN_VERTICES：polygon 至少保留三个顶点。' );
		}
		if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		return canonicalFeature<PolygonFeature>( {
			...feature,
			geometry: {
				positions: feature.geometry.positions.filter( ( _, current ) => current !== index ),
			},
			revision: feature.revision + 1,
		} );
	}

	public toRenderDescription( feature: PolygonFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polygon', positions: feature.geometry.positions,
			closed: true, sourceType: 'polygon', generated: false,
		} );
	}

	public toJSON( feature: PolygonFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: PolygonDrawingDraft ): PolygonDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}
