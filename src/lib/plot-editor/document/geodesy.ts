import { normalizePosition, unwrapLongitudeDegrees } from './normalize';
import { HeightReference, type Position3D } from './types';

export const WGS84_SEMI_MAJOR_AXIS = 6_378_137;
export const WGS84_FLATTENING = 1 / 298.257_223_563;
export const WGS84_SEMI_MINOR_AXIS = WGS84_SEMI_MAJOR_AXIS
	* ( 1 - WGS84_FLATTENING );

const WGS84_FIRST_ECCENTRICITY_SQUARED = WGS84_FLATTENING
	* ( 2 - WGS84_FLATTENING );
const WGS84_SECOND_ECCENTRICITY_SQUARED =
	( WGS84_SEMI_MAJOR_AXIS ** 2 - WGS84_SEMI_MINOR_AXIS ** 2 )
	/ WGS84_SEMI_MINOR_AXIS ** 2;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const VINCENTY_ITERATION_LIMIT = 100;
const VINCENTY_CONVERGENCE = 1e-12;
const POLE_EPSILON_METERS = 1e-8;

export type Vector3Tuple = readonly [ x: number, y: number, z: number ];

export interface EnuFrame {
	readonly origin: Vector3Tuple;
	readonly east: Vector3Tuple;
	readonly north: Vector3Tuple;
	readonly up: Vector3Tuple;
}

/** 将 WGS84 地理坐标转换为地心地固坐标（ECEF，单位米）。 */
export function geodeticToEcef( position: Position3D ): Vector3Tuple {
	const longitude = position[ 0 ] * DEGREES_TO_RADIANS;
	const latitude = position[ 1 ] * DEGREES_TO_RADIANS;
	const height = position[ 2 ];
	const sinLatitude = Math.sin( latitude );
	const cosLatitude = Math.cos( latitude );
	const normalRadius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(
		1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude ** 2,
	);
	return [
		( normalRadius + height ) * cosLatitude * Math.cos( longitude ),
		( normalRadius + height ) * cosLatitude * Math.sin( longitude ),
		( normalRadius * ( 1 - WGS84_FIRST_ECCENTRICITY_SQUARED ) + height )
			* sinLatitude,
	];
}

/**
 * 将 ECEF 反算为 WGS84 地理坐标。
 * 精确极点处经度没有几何唯一值，调用方可传入稳定的首选经度。
 */
export function ecefToGeodetic(
	point: Vector3Tuple,
	preferredPoleLongitudeDegrees = 0,
): Position3D {
	const [ x, y, z ] = point;
	if ( ! [ x, y, z ].every( Number.isFinite ) ) {
		throw new TypeError( 'ECEF 三个分量都必须是有限 number。' );
	}
	const horizontal = Math.hypot( x, y );
	if ( horizontal < POLE_EPSILON_METERS ) {
		const latitude = z < 0 ? -90 : 90;
		return normalizePosition(
			[ preferredPoleLongitudeDegrees, latitude, Math.abs( z ) - WGS84_SEMI_MINOR_AXIS ],
			HeightReference.NONE,
		);
	}

	const longitude = Math.atan2( y, x );
	const theta = Math.atan2(
		z * WGS84_SEMI_MAJOR_AXIS,
		horizontal * WGS84_SEMI_MINOR_AXIS,
	);
	const sinTheta = Math.sin( theta );
	const cosTheta = Math.cos( theta );
	const latitude = Math.atan2(
		z + WGS84_SECOND_ECCENTRICITY_SQUARED
			* WGS84_SEMI_MINOR_AXIS * sinTheta ** 3,
		horizontal - WGS84_FIRST_ECCENTRICITY_SQUARED
			* WGS84_SEMI_MAJOR_AXIS * cosTheta ** 3,
	);
	const sinLatitude = Math.sin( latitude );
	const normalRadius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(
		1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude ** 2,
	);
	const height = horizontal / Math.cos( latitude ) - normalRadius;
	return normalizePosition( [
		longitude * RADIANS_TO_DEGREES,
		latitude * RADIANS_TO_DEGREES,
		height,
	], HeightReference.NONE );
}

/** 在指定地理锚点构造确定性的 WGS84 东、北、上正交基。 */
export function createEnuFrame( anchor: Position3D ): EnuFrame {
	const longitude = anchor[ 0 ] * DEGREES_TO_RADIANS;
	const latitude = anchor[ 1 ] * DEGREES_TO_RADIANS;
	const sinLongitude = Math.sin( longitude );
	const cosLongitude = Math.cos( longitude );
	const sinLatitude = Math.sin( latitude );
	const cosLatitude = Math.cos( latitude );
	return Object.freeze( {
		origin: geodeticToEcef( anchor ),
		east: [ -sinLongitude, cosLongitude, 0 ] as Vector3Tuple,
		north: [
			-sinLatitude * cosLongitude,
			-sinLatitude * sinLongitude,
			cosLatitude,
		] as Vector3Tuple,
		up: [
			cosLatitude * cosLongitude,
			cosLatitude * sinLongitude,
			sinLatitude,
		] as Vector3Tuple,
	} );
}

export function ecefToEnu(
	point: Vector3Tuple,
	frame: EnuFrame,
): Vector3Tuple {
	const delta: Vector3Tuple = [
		point[ 0 ] - frame.origin[ 0 ],
		point[ 1 ] - frame.origin[ 1 ],
		point[ 2 ] - frame.origin[ 2 ],
	];
	return [
		dot( delta, frame.east ),
		dot( delta, frame.north ),
		dot( delta, frame.up ),
	];
}

export function enuToEcef(
	point: Vector3Tuple,
	frame: EnuFrame,
): Vector3Tuple {
	return [
		frame.origin[ 0 ] + point[ 0 ] * frame.east[ 0 ]
			+ point[ 1 ] * frame.north[ 0 ] + point[ 2 ] * frame.up[ 0 ],
		frame.origin[ 1 ] + point[ 0 ] * frame.east[ 1 ]
			+ point[ 1 ] * frame.north[ 1 ] + point[ 2 ] * frame.up[ 1 ],
		frame.origin[ 2 ] + point[ 0 ] * frame.east[ 2 ]
			+ point[ 1 ] * frame.north[ 2 ] + point[ 2 ] * frame.up[ 2 ],
	];
}

/**
 * Vincenty 反解计算两点的 WGS84 椭球测地线距离。
 * 近对跖点不收敛时使用有限且确定的球面短弧兜底。
 */
export function geodesicDistanceMeters(
	start: Position3D,
	end: Position3D,
): number {
	const latitude1 = start[ 1 ] * DEGREES_TO_RADIANS;
	const latitude2 = end[ 1 ] * DEGREES_TO_RADIANS;
	const [ unwrappedStart, unwrappedEnd ] = unwrapLongitudeDegrees( [
		start[ 0 ],
		end[ 0 ],
	] );
	const longitudeDelta = ( unwrappedEnd - unwrappedStart ) * DEGREES_TO_RADIANS;
	if ( latitude1 === latitude2 && longitudeDelta === 0 ) {
		return 0;
	}

	const reducedLatitude1 = Math.atan(
		( 1 - WGS84_FLATTENING ) * Math.tan( latitude1 ),
	);
	const reducedLatitude2 = Math.atan(
		( 1 - WGS84_FLATTENING ) * Math.tan( latitude2 ),
	);
	const sinU1 = Math.sin( reducedLatitude1 );
	const cosU1 = Math.cos( reducedLatitude1 );
	const sinU2 = Math.sin( reducedLatitude2 );
	const cosU2 = Math.cos( reducedLatitude2 );
	let lambda = longitudeDelta;
	let sinSigma = 0;
	let cosSigma = 0;
	let sigma = 0;
	let sinAlpha = 0;
	let cosSqAlpha = 0;
	let cos2SigmaM = 0;
	let converged = false;

	for ( let iteration = 0; iteration < VINCENTY_ITERATION_LIMIT; iteration++ ) {
		const sinLambda = Math.sin( lambda );
		const cosLambda = Math.cos( lambda );
		sinSigma = Math.hypot(
			cosU2 * sinLambda,
			cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
		);
		if ( sinSigma === 0 ) {
			return 0;
		}
		cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
		sigma = Math.atan2( sinSigma, cosSigma );
		sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
		cosSqAlpha = 1 - sinAlpha ** 2;
		cos2SigmaM = cosSqAlpha === 0
			? 0
			: cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
		const coefficient = WGS84_FLATTENING / 16 * cosSqAlpha
			* ( 4 + WGS84_FLATTENING * ( 4 - 3 * cosSqAlpha ) );
		const previous = lambda;
		lambda = longitudeDelta + ( 1 - coefficient ) * WGS84_FLATTENING
			* sinAlpha * (
				sigma + coefficient * sinSigma * (
					cos2SigmaM + coefficient * cosSigma
						* ( -1 + 2 * cos2SigmaM ** 2 )
				)
			);
		if ( Math.abs( lambda - previous ) <= VINCENTY_CONVERGENCE ) {
			converged = true;
			break;
		}
	}

	if ( ! converged ) {
		return sphericalFallbackDistance( latitude1, latitude2, longitudeDelta );
	}
	const uSq = cosSqAlpha
		* ( WGS84_SEMI_MAJOR_AXIS ** 2 - WGS84_SEMI_MINOR_AXIS ** 2 )
		/ WGS84_SEMI_MINOR_AXIS ** 2;
	const coefficientA = 1 + uSq / 16_384
		* ( 4096 + uSq * ( -768 + uSq * ( 320 - 175 * uSq ) ) );
	const coefficientB = uSq / 1024
		* ( 256 + uSq * ( -128 + uSq * ( 74 - 47 * uSq ) ) );
	const deltaSigma = coefficientB * sinSigma * (
		cos2SigmaM + coefficientB / 4 * (
			cosSigma * ( -1 + 2 * cos2SigmaM ** 2 )
			- coefficientB / 6 * cos2SigmaM
				* ( -3 + 4 * sinSigma ** 2 )
				* ( -3 + 4 * cos2SigmaM ** 2 )
		)
	);
	return WGS84_SEMI_MINOR_AXIS * coefficientA * ( sigma - deltaSigma );
}

function dot( left: Vector3Tuple, right: Vector3Tuple ): number {
	return left[ 0 ] * right[ 0 ] + left[ 1 ] * right[ 1 ] + left[ 2 ] * right[ 2 ];
}

function sphericalFallbackDistance(
	latitude1: number,
	latitude2: number,
	longitudeDelta: number,
): number {
	const centralAngle = Math.atan2(
		Math.hypot(
			Math.cos( latitude2 ) * Math.sin( longitudeDelta ),
			Math.cos( latitude1 ) * Math.sin( latitude2 )
				- Math.sin( latitude1 ) * Math.cos( latitude2 ) * Math.cos( longitudeDelta ),
		),
		Math.sin( latitude1 ) * Math.sin( latitude2 )
			+ Math.cos( latitude1 ) * Math.cos( latitude2 ) * Math.cos( longitudeDelta ),
	);
	const meanRadius = ( 2 * WGS84_SEMI_MAJOR_AXIS + WGS84_SEMI_MINOR_AXIS ) / 3;
	return meanRadius * centralAngle;
}
