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
 * 与 circle/rectangle 全填充语义一致。innerMetersRect 设为足迹宽高，
 * 下游 color 材质用其 zw 通道做归一化（见 C4）。
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
		// 文字 color 材质用 zw 做 planarMeters → uv 归一化（见 C4）
		innerMetersRect: new Vector4(
			0.0, 0.0,
			footprint.footprintWidthMeters,
			footprint.footprintHeightMeters,
		),
	};
}
