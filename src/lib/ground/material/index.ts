// Public Material subsystem barrel. Compiler internals and legacy adapters stay
// private; only the stable ABI, logical strategies, public types, and built-in
// factories cross the package boundary.
export { C23_GROUND_SHADER_ABI_VERSION } from './shader-abi';
export {
	C23_GROUND_VERTEX_SHADER_TEMPLATE,
	C23_GROUND_FRAGMENT_SHADER_TEMPLATE,
	createGroundVertexShader,
	createGroundFragmentShader,
} from './templates';
export {
	CesiumGroundMaterial,
	type CesiumGroundMaterialEventMap,
	type CesiumGroundMaterialOptions,
} from './CesiumGroundMaterial';
export {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
	type CesiumGroundAppearance,
	type CesiumGroundAppearanceOptions,
	type CesiumGroundAppearanceOwner,
	type CesiumGroundMaterialAppearanceOptions,
	type CesiumGroundRawShaderAppearanceEventMap,
	type CesiumGroundRawShaderAppearanceOptions,
} from './appearances';
export {
	createColorGroundMaterial,
	createTexturedDecalMaterial,
	createPolylineDashMaterial,
	createFlowLineMaterial,
	createPulsePointMaterial,
	createScalePulseMaterial,
	type ColorGroundMaterialOptions,
	type TexturedDecalMaterialOptions,
	type PolylineDashMaterialOptions,
	type FlowLineMaterialOptions,
	type PulsePointMaterialOptions,
	type ScalePulseMaterialOptions,
	type GroundColorInput,
} from './builtins';
export {
	CesiumGroundMaterialError,
	type CesiumGroundMaterialErrorCode,
} from './errors';
export type {
	GroundDefineValue,
	GroundDefines,
	GroundUserUniforms,
	GroundSystemUniforms,
	GroundPrimitiveKind,
	GroundRenderPass,
	GroundRawShaderBuildContext,
	GroundMaterialFactory,
} from './types';
