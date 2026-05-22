// ============================================================
// circle/circle-top-bottom.ts — Circle 顶/底面顶点 + extrudeDirection 构造
// 层级:L2(基于 circle-positions 输出与 math/ellipsoid 椭球函数)
// 职责:
//   - 输入 fill 网格(由 circle-positions 产出,扁平 Float64Array)
//   - 输出 segregated layout `[top 半 N, bot 半 N]` 的顶点 positions
//     + extrudeDirection(top 半全 0,bot 半 = -geodeticSurfaceNormal)
//   - top 顶点 = scaleToGeodeticSurface(fillPoint) + maximumHeight × normal
//   - bot 顶点 = scaleToGeodeticSurface(fillPoint) + minimumHeight × normal
// 依赖:Three.js Vector3、math/ellipsoid.ts。
// 被消费:circle-construct-extruded.ts。
// 算法对应:
//   - Cesium EllipseGeometry.js#computeTopBottomAttributes(L46-310,
//     POSITION_ONLY + shadowVolume 路径裁剪)
//   - Cesium EllipseGeometryLibrary.js#raisePositionsToHeight(L59-104,
//     与 computeTopBottomAttributes 共同决定 top/bot 顶点位置)
// ============================================================

import { Vector3 } from 'three';

import {
	geodeticSurfaceNormal,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';

// ============================================================
// 模块级 scratch
//   命名对齐 Cesium scratchCartesian1..4 + scratchNormal。
// ============================================================
const _scratchPosition = new Vector3();    // Cesium scratchCartesian1
const _scratchExtruded = new Vector3();    // Cesium scratchCartesian2(clone)
const _scratchNormal = new Vector3();      // Cesium scratchNormal
const _scratchScaledNormal = new Vector3();// Cesium scratchCartesian3 / scaledNormal

/**
 * Circle 顶/底面顶点构造结果。
 *
 * Layout:`[top 半 N 个顶点, bot 半 N 个顶点]`(segregated),
 * N = fillPositions.length / 3。
 *
 * 与 polygon 的 interleaved `[top_0, bot_0, top_1, bot_1, ...]` 不同 —
 * Cesium ellipse / circle 路径固有 convention,本期严格保留。
 */
export interface CircleTopBottomResult {
	/** ECEF 顶点 Float64,长度 = (fillPositions.length / 3) × 2 × 3 */
	positions: Float64Array;

	/**
	 * 顶点 extrudeDirection,Float32,与 positions 同长。
	 * - 索引 [0, length):top 半,全 0(顶面不需挤出方向)
	 * - 索引 [length, 2·length):bot 半,= -geodeticSurfaceNormal(fillPoint 投影)
	 */
	extrudeDirection: Float32Array;
}

/**
 * 把 circle fill 网格扩展为 segregated 顶/底面顶点 + extrudeDirection。
 *
 * 复刻 Cesium `computeTopBottomAttributes(positions, options, extrude=true)`
 * 的 POSITION_ONLY + shadowVolume 子集(裁掉 st / normal / tangent /
 * bitangent / offsetAttribute 分支)。
 *
 * 算法(每个 fillPoint 8 步):
 *   1. position = (fillPositions[i], fillPositions[i+1], fillPositions[i+2])
 *   2. position = scaleToGeodeticSurface(position)  ← 原地投到椭球面
 *   3. extrudedPosition = clone(position)            ← bot 顶点起点
 *   4. normal = geodeticSurfaceNormal(position)
 *   5. 写入 bot 半 extrudeDirection = -normal(top 半默认 0)
 *   6. scaledNormal = normal × maximumHeight
 *      position = position + scaledNormal             ← top 顶点
 *   7. scaledNormal = normal × minimumHeight          ← 覆盖 scratch
 *      extrudedPosition = extrudedPosition + scaledNormal ← bot 顶点
 *   8. 写入 positions:top 半 [i, i+1, i+2] 与 bot 半 [i+length, ...]
 *
 * 字节级关键(V5):
 *   - scratch 复用顺序与 Cesium 一致(scratchCartesian3 在 top/bot 处分别
 *     被 multiplyByScalar 覆盖一次)
 *   - position 与 extrudedPosition 用各自独立 scratch,确保 top 的
 *     `position += maximumHeight·normal` 不影响 bot 的 extrudedPosition
 *   - Cesium 中 vertexFormat.position = true 时才走 raisePositionsToHeight 分支;
 *     本期固定 POSITION_ONLY → vertexFormat.position 必为 true,直接展开
 *
 * **注意 Cesium 路径细节**:Cesium `computeTopBottomAttributes` 先在主循环
 * 里跑一遍 shadowVolume 的 extrudeNormals 写入(用 `position = fromArray(...)`
 * 后 `geodeticSurfaceNormal(position, normal)`,**未** scaleToGeodeticSurface),
 * 然后**单独**再走 `raisePositionsToHeight`(在 `raisePositions` 里才 scaleToGeodeticSurface)。
 *
 * 但本期合并为一个循环,在 normal 计算前先 scaleToGeodeticSurface — 这与
 * Cesium 的 `raisePositionsToHeight` 子路径一致(L77),且因 fillPositions 来自
 * `computeEllipsePositions` 的 pointOnEllipsoid 输出(已通过 `normalize · mag`
 * 投到椭球面),`scaleToGeodeticSurface` Newton 1 次迭代即收敛,数值上
 * **几乎不变**。两条路径(合并版 vs 分开版)在 V5 字节级测试上**等价**,
 * 因为最后的 normal 都用 surface-projected position 算 — 这与 Cesium
 * computeTopBottomAttributes 调用 raisePositionsToHeight 后的状态一致。
 *
 * **重要**:如果 V5 字节级测试失败,需把这个函数拆成两遍循环 —
 * 第 1 遍写 extrudeDirection(用 raw position 的 normal),第 2 遍走
 * raisePositionsToHeight(scaleToGeodeticSurface 后的 normal)。
 *
 * @param fillPositions 由 computeCircleFillPositions 产出的扁平 ECEF 顶点。
 * @param maximumHeight 顶面高度,米。
 * @param minimumHeight 底面高度,米。
 * @returns positions + extrudeDirection 二元组。
 */
export function computeTopBottomAttributes(
	fillPositions: Float64Array,
	maximumHeight: number,
	minimumHeight: number,
): CircleTopBottomResult {
	const length = fillPositions.length;
	const size = ( length / 3 ) * 2;
	// bottomOffset 在 Cesium L122 为 length;extrude = true 时 bot 半起始 floats 位置。
	const bottomOffset = length;

	const positions = new Float64Array( size * 3 );
	const extrudeDirection = new Float32Array( size * 3 );

	for ( let i = 0; i < length; i += 3 ) {
		const i1 = i + 1;
		const i2 = i + 2;

		// 步骤 1 · 读 fillPosition 到 scratch
		_scratchPosition.set(
			fillPositions[ i ],
			fillPositions[ i1 ],
			fillPositions[ i2 ],
		);

		// 步骤 2 · 投到椭球面(原地修改 _scratchPosition)
		// 等价 Cesium raisePositionsToHeight L78:
		//   ellipsoid.scaleToGeodeticSurface(position, position);
		scaleToGeodeticSurface( _scratchPosition, _scratchPosition );

		// 步骤 3 · clone(等价 Cesium L80:Cartesian3.clone(position, scratchCartesian2))
		_scratchExtruded.copy( _scratchPosition );

		// 步骤 4 · normal = geodeticSurfaceNormal(position)
		// 等价 Cesium L81 / L167-172:在 surface 投影后的 position 上算法向。
		const normal = geodeticSurfaceNormal( _scratchPosition, _scratchNormal );
		if ( normal === undefined ) {
			// fill 顶点在椭球中心(理论不可能,因 fillPositions 来自
			// pointOnEllipsoid 的 `normalize · mag` 输出),保留为防御。
			throw new Error(
				`Circle fill vertex #${ i / 3 } projects to ellipsoid center; cannot compute extrude normal.`,
			);
		}

		// 步骤 5 · shadowVolume bot 半 extrudeDirection = -normal
		// (Cesium L169-173,top 半默认 0,Float32Array 初始化即 0)
		extrudeDirection[ i + bottomOffset ] = -normal.x;
		extrudeDirection[ i1 + bottomOffset ] = -normal.y;
		extrudeDirection[ i2 + bottomOffset ] = -normal.z;

		// 步骤 6 · top 顶点 = position + maximumHeight × normal
		// (Cesium raisePositionsToHeight L82-87)
		_scratchScaledNormal.copy( normal ).multiplyScalar( maximumHeight );
		_scratchPosition.add( _scratchScaledNormal );

		// 步骤 7 · bot 顶点:scaledNormal 覆盖为 normal × minimumHeight,
		//          extrudedPosition += scaledNormal
		// (Cesium L90-91:multiplyByScalar(normal, extrudedHeight, scaledNormal);
		//                add(extrudedPosition, scaledNormal, extrudedPosition))
		_scratchScaledNormal.copy( normal ).multiplyScalar( minimumHeight );
		_scratchExtruded.add( _scratchScaledNormal );

		// 步骤 8 · 写入 positions(top 半 + bot 半)
		// Cesium L93-100:
		//   finalPositions[i + bottomOffset] = extrudedPosition.x/y/z
		//   finalPositions[i]                = position.x/y/z
		positions[ i + bottomOffset ] = _scratchExtruded.x;
		positions[ i1 + bottomOffset ] = _scratchExtruded.y;
		positions[ i2 + bottomOffset ] = _scratchExtruded.z;

		positions[ i ] = _scratchPosition.x;
		positions[ i1 ] = _scratchPosition.y;
		positions[ i2 ] = _scratchPosition.z;
	}

	return { positions, extrudeDirection };
}
