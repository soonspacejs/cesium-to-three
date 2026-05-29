// ============================================================
// math/ellipsoid-geodesic.ts — Vincenty 大地线（geodesic）
// 层级：L0（零依赖数学基础）
// 职责：给定起止 Cartographic，用 Vincenty 公式求出椭球面上两点
//        间的最短大地线，并支持按弧长插值取中间点。
// 依赖：math/cartographic.ts、math/constants.ts。
// 被消费：line/line-densify.ts、line/line-preprocess.ts。
// 算法对应：Cesium Source/Core/EllipsoidGeodesic.js（逐字移植）。
// ============================================================

import type { Cartographic } from './cartographic';
import { createCartographic } from './cartographic';
import { EPSILON12, WGS84_RADII_X, WGS84_RADII_Z } from './constants';

/** Vincenty 椭球（贴地线只用 WGS84，公开 ellipsoid 也只暴露这两项）。 */
export interface GeodesicEllipsoid {
	maximumRadius: number;
	minimumRadius: number;
}

/** 插值预算常量（一次 `vincentyInverseFormula` + `setConstants` 后定型）。 */
interface GeodesicConstants {
	a: number;
	b: number;
	f: number;
	cosineHeading: number;
	sineHeading: number;
	tanU: number;
	cosineU: number;
	sineU: number;
	sigma: number;
	sineAlpha: number;
	sineSquaredAlpha: number;
	cosineSquaredAlpha: number;
	cosineAlpha: number;
	u2Over4: number;
	u4Over16: number;
	u6Over64: number;
	u8Over256: number;
	a0: number;
	a1: number;
	a2: number;
	a3: number;
	distanceRatio: number;
}

const WGS84_DEFAULT: GeodesicEllipsoid = {
	maximumRadius: WGS84_RADII_X,
	minimumRadius: WGS84_RADII_Z,
};

/**
 * Cesium `computeC(f, cos²α)` 中辅助系数 C 的逐字移植。
 *
 * @param f                椭球扁率。
 * @param cosineSquaredAlpha 大地线方位角余弦平方。
 * @returns                C 系数。
 */
function computeC( f: number, cosineSquaredAlpha: number ): number {
	return (
		( f * cosineSquaredAlpha * ( 4.0 + f * ( 4.0 - 3.0 * cosineSquaredAlpha ) ) ) / 16.0
	);
}

/**
 * Cesium `computeDeltaLambda` 逐字移植：Vincenty 主循环里的 ΔλC 项。
 *
 * 用 `f`、方位角项、`sigma`/`sineSigma`/`cosineSigma`/`cos2σm` 算出经差残余值 Δλ。
 *
 * @returns 经差残余值（弧度）。
 */
function computeDeltaLambda(
	f: number,
	sineAlpha: number,
	cosineSquaredAlpha: number,
	sigma: number,
	sineSigma: number,
	cosineSigma: number,
	cosineTwiceSigmaMidpoint: number,
): number {
	const C = computeC( f, cosineSquaredAlpha );

	return (
		( 1.0 - C ) *
		f *
		sineAlpha *
		( sigma +
			C *
				sineSigma *
				( cosineTwiceSigmaMidpoint +
					C *
						cosineSigma *
						( 2.0 * cosineTwiceSigmaMidpoint * cosineTwiceSigmaMidpoint - 1.0 ) ) )
	);
}

/**
 * Vincenty 逆解：给定两点 lon/lat，求椭球面距离与起止航向。
 * 算法逐字对应 Cesium `vincentyInverseFormula`，循环收敛阈值 EPSILON12。
 *
 * @param geodesic        要写回 `_distance`/`_startHeading`/`_endHeading`/`_uSquared` 的对象。
 * @param major           椭球半长轴（米）。
 * @param minor           椭球半短轴（米）。
 * @param firstLongitude  起点经度（弧度）。
 * @param firstLatitude   起点纬度（弧度）。
 * @param secondLongitude 终点经度（弧度）。
 * @param secondLatitude  终点纬度（弧度）。
 */
function vincentyInverseFormula(
	geodesic: EllipsoidGeodesic,
	major: number,
	minor: number,
	firstLongitude: number,
	firstLatitude: number,
	secondLongitude: number,
	secondLatitude: number,
): void {
	const eff = ( major - minor ) / major;
	const l = secondLongitude - firstLongitude;

	const u1 = Math.atan( ( 1.0 - eff ) * Math.tan( firstLatitude ) );
	const u2 = Math.atan( ( 1.0 - eff ) * Math.tan( secondLatitude ) );

	const cosineU1 = Math.cos( u1 );
	const sineU1 = Math.sin( u1 );
	const cosineU2 = Math.cos( u2 );
	const sineU2 = Math.sin( u2 );

	const cc = cosineU1 * cosineU2;
	const cs = cosineU1 * sineU2;
	const ss = sineU1 * sineU2;
	const sc = sineU1 * cosineU2;

	let lambda = l;
	let lambdaDot = Math.PI * 2.0;

	let cosineLambda = Math.cos( lambda );
	let sineLambda = Math.sin( lambda );

	let sigma = 0.0;
	let cosineSigma = 1.0;
	let sineSigma = 0.0;
	let cosineSquaredAlpha = 1.0;
	let cosineTwiceSigmaMidpoint = 0.0;

	// Vincenty 退化保护：起止点完全重合 → 距离 = 0，避免在主循环里反复算
	// 与本初子午线 + IDL 拆段保持稳健性同步：这只挡完全重合 (l==0 且 lat 相等)，
	// 跨对跖由上层 splitAcrossXZPlane 预先拆段保证 |L| 远离 π。
	if ( l === 0.0 && firstLatitude === secondLatitude ) {
		geodesic._distance = 0.0;
		geodesic._startHeading = 0.0;
		geodesic._endHeading = 0.0;
		geodesic._uSquared = 0.0;
		return;
	}

	do {
		cosineLambda = Math.cos( lambda );
		sineLambda = Math.sin( lambda );

		const temp = cs - sc * cosineLambda;
		sineSigma = Math.sqrt(
			cosineU2 * cosineU2 * sineLambda * sineLambda + temp * temp,
		);
		cosineSigma = ss + cc * cosineLambda;

		sigma = Math.atan2( sineSigma, cosineSigma );

		let sineAlpha = 0.0;
		if ( sineSigma === 0.0 ) {
			sineAlpha = 0.0;
			cosineSquaredAlpha = 1.0;
		} else {
			sineAlpha = ( cc * sineLambda ) / sineSigma;
			cosineSquaredAlpha = 1.0 - sineAlpha * sineAlpha;
		}

		lambdaDot = lambda;

		cosineTwiceSigmaMidpoint = cosineSigma - ( 2.0 * ss ) / cosineSquaredAlpha;
		if ( ! Number.isFinite( cosineTwiceSigmaMidpoint ) ) {
			cosineTwiceSigmaMidpoint = 0.0;
		}

		lambda =
			l +
			computeDeltaLambda(
				eff,
				sineAlpha,
				cosineSquaredAlpha,
				sigma,
				sineSigma,
				cosineSigma,
				cosineTwiceSigmaMidpoint,
			);
	} while ( Math.abs( lambda - lambdaDot ) > EPSILON12 );

	const uSquared =
		( cosineSquaredAlpha * ( major * major - minor * minor ) ) / ( minor * minor );
	const A =
		1.0 +
		( uSquared * ( 4096.0 + uSquared * ( uSquared * ( 320.0 - 175.0 * uSquared ) - 768.0 ) ) ) /
			16384.0;
	const B =
		( uSquared * ( 256.0 + uSquared * ( uSquared * ( 74.0 - 47.0 * uSquared ) - 128.0 ) ) ) /
		1024.0;

	const cosineSquaredTwiceSigmaMidpoint =
		cosineTwiceSigmaMidpoint * cosineTwiceSigmaMidpoint;
	const deltaSigma =
		B *
		sineSigma *
		( cosineTwiceSigmaMidpoint +
			( B *
				( cosineSigma * ( 2.0 * cosineSquaredTwiceSigmaMidpoint - 1.0 ) -
					( B *
						cosineTwiceSigmaMidpoint *
						( 4.0 * sineSigma * sineSigma - 3.0 ) *
						( 4.0 * cosineSquaredTwiceSigmaMidpoint - 3.0 ) ) /
						6.0 ) ) /
				4.0 );

	const distance = minor * A * ( sigma - deltaSigma );

	const startHeading = Math.atan2( cosineU2 * sineLambda, cs - sc * cosineLambda );
	const endHeading = Math.atan2( cosineU1 * sineLambda, cs * cosineLambda - sc );

	geodesic._distance = distance;
	geodesic._startHeading = startHeading;
	geodesic._endHeading = endHeading;
	geodesic._uSquared = uSquared;
}

/**
 * 预算插值系数（`setConstants`），逐字移植自 Cesium。
 * 由 `computeProperties` 在每次 `setEndPoints` 后调用一次。
 */
function setConstants( geodesic: EllipsoidGeodesic ): void {
	const uSquared = geodesic._uSquared;
	const a = geodesic._ellipsoid.maximumRadius;
	const b = geodesic._ellipsoid.minimumRadius;
	const f = ( a - b ) / a;

	const cosineHeading = Math.cos( geodesic._startHeading );
	const sineHeading = Math.sin( geodesic._startHeading );

	const tanU = ( 1.0 - f ) * Math.tan( geodesic._start.latitude );

	const cosineU = 1.0 / Math.sqrt( 1.0 + tanU * tanU );
	const sineU = cosineU * tanU;

	const sigma = Math.atan2( tanU, cosineHeading );

	const sineAlpha = cosineU * sineHeading;
	const sineSquaredAlpha = sineAlpha * sineAlpha;
	const cosineSquaredAlpha = 1.0 - sineSquaredAlpha;
	const cosineAlpha = Math.sqrt( cosineSquaredAlpha );

	const u2Over4 = uSquared / 4.0;
	const u4Over16 = u2Over4 * u2Over4;
	const u6Over64 = u4Over16 * u2Over4;
	const u8Over256 = u4Over16 * u4Over16;

	const a0 =
		1.0 +
		u2Over4 -
		( 3.0 * u4Over16 ) / 4.0 +
		( 5.0 * u6Over64 ) / 4.0 -
		( 175.0 * u8Over256 ) / 64.0;
	const a1 =
		1.0 - u2Over4 + ( 15.0 * u4Over16 ) / 8.0 - ( 35.0 * u6Over64 ) / 8.0;
	const a2 = 1.0 - 3.0 * u2Over4 + ( 35.0 * u4Over16 ) / 4.0;
	const a3 = 1.0 - 5.0 * u2Over4;

	const distanceRatio =
		a0 * sigma -
		( a1 * Math.sin( 2.0 * sigma ) * u2Over4 ) / 2.0 -
		( a2 * Math.sin( 4.0 * sigma ) * u4Over16 ) / 16.0 -
		( a3 * Math.sin( 6.0 * sigma ) * u6Over64 ) / 48.0 -
		( Math.sin( 8.0 * sigma ) * 5.0 * u8Over256 ) / 512.0;

	geodesic._constants = {
		a, b, f,
		cosineHeading, sineHeading,
		tanU, cosineU, sineU,
		sigma,
		sineAlpha, sineSquaredAlpha, cosineSquaredAlpha, cosineAlpha,
		u2Over4, u4Over16, u6Over64, u8Over256,
		a0, a1, a2, a3,
		distanceRatio,
	};
}

/**
 * 计算并写回 geodesic 的 start/end + Vincenty 逆解结果 + 插值常量。
 */
function computeProperties(
	geodesic: EllipsoidGeodesic,
	start: Cartographic,
	end: Cartographic,
	ellipsoid: GeodesicEllipsoid,
): void {
	vincentyInverseFormula(
		geodesic,
		ellipsoid.maximumRadius,
		ellipsoid.minimumRadius,
		start.longitude,
		start.latitude,
		end.longitude,
		end.latitude,
	);

	geodesic._start.longitude = start.longitude;
	geodesic._start.latitude = start.latitude;
	geodesic._start.height = 0.0;
	geodesic._end.longitude = end.longitude;
	geodesic._end.latitude = end.latitude;
	geodesic._end.height = 0.0;

	setConstants( geodesic );
}

/**
 * 大地线（geodesic）：椭球面两点间的最短曲面路径。Vincenty 逆解 + 反求插值。
 *
 * 行为与 Cesium `EllipsoidGeodesic` 字节级一致。所有计算在 JS Float64
 * 上完成，不依赖 GPU。贴地线 `line-densify.ts` 每段构造一个实例，按
 * 等弧长插值取中间点。
 */
export class EllipsoidGeodesic {
	/** 椭球（默认 WGS84）。 */
	public readonly _ellipsoid: GeodesicEllipsoid;

	/** 起点 cartographic（height 永远 0）。 */
	public readonly _start: Cartographic;

	/** 终点 cartographic（height 永远 0）。 */
	public readonly _end: Cartographic;

	/** 起点航向（弧度，由 Vincenty 写入）。 */
	public _startHeading = 0.0;

	/** 终点航向（弧度，由 Vincenty 写入）。 */
	public _endHeading = 0.0;

	/** 椭球面距离（米，由 Vincenty 写入）。 */
	public _distance = 0.0;

	/** Vincenty u² = cos²α·(a²-b²)/b²。 */
	public _uSquared = 0.0;

	/** 插值常量缓存（setConstants 写入）。 */
	public _constants: GeodesicConstants;

	/**
	 * @param start     可选起点。
	 * @param end       可选终点。
	 * @param ellipsoid 可选椭球，默认 WGS84。
	 */
	public constructor(
		start?: Cartographic,
		end?: Cartographic,
		ellipsoid: GeodesicEllipsoid = WGS84_DEFAULT,
	) {
		this._ellipsoid = ellipsoid;
		this._start = createCartographic();
		this._end = createCartographic();
		this._constants = createEmptyConstants();

		if ( start !== undefined && end !== undefined ) {
			computeProperties( this, start, end, ellipsoid );
		}
	}

	/** 起点航向（构造后只读）。 */
	public get startHeading(): number {
		return this._startHeading;
	}

	/** 终点航向（构造后只读）。 */
	public get endHeading(): number {
		return this._endHeading;
	}

	/** 椭球面距离（米）。 */
	public get surfaceDistance(): number {
		return this._distance;
	}

	/**
	 * 重设起止点。
	 *
	 * @param start 起点。
	 * @param end   终点。
	 */
	public setEndPoints( start: Cartographic, end: Cartographic ): void {
		computeProperties( this, start, end, this._ellipsoid );
	}

	/**
	 * 按 fraction（0..1）取大地线上点。等价 `interpolateUsingSurfaceDistance(_distance * fraction)`。
	 *
	 * @param fraction 0..1 之间的弧长比例。
	 * @param result   接收结果的 Cartographic。
	 * @returns        填好的 result。
	 */
	public interpolateUsingFraction(
		fraction: number,
		result: Cartographic,
	): Cartographic {
		return this.interpolateUsingSurfaceDistance( this._distance * fraction, result );
	}

	/**
	 * 按弧长取大地线上点（Vincenty 正解）。
	 *
	 * @param distance 距起点的弧长（米）。
	 * @param result   接收结果的 Cartographic（lon/lat 弧度，height=0）。
	 * @returns        填好的 result。
	 */
	public interpolateUsingSurfaceDistance(
		distance: number,
		result: Cartographic,
	): Cartographic {
		const constants = this._constants;
		const s = constants.distanceRatio + distance / constants.b;

		const cosine2S = Math.cos( 2.0 * s );
		const cosine4S = Math.cos( 4.0 * s );
		const cosine6S = Math.cos( 6.0 * s );
		const sine2S = Math.sin( 2.0 * s );
		const sine4S = Math.sin( 4.0 * s );
		const sine6S = Math.sin( 6.0 * s );
		const sine8S = Math.sin( 8.0 * s );

		const s2 = s * s;
		const s3 = s * s2;

		const u8Over256 = constants.u8Over256;
		const u2Over4 = constants.u2Over4;
		const u6Over64 = constants.u6Over64;
		const u4Over16 = constants.u4Over16;

		let sigma =
			( 2.0 * s3 * u8Over256 * cosine2S ) / 3.0 +
			s *
				( 1.0 -
					u2Over4 +
					( 7.0 * u4Over16 ) / 4.0 -
					( 15.0 * u6Over64 ) / 4.0 +
					( 579.0 * u8Over256 ) / 64.0 -
					( u4Over16 - ( 15.0 * u6Over64 ) / 4.0 + ( 187.0 * u8Over256 ) / 16.0 ) *
						cosine2S -
					( ( 5.0 * u6Over64 ) / 4.0 - ( 115.0 * u8Over256 ) / 16.0 ) * cosine4S -
					( 29.0 * u8Over256 * cosine6S ) / 16.0 ) +
			( u2Over4 / 2.0 -
				u4Over16 +
				( 71.0 * u6Over64 ) / 32.0 -
				( 85.0 * u8Over256 ) / 16.0 ) *
				sine2S +
			( ( 5.0 * u4Over16 ) / 16.0 -
				( 5.0 * u6Over64 ) / 4.0 +
				( 383.0 * u8Over256 ) / 96.0 ) *
				sine4S -
			s2 *
				( ( u6Over64 - ( 11.0 * u8Over256 ) / 2.0 ) * sine2S +
					( 5.0 * u8Over256 * sine4S ) / 2.0 ) +
			( ( 29.0 * u6Over64 ) / 96.0 - ( 29.0 * u8Over256 ) / 16.0 ) * sine6S +
			( 539.0 * u8Over256 * sine8S ) / 1536.0;

		const theta = Math.asin( Math.sin( sigma ) * constants.cosineAlpha );
		const latitude = Math.atan( ( constants.a / constants.b ) * Math.tan( theta ) );

		sigma = sigma - constants.sigma;
		const cosineTwiceSigmaMidpoint = Math.cos( 2.0 * constants.sigma + sigma );

		const sineSigma = Math.sin( sigma );
		const cosineSigma = Math.cos( sigma );

		const cc = constants.cosineU * cosineSigma;
		const ss = constants.sineU * sineSigma;

		const lambda = Math.atan2(
			sineSigma * constants.sineHeading,
			cc - ss * constants.cosineHeading,
		);

		const l =
			lambda -
			computeDeltaLambda(
				constants.f,
				constants.sineAlpha,
				constants.cosineSquaredAlpha,
				sigma,
				sineSigma,
				cosineSigma,
				cosineTwiceSigmaMidpoint,
			);

		result.longitude = this._start.longitude + l;
		result.latitude = latitude;
		result.height = 0.0;
		return result;
	}
}

/**
 * 构造 setConstants 还没运行前的零值常量占位。把字段固化在隐藏类上，避免
 * V8 在 setConstants 第一次写入时 transition 到新隐藏类。
 */
function createEmptyConstants(): GeodesicConstants {
	return {
		a: 0.0, b: 0.0, f: 0.0,
		cosineHeading: 0.0, sineHeading: 0.0,
		tanU: 0.0, cosineU: 0.0, sineU: 0.0,
		sigma: 0.0,
		sineAlpha: 0.0, sineSquaredAlpha: 0.0,
		cosineSquaredAlpha: 0.0, cosineAlpha: 0.0,
		u2Over4: 0.0, u4Over16: 0.0, u6Over64: 0.0, u8Over256: 0.0,
		a0: 0.0, a1: 0.0, a2: 0.0, a3: 0.0,
		distanceRatio: 0.0,
	};
}
