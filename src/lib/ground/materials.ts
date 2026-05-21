// ============================================================
// materials.ts
// Layer: Cesium-to-Three ground shader/material bridge.
// Role: translate Cesium GroundPrimitive shader snippets into Three
//       RawShaderMaterial instances while preserving Cesium stencil/color
//       command semantics.
// Dependencies: Three.js material state and unmodified Cesium GLSL sources.
// Consumed by: classification.ts and depth.ts.
// ============================================================

import {
	AddEquation,
	AlwaysStencilFunc,
	CustomBlending,
	DoubleSide,
	KeepStencilOp,
	NotEqualStencilFunc,
	OneFactor,
	OneMinusSrcAlphaFactor,
	RawShaderMaterial,
	ZeroStencilOp,
	GLSL3,
	type Side,
	type StencilOp,
} from 'three';

import cesiumShadowVolumeAppearanceVS from '../../../cesium-ground-source/engine/Source/Shaders/ShadowVolumeAppearanceVS.glsl?raw';
import cesiumShadowVolumeAppearanceFS from '../../../cesium-ground-source/engine/Source/Shaders/ShadowVolumeAppearanceFS.glsl?raw';
import cesiumShadowVolumeFS from '../../../cesium-ground-source/engine/Source/Shaders/ShadowVolumeFS.glsl?raw';
import cesiumDepthClamp from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/depthClamp.glsl?raw';
import cesiumWriteDepthClamp from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/writeDepthClamp.glsl?raw';
import cesiumTranslateRelativeToEye from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/translateRelativeToEye.glsl?raw';
import cesiumWindowToEyeCoordinates from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/windowToEyeCoordinates.glsl?raw';
import cesiumUnpackDepth from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/unpackDepth.glsl?raw';
import cesiumPackDepth from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/packDepth.glsl?raw';
import cesiumPlaneDistance from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/planeDistance.glsl?raw';
import cesiumGammaCorrect from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/gammaCorrect.glsl?raw';

import {
	CLASSIFICATION_MASK,
	MAX_POLYGON_STYLE_VERTICES,
	SCENE_MODE_3D,
} from './constants';
import type { SharedUniforms } from './types';

/**
 * Creates a shader prefix with Cesium automatic uniforms and batch-table hooks.
 *
 * @param defines GLSL defines to prepend exactly as Cesium ShaderSource would.
 * @returns GLSL source prefix.
 */
function createVertexPrefix( defines: readonly string[] ): string {
	const defineSource = defines.map( define => `#define ${ define }` ).join( '\n' );

	return /* glsl */ `
${ defineSource }
precision highp float;
precision highp int;

uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_modelViewProjectionRelativeToEye;
uniform mat3 czm_normal;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;

#define czm_sceneMode3D ${ SCENE_MODE_3D.toFixed( 1 ) }
#define czm_computePosition() czm_translateRelativeToEye(position3DHigh, position3DLow)

uniform vec3 u_southWest_HIGH;
uniform vec3 u_southWest_LOW;
uniform vec3 u_eastward;
uniform vec3 u_northward;
uniform vec4 u_uvMinAndExtents;
uniform vec4 u_uMaxVmax;
uniform vec4 u_color;

${ cesiumDepthClamp }

vec3 czm_batchTable_southWest_HIGH(float batchId) { return u_southWest_HIGH; }
vec3 czm_batchTable_southWest_LOW(float batchId) { return u_southWest_LOW; }
vec3 czm_batchTable_eastward(float batchId) { return u_eastward; }
vec3 czm_batchTable_northward(float batchId) { return u_northward; }
vec4 czm_batchTable_uvMinAndExtents(float batchId) { return u_uvMinAndExtents; }
vec4 czm_batchTable_uMaxVmax(float batchId) { return u_uMaxVmax; }
vec4 czm_batchTable_color(float batchId) { return u_color; }
float czm_batchTable_longitudeRotation(float batchId) { return 0.0; }
vec4 czm_batchTable_sphericalExtents(float batchId) { return vec4(0.0, 0.0, 1.0, 1.0); }
vec4 czm_batchTable_planes2D_HIGH(float batchId) { return vec4(0.0); }
vec4 czm_batchTable_planes2D_LOW(float batchId) { return vec4(0.0); }

float czm_branchFreeTernary(bool comparison, float trueValue, float falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_branchFreeTernary(bool comparison, vec2 trueValue, vec2 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec3 czm_branchFreeTernary(bool comparison, vec3 trueValue, vec3 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec4 czm_branchFreeTernary(bool comparison, vec4 trueValue, vec4 falseValue) {
	return comparison ? trueValue : falseValue;
}

${ cesiumTranslateRelativeToEye }
`;
}

/**
 * Creates the fragment prefix for Cesium shadow-volume color or stencil shaders.
 *
 * @param defines GLSL defines to prepend exactly as Cesium ShaderSource would.
 * @returns GLSL source prefix.
 */
function createFragmentPrefix( defines: readonly string[] ): string {
	const defineSource = defines.map( define => `#define ${ define }` ).join( '\n' );

	return /* glsl */ `
${ defineSource }
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 out_FragColor;

uniform sampler2D czm_globeDepthTexture;
uniform vec4 czm_viewport;
uniform mat4 czm_inverseProjection;
uniform mat4 czm_viewportTransformation;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform vec4 u_borderColor;
uniform float u_borderEnabled;
uniform float u_borderWidthMeters;
uniform vec4 u_innerMetersRect;
uniform float u_polygonBorderMode;
uniform float u_polygonPointCount;
uniform vec2 u_polygonPoints[${ MAX_POLYGON_STYLE_VERTICES }];
uniform float u_circleBorderMode;
uniform vec2 u_circleCenterMeters;
uniform float u_circleFillRadiusMeters;
uniform float u_circleRenderRadiusMeters;
uniform float u_circleRingCount;
uniform float u_circleRingGapMeters;
uniform float u_circleSectorStartRadians;
uniform float u_circleSectorAngleRadians;

const float czm_pi = 3.141592653589793;
const float czm_twoPi = 6.283185307179586;

${ cesiumWriteDepthClamp }

float czm_branchFreeTernary(bool comparison, float trueValue, float falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_branchFreeTernary(bool comparison, vec2 trueValue, vec2 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_approximateSphericalCoordinates(vec3 normal) {
	float latitudeApproximation = atan(length(normal.xy), normal.z);
	float longitudeApproximation = atan(normal.x, normal.y);
	return vec2(latitudeApproximation, longitudeApproximation);
}

float czm_lineDistance(vec2 point1, vec2 point2, vec2 point) {
	return abs((point2.y - point1.y) * point.x - (point2.x - point1.x) * point.y + point2.x * point1.y - point2.y * point1.x) / distance(point2, point1);
}

bool c23_pointInsidePolygon(vec2 point) {
	bool inside = false;
	int count = int(u_polygonPointCount);

	for (int i = 0; i < ${ MAX_POLYGON_STYLE_VERTICES }; i++) {
		if (i >= count) {
			break;
		}

		int previousIndex = i == 0 ? count - 1 : i - 1;
		vec2 current = u_polygonPoints[i];
		vec2 previous = u_polygonPoints[previousIndex];
		bool crosses = (current.y > point.y) != (previous.y > point.y);
		float denominator = previous.y - current.y;
		float safeDenominator = abs(denominator) < 1e-6 ? (denominator < 0.0 ? -1e-6 : 1e-6) : denominator;
		float intersectionX = (previous.x - current.x) * (point.y - current.y) / safeDenominator + current.x;

		if (crosses && point.x < intersectionX) {
			inside = !inside;
		}
	}

	return inside;
}

float c23_wrappedPositiveAngle(float radians) {
	float wrapped = mod(radians, czm_twoPi);
	return wrapped < 0.0 ? wrapped + czm_twoPi : wrapped;
}

${ cesiumUnpackDepth }
${ cesiumWindowToEyeCoordinates }
${ cesiumPlaneDistance }
${ cesiumGammaCorrect }
`;
}

/**
 * Creates a shader that packs gl_FragCoord.z with Cesium czm_packDepth.
 *
 * @returns RawShaderMaterial used by the globe depth pass.
 */
export function createPackDepthMaterial(): RawShaderMaterial {
	return new RawShaderMaterial( {
		glslVersion: GLSL3,
		vertexShader: /* glsl */ `
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;

void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
		fragmentShader: /* glsl */ `
precision highp float;
precision highp int;

out vec4 out_FragColor;

${ cesiumPackDepth }

void main() {
	out_FragColor = czm_packDepth(gl_FragCoord.z);
}
`,
		depthTest: true,
		depthWrite: true,
		colorWrite: true,
		toneMapped: false,
	} );
}

/**
 * Injects adapter-side border styling into Cesium's per-instance color branch.
 *
 * Geometry generation, stencil updates, and globe-depth classification still
 * use Cesium's shadow volume. The border is a material style computed from the
 * local meter coordinates reconstructed from Cesium's planar uv.
 *
 * @returns ShadowVolumeAppearanceFS with one Three-side border style hook.
 */
function createColorFragmentBody(): string {
	const colorDeclaration = '    vec4 color = czm_gammaCorrect(v_color);';
	const borderInjection = /* glsl */ `    vec4 color = czm_gammaCorrect(v_color);
#ifdef CESIUM_THREE_BORDER
#ifdef TEXTURE_COORDINATES
#ifndef SPHERICAL
    vec2 planarMeters = uv / v_inversePlaneExtents;
    if (u_circleBorderMode > 0.5) {
        vec2 circleVectorMeters = planarMeters - u_circleCenterMeters;
        float circleDistanceMeters = length(circleVectorMeters);
        if (circleDistanceMeters > u_circleRenderRadiusMeters) {
            discard;
        }

        float safeSectorAngle = clamp(abs(u_circleSectorAngleRadians), 0.0, czm_twoPi);
        float sectorDirection = u_circleSectorAngleRadians < 0.0 ? -1.0 : 1.0;
        bool fullCircleSector = safeSectorAngle >= czm_twoPi - 1e-5;
        float circleAngle = c23_wrappedPositiveAngle(atan(circleVectorMeters.y, circleVectorMeters.x));
        float sectorStart = c23_wrappedPositiveAngle(u_circleSectorStartRadians);
        float sectorLocalAngle = c23_wrappedPositiveAngle((circleAngle - sectorStart) * sectorDirection);
        bool insideSectorAngle = fullCircleSector || sectorLocalAngle <= safeSectorAngle;

        float safeRingCount = max(floor(u_circleRingCount + 0.5), 1.0);
        float gapCount = max(safeRingCount - 1.0, 0.0);
        float safeGapMeters = max(u_circleRingGapMeters, 0.0);
        float totalGapMeters = min(safeGapMeters * gapCount, max(u_circleFillRadiusMeters - 1e-3, 0.0));
        float ringWidthMeters = (u_circleFillRadiusMeters - totalGapMeters) / max(safeRingCount, 1e-6);
        float gapWidthMeters = gapCount > 0.0 ? totalGapMeters / gapCount : 0.0;
        float cellWidthMeters = max(ringWidthMeters + gapWidthMeters, 1e-6);
        float cellDistanceMeters = mod(circleDistanceMeters, cellWidthMeters);
        float outerRingStartMeters = max(u_circleFillRadiusMeters - ringWidthMeters, 0.0);
        bool insideFillRadius = circleDistanceMeters <= u_circleFillRadiusMeters;
        bool insideOuterBorder = circleDistanceMeters > u_circleFillRadiusMeters;
        bool insideRingBand = safeRingCount <= 1.0 || cellDistanceMeters <= ringWidthMeters || circleDistanceMeters >= outerRingStartMeters;
        float sectorEdgeDistanceMeters = min(sectorLocalAngle, max(safeSectorAngle - sectorLocalAngle, 0.0)) * circleDistanceMeters;
        bool sectorEdgeAllowed = safeRingCount <= 1.0 || circleDistanceMeters >= ringWidthMeters;
        bool sectorEdge = !fullCircleSector && insideSectorAngle && sectorEdgeAllowed && circleDistanceMeters <= u_circleFillRadiusMeters && sectorEdgeDistanceMeters <= u_borderWidthMeters;

        if (!insideSectorAngle) {
            color = vec4(color.rgb, 0.0);
        } else if (insideOuterBorder) {
            if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0) {
                color = vec4(color.rgb, 0.0);
            } else {
                color = czm_gammaCorrect(u_borderColor);
            }
        } else if (!insideFillRadius || !insideRingBand) {
            color = vec4(color.rgb, 0.0);
        } else if (u_borderEnabled > 0.5 && u_borderColor.a > 0.0) {
            float distanceToRingEdge = min(cellDistanceMeters, ringWidthMeters - cellDistanceMeters);
            bool ringEdge = safeRingCount > 1.0 && circleDistanceMeters > ringWidthMeters && distanceToRingEdge <= u_borderWidthMeters;
            bool centerRingOuterEdge = safeRingCount > 1.0 && abs(circleDistanceMeters - ringWidthMeters) <= u_borderWidthMeters;
            if (ringEdge || centerRingOuterEdge || sectorEdge) {
                color = czm_gammaCorrect(u_borderColor);
            }
        }

        if (color.a <= 0.0) {
            out_FragColor = color;
            out_FragColor.rgb *= out_FragColor.a;
            return;
        }
    } else if (u_polygonBorderMode > 0.5) {
        bool insideFillPolygon = c23_pointInsidePolygon(planarMeters);
        if (!insideFillPolygon) {
            if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0) {
                discard;
            }
            color = czm_gammaCorrect(u_borderColor);
        }
    } else {
        vec2 outsideLower = u_innerMetersRect.xy - planarMeters;
        vec2 outsideUpper = planarMeters - u_innerMetersRect.zw;
        vec2 outsideMeters = max(outsideLower, outsideUpper);
        float outsideDistanceMeters = max(outsideMeters.x, outsideMeters.y);
        if (outsideDistanceMeters > 0.0) {
            if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0 || outsideDistanceMeters > u_borderWidthMeters) {
                discard;
            }
            color = czm_gammaCorrect(u_borderColor);
        }
    }
#endif
#endif
#endif`;
	const shader = cesiumShadowVolumeAppearanceFS.replace( colorDeclaration, borderInjection );

	if ( shader === cesiumShadowVolumeAppearanceFS ) {
		throw new Error( 'Cesium shader patch failed: per-instance color hook was not found.' );
	}

	return shader;
}

/**
 * Creates one face-specific material for Cesium's stencil-depth command.
 *
 * @param uniforms Shared uniforms for all classification commands.
 * @param side Three side selection matching the Cesium front/back command.
 * @param stencilZFail Stencil operation executed when depth test fails.
 * @param name Material debug name.
 * @returns RawShaderMaterial matching one half of Cesium's z-fail command.
 */
export function createStencilMaterial(
	uniforms: SharedUniforms,
	side: Side,
	stencilZFail: StencilOp,
	name: string,
): RawShaderMaterial {
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( [ 'EXTRUDED_GEOMETRY' ] ) }\n${ cesiumShadowVolumeAppearanceVS }`,
		fragmentShader: `${ createFragmentPrefix( [] ) }\n${ cesiumShadowVolumeFS }`,
		side,
		colorWrite: false,
		depthWrite: false,
		depthTest: true,
		stencilWrite: true,
		stencilFunc: AlwaysStencilFunc,
		stencilRef: 0,
		stencilFuncMask: CLASSIFICATION_MASK,
		stencilWriteMask: CLASSIFICATION_MASK,
		stencilFail: KeepStencilOp,
		stencilZFail,
		stencilZPass: KeepStencilOp,
		toneMapped: false,
	} );

	material.name = name;
	return material;
}

/**
 * Creates the material for Cesium's final color classification command.
 *
 * @param uniforms Shared uniforms for all classification commands.
 * @param fragmentCull Whether Cesium's fragment-culling shader define is active.
 * @returns RawShaderMaterial matching Cesium's color pass render state.
 */
export function createColorMaterial( uniforms: SharedUniforms, fragmentCull: boolean ): RawShaderMaterial {
	const defines = [
		'EXTRUDED_GEOMETRY',
		'TEXTURE_COORDINATES',
		fragmentCull ? 'CULL_FRAGMENTS' : '',
		'PER_INSTANCE_COLOR',
		'FLAT',
		'REQUIRES_EC',
		'CESIUM_THREE_BORDER',
	].filter( define => define.length > 0 );

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( defines ) }\n${ cesiumShadowVolumeAppearanceVS }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ createColorFragmentBody() }`,
		side: DoubleSide,
		colorWrite: true,
		depthWrite: false,
		depthTest: false,
		stencilWrite: true,
		stencilFunc: NotEqualStencilFunc,
		stencilRef: 0,
		stencilFuncMask: CLASSIFICATION_MASK,
		stencilWriteMask: CLASSIFICATION_MASK,
		stencilFail: ZeroStencilOp,
		stencilZFail: ZeroStencilOp,
		stencilZPass: ZeroStencilOp,
		// The final color command still blends, but it must stay in Three's
		// opaque render list so renderOrder can keep each plot object's
		// stencil and color commands contiguous.
		transparent: false,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumClassificationColorMaterial';
	return material;
}
