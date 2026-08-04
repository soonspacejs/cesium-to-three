// ============================================================
// materials.ts
// Layer: packed-depth compatibility helper.
// Purpose: create the globe-depth material shared by depth-source managers.
//
// Classification, decal, polyline, and arrow shaders are assembled explicitly
// by material/ground-system-shaders.ts and material/compiler.ts. Keeping this
// file limited to packed depth prevents the retired Cesium main-anchor patching
// path from becoming a second Ground Material implementation again.
// ============================================================

import {
	GLSL3,
	LessEqualDepth,
	RawShaderMaterial,
} from 'three';

import { cesiumPackDepth } from './shaders/shadow-volume-glsl';

// Three.js 的 RawShaderMaterial 不会执行 Cesium ShaderSource 的自动
// LOG_DEPTH 包装(也就是向 main() 添加 czm_vertexLogDepth() /
// czm_writeLogDepth() 调用)。下面手动复刻这段注入逻辑。`LOG_DEPTH`
// define 同时控制 GLSL 源码与对应 Three 渲染状态中的 gl_FragDepth 路径。
// Three RawShaderMaterial does not receive Cesium ShaderSource's automatic
// logarithmic-depth wrapping. The standalone packed-depth pass therefore keeps
// its explicit equivalent. This shader is complete source, not an anchor patch.
const ENABLE_LOG_DEPTH = true;

/**
 * Creates the globe packed-depth pass consumed by Ground classification.
 * Fragments outside the active frustum are discarded so the render target keeps
 * its transparent-zero sentinel instead of exposing a fabricated far-plane hit.
 */
export function createPackDepthMaterial(): RawShaderMaterial {
	const defines = ENABLE_LOG_DEPTH ? [ 'LOG_DEPTH' ] : [];
	const defineSource = defines.map( define => `#define ${ define }` ).join( '\n' );

	return new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: {
			czm_currentFrustum: { value: null },
			czm_farDepthFromNearPlusOne: { value: 1.0 },
			czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
		},
		vertexShader: /* glsl */ `${ defineSource }
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;

#ifdef LOG_DEPTH
uniform vec3 czm_currentFrustum;
out float v_depthFromNearPlusOne;
#endif

void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#ifdef LOG_DEPTH
	v_depthFromNearPlusOne = ( gl_Position.w - czm_currentFrustum.x ) + 1.0;
	gl_Position.z = clamp( gl_Position.z / gl_Position.w, - 1.0, 1.0 ) * gl_Position.w;
#endif
}
`,
		fragmentShader: /* glsl */ `${ defineSource }
precision highp float;
precision highp int;

out vec4 out_FragColor;

${ cesiumPackDepth }

#ifdef LOG_DEPTH
in float v_depthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
#endif

void main() {
#ifdef LOG_DEPTH
	float depth = v_depthFromNearPlusOne;
	if ( depth <= 0.9999999 || depth > czm_farDepthFromNearPlusOne ) {
		discard;
	}
	float logDepth = log2( depth ) * czm_oneOverLog2FarDepthFromNearPlusOne;
	gl_FragDepth = logDepth;
	out_FragColor = czm_packDepth( logDepth );
#else
	out_FragColor = czm_packDepth( gl_FragCoord.z );
#endif
}
`,
		depthTest: true,
		depthWrite: true,
		depthFunc: LessEqualDepth,
		colorWrite: true,
		toneMapped: false,
	} );
}

export { ENABLE_LOG_DEPTH };
