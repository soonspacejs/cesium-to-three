// ============================================================
// validation.ts
// 层级:Cesium-to-Three 贴地运行时校验。
// 职责:检查 Cesium ground classification 需要的 WebGL 能力。
// 依赖:Three.js renderer capabilities。
// 被消费:公开贴地适配器与 demo。
// ============================================================

import type { WebGLRenderer } from 'three';

/**
 * 检查 Cesium classification 需要的 WebGL 特性。
 *
 * @param renderer 当前使用的 Three WebGL renderer。
 */
export function validateCesiumGroundRenderer( renderer: WebGLRenderer ): void {
	const gl = renderer.getContext();

	if ( ! renderer.capabilities.isWebGL2 ) {
		throw new Error( 'Cesium ground classification requires WebGL2 in this Three adapter.' );
	}

	if ( gl.getParameter( gl.STENCIL_BITS ) < 8 ) {
		throw new Error( 'Cesium ground classification requires an 8-bit stencil buffer.' );
	}
}
