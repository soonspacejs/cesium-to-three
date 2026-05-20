// ============================================================
// rectangle/rectangle-construct-extruded.ts — 矩形挤出 prism 构造
// 层级:L4(基于 rectangle-construct-cap + math/ellipsoid 的最终组合)
// 职责:把矩形顶面 cap 升级为完整的 shadow volume prism:
//      - 顶面顶点(从 cap 复制 → scaleToGeodeticHeight 升到 maximumHeight)
//      - 底面顶点(cap 原地降到 minimumHeight,索引 winding 反向)
//      - 四条墙顶点(West→South→East→North 顺时针,每位置 top+bottom 一对)
//      - extrudeDirection 属性(top 半 = 0,bottom 半 = -normal)
//      - 合并索引(顶 + 底 + 墙,墙索引带顶点偏移)
//
//      Cesium 1:1 复刻,包括看似冗余的 scaleToSurface=true(bottom 层 Newton 兜底)
//      与 EPSILON10 角点重复检测。任何"看起来用不到"的分支也必须保留,以保证
//      与 Cesium 字节级一致(V5 验收依赖)。
// 依赖:Three.js Vector3、rectangle-construct-cap.ts、rectangle-attributes.ts、
//      math/ellipsoid.ts(scaleToGeodeticHeight)、math/constants.ts(EPSILON10)、
//      math/vec3-helpers.ts(vec3EqualsEpsilon)
// 被消费:rectangle-shadow-volume.ts(公共入口)
// 算法对应:Cesium Source/Core/RectangleGeometry.js#constructExtrudedRectangle(L457-908)
//          只保留 shadowVolume=true, vertexFormat=POSITION_ONLY 路径
// ============================================================

import { Vector3 } from 'three';

import { EPSILON10 } from '../math/constants';
import { scaleToGeodeticHeight } from '../math/ellipsoid';
import { vec3EqualsEpsilon } from '../math/vec3-helpers';
import {
	createIndexTypedArray,
} from './rectangle-attributes';
import {
	constructRectangleCap,
} from './rectangle-construct-cap';
import type { RectangleRadians } from './rectangle-radians';

/**
 * `constructExtrudedRectangleShadowVolume` 的完整输出。
 *
 * 三个数组互相一致:
 *   - positions / extrudeDirection 同长度,顶点对应。
 *   - indices 已合并 top + bottom + wall,墙索引已加上 topBottomVertexCount 偏移。
 *   - indices 末尾可能被 subarray 截断(因为墙角点重复检测会跳过 4 个 quad)。
 */
export interface RectangleShadowVolumeResult {
	/** 全部顶点 ECEF 位置(top + bottom + walls),Float64,长度 = 3 × totalVertexCount */
	positions: Float64Array;

	/** 每顶点 extrudeDirection(top 半 = 0,bottom 半 = -normal),Float32,长度同 positions */
	extrudeDirection: Float32Array;

	/** 合并索引(top + bottom + wall),墙索引已偏移 topBottomVertexCount */
	indices: Uint16Array | Uint32Array;
}

// 模块级 scratch:墙索引循环中角点重复检测使用
const _wallP1 = new Vector3();
const _wallP2 = new Vector3();

/**
 * 构造矩形挤出 shadow volume prism。
 *
 * 完整 8 步算法(见文件头职责说明)。所有循环边界、winding 反向、
 * EPSILON10 容差判定都与 Cesium 字节级一致。
 *
 * Cesium 对应:RectangleGeometry.js:457-908
 *
 * @param rect          矩形(弧度)。
 * @param granularity   网格精度(弧度)。
 * @param minimumHeight shadow volume 底面高度(米;可负)。
 * @param maximumHeight shadow volume 顶面高度(米;> minimumHeight)。
 * @param radiiSquared  椭球半轴平方(供 cap grid 采样用)。
 * @returns             ECEF positions / extrudeDirection / 合并索引。
 */
export function constructExtrudedRectangleShadowVolume(
	rect: RectangleRadians,
	granularity: number,
	minimumHeight: number,
	maximumHeight: number,
	radiiSquared: Vector3,
): RectangleShadowVolumeResult {
	// ── 步骤 1 · 调用 cap 构造 ──
	const cap = constructRectangleCap( rect, granularity, radiiSquared );
	const capWidth = cap.width;
	const capHeight = cap.height;
	const northCap = cap.northCap;
	const southCap = cap.southCap;

	const length = cap.positions.length;
	const newLength = length * 2;
	const posLength = length / 3; // = cap 顶点数(size)

	// ── 步骤 2 · top/bottom 位置数组 ──
	// 2.1 · 复制 cap.positions 给 topPositions(避免下游修改 cap.positions 前覆盖)
	const topPositions = new Float64Array( cap.positions );

	// 2.2 · top 层:scaleToSurface=false(顶点已在表面,直接加 maxHeight 偏移)
	scaleToGeodeticHeight( topPositions, maximumHeight, false );

	// 2.3 · 分配 positions(前半 = top,后半 = bottom)
	const positions = new Float64Array( newLength );
	positions.set( topPositions, 0 );

	// 2.4 · bottom 层:scaleToSurface=true(Newton 兜底,虽然此时 cap.positions 仍是原始 surface,Newton 是 no-op)
	scaleToGeodeticHeight( cap.positions, minimumHeight, true );
	const bottomPositions = cap.positions; // 引用别名,更清晰

	// 2.5 · positions 后半 = bottom
	positions.set( bottomPositions, length );

	// ── 步骤 3 · extrudeDirection 属性 ──
	// 3.1 · 分配,全 0(top 层 extrudeDirection 不挤出)
	const extrudeNormals = new Float32Array( newLength );

	// 3.2 · 取 cap.normals 引用(此时仍是顶点正法向,未取反)
	const topNormals = cap.normals;

	// 3.3 · 原地取反(变成 -normal,指向地心)
	for ( let i = 0; i < length; i++ ) {
		topNormals[ i ] = -topNormals[ i ];
	}

	// 3.4 · 写入 extrudeNormals 后半 = -normal(bottom 层挤出方向)
	extrudeNormals.set( topNormals, length );

	// ── 步骤 4 · top/bottom 索引拼接 ──
	const topIndices = cap.indices;
	const indicesLength = topIndices.length;

	// 4.1 · 分配新数组,容纳顶 + 底两套
	const newIndices = createIndexTypedArray( newLength / 3, indicesLength * 2 );

	// 4.2 · 前半 = top 索引(直接复制)
	newIndices.set( topIndices, 0 );

	// 4.3 · 后半 = bottom 索引(交换三角形第 0/2 顶点反转 winding + 顶点 ID 加 posLength)
	// 几何意义:外表面所有三角形从外面看都是 CCW,顶面 CCW from above 等价于
	// 底面 CCW from below = CW from above,故反向。
	for ( let i = 0; i < indicesLength; i += 3 ) {
		newIndices[ i + indicesLength ] = topIndices[ i + 2 ] + posLength;
		newIndices[ i + 1 + indicesLength ] = topIndices[ i + 1 ] + posLength;
		newIndices[ i + 2 + indicesLength ] = topIndices[ i + 0 ] + posLength;
	}

	// ── 步骤 5 · 墙周长计算 ──
	// 公式来自 Cesium RectangleGeometry.js:599-623。
	// rowHeight 是主网格的有效行数(扣除被 cap 取代的极行)。
	let rowHeight = capHeight;
	let widthMultiplier = 2;
	let perimeterPositions = 0;
	let corners = 4;
	let duplicateCorners = 4;

	if ( northCap ) {
		widthMultiplier -= 1;
		rowHeight -= 1;
		perimeterPositions += 1;
		corners -= 2;
		duplicateCorners -= 1;
	}

	if ( southCap ) {
		widthMultiplier -= 1;
		rowHeight -= 1;
		perimeterPositions += 1;
		corners -= 2;
		duplicateCorners -= 1;
	}

	perimeterPositions += widthMultiplier * capWidth + 2 * rowHeight - corners;
	const wallCount = ( perimeterPositions + duplicateCorners ) * 2;

	// ── 步骤 6 · 墙顶点采样(4 条边:西 → 南 → 东 → 北 顺时针)──
	const wallPositions = new Float64Array( wallCount * 3 );
	const wallExtrudeNormals = new Float32Array( wallCount * 3 );

	let posIndex = 0;
	let extrudeNormalIndex = 0;
	const area = capWidth * rowHeight; // 主网格顶点数(扣除 cap 极行)

	// 6.1 · 西边 WEST(沿经线 NW → SW,i = 0, width, ..., (rowHeight-1)×width)
	for ( let i = 0; i < area; i += capWidth ) {
		const threeI = i * 3;

		// 写入 top, bottom 一对
		wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
		wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
		wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
		wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
		wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
		wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
		posIndex += 6;

		// extrudeDirection:top 半留 0,bottom 半写 -normal(cap.normals 已被取反)
		extrudeNormalIndex += 3;
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
	}

	// 6.2 · 南边 SOUTH(SW → SE)
	if ( ! southCap ) {
		// 标准路径:沿底行采样
		for ( let i = area - capWidth; i < area; i++ ) {
			const threeI = i * 3;
			wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
			wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
			wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
			wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
			wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
			wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
			posIndex += 6;

			extrudeNormalIndex += 3;
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
		}
	} else {
		// southCap 分支:南极单点写两次(duplicate corner)
		// cap 单点在 cap 顶点数组的 `area` 索引(若仅 southCap),或 `area + 1`(若同时 northCap;不可能但保留)
		const southIndex = northCap ? area + 1 : area;
		const threeI = southIndex * 3;
		for ( let i = 0; i < 2; i++ ) {
			wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
			wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
			wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
			wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
			wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
			wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
			posIndex += 6;

			extrudeNormalIndex += 3;
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
		}
	}

	// 6.3 · 东边 EAST(SE → NE,沿经线升,i = area-1, area-1-width, ..., width-1)
	for ( let i = area - 1; i > 0; i -= capWidth ) {
		const threeI = i * 3;
		wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
		wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
		wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
		wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
		wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
		wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
		posIndex += 6;

		extrudeNormalIndex += 3;
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
		wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
	}

	// 6.4 · 北边 NORTH(NE → NW)
	if ( ! northCap ) {
		// 标准路径:沿顶行倒序采样(i = width-1, width-2, ..., 0)
		for ( let i = capWidth - 1; i >= 0; i-- ) {
			const threeI = i * 3;
			wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
			wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
			wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
			wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
			wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
			wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
			posIndex += 6;

			extrudeNormalIndex += 3;
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
		}
	} else {
		// northCap 分支:北极单点写两次
		const northIndex = area;
		const threeI = northIndex * 3;
		for ( let i = 0; i < 2; i++ ) {
			wallPositions[ posIndex + 0 ] = topPositions[ threeI + 0 ];
			wallPositions[ posIndex + 1 ] = topPositions[ threeI + 1 ];
			wallPositions[ posIndex + 2 ] = topPositions[ threeI + 2 ];
			wallPositions[ posIndex + 3 ] = bottomPositions[ threeI + 0 ];
			wallPositions[ posIndex + 4 ] = bottomPositions[ threeI + 1 ];
			wallPositions[ posIndex + 5 ] = bottomPositions[ threeI + 2 ];
			posIndex += 6;

			extrudeNormalIndex += 3;
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 0 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 1 ];
			wallExtrudeNormals[ extrudeNormalIndex++ ] = topNormals[ threeI + 2 ];
		}
	}

	// invariant:posIndex / extrudeNormalIndex 必须等于 wallCount × 3
	if ( posIndex !== wallCount * 3 ) {
		throw new Error(
			`Wall position write index mismatch: posIndex=${ posIndex }, expected=${ wallCount * 3 }`,
		);
	}
	if ( extrudeNormalIndex !== wallCount * 3 ) {
		throw new Error(
			`Wall extrudeNormal write index mismatch: extrudeNormalIndex=${ extrudeNormalIndex }, expected=${ wallCount * 3 }`,
		);
	}

	// ── 步骤 7 · 墙索引构造 ──
	// 7.1 · 分配(上界 = perimeterPositions × 6;实际可能少,因角点 quad 被跳过)
	const wallIndicesUpperBound = perimeterPositions * 6;
	let wallIndices = createIndexTypedArray( wallCount, wallIndicesUpperBound );
	const wallVertexCount = wallPositions.length / 3;
	let index = 0;

	// 7.2 · 主循环:每两个 wall 位置(top+bottom 一对)组成一个 quad
	// i 步进 2(因为每个 wall 位置占 2 个顶点)。
	for ( let i = 0; i < wallVertexCount - 1; i += 2 ) {
		const upperLeft = i;
		const upperRight = ( upperLeft + 2 ) % wallVertexCount;

		// 7.3 · 角点重复检查:在 EPSILON10 容差内当前与下一位置重合则跳过此 quad
		// ECEF 量级 1e7 米下,EPSILON10 等价 ≤ 1e-3 米精度,SW/SE/NE/NW 角点
		// 两次写入来自同一 topPositions 读取,数值严格相等 → 命中 skip。
		_wallP1.set(
			wallPositions[ upperLeft * 3 + 0 ],
			wallPositions[ upperLeft * 3 + 1 ],
			wallPositions[ upperLeft * 3 + 2 ],
		);
		_wallP2.set(
			wallPositions[ upperRight * 3 + 0 ],
			wallPositions[ upperRight * 3 + 1 ],
			wallPositions[ upperRight * 3 + 2 ],
		);
		if ( vec3EqualsEpsilon( _wallP1, _wallP2, EPSILON10 ) ) {
			continue;
		}

		const lowerLeft = ( upperLeft + 1 ) % wallVertexCount;
		const lowerRight = ( lowerLeft + 2 ) % wallVertexCount;

		// 7.4 · 两个 CCW 三角形(从墙外看)
		wallIndices[ index++ ] = upperLeft;
		wallIndices[ index++ ] = lowerLeft;
		wallIndices[ index++ ] = upperRight;
		wallIndices[ index++ ] = upperRight;
		wallIndices[ index++ ] = lowerLeft;
		wallIndices[ index++ ] = lowerRight;
	}

	// invariant:写入数不超上界
	if ( index > wallIndicesUpperBound ) {
		throw new Error(
			`Wall indices exceeded allocated size: index=${ index } > ${ wallIndicesUpperBound }`,
		);
	}

	// 7.5 · 截断到实际写入长度
	// 关键:若不截断,数组末尾的零会污染 stencil 计数(指向 wall 顶点 0 的退化三角形)
	wallIndices = wallIndices.subarray( 0, index );

	// ── 步骤 8 · 合并 top/bottom + 墙 ──
	const topBottomVertexCount = positions.length / 3;
	const finalWallVertexCount = wallPositions.length / 3;
	const totalVertexCount = topBottomVertexCount + finalWallVertexCount;
	const totalFloats = positions.length + wallPositions.length;

	// 8.1 · 合并位置(top + bottom + wall)
	const allPositions = new Float64Array( totalFloats );
	allPositions.set( positions, 0 );
	allPositions.set( wallPositions, positions.length );

	// 8.2 · 合并 extrudeDirection
	const allExtrudeDirection = new Float32Array( totalFloats );
	allExtrudeDirection.set( extrudeNormals, 0 );
	allExtrudeDirection.set( wallExtrudeNormals, extrudeNormals.length );

	// 8.3 · 合并索引(墙索引需要加 topBottomVertexCount 偏移)
	const topBottomIndexCount = newIndices.length;
	const wallIndexCount = wallIndices.length;
	const totalIndexCount = topBottomIndexCount + wallIndexCount;

	const allIndices = createIndexTypedArray( totalVertexCount, totalIndexCount );
	allIndices.set( newIndices, 0 );
	for ( let j = 0; j < wallIndexCount; j++ ) {
		allIndices[ topBottomIndexCount + j ] = wallIndices[ j ] + topBottomVertexCount;
	}

	return {
		positions: allPositions,
		extrudeDirection: allExtrudeDirection,
		indices: allIndices,
	};
}
