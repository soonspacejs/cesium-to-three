// ============================================================
// circle/circle-wall-construction.ts — Circle 墙顶点 + 墙索引构造
// 层级:L2(基于 math/ellipsoid + rectangle/rectangle-attributes)
// 职责:
//   - computeWallAttributes:输入 outerPositions(numPts × 4 顶点,绕圆一圈),
//     输出 segregated layout `[top 半 N, bot 半 N]` 的墙顶点 positions +
//     extrudeDirection。N = outerPositions.length / 3。
//   - computeWallIndices:产 quad 模板索引 `(UL, LL, UR), (UR, LL, LR)`,
//     `% length` wrap 闭环。
// 依赖:Three.js Vector3、math/ellipsoid.ts、rectangle/rectangle-attributes.ts
//      (createIndexTypedArray)。
// 被消费:circle-construct-extruded.ts。
// 算法对应:
//   - Cesium EllipseGeometry.js#computeWallAttributes(L450-720,POSITION_ONLY +
//     shadowVolume 路径裁剪)
//   - Cesium EllipseGeometry.js#computeWallIndices(L723-741,逐字)
//
// **Layout 差异警示**:circle wall 是 `[UL_0, UL_1, ..., LL_0, LL_1, ...]`
// segregated,**不是** polygon 的 `[UL_0, LL_0, UL_1, LL_1, ...]` interleaved。
// Index 模板因此也不同(UL=i, LL=i+length, UR=(i+1)%length, LR=UR+length)。
// 写错 layout = V5 必败。
// ============================================================

import { Vector3 } from 'three';

import {
	geodeticSurfaceNormal,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';
import { createIndexTypedArray } from '../rectangle/rectangle-attributes';

// ============================================================
// 模块级 scratch(命名对齐 Cesium computeWallAttributes 同位置 scratch)
// ============================================================
const _scratchPosition = new Vector3();    // Cesium scratchCartesian1
const _scratchExtruded = new Vector3();    // Cesium scratchCartesian2(clone)
const _scratchNormal = new Vector3();      // Cesium scratchNormal
const _scratchScaledNormal = new Vector3();// Cesium scratchCartesian4 / scaledNormal

/**
 * Circle 墙顶点构造结果。
 *
 * Segregated layout:`[top 半 N 顶点, bot 半 N 顶点]`,
 * N = outerPositions.length / 3。
 */
export interface CircleWallResult {
	/** ECEF 顶点 Float64,长度 = (outerPositions.length / 3) × 2 × 3 */
	positions: Float64Array;

	/**
	 * 顶点 extrudeDirection,Float32,与 positions 同长。
	 * - 索引 [0, length):top 半,全 0
	 * - 索引 [length, 2·length):bot 半,= -geodeticSurfaceNormal(outer 投影)
	 *
	 * `length` = outerPositions.length(注意是 floats 长度,不是顶点数,
	 * 与 Cesium 写法一致)。
	 */
	extrudeDirection: Float32Array;
}

/**
 * 计算 Circle 墙顶点 + extrudeDirection。
 *
 * 复刻 Cesium `computeWallAttributes(outerPositions, options)` 的
 * POSITION_ONLY + shadowVolume 子集(裁掉 st / normal / tangent / bitangent /
 * offsetAttribute 分支)。
 *
 * 算法逐字对齐 Cesium L515-585 的主循环:
 *   1. position = (outerPositions[i, i+1, i+2])
 *   2. position = scaleToGeodeticSurface(position)       ← 原地
 *   3. extrudedPosition = clone(position)                  ← scratchCartesian2
 *   4. normal = geodeticSurfaceNormal(position)            ← scratchNormal
 *   5. 写 extrudeNormals[i + length] = -normal(top 半默认 0)
 *   6. scaledNormal = normal × maximumHeight                ← scratchCartesian4
 *      position = position + scaledNormal                   ← top 顶点
 *   7. scaledNormal = normal × minimumHeight                ← 覆盖 scratch
 *      extrudedPosition = extrudedPosition + scaledNormal   ← bot 顶点
 *   8. 写 finalPositions:[i] = position(top 半),[i+length] = extruded(bot 半)
 *
 * 与 `circle-top-bottom.ts` 几乎完全相同,唯一差异是输入数组(outerPositions
 * vs fillPositions)与 layout 内 `length` 的含义略不同(此处 length =
 * outerPositions.length floats 数,Cesium L513 同名)。
 *
 * @param outerPositions 由 computeCircleFillPositions 产出的外圈点扁平 ECEF。
 * @param maximumHeight  顶面高度,米。
 * @param minimumHeight  底面高度,米。
 * @returns              positions + extrudeDirection 二元组。
 */
export function computeWallAttributes(
	outerPositions: Float64Array,
	maximumHeight: number,
	minimumHeight: number,
): CircleWallResult {
	const length = outerPositions.length;
	const size = ( length / 3 ) * 2;

	const positions = new Float64Array( size * 3 );
	const extrudeDirection = new Float32Array( size * 3 );

	for ( let i = 0; i < length; i += 3 ) {
		const i1 = i + 1;
		const i2 = i + 2;

		// 步骤 1 · 读 outerPosition 到 scratch
		_scratchPosition.set(
			outerPositions[ i ],
			outerPositions[ i1 ],
			outerPositions[ i2 ],
		);

		// 步骤 2 · 投到椭球面
		// Cesium L550:position = ellipsoid.scaleToGeodeticSurface(position, position)
		scaleToGeodeticSurface( _scratchPosition, _scratchPosition );

		// 步骤 3 · clone(Cesium L551)
		_scratchExtruded.copy( _scratchPosition );

		// 步骤 4 · normal
		// Cesium L552:normal = ellipsoid.geodeticSurfaceNormal(position, normal)
		const normal = geodeticSurfaceNormal( _scratchPosition, _scratchNormal );
		if ( normal === undefined ) {
			throw new Error(
				`Circle outer vertex #${ i / 3 } projects to ellipsoid center; cannot compute extrude normal.`,
			);
		}

		// 步骤 5 · shadowVolume:bot 半 extrudeDirection = -normal(top 半默认 0)
		// Cesium L554-558(注意 length 是 floats 数,所以 `i + length` 跳到 bot 半同一 float 位置)
		extrudeDirection[ i + length ] = -normal.x;
		extrudeDirection[ i1 + length ] = -normal.y;
		extrudeDirection[ i2 + length ] = -normal.z;

		// 步骤 6 · top 顶点 = position + maximumHeight × normal
		// Cesium L560-565
		_scratchScaledNormal.copy( normal ).multiplyScalar( maximumHeight );
		_scratchPosition.add( _scratchScaledNormal );

		// 步骤 7 · bot 顶点 = extrudedPosition + minimumHeight × normal
		// Cesium L566-575(scaledNormal 复用 scratch,内容被覆盖)
		_scratchScaledNormal.copy( normal ).multiplyScalar( minimumHeight );
		_scratchExtruded.add( _scratchScaledNormal );

		// 步骤 8 · 写入 positions(top 半 + bot 半 segregated)
		// Cesium L578-584
		positions[ i + length ] = _scratchExtruded.x;
		positions[ i1 + length ] = _scratchExtruded.y;
		positions[ i2 + length ] = _scratchExtruded.z;

		positions[ i ] = _scratchPosition.x;
		positions[ i1 ] = _scratchPosition.y;
		positions[ i2 ] = _scratchPosition.z;
	}

	return { positions, extrudeDirection };
}

/**
 * 计算 Circle 墙 quad 索引。
 *
 * 复刻 Cesium `computeWallIndices`(L723-741)逐字。
 *
 * 算法:
 *   length = outerPositionsFloatLength / 3                ← 位置数 N
 *   for i in [0, length):
 *     UL = i              ← 当前位置 top
 *     LL = i + length     ← 当前位置 bot
 *     UR = (i + 1) % length ← 下一位置 top(wrap 闭环)
 *     LR = UR + length     ← 下一位置 bot
 *     写三角形 (UL, LL, UR), (UR, LL, LR)
 *
 * 索引数组长度 = N × 6(每位置 1 quad = 2 三角形 × 3 索引)。
 *
 * 字节级关键:Cesium `createTypedArray(length, length * 6)` 第 1 参传的是
 * **位置数 N**(不是 wall 总顶点数 2N)— 这是 Cesium 简化(实际索引值
 * 最大 2N-1,严格应传 2N 才正确选 Uint16/Uint32 阈值)。但 N × 6 < 65535
 * 时 N 一般也 ≤ 32767 < 65535/2,Uint16 仍够 — 实际无影响。
 * 本期为字节级一致,**逐字复刻 Cesium 行为**(传 length 而非 length × 2)。
 *
 * @param outerPositionsFloatLength outerPositions 数组的 floats 数(= N × 3)。
 * @returns 索引数组(Uint16Array 或 Uint32Array,长度 N × 6)。
 */
export function computeWallIndices(
	outerPositionsFloatLength: number,
): Uint16Array | Uint32Array {
	const length = outerPositionsFloatLength / 3;
	// Cesium L725:`IndexDatatype.createTypedArray(length, length * 6)`
	// 注意第 1 参是 length(位置数)而非 length × 2(wall 总顶点数)
	const indices = createIndexTypedArray( length, length * 6 );

	let index = 0;
	for ( let i = 0; i < length; i++ ) {
		const UL = i;
		const LL = i + length;
		const UR = ( UL + 1 ) % length;
		const LR = UR + length;

		// 三角形 1:(UL, LL, UR)
		indices[ index++ ] = UL;
		indices[ index++ ] = LL;
		indices[ index++ ] = UR;

		// 三角形 2:(UR, LL, LR)
		indices[ index++ ] = UR;
		indices[ index++ ] = LL;
		indices[ index++ ] = LR;
	}

	return indices;
}
