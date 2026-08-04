// ============================================================
// material/shader-abi.ts
// Purpose: the single source of truth for ABI v1 names, GLSL field order,
//          kind macros, zero initialization, and premultiplied final output.
// Any breaking change to these declarations requires an ABI version increment.
// ============================================================

import type { GroundDefines, GroundPrimitiveKind } from './types';
import { canonicalizeGroundDefines } from './validation';

export const C23_GROUND_SHADER_ABI_VERSION = 1 as const;

export const C23_KIND_DEFINE_NAMES = {
	surface: 'C23_SURFACE',
	polyline: 'C23_POLYLINE',
	decal: 'C23_DECAL',
	arrow: 'C23_ARROW',
} as const satisfies Record<GroundPrimitiveKind, string>;

/** Frame values present for every primitive kind and render pass. */
export const C23_COMMON_SYSTEM_UNIFORM_NAMES = [
	'czm_encodedCameraPositionMCHigh',
	'czm_encodedCameraPositionMCLow',
	'czm_modelViewRelativeToEye',
	'czm_modelViewProjectionRelativeToEye',
	'czm_normal',
	'czm_geometricToleranceOverMeter',
	'czm_sceneMode',
	'czm_globeDepthTexture',
	'czm_viewport',
	'czm_inverseProjection',
	'czm_viewportTransformation',
	'czm_frustumPlanes',
	'czm_currentFrustum',
	'czm_farDepthFromNearPlusOne',
	'czm_log2FarDepthFromNearPlusOne',
	'czm_oneOverLog2FarDepthFromNearPlusOne',
	'c23_time',
	'c23_deltaTime',
	'c23_frameNumber',
] as const;

/** Shape/style wrappers exposed for surface and decal system stages. */
export const C23_SURFACE_SYSTEM_UNIFORM_NAMES = [
	'c23_globeMinimumAltitude',
	'c23_southWestHigh',
	'c23_southWestLow',
	'c23_eastward',
	'c23_northward',
	'c23_uvMinAndExtents',
	'c23_uMaxVmax',
	'c23_fillColor',
	'c23_strokeColor',
	'c23_borderEnabled',
	'c23_borderWidthMeters',
	'c23_innerMetersRect',
	'c23_cpuWestPlane',
	'c23_cpuSouthPlane',
	'c23_polygonBorderMode',
	'c23_polygonMiterStrokeMode',
	'c23_polygonPointCount',
	'c23_polygonPoints',
	'c23_circleBorderMode',
	'c23_circleCenterMeters',
	'c23_circleFillRadiusMeters',
	'c23_circleRenderRadiusMeters',
	'c23_circleRingCount',
	'c23_circleRingGapMeters',
	'c23_circleSectorStartRadians',
	'c23_circleSectorAngleRadians',
] as const;

/** Width, length, color and endpoint coordination for line/arrow stages. */
export const C23_LINE_SYSTEM_UNIFORM_NAMES = [
	'czm_projection',
	'czm_pixelRatio',
	'c23_lineColor',
	'c23_lineWidthPixels',
	'c23_lineWidthMode',
	'c23_lineWidthMeters',
	'c23_lineTotalMeters',
	'c23_arrowWidthMode',
	'c23_arrowLengthPixels',
	'c23_arrowHalfWidthPixels',
	'c23_arrowLengthMeters',
	'c23_arrowHalfWidthMeters',
	'c23_arrowColor',
	'c23_arrowStrokeHalfPixels',
	'c23_lineArrowClipEndEnabled',
	'c23_lineArrowClipStartEnabled',
	'c23_lineArrowStyleStart',
	'c23_lineArrowStyleEnd',
] as const;

/** Stable superset used by validation, snapshots, and Raw context diagnostics. */
export const C23_SYSTEM_UNIFORM_NAMES = [
	...C23_COMMON_SYSTEM_UNIFORM_NAMES,
	...C23_SURFACE_SYSTEM_UNIFORM_NAMES,
	...C23_LINE_SYSTEM_UNIFORM_NAMES,
] as const;

/** ABI declarations injected before validated user material source. */
export const C23_SHADER_ABI_SOURCE = /* glsl */ `
#define C23_GROUND_SHADER_ABI_VERSION ${ C23_GROUND_SHADER_ABI_VERSION }

uniform float c23_time;
uniform float c23_deltaTime;
uniform float c23_frameNumber;

struct c23_materialInput {
	vec2 st;
	vec2 localMeters;
	vec4 baseColor;
	float isStroke;
	vec3 positionEC;
	vec3 positionToEyeEC;
	vec3 normalEC;
	float distanceAlongMeters;
	float distanceAcrossMeters;
	float lineTotalMeters;
	float metersPerPixel;
};

struct c23_material {
	vec3 diffuse;
	vec3 emission;
	float alpha;
};
`;

/** ABI declarations injected only when a safe Material provides a vertex hook. */
export const C23_VERTEX_SHADER_ABI_SOURCE = /* glsl */ `
#define C23_GROUND_SHADER_ABI_VERSION ${ C23_GROUND_SHADER_ABI_VERSION }

uniform float c23_time;
uniform float c23_deltaTime;
uniform float c23_frameNumber;

struct c23_vertexInput {
	vec3 positionEC;
};

struct c23_vertexOutput {
	vec4 positionClip;
};
`;

/** Emits the one and only kind macro for a safe compiled material. */
export function createGroundKindDefineSource( kind: GroundPrimitiveKind ): string {
	return `#define ${ C23_KIND_DEFINE_NAMES[ kind ] } 1`;
}

/** Emits validated user defines in canonical name order. */
export function createGroundUserDefineSource( defines: GroundDefines ): string {
	return canonicalizeGroundDefines( defines )
		.filter(( [ , value ] ) => value !== false )
		.map(( [ name, value ] ) => {
			const serialized = value === true ? '1' : String( value );
			return `#define ${ name } ${ serialized }`;
		} )
		.join( '\n' );
}

/**
 * Library-owned zero initializer. Kind-specific system stages overwrite only
 * fields they can provide, making cross-kind material sharing deterministic.
 */
export function createMaterialInputSource( variableName = 'c23_input' ): string {
	return /* glsl */ `
c23_materialInput ${ variableName };
${ variableName }.st = vec2(0.0);
${ variableName }.localMeters = vec2(0.0);
${ variableName }.baseColor = vec4(0.0);
${ variableName }.isStroke = 0.0;
${ variableName }.positionEC = vec3(0.0);
${ variableName }.positionToEyeEC = vec3(0.0);
${ variableName }.normalEC = vec3(0.0);
${ variableName }.distanceAlongMeters = 0.0;
${ variableName }.distanceAcrossMeters = 0.0;
${ variableName }.lineTotalMeters = 0.0;
${ variableName }.metersPerPixel = 0.0;
`;
}

/**
 * Final safe output: apply system coverage, add straight RGB channels, and
 * premultiply exactly once. Alpha zero still writes, allowing stencil cleanup.
 */
export function createFinalOutputSource(
	materialVariable = 'c23_surfaceMaterial',
	coverageVariable = 'c23_systemCoverage',
	outputVariable = 'out_FragColor',
): string {
	return /* glsl */ `
float c23_finalAlpha = ${ materialVariable }.alpha * ${ coverageVariable };
vec3 c23_straightRgb = ${ materialVariable }.diffuse + ${ materialVariable }.emission;
${ outputVariable } = vec4(c23_straightRgb * c23_finalAlpha, c23_finalAlpha);
`;
}
