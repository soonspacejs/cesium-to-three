import { geodesicDestination } from '../../document/geodesy';
import type { HeightReference, Position3D } from '../../document/types';
import { normalizeAuthorPosition } from './shared';

const MIN_CIRCLE_SEGMENTS = 32;
const MAX_CIRCLE_SEGMENTS = 256;

export function normalizeHeading( angle: number ): number {
	if ( ! Number.isFinite( angle ) ) throw new TypeError( 'heading 必须是有限数。' );
	const normalized = ( ( angle % 360 ) + 360 ) % 360;
	return Object.is( normalized, -0 ) ? 0 : normalized;
}

export function clockwiseSweep( startHeading: number, endHeading: number ): number {
	const delta = normalizeHeading( endHeading ) - normalizeHeading( startHeading );
	const sweep = ( delta + 360 ) % 360;
	return sweep === 0 ? 360 : sweep;
}

export function sampleGeodesicArc(
	center: Position3D,
	radiusMeters: number,
	startHeading: number,
	sweepDegrees: number,
	heightReference: HeightReference,
): readonly Position3D[] {
	if ( ! Number.isFinite( radiusMeters ) || radiusMeters <= 0
		|| ! Number.isFinite( sweepDegrees ) || sweepDegrees <= 0 || sweepDegrees > 360 ) {
		throw new RangeError( '圆弧半径必须为正，张角必须位于 (0, 360]。' );
	}
	const fullSegments = Math.min(
		MAX_CIRCLE_SEGMENTS,
		Math.max( MIN_CIRCLE_SEGMENTS, Math.ceil( 2 * Math.PI * radiusMeters / 5_000 ) ),
	);
	const segments = Math.max( 2, Math.ceil( fullSegments * sweepDegrees / 360 ) );
	const points: Position3D[] = [];
	for ( let index = 0; index <= segments; index++ ) {
		// 完整圆不重复保存最后一点；闭合由 render description 的 closed 表达。
		if ( sweepDegrees === 360 && index === segments ) break;
		const heading = normalizeHeading( startHeading + sweepDegrees * index / segments );
		points.push( normalizeAuthorPosition(
			geodesicDestination( center, heading, radiusMeters, center[ 2 ] ),
			heightReference,
		) );
	}
	return Object.freeze( points );
}
