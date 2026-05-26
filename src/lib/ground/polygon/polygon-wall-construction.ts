// ============================================================
// polygon/polygon-wall-construction.ts — Polygon 挤出墙(side wall)构造
// 层级:L3(基于 polygon-subdivide-line + math/ellipsoid + rectangle-attributes)
// 职责:对单个 polygon ring(外环或一个 hole),沿每条边按 chord 距离细分,
//      生成顶面 / 底面顶点对 + 顶/底连接 quad(每个 quad 6 个索引)。
//      Wall 数据布局严格匹配 Cesium computeWallGeometry(L1050-1300):
//        - 每条 edge 写 (subdivideLineCount + 1) 个顶点(N 个 chord 起点 + 1 个 p2 端点)
//        - 顶点存两份:top 半 [0..perSideFloatLength) + bottom 半 [perSideFloatLength..total)
//        - 初始 top == bottom = chord 直线坐标;scaleToHeightExtruded 后才分开
//      索引采用 corner-skipping:相邻顶点位置相等(epsilon10)→ 跳过对应 quad,
//      自动剔除两条 edge 衔接处的"零宽" quad,同时正确处理 wrap-around。
// 依赖:Three.js Vector3,math/constants.ts(WGS84_RADII_X / EPSILON10),
//      math/ellipsoid.ts(scaleToGeodeticSurface / geodeticSurfaceNormal),
//      polygon-subdivide-line.ts(chordLength / subdivideLineCount / subdivideLine),
//      rectangle/rectangle-attributes.ts(createIndexTypedArray)
// 被消费:polygon-construct-extruded.ts
// 算法对应:Cesium Source/Core/PolygonGeometryLibrary.js#computeWallGeometry(L1050-1300,
//          GEODESIC + perPositionHeight=false 路径)
//          + Source/Core/PolygonGeometryLibrary.js#scaleToGeodeticHeightExtruded(L379-423)
//          + Source/Core/PolygonGeometry.js#computeAttributes(L62-423,shadowVolume + wall 分支
//            的 extrudeDirection = -geodeticSurfaceNormal(top_half_position) 计算)
// ============================================================

import { Vector3 } from 'three';

import { EPSILON10, WGS84_RADII_X } from '../math/constants';
import { geodeticSurfaceNormal, scaleToGeodeticSurface } from '../math/ellipsoid';
import { createIndexTypedArray } from '../rectangle/rectangle-attributes';
import {
	chordLength,
	subdivideLine,
	subdivideLineCount,
} from './polygon-subdivide-line';

/**
 * Polygon wall(单个 ring 的挤出墙)构造结果。
 *
 * 布局(匹配 Cesium computeWallGeometry):
 *   positions = [
 *     <top  vertex 0..perSide-1>,   // 高度 = maximumHeight,扁平 (x, y, z, x, y, z, ...)
 *     <bottom vertex 0..perSide-1>, // 高度 = minimumHeight
 *   ]
 *   每个 vertex 占 3 个 Float64;perSide = 每条 edge 的 (subdivideLineCount + 1) 之和。
 *
 *   extrudeDirection 同样长度:
 *     top 半 = (0, 0, 0)
 *     bot 半 = -geodeticSurfaceNormal(top 半对应位置)
 *
 *   indices 引用本 wall 局部顶点 ID(0 到 perSide × 2 - 1);
 *   合并到 prism 时由 caller 加偏移。
 */
export interface PolygonWallResult {
	/** Float64 ECEF,长度 = 6 × perSideVertexCount */
	positions: Float64Array;

	/** Float32 extrudeDirection,长度同 positions */
	extrudeDirection: Float32Array;

	/** Uint16/32 索引,长度 = 6 × (perSideVertexCount - ringLength) */
	indices: Uint16Array | Uint32Array;
}

// ── 模块级 scratch:wall 构造中反复使用的 Vector3 ──
// JS 单线程 + 同步函数体内复用,安全。
const _wallChordPositionScratch = new Vector3();
const _wallSurfaceScratch = new Vector3();
const _wallNormalScratch = new Vector3();
const _wallExtrudeNormalScratch = new Vector3();
const _wallTopPosScratch = new Vector3();

/**
 * 构造单个 polygon ring 的挤出墙。
 *
 * 算法 5 步,顺序与 Cesium computeWallGeometry + scaleToGeodeticHeightExtruded +
 * computeAttributes(shadowVolume + wall 分支)一致:
 *
 *   步骤 1 · 计算 perSideVertexCount
 *     遍历 length 条 edge(p1=ring[i], p2=ring[(i+1) % length]),
 *     累加 subdivideLineCount(p1, p2, minDistance) + 1(每条 edge 产 N+1 顶点),
 *     得到每一面(top 或 bot)的总顶点数。
 *
 *   步骤 2 · 写 chord 顶点到双面 buffer
 *     对每条 edge:
 *       a. subdivideLine(p1, p2) → 一维 [p1.x, p1.y, p1.z, mid1.x, ..., mid_{N-1}.z]
 *          (注意:输出不含 p2 端点)
 *       b. 把 subdivideLine 结果同时写入 top 半与 bottom 半
 *       c. 显式写 p2.{x, y, z} 到 top 与 bot(edge 的终点;同时也是下一条 edge 的起点
 *          —— 但下一条 edge 的 subdivideLine 输出 p2(next.p1)再次,所以 wall 上
 *          相邻 edge 之间确实有"重复顶点对",由索引步骤的 corner-skipping 跳过)
 *
 *   步骤 3 · 生成索引(使用 chord 位置,top == bottom,所以位置相等判定可识别 corner)
 *     for i in [0, perSideVertexCount):
 *       UL = i,UR = i + 1
 *       LL = UL + perSideVertexCount,LR = UR + perSideVertexCount
 *       p_UL = positions[UL × 3..],p_UR = positions[UR × 3..]
 *       if equalsEpsilon(p_UL, p_UR, EPSILON10): continue  // corner / wrap-around 自动跳过
 *       否则写 2 个三角形:(UL, LL, UR) + (UR, LL, LR)
 *
 *   步骤 4 · scaleToGeodeticHeightExtruded:把 chord 位置投到指定高度
 *     for i in [0, perSideFloatLength) step 3:
 *       chord = positions[i..i+3]            (原始 chord 位置,top 半,bot 半相同)
 *       surface = scaleToGeodeticSurface(chord)
 *       normal  = geodeticSurfaceNormal(chord)
 *       positions[i.. (top)] = surface + maxHeight * normal
 *       positions[i + perSideFloatLength.. (bot)] = surface + minHeight * normal
 *     注:Cesium 用 chord 位置(非 surface)算 normal;细微差异但与 Cesium 一致。
 *
 *   步骤 5 · extrudeDirection
 *     top 半 = (0, 0, 0)(Float32Array 默认 0)
 *     bot 半 = -geodeticSurfaceNormal(top 半对应位置)
 *     Cesium 在 computeAttributes 的 shadowVolume + wall 分支里重新读取 top 半
 *     位置(at maxHeight,已被 step 4 修改)算 normal,与本步骤一致。
 *
 * @param ringPositions 单个 ring 的椭球面 ECEF 顶点(已经过 winding 校正)。
 * @param granularity   角分辨率,弧度(控制 minDistance 阈值)。
 * @param minimumHeight 底面高度,米(典型 -55000)。
 * @param maximumHeight 顶面高度,米(典型 +55000)。
 * @returns             PolygonWallResult。
 */
export function constructPolygonWall(
	ringPositions: readonly Vector3[],
	granularity: number,
	minimumHeight: number,
	maximumHeight: number,
): PolygonWallResult {
	const length = ringPositions.length;
	if ( length < 3 ) {
		throw new Error(
			`constructPolygonWall: ring must have ≥ 3 vertices, got ${ length }.`,
		);
	}

	const minDistance = chordLength( granularity, WGS84_RADII_X );

	// ── 步骤 1 · 计算 perSideVertexCount ──
	// Cesium L1081-1099 GEODESIC 分支:
	//   numVertices += subdivideLineCount(p1, p2, minDistance);   // 累加每条 edge
	// topEdgeLength = (numVertices + length) * 3                  // floats per side
	// 即 perSideVertexCount = numVertices + length。
	let numVertices = 0;
	for ( let i = 0; i < length; i++ ) {
		const p1 = ringPositions[ i ];
		const p2 = ringPositions[ ( i + 1 ) % length ];
		numVertices += subdivideLineCount( p1, p2, minDistance );
	}
	const perSideVertexCount = numVertices + length;
	const perSideFloatLength = perSideVertexCount * 3;
	const totalFloatLength = perSideFloatLength * 2;

	// ── 步骤 2 · 分配 buffer 并写 chord 位置到 top + bot 两个半 ──
	const positions = new Float64Array( totalFloatLength );

	// subdivideLine 输出复用同一个临时 number[],避免每条 edge 都新建。
	const subdivideTemp: number[] = [];
	let writeIndex = 0;

	for ( let i = 0; i < length; i++ ) {
		const p1 = ringPositions[ i ];
		const p2 = ringPositions[ ( i + 1 ) % length ];

		// 2a · subdivideLine → [p1.x, p1.y, p1.z, mid1.x, mid1.y, mid1.z, ...]
		// 输出长度 = subdivideLineCount(p1, p2) × 3,不含 p2。
		subdivideLine( p1, p2, minDistance, subdivideTemp );

		// 2b · 把 subdivideLine 输出同时写入 top 半与 bot 半
		const tempLen = subdivideTemp.length;
		for ( let j = 0; j < tempLen; j++ ) {
			positions[ writeIndex ] = subdivideTemp[ j ];
			positions[ writeIndex + perSideFloatLength ] = subdivideTemp[ j ];
			writeIndex++;
		}

		// 2c · 显式写 p2 端点(top 与 bot)
		positions[ writeIndex ] = p2.x;
		positions[ writeIndex + perSideFloatLength ] = p2.x;
		writeIndex++;
		positions[ writeIndex ] = p2.y;
		positions[ writeIndex + perSideFloatLength ] = p2.y;
		writeIndex++;
		positions[ writeIndex ] = p2.z;
		positions[ writeIndex + perSideFloatLength ] = p2.z;
		writeIndex++;
	}

	// ── 步骤 3 · 生成索引(用 chord 位置;corner-skipping 处理重复顶点对)──
	// indices count 公式(Cesium L1242-1245):
	//   length(edgePositions) = perSideFloatLength * 2
	//   indices count = length - positions.length * 6 = perSideFloatLength * 2 - length * 6
	//                 = 6 × (perSideVertexCount - length) = 6 × numVertices
	// 即每条 edge 产 subdivideLineCount(p1,p2) 个 wall quad,共 numVertices 个 quad。
	const indicesCount = 6 * numVertices;
	const indices = createIndexTypedArray(
		perSideVertexCount * 2,   // 顶点总数(top + bot),决定 Uint16 vs Uint32
		indicesCount,
	);
	let edgeIndex = 0;

	for ( let i = 0; i < perSideVertexCount; i++ ) {
		const UL = i;
		const UR = UL + 1;
		const LL = UL + perSideVertexCount;
		const LR = UR + perSideVertexCount;

		// 读 UL 与 UR 的位置(top 半;此刻仍是 chord 坐标)
		// 注意:i = perSideVertexCount - 1 时 UR = perSideVertexCount,
		// 这是 bot 半的第一个 vertex(p_bot[0] = chord_0 = p_top[0])。
		// 它与 p_top[last] 位置上是否相等,取决于 wall 是否闭环。
		// 对正常 polygon,p_top[last] = p_top[0](因为 ring 闭合),所以相等 → 跳过此 quad。
		const ulX = positions[ UL * 3 ];
		const ulY = positions[ UL * 3 + 1 ];
		const ulZ = positions[ UL * 3 + 2 ];
		const urX = positions[ UR * 3 ];
		const urY = positions[ UR * 3 + 1 ];
		const urZ = positions[ UR * 3 + 2 ];

		// 等价 Cesium `Cartesian3.equalsEpsilon(p1, p2, EPSILON10, EPSILON10)`。
		// 注:Cesium 第 4 参是 relativeEpsilon,本应用上等价 absolute(因为相对差只在
		// 大数尺度下与 absolute 差异,而 chord 位置量级 1e7,EPSILON10 absolute 几乎等价)。
		const isCorner =
			Math.abs( ulX - urX ) <= EPSILON10 &&
			Math.abs( ulY - urY ) <= EPSILON10 &&
			Math.abs( ulZ - urZ ) <= EPSILON10;
		if ( isCorner ) {
			continue;
		}

		// 写 quad 索引:三角形 1 (UL, LL, UR),三角形 2 (UR, LL, LR)
		// 顺序逐字匹配 Cesium L1269-1274,从墙外看 CCW(stencil shadow volume 渲染依赖此 winding)
		indices[ edgeIndex++ ] = UL;
		indices[ edgeIndex++ ] = LL;
		indices[ edgeIndex++ ] = UR;
		indices[ edgeIndex++ ] = UR;
		indices[ edgeIndex++ ] = LL;
		indices[ edgeIndex++ ] = LR;
	}

	// ── 步骤 4 · scaleToGeodeticHeightExtruded:chord → top(maxHeight)+ bot(minHeight)──
	// 严格匹配 Cesium PolygonGeometryLibrary.scaleToGeodeticHeightExtruded(L379-423):
	//   n1 = geodeticSurfaceNormal(p)         (p = top 半 chord 位置)
	//   p2 = scaleToGeodeticSurface(p)
	//   bot = p2 + minHeight * n1
	//   top = p2 + maxHeight * n1
	// 注意:法向用的是 p(chord 位置)的法向,**非** surface 点的法向 — 两者有细微差别。
	for ( let i = 0; i < perSideFloatLength; i += 3 ) {
		_wallChordPositionScratch.set(
			positions[ i ],
			positions[ i + 1 ],
			positions[ i + 2 ],
		);

		// n1 = geodeticSurfaceNormal(chord_position)
		const normalResult = geodeticSurfaceNormal(
			_wallChordPositionScratch,
			_wallNormalScratch,
		);
		if ( normalResult === undefined ) {
			throw new Error(
				`constructPolygonWall: vertex at index ${ i / 3 } is at ellipsoid center, cannot compute surface normal.`,
			);
		}

		// surface = scaleToGeodeticSurface(chord_position)
		const surfaceResult = scaleToGeodeticSurface(
			_wallChordPositionScratch,
			_wallSurfaceScratch,
		);
		if ( surfaceResult === undefined ) {
			throw new Error(
				`constructPolygonWall: vertex at index ${ i / 3 } cannot project to ellipsoid surface.`,
			);
		}

		// bot = surface + minHeight * normal
		positions[ i + perSideFloatLength ]     = _wallSurfaceScratch.x + _wallNormalScratch.x * minimumHeight;
		positions[ i + 1 + perSideFloatLength ] = _wallSurfaceScratch.y + _wallNormalScratch.y * minimumHeight;
		positions[ i + 2 + perSideFloatLength ] = _wallSurfaceScratch.z + _wallNormalScratch.z * minimumHeight;

		// top = surface + maxHeight * normal
		positions[ i ]     = _wallSurfaceScratch.x + _wallNormalScratch.x * maximumHeight;
		positions[ i + 1 ] = _wallSurfaceScratch.y + _wallNormalScratch.y * maximumHeight;
		positions[ i + 2 ] = _wallSurfaceScratch.z + _wallNormalScratch.z * maximumHeight;
	}

	// ── 步骤 5 · extrudeDirection:top 半 = 0,bot 半 = -geodeticSurfaceNormal(top_at_maxHeight)──
	// Cesium computeAttributes 在 shadowVolume + wall 分支中:
	//   normal = ellipsoid.geodeticSurfaceNormal(position)   // position = 当前 top 半位置(at maxHeight)
	//   extrudeNormals[bottomOffset] = -normal
	// 我们逐字复刻 — 读 step 4 修改后的 top 半(at maxHeight),不是 surface / chord。
	const extrudeDirection = new Float32Array( totalFloatLength );
	// top 半默认 (0, 0, 0)(Float32Array 默认填 0),无需显式写。

	for ( let i = 0; i < perSideFloatLength; i += 3 ) {
		_wallTopPosScratch.set(
			positions[ i ],
			positions[ i + 1 ],
			positions[ i + 2 ],
		);
		const result = geodeticSurfaceNormal(
			_wallTopPosScratch,
			_wallExtrudeNormalScratch,
		);
		if ( result === undefined ) {
			throw new Error(
				`constructPolygonWall: top vertex at index ${ i / 3 } cannot compute geodeticSurfaceNormal for extrudeDirection.`,
			);
		}

		// bot 半 = -normal
		extrudeDirection[ i + perSideFloatLength ]     = -_wallExtrudeNormalScratch.x;
		extrudeDirection[ i + 1 + perSideFloatLength ] = -_wallExtrudeNormalScratch.y;
		extrudeDirection[ i + 2 + perSideFloatLength ] = -_wallExtrudeNormalScratch.z;
	}

	return {
		positions,
		extrudeDirection,
		indices,
	};
}
