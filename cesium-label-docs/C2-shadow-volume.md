# C2 · `text-shadow-volume.ts` —— BufferGeometry facade

> [← C1-construct](./C1-construct.md) | [C3-extents →](./C3-extents.md)

## 职责

把 [C1](./C1-construct.md) 的棱柱（Float64 positions + Float32 extrudeDirection + index）RTE 编码后装配成 Three `BufferGeometry`，attribute 命名严格用 `ShadowVolumeAppearanceVS.glsl` 消费的固定名：`position3DHigh` / `position3DLow` / `extrudeDirection` / `batchId`。这是「共享底层」契约——和 rectangle/circle 的几何装配一字不差，只是顶点来源不同。

## 完整源码

```typescript
// ============================================================
// text-shadow-volume.ts
// 层级：L3（顶层 facade，text-primitive 直接调用）
// 职责：4 角点 → constructExtrudedTextShadowVolume → RTE 编码 → 装配
//       BufferGeometry(position3DHigh/Low + extrudeDirection + batchId + index)。
//       attribute 名是 ShadowVolumeAppearanceVS.glsl 的固定契约，不可改名。
// 依赖：Three.BufferGeometry/BufferAttribute、math/rte-encoding、
//      text-construct-extruded、text-options。
// 被消费：text-primitive。
// ============================================================

import { BufferAttribute, BufferGeometry } from 'three';

import { encodePositionsToHighLowArrays } from '../math/rte-encoding';

import { constructExtrudedTextShadowVolume } from './text-construct-extruded';
import type { TextShadowVolumeOptions } from './text-options';

/**
 * 从 TextShadowVolumeOptions 构造 Three BufferGeometry。
 *
 * 流程：
 *   1. constructExtrudedTextShadowVolume → Float64 positions + Float32
 *      extrudeDirection + index
 *   2. encodePositionsToHighLowArrays：Float64 ECEF → high/low 两个 Float32
 *      （split-double，绕过 GPU Float32 7 位精度，防顶点抖动）
 *   3. setAttribute position3DHigh / position3DLow / extrudeDirection / batchId
 *      + setIndex
 *
 * 不调用 computeBoundingSphere：几何无 'position' attribute（只有 3DHigh/Low），
 * 与 rectangle/circle 一致；classification 自行处理视锥（frustumCulled=false）。
 *
 * @param options 4 角点 + 可选顶/底高度。
 * @returns       可直接喂给 classification stencil/color mesh 的 BufferGeometry。
 */
export function buildTextShadowVolumeGeometry(
	options: TextShadowVolumeOptions,
): BufferGeometry {
	// Step 1 · 棱柱顶点 / 挤出方向 / 索引
	const result = constructExtrudedTextShadowVolume( options );

	// Step 2 · RTE split-double：Float64 ECEF → high/low Float32
	const { high, low } = encodePositionsToHighLowArrays( result.positions );

	// Step 3 · 装配 BufferGeometry
	const geometry = new BufferGeometry();
	const vertexCount = result.positions.length / 3;

	// 这些名是 ShadowVolumeAppearanceVS.glsl 的 `in vec3 ...` 名，不可改名。
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	geometry.setAttribute(
		'extrudeDirection',
		new BufferAttribute( result.extrudeDirection, 3 ),
	);

	// batchId：单标牌作为一个 batch，固定全 0（与 rectangle/circle 一致）
	const batchId = new Float32Array( vertexCount );
	geometry.setAttribute( 'batchId', new BufferAttribute( batchId, 1 ) );

	// 合并索引（top cap + bottom cap + 4 墙）
	geometry.setIndex( new BufferAttribute( result.indices, 1 ) );

	return geometry;
}
```

## 设计记录

- **无 `position` attribute**：几何只有 `position3DHigh/Low`。Three 默认会想读 `position` 算 bounding sphere——因此 `frustumCulled` 必须在 mesh 上设 `false`（classification 那边做），否则会因 bounding sphere 缺失被错误剔除。
- **batchId 全 0**：Cesium batch table 机制残留。单标牌一个 batch，VS 里 `czm_batchTable_*(batchId)` 都取同一组 uniform。

## 单元测试建议

赤道足迹：`getAttribute('position3DHigh').count===8`、`getIndex().count===36`；high+low 重建（`high[i]+low[i]`）≈ 原 Float64 positions（误差 < 1e-3 米）。

---

[← C1-construct](./C1-construct.md) | [C3-extents →](./C3-extents.md)
