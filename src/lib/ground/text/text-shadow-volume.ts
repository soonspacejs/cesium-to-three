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

import type { BufferGeometry } from 'three';

import { buildTexturedDecalShadowVolumeGeometry } from '../textured-decal';
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
 * 上述装配流程现由 textured-decal 统一实现；本函数保留文字模块的公开兼容入口，
 * 图片点也走完全相同的 shadow-volume 属性契约。
 *
 * @param options 4 角点 + 可选顶/底高度。
 * @returns       可直接喂给 classification stencil/color mesh 的 BufferGeometry。
 */
export function buildTextShadowVolumeGeometry(
	options: TextShadowVolumeOptions,
): BufferGeometry {
	return buildTexturedDecalShadowVolumeGeometry( options );
}
