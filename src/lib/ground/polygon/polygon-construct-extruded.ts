// ============================================================
// polygon/polygon-construct-extruded.ts — Polygon 整体 prism 装配
// 层级:L4(组合 cap + wall + tangent-plane + extrudeDirection + rectangle)
// 职责:把 PolygonHierarchy 转为完整 shadow volume prism 几何:
//        1. constructPolygonCap → 顶面网格(在椭球面上;含 subdivision 中点)
//        2. cap 复制为 top + bottom 两份,各自加 maxH / minH(Cesium-equivalent
//           scaleToGeodeticHeightExtruded:用 chord 法向 + 投到 surface 后加高度)
//        3. cap extrudeDirection:top = 0,bot = -geodeticSurfaceNormal(top_at_maxH)
//        4. cap 索引:top = 原 cap.indices,bot = (i2, i1, i0) + capVertexCount(winding 反转)
//        5. 每个 ring(外环 + 每个 hole)调 constructPolygonWall,各自独立 wall
//        6. 合并 positions(cap top + cap bot + 每个 wall),extrudeDirection 同序,
//           indices(cap top + cap bot + 每个 wall,wall 索引加偏移)
//        7. polygonRectangle = outer ring 经度纬度 min/max(用于 polygon-extents/style)
// 依赖:Three.js Vector3、math/ellipsoid.ts、polygon-cap-construction.ts、
//      polygon-wall-construction.ts、polygon-rectangle.ts、polygon-hierarchy.ts、
//      rectangle/rectangle-attributes.ts(createIndexTypedArray)、types.ts
// 被消费:polygon-shadow-volume.ts(公共入口)
// 算法对应:Cesium PolygonGeometry.createGeometry 主体 +
//          createGeometryFromPositionsExtruded(L428-557)装配 +
//          scaleToGeodeticHeightExtruded(L379-423) +
//          computeAttributes shadowVolume 分支(L62-423)
// ============================================================

import { Vector3 } from 'three';

import {
	geodeticSurfaceNormal,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';
import { createIndexTypedArray } from '../rectangle/rectangle-attributes';
import type { RectangleRadians } from '../types';
import { constructPolygonCap } from './polygon-cap-construction';
import type { PolygonHierarchy } from './polygon-hierarchy';
import { computePolygonRectangle } from './polygon-rectangle';
import {
	constructPolygonWall,
	type PolygonWallResult,
} from './polygon-wall-construction';

/**
 * 完整 prism 装配结果。
 *
 * 排列约定:
 *   positions  = [
 *     <cap top    顶点 0..capVertexCount-1>    (高度 = maximumHeight)
 *     <cap bottom 顶点 0..capVertexCount-1>    (高度 = minimumHeight)
 *     <wall_0 顶点 0..(2 × wallPerSide_0 - 1)>  (顺序由 constructPolygonWall 决定)
 *     <wall_1 顶点 ...>
 *     ...
 *   ]
 *   extrudeDirection 同序,Float32,长度同 positions。
 *
 *   indices = [
 *     <cap top    三角形索引>       (引用 cap top 顶点 ID 0..capVertexCount-1)
 *     <cap bottom 三角形索引(winding 反转 + 加 capVertexCount 偏移)>
 *     <wall_0 索引(加 capVertexCount × 2 偏移)>
 *     <wall_1 索引(加 capVertexCount × 2 + wall_0 顶点数 偏移)>
 *     ...
 *   ]
 *
 * polygonRectangle 是 outer ring 顶点的轴对齐经纬度外接矩形(弧度);
 * 由 polygon-extents.ts / polygon-style-points.ts 在更上层使用。
 */
export interface ExtrudedPolygonResult {
	positions: Float64Array;
	extrudeDirection: Float32Array;
	indices: Uint16Array | Uint32Array;
	polygonRectangle: RectangleRadians;
}

// 模块级 scratch(整个 polygon 构造路径下复用一次性 Vector3)。
const _capScaleChordScratch = new Vector3();
const _capScaleSurfaceScratch = new Vector3();
const _capScaleNormalScratch = new Vector3();
const _capExtrudeTopPosScratch = new Vector3();
const _capExtrudeNormalScratch = new Vector3();

/**
 * 把 cap 的双面 positions(top + bot,初始都是 cap surface/chord 位置)
 * 投到 top = maximumHeight、bot = minimumHeight 的高度,
 * **使用 Cesium scaleToGeodeticHeightExtruded 完全字节级一致的逻辑**:
 *   n1 = geodeticSurfaceNormal(chord_position)     ← 用 chord(未投影)位置算法向
 *   p2 = scaleToGeodeticSurface(chord_position)    ← 把 chord 投到 surface
 *   bot = p2 + minHeight * n1
 *   top = p2 + maxHeight * n1
 *
 * 关键:**法向用 chord 位置算,加高度时基于 surface 投影**。math/ellipsoid.ts
 * 的 scaleToGeodeticHeight 在 scaleToSurface=true 时用 surface 法向,不同 —
 * 因此本函数不用 math/ellipsoid.ts 的封装,直接调底层 2 个函数。
 *
 * @param positions       双面 positions 数组(原地修改;长度 = perSideFloatLength × 2)。
 * @param perSideFloatLength cap 单面 floats 数量(= capVertexCount × 3)。
 * @param maximumHeight   顶面高度(米)。
 * @param minimumHeight   底面高度(米)。
 */
function scaleCapPositionsToHeights(
	positions: Float64Array,
	perSideFloatLength: number,
	maximumHeight: number,
	minimumHeight: number,
): void {
	for ( let i = 0; i < perSideFloatLength; i += 3 ) {
		_capScaleChordScratch.set(
			positions[ i ],
			positions[ i + 1 ],
			positions[ i + 2 ],
		);

		// n1 = geodeticSurfaceNormal(chord)
		const normalResult = geodeticSurfaceNormal(
			_capScaleChordScratch,
			_capScaleNormalScratch,
		);
		if ( normalResult === undefined ) {
			throw new Error(
				`scaleCapPositionsToHeights: cap vertex #${ i / 3 } is at ellipsoid center, cannot compute normal.`,
			);
		}

		// p2 = scaleToGeodeticSurface(chord)
		const surfaceResult = scaleToGeodeticSurface(
			_capScaleChordScratch,
			_capScaleSurfaceScratch,
		);
		if ( surfaceResult === undefined ) {
			throw new Error(
				`scaleCapPositionsToHeights: cap vertex #${ i / 3 } cannot project to surface.`,
			);
		}

		// bot = surface + minHeight * normal(写入下半区)
		positions[ i + perSideFloatLength ]     = _capScaleSurfaceScratch.x + _capScaleNormalScratch.x * minimumHeight;
		positions[ i + 1 + perSideFloatLength ] = _capScaleSurfaceScratch.y + _capScaleNormalScratch.y * minimumHeight;
		positions[ i + 2 + perSideFloatLength ] = _capScaleSurfaceScratch.z + _capScaleNormalScratch.z * minimumHeight;

		// top = surface + maxHeight * normal(覆盖上半区,本来是 chord)
		positions[ i ]     = _capScaleSurfaceScratch.x + _capScaleNormalScratch.x * maximumHeight;
		positions[ i + 1 ] = _capScaleSurfaceScratch.y + _capScaleNormalScratch.y * maximumHeight;
		positions[ i + 2 ] = _capScaleSurfaceScratch.z + _capScaleNormalScratch.z * maximumHeight;
	}
}

/**
 * 计算 cap 的 extrudeDirection:
 *   top 半 = (0, 0, 0)(Float32Array 默认 0,无需显式写)
 *   bot 半 = -geodeticSurfaceNormal(top 半对应位置, 已 at maxHeight)
 *
 * 与 Cesium computeAttributes 的 shadowVolume + (cap 路径 wall=false) 分支一致:
 * 该路径里 normal = ellipsoid.geodeticSurfaceNormal(position),position 是
 * 已经过 scaleToGeodeticHeightExtruded 的 top 半位置(at maxHeight)。
 *
 * @param positions          完整 cap 双面 positions(已 scale 过高度)。
 * @param perSideFloatLength cap 单面 floats 数量。
 * @param extrudeDirection   输出 Float32Array(长度同 positions;原地写入 bot 半)。
 */
function computeCapExtrudeDirection(
	positions: Float64Array,
	perSideFloatLength: number,
	extrudeDirection: Float32Array,
): void {
	for ( let i = 0; i < perSideFloatLength; i += 3 ) {
		_capExtrudeTopPosScratch.set(
			positions[ i ],
			positions[ i + 1 ],
			positions[ i + 2 ],
		);
		const result = geodeticSurfaceNormal(
			_capExtrudeTopPosScratch,
			_capExtrudeNormalScratch,
		);
		if ( result === undefined ) {
			throw new Error(
				`computeCapExtrudeDirection: cap top vertex #${ i / 3 } at maxHeight cannot compute geodeticSurfaceNormal.`,
			);
		}

		// bot 半 = -normal
		extrudeDirection[ i + perSideFloatLength ]     = -_capExtrudeNormalScratch.x;
		extrudeDirection[ i + 1 + perSideFloatLength ] = -_capExtrudeNormalScratch.y;
		extrudeDirection[ i + 2 + perSideFloatLength ] = -_capExtrudeNormalScratch.z;
		// top 半保持 0(Float32Array 默认初始化)
	}
}

/**
 * 从 cap.positions 中提取一个 ring 的顶点(原始 ring 边界,不含 subdivision 中点),
 * 返回 Vector3[] 供 constructPolygonWall 消费。
 *
 * @param capPositions cap.positions(Float64,扁平 ECEF;**注意此处必须传 surface
 *                     版本的 cap.positions,不能传 already-scaled 高度版本**)。
 * @param startIndex   ring 在 cap.positions 中的起始顶点索引(乘以 3 得到 float 偏移)。
 * @param length       ring 长度(顶点数)。
 * @returns            Vector3[](每个顶点是新实例,可以安全持有)。
 */
function readRingFromCapPositions(
	capPositions: Float64Array,
	startIndex: number,
	length: number,
): Vector3[] {
	const result: Vector3[] = new Array( length );
	for ( let k = 0; k < length; k++ ) {
		const floatIdx = ( startIndex + k ) * 3;
		result[ k ] = new Vector3(
			capPositions[ floatIdx ],
			capPositions[ floatIdx + 1 ],
			capPositions[ floatIdx + 2 ],
		);
	}
	return result;
}

/**
 * 构造完整的 polygon shadow volume prism(顶面 + 底面 + 每个 ring 的侧墙)。
 *
 * @param hierarchy     Polygon hierarchy(Vector3 ECEF;由 polygon-hierarchy 校验过)。
 * @param granularity   网格精度(弧度);≤ 0 抛错。
 * @param minimumHeight 底面高度(米)。
 * @param maximumHeight 顶面高度(米);必须 > minimumHeight。
 * @returns             完整 prism 装配结果。
 * @throws              granularity / 高度参数非法,或几何退化(ring < 3 顶点)。
 */
export function constructExtrudedPolygonShadowVolume(
	hierarchy: PolygonHierarchy,
	granularity: number,
	minimumHeight: number,
	maximumHeight: number,
): ExtrudedPolygonResult {
	if ( ! ( granularity > 0.0 ) ) {
		throw new Error(
			`constructExtrudedPolygonShadowVolume: granularity must be > 0, got ${ granularity }.`,
		);
	}
	if ( ! Number.isFinite( minimumHeight ) || ! Number.isFinite( maximumHeight ) ) {
		throw new Error(
			'constructExtrudedPolygonShadowVolume: minimum/maximumHeight must be finite numbers.',
		);
	}
	if ( maximumHeight <= minimumHeight ) {
		throw new Error(
			`constructExtrudedPolygonShadowVolume: maximumHeight (${ maximumHeight }) must be > minimumHeight (${ minimumHeight }).`,
		);
	}

	// ── Step 1 · Cap 构造 ──
	// cap.positions 是 Float64 ECEF,在椭球面/chord(subdivision 中点在 chord),
	// 长度 = 3 × capVertexCount,capVertexCount = 原 ring 顶点 + subdivision 中点。
	// cap.rings 是原始 ring 边界的 [startIndex, length],只引用 ring 顶点(0..ringTotalLen)。
	const cap = constructPolygonCap( hierarchy, granularity );
	const capVertexCount = cap.positions.length / 3;
	const capFloatLength = cap.positions.length;

	// ── Step 2 · Cap 双面 positions ──
	// Cesium L462:`topBottomPositions = edgePoints.concat(edgePoints)`
	// 即两份 cap positions 顺序排列,top 半在前,bot 半在后(都是 chord)。
	// 然后 scaleToGeodeticHeightExtruded 把 top 半改成 +maxHeight,bot 半改成 +minHeight。
	const totalCapFloatLength = capFloatLength * 2;
	const capPositions = new Float64Array( totalCapFloatLength );
	capPositions.set( cap.positions, 0 );
	capPositions.set( cap.positions, capFloatLength );
	scaleCapPositionsToHeights( capPositions, capFloatLength, maximumHeight, minimumHeight );

	// ── Step 3 · Cap extrudeDirection ──
	const capExtrudeDirection = new Float32Array( totalCapFloatLength );
	computeCapExtrudeDirection( capPositions, capFloatLength, capExtrudeDirection );

	// ── Step 4 · Cap 索引(top 原样 + bot winding 反转 + 加 capVertexCount 偏移) ──
	// Cesium L466-483:
	//   newIndices[i + ilength] = i2;          ← 反转 winding
	//   newIndices[i + 1 + ilength] = i1;
	//   newIndices[i + 2 + ilength] = i0;
	//   (每个 + length 是因为 newIndices[i..ilength] = indices(top 原样),
	//    再后面是 bot 索引 + capVertexCount 偏移)
	const capIndicesLength = cap.indices.length;
	const totalCapIndicesLength = capIndicesLength * 2;

	// ── Step 5 · 每个 ring 调 constructPolygonWall ──
	// cap.rings[0] = 外环;cap.rings[1..N] = 每个 hole(可能少于 hierarchy.holes.length,
	// 因为 processPolygonRings 会丢弃退化 hole)。
	const wallResults: PolygonWallResult[] = [];
	let totalWallVertexCount = 0;
	let totalWallIndicesLength = 0;

	for ( let r = 0; r < cap.rings.length; r++ ) {
		const ringInfo = cap.rings[ r ];
		const ringPositions = readRingFromCapPositions(
			cap.positions,
			ringInfo.startIndex,
			ringInfo.length,
		);
		const wall = constructPolygonWall(
			ringPositions,
			granularity,
			minimumHeight,
			maximumHeight,
		);
		wallResults.push( wall );
		totalWallVertexCount += wall.positions.length / 3;
		totalWallIndicesLength += wall.indices.length;
	}

	// ── Step 6 · 合并 ──
	const totalVertexCount = capVertexCount * 2 + totalWallVertexCount;
	const totalFloatLength = totalVertexCount * 3;
	const totalIndicesLength = totalCapIndicesLength + totalWallIndicesLength;

	const positions = new Float64Array( totalFloatLength );
	const extrudeDirection = new Float32Array( totalFloatLength );
	const indices = createIndexTypedArray( totalVertexCount, totalIndicesLength );

	// 6a · cap positions + extrudeDirection
	positions.set( capPositions, 0 );
	extrudeDirection.set( capExtrudeDirection, 0 );

	// 6b · cap 索引(top 原样)
	let indicesWriteIdx = 0;
	for ( let k = 0; k < capIndicesLength; k++ ) {
		indices[ indicesWriteIdx++ ] = cap.indices[ k ];
	}
	// 6b · cap 索引(bot winding 反转 + 加 capVertexCount 偏移)
	for ( let k = 0; k < capIndicesLength; k += 3 ) {
		indices[ indicesWriteIdx++ ] = cap.indices[ k + 2 ] + capVertexCount;
		indices[ indicesWriteIdx++ ] = cap.indices[ k + 1 ] + capVertexCount;
		indices[ indicesWriteIdx++ ] = cap.indices[ k ]     + capVertexCount;
	}

	// 6c · 写每个 wall 的 positions / extrudeDirection / indices
	let wallPositionOffsetFloat = capFloatLength * 2;
	let wallVertexIDOffset = capVertexCount * 2;

	for ( let w = 0; w < wallResults.length; w++ ) {
		const wall = wallResults[ w ];

		// positions / extrudeDirection 整段 set(Float64Array.set / Float32Array.set 内部 memcpy)
		positions.set( wall.positions, wallPositionOffsetFloat );
		extrudeDirection.set( wall.extrudeDirection, wallPositionOffsetFloat );

		// indices 逐个加偏移
		for ( let k = 0; k < wall.indices.length; k++ ) {
			indices[ indicesWriteIdx++ ] = wall.indices[ k ] + wallVertexIDOffset;
		}

		wallPositionOffsetFloat += wall.positions.length;
		wallVertexIDOffset += wall.positions.length / 3;
	}

	// ── Step 7 · polygonRectangle(给下游 extents / style 用)──
	// 注意:本期 normalizePolygonPoints 已禁止跨 IDL,所以直接取 outer ring 的 lon/lat
	// min/max,与 polygon-extents 内部使用的 polygonRectangle 字节级一致。
	const polygonRectangle = computePolygonRectangle( hierarchy.positions );

	return {
		positions,
		extrudeDirection,
		indices,
		polygonRectangle,
	};
}
