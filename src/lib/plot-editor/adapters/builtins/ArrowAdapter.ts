import {
	createAssaultDirectionArrow,
	createAttackArrow,
	createCurvedArrow,
	createFineArrow,
	createSwallowtailAttackArrow,
} from '../../../arrow';
import {
	createEnuFrame,
	ecefToEnu,
	geodesicDistanceMeters,
	geodeticToEcef,
} from '../../document/geodesy';
import { unwrapPositions, wrapLongitudeDegrees } from '../../document/normalize';
import type { ArrowFeature, ArrowType, Position3D } from '../../document/types';
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
	constrainHeadingDeltaDegrees,
	drawingValidationFromError,
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

const MAX_ARROW_CONTROL_POINTS = 512;

interface ArrowParameters {
	readonly arrowType: ArrowType;
	readonly sizeScale: number;
	readonly curvedBodyWidthFactor?: number;
	readonly curvedHeadWidthFactor?: number;
	readonly curvedHeadLengthFactor?: number;
}

export type ArrowDrawingDraft = DrawingDraft<ArrowParameters> & { readonly type: 'arrow' };

export class ArrowGeometryAdapter implements GeometryAdapter<ArrowDrawingDraft, ArrowFeature> {
	public readonly kind = 'arrow' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: true,
		insertVertices: true,
		removeVertices: true,
		translate: true,
		rotateHeading: true,
		rotatePitchRoll: true,
		scaleHorizontal: true,
		scaleVertical: true,
		parameterHandles: Object.freeze( [ 'vertex', 'midpoint', 'center', 'rotation' ] as const ),
	} );

	public begin( context: DrawToolContext<Partial<ArrowParameters>> ): ArrowDrawingDraft {
		const options = context.options ?? {};
		const parameters: ArrowParameters = {
			arrowType: options.arrowType ?? 'fine',
			sizeScale: options.sizeScale ?? 1,
			...( options.curvedBodyWidthFactor === undefined ? {} : {
				curvedBodyWidthFactor: options.curvedBodyWidthFactor,
			} ),
			...( options.curvedHeadWidthFactor === undefined ? {} : {
				curvedHeadWidthFactor: options.curvedHeadWidthFactor,
			} ),
			...( options.curvedHeadLengthFactor === undefined ? {} : {
				curvedHeadLengthFactor: options.curvedHeadLengthFactor,
			} ),
		};
		return this._withValidation( freezeDraft( {
			type: 'arrow' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( parameters ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '箭头控制点不足。' ),
		} ) );
	}

	public addPoint( draft: ArrowDrawingDraft, point: Position3D ): ArrowDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const last = draft.points.at( -1 );
		const duplicate = last !== undefined
			&& geodesicDistanceMeters( last, normalized ) <= GEOMETRY_EPSILON_METERS;
		let points = draft.points;
		if ( ! duplicate ) {
			points = fixedTwoPointArrow( draft.parameters.arrowType ) && draft.points.length >= 2
				? Object.freeze( [ draft.points[ 0 ], normalized ] )
				: Object.freeze( [ ...draft.points, normalized ] );
		}
		const ready = points.length >= minimumPoints( draft.parameters.arrowType );
		return this._withValidation( freezeDraft( {
			...draft, phase: ready ? 'ready' : 'drawing', points, previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: ArrowDrawingDraft, point: Position3D ): ArrowDrawingDraft {
		return freezeDraft( {
			...draft, previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: ArrowDrawingDraft ): ArrowDrawingDraft {
		return draft.points.length <= minimumPoints( draft.parameters.arrowType )
			? draft
			: this._withValidation( freezeDraft( {
				...draft, points: Object.freeze( draft.points.slice( 0, -1 ) ),
				previewPoint: undefined,
			} ) );
	}

	public validateDraft( draft: ArrowDrawingDraft ): DrawingValidation {
		if ( ! isArrowType( draft.parameters.arrowType ) ) {
			return invalidDrawing( 'DRAW_INVALID_PARAMETER', 'arrowType 不受支持。' );
		}
		if ( draft.points.length > MAX_ARROW_CONTROL_POINTS ) {
			return invalidDrawing( 'DRAW_POINT_LIMIT', `箭头最多允许 ${ MAX_ARROW_CONTROL_POINTS } 个控制点。` );
		}
		const distinct = validateDistinctAdjacent(
			draft.points,
			minimumPoints( draft.parameters.arrowType ),
		);
		if ( ! distinct.valid ) return distinct;
		for ( const value of [
			draft.parameters.sizeScale,
			draft.parameters.curvedBodyWidthFactor,
			draft.parameters.curvedHeadWidthFactor,
			draft.parameters.curvedHeadLengthFactor,
		] ) {
			if ( value !== undefined && ( ! Number.isFinite( value ) || value <= 0 ) ) {
				return invalidDrawing( 'DRAW_INVALID_PARAMETER', '箭头尺寸与曲线体型参数必须为正有限数。' );
			}
		}
		try {
			canonicalFeature<ArrowFeature>( {
				id: '__draft_arrow__', type: 'arrow',
				geometry: { positions: draft.points, ...draft.parameters },
				style: mergeStyle( draft.style ), heightReference: draft.heightReference,
				visible: true, properties: {}, revision: 0,
			} );
			return Object.freeze( { valid: true } );
		} catch ( error ) {
			return drawingValidationFromError( error );
		}
	}

	public canFinish( draft: ArrowDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: ArrowDrawingDraft, options: FinishFeatureOptions ): ArrowFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<ArrowFeature>( {
			...commonFeatureFields( draft, options ), type: 'arrow',
			geometry: { positions: draft.points, ...draft.parameters },
			style: mergeStyle( draft.style ),
		} );
	}

	public cancel(): void {}

	public preview( draft: ArrowDrawingDraft ): DraftPreviewGeometry {
		let source = [ ...draft.points ];
		if ( draft.previewPoint !== undefined ) {
			const last = source.at( -1 );
			if ( last === undefined
				|| geodesicDistanceMeters( last, draft.previewPoint ) > GEOMETRY_EPSILON_METERS ) {
				if ( fixedTwoPointArrow( draft.parameters.arrowType ) && source.length >= 2 ) {
					source = [ source[ 0 ], draft.previewPoint ];
				} else {
					source.push( draft.previewPoint );
				}
			}
		}
		if ( source.length < minimumPoints( draft.parameters.arrowType ) ) {
			return Object.freeze( {
				primitive: 'polyline', positions: Object.freeze( source ), closed: false,
				sourceType: 'arrow', generated: false,
			} );
		}
		return Object.freeze( {
			primitive: 'polygon',
			positions: generateArrowPolygon(
				source, draft.parameters, draft.heightReference,
			),
			closed: true, sourceType: 'arrow', generated: true,
		} );
	}

	public listHandles( feature: ArrowFeature ): readonly EditHandle[] {
		const positions = feature.geometry.positions;
		const handles: EditHandle[] = positions.map( ( position, index ) => ( {
			id: `vertex:${ index }`, entityId: feature.id, kind: 'vertex',
			position, vertexIndex: index, priority: 100,
		} ) );
		if ( ! fixedTwoPointArrow( feature.geometry.arrowType ) ) {
			for ( let index = 0; index < positions.length - 1; index++ ) {
				handles.push( {
					id: `midpoint:${ index }`, entityId: feature.id, kind: 'midpoint',
					position: geographicMidpoint(
						positions[ index ], positions[ index + 1 ], feature.heightReference,
					),
					segmentIndex: index, priority: 90,
				} );
			}
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
		feature: ArrowFeature,
		handleId: string,
		movement: HandleMovement,
	): ArrowFeature {
		if ( handleId.startsWith( 'generated:' ) ) {
			throw new Error( 'EDIT_DERIVED_GEOMETRY_READONLY：箭头派生轮廓不可编辑。' );
		}
		let positions: readonly Position3D[];
		if ( handleId.startsWith( 'vertex:' ) ) {
			const index = requireHandleIndex( handleId, 'vertex' );
			if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			positions = feature.geometry.positions.map( ( position, current ) => current === index
				? normalizeAuthorPosition( movement.authorPosition, feature.heightReference )
				: position );
		} else if ( handleId.startsWith( 'midpoint:' ) ) {
			if ( fixedTwoPointArrow( feature.geometry.arrowType ) ) {
				throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：该箭头只有起终点语义。' );
			}
			const index = requireHandleIndex( handleId, 'midpoint' );
			if ( index >= feature.geometry.positions.length - 1 ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
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
			const center = geographicCenter( feature.geometry.positions );
			const current = headingDegreesFrom( center, feature.geometry.positions[ 0 ] );
			const target = headingDegreesFrom( center, movement.authorPosition );
			const delta = constrainHeadingDeltaDegrees( target - current, movement.alt );
			positions = rotatePositionsAroundCenter(
				feature.geometry.positions, delta, feature.heightReference,
			);
		} else {
			throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		}
		return canonicalFeature<ArrowFeature>( {
			...feature,
			geometry: { ...feature.geometry, positions },
			revision: feature.revision + 1,
		} );
	}

	public removeVertex( feature: ArrowFeature, handleId: string ): ArrowFeature {
		const index = requireHandleIndex( handleId, 'vertex' );
		if ( feature.geometry.positions.length <= minimumPoints( feature.geometry.arrowType ) ) {
			throw new Error( 'EDIT_MIN_VERTICES：箭头已达到该类型控制点下限。' );
		}
		if ( index >= feature.geometry.positions.length ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		return canonicalFeature<ArrowFeature>( {
			...feature,
			geometry: {
				...feature.geometry,
				positions: feature.geometry.positions.filter( ( _, current ) => current !== index ),
			},
			revision: feature.revision + 1,
		} );
	}

	public toRenderDescription( feature: ArrowFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polygon',
			positions: generateArrowPolygon(
				feature.geometry.positions,
				feature.geometry,
				feature.heightReference,
			),
			closed: true, sourceType: 'arrow', generated: true,
		} );
	}

	public toJSON( feature: ArrowFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: ArrowDrawingDraft ): ArrowDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}

function generateArrowPolygon(
	positions: readonly Position3D[],
	parameters: ArrowParameters,
	heightReference: ArrowDrawingDraft[ 'heightReference' ],
): readonly Position3D[] {
	const continuous = unwrapPositions( positions );
	const lonLat = continuous.map( ( position ) => [ position[ 0 ], position[ 1 ] ] as [ number, number ] );
	const options = { widthScale: parameters.sizeScale };
	let generated: readonly ( readonly [ number, number ] )[];
	switch ( parameters.arrowType ) {
		case 'fine': generated = createFineArrow( lonLat[ 0 ], lonLat[ 1 ], options ); break;
		case 'assaultDirection': generated = createAssaultDirectionArrow( lonLat[ 0 ], lonLat[ 1 ], options ); break;
		case 'attack': generated = createAttackArrow( lonLat, options ); break;
		case 'swallowtailAttack': generated = createSwallowtailAttackArrow( lonLat, options ); break;
		case 'curved': generated = createCurvedArrow( lonLat, {
			...options,
			...( parameters.curvedBodyWidthFactor === undefined ? {} : {
				bodyWidthFactor: parameters.curvedBodyWidthFactor,
			} ),
			...( parameters.curvedHeadWidthFactor === undefined ? {} : {
				headWidthFactor: parameters.curvedHeadWidthFactor,
			} ),
			...( parameters.curvedHeadLengthFactor === undefined ? {} : {
				headLengthFactor: parameters.curvedHeadLengthFactor,
			} ),
		} ); break;
	}
	const withHeight = generated.map( ( point ) => {
		const wrapped: Position3D = [ wrapLongitudeDegrees( point[ 0 ] ), point[ 1 ], 0 ];
		return interpolateArrowHeight( wrapped, positions, heightReference );
	} );
	if ( withHeight.length > 1
		&& geodesicDistanceMeters( withHeight[ 0 ], withHeight.at( -1 ) as Position3D )
		<= GEOMETRY_EPSILON_METERS ) {
		withHeight.pop();
	}
	return Object.freeze( withHeight );
}

function interpolateArrowHeight(
	generated: Position3D,
	controls: readonly Position3D[],
	heightReference: ArrowDrawingDraft[ 'heightReference' ],
): Position3D {
	let bestDistanceSquared = Number.POSITIVE_INFINITY;
	let bestSegment = 0;
	let bestT = 0;
	for ( let index = 0; index < controls.length - 1; index++ ) {
		const frame = createEnuFrame( [ controls[ index ][ 0 ], controls[ index ][ 1 ], 0 ] );
		const end = ecefToEnu(
			geodeticToEcef( [ controls[ index + 1 ][ 0 ], controls[ index + 1 ][ 1 ], 0 ] ),
			frame,
		);
		const point = ecefToEnu(
			geodeticToEcef( [ generated[ 0 ], generated[ 1 ], 0 ] ),
			frame,
		);
		const lengthSquared = end[ 0 ] ** 2 + end[ 1 ] ** 2;
		const t = lengthSquared === 0 ? 0 : Math.max( 0, Math.min( 1,
			( point[ 0 ] * end[ 0 ] + point[ 1 ] * end[ 1 ] ) / lengthSquared,
		) );
		const east = point[ 0 ] - t * end[ 0 ];
		const north = point[ 1 ] - t * end[ 1 ];
		const distanceSquared = east ** 2 + north ** 2;
		// 严格小于才替换，等距时天然保留较小 segment index。
		if ( distanceSquared < bestDistanceSquared ) {
			bestDistanceSquared = distanceSquared;
			bestSegment = index;
			bestT = t;
		}
	}
	const height = controls[ bestSegment ][ 2 ]
		+ ( controls[ bestSegment + 1 ][ 2 ] - controls[ bestSegment ][ 2 ] ) * bestT;
	return normalizeAuthorPosition(
		[ generated[ 0 ], generated[ 1 ], height ],
		heightReference,
	);
}

function minimumPoints( arrowType: ArrowType ): number {
	return arrowType === 'attack' || arrowType === 'swallowtailAttack' ? 3 : 2;
}

function fixedTwoPointArrow( arrowType: ArrowType ): boolean {
	return arrowType === 'fine' || arrowType === 'assaultDirection';
}

function isArrowType( value: unknown ): value is ArrowType {
	return value === 'fine' || value === 'assaultDirection' || value === 'attack'
		|| value === 'swallowtailAttack' || value === 'curved';
}
