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
	// 步骤 1 · 棱柱顶点 / 挤出方向 / 索引
	const result = constructExtrudedTextShadowVolume( options );

	// 步骤 2 · RTE split-double：Float64 ECEF → high/low Float32
	const { high, low } = encodePositionsToHighLowArrays( result.positions );

	// 步骤 3 · 装配 BufferGeometry
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
