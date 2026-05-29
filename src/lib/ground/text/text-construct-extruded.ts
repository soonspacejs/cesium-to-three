// ============================================================
// text-construct-extruded.ts
// 层级：L2（依赖 math/ellipsoid + rectangle-attributes 的索引类型助手）
// 职责：4 个 ECEF 角点 → 封闭盒子棱柱 shadow volume:
//       8 顶点(segregated top×4 + bot×4) + extrudeDirection + 36 索引。
//       顶点抬升 / extrudeDirection / 绕向严格对齐 circle-top-bottom 约定。
// 依赖：Three.Vector3、math/ellipsoid(scaleToGeodeticSurface /
//      geodeticSurfaceNormal)、rectangle/rectangle-attributes(createIndexTypedArray)。
// 被消费：text-shadow-volume。
// ============================================================

import { Vector3 } from 'three';

import {
	geodeticSurfaceNormal,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';
import { createIndexTypedArray } from '../rectangle/rectangle-attributes';

import {
	TEXT_DEFAULT_MAX_HEIGHT,
	TEXT_DEFAULT_MIN_HEIGHT,
	type TextShadowVolumeOptions,
} from './text-options';

/** 棱柱装配结果（与 rectangle/circle 同形：positions/extrudeDirection/indices）。 */
export interface ExtrudedTextResult {
	/** ECEF 顶点 Float64，8 顶点 × 3 = 24。 */
	positions: Float64Array;
	/** extrudeDirection Float32，与 positions 同长（top 半 0、bot 半 −normal）。 */
	extrudeDirection: Float32Array;
	/** 三角索引，36 个。 */
	indices: Uint16Array | Uint32Array;
}

// 模块级 scratch：每角点复用，避免堆分配。
const _surface = new Vector3();   // scaleToGeodeticSurface 输出
const _normal = new Vector3();    // 椭球面法向
const _scaled = new Vector3();    // normal × height
const _top = new Vector3();       // top 顶点
const _bot = new Vector3();       // bot 顶点

// 顶点索引常量（环序 SW=0 SE=1 NE=2 NW=3；bot = top + 4）。
const RING_COUNT = 4;

// 索引模板（顶/底 cap + 4 面墙，全部外向 CCW）。
const TEXT_PRISM_INDICES: ReadonlyArray<number> = [
	// top cap（朝天，CCW）
	0, 1, 2, 0, 2, 3,
	// bottom cap（朝地，winding 反转）
	4, 6, 5, 4, 7, 6,
	// 墙 edge 0→1
	0, 4, 5, 0, 5, 1,
	// 墙 edge 1→2
	1, 5, 6, 1, 6, 2,
	// 墙 edge 2→3
	2, 6, 7, 2, 7, 3,
	// 墙 edge 3→0
	3, 7, 4, 3, 4, 0,
];

/**
 * 把 4 个 ECEF 角点构造成封闭盒子棱柱 shadow volume。
 *
 * 每个角点 6 步（对齐 circle-top-bottom 约定）：
 *   1. scaleToGeodeticSurface(corner) → 投到椭球面
 *   2. normal = geodeticSurfaceNormal(surface)
 *   3. top = surface + maxHeight × normal，extrudeDir = (0,0,0)
 *   4. bot = surface + minHeight × normal，extrudeDir = −normal
 *   5. 写入 segregated positions：top 半 [0..3]、bot 半 [4..7]
 *   6. 索引用固定模板（12 三角，全外向 CCW）
 *
 * @param options 4 角点 + 可选顶/底高度。
 * @returns       positions + extrudeDirection + indices。
 * @throws        角点投影到椭球中心（理论不可能；防御）。
 */
export function constructExtrudedTextShadowVolume(
	options: TextShadowVolumeOptions,
): ExtrudedTextResult {
	const maximumHeight = options.maximumHeight !== undefined
		? options.maximumHeight
		: TEXT_DEFAULT_MAX_HEIGHT;
	const minimumHeight = options.minimumHeight !== undefined
		? options.minimumHeight
		: TEXT_DEFAULT_MIN_HEIGHT;

	// 环序 SW/SE/NE/NW（俯视 CCW），与索引模板对应。
	const ring: Vector3[] = [
		options.swEcef,
		options.seEcef,
		options.neEcef,
		options.nwEcef,
	];

	const vertexCount = RING_COUNT * 2; // 4 top + 4 bot = 8
	const positions = new Float64Array( vertexCount * 3 );
	const extrudeDirection = new Float32Array( vertexCount * 3 );
	// bot 半在 positions/extrudeDirection 中的 float 起始偏移
	const bottomFloatOffset = RING_COUNT * 3;

	for ( let i = 0; i < RING_COUNT; i ++ ) {
		const corner = ring[ i ];

		// 步骤 1 · 投到椭球面（角点来自切平面，亚毫米偏差，投影后严格在面上）
		const surface = scaleToGeodeticSurface( corner, _surface );
		if ( surface === undefined ) {
			throw new Error(
				`PlotText footprint corner #${ i } projects to ellipsoid center.`,
			);
		}

		// 步骤 2 · 椭球面法向
		const normal = geodeticSurfaceNormal( _surface, _normal );
		if ( normal === undefined ) {
			throw new Error(
				`PlotText footprint corner #${ i } cannot compute geodetic normal.`,
			);
		}

		// 步骤 3 · top 顶点 = surface + maxHeight × normal
		_scaled.copy( normal ).multiplyScalar( maximumHeight );
		_top.copy( _surface ).add( _scaled );

		// 步骤 4 · bot 顶点 = surface + minHeight × normal
		_scaled.copy( normal ).multiplyScalar( minimumHeight );
		_bot.copy( _surface ).add( _scaled );

		// 步骤 5 · 写 segregated positions
		const topBase = i * 3;
		const botBase = bottomFloatOffset + i * 3;
		positions[ topBase ] = _top.x;
		positions[ topBase + 1 ] = _top.y;
		positions[ topBase + 2 ] = _top.z;
		positions[ botBase ] = _bot.x;
		positions[ botBase + 1 ] = _bot.y;
		positions[ botBase + 2 ] = _bot.z;

		// extrudeDirection：top 半保持 0（Float32Array 初值），bot 半 = −normal
		extrudeDirection[ botBase ] = -normal.x;
		extrudeDirection[ botBase + 1 ] = -normal.y;
		extrudeDirection[ botBase + 2 ] = -normal.z;
	}

	// 步骤 6 · 索引（8 顶点 < 65535 → Uint16）
	const indices = createIndexTypedArray( vertexCount, TEXT_PRISM_INDICES.length );
	for ( let i = 0; i < TEXT_PRISM_INDICES.length; i ++ ) {
		indices[ i ] = TEXT_PRISM_INDICES[ i ];
	}

	return { positions, extrudeDirection, indices };
}
