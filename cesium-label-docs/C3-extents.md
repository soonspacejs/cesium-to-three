# C3 · `text-extents.ts` —— 旋转对齐 PlanarExtents

> [← C2-shadow-volume](./C2-shadow-volume.md) | [C4-material →](./C4-material.md)

## 职责

把 [B1](./B1-placement.md) 的足迹 4 角点算成 `PlanarExtents`（shader 用来在片元重建 uv）。**关键**：`eastward / northward` 直接取自**旋转后**的文字边向量（SE−SW、NW−SW），所以 uv 沿字面轴，纹理不被拉斜。这是贴地旋转文本成立的根基。

## 原理回顾（与 `ShadowVolumeAppearanceVS.glsl` 对应）

VS（3D 非球面分支）用三个 batch-table 量重建：

```glsl
southWestCorner = MV_RTE * translateRelativeToEye(southWest_HIGH, southWest_LOW)
southEastCorner = czm_normal * eastward  + southWestCorner
northWestCorner = czm_normal * northward + southWestCorner
eastWard = normalize(SE − SW); eastExtent = |SE − SW|
northWard = normalize(NW − SW); northExtent = |NW − SW|
v_westPlane  = vec4(eastWard,  −dot(eastWard,  SW))
v_southPlane = vec4(northWard, −dot(northWard, SW))
v_inversePlaneExtents = (1/eastExtent, 1/northExtent)
```

FS：`uv.x = planeDistance(westPlane, frag) / eastExtent`、`uv.y = planeDistance(southPlane, frag) / northExtent`。

`eastward / northward` 是**任意 ECEF 向量**——VS 不要求它们沿 ENU 东/北。把它们设成旋转后的文字边向量，uv 就贴着字面：uv.x 0→1 从 SW 到 SE（文字左→右），uv.y 0→1 从 SW 到 NW（文字下→上）。配合 [C4](./C4-material.md) 采样 `texture(map, vec2(uv.x, 1−uv.y))`，纹理与足迹完全对齐，旋转任意角度都不歪。

## 完整源码

```typescript
// ============================================================
// text-extents.ts
// 层级：L2（依赖 math/rte-encoding + text-placement 产物 + 共享 PlanarExtents 类型）
// 职责：用足迹 4 角点算 PlanarExtents。eastward/northward 取自旋转后的文字边
//       向量(SE−SW / NW−SW)，使 uv 沿字面轴(纹理不被拉斜)。
// 依赖：Three.Vector3/Vector4、math/rte-encoding、text-placement、ground/types。
// 被消费：text-classification（作为 color command 的 uniform）。
// ============================================================

import { Vector3, Vector4 } from 'three';

import { encodeVec3RTE } from '../math/rte-encoding';
import type { PlanarExtents } from '../types';

import type { TextFootprint } from './text-placement';

// 模块级 scratch：SW 角点 RTE 编码用，避免堆分配。
const _swHigh = new Vector3();
const _swLow = new Vector3();

/**
 * 用足迹 4 角点算旋转对齐的 PlanarExtents。
 *
 * eastward = SE − SW（文字右方向，模长 = footprintWidthMeters）
 * northward = NW − SW（文字上方向，模长 = footprintHeightMeters）
 * southWest = SW（uv 原点）经 RTE split-double 编码为 high/low。
 *
 * uvMinAndExtents = (0,0,1,1)、uMaxVmax = (0,1,1,0)：整张纹理铺满足迹，
 * 与 circle/rectangle 全填充语义一致。innerMetersRect 设满（文字不用 border-meters
 * 那套，描边在纹理里画好了），下游 color 材质也不读它（见 C4）。
 *
 * @param footprint text-placement.computeTextFootprint 的产物。
 * @returns         PlanarExtents（southWestHigh/Low/eastward/northward 均新建
 *                  Vector3，下游 uniform 长期持有）。
 */
export function computeTextPlanarExtents( footprint: TextFootprint ): PlanarExtents {
	// eastward = SE − SW（沿旋转后的文字右方向）
	const eastward = new Vector3(
		footprint.seEcef.x - footprint.swEcef.x,
		footprint.seEcef.y - footprint.swEcef.y,
		footprint.seEcef.z - footprint.swEcef.z,
	);
	// northward = NW − SW（沿旋转后的文字上方向）
	const northward = new Vector3(
		footprint.nwEcef.x - footprint.swEcef.x,
		footprint.nwEcef.y - footprint.swEcef.y,
		footprint.nwEcef.z - footprint.swEcef.z,
	);

	// SW 角点 RTE 编码（high/low Float32）
	encodeVec3RTE( footprint.swEcef, _swHigh, _swLow );

	return {
		southWestHigh: new Vector3( _swHigh.x, _swHigh.y, _swHigh.z ),
		southWestLow: new Vector3( _swLow.x, _swLow.y, _swLow.z ),
		eastward,
		northward,
		// 整张纹理铺满足迹
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		// 文字不用 border-meters；设满矩形即可（color 材质不读它）
		innerMetersRect: new Vector4(
			0.0, 0.0,
			footprint.footprintWidthMeters,
			footprint.footprintHeightMeters,
		),
	};
}
```

## 与 circle-extents 的对照

| | circle-extents | text-extents |
|---|---|---|
| SW 角点 | ENU 平面 `(−r,−r)` → ECEF | 旋转后文字左下角（已是 ECEF） |
| eastward | ENU 东向 × 2r | **旋转后文字右向** × footprintWidth |
| northward | ENU 北向 × 2r | **旋转后文字上向** × footprintHeight |
| uv 对齐 | ENU 东/北（轴对齐） | **字面轴**（随 rotation 转） |

底层都是「角点 → eastward/northward → RTE 编码 SW」，但 circle 沿 ENU 轴、文字沿旋转字面轴——这就是「底层同源、上层不同」。

## 单元测试建议

赤道足迹、rotation=0：`|eastward|≈footprintWidth`、`|northward|≈footprintHeight`、二者近似正交（点积≈0）。rotation=90°：`|eastward|` 不变但方向转到 ENU 南向（见 [B1 §4](./B1-placement.md)）。SW high+low 重建 ≈ swEcef。

---

[← C2-shadow-volume](./C2-shadow-volume.md) | [C4-material →](./C4-material.md)
