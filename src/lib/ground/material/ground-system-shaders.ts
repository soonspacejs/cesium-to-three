// ============================================================
// material/ground-system-shaders.ts
// Purpose: trusted, pass-specific GLSL sections consumed by the explicit
//          assembler. These sections own geometry, depth reconstruction,
//          membership, and coverage; safe user source only owns appearance.
// ============================================================

import { MAX_POLYGON_STYLE_VERTICES, SCENE_MODE_3D } from '../constants';
import type { CesiumGroundMaterial } from './CesiumGroundMaterial';
import {
	assembleGroundFragmentShader,
	assembleGroundVertexShader,
} from './shader-assembler';
import type { GroundPrimitiveKind, GroundRenderPass } from './types';

/** Complete source pair ready for a Three GLSL3 RawShaderMaterial. */
export interface GroundShaderSourcePair {
	readonly vertexShader: string;
	readonly fragmentShader: string;
}

/**
 * Canonical frame and shadow-volume uniforms used by both classification
 * stencil halves. Values are provided through wrapper aliases; no legacy u_*
 * identifier is exposed in this source.
 */
const CLASSIFICATION_STENCIL_VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_modelViewProjectionRelativeToEye;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;
uniform vec3 czm_currentFrustum;
uniform float c23_globeMinimumAltitude;
`;

/** The v1 surface/decal geometry layout is identical for all three passes. */
const CLASSIFICATION_ATTRIBUTES = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
in vec3 extrudeDirection;
`;

/** Log-depth value interpolated after the final clip-space position is known. */
const CLASSIFICATION_STENCIL_VERTEX_VARYINGS = /* glsl */ `
out float c23_depthFromNearPlusOne;
`;

/**
 * Cesium-style relative-to-eye reconstruction and vertex log-depth clamp.
 * Subtracting encoded camera parts before summation preserves low bits at ECEF
 * magnitudes where a direct high+low reconstruction would visibly jitter.
 */
const CLASSIFICATION_RTE_VERTEX_HELPER = /* glsl */ `
vec4 c23_translateRelativeToEye(vec3 high, vec3 low) {
	vec3 highDifference = high - czm_encodedCameraPositionMCHigh;
	vec3 lowDifference = low - czm_encodedCameraPositionMCLow;
	return vec4(highDifference + lowDifference, 1.0);
}
`;

/** Stencil-only helper that clamps clip depth and exports the logarithmic value. */
const CLASSIFICATION_STENCIL_VERTEX_LOG_DEPTH_HELPER = /* glsl */ `
void c23_writeVertexLogDepth() {
	c23_depthFromNearPlusOne = (gl_Position.w - czm_currentFrustum.x) + 1.0;
	gl_Position.z = clamp(gl_Position.z / gl_Position.w, -1.0, 1.0) * gl_Position.w;
}
`;

/**
 * Produces the same shadow-volume extrusion used by both stencil halves. The
 * top layer carries a zero direction; bottom/wall vertices move toward the
 * conservative globe floor only in 3D scene mode.
 */
const CLASSIFICATION_STENCIL_VERTEX_MAIN = /* glsl */ `
void main() {
	vec4 positionRte = c23_translateRelativeToEye(position3DHigh, position3DLow);
	float extrusionDelta = min(
		c23_globeMinimumAltitude,
		czm_geometricToleranceOverMeter * length(positionRte.xyz)
	);
	extrusionDelta *= czm_sceneMode == ${ SCENE_MODE_3D.toFixed( 1 ) } ? 1.0 : 0.0;
	positionRte.xyz += extrudeDirection * extrusionDelta;

	// Keep the ABI-prescribed batch attribute live without changing the single-instance result.
	positionRte.w += batchId * 0.0;
	gl_Position = czm_modelViewProjectionRelativeToEye * positionRte;
	c23_writeVertexLogDepth();
}
`;

const CLASSIFICATION_STENCIL_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
`;

const CLASSIFICATION_STENCIL_FRAGMENT_VARYINGS = /* glsl */ `
in float c23_depthFromNearPlusOne;
`;

/**
 * Unlike classification color cleanup, stencil depth must discard values
 * outside the current frustum. Clamping those fragments would create false
 * increment/decrement contributions in the Z-fail count.
 */
const CLASSIFICATION_STENCIL_FRAGMENT_HELPERS = /* glsl */ `
void c23_writeStencilLogDepth(float depthFromNearPlusOne) {
	if (
		depthFromNearPlusOne <= 0.9999999 ||
		depthFromNearPlusOne > czm_farDepthFromNearPlusOne
	) {
		discard;
	}
	gl_FragDepth = log2(depthFromNearPlusOne) * czm_oneOverLog2FarDepthFromNearPlusOne;
}
`;

const CLASSIFICATION_STENCIL_FRAGMENT_MAIN = /* glsl */ `
void main() {
	// Color writes are disabled by render state, but a defined output keeps the
	// GLSL3 fragment interface complete on strict WebGL2 drivers.
	out_FragColor = vec4(1.0);
	c23_writeStencilLogDepth(c23_depthFromNearPlusOne);
}
`;

/**
 * Builds one fixed surface/decal stencil half. Front and back share identical
 * GLSL and differ only in side/stencil render state owned by the compiler.
 */
export function createGroundClassificationStencilShaders(
	kind: Extract<GroundPrimitiveKind, 'surface' | 'decal'>,
	pass: Extract<GroundRenderPass, 'frontStencil' | 'backStencil'>,
): GroundShaderSourcePair {
	return Object.freeze( {
		vertexShader: assembleGroundVertexShader( {
			kind,
			pass,
			sections: {
				declarations: CLASSIFICATION_STENCIL_VERTEX_DECLARATIONS,
				attributes: CLASSIFICATION_ATTRIBUTES,
				varyings: CLASSIFICATION_STENCIL_VERTEX_VARYINGS,
				helpers: [
					CLASSIFICATION_RTE_VERTEX_HELPER,
					CLASSIFICATION_STENCIL_VERTEX_LOG_DEPTH_HELPER,
				].join( '\n' ),
				main: CLASSIFICATION_STENCIL_VERTEX_MAIN,
			},
		} ),
		fragmentShader: assembleGroundFragmentShader( {
			mode: 'stencil',
			kind,
			pass,
			sections: {
				declarations: CLASSIFICATION_STENCIL_FRAGMENT_DECLARATIONS,
				varyings: CLASSIFICATION_STENCIL_FRAGMENT_VARYINGS,
				helpers: CLASSIFICATION_STENCIL_FRAGMENT_HELPERS,
				main: CLASSIFICATION_STENCIL_FRAGMENT_MAIN,
			},
		} ),
	} );
}

// ---------------------------------------------------------------------------
// Surface/decal classification color pass
// ---------------------------------------------------------------------------

/** Color uses the same conservative shadow volume but never writes depth. */
const CLASSIFICATION_COLOR_VERTEX_DECLARATIONS = CLASSIFICATION_STENCIL_VERTEX_DECLARATIONS;

/**
 * Color still clamps clip-space z so near/far clipping cannot remove pixels
 * whose stencil value must be consumed. No log-depth varying is needed because
 * the color render state neither tests nor writes depth.
 */
const CLASSIFICATION_COLOR_VERTEX_MAIN = /* glsl */ `
void main() {
	vec4 positionRte = c23_translateRelativeToEye(position3DHigh, position3DLow);
	float extrusionDelta = min(
		c23_globeMinimumAltitude,
		czm_geometricToleranceOverMeter * length(positionRte.xyz)
	);
	extrusionDelta *= czm_sceneMode == ${ SCENE_MODE_3D.toFixed( 1 ) } ? 1.0 : 0.0;
	positionRte.xyz += extrudeDirection * extrusionDelta;
	positionRte.w += batchId * 0.0;

	gl_Position = czm_modelViewProjectionRelativeToEye * positionRte;
	gl_Position.z = clamp(gl_Position.z / gl_Position.w, -1.0, 1.0) * gl_Position.w;
}
`;

/** Canonical system inputs for depth reconstruction and shape evaluation. */
const CLASSIFICATION_COLOR_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D czm_globeDepthTexture;
uniform vec4 czm_viewport;
uniform mat4 czm_inverseProjection;
uniform vec3 czm_currentFrustum;
uniform float czm_log2FarDepthFromNearPlusOne;

uniform vec3 c23_eastward;
uniform vec3 c23_northward;
uniform vec4 c23_fillColor;
uniform vec4 c23_strokeColor;
uniform float c23_borderEnabled;
uniform float c23_borderWidthMeters;
uniform vec4 c23_innerMetersRect;
uniform vec4 c23_cpuWestPlane;
uniform vec4 c23_cpuSouthPlane;

uniform float c23_polygonBorderMode;
uniform float c23_polygonMiterStrokeMode;
uniform float c23_polygonPointCount;
uniform vec2 c23_polygonPoints[${ MAX_POLYGON_STYLE_VERTICES }];

uniform float c23_circleBorderMode;
uniform vec2 c23_circleCenterMeters;
uniform float c23_circleFillRadiusMeters;
uniform float c23_circleRenderRadiusMeters;
uniform float c23_circleRingCount;
uniform float c23_circleRingGapMeters;
uniform float c23_circleSectorStartRadians;
uniform float c23_circleSectorAngleRadians;
`;

/**
 * Trusted intermediate result keeps Material-facing fields and cleanup coverage
 * together. It is fully initialized even for invalid packed depth so the user
 * function never observes undefined data.
 */
const CLASSIFICATION_COLOR_FRAGMENT_HELPERS = /* glsl */ `
const float c23_pi = 3.141592653589793;
const float c23_twoPi = 6.283185307179586;

struct c23_surfaceEvaluation {
	vec2 st;
	vec2 localMeters;
	vec4 baseColor;
	float isStroke;
	float coverage;
	vec3 positionEC;
	vec3 positionToEyeEC;
	vec3 normalEC;
};

float c23_unpackDepth(vec4 packedDepth) {
	return dot(
		packedDepth,
		vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)
	);
}

vec3 c23_reconstructEyePosition(vec2 fragmentCoordinate, float logDepth) {
	vec2 viewportUv = (fragmentCoordinate - czm_viewport.xy) / czm_viewport.zw;
	float nearDistance = czm_currentFrustum.x;
	float farDistance = czm_currentFrustum.y;
	float depthFromNear = exp2(logDepth * czm_log2FarDepthFromNearPlusOne) - 1.0;
	float depthFromCamera = depthFromNear + nearDistance;
	float windowDepth = farDistance * (1.0 - nearDistance / depthFromCamera)
		/ (farDistance - nearDistance);
	vec4 clipCoordinate = vec4(viewportUv * 2.0 - 1.0, windowDepth * 2.0 - 1.0, 1.0);
	vec4 eyeCoordinate = czm_inverseProjection * clipCoordinate;
	return eyeCoordinate.xyz / eyeCoordinate.w;
}

float c23_planeDistance(vec4 plane, vec3 point) {
	return dot(plane.xyz, point) + plane.w;
}

float c23_wrappedPositiveAngle(float radians) {
	float wrapped = mod(radians, c23_twoPi);
	return wrapped < 0.0 ? wrapped + c23_twoPi : wrapped;
}

bool c23_pointInsidePolygon(vec2 point) {
	bool inside = false;
	int count = int(c23_polygonPointCount);
	for (int index = 0; index < ${ MAX_POLYGON_STYLE_VERTICES }; index++) {
		if (index >= count) break;
		int previousIndex = index == 0 ? count - 1 : index - 1;
		vec2 current = c23_polygonPoints[index];
		vec2 previous = c23_polygonPoints[previousIndex];
		bool crosses = (current.y > point.y) != (previous.y > point.y);
		float denominator = previous.y - current.y;
		float safeDenominator = abs(denominator) < 1e-6
			? (denominator < 0.0 ? -1e-6 : 1e-6)
			: denominator;
		float intersectionX = (previous.x - current.x) * (point.y - current.y)
			/ safeDenominator + current.x;
		if (crosses && point.x < intersectionX) inside = !inside;
	}
	return inside;
}

float c23_distanceToPolygonEdges(vec2 point) {
	float minimumDistance = 1.0e20;
	int count = int(c23_polygonPointCount);
	for (int index = 0; index < ${ MAX_POLYGON_STYLE_VERTICES }; index++) {
		if (index >= count) break;
		int nextIndex = index + 1 >= count ? 0 : index + 1;
		vec2 start = c23_polygonPoints[index];
		vec2 end = c23_polygonPoints[nextIndex];
		vec2 edge = end - start;
		float edgeLengthSquared = dot(edge, edge);
		float segmentT = edgeLengthSquared > 1e-12
			? clamp(dot(point - start, edge) / edgeLengthSquared, 0.0, 1.0)
			: 0.0;
		minimumDistance = min(minimumDistance, distance(point, start + edge * segmentT));
	}
	return minimumDistance;
}

void c23_selectStroke(inout c23_surfaceEvaluation evaluation) {
	evaluation.baseColor = c23_strokeColor;
	evaluation.isStroke = 1.0;
}

void c23_evaluateRectangle(inout c23_surfaceEvaluation evaluation) {
	vec2 outsideLower = c23_innerMetersRect.xy - evaluation.localMeters;
	vec2 outsideUpper = evaluation.localMeters - c23_innerMetersRect.zw;
	vec2 outsideMeters = max(outsideLower, outsideUpper);
	float outsideDistanceMeters = max(outsideMeters.x, outsideMeters.y);
	if (outsideDistanceMeters <= 0.0) return;

	if (
		c23_borderEnabled > 0.5 &&
		c23_strokeColor.a > 0.0 &&
		outsideDistanceMeters <= c23_borderWidthMeters
	) {
		c23_selectStroke(evaluation);
	} else {
		evaluation.coverage = 0.0;
	}
}

void c23_evaluatePolygon(inout c23_surfaceEvaluation evaluation) {
	bool insidePolygon = c23_pointInsidePolygon(evaluation.localMeters);
	float edgeDistanceMeters = c23_distanceToPolygonEdges(evaluation.localMeters);
	if (c23_polygonMiterStrokeMode > 0.5) {
		if (!insidePolygon) {
			evaluation.coverage = 0.0;
			return;
		}
		if (
			c23_borderEnabled > 0.5 &&
			c23_strokeColor.a > 0.0 &&
			edgeDistanceMeters <= c23_borderWidthMeters
		) c23_selectStroke(evaluation);
		return;
	}

	if (!insidePolygon) {
		if (
			c23_borderEnabled > 0.5 &&
			c23_strokeColor.a > 0.0 &&
			edgeDistanceMeters <= c23_borderWidthMeters
		) {
			c23_selectStroke(evaluation);
		} else {
			evaluation.coverage = 0.0;
		}
	}
}

void c23_evaluateCircle(inout c23_surfaceEvaluation evaluation) {
	vec2 circleVectorMeters = evaluation.localMeters - c23_circleCenterMeters;
	float circleDistanceMeters = length(circleVectorMeters);
	if (circleDistanceMeters > c23_circleRenderRadiusMeters) {
		evaluation.coverage = 0.0;
		return;
	}

	float safeSectorAngle = clamp(abs(c23_circleSectorAngleRadians), 0.0, c23_twoPi);
	float sectorDirection = c23_circleSectorAngleRadians < 0.0 ? -1.0 : 1.0;
	bool fullCircleSector = safeSectorAngle >= c23_twoPi - 1e-5;
	float circleAngle = c23_wrappedPositiveAngle(atan(circleVectorMeters.y, circleVectorMeters.x));
	float sectorStart = c23_wrappedPositiveAngle(c23_circleSectorStartRadians);
	float sectorLocalAngle = c23_wrappedPositiveAngle((circleAngle - sectorStart) * sectorDirection);
	bool insideSectorAngle = fullCircleSector || sectorLocalAngle <= safeSectorAngle;
	if (!insideSectorAngle) {
		evaluation.coverage = 0.0;
		return;
	}

	float safeRingCount = max(floor(c23_circleRingCount + 0.5), 1.0);
	float gapCount = max(safeRingCount - 1.0, 0.0);
	float safeGapMeters = max(c23_circleRingGapMeters, 0.0);
	float totalGapMeters = min(
		safeGapMeters * gapCount,
		max(c23_circleFillRadiusMeters - 1e-3, 0.0)
	);
	float ringWidthMeters = (c23_circleFillRadiusMeters - totalGapMeters)
		/ max(safeRingCount, 1e-6);
	float gapWidthMeters = gapCount > 0.0 ? totalGapMeters / gapCount : 0.0;
	float cellWidthMeters = max(ringWidthMeters + gapWidthMeters, 1e-6);
	float cellDistanceMeters = mod(circleDistanceMeters, cellWidthMeters);
	float outerRingStartMeters = max(c23_circleFillRadiusMeters - ringWidthMeters, 0.0);
	bool insideFillRadius = circleDistanceMeters <= c23_circleFillRadiusMeters;
	bool insideOuterBorder = circleDistanceMeters > c23_circleFillRadiusMeters;
	bool insideRingBand = safeRingCount <= 1.0
		|| cellDistanceMeters <= ringWidthMeters
		|| circleDistanceMeters >= outerRingStartMeters;

	if (insideOuterBorder) {
		if (c23_borderEnabled > 0.5 && c23_strokeColor.a > 0.0) {
			c23_selectStroke(evaluation);
		} else {
			evaluation.coverage = 0.0;
		}
		return;
	}
	if (!insideFillRadius || !insideRingBand) {
		evaluation.coverage = 0.0;
		return;
	}

	if (c23_borderEnabled > 0.5 && c23_strokeColor.a > 0.0) {
		float distanceToRingEdge = min(cellDistanceMeters, ringWidthMeters - cellDistanceMeters);
		bool ringEdge = safeRingCount > 1.0
			&& circleDistanceMeters > ringWidthMeters
			&& distanceToRingEdge <= c23_borderWidthMeters;
		bool centerRingOuterEdge = safeRingCount > 1.0
			&& abs(circleDistanceMeters - ringWidthMeters) <= c23_borderWidthMeters;
		float sectorEdgeDistanceMeters = min(
			sectorLocalAngle,
			max(safeSectorAngle - sectorLocalAngle, 0.0)
		) * circleDistanceMeters;
		bool sectorEdge = !fullCircleSector
			&& circleDistanceMeters >= ringWidthMeters
			&& sectorEdgeDistanceMeters <= c23_borderWidthMeters;
		if (ringEdge || centerRingOuterEdge || sectorEdge) c23_selectStroke(evaluation);
	}
}

c23_surfaceEvaluation c23_evaluateClassificationSurface() {
	c23_surfaceEvaluation evaluation;
	evaluation.st = vec2(0.0);
	evaluation.localMeters = vec2(0.0);
	evaluation.baseColor = c23_fillColor;
	evaluation.isStroke = 0.0;
	evaluation.coverage = 1.0;
	evaluation.positionEC = vec3(0.0);
	evaluation.positionToEyeEC = vec3(0.0);
	evaluation.normalEC = vec3(0.0);

	vec2 depthUv = (gl_FragCoord.xy - czm_viewport.xy) / czm_viewport.zw;
	bool insideViewport = all(greaterThanEqual(depthUv, vec2(0.0)))
		&& all(lessThanEqual(depthUv, vec2(1.0)));
	float packedDepth = insideViewport
		? c23_unpackDepth(texture(czm_globeDepthTexture, depthUv))
		: 0.0;
	if (!insideViewport || packedDepth <= 0.0 || packedDepth >= 1.0) {
		evaluation.coverage = 0.0;
		return evaluation;
	}

	evaluation.positionEC = c23_reconstructEyePosition(gl_FragCoord.xy, packedDepth);
	evaluation.positionToEyeEC = -evaluation.positionEC;
	vec3 derivativeX = dFdx(evaluation.positionEC);
	vec3 derivativeY = dFdy(evaluation.positionEC);
	vec3 reconstructedNormal = normalize(cross(derivativeX, derivativeY));
	evaluation.normalEC = dot(reconstructedNormal, evaluation.positionToEyeEC) < 0.0
		? -reconstructedNormal
		: reconstructedNormal;
	evaluation.localMeters = vec2(
		c23_planeDistance(c23_cpuWestPlane, evaluation.positionEC),
		c23_planeDistance(c23_cpuSouthPlane, evaluation.positionEC)
	);
	vec2 footprintMeters = max(
		vec2(length(c23_eastward), length(c23_northward)),
		vec2(1e-6)
	);
	evaluation.st = evaluation.localMeters / footprintMeters;

#ifdef C23_FRAGMENT_CULL
	if (any(lessThanEqual(evaluation.st, vec2(0.0)))
		|| any(greaterThanEqual(evaluation.st, vec2(1.0)))) {
		evaluation.coverage = 0.0;
	}
#endif

#ifdef C23_SURFACE
	if (c23_circleBorderMode > 0.5) {
		c23_evaluateCircle(evaluation);
	} else if (c23_polygonBorderMode > 0.5) {
		c23_evaluatePolygon(evaluation);
	} else {
		c23_evaluateRectangle(evaluation);
	}
#endif

	return evaluation;
}
`;

const CLASSIFICATION_COLOR_MAIN_PROLOGUE = /* glsl */ `
c23_surfaceEvaluation c23_surface = c23_evaluateClassificationSurface();
c23_systemCoverage = c23_surface.coverage;
`;

const CLASSIFICATION_COLOR_INPUT_ASSIGNMENTS = /* glsl */ `
c23_input.st = c23_surface.st;
c23_input.localMeters = c23_surface.localMeters;
c23_input.baseColor = c23_surface.baseColor;
c23_input.isStroke = c23_surface.isStroke;
c23_input.positionEC = c23_surface.positionEC;
c23_input.positionToEyeEC = c23_surface.positionToEyeEC;
c23_input.normalEC = c23_surface.normalEC;
`;

/**
 * Builds the safe surface/decal color shader. Shape and invalid-depth paths
 * never discard: zero coverage still reaches the output and therefore the
 * render state's ZeroStencilOp cleanup.
 */
export function createGroundClassificationColorShaders(
	kind: Extract<GroundPrimitiveKind, 'surface' | 'decal'>,
	material: Pick<CesiumGroundMaterial, 'type' | 'fragmentShader' | 'uniforms' | 'defines'>,
	fragmentCull: boolean,
): GroundShaderSourcePair {
	const systemDefines = fragmentCull ? [ 'C23_FRAGMENT_CULL 1' ] : [];
	return Object.freeze( {
		vertexShader: assembleGroundVertexShader( {
			kind,
			pass: 'color',
			systemDefines,
			sections: {
				declarations: CLASSIFICATION_COLOR_VERTEX_DECLARATIONS,
				attributes: CLASSIFICATION_ATTRIBUTES,
				helpers: CLASSIFICATION_RTE_VERTEX_HELPER,
				main: CLASSIFICATION_COLOR_VERTEX_MAIN,
			},
		} ),
		fragmentShader: assembleGroundFragmentShader( {
			mode: 'material',
			kind,
			pass: 'color',
			material,
			systemDefines,
			sections: {
				declarations: CLASSIFICATION_COLOR_FRAGMENT_DECLARATIONS,
				helpers: CLASSIFICATION_COLOR_FRAGMENT_HELPERS,
				mainPrologue: CLASSIFICATION_COLOR_MAIN_PROLOGUE,
				inputAssignments: CLASSIFICATION_COLOR_INPUT_ASSIGNMENTS,
			},
		} ),
	} );
}
