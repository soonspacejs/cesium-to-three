import {
	WGS84_SEMI_MAJOR_AXIS,
	WGS84_SEMI_MINOR_AXIS,
	createEnuFrame,
	ecefToEnu,
	ecefToGeodetic,
	enuToEcef,
	geodesicDistanceMeters,
	geodeticToEcef,
	type Vector3Tuple,
} from '../../document/geodesy';
import { PlotEditorValidationError } from '../../document/diagnostics';
import { normalizePosition } from '../../document/normalize';
import { normalizeFeature } from '../../document/validate';
import type {
	HeightReference,
	PlotFeature,
	PlotStyle,
	Position3D,
} from '../../document/types';
import type {
	DrawingDraft,
	DrawingErrorCode,
	DrawingValidation,
	FinishFeatureOptions,
} from '../types';

export const GEOMETRY_EPSILON_METERS = 1e-3;
export const DEFAULT_PLOT_STYLE: PlotStyle = Object.freeze( {
	strokeColor: '#3388ff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 35,
} );

export function normalizeAuthorPosition(
	position: Position3D,
	heightReference: HeightReference,
): Position3D {
	return Object.freeze( normalizePosition( position, heightReference, {
		clampHeightPolicy: 'coerce',
	} ) ) as Position3D;
}

export function normalizeAuthorPositions(
	positions: readonly Position3D[],
	heightReference: HeightReference,
): readonly Position3D[] {
	return Object.freeze( positions.map(
		( position ) => normalizeAuthorPosition( position, heightReference ),
	) );
}

export function freezeDraft<T extends DrawingDraft>( draft: T ): T {
	return Object.freeze( {
		...draft,
		points: normalizeAuthorPositions( draft.points, draft.heightReference ),
		...( draft.previewPoint === undefined ? {} : {
			previewPoint: normalizeAuthorPosition( draft.previewPoint, draft.heightReference ),
		} ),
		parameters: Object.freeze( { ...draft.parameters } ),
		style: Object.freeze( { ...draft.style } ),
		validation: Object.freeze( { ...draft.validation } ),
	} ) as T;
}

export function validDrawing(): DrawingValidation {
	return Object.freeze( { valid: true } );
}

export function invalidDrawing(
	code: DrawingErrorCode,
	message: string,
	pointIndex?: number,
): DrawingValidation {
	return Object.freeze( {
		valid: false,
		code,
		message,
		...( pointIndex === undefined ? {} : { pointIndex } ),
	} );
}

export function validateDistinctAdjacent(
	positions: readonly Position3D[],
	minimum: number,
): DrawingValidation {
	if ( positions.length < minimum ) {
		return invalidDrawing(
			'DRAW_TOO_FEW_POINTS',
			`至少需要 ${ minimum } 个控制点。`,
		);
	}
	for ( let index = 1; index < positions.length; index++ ) {
		if ( geodesicDistanceMeters( positions[ index - 1 ], positions[ index ] )
			<= GEOMETRY_EPSILON_METERS ) {
			return invalidDrawing(
				'DRAW_DEGENERATE_GEOMETRY',
				'相邻控制点不能重合。',
				index,
			);
		}
	}
	return validDrawing();
}

export function canonicalFeature<T extends PlotFeature>(
	input: unknown,
): T {
	return normalizeFeature( input, { clampHeightPolicy: 'coerce' } ) as T;
}

export function commonFeatureFields(
	draft: DrawingDraft,
	options: FinishFeatureOptions,
): Pick<PlotFeature, 'id' | 'heightReference' | 'visible' | 'properties' | 'revision'> {
	return {
		id: options.id,
		heightReference: draft.heightReference,
		visible: options.visible ?? true,
		properties: options.properties ?? {},
		revision: options.revision ?? 0,
	};
}

export function drawingValidationFromError( error: unknown ): DrawingValidation {
	const message = error instanceof Error ? error.message : '图形校验失败。';
	if ( error instanceof PlotEditorValidationError ) {
		if ( /自交/.test( message ) ) {
			return invalidDrawing( 'DRAW_SELF_INTERSECTION', message );
		}
		if ( /坐标|高度|纬度|经度/.test( message ) ) {
			return invalidDrawing( 'DRAW_INVALID_HEIGHT', message );
		}
		if ( /至少|点数/.test( message ) ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', message );
		}
		if ( /半径|尺寸|宽|高|角|参数|字号|padding/.test( message ) ) {
			return invalidDrawing( 'DRAW_INVALID_PARAMETER', message );
		}
	}
	return invalidDrawing( 'DRAW_DEGENERATE_GEOMETRY', message );
}

export function mergeStyle(
	style: Readonly<Record<string, unknown>>,
	extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return { ...DEFAULT_PLOT_STYLE, ...style, ...extra };
}

/** ECEF 平均方向投影到 WGS84 椭球；近对跖时确定性回退首点。 */
export function geographicCenter( positions: readonly Position3D[] ): Position3D {
	if ( positions.length === 0 ) throw new Error( '中心计算至少需要一个坐标。' );
	let x = 0;
	let y = 0;
	let z = 0;
	let height = 0;
	for ( const position of positions ) {
		const ecef = geodeticToEcef( [ position[ 0 ], position[ 1 ], 0 ] );
		const length = Math.hypot( ...ecef );
		x += ecef[ 0 ] / length;
		y += ecef[ 1 ] / length;
		z += ecef[ 2 ] / length;
		height += position[ 2 ];
	}
	let direction: Vector3Tuple = [ x, y, z ];
	let length = Math.hypot( x, y, z );
	if ( length < 1e-12 ) {
		const fallback = geodeticToEcef( [ positions[ 0 ][ 0 ], positions[ 0 ][ 1 ], 0 ] );
		length = Math.hypot( ...fallback );
		direction = [ fallback[ 0 ] / length, fallback[ 1 ] / length, fallback[ 2 ] / length ];
	} else {
		direction = [ x / length, y / length, z / length ];
	}
	const surfaceScale = 1 / Math.sqrt(
		( direction[ 0 ] ** 2 + direction[ 1 ] ** 2 ) / WGS84_SEMI_MAJOR_AXIS ** 2
		+ direction[ 2 ] ** 2 / WGS84_SEMI_MINOR_AXIS ** 2,
	);
	const surface = ecefToGeodetic( [
		direction[ 0 ] * surfaceScale,
		direction[ 1 ] * surfaceScale,
		direction[ 2 ] * surfaceScale,
	], positions[ 0 ][ 0 ] );
	return Object.freeze( [ surface[ 0 ], surface[ 1 ], height / positions.length ] ) as Position3D;
}

/** 稳定短弧中点；高度使用两个作者高度的线性中值。 */
export function geographicMidpoint(
	start: Position3D,
	end: Position3D,
	heightReference: HeightReference,
): Position3D {
	const center = geographicCenter( [ start, end ] );
	return normalizeAuthorPosition(
		[ center[ 0 ], center[ 1 ], ( start[ 2 ] + end[ 2 ] ) / 2 ],
		heightReference,
	);
}

/** 在 anchor 的局部 ENU 平面生成纯作者坐标，适合 handle 与派生采样。 */
export function positionAtEnuOffset(
	anchor: Position3D,
	eastMeters: number,
	northMeters: number,
	heightReference: HeightReference,
	height = anchor[ 2 ],
): Position3D {
	const frame = createEnuFrame( [ anchor[ 0 ], anchor[ 1 ], 0 ] );
	const ecef = enuToEcef( [ eastMeters, northMeters, 0 ], frame );
	const position = ecefToGeodetic( ecef, anchor[ 0 ] );
	return normalizeAuthorPosition( [ position[ 0 ], position[ 1 ], height ], heightReference );
}

/** 北为 0°、顺时针为正的局部 ENU heading。 */
export function headingDegreesFrom( center: Position3D, target: Position3D ): number {
	const frame = createEnuFrame( [ center[ 0 ], center[ 1 ], 0 ] );
	const local = ecefToEnu(
		geodeticToEcef( [ target[ 0 ], target[ 1 ], 0 ] ),
		frame,
	);
	if ( Math.hypot( local[ 0 ], local[ 1 ] ) <= GEOMETRY_EPSILON_METERS ) {
		throw new Error( 'EDIT_DEGENERATE_GEOMETRY：方向点不能与中心重合。' );
	}
	return ( Math.atan2( local[ 0 ], local[ 1 ] ) * 180 / Math.PI + 360 ) % 360;
}

/** 用旧中心 ENU offset 平移整组 source points，绝不使用经纬度差近似。 */
export function translatePositionsToCenter(
	positions: readonly Position3D[],
	newCenterInput: Position3D,
	heightReference: HeightReference,
): readonly Position3D[] {
	const oldCenter = geographicCenter( positions );
	const newCenter = normalizeAuthorPosition( newCenterInput, heightReference );
	const oldFrame = createEnuFrame( [ oldCenter[ 0 ], oldCenter[ 1 ], 0 ] );
	const newFrame = createEnuFrame( [ newCenter[ 0 ], newCenter[ 1 ], 0 ] );
	return Object.freeze( positions.map( ( position ) => {
		const local = ecefToEnu(
			geodeticToEcef( [ position[ 0 ], position[ 1 ], 0 ] ),
			oldFrame,
		);
		const moved = ecefToGeodetic(
			enuToEcef( [ local[ 0 ], local[ 1 ], 0 ], newFrame ),
			newCenter[ 0 ],
		);
		return normalizeAuthorPosition(
			[ moved[ 0 ], moved[ 1 ], position[ 2 ] ],
			heightReference,
		);
	} ) );
}

/** 绕稳定地理中心按 heading（顺时针）旋转 source points。 */
export function rotatePositionsAroundCenter(
	positions: readonly Position3D[],
	deltaDegrees: number,
	heightReference: HeightReference,
): readonly Position3D[] {
	if ( ! Number.isFinite( deltaDegrees ) ) throw new TypeError( '旋转角必须是有限数。' );
	const center = geographicCenter( positions );
	const frame = createEnuFrame( [ center[ 0 ], center[ 1 ], 0 ] );
	const radians = deltaDegrees * Math.PI / 180;
	const cosine = Math.cos( radians );
	const sine = Math.sin( radians );
	return Object.freeze( positions.map( ( position ) => {
		const local = ecefToEnu(
			geodeticToEcef( [ position[ 0 ], position[ 1 ], 0 ] ),
			frame,
		);
		const east = local[ 0 ] * cosine + local[ 1 ] * sine;
		const north = -local[ 0 ] * sine + local[ 1 ] * cosine;
		const rotated = ecefToGeodetic( enuToEcef( [ east, north, 0 ], frame ), center[ 0 ] );
		return normalizeAuthorPosition(
			[ rotated[ 0 ], rotated[ 1 ], position[ 2 ] ],
			heightReference,
		);
	} ) );
}

export function cloneJson( value: unknown ): unknown {
	return JSON.parse( JSON.stringify( value ) );
}

export function requireHandleIndex( handleId: string, prefix: string ): number {
	const match = new RegExp( `^${ prefix }:(\\d+)$` ).exec( handleId );
	if ( match === null ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
	return Number( match[ 1 ] );
}
