// ============================================================
// terrain-log-depth.ts
// 层级:Cesium-to-Three 地形深度适配层。
// 职责:向 Three.js MeshStandard(或任何支持 onBeforeCompile 的)材质注入
//      Cesium 兼容的 log-depth GLSL，使主帧缓冲深度写入
//      `log2((w - near) + 1) / log2((far - near) + 1)` 空间，
//      与 shadow-volume color 命令采样的深度空间一致。若没有此适配层，
//      地形深度(NDC 线性)与 shadow-volume 深度(Cesium log depth)会处在不同空间，
//      LESS_OR_EQUAL stencil pass 会在每个片元上误判。
// 依赖:Three.js Material / Shader hook。
// 被消费:demo 地形接线(tiles.ts)，以及所有向贴地 classification 管线提供非 Cesium 深度的外部宿主。
// ============================================================

import { Vector3, type Material, type WebGLRenderer } from 'three';

interface ShaderLike {
	uniforms: Record<string, { value: unknown }>;
	vertexShader: string;
	fragmentShader: string;
}

type OnBeforeCompileFn = ( shader: ShaderLike, renderer: WebGLRenderer ) => void;

/**
 * 共享 log-depth uniform 引用。Three.js 材质按引用复用同一组 `{value}` 容器；
 * 每帧更新一次即可同步到所有通过 {@link applyCesiumLogDepthToMaterial} 增强过的材质。
 */
export const terrainLogDepthUniforms = {
	czm_currentFrustum: { value: new Vector3( 1.0, 1.0, 0.0 ) },
	czm_farDepthFromNearPlusOne: { value: 1.0 },
	czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
};

/**
 * 刷新当前视锥使用的共享地形 log-depth uniform。
 * 必须在主场景渲染前每帧调用一次。
 *
 * @param near 相机近裁剪面，单位米。
 * @param far 相机远裁剪面，单位米。
 */
export function updateTerrainLogDepthUniforms( near: number, far: number ): void {
	terrainLogDepthUniforms.czm_currentFrustum.value.set( near, far, 0.0 );

	const farDepthFromNearPlusOne = ( far - near ) + 1.0;
	const log2FarDepthFromNearPlusOne = Math.log2( farDepthFromNearPlusOne );
	terrainLogDepthUniforms.czm_farDepthFromNearPlusOne.value = farDepthFromNearPlusOne;
	terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne.value =
		log2FarDepthFromNearPlusOne > 0.0 ? 1.0 / log2FarDepthFromNearPlusOne : 1.0;
}

const TERRAIN_VERTEX_DECLARATION = /* glsl */ `
varying float v_depthFromNearPlusOne;
uniform vec3 czm_currentFrustum;
`;

const TERRAIN_VERTEX_WRITE = /* glsl */ `
	v_depthFromNearPlusOne = ( gl_Position.w - czm_currentFrustum.x ) + 1.0;
	gl_Position.z = clamp( gl_Position.z / gl_Position.w, - 1.0, 1.0 ) * gl_Position.w;
`;

const TERRAIN_FRAGMENT_DECLARATION = /* glsl */ `
varying float v_depthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
`;

// 与 Cesium 等价的 log-depth 写入。这里在 near/far 处 clamp 而不是 discard，
// 让地形因 log-depth 精度舍入而轻微越过视锥时仍能栅格化。
const TERRAIN_FRAGMENT_WRITE = /* glsl */ `
	{
		float czm_logDepth = v_depthFromNearPlusOne;
		if ( czm_logDepth <= 1.0 ) {
			gl_FragDepth = 0.0;
		} else if ( czm_logDepth > czm_farDepthFromNearPlusOne ) {
			gl_FragDepth = 1.0;
		} else {
			gl_FragDepth = log2( czm_logDepth ) * czm_oneOverLog2FarDepthFromNearPlusOne;
		}
	}
`;

// 带自定义 userData 标记的 Three.js Material 类型视图。这里使用交叉类型，
// 而不是 `interface extends Material`，避免用 Three 更严格的非可选签名重新声明
// `onBeforeCompile`。运行时赋值走上方更宽松的 `OnBeforeCompileFn` 形状，
// 并在下方赋值点进行 cast。
type CesiumLogDepthFlaggedMaterial = Material & {
	userData: {
		cesiumLogDepthApplied?: boolean;
		[ key: string ]: unknown;
	};
};

/**
 * 替换 `source` 中第一次出现的 `pattern`，并校验替换确实发生。
 * 当源码已偏离 Three.js 标准 chunk 时抛错，使布局回归在开发期显式暴露，
 * 而不是到运行时才产生错误深度值。
 *
 * @param source 原始 GLSL 源码。
 * @param pattern 要替换的匹配项，字符串或正则。
 * @param replacement 替换内容。
 * @param context 抛错时使用的上下文名称。
 * @returns 完成替换后的源码。
 */
function replaceOnce(
	source: string,
	pattern: string | RegExp,
	replacement: string,
	context: string,
): string {
	const next = source.replace( pattern, replacement );
	if ( next === source ) {
		throw new Error( `Cesium log-depth injection failed: ${ context } anchor not found.` );
	}
	return next;
}

/**
 * 向 Three.js 材质 shader 注入 Cesium log-depth 输出，并串接在调用方已有的
 * `onBeforeCompile` 之后。该操作幂等。
 *
 * @param material 需要增强的 Three.js 材质。
 */
export function applyCesiumLogDepthToMaterial( material: Material ): void {
	const flagged = material as CesiumLogDepthFlaggedMaterial;
	if ( flagged.userData?.cesiumLogDepthApplied === true ) {
		return;
	}
	if ( ! flagged.userData ) {
		flagged.userData = {};
	}
	flagged.userData.cesiumLogDepthApplied = true;

	const previousOnBeforeCompile = flagged.onBeforeCompile as
		| OnBeforeCompileFn
		| undefined;

	const nextOnBeforeCompile: OnBeforeCompileFn = ( shader, renderer ) => {
		if ( typeof previousOnBeforeCompile === 'function' ) {
			previousOnBeforeCompile( shader, renderer );
		}

		shader.uniforms.czm_currentFrustum = terrainLogDepthUniforms.czm_currentFrustum;
		shader.uniforms.czm_farDepthFromNearPlusOne =
			terrainLogDepthUniforms.czm_farDepthFromNearPlusOne;
		shader.uniforms.czm_oneOverLog2FarDepthFromNearPlusOne =
			terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne;

		shader.vertexShader = replaceOnce(
			shader.vertexShader,
			'void main() {',
			`${ TERRAIN_VERTEX_DECLARATION }\nvoid main() {`,
			'vertex declaration',
		);
		shader.vertexShader = replaceOnce(
			shader.vertexShader,
			'#include <project_vertex>',
			`#include <project_vertex>\n${ TERRAIN_VERTEX_WRITE }`,
			'vertex log-depth write',
		);

		// 注:不能用字面串 'void main() {'。3d-tiles-renderer 的 ImageOverlayPlugin
		// 在 processTileModel 阶段先跑 wrapOverlaysMaterial(在 load-model 事件 / 我们
		// 的 configureLoadedTileScene 之前),它的 fragment 替换正则只匹配 `void main(`,
		// 然后用 template literal 在尾部 `${ value }` 之后插了换行 + 缩进,导致最终
		// fragment shader 中出现 `void main(\n\n    ) {` 的形态——`(` 与 `)` 之间被
		// 插入了空白,字面串 'void main() {' 不再匹配。改用正则容忍这两段空白。
		shader.fragmentShader = replaceOnce(
			shader.fragmentShader,
			/void main\s*\(\s*\)\s*\{/,
			`${ TERRAIN_FRAGMENT_DECLARATION }\nvoid main() {`,
			'fragment declaration',
		);
		shader.fragmentShader = shader.fragmentShader.replace(
			/\}\s*$/,
			`${ TERRAIN_FRAGMENT_WRITE }\n}`,
		);
	};
	// Three.js 类型把 onBeforeCompile 声明为接收 `WebGLProgramParametersWithUniforms`。
	// 我们内部的 `ShaderLike` 结构兼容(同样具备 `uniforms / vertexShader / fragmentShader`
	// 字段)。在赋值处 cast，避免宽松内部类型泄漏到 Three.js 更严格的签名中。
	flagged.onBeforeCompile = nextOnBeforeCompile as unknown as Material[ 'onBeforeCompile' ];

	// 强制 Three.js 用增强后的 shader 重新编译该材质。
	flagged.needsUpdate = true;
	// 缓存键必须唯一：修改后的 shader 文本不同于原版，Three.js WebGLPrograms 缓存
	// 不能把它与相同 defines 下的非 log-depth MeshStandardMaterial 变体合并。
	flagged.customProgramCacheKey = () => 'cesium-log-depth-v1';
}
