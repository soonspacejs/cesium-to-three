// ============================================================
// text-extents.ts
// 层级：L2（依赖 math/rte-encoding + text-placement 产物 + 共享 PlanarExtents 类型）
// 职责：用足迹 4 角点算 PlanarExtents。eastward/northward 取自旋转后的文字边
//       向量(SE−SW / NW−SW)，使 uv 沿字面轴(纹理不被拉斜)。
// 依赖：Three.Vector3/Vector4、math/rte-encoding、text-placement、ground/types。
// 被消费：text-classification（作为 color command 的 uniform）。
// ============================================================

import type { PlanarExtents } from '../types';
import { computeTexturedDecalPlanarExtents } from '../textured-decal';

import type { TextFootprint } from './text-placement';

/**
 * 用足迹 4 角点算旋转对齐的 PlanarExtents。
 *
 * eastward = SE − SW（文字右方向，模长 = footprintWidthMeters）
 * northward = NW − SW（文字上方向，模长 = footprintHeightMeters）
 * southWest = SW（uv 原点）经 RTE split-double 编码为 high/low。
 *
 * uvMinAndExtents = (0,0,1,1)、uMaxVmax = (0,1,1,0)：整张纹理铺满足迹，
 * 与 circle/rectangle 全填充语义一致。innerMetersRect 设为足迹宽高，
 * 下游 color 材质用其 zw 通道做归一化（见 C4）。
 *
 * 通用计算已抽到 textured-decal，文字保留本兼容门面与完整语义说明，避免
 * 文字和图片点分别维护两套精度敏感的 RTE/UV 逻辑。
 *
 * @param footprint text-placement.computeTextFootprint 的产物。
 * @returns         PlanarExtents（southWestHigh/Low/eastward/northward 均新建
 *                  Vector3，下游 uniform 长期持有）。
 */
export function computeTextPlanarExtents( footprint: TextFootprint ): PlanarExtents {
	return computeTexturedDecalPlanarExtents( footprint );
}
