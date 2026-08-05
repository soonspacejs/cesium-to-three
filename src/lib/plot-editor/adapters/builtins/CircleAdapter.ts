import { geodesicDestination, geodesicDistanceMeters } from '../../document/geodesy';
import type { CircleFeature, Position3D } from '../../document/types';
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
import { sampleGeodesicArc } from './radial';

export type CircleDrawingDraft = DrawingDraft & { readonly type: 'circle' };

export class CircleGeometryAdapter implements GeometryAdapter<CircleDrawingDraft, CircleFeature> {
	public readonly kind = 'circle' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: false,
		insertVertices: false,
		removeVertices: false,
		translate: true,
		rotateHeading: false,
		scaleHorizontal: true,
		parameterHandles: Object.freeze( [ 'center', 'radius' ] as const ),
	} );

	public begin( context: DrawToolContext ): CircleDrawingDraft {
		return this._withValidation( freezeDraft( {
			type: 'circle' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( {} ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '圆需要中心和半径点。' ),
		} ) );
	}

	public addPoint( draft: CircleDrawingDraft, point: Position3D ): CircleDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const points = draft.points.length === 0
			? Object.freeze( [ normalized ] )
			: Object.freeze( [ draft.points[ 0 ], normalized ] );
		return this._withValidation( freezeDraft( {
			...draft, phase: points.length === 2 ? 'ready' : 'drawing',
			points, previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: CircleDrawingDraft, point: Position3D ): CircleDrawingDraft {
		return freezeDraft( {
			...draft, previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: CircleDrawingDraft ): CircleDrawingDraft { return draft; }

	public validateDraft( draft: CircleDrawingDraft ): DrawingValidation {
		if ( draft.points.length < 2 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '圆需要中心和半径点。' );
		}
		const radius = geodesicDistanceMeters( draft.points[ 0 ], draft.points[ 1 ] );
		return Number.isFinite( radius ) && radius > GEOMETRY_EPSILON_METERS
			? Object.freeze( { valid: true } )
			: invalidDrawing( 'DRAW_DEGENERATE_GEOMETRY', '圆半径必须为正。' );
	}

	public canFinish( draft: CircleDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: CircleDrawingDraft, options: FinishFeatureOptions ): CircleFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<CircleFeature>( {
			...commonFeatureFields( draft, options ), type: 'circle',
			geometry: {
				center: draft.points[ 0 ],
				radius: geodesicDistanceMeters( draft.points[ 0 ], draft.points[ 1 ] ),
			},
			style: mergeStyle( draft.style ),
		} );
	}

	public cancel(): void {}

	public preview( draft: CircleDrawingDraft ): DraftPreviewGeometry {
		const center = draft.points[ 0 ];
		const radiusPoint = draft.points[ 1 ] ?? draft.previewPoint;
		let positions: readonly Position3D[] = center === undefined ? [] : [ center ];
		if ( center !== undefined && radiusPoint !== undefined ) {
			const radius = geodesicDistanceMeters( center, radiusPoint );
			if ( radius > GEOMETRY_EPSILON_METERS ) {
				positions = sampleGeodesicArc( center, radius, 0, 360, draft.heightReference );
			}
		}
		return Object.freeze( {
			primitive: 'polygon', positions, closed: positions.length >= 3,
			sourceType: 'circle', generated: true,
		} );
	}

	public listHandles( feature: CircleFeature ): readonly EditHandle[] {
		return Object.freeze( [
			Object.freeze( {
				id: 'center', entityId: feature.id, kind: 'center' as const,
				position: feature.geometry.center, priority: 100,
			} ),
			Object.freeze( {
				id: 'radius', entityId: feature.id, kind: 'radius' as const,
				position: normalizeAuthorPosition( geodesicDestination(
					feature.geometry.center, 90, feature.geometry.radius,
					feature.geometry.center[ 2 ],
				), feature.heightReference ),
				priority: 90,
			} ),
		] );
	}

	public applyHandle(
		feature: CircleFeature,
		handleId: string,
		movement: HandleMovement,
	): CircleFeature {
		if ( handleId === 'center' ) {
			return canonicalFeature<CircleFeature>( {
				...feature,
				geometry: {
					...feature.geometry,
					center: normalizeAuthorPosition( movement.authorPosition, feature.heightReference ),
				},
				revision: feature.revision + 1,
			} );
		}
		if ( handleId !== 'radius' ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		const radius = geodesicDistanceMeters( feature.geometry.center, movement.authorPosition );
		if ( radius <= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_INVALID_RADIUS：圆半径必须为正。' );
		return canonicalFeature<CircleFeature>( {
			...feature, geometry: { ...feature.geometry, radius }, revision: feature.revision + 1,
		} );
	}

	public removeVertex(): CircleFeature {
		throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：circle 不支持顶点增删。' );
	}

	public toRenderDescription( feature: CircleFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polygon',
			positions: sampleGeodesicArc(
				feature.geometry.center, feature.geometry.radius, 0, 360, feature.heightReference,
			),
			closed: true, sourceType: 'circle', generated: true,
		} );
	}

	public toJSON( feature: CircleFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: CircleDrawingDraft ): CircleDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}
