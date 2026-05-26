// ============================================================
// math/ellipsoid-rhumb-line.ts — 椭球恒向线（rhumb line / loxodrome）
// 层级：L0（零依赖数学基础）
// 职责：给定起止 Cartographic，求恒定方位角连接两点的曲面路径，
//        并支持按弧长插值、以及与给定经线 / 纬线的交点（拆段用）。
// 依赖：math/cartographic.ts、math/constants.ts。
// 被消费：line/line-preprocess.ts、line/line-densify.ts。
// 算法对应：Cesium Source/Core/EllipsoidRhumbLine.js（逐字移植）。
// ============================================================

import type { Cartographic } from './cartographic';
import { createCartographic } from './cartographic';
import { EPSILON12, WGS84_RADII_X, WGS84_RADII_Z } from './constants';
import type { GeodesicEllipsoid } from './ellipsoid-geodesic';

const EPSILON8 = 1.0e-8;
const EPSILON10 = 1.0e-10;
const EPSILON14 = 1.0e-14;

const WGS84_DEFAULT: GeodesicEllipsoid = {
	maximumRadius: WGS84_RADII_X,
	minimumRadius: WGS84_RADII_Z,
};

/**
 * Cesium `CesiumMath.negativePiToPi` 移植——把任意角折回 [-π, π)。
 *
 * @param angle 任意角度（弧度）。
 * @returns     折回 [-π, π) 的等价角。
 */
function negativePiToPi( angle: number ): number {
	const twoPi = Math.PI * 2.0;
	let wrapped = angle % twoPi;
	if ( wrapped < - Math.PI ) {
		wrapped += twoPi;
	} else if ( wrapped >= Math.PI ) {
		wrapped -= twoPi;
	}
	return wrapped;
}

/**
 * 椭球子午线弧长积分（M(φ)，逐字 Cesium `calculateM`）。
 *
 * @param ellipticity 椭球第一偏心率 e（非平方）。
 * @param major       半长轴（米）。
 * @param latitude    目标纬度（弧度）。
 * @returns           从赤道到该纬度的子午线弧长（米）。
 */
function calculateM( ellipticity: number, major: number, latitude: number ): number {
	if ( ellipticity === 0.0 ) {
		return major * latitude;
	}

	const e2 = ellipticity * ellipticity;
	const e4 = e2 * e2;
	const e6 = e4 * e2;
	const e8 = e6 * e2;
	const e10 = e8 * e2;
	const e12 = e10 * e2;
	const phi = latitude;
	const sin2Phi = Math.sin( 2.0 * phi );
	const sin4Phi = Math.sin( 4.0 * phi );
	const sin6Phi = Math.sin( 6.0 * phi );
	const sin8Phi = Math.sin( 8.0 * phi );
	const sin10Phi = Math.sin( 10.0 * phi );
	const sin12Phi = Math.sin( 12.0 * phi );

	return (
		major *
		( ( 1.0 -
			e2 / 4.0 -
			( 3.0 * e4 ) / 64.0 -
			( 5.0 * e6 ) / 256.0 -
			( 175.0 * e8 ) / 16384.0 -
			( 441.0 * e10 ) / 65536.0 -
			( 4851.0 * e12 ) / 1048576.0 ) *
			phi -
			( ( 3.0 * e2 ) / 8.0 +
				( 3.0 * e4 ) / 32.0 +
				( 45.0 * e6 ) / 1024.0 +
				( 105.0 * e8 ) / 4096.0 +
				( 2205.0 * e10 ) / 131072.0 +
				( 6237.0 * e12 ) / 524288.0 ) *
				sin2Phi +
			( ( 15.0 * e4 ) / 256.0 +
				( 45.0 * e6 ) / 1024.0 +
				( 525.0 * e8 ) / 16384.0 +
				( 1575.0 * e10 ) / 65536.0 +
				( 155925.0 * e12 ) / 8388608.0 ) *
				sin4Phi -
			( ( 35.0 * e6 ) / 3072.0 +
				( 175.0 * e8 ) / 12288.0 +
				( 3675.0 * e10 ) / 262144.0 +
				( 13475.0 * e12 ) / 1048576.0 ) *
				sin6Phi +
			( ( 315.0 * e8 ) / 131072.0 +
				( 2205.0 * e10 ) / 524288.0 +
				( 43659.0 * e12 ) / 8388608.0 ) *
				sin8Phi -
			( ( 693.0 * e10 ) / 1310720.0 + ( 6237.0 * e12 ) / 5242880.0 ) * sin10Phi +
			( ( 1001.0 * e12 ) / 8388608.0 ) * sin12Phi )
	);
}

/**
 * 子午线弧长反演（calculateInverseM）：由 M 反求纬度 φ。
 * 公式逐字 Cesium。
 */
function calculateInverseM( M: number, ellipticity: number, major: number ): number {
	const d = M / major;

	if ( ellipticity === 0.0 ) {
		return d;
	}

	const d2 = d * d;
	const d3 = d2 * d;
	const d4 = d3 * d;
	const e = ellipticity;
	const e2 = e * e;
	const e4 = e2 * e2;
	const e6 = e4 * e2;
	const e8 = e6 * e2;
	const e10 = e8 * e2;
	const e12 = e10 * e2;
	const sin2D = Math.sin( 2.0 * d );
	const cos2D = Math.cos( 2.0 * d );
	const sin4D = Math.sin( 4.0 * d );
	const cos4D = Math.cos( 4.0 * d );
	const sin6D = Math.sin( 6.0 * d );
	const cos6D = Math.cos( 6.0 * d );
	const sin8D = Math.sin( 8.0 * d );
	const cos8D = Math.cos( 8.0 * d );
	const sin10D = Math.sin( 10.0 * d );
	const cos10D = Math.cos( 10.0 * d );
	const sin12D = Math.sin( 12.0 * d );

	return (
		d +
		( d * e2 ) / 4.0 +
		( 7.0 * d * e4 ) / 64.0 +
		( 15.0 * d * e6 ) / 256.0 +
		( 579.0 * d * e8 ) / 16384.0 +
		( 1515.0 * d * e10 ) / 65536.0 +
		( 16837.0 * d * e12 ) / 1048576.0 +
		( ( 3.0 * d * e4 ) / 16.0 +
			( 45.0 * d * e6 ) / 256.0 -
			( d * ( 32.0 * d2 - 561.0 ) * e8 ) / 4096.0 -
			( d * ( 232.0 * d2 - 1677.0 ) * e10 ) / 16384.0 +
			( d * ( 399985.0 - 90560.0 * d2 + 512.0 * d4 ) * e12 ) / 5242880.0 ) *
			cos2D +
		( ( 21.0 * d * e6 ) / 256.0 +
			( 483.0 * d * e8 ) / 4096.0 -
			( d * ( 224.0 * d2 - 1969.0 ) * e10 ) / 16384.0 -
			( d * ( 33152.0 * d2 - 112599.0 ) * e12 ) / 1048576.0 ) *
			cos4D +
		( ( 151.0 * d * e8 ) / 4096.0 +
			( 4681.0 * d * e10 ) / 65536.0 +
			( 1479.0 * d * e12 ) / 16384.0 -
			( 453.0 * d3 * e12 ) / 32768.0 ) *
			cos6D +
		( ( 1097.0 * d * e10 ) / 65536.0 + ( 42783.0 * d * e12 ) / 1048576.0 ) * cos8D +
		( ( 8011.0 * d * e12 ) / 1048576.0 ) * cos10D +
		( ( 3.0 * e2 ) / 8.0 +
			( 3.0 * e4 ) / 16.0 +
			( 213.0 * e6 ) / 2048.0 -
			( 3.0 * d2 * e6 ) / 64.0 +
			( 255.0 * e8 ) / 4096.0 -
			( 33.0 * d2 * e8 ) / 512.0 +
			( 20861.0 * e10 ) / 524288.0 -
			( 33.0 * d2 * e10 ) / 512.0 +
			( d4 * e10 ) / 1024.0 +
			( 28273.0 * e12 ) / 1048576.0 -
			( 471.0 * d2 * e12 ) / 8192.0 +
			( 9.0 * d4 * e12 ) / 4096.0 ) *
			sin2D +
		( ( 21.0 * e4 ) / 256.0 +
			( 21.0 * e6 ) / 256.0 +
			( 533.0 * e8 ) / 8192.0 -
			( 21.0 * d2 * e8 ) / 512.0 +
			( 197.0 * e10 ) / 4096.0 -
			( 315.0 * d2 * e10 ) / 4096.0 +
			( 584039.0 * e12 ) / 16777216.0 -
			( 12517.0 * d2 * e12 ) / 131072.0 +
			( 7.0 * d4 * e12 ) / 2048.0 ) *
			sin4D +
		( ( 151.0 * e6 ) / 6144.0 +
			( 151.0 * e8 ) / 4096.0 +
			( 5019.0 * e10 ) / 131072.0 -
			( 453.0 * d2 * e10 ) / 16384.0 +
			( 26965.0 * e12 ) / 786432.0 -
			( 8607.0 * d2 * e12 ) / 131072.0 ) *
			sin6D +
		( ( 1097.0 * e8 ) / 131072.0 +
			( 1097.0 * e10 ) / 65536.0 +
			( 225797.0 * e12 ) / 10485760.0 -
			( 1097.0 * d2 * e12 ) / 65536.0 ) *
			sin8D +
		( ( 8011.0 * e10 ) / 2621440.0 + ( 8011.0 * e12 ) / 1048576.0 ) * sin10D +
		( ( 293393.0 * e12 ) / 251658240.0 ) * sin12D
	);
}

/**
 * 等距纬度（isometric latitude）—— 用于恒向线方位角与经差换算。
 */
function calculateSigma( ellipticity: number, latitude: number ): number {
	if ( ellipticity === 0.0 ) {
		return Math.log( Math.tan( 0.5 * ( Math.PI / 2.0 + latitude ) ) );
	}

	const eSinL = ellipticity * Math.sin( latitude );
	return (
		Math.log( Math.tan( 0.5 * ( Math.PI / 2.0 + latitude ) ) ) -
		( ellipticity / 2.0 ) * Math.log( ( 1.0 + eSinL ) / ( 1.0 - eSinL ) )
	);
}

/**
 * 恒向线方位角（heading）—— 起止两点确定的常方位角（弧度）。
 */
function calculateHeading(
	rhumbLine: EllipsoidRhumbLine,
	firstLongitude: number,
	firstLatitude: number,
	secondLongitude: number,
	secondLatitude: number,
): number {
	const sigma1 = calculateSigma( rhumbLine._ellipticity, firstLatitude );
	const sigma2 = calculateSigma( rhumbLine._ellipticity, secondLatitude );
	return Math.atan2(
		negativePiToPi( secondLongitude - firstLongitude ),
		sigma2 - sigma1,
	);
}

/**
 * 恒向线弧长（arc length）—— 起止两点间的弧长（米）。
 * 90° 航向（东西向，常纬度）用 parallel of latitude 公式，否则用子午线弧长差除以余弦。
 */
function calculateArcLength(
	rhumbLine: EllipsoidRhumbLine,
	major: number,
	minor: number,
	firstLongitude: number,
	firstLatitude: number,
	secondLongitude: number,
	secondLatitude: number,
): number {
	const heading = rhumbLine._heading;
	const deltaLongitude = secondLongitude - firstLongitude;

	let distance = 0.0;

	if ( Math.abs( Math.abs( heading ) - Math.PI / 2.0 ) <= EPSILON8 ) {
		if ( major === minor ) {
			distance = major * Math.cos( firstLatitude ) * negativePiToPi( deltaLongitude );
		} else {
			const sinPhi = Math.sin( firstLatitude );
			distance =
				( major *
					Math.cos( firstLatitude ) *
					negativePiToPi( deltaLongitude ) ) /
				Math.sqrt( 1.0 - rhumbLine._ellipticitySquared * sinPhi * sinPhi );
		}
	} else {
		const M1 = calculateM( rhumbLine._ellipticity, major, firstLatitude );
		const M2 = calculateM( rhumbLine._ellipticity, major, secondLatitude );
		distance = ( M2 - M1 ) / Math.cos( heading );
	}
	return Math.abs( distance );
}

/**
 * 沿恒向线推进 distance 米 → 给出终点。逐字 Cesium。
 */
function interpolateUsingSurfaceDistance(
	start: Cartographic,
	heading: number,
	distance: number,
	major: number,
	ellipticity: number,
	result: Cartographic,
): Cartographic {
	if ( distance === 0.0 ) {
		result.longitude = start.longitude;
		result.latitude = start.latitude;
		result.height = 0.0;
		return result;
	}

	const ellipticitySquared = ellipticity * ellipticity;

	let longitude = 0.0;
	let latitude = 0.0;
	let deltaLongitude = 0.0;

	if ( Math.abs( Math.PI / 2.0 - Math.abs( heading ) ) > EPSILON8 ) {
		const M1 = calculateM( ellipticity, major, start.latitude );
		const deltaM = distance * Math.cos( heading );
		const M2 = M1 + deltaM;
		latitude = calculateInverseM( M2, ellipticity, major );

		if ( Math.abs( heading ) < EPSILON10 ) {
			longitude = negativePiToPi( start.longitude );
		} else {
			const sigma1 = calculateSigma( ellipticity, start.latitude );
			const sigma2 = calculateSigma( ellipticity, latitude );
			deltaLongitude = Math.tan( heading ) * ( sigma2 - sigma1 );
			longitude = negativePiToPi( start.longitude + deltaLongitude );
		}
	} else {
		latitude = start.latitude;
		let localRad: number;
		if ( ellipticity === 0.0 ) {
			localRad = major * Math.cos( start.latitude );
		} else {
			const sinPhi = Math.sin( start.latitude );
			localRad =
				( major * Math.cos( start.latitude ) ) /
				Math.sqrt( 1.0 - ellipticitySquared * sinPhi * sinPhi );
		}

		deltaLongitude = distance / localRad;
		if ( heading > 0.0 ) {
			longitude = negativePiToPi( start.longitude + deltaLongitude );
		} else {
			longitude = negativePiToPi( start.longitude - deltaLongitude );
		}
	}

	result.longitude = longitude;
	result.latitude = latitude;
	result.height = 0.0;
	return result;
}

/**
 * 写回 start/end + heading + arcLength + ellipticity 等所有字段。
 */
function computeProperties(
	rhumbLine: EllipsoidRhumbLine,
	start: Cartographic,
	end: Cartographic,
	ellipsoid: GeodesicEllipsoid,
): void {
	const major = ellipsoid.maximumRadius;
	const minor = ellipsoid.minimumRadius;
	const majorSquared = major * major;
	const minorSquared = minor * minor;
	rhumbLine._ellipticitySquared = ( majorSquared - minorSquared ) / majorSquared;
	rhumbLine._ellipticity = Math.sqrt( rhumbLine._ellipticitySquared );

	rhumbLine._start.longitude = start.longitude;
	rhumbLine._start.latitude = start.latitude;
	rhumbLine._start.height = 0.0;

	rhumbLine._end.longitude = end.longitude;
	rhumbLine._end.latitude = end.latitude;
	rhumbLine._end.height = 0.0;

	rhumbLine._heading = calculateHeading(
		rhumbLine,
		start.longitude,
		start.latitude,
		end.longitude,
		end.latitude,
	);
	rhumbLine._distance = calculateArcLength(
		rhumbLine,
		major,
		minor,
		start.longitude,
		start.latitude,
		end.longitude,
		end.latitude,
	);
}

/**
 * 椭球恒向线（rhumb line）：保持恒定方位角的曲面路径。
 *
 * 与 `EllipsoidGeodesic` 接口对称。贴地线 `line-densify.ts` 在 `arcType==='rhumb'`
 * 时构造一个实例并按弧长插值；`line-preprocess.ts` 跨本初子午线 / IDL 拆段
 * 时用 `findIntersectionWithLongitude` 在恒向线上求交点。
 */
export class EllipsoidRhumbLine {
	public readonly _ellipsoid: GeodesicEllipsoid;
	public readonly _start: Cartographic;
	public readonly _end: Cartographic;
	public _heading = 0.0;
	public _distance = 0.0;
	public _ellipticity = 0.0;
	public _ellipticitySquared = 0.0;

	public constructor(
		start?: Cartographic,
		end?: Cartographic,
		ellipsoid: GeodesicEllipsoid = WGS84_DEFAULT,
	) {
		this._ellipsoid = ellipsoid;
		this._start = createCartographic();
		this._end = createCartographic();

		if ( start !== undefined && end !== undefined ) {
			computeProperties( this, start, end, ellipsoid );
		}
	}

	/** 起止两点的恒向线弧长（米）。 */
	public get surfaceDistance(): number {
		return this._distance;
	}

	/** 恒方位角（弧度）。 */
	public get heading(): number {
		return this._heading;
	}

	public setEndPoints( start: Cartographic, end: Cartographic ): void {
		computeProperties( this, start, end, this._ellipsoid );
	}

	/**
	 * 按 fraction（0..1）取恒向线上点。
	 */
	public interpolateUsingFraction(
		fraction: number,
		result: Cartographic,
	): Cartographic {
		return this.interpolateUsingSurfaceDistance(
			fraction * this._distance,
			result,
		);
	}

	/**
	 * 按弧长取恒向线上点。
	 *
	 * @param distance 弧长（米）。
	 * @param result   接收结果的 Cartographic。
	 * @returns        填好的 result。
	 */
	public interpolateUsingSurfaceDistance(
		distance: number,
		result: Cartographic,
	): Cartographic {
		return interpolateUsingSurfaceDistance(
			this._start,
			this._heading,
			distance,
			this._ellipsoid.maximumRadius,
			this._ellipticity,
			result,
		);
	}

	/**
	 * 找恒向线与给定经线的交点。逐字 Cesium，含 90°/0° 退化、对跖与 EPSILON14 边界处理。
	 *
	 * @param intersectionLongitude 经度（弧度）。
	 * @param result                接收结果的 Cartographic。
	 * @returns                     填好的 result；E-W 与给定经线重合等无穷交点情形返回 undefined。
	 */
	public findIntersectionWithLongitude(
		intersectionLongitude: number,
		result: Cartographic,
	): Cartographic | undefined {
		if ( this._distance === 0.0 ) {
			return undefined;
		}

		const ellipticity = this._ellipticity;
		const heading = this._heading;
		const absHeading = Math.abs( heading );
		const start = this._start;

		let lon = negativePiToPi( intersectionLongitude );
		if ( Math.abs( Math.abs( lon ) - Math.PI ) <= EPSILON14 ) {
			lon = Math.sign( start.longitude ) * Math.PI;
		}

		// E-W 恒纬度线
		if ( Math.abs( Math.PI / 2.0 - absHeading ) <= EPSILON8 ) {
			result.longitude = lon;
			result.latitude = start.latitude;
			result.height = 0.0;
			return result;
		}

		// E-W ± 90° 的边界，向极点收敛
		if ( Math.abs( Math.abs( Math.PI / 2.0 - absHeading ) - Math.PI / 2.0 ) <= EPSILON8 ) {
			if ( Math.abs( lon - start.longitude ) <= EPSILON12 ) {
				return undefined;
			}
			result.longitude = lon;
			result.latitude = ( Math.PI / 2.0 ) * Math.sign( Math.PI / 2.0 - heading );
			result.height = 0.0;
			return result;
		}

		// 迭代求解 Equation 9（Williams：http://edwilliams.org/ellipsoid/ellipsoid.pdf）
		const phi1 = start.latitude;
		const eSinPhi1 = ellipticity * Math.sin( phi1 );
		const leftComponent =
			Math.tan( 0.5 * ( Math.PI / 2.0 + phi1 ) ) *
			Math.exp( ( lon - start.longitude ) / Math.tan( heading ) );
		const denominator = ( 1.0 + eSinPhi1 ) / ( 1.0 - eSinPhi1 );

		let newPhi = start.latitude;
		let phi = newPhi;
		do {
			phi = newPhi;
			const eSinPhi = ellipticity * Math.sin( phi );
			const numerator = ( 1.0 + eSinPhi ) / ( 1.0 - eSinPhi );
			newPhi =
				2.0 *
					Math.atan(
						leftComponent * Math.pow( numerator / denominator, ellipticity / 2.0 ),
					) -
				Math.PI / 2.0;
		} while ( Math.abs( newPhi - phi ) > EPSILON12 );

		result.longitude = lon;
		result.latitude = newPhi;
		result.height = 0.0;
		return result;
	}
}
