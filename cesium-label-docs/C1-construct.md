# C1 · `text-options.ts` + `text-construct-extruded.ts` —— 足迹棱柱构造

> [← B1-placement](./B1-placement.md) | [C2-shadow-volume →](./C2-shadow-volume.md)

## 职责

把 [B1](./B1-placement.md) 产出的 4 个 ECEF 角点（文字空间 SW/SE/NE/NW 环序）构造成一个**封闭的盒子棱柱** shadow volume：top cap（4 角抬到 maximumHeight）+ bottom cap（降到 minimumHeight）+ 4 面墙，并产出 `position3DHigh/Low + extrudeDirection + index` 这套 attribute。

比 circle 简单得多——circle 要细分圆盘 + 外圈墙（几百顶点），文字足迹只是个矩形 → **8 顶点、12 三角、36 索引**的最小封闭棱柱。但顶/底/墙的顶点抬升、extrudeDirection、绕向约定与 circle 严格一致（见 [circle-top-bottom 约定](./README.md)）。

## 顶点与索引布局

环序（俯视 CCW，外法向朝天）：`[SW, SE, NE, NW]`。

```
顶点(segregated):
  index 0..3 = top:  T_SW T_SE T_NE T_NW  (= 面点 + maxHeight×normal, extrudeDir 0)
  index 4..7 = bot:  B_SW B_SE B_NE B_NW  (= 面点 + minHeight×normal, extrudeDir −normal)

三角(全部外向 CCW，封闭流形，z-fail stencil 计数才正确):
  top cap   (朝天): 0,1,2  0,2,3
  bottom cap(朝地): 4,6,5  4,7,6        ← winding 反转
  墙 edge i→(i+1)%4，外向 CCW = (i, i+4, j+4, j) 其中 j=(i+1)%4:
    edge 0→1: 0,4,5  0,5,1
    edge 1→2: 1,5,6  1,6,2
    edge 2→3: 2,6,7  2,7,3
    edge 3→0: 3,7,4  3,4,0
```

**为什么必须全外向 CCW 一致**：classification 用 z-fail（Carmack reverse）。Three 把同一几何渲染两遍——`FrontSide`（front face = CCW）做 DecrementWrap、`BackSide`（CW）做 IncrementWrap。只有当棱柱是**封闭流形 + 绕向一致**时，front/back 计数才在地形落入体内处净非零。任何一面翻转都会破坏计数。南墙外向验证：从南向北看，T_SW 左上、T_SE 右上、B_SE 右下、B_SW 左下，CCW 序 `T_SW→B_SW→B_SE→T_SE` = `(0,4,5,1)` ✓。

## 完整源码 · `text-options.ts`

```typescript
// ============================================================
// text-options.ts
// 层级：L1（依赖 Three.Vector3 类型 + ground/constants）
// 职责：定义贴地文本 shadow volume 构造选项 —— 4 个 ECEF 角点(文字空间环序
//       SW/SE/NE/NW) + 顶/底高度。比 circle 的 options 简单(无半径/granularity)。
// 依赖：Three.js Vector3。
// 被消费：text-construct-extruded / text-shadow-volume。
// ============================================================

import type { Vector3 } from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from '../constants';

/**
 * 贴地文本 shadow volume 构造选项。
 *
 * 4 个角点必须是 text-placement.computeTextFootprint 产出的同一组，
 * 环序固定 SW(左下) → SE(右下) → NE(右上) → NW(左上)（俯视 CCW）。
 */
export interface TextShadowVolumeOptions {
	/** 文字左下角 ECEF（uv 原点）。 */
	swEcef: Vector3;
	/** 文字右下角 ECEF。 */
	seEcef: Vector3;
	/** 文字右上角 ECEF。 */
	neEcef: Vector3;
	/** 文字左上角 ECEF。 */
	nwEcef: Vector3;
	/** 顶面高度，米。默认 +CESIUM_GLOBE_MINIMUM_ALTITUDE。 */
	maximumHeight?: number;
	/** 底面高度，米。默认 −CESIUM_GLOBE_MINIMUM_ALTITUDE。 */
	minimumHeight?: number;
}

/** 顶面默认高度（米）：与 rectangle/circle 一致，确保 shadow volume 罩住地形。 */
export const TEXT_DEFAULT_MAX_HEIGHT = CESIUM_GLOBE_MINIMUM_ALTITUDE;
/** 底面默认高度（米）：负值，向地心方向延伸。 */
export const TEXT_DEFAULT_MIN_HEIGHT = -CESIUM_GLOBE_MINIMUM_ALTITUDE;
```

## 完整源码 · `text-construct-extruded.ts`

```typescript
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

// 索引模板（见本文档「顶点与索引布局」）。常量数组，构造期一次性拷入 typed array。
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
```

## 单元测试建议

赤道锚点、100×40 足迹、默认高度：验证 `positions.length===24`、`indices.length===36`；top 半 8 个 float 的高度（减面点 ≈ maxHeight）；bot 半 extrudeDir 模长≈1 且方向 ≈ −normal；任一三角形顶点不重合（无零面积）。封闭性可用「每条边恰被两个三角共享」校验。

---

[← B1-placement](./B1-placement.md) | [C2-shadow-volume →](./C2-shadow-volume.md)
