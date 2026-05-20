// ============================================================
// rectangle/rectangle-attributes.ts — 矩形 attribute / 索引数组工厂
// 层级:L2(基于 math/ellipsoid 的辅助)
// 职责:
//      1. computeCapNormals:遍历 cap.positions(Float64),用 geodeticSurfaceNormal
//         算每点单位法向,写入 Float32Array。
//      2. createIndexTypedArray:根据顶点数选 Uint16(≤ 65535)或 Uint32 索引数组。
// 依赖:Three.js Vector3、math/ellipsoid.ts
// 被消费:rectangle-construct-cap.ts、rectangle-construct-extruded.ts
// 算法对应:Cesium Source/Core/RectangleGeometry.js#calculateAttributes(L72-134,
//          只取 normal 分支)+ Source/Core/IndexDatatype.js#createTypedArray
// ============================================================

import { Vector3 } from 'three';

import { geodeticSurfaceNormal } from '../math/ellipsoid';

// 模块级 scratch:法向计算复用,避免每点分配。
const _capP = new Vector3();
const _capNormal = new Vector3();

/**
 * 计算每个顶点的椭球表面单位法向。
 *
 * 遍历 positions(Float64,长度必须是 3 的倍数),对每点调用
 * `geodeticSurfaceNormal`,把单位法向写入新分配的 Float32Array。
 *
 * 法向 Float32 精度充裕(单位向量 |n|=1,Float32 有 ~7 位十进制精度)。
 *
 * @param positions ECEF 顶点数组(Float64,长度 = 3 × vertexCount)。
 * @returns         单位法向数组(Float32,长度同 positions)。
 * @throws          某个顶点位于椭球中心(geodeticSurfaceNormal 返回 undefined)。
 */
export function computeCapNormals( positions: Float64Array ): Float32Array {
	const length = positions.length;
	const normals = new Float32Array( length );

	for ( let i = 0; i < length; i += 3 ) {
		_capP.set( positions[ i ], positions[ i + 1 ], positions[ i + 2 ] );
		const result = geodeticSurfaceNormal( _capP, _capNormal );
		if ( result === undefined ) {
			// 网格采样不可能在椭球中心,若发生说明上游 grid / Newton 出错。
			throw new Error(
				`Cap vertex #${ i / 3 } at ellipsoid center, cannot compute normal`,
			);
		}
		normals[ i ] = _capNormal.x;
		normals[ i + 1 ] = _capNormal.y;
		normals[ i + 2 ] = _capNormal.z;
	}

	return normals;
}

/**
 * 根据顶点数选择索引 TypedArray:
 *   - vertexCount ≤ 65535 → Uint16Array(WebGL 1 默认支持)
 *   - vertexCount > 65535 → Uint32Array(需 WebGL 2 或 ANGLE_instanced_arrays 等)
 *
 * Three BufferGeometry 在 setIndex 时自动检测 TypedArray 类型并选择对应
 * GL 调用,两种返回值都能消费。
 *
 * Cesium 对应:IndexDatatype.js#createTypedArray
 *
 * @param vertexCount 顶点总数(决定索引值上限)。
 * @param indexCount  索引数组长度(顶点 ID 个数)。
 * @returns           Uint16Array 或 Uint32Array,长度 = indexCount。
 */
export function createIndexTypedArray(
	vertexCount: number,
	indexCount: number,
): Uint16Array | Uint32Array {
	if ( vertexCount > 65535 ) {
		return new Uint32Array( indexCount );
	}
	return new Uint16Array( indexCount );
}
