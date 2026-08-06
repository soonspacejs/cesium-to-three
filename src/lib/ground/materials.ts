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
	Matrix3,
	Matrix4,
	type Mesh,
	RawShaderMaterial,
	Vector3,
} from 'three';

import { cesiumPackDepth } from './shaders/shadow-volume-glsl';
import { terrainLogDepthUniforms } from './terrain-log-depth';

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
			c23_analyticEllipsoid: { value: 0.0 },
			c23_cameraPositionEllipsoid: { value: new Vector3() },
			c23_eyeToEllipsoid: { value: new Matrix3() },
		},
		vertexShader: /* glsl */ `${ defineSource }
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;

// 椭球兜底网格只负责产生片元；真实地表深度在片元阶段解析求交。
out vec3 c23_positionEC;

#ifdef LOG_DEPTH
uniform vec3 czm_currentFrustum;
out float v_depthFromNearPlusOne;
#endif

void main() {
	vec4 positionEC = modelViewMatrix * vec4(position, 1.0);
	c23_positionEC = positionEC.xyz;
	gl_Position = projectionMatrix * positionEC;
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

in vec3 c23_positionEC;
uniform float c23_analyticEllipsoid;
uniform vec3 c23_cameraPositionEllipsoid;
uniform mat3 c23_eyeToEllipsoid;

${ cesiumPackDepth }

#ifdef LOG_DEPTH
in float v_depthFromNearPlusOne;
uniform vec3 czm_currentFrustum;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
#endif

void main() {
#ifdef LOG_DEPTH
	float depth = v_depthFromNearPlusOne;
	if (c23_analyticEllipsoid > 0.5) {
		vec3 eyeDirection = normalize(c23_positionEC);
		vec3 ellipsoidDirection = c23_eyeToEllipsoid * eyeDirection;
		float a = dot(ellipsoidDirection, ellipsoidDirection);
		float halfB = dot(c23_cameraPositionEllipsoid, ellipsoidDirection);
		float c = dot(c23_cameraPositionEllipsoid, c23_cameraPositionEllipsoid) - 1.0;
		float discriminant = halfB * halfB - a * c;
		if (a <= 1.0e-30 || discriminant < 0.0) discard;

		float root = sqrt(max(discriminant, 0.0));
		// 相机在椭球外时使用稳定的近根公式，避免两个近似相等数相减。
		float distanceToSurface = c > 0.0
			? c / (-halfB + root)
			: (-halfB + root) / a;
		if (distanceToSurface <= 0.0) discard;
		depth = (-eyeDirection.z * distanceToSurface - czm_currentFrustum.x) + 1.0;
	}
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

/** 主帧缓冲使用的解析椭球 log-depth 材质。 */
export function createAnalyticEllipsoidMainDepthMaterial(): RawShaderMaterial {
	const material = createPackDepthMaterial();
	material.uniforms.czm_currentFrustum = terrainLogDepthUniforms.czm_currentFrustum;
	material.uniforms.czm_farDepthFromNearPlusOne =
		terrainLogDepthUniforms.czm_farDepthFromNearPlusOne;
	material.uniforms.czm_oneOverLog2FarDepthFromNearPlusOne =
		terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne;
	material.colorWrite = false;
	material.name = 'EllipsoidFallbackMainDepthMaterial';
	return material;
}

interface AnalyticEllipsoidUniforms {
	readonly c23_analyticEllipsoid?: { value: number };
	readonly c23_cameraPositionEllipsoid?: { value: Vector3 };
	readonly c23_eyeToEllipsoid?: { value: Matrix3 };
}

/**
 * 将球面网格标记为解析椭球深度代理。粗网格仅提供屏幕覆盖，onBeforeRender
 * 按实际 matrixWorld 把相机和视线变换到单位椭球空间。
 */
export function configureAnalyticEllipsoidDepthMesh( mesh: Mesh ): void {
	const previousBeforeRender = mesh.onBeforeRender;
	const previousAfterRender = mesh.onAfterRender;
	const inverseWorld = new Matrix4();
	const worldToEllipsoid = new Matrix3();
	const eyeToWorld = new Matrix3();
	const eyeToEllipsoid = new Matrix3();
	const cameraWorld = new Vector3();
	mesh.onBeforeRender = ( renderer, scene, camera, geometry, material, group ) => {
		previousBeforeRender.call( mesh, renderer, scene, camera, geometry, material, group );
		const uniforms = ( material as RawShaderMaterial ).uniforms as AnalyticEllipsoidUniforms;
		if ( uniforms.c23_analyticEllipsoid === undefined
			|| uniforms.c23_cameraPositionEllipsoid === undefined
			|| uniforms.c23_eyeToEllipsoid === undefined ) return;

		inverseWorld.copy( mesh.matrixWorld ).invert();
		cameraWorld.setFromMatrixPosition( camera.matrixWorld );
		uniforms.c23_cameraPositionEllipsoid.value
			.copy( cameraWorld )
			.applyMatrix4( inverseWorld );
		worldToEllipsoid.setFromMatrix4( inverseWorld );
		eyeToWorld.setFromMatrix4( camera.matrixWorld );
		eyeToEllipsoid.multiplyMatrices( worldToEllipsoid, eyeToWorld );
		uniforms.c23_eyeToEllipsoid.value.copy( eyeToEllipsoid );
		uniforms.c23_analyticEllipsoid.value = 1.0;
	};
	mesh.onAfterRender = ( renderer, scene, camera, geometry, material, group ) => {
		// overrideMaterial 会被同一场景的所有 draw 共享。解析代理完成后立即复位，
		// 避免排序在它后面的 terrain/tiles 或普通深度对象误走椭球求交分支。
		resetAnalyticEllipsoidDepthMaterial( material as RawShaderMaterial );
		previousAfterRender.call( mesh, renderer, scene, camera, geometry, material, group );
	};
}

/** 外部 terrain/tiles draw 前恢复普通几何深度模式。 */
export function resetAnalyticEllipsoidDepthMaterial( material: RawShaderMaterial ): void {
	const uniforms = material.uniforms as AnalyticEllipsoidUniforms;
	if ( uniforms.c23_analyticEllipsoid !== undefined ) {
		uniforms.c23_analyticEllipsoid.value = 0.0;
	}
}

export { ENABLE_LOG_DEPTH };
