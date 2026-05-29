// ============================================================
// line/line-densify.ts — 逐段加密（geodesic / rhumb / none）
// 层级：L4（贴地线几何子模块）。
// 职责：按 arcType 在两个相邻 Cartographic 之间等距插入「中间点」，并把
//        bottom / top / normal / cartographic 四件套追加到累加数组。Cesium
//        `interpolateSegment` 的逐字移植。
// 依赖：math/ellipsoid.ts、math/ellipsoid-geodesic.ts、math/ellipsoid-rhumb-line.ts、
//        math/cartographic.ts、line/line-geometry-normals.ts。
// 被消费：line-geometry-normals.ts 主循环、line-shadow-volume.ts facade。
// 算法对应：Cesium GroundPolylineGeometry.interpolateSegment（+ 弦插值兜底）。
// ============================================================

import { Vector3 } from 'three';

import type { Cartographic } from '../math/cartographic';
import { createCartographic } from '../math/cartographic';
import {
	cartesianToCartographic,
	cartographicToCartesian,
} from '../math/ellipsoid';
import { EllipsoidGeodesic } from '../math/ellipsoid-geodesic';
import { EllipsoidRhumbLine } from '../math/ellipsoid-rhumb-line';

import { computeRightNormal } from './line-geometry-normals';
import { ArcType } from './line-types';

// 模块级 scratch。函数体内禁止 `new`，避免热路径 GC。
const _scratchInterCarto = createCartographic();
const _scratchBottom = new Vector3();
const _scratchTop = new Vector3();
const _scratchRightNormal = new Vector3();
const _scratchChordA = new Vector3();
const _scratchChordB = new Vector3();
const _scratchChordEcef = new Vector3();
const _scratchChordCarto = createCartographic();

/**
 * 给定 cartographic + height，复用 scratch 调用 cartographicToCartesian。
 *
 * @param carto  输入 cartographic（不修改 height）。
 * @param height 高度（米），临时写回 carto.height 再恢复。
 * @param out    输出 ECEF。
 * @returns      out。
 */
function getPosition( carto: Cartographic, height: number, out: Vector3 ): Vector3 {
	const savedHeight = carto.height;
	carto.height = height;
	cartographicToCartesian( carto, out );
	carto.height = savedHeight;
	return out;
}

/** 把 Vector3 的三分量追加到 number[]。 */
function pack3( v: Vector3, array: number[] ): void {
	array.push( v.x, v.y, v.z );
}

/**
 * 单点 push（端点用，doc 02 §3.3）：把一个 cartographic 端点的 bottom / top /
 * 几何法线 / cartographic 追加到四个累加数组。
 *
 * @param carto              端点 cartographic（lon/lat 弧度）。
 * @param normal             已算好的几何法线（vertex miter 或 right normal）。
 * @param minHeight          标准墙下沿高度（构造期统一 0）。
 * @param maxHeight          标准墙上沿高度（构造期统一 1000）。
 * @param normalsArray       追加目标。
 * @param bottomPositionsArray 追加目标。
 * @param topPositionsArray  追加目标。
 * @param cartographicsArray 追加目标（顺序：lat 先 lon 后）。
 */
export function pushVertex(
	carto: Cartographic,
	normal: Vector3,
	minHeight: number,
	maxHeight: number,
	normalsArray: number[],
	bottomPositionsArray: number[],
	topPositionsArray: number[],
	cartographicsArray: number[],
): void {
	pack3( normal, normalsArray );
	pack3( getPosition( carto, minHeight, _scratchBottom ), bottomPositionsArray );
	pack3( getPosition( carto, maxHeight, _scratchTop ), topPositionsArray );
	cartographicsArray.push( carto.latitude, carto.longitude );
}

/**
 * `ArcType.NONE` 的兜底：ECEF 弦上等距插值。每个中点投回到 (lon/lat, h=0) 后
 * 重新算 bottom/top。逐字对应 Cesium 弦插值分支。
 */
function interpolateChord(
	start: Cartographic,
	end: Cartographic,
	minHeight: number,
	maxHeight: number,
	granularity: number,
	normalsArray: number[],
	bottomPositionsArray: number[],
	topPositionsArray: number[],
	cartographicsArray: number[],
): void {
	const startEcef = getPosition( start, 0.0, _scratchChordA );
	const endEcef = getPosition( end, 0.0, _scratchChordB );
	const dist = startEcef.distanceTo( endEcef );
	if ( dist < granularity ) {
		return;
	}

	const rightNormal = computeRightNormal( start, end, maxHeight, _scratchRightNormal );
	const segments = Math.ceil( dist / granularity );

	for ( let i = 1; i < segments; i++ ) {
		const t = i / segments;
		_scratchChordEcef.copy( startEcef ).lerp( endEcef, t );
		const c = cartesianToCartographic( _scratchChordEcef, _scratchChordCarto );
		if ( c === undefined ) {
			continue;
		}
		pack3( rightNormal, normalsArray );
		pack3( getPosition( c, minHeight, _scratchBottom ), bottomPositionsArray );
		pack3( getPosition( c, maxHeight, _scratchTop ), topPositionsArray );
		cartographicsArray.push( c.latitude, c.longitude );
	}
}

/**
 * 在 start → end 之间按 granularity 等弧长插入「中间点」（不含 start/end）。
 * 每个中间点的几何法线复用该段端点 right normal（doc 02 §3.1）。
 *
 * @param start              段起点。
 * @param end                段终点。
 * @param minHeight          标准墙下沿高度。
 * @param maxHeight          标准墙上沿高度。
 * @param granularity        加密阈值（弧度），与 surfaceDistance（米）直接比较，
 *                           对应 Cesium 的实现细节（不做单位换算）。
 * @param arcType            连线方式。
 * @param normalsArray       追加目标。
 * @param bottomPositionsArray 追加目标。
 * @param topPositionsArray  追加目标。
 * @param cartographicsArray 追加目标。
 */
export function interpolateSegment(
	start: Cartographic,
	end: Cartographic,
	minHeight: number,
	maxHeight: number,
	granularity: number,
	arcType: ArcType,
	normalsArray: number[],
	bottomPositionsArray: number[],
	topPositionsArray: number[],
	cartographicsArray: number[],
): void {
	if ( granularity === 0.0 ) {
		return;
	}

	if ( arcType === ArcType.NONE ) {
		interpolateChord(
			start, end, minHeight, maxHeight, granularity,
			normalsArray, bottomPositionsArray, topPositionsArray, cartographicsArray,
		);
		return;
	}

	const line =
		arcType === ArcType.GEODESIC
			? new EllipsoidGeodesic( start, end )
			: new EllipsoidRhumbLine( start, end );

	const surfaceDistance = line.surfaceDistance;
	if ( surfaceDistance < granularity ) {
		return;
	}

	const rightNormal = computeRightNormal( start, end, maxHeight, _scratchRightNormal );
	const segments = Math.ceil( surfaceDistance / granularity );
	const interpointDistance = surfaceDistance / segments;
	const pointsToAdd = segments - 1;
	let distanceFromStart = interpointDistance;

	for ( let i = 0; i < pointsToAdd; i++ ) {
		const c = line.interpolateUsingSurfaceDistance( distanceFromStart, _scratchInterCarto );
		pack3( rightNormal, normalsArray );
		pack3( getPosition( c, minHeight, _scratchBottom ), bottomPositionsArray );
		pack3( getPosition( c, maxHeight, _scratchTop ), topPositionsArray );
		cartographicsArray.push( c.latitude, c.longitude );
		distanceFromStart += interpointDistance;
	}
}
