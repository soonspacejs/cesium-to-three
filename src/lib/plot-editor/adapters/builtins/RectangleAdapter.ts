import {
	createEnuFrame,
	ecefToEnu,
	ecefToGeodetic,
	enuToEcef,
	geodesicDistanceMeters,
	geodeticToEcef,
	type EnuFrame,
} from '../../document/geodesy';
import type { HeightReference, Position3D, RectangleFeature } from '../../document/types';
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
} from './shared';

export type RectangleDrawingDraft = DrawingDraft & { readonly type: 'rectangle' };

export class RectangleGeometryAdapter implements GeometryAdapter<RectangleDrawingDraft, RectangleFeature> {
	public readonly kind = 'rectangle' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: true,
		insertVertices: false,
		removeVertices: false,
		translate: true,
		rotateHeading: true,
		rotatePitchRoll: true,
		scaleHorizontal: true,
		scaleVertical: true,
		parameterHandles: Object.freeze( [ 'vertex', 'midpoint', 'center', 'rotation' ] as const ),
	} );

	public begin( context: DrawToolContext ): RectangleDrawingDraft {
		return this._withValidation( freezeDraft( {
			type: 'rectangle' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( {} ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '矩形需要两个对角点。' ),
		} ) );
	}

	public addPoint( draft: RectangleDrawingDraft, point: Position3D ): RectangleDrawingDraft {
		const normalized = normalizeAuthorPosition( point, draft.heightReference );
		const points = draft.points.length === 0
			? Object.freeze( [ normalized ] )
			: Object.freeze( [ draft.points[ 0 ], normalized ] );
		return this._withValidation( freezeDraft( {
			...draft,
			phase: points.length === 2 ? 'ready' : 'drawing',
			points,
			previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: RectangleDrawingDraft, point: Position3D ): RectangleDrawingDraft {
		return freezeDraft( {
			...draft,
			previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: RectangleDrawingDraft ): RectangleDrawingDraft {
		// 两个对角点就是 rectangle 的最小输入；Backspace 不越过拓扑下限。
		return draft;
	}

	public validateDraft( draft: RectangleDrawingDraft ): DrawingValidation {
		if ( draft.points.length < 2 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '矩形需要两个对角点。' );
		}
		if ( geodesicDistanceMeters( draft.points[ 0 ], draft.points[ 1 ] )
			<= GEOMETRY_EPSILON_METERS ) {
			return invalidDrawing( 'DRAW_DEGENERATE_GEOMETRY', '矩形两个对角点不能重合。' );
		}
		try {
			const positions = rectangleFromDiagonal(
				draft.points[ 0 ], draft.points[ 1 ], draft.heightReference,
			);
			canonicalFeature<RectangleFeature>( {
				id: '__draft_rectangle__', type: 'rectangle', geometry: { positions },
				style: mergeStyle( draft.style ), heightReference: draft.heightReference,
				visible: true, properties: {}, revision: 0,
			} );
			return Object.freeze( { valid: true } );
		} catch ( error ) {
			return drawingValidationFromError( error );
		}
	}

	public canFinish( draft: RectangleDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: RectangleDrawingDraft, options: FinishFeatureOptions ): RectangleFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<RectangleFeature>( {
			...commonFeatureFields( draft, options ), type: 'rectangle',
			geometry: {
				positions: rectangleFromDiagonal(
					draft.points[ 0 ], draft.points[ 1 ], draft.heightReference,
				),
			},
			style: mergeStyle( draft.style ),
		} );
	}

	public cancel(): void {}

	public preview( draft: RectangleDrawingDraft ): DraftPreviewGeometry {
		const diagonal = draft.points.length >= 2
			? draft.points[ 1 ]
			: draft.previewPoint;
		let positions: readonly Position3D[] = draft.points;
		if ( draft.points[ 0 ] !== undefined && diagonal !== undefined ) {
			try {
				positions = rectangleFromDiagonal( draft.points[ 0 ], diagonal, draft.heightReference );
			} catch {
				// 对角点退化时保留最后可表达的 source 点，等待下一次有效 pointermove。
			}
		}
		return Object.freeze( {
			primitive: 'polygon', positions,
			closed: positions.length === 4, sourceType: 'rectangle', generated: true,
		} );
	}

	public listHandles( feature: RectangleFeature ): readonly EditHandle[] {
		const positions = feature.geometry.positions;
		const handles: EditHandle[] = positions.map( ( position, index ) => ( {
			id: `vertex:${ index }`, entityId: feature.id, kind: 'vertex',
			position, vertexIndex: index, priority: 100,
		} ) );
		for ( let index = 0; index < 4; index++ ) {
			handles.push( {
				id: `midpoint:${ index }`, entityId: feature.id, kind: 'midpoint',
				position: geographicMidpoint(
					positions[ index ], positions[ ( index + 1 ) % 4 ], feature.heightReference,
				),
				segmentIndex: index, priority: 90,
			} );
		}
		const center = geographicCenter( positions );
		handles.push( {
			id: 'center', entityId: feature.id, kind: 'center', position: center, priority: 80,
		} );
		const radius = Math.max( ...positions.map(
			( position ) => geodesicDistanceMeters( center, position ),
		) );
		handles.push( {
			id: 'rotation', entityId: feature.id, kind: 'rotation', priority: 70,
			position: positionAtEnuOffset( center, 0, radius * 1.2, feature.heightReference ),
		} );
		return Object.freeze( handles.map( ( handle ) => Object.freeze( handle ) ) );
	}

	public applyHandle(
		feature: RectangleFeature,
		handleId: string,
		movement: HandleMovement,
	): RectangleFeature {
		let positions: readonly Position3D[];
		if ( handleId.startsWith( 'vertex:' ) ) {
			const index = requireHandleIndex( handleId, 'vertex' );
			if ( index >= 4 ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			positions = resizeRectangleCorner( feature, index, movement.authorPosition );
		} else if ( handleId.startsWith( 'midpoint:' ) ) {
			const index = requireHandleIndex( handleId, 'midpoint' );
			if ( index >= 4 ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
			positions = resizeRectangleSide( feature, index, movement.authorPosition );
		} else if ( handleId === 'center' ) {
			positions = translatePositionsToCenter(
				feature.geometry.positions, movement.authorPosition, feature.heightReference,
			);
		} else if ( handleId === 'rotation' ) {
			const center = geographicCenter( feature.geometry.positions );
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
		return canonicalFeature<RectangleFeature>( {
			...feature, geometry: { positions }, revision: feature.revision + 1,
		} );
	}

	public removeVertex(): RectangleFeature {
		throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：rectangle 始终保持四个角。' );
	}

	public toRenderDescription( feature: RectangleFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'polygon', positions: feature.geometry.positions,
			closed: true, sourceType: 'rectangle', generated: false,
		} );
	}

	public toJSON( feature: RectangleFeature ): unknown { return cloneJson( feature ); }

	private _withValidation( draft: RectangleDrawingDraft ): RectangleDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}

function rectangleFromDiagonal(
	first: Position3D,
	second: Position3D,
	heightReference: HeightReference,
): readonly Position3D[] {
	const center = geographicCenter( [ first, second ] );
	const frame = createEnuFrame( [ center[ 0 ], center[ 1 ], 0 ] );
	const a = ecefToEnu( geodeticToEcef( [ first[ 0 ], first[ 1 ], 0 ] ), frame );
	const c = ecefToEnu( geodeticToEcef( [ second[ 0 ], second[ 1 ], 0 ] ), frame );
	const west = Math.min( a[ 0 ], c[ 0 ] );
	const east = Math.max( a[ 0 ], c[ 0 ] );
	const south = Math.min( a[ 1 ], c[ 1 ] );
	const north = Math.max( a[ 1 ], c[ 1 ] );
	if ( east - west <= GEOMETRY_EPSILON_METERS
		|| north - south <= GEOMETRY_EPSILON_METERS ) {
		throw new Error( 'DRAW_DEGENERATE_GEOMETRY：矩形宽和高必须大于零。' );
	}
	const averageHeight = ( first[ 2 ] + second[ 2 ] ) / 2;
	return localCornersToPositions(
		frame,
		[ [ west, south ], [ east, south ], [ east, north ], [ west, north ] ],
		heightReference,
		averageHeight,
	);
}

function resizeRectangleCorner(
	feature: RectangleFeature,
	index: number,
	target: Position3D,
): readonly Position3D[] {
	const local = rectangleLocal( feature.geometry.positions );
	const opposite = ( index + 2 ) % 4;
	const targetLocal = ecefToEnu(
		geodeticToEcef( [ target[ 0 ], target[ 1 ], 0 ] ), local.frame,
	);
	const fixed = local.points[ opposite ];
	const delta: readonly [ number, number ] = [ targetLocal[ 0 ] - fixed[ 0 ], targetLocal[ 1 ] - fixed[ 1 ] ];
	const signs = [ [ -1, -1 ], [ 1, -1 ], [ 1, 1 ], [ -1, 1 ] ] as const;
	const alongX = dot2( delta, local.xAxis ) * signs[ index ][ 0 ];
	const alongY = dot2( delta, local.yAxis ) * signs[ index ][ 1 ];
	if ( alongX <= GEOMETRY_EPSILON_METERS || alongY <= GEOMETRY_EPSILON_METERS ) {
		throw new Error( 'EDIT_DEGENERATE_GEOMETRY：角点不能越过对角锚点。' );
	}
	const center: readonly [ number, number ] = [
		( targetLocal[ 0 ] + fixed[ 0 ] ) / 2,
		( targetLocal[ 1 ] + fixed[ 1 ] ) / 2,
	];
	return rectangleFromLocalParameters(
		local.frame, center, alongX / 2, alongY / 2,
		local.xAxis, local.yAxis, feature.heightReference,
		averageHeight( feature.geometry.positions ),
	);
}

function resizeRectangleSide(
	feature: RectangleFeature,
	edgeIndex: number,
	target: Position3D,
): readonly Position3D[] {
	const local = rectangleLocal( feature.geometry.positions );
	const targetLocal = ecefToEnu(
		geodeticToEcef( [ target[ 0 ], target[ 1 ], 0 ] ), local.frame,
	);
	const center = [ local.center[ 0 ], local.center[ 1 ] ] as [ number, number ];
	let halfWidth = local.halfWidth;
	let halfHeight = local.halfHeight;
	if ( edgeIndex === 0 || edgeIndex === 2 ) {
		const targetY = dot2( [ targetLocal[ 0 ], targetLocal[ 1 ] ], local.yAxis );
		const oppositeY = dot2( local.points[ edgeIndex === 0 ? 2 : 0 ], local.yAxis );
		const span = ( edgeIndex === 0 ? oppositeY - targetY : targetY - oppositeY );
		if ( span <= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_DEGENERATE_GEOMETRY：矩形高度必须为正。' );
		halfHeight = span / 2;
		const centerY = ( targetY + oppositeY ) / 2;
		const currentY = dot2( center, local.yAxis );
		center[ 0 ] += ( centerY - currentY ) * local.yAxis[ 0 ];
		center[ 1 ] += ( centerY - currentY ) * local.yAxis[ 1 ];
	} else {
		const targetX = dot2( [ targetLocal[ 0 ], targetLocal[ 1 ] ], local.xAxis );
		const oppositeX = dot2( local.points[ edgeIndex === 1 ? 3 : 1 ], local.xAxis );
		const span = ( edgeIndex === 1 ? targetX - oppositeX : oppositeX - targetX );
		if ( span <= GEOMETRY_EPSILON_METERS ) throw new Error( 'EDIT_DEGENERATE_GEOMETRY：矩形宽度必须为正。' );
		halfWidth = span / 2;
		const centerX = ( targetX + oppositeX ) / 2;
		const currentX = dot2( center, local.xAxis );
		center[ 0 ] += ( centerX - currentX ) * local.xAxis[ 0 ];
		center[ 1 ] += ( centerX - currentX ) * local.xAxis[ 1 ];
	}
	return rectangleFromLocalParameters(
		local.frame, center, halfWidth, halfHeight,
		local.xAxis, local.yAxis, feature.heightReference,
		averageHeight( feature.geometry.positions ),
	);
}

function rectangleLocal( positions: readonly Position3D[] ) {
	const centerPosition = geographicCenter( positions );
	const frame = createEnuFrame( [ centerPosition[ 0 ], centerPosition[ 1 ], 0 ] );
	const points = positions.map( ( position ) => {
		const point = ecefToEnu( geodeticToEcef( [ position[ 0 ], position[ 1 ], 0 ] ), frame );
		return [ point[ 0 ], point[ 1 ] ] as const;
	} );
	const center = [
		points.reduce( ( sum, point ) => sum + point[ 0 ], 0 ) / 4,
		points.reduce( ( sum, point ) => sum + point[ 1 ], 0 ) / 4,
	] as const;
	const edgeX = [ points[ 1 ][ 0 ] - points[ 0 ][ 0 ], points[ 1 ][ 1 ] - points[ 0 ][ 1 ] ] as const;
	const xLength = Math.hypot( ...edgeX );
	const xAxis = [ edgeX[ 0 ] / xLength, edgeX[ 1 ] / xLength ] as const;
	const rawY = [ points[ 3 ][ 0 ] - points[ 0 ][ 0 ], points[ 3 ][ 1 ] - points[ 0 ][ 1 ] ] as const;
	const projection = dot2( rawY, xAxis );
	const orthogonalY = [ rawY[ 0 ] - projection * xAxis[ 0 ], rawY[ 1 ] - projection * xAxis[ 1 ] ] as const;
	const yLength = Math.hypot( ...orthogonalY );
	const yAxis = [ orthogonalY[ 0 ] / yLength, orthogonalY[ 1 ] / yLength ] as const;
	return {
		frame, points, center, xAxis, yAxis,
		halfWidth: xLength / 2,
		halfHeight: yLength / 2,
	};
}

function rectangleFromLocalParameters(
	frame: EnuFrame,
	center: readonly [ number, number ],
	halfWidth: number,
	halfHeight: number,
	xAxis: readonly [ number, number ],
	yAxis: readonly [ number, number ],
	heightReference: HeightReference,
	height: number,
): readonly Position3D[] {
	const signs = [ [ -1, -1 ], [ 1, -1 ], [ 1, 1 ], [ -1, 1 ] ] as const;
	const corners = signs.map( ( [ sx, sy ] ) => [
		center[ 0 ] + sx * halfWidth * xAxis[ 0 ] + sy * halfHeight * yAxis[ 0 ],
		center[ 1 ] + sx * halfWidth * xAxis[ 1 ] + sy * halfHeight * yAxis[ 1 ],
	] as const );
	return localCornersToPositions( frame, corners, heightReference, height );
}

function localCornersToPositions(
	frame: EnuFrame,
	corners: readonly ( readonly [ number, number ] )[],
	heightReference: HeightReference,
	height: number,
): readonly Position3D[] {
	return Object.freeze( corners.map( ( corner ) => {
		const geographic = ecefToGeodetic(
			enuToEcef( [ corner[ 0 ], corner[ 1 ], 0 ], frame ),
		);
		return normalizeAuthorPosition(
			[ geographic[ 0 ], geographic[ 1 ], height ], heightReference,
		);
	} ) );
}

function dot2( left: readonly [ number, number ], right: readonly [ number, number ] ): number {
	return left[ 0 ] * right[ 0 ] + left[ 1 ] * right[ 1 ];
}

function averageHeight( positions: readonly Position3D[] ): number {
	return positions.reduce( ( sum, position ) => sum + position[ 2 ], 0 ) / positions.length;
}
