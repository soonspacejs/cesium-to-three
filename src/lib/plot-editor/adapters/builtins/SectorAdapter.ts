import {
	geodesicDestination,
	geodesicDistanceMeters,
	initialGeodesicBearingDegrees,
} from '../../document/geodesy';
import type { Position3D, SectorFeature } from '../../document/types';
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
	invalidDrawing,
	mergeStyle,
	normalizeAuthorPosition,
} from './shared';
import { clockwiseSweep, normalizeHeading, sampleGeodesicArc } from './radial';

export type SectorDrawingDraft = DrawingDraft & { readonly type: 'sector' };

export class SectorGeometryAdapter implements GeometryAdapter<SectorDrawingDraft, SectorFeature> {
	public readonly kind = 'sector' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: false,
		insertVertices: false,
		removeVertices: false,
		translate: true,
		rotateHeading: true,
		rotatePitchRoll: false,
		scaleHorizontal: true,
		scaleVertical: false,
		parameterHandles: Object.freeze( [ 'center', 'radius', 'start-angle', 'end-angle' ] as const ),
	} );

	public begin( context: DrawToolContext ): SectorDrawingDraft {
		return this._withValidation( freezeDraft( {
			type: 'sector' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( {} ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '扇形需要中心、起始和终止方向点。' ),
		} ) );
	}

	public addPoint( draft: SectorDrawingDraft, point: Position3D ): SectorDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const points = draft.points.length < 3
			? Object.freeze( [ ...draft.points, normalized ] )
			: Object.freeze( [ draft.points[ 0 ], draft.points[ 1 ], normalized ] );
		return this._withValidation( freezeDraft( {
			...draft,
			phase: points.length === 3 ? 'ready' : 'drawing',
			points,
			previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: SectorDrawingDraft, point: Position3D ): SectorDrawingDraft {
		return freezeDraft( {
			...draft, previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: SectorDrawingDraft ): SectorDrawingDraft { return draft; }

	public validateDraft( draft: SectorDrawingDraft ): DrawingValidation {
		if ( draft.points.length < 3 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '扇形需要中心、起始和终止方向点。' );
		}
		const center = draft.points[ 0 ];
		const radius = geodesicDistanceMeters( center, draft.points[ 1 ] );
		const endDistance = geodesicDistanceMeters( center, draft.points[ 2 ] );
		if ( radius <= GEOMETRY_EPSILON_METERS || endDistance <= GEOMETRY_EPSILON_METERS ) {
			return invalidDrawing( 'DRAW_DEGENERATE_GEOMETRY', '扇形方向点不能与圆心重合。' );
		}
		return Object.freeze( { valid: true } );
	}

	public canFinish( draft: SectorDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: SectorDrawingDraft, options: FinishFeatureOptions ): SectorFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		const center = draft.points[ 0 ];
		const startAngle = initialGeodesicBearingDegrees( center, draft.points[ 1 ] );
		const endAngle = initialGeodesicBearingDegrees( center, draft.points[ 2 ] );
		return canonicalFeature<SectorFeature>( {
			...commonFeatureFields( draft, options ), type: 'sector',
			geometry: {
				center,
				radius: geodesicDistanceMeters( center, draft.points[ 1 ] ),
				startAngle: normalizeHeading( startAngle ),
				sectorAngle: clockwiseSweep( startAngle, endAngle ),
			},
			style: mergeStyle( draft.style ),
		} );
	}

	public cancel(): void {}

	public preview( draft: SectorDrawingDraft ): DraftPreviewGeometry {
		const center = draft.points[ 0 ];
		const start = draft.points[ 1 ];
		const end = draft.points[ 2 ] ?? draft.previewPoint;
		let positions: readonly Position3D[] = center === undefined ? [] : [ center ];
		if ( center !== undefined && start !== undefined && end !== undefined ) {
			const radius = geodesicDistanceMeters( center, start );
			if ( radius > GEOMETRY_EPSILON_METERS
				&& geodesicDistanceMeters( center, end ) > GEOMETRY_EPSILON_METERS ) {
				const startAngle = initialGeodesicBearingDegrees( center, start );
				const sweep = clockwiseSweep(
					startAngle,
					initialGeodesicBearingDegrees( center, end ),
				);
				positions = Object.freeze( [
					center,
					...sampleGeodesicArc(
						center, radius, startAngle, sweep, draft.heightReference,
					),
				] );
			}
		}
		return Object.freeze( {
			primitive: 'polygon', positions, closed: positions.length >= 4,
			sourceType: 'sector', generated: true,
		} );
	}

	public listHandles( feature: SectorFeature ): readonly EditHandle[] {
		const { center, radius, startAngle, sectorAngle } = feature.geometry;
		const authorPoint = ( heading: number ) => normalizeAuthorPosition(
			geodesicDestination( center, heading, radius, center[ 2 ] ),
			feature.heightReference,
		);
		return Object.freeze( [
			Object.freeze( {
				id: 'center', entityId: feature.id, kind: 'center' as const,
				position: center, priority: 100,
			} ),
			Object.freeze( {
				id: 'radius', entityId: feature.id, kind: 'radius' as const,
				position: authorPoint( startAngle + sectorAngle / 2 ), priority: 90,
			} ),
			Object.freeze( {
				id: 'start-angle', entityId: feature.id, kind: 'start-angle' as const,
				position: authorPoint( startAngle ), priority: 95,
			} ),
			Object.freeze( {
				id: 'end-angle', entityId: feature.id, kind: 'end-angle' as const,
				position: authorPoint( startAngle + sectorAngle ), priority: 95,
			} ),
		] );
	}

	public applyHandle(
		feature: SectorFeature,
		handleId: string,
		movement: HandleMovement,
	): SectorFeature {
		let geometry = feature.geometry;
		if ( handleId === 'center' ) {
			geometry = {
				...geometry,
				center: normalizeAuthorPosition( movement.authorPosition, feature.heightReference ),
			};
		} else if ( handleId === 'radius' ) {
			const radius = geodesicDistanceMeters( geometry.center, movement.authorPosition );
			if ( radius <= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_INVALID_RADIUS：扇形半径必须为正。' );
			geometry = { ...geometry, radius };
		} else if ( handleId === 'start-angle' ) {
			if ( geodesicDistanceMeters( geometry.center, movement.authorPosition )
				<= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_INVALID_ANGLE：方向点不能与中心重合。' );
			geometry = {
				...geometry,
				startAngle: normalizeHeading( initialGeodesicBearingDegrees(
					geometry.center, movement.authorPosition,
				) ),
			};
		} else if ( handleId === 'end-angle' ) {
			if ( geodesicDistanceMeters( geometry.center, movement.authorPosition )
				<= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_INVALID_ANGLE：方向点不能与中心重合。' );
			geometry = {
				...geometry,
				sectorAngle: clockwiseSweep(
					geometry.startAngle,
					initialGeodesicBearingDegrees( geometry.center, movement.authorPosition ),
				),
			};
		} else {
			throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		}
		return canonicalFeature<SectorFeature>( {
			...feature, geometry, revision: feature.revision + 1,
		} );
	}

	public removeVertex(): SectorFeature {
		throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：sector 不支持顶点增删。' );
	}

	public toRenderDescription( feature: SectorFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polygon',
			positions: Object.freeze( [
				feature.geometry.center,
				...sampleGeodesicArc(
					feature.geometry.center, feature.geometry.radius,
					feature.geometry.startAngle, feature.geometry.sectorAngle,
					feature.heightReference,
				),
			] ),
			closed: true, sourceType: 'sector', generated: true,
		} );
	}

	public toJSON( feature: SectorFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: SectorDrawingDraft ): SectorDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}
