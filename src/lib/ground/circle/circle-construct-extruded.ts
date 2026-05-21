// ============================================================
// circle/circle-construct-extruded.ts — Circle 挤出 prism 整体装配
// 层级:L3(组合 circle-positions / -top-indices / -top-bottom / -wall-construction)
// 职责:
//   1. computeCircleFillPositions → fill 网格 + 外圈点 + numPts
//   2. computeTopBottomAttributes → top/bot 顶点 + extrudeDirection
//   3. computeTopIndices → top 索引;镜像生成 bottom 索引(winding 反转 + 偏移 posLength)
//   4. computeWallAttributes / computeWallIndices → 墙顶点 + 墙索引
//   5. combineInstances 复刻:positions / extrudeDirection 数组拼接,
//      wall 索引加 topBottomVertexCount 偏移
// 依赖:Three.js Vector3、circle-positions、circle-top-indices、
//      circle-top-bottom、circle-wall-construction、
//      rectangle/rectangle-attributes.ts(createIndexTypedArray)。
// 被消费:circle-shadow-volume.ts。
// 算法对应:
//   - Cesium EllipseGeometry.js#computeExtrudedEllipse(L746-839)
//   - Cesium GeometryPipeline.combineInstances 合并逻辑(本期手写复刻)
// ============================================================

import type { Vector3 } from 'three';

import { createIndexTypedArray } from '../rectangle/rectangle-attributes';

import { computeCircleFillPositions } from './circle-positions';
import { computeTopIndices } from './circle-top-indices';
import { computeTopBottomAttributes } from './circle-top-bottom';
import {
	computeWallAttributes,
	computeWallIndices,
} from './circle-wall-construction';

/**
 * Circle 挤出 prism 装配结果。
 *
 * 排列约定(与 polygon/rectangle 阶段同形):
 *   positions = [
 *     <topBottom: top 半 + bot 半 segregated>            (高度 max/min,fill 网格)
 *     <wall:     top 半 + bot 半 segregated>             (高度 max/min,outer 圈)
 *   ]
 *   extrudeDirection 同序,Float32,与 positions 同长。
 *
 *   indices = [
 *     <topBottom 索引>                                    (top + bottom,bottom 加 posLength 偏移)
 *     <wall 索引 + topBottomVertexCount>                  (wall 偏移到合并后 vertex 空间)
 *   ]
 *
 * 默认 demo 场景(centerLon=86.99°, lat=27.99°, radius=1115m, granularity=π/180):
 *   - numPts(if-branch 后)= 12
 *   - fill 顶点 = 2 × 12 × 14 = 336;outer 顶点 = 12 × 4 = 48
 *   - topBottomVertexCount = 672(2 × 336)
 *   - wallVertexCount = 96(2 × 48)
 *   - totalVertexCount = 768
 *   - topBottomIndices 长度 = 2 × (12 × 12 × 13 - 6) = 2 × 1866 = 3732
 *   - wallIndices 长度 = 48 × 6 = 288
 *   - 总索引 = 3732 + 288 = 4020
 */
export interface ExtrudedCircleResult {
	/** ECEF 顶点 Float64,长度 = totalVertexCount × 3 */
	positions: Float64Array;

	/** 顶点 extrudeDirection Float32,与 positions 同长 */
	extrudeDirection: Float32Array;

	/** 三角形索引 Uint16/Uint32(根据顶点数自动选择) */
	indices: Uint16Array | Uint32Array;
}

/**
 * 装配 Circle 挤出 prism。
 *
 * 7 步算法(逐字对齐 Cesium computeExtrudedEllipse L746-839,
 * 跳过 BoundingSphere 因为本期 BufferGeometry 不消费):
 *
 *   Step 1 · computeEllipsePositions(addFill=true, addEdge=true)
 *   Step 2 · computeTopBottomAttributes(fill.positions, options, extrude=true)
 *   Step 3 · topIndices(numPts)                                 ← top 索引模板
 *   Step 4 · 镜像 bottom 索引:winding 反转 (i, i+1, i+2 → i+2, i+1, i)
 *           + 偏移 posLength(= fill.positions.length / 3)
 *           → topBottomIndices = createTypedArray((posLength × 2) / 3, indices)
 *   Step 5 · computeWallAttributes(fill.outerPositions, options)
 *   Step 6 · computeWallIndices(fill.outerPositions)            ← 墙索引模板
 *           → wallIndices = createTypedArray((outer.length × 2) / 3, wallIdx)
 *   Step 7 · combineInstances:positions / extrudeDirection 数组拼接;
 *           wall 索引 += topBottomVertexCount
 *
 * @param centerECEF    已 scaleToGeodeticSurface 的 center(由 caller 保证)。
 * @param radius        圆半径,米。
 * @param granularity   caller 原始 granularity(未 × 8)。
 * @param rotation      stRotation 弧度。
 * @param minimumHeight 底面高度,米。
 * @param maximumHeight 顶面高度,米。
 * @returns positions + extrudeDirection + indices 三元组。
 */
export function constructExtrudedCircleShadowVolume(
	centerECEF: Vector3,
	radius: number,
	granularity: number,
	rotation: number,
	minimumHeight: number,
	maximumHeight: number,
): ExtrudedCircleResult {
	// ============================================================
	// Step 1 · fill 网格 + 外圈点
	// ============================================================
	const fill = computeCircleFillPositions(
		centerECEF, radius, granularity, rotation,
	);
	// fill.positions:Float64Array,长度 = 2 × numPts × (numPts + 2) × 3
	// fill.outerPositions:Float64Array,长度 = numPts × 4 × 3
	// fill.numPts:经 if-branch 兜底后的环数

	// ============================================================
	// Step 2 · top/bot 顶点 + extrudeDirection(segregated)
	// ============================================================
	const topBottom = computeTopBottomAttributes(
		fill.positions, maximumHeight, minimumHeight,
	);
	// topBottom.positions:Float64Array,长度 = fill.positions.length × 2
	// topBottom.extrudeDirection:Float32Array,同长

	const topBottomVertexCount = topBottom.positions.length / 3;
	// posLength 是 Cesium 局部变量名,= fill.positions.length / 3 = fillVertexCount。
	// 用于 Step 4 的 bottom 索引偏移。
	const posLength = fill.positions.length / 3;

	// ============================================================
	// Step 3 · top 索引
	// ============================================================
	const topIndicesArray = computeTopIndices( fill.numPts );
	// topIndicesArray:number[],长度 = 12 × numPts × (numPts + 1) − 6

	// ============================================================
	// Step 4 · 镜像 bottom 索引 + 拼成 topBottomIndices typed array
	//
	// Cesium L791-799 逐字:
	//   const length = indices.length;
	//   indices.length = length * 2;
	//   const posLength = positions.length / 3;
	//   for (let i = 0; i < length; i += 3) {
	//     indices[i + length] = indices[i + 2] + posLength;
	//     indices[i + 1 + length] = indices[i + 1] + posLength;
	//     indices[i + 2 + length] = indices[i] + posLength;
	//   }
	// 注意 winding 反转:bottom 三角形的 (a, b, c) 写成 (c, b, a)。
	// ============================================================
	const topIndicesLength = topIndicesArray.length;
	// 用 JS Array(Cesium 用 indices.length = length * 2 扩展同一个 Array)
	// 然后在 Cesium L801-804 通过 createTypedArray 转 Uint16/32。
	const expandedIndices: number[] = new Array( topIndicesLength * 2 );

	// 前半:原 top 索引
	for ( let i = 0; i < topIndicesLength; i++ ) {
		expandedIndices[ i ] = topIndicesArray[ i ];
	}
	// 后半:winding 反转的 bottom 索引(每元素 + posLength 偏移)
	for ( let i = 0; i < topIndicesLength; i += 3 ) {
		expandedIndices[ i + topIndicesLength ] = topIndicesArray[ i + 2 ] + posLength;
		expandedIndices[ i + 1 + topIndicesLength ] = topIndicesArray[ i + 1 ] + posLength;
		expandedIndices[ i + 2 + topIndicesLength ] = topIndicesArray[ i ] + posLength;
	}

	// Cesium L801-804:createTypedArray((posLength * 2) / 3, indices)
	// 注意 Cesium 第 1 参写成 `(posLength * 2) / 3`,因 posLength = positions.length / 3,
	// 实际数值 = positions.length × 2 / 9,看似 bug —— 但 createTypedArray 第 1 参
	// 只影响 Uint16 / Uint32 阈值判定,数值含义不重要。
	//
	// 本期用更直观的 `topBottomVertexCount`(实际 vertex 数),与 Cesium 的阈值
	// 判定结果一致(因为 default scene 下 topBottomVertexCount = 672 < 65535,
	// 而 Cesium 的 (posLength × 2) / 3 ≈ 224 也 < 65535 → 都选 Uint16)。
	// 在 vertexCount 跨越 65535 阈值的极大圆形场景,本期与 Cesium 可能选不同类型,
	// 但默认场景一致。注:这是本期与 Cesium 的极少数"语义等价但实现不同"点之一。
	const topBottomIndices = createIndexTypedArray(
		topBottomVertexCount,
		expandedIndices.length,
	);
	for ( let i = 0; i < expandedIndices.length; i++ ) {
		topBottomIndices[ i ] = expandedIndices[ i ];
	}

	// ============================================================
	// Step 5 · 墙顶点 + extrudeDirection(segregated)
	// ============================================================
	const wall = computeWallAttributes(
		fill.outerPositions, maximumHeight, minimumHeight,
	);
	const wallVertexCount = wall.positions.length / 3;

	// ============================================================
	// Step 6 · 墙索引(Cesium computeWallIndices)
	// ============================================================
	// computeWallIndices 内部已通过 createIndexTypedArray 选好 Uint16/32 类型。
	const wallIndices = computeWallIndices( fill.outerPositions.length );

	// ============================================================
	// Step 7 · combineInstances 复刻(positions / extrudeDirection / indices 合并)
	//
	// Cesium GeometryPipeline.combineInstances 的语义:
	//   - 对每个 attribute name,把每个 instance 的 values 数组按顺序 concat
	//   - 对 indices,把每个 instance 的 indices 数组按顺序 concat,
	//     但**第 N 个 instance 的索引值加上前 N-1 个 instance 的 vertex count 总和**
	//
	// 这里只有 2 个 instance(topBottom + wall),所以 wall 索引偏移 = topBottomVertexCount。
	// ============================================================
	const totalVertexCount = topBottomVertexCount + wallVertexCount;
	const totalFloatLength = totalVertexCount * 3;

	// 合并 positions
	const allPositions = new Float64Array( totalFloatLength );
	allPositions.set( topBottom.positions, 0 );
	allPositions.set( wall.positions, topBottom.positions.length );

	// 合并 extrudeDirection
	const allExtrudeDirection = new Float32Array( totalFloatLength );
	allExtrudeDirection.set( topBottom.extrudeDirection, 0 );
	allExtrudeDirection.set( wall.extrudeDirection, topBottom.extrudeDirection.length );

	// 合并 indices:topBottom 索引(无偏移)+ wall 索引(+ topBottomVertexCount)
	const totalIndicesLength = topBottomIndices.length + wallIndices.length;
	const allIndices = createIndexTypedArray( totalVertexCount, totalIndicesLength );

	// 前段:topBottomIndices(直接拷贝,无偏移)
	allIndices.set( topBottomIndices, 0 );

	// 后段:wallIndices + topBottomVertexCount
	const wallIndicesLength = wallIndices.length;
	for ( let i = 0; i < wallIndicesLength; i++ ) {
		allIndices[ topBottomIndices.length + i ] = wallIndices[ i ] + topBottomVertexCount;
	}

	return {
		positions: allPositions,
		extrudeDirection: allExtrudeDirection,
		indices: allIndices,
	};
}
