// ============================================================
// rectangle/rectangle-construct-cap.ts — 矩形顶面网格构造
// 层级:L3(基于 rectangle-grid + rectangle-attributes 的组合)
// 职责:给定 RectangleRadians + granularity + 椭球参数,生成顶面网格的:
//      - positions (Float64Array,ECEF 椭球表面采样)
//      - normals (Float32Array,每点单位法向,用于后续 extrudeDirection)
//      - indices (Uint16/32Array,主网格 + cap 扇形索引)
//      - width / height / cap flags(供下游 extruded 路径墙循环用)
//
//      Cap 是矩形挤出几何中的"顶面网格",同样数据稍后被复用一份作为"底面网格"。
// 依赖:Three.js Vector3、rectangle-grid.ts、rectangle-attributes.ts
// 被消费:rectangle-construct-extruded.ts
// 算法对应:Cesium Source/Core/RectangleGeometry.js#constructRectangle(L220-429)
//          只保留 POSITION + normal 路径,删除 st / tangent / bitangent
// ============================================================

import { Vector3 } from 'three';

import {
	computeCapNormals,
	createIndexTypedArray,
} from './rectangle-attributes';
import {
	computeRectangleGridOptions,
	computeRectangleGridSurfacePosition,
} from './rectangle-grid';
import type { RectangleRadians } from './rectangle-radians';

/**
 * `constructRectangleCap` 的完整输出。
 *
 * 字段意义见 `RectangleCapResult` 注释。所有数组都是新分配的,caller
 * 拥有全部所有权(下游 extruded 路径会原地修改 positions / normals)。
 */
export interface RectangleCapResult {
	/**
	 * 顶点位置,ECEF 米,Float64。
	 * 长度 = 3 × vertexCount;vertexCount = width · rowHeight + capExtras。
	 */
	positions: Float64Array;

	/**
	 * 每顶点单位法向,Float32(单位向量精度充裕)。
	 * 长度 = positions.length。
	 */
	normals: Float32Array;

	/**
	 * 顶面三角形索引(从地表上方俯视为 CCW)。
	 * vertexCount ≤ 65535 → Uint16Array;否则 Uint32Array。
	 */
	indices: Uint16Array | Uint32Array;

	/** 网格列数(经度方向顶点数) */
	width: number;

	/** 网格行数(纬度方向顶点数,包含 cap 用) */
	height: number;

	/** 是否覆盖北极(north === π/2) */
	northCap: boolean;

	/** 是否覆盖南极(south === -π/2) */
	southCap: boolean;
}

/**
 * 构造矩形顶面 cap 网格。
 *
 * 算法 6 步:
 *   1. computeRectangleGridOptions → width / height / nwCorner / capFlags
 *   2. 计算 size = width · height + cap 修正,确定 rowStart / rowEnd / rowHeight
 *   3. 主循环采样 ECEF 顶点(行主序)
 *   4. (可选) cap 单点采样(north/south 极点单点表示)
 *   5. 计算每顶点法向
 *   6. 构造索引(主网格双三角化 + cap 扇形)
 *
 * Cesium 对应:RectangleGeometry.js:220-429
 *
 * @param rect         矩形(弧度)。
 * @param granularity  网格精度(弧度)。
 * @param radiiSquared 椭球半轴平方,用于 grid 采样的 gamma 投影法。
 * @returns            完整 cap 结果。
 */
export function constructRectangleCap(
	rect: RectangleRadians,
	granularity: number,
	radiiSquared: Vector3,
): RectangleCapResult {
	// ── 步骤 1 · 网格参数 ──
	const opts = computeRectangleGridOptions( rect, granularity );
	const width = opts.width;
	const height = opts.height;
	const northCap = opts.northCap;
	const southCap = opts.southCap;

	// ── 步骤 2 · size 与 rowStart/rowEnd/rowHeight ──
	let size = width * height;
	let rowStart = 0;
	let rowEnd = height;
	let rowHeight = height;

	if ( northCap ) {
		// 北极覆盖时:整行 width 顶点被一个 cap 单点取代。
		size += 1;
		size -= width;
		rowStart += 1;
		rowHeight -= 1;
	}

	if ( southCap ) {
		size += 1;
		size -= width;
		rowEnd -= 1;
		rowHeight -= 1;
	}

	// ── 步骤 3 · 主网格采样(行优先) ──
	const positions = new Float64Array( size * 3 );
	const position = new Vector3();
	let posIndex = 0;

	for ( let row = rowStart; row < rowEnd; row++ ) {
		for ( let col = 0; col < width; col++ ) {
			computeRectangleGridSurfacePosition( opts, row, col, radiiSquared, position );
			positions[ posIndex++ ] = position.x;
			positions[ posIndex++ ] = position.y;
			positions[ posIndex++ ] = position.z;
		}
	}

	// ── 步骤 4 · cap 单点采样(若需要) ──
	// north cap 单点 = (longitude=west, latitude=π/2) → cosLat=0 → 球向量 (0,0,1) → ECEF (0,0,c)
	// south cap 单点 = (longitude=west, latitude=-π/2) → ECEF (0,0,-c)
	if ( northCap ) {
		computeRectangleGridSurfacePosition( opts, 0, 0, radiiSquared, position );
		positions[ posIndex++ ] = position.x;
		positions[ posIndex++ ] = position.y;
		positions[ posIndex++ ] = position.z;
	}

	if ( southCap ) {
		computeRectangleGridSurfacePosition( opts, height - 1, 0, radiiSquared, position );
		positions[ posIndex++ ] = position.x;
		positions[ posIndex++ ] = position.y;
		positions[ posIndex++ ] = position.z;
	}

	// invariant:posIndex 必须正好等于 size·3
	if ( posIndex !== size * 3 ) {
		throw new Error(
			`Cap position write count mismatch: posIndex=${ posIndex }, expected=${ size * 3 }`,
		);
	}

	// ── 步骤 5 · 法向 ──
	const normals = computeCapNormals( positions );

	// ── 步骤 6 · 索引构造 ──
	// 6.0 · 分配
	let indicesSize = 6 * ( width - 1 ) * ( rowHeight - 1 );
	if ( northCap ) {
		indicesSize += 3 * ( width - 1 );
	}
	if ( southCap ) {
		indicesSize += 3 * ( width - 1 );
	}

	const indices = createIndexTypedArray( size, indicesSize );
	let indicesIndex = 0;

	// 6.1 · 主网格双三角化
	// 每个 quad 切两个 CCW 三角形(从地表正上方俯视)。
	// 顶点 ID 用 `index` 游标(行主序),`index += 1` 在内循环末尾,
	// `index += 1` 在外循环末尾(跳过"换行"边界,与 Cesium 一致)。
	let index = 0;
	for ( let i = 0; i < rowHeight - 1; i++ ) {
		for ( let j = 0; j < width - 1; j++ ) {
			const upperLeft = index;
			const lowerLeft = upperLeft + width;
			const lowerRight = lowerLeft + 1;
			const upperRight = upperLeft + 1;

			indices[ indicesIndex++ ] = upperLeft;
			indices[ indicesIndex++ ] = lowerLeft;
			indices[ indicesIndex++ ] = upperRight;

			indices[ indicesIndex++ ] = upperRight;
			indices[ indicesIndex++ ] = lowerLeft;
			indices[ indicesIndex++ ] = lowerRight;

			index += 1;
		}
		index += 1; // 跳过本行末尾,进入下一行起点
	}

	// 6.2 · cap 扇形索引
	if ( northCap || southCap ) {
		// northIndex / southIndex 是 cap 单点的顶点 ID。
		// 若两者都存在:north 先(size-2),south 后(size-1)。
		// 若只有 north:northIndex = size-1。
		// 若只有 south:southIndex = size-1。
		let northIndex = size - 1;
		const southIndex = size - 1;
		if ( northCap && southCap ) {
			northIndex = size - 2;
		}

		if ( northCap ) {
			// 北极扇形:从顶点 0 开始,顺序串联 (northIndex, p1, p2) 三元组。
			// 顶点在前 — 从北极上方俯视为 CCW。
			let scanIndex = 0;
			for ( let i = 0; i < width - 1; i++ ) {
				const p1 = scanIndex;
				const p2 = p1 + 1;
				indices[ indicesIndex++ ] = northIndex;
				indices[ indicesIndex++ ] = p1;
				indices[ indicesIndex++ ] = p2;
				scanIndex += 1;
			}
		}

		if ( southCap ) {
			// 南极扇形:从底行(row = rowHeight-1)的第一个顶点开始。
			// 顺序 (p1, southIndex, p2) — 顶点在中,以保持从地表向上看 CCW。
			let scanIndex = ( rowHeight - 1 ) * width;
			for ( let i = 0; i < width - 1; i++ ) {
				const p1 = scanIndex;
				const p2 = p1 + 1;
				indices[ indicesIndex++ ] = p1;
				indices[ indicesIndex++ ] = southIndex;
				indices[ indicesIndex++ ] = p2;
				scanIndex += 1;
			}
		}
	}

	// invariant:indicesIndex 必须正好等于 indicesSize
	if ( indicesIndex !== indicesSize ) {
		throw new Error(
			`Cap indices write count mismatch: indicesIndex=${ indicesIndex }, expected=${ indicesSize }`,
		);
	}

	return {
		positions,
		normals,
		indices,
		width,
		height,
		northCap,
		southCap,
	};
}
