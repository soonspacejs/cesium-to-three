// ============================================================
// polygon/polygon-offset.ts
// 层级:polygon 描边渲染环构造。
// 职责:在局部 ENU 米制平面中构造鲁棒的外扩 offset ring。polygon classification
//      图元会在构造 shadow volume 前使用该路径，使凹形箭头的描边几何与
//      shader 填充测试保持在同一个米制坐标框架中。
// 依赖:Three.js Matrix4/Vector3、ground math cartographic/ellipsoid 辅助函数、
//      ENU 坐标框架辅助函数、矩阵点变换。
// 被消费:primitives.ts。
// ============================================================

import { Matrix4, Vector3 } from 'three';

import { BORDER_GEOMETRY_EXPANSION_SCALE } from '../constants';
import { createCartographic } from '../math/cartographic';
import { cartesianToCartographic, cartographicToCartesian } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import type { LonLatPoint } from '../types';
import { computePolygonCentroidDegrees } from './polygon-helpers';

const _offsetCenterCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _offsetCenterCartesian = new Vector3();
const _offsetEnuMatrix = new Matrix4();
const _offsetInverseEnu = new Matrix4();
const _offsetPointCartographic = createCartographic( 0.0, 0.0, 0.0 );
const _offsetPointCartesian = new Vector3();
const _offsetPointEnu = new Vector3();

function clonePoints( points: readonly LonLatPoint[] ): LonLatPoint[] {
	return points.map( ( point ) => [ point[ 0 ], point[ 1 ] ] as LonLatPoint );
}

function signedArea2D( values: readonly number[] ): number {
	let area = 0.0;
	const n = values.length / 2;
	for ( let i = 0; i < n; i++ ) {
		const j = ( i + 1 ) % n;
		area += values[ 2 * i ] * values[ 2 * j + 1 ] -
			values[ 2 * j ] * values[ 2 * i + 1 ];
	}
	return area * 0.5;
}

function projectRingToEnu(
	points: readonly LonLatPoint[],
	out: number[],
): void {
	const centroid = computePolygonCentroidDegrees( points );
	_offsetCenterCartographic.longitude = centroid[ 0 ] * Math.PI / 180.0;
	_offsetCenterCartographic.latitude = centroid[ 1 ] * Math.PI / 180.0;
	_offsetCenterCartographic.height = 0.0;
	cartographicToCartesian( _offsetCenterCartographic, _offsetCenterCartesian );
	eastNorthUpToFixedFrame( _offsetCenterCartesian, _offsetEnuMatrix );
	_offsetInverseEnu.copy( _offsetEnuMatrix ).invert();

	for ( let i = 0; i < points.length; i++ ) {
		const point = points[ i ];
		_offsetPointCartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		_offsetPointCartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		_offsetPointCartographic.height = 0.0;
		cartographicToCartesian( _offsetPointCartographic, _offsetPointCartesian );
		matrix4MultiplyByPoint(
			_offsetInverseEnu,
			_offsetPointCartesian,
			_offsetPointEnu,
		);
		out[ 2 * i ] = _offsetPointEnu.x;
		out[ 2 * i + 1 ] = _offsetPointEnu.y;
	}
}

function enuPointToLonLat( eastMeters: number, northMeters: number ): LonLatPoint {
	_offsetPointEnu.set( eastMeters, northMeters, 0.0 );
	matrix4MultiplyByPoint(
		_offsetEnuMatrix,
		_offsetPointEnu,
		_offsetPointCartesian,
	);
	const carto = cartesianToCartographic(
		_offsetPointCartesian,
		_offsetPointCartographic,
	);
	if ( carto === undefined ) {
		throw new Error( 'enuPointToLonLat: cannot reverse-project ENU point.' );
	}

	return [
		carto.longitude * 180.0 / Math.PI,
		carto.latitude * 180.0 / Math.PI,
	];
}

/**
 * 为 shader 驱动的多边形描边构造保守渲染外壳。
 *
 * shader 现在会按真实 point-to-edge 距离裁剪描边，因此渲染几何只需覆盖填充环
 * 加请求的描边带。这里有意使用局部米制 AABB，它比直接 offset 凹形箭头轮廓更稳定；
 * 后者的 miter 可能自交并裁掉填充。
 *
 * @param points WGS84 度制多边形填充环。
 * @param borderWidthMeters 请求的外侧描边宽度，单位米。
 * @returns 局部 ENU 渲染外壳的四个 lon/lat 角点。
 */
export function polygonRenderBoundsThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
): LonLatPoint[] {
	if ( points.length < 3 ) {
		return clonePoints( points );
	}

	const paddingMeters = Math.max( borderWidthMeters, 0.0 ) *
		BORDER_GEOMETRY_EXPANSION_SCALE;
	const enu = new Array<number>( points.length * 2 );
	projectRingToEnu( points, enu );

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for ( let i = 0; i < points.length; i++ ) {
		const x = enu[ 2 * i ];
		const y = enu[ 2 * i + 1 ];
		minX = Math.min( minX, x );
		minY = Math.min( minY, y );
		maxX = Math.max( maxX, x );
		maxY = Math.max( maxY, y );
	}

	if (
		! Number.isFinite( minX ) ||
		! Number.isFinite( minY ) ||
		! Number.isFinite( maxX ) ||
		! Number.isFinite( maxY )
	) {
		return clonePoints( points );
	}

	minX -= paddingMeters;
	minY -= paddingMeters;
	maxX += paddingMeters;
	maxY += paddingMeters;

	return [
		enuPointToLonLat( minX, minY ),
		enuPointToLonLat( maxX, minY ),
		enuPointToLonLat( maxX, maxY ),
		enuPointToLonLat( minX, maxY ),
	];
}

/**
 * 通过相邻 offset 边线求交来扩张 lon/lat 多边形。
 *
 * 旧的角平分线长度公式在凹形箭头顶点上不稳定：miter 符号可能翻转，
 * 把渲染外壳推穿填充环。对两条平行 offset 边求交可同时处理凸/凹连接，
 * 之后只需 clamp 特别尖锐的 miter。
 *
 * @param points WGS84 度制多边形填充环。
 * @param borderWidthMeters 请求的外侧描边宽度，单位米。
 * @returns WGS84 度制 offset 渲染环。
 */
function offsetPolygonRingThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
	directionSign: number,
): LonLatPoint[] {
	const offsetMeters = Math.max( borderWidthMeters, 0.0 ) *
		Math.sign( directionSign || 1.0 ) *
		BORDER_GEOMETRY_EXPANSION_SCALE;
	if ( offsetMeters === 0.0 || points.length < 3 ) {
		return clonePoints( points );
	}

	const n = points.length;
	const enu = new Array<number>( n * 2 );
	projectRingToEnu( points, enu );

	const windingSign = signedArea2D( enu ) >= 0.0 ? 1.0 : -1.0;
	const offset: number[] = [];
	const absOffsetMeters = Math.abs( offsetMeters );
	const miterLimit = absOffsetMeters * 4.0;

	for ( let i = 0; i < n; i++ ) {
		const prev = ( i - 1 + n ) % n;
		const next = ( i + 1 ) % n;
		const px = enu[ 2 * prev ];
		const py = enu[ 2 * prev + 1 ];
		const cx = enu[ 2 * i ];
		const cy = enu[ 2 * i + 1 ];
		const nx = enu[ 2 * next ];
		const ny = enu[ 2 * next + 1 ];

		let ePrevX = cx - px;
		let ePrevY = cy - py;
		let eNextX = nx - cx;
		let eNextY = ny - cy;
		const ePrevLen = Math.hypot( ePrevX, ePrevY );
		const eNextLen = Math.hypot( eNextX, eNextY );

		if ( ePrevLen < 1e-9 && eNextLen < 1e-9 ) {
			offset.push( cx, cy );
			continue;
		}
		if ( ePrevLen >= 1e-9 ) {
			ePrevX /= ePrevLen;
			ePrevY /= ePrevLen;
		} else {
			ePrevX = eNextX / eNextLen;
			ePrevY = eNextY / eNextLen;
		}
		if ( eNextLen >= 1e-9 ) {
			eNextX /= eNextLen;
			eNextY /= eNextLen;
		} else {
			eNextX = ePrevX;
			eNextY = ePrevY;
		}

		const prevNormalX = windingSign * ePrevY;
		const prevNormalY = - windingSign * ePrevX;
		const nextNormalX = windingSign * eNextY;
		const nextNormalY = - windingSign * eNextX;
		const line1X = cx + prevNormalX * offsetMeters;
		const line1Y = cy + prevNormalY * offsetMeters;
		const line2X = cx + nextNormalX * offsetMeters;
		const line2Y = cy + nextNormalY * offsetMeters;
		const cross = ePrevX * eNextY - ePrevY * eNextX;
		const isOutwardOffset = offsetMeters > 0.0;
		const isConvexJoin = cross * windingSign > 1e-9;

		if ( isOutwardOffset && ! isConvexJoin ) {
			// 凹连接无法用单个 miter 点表示：两条外扩 offset 线的交点会落到填充环错误侧，
			// 使描边外壳穿过箭头头部/颈部。这里保留两个 offset 边端点，并用短 bevel 段连接，
			// 让渲染外壳仍包住填充区域，同时不生成巨大的三角形。
			offset.push( line1X, line1Y, line2X, line2Y );
			continue;
		}

		let joinedX: number;
		let joinedY: number;
		if ( Math.abs( cross ) > 1e-9 ) {
			const deltaX = line2X - line1X;
			const deltaY = line2Y - line1Y;
			const t = ( deltaX * eNextY - deltaY * eNextX ) / cross;
			joinedX = line1X + ePrevX * t;
			joinedY = line1Y + ePrevY * t;
		} else {
			const normalX = prevNormalX + nextNormalX;
			const normalY = prevNormalY + nextNormalY;
			const normalLen = Math.hypot( normalX, normalY );
			joinedX = normalLen > 1e-9
				? cx + ( normalX / normalLen ) * offsetMeters
				: line1X;
			joinedY = normalLen > 1e-9
				? cy + ( normalY / normalLen ) * offsetMeters
				: line1Y;
		}

		const dx = joinedX - cx;
		const dy = joinedY - cy;
		const length = Math.hypot( dx, dy );
		if ( Number.isFinite( length ) && length > miterLimit && length > 1e-9 ) {
			offset.push( cx + dx / length * miterLimit, cy + dy / length * miterLimit );
		} else if ( Number.isFinite( joinedX ) && Number.isFinite( joinedY ) ) {
			offset.push( joinedX, joinedY );
		} else {
			offset.push( line1X, line1Y );
		}
	}

	const resultLength = offset.length / 2;
	const result: LonLatPoint[] = new Array( resultLength );
	for ( let i = 0; i < resultLength; i++ ) {
		result[ i ] = enuPointToLonLat( offset[ 2 * i ], offset[ 2 * i + 1 ] );
	}

	return result;
}

export function offsetPolygonPointsThroughMeters(
	points: readonly LonLatPoint[],
	borderWidthMeters: number,
): LonLatPoint[] {
	return offsetPolygonRingThroughMeters( points, borderWidthMeters, 1.0 );
}
