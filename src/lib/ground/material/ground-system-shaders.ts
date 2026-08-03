// ============================================================
// material/ground-system-shaders.ts
// Purpose: trusted, pass-specific GLSL sections consumed by the explicit
//          assembler. These sections own geometry, depth reconstruction,
//          membership, and coverage; safe user source only owns appearance.
// ============================================================

import {
	MAX_POLYGON_STYLE_VERTICES,
	SCENE_MODE_3D,
	WGS84_X_RADIUS,
	WGS84_Z_RADIUS,
} from '../constants';
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

// ---------------------------------------------------------------------------
// Polyline depth-reconstruction pass
// ---------------------------------------------------------------------------

const POLYLINE_VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_projection;
uniform mat3 czm_normal;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;
uniform vec4 czm_viewport;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_pixelRatio;

uniform float c23_lineWidthPixels;
uniform float c23_lineWidthMode;
uniform float c23_lineWidthMeters;
`;

const POLYLINE_ATTRIBUTES = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 startHiAndForwardOffsetX;
in vec4 startLoAndForwardOffsetY;
in vec4 startNormalAndForwardOffsetZ;
in vec4 endNormalAndTextureCoordinateNormalizationX;
in vec4 rightNormalAndTextureCoordinateNormalizationY;
in float batchId;
`;

const POLYLINE_VARYINGS = /* glsl */ `
out vec4 c23_startPlaneNormalEcAndHalfWidth;
out vec4 c23_endPlaneNormalEcAndBatchId;
out vec4 c23_rightPlaneEC;
out vec4 c23_endEcAndStartEcX;
out vec4 c23_texcoordNormalizationAndStartEcYZ;
`;

/** Shared metric helpers used by the conservative line-box vertex stage. */
const POLYLINE_VERTEX_HELPERS = /* glsl */ `
vec4 c23_translateRelativeToEye(vec3 high, vec3 low) {
	vec3 highDifference = high - czm_encodedCameraPositionMCHigh;
	vec3 lowDifference = low - czm_encodedCameraPositionMCLow;
	return vec4(highDifference + lowDifference, 1.0);
}

float c23_planeDistance(vec4 plane, vec3 point) {
	return dot(plane.xyz, point) + plane.w;
}

float c23_branch(bool condition, float whenTrue, float whenFalse) {
	return condition ? whenTrue : whenFalse;
}

vec3 c23_branch(bool condition, vec3 whenTrue, vec3 whenFalse) {
	return condition ? whenTrue : whenFalse;
}

float c23_metersPerPixel(vec4 positionEC) {
	float width = czm_viewport.z;
	float height = czm_viewport.w;
	float top = czm_frustumPlanes.x;
	float bottom = czm_frustumPlanes.y;
	float left = czm_frustumPlanes.z;
	float right = czm_frustumPlanes.w;
	float pixelWidth;
	float pixelHeight;
	if (czm_sceneMode == 2.0) {
		pixelWidth = (right - left) / width;
		pixelHeight = (top - bottom) / height;
	} else {
		float distanceToPixel = -positionEC.z;
		float inverseNear = 1.0 / czm_currentFrustum.x;
		pixelHeight = 2.0 * distanceToPixel * top * inverseNear / height;
		pixelWidth = 2.0 * distanceToPixel * right * inverseNear / width;
	}
	return max(pixelWidth, pixelHeight) * czm_pixelRatio;
}
`;

/**
 * Preserves the current segment-box algorithm: endpoint planes are rotated to
 * eye coordinates, bottom vertices extend conservatively, and each side moves
 * by twice the requested half-width so sub-pixel movement cannot expose gaps.
 */
const POLYLINE_VERTEX_MAIN = /* glsl */ `
void main() {
	vec3 ecStart = (czm_modelViewRelativeToEye * c23_translateRelativeToEye(
		startHiAndForwardOffsetX.xyz,
		startLoAndForwardOffsetY.xyz
	)).xyz;
	vec3 forwardOffsetEC = czm_normal * vec3(
		startHiAndForwardOffsetX.w,
		startLoAndForwardOffsetY.w,
		startNormalAndForwardOffsetZ.w
	);
	vec3 ecEnd = ecStart + forwardOffsetEC;
	vec3 forwardDirectionEC = normalize(forwardOffsetEC);

	vec4 startPlaneEC;
	startPlaneEC.xyz = czm_normal * startNormalAndForwardOffsetZ.xyz;
	startPlaneEC.w = -dot(startPlaneEC.xyz, ecStart);
	vec4 endPlaneEC;
	endPlaneEC.xyz = czm_normal * endNormalAndTextureCoordinateNormalizationX.xyz;
	endPlaneEC.w = -dot(endPlaneEC.xyz, ecEnd);
	c23_rightPlaneEC.xyz = czm_normal * rightNormalAndTextureCoordinateNormalizationY.xyz;
	c23_rightPlaneEC.w = -dot(c23_rightPlaneEC.xyz, ecStart);

	c23_texcoordNormalizationAndStartEcYZ.x = abs(endNormalAndTextureCoordinateNormalizationX.w);
	c23_texcoordNormalizationAndStartEcYZ.y = rightNormalAndTextureCoordinateNormalizationY.w;
	c23_endEcAndStartEcX.xyz = ecEnd;
	c23_endEcAndStartEcX.w = ecStart.x;
	c23_texcoordNormalizationAndStartEcYZ.zw = ecStart.yz;

	vec4 positionRelativeToEye = c23_translateRelativeToEye(position3DHigh, position3DLow);
	vec4 positionEC = czm_modelViewRelativeToEye * positionRelativeToEye;
	float startDistance = abs(c23_planeDistance(startPlaneEC, positionEC.xyz));
	float endDistance = abs(c23_planeDistance(endPlaneEC, positionEC.xyz));
	vec3 planeDirection = c23_branch(
		startDistance < endDistance,
		startPlaneEC.xyz,
		endPlaneEC.xyz
	);
	vec3 upOrDown = normalize(cross(c23_rightPlaneEC.xyz, planeDirection));
	vec3 normalEC = normalize(cross(planeDirection, upOrDown));

	upOrDown = cross(forwardDirectionEC, normalEC);
	upOrDown *= float(
		c23_texcoordNormalizationAndStartEcYZ.y > 1.0 ||
		c23_texcoordNormalizationAndStartEcYZ.y < 0.0
	);
	upOrDown *= min(
		55000.0,
		czm_geometricToleranceOverMeter * length(positionRelativeToEye.xyz)
	);
	positionEC.xyz += upOrDown;
	c23_texcoordNormalizationAndStartEcYZ.y = c23_branch(
		c23_texcoordNormalizationAndStartEcYZ.y > 1.0,
		0.0,
		abs(c23_texcoordNormalizationAndStartEcYZ.y)
	);

	float fullWidth = c23_branch(
		c23_lineWidthMode > 0.5,
		c23_lineWidthMeters,
		c23_lineWidthPixels
	);
	c23_startPlaneNormalEcAndHalfWidth = vec4(startPlaneEC.xyz, fullWidth * 0.5);
	c23_endPlaneNormalEcAndBatchId = vec4(endPlaneEC.xyz, batchId);
	float pushMeters = c23_branch(
		c23_lineWidthMode > 0.5,
		fullWidth,
		fullWidth * max(0.0, c23_metersPerPixel(positionEC))
	);
	float miterProjection = dot(normalEC, c23_rightPlaneEC.xyz);
	pushMeters /= abs(miterProjection) > 1e-6 ? miterProjection : 1e-6;
	normalEC *= sign(endNormalAndTextureCoordinateNormalizationX.w);
	positionEC.xyz += pushMeters * normalEC;

	gl_Position = czm_projection * positionEC;
	gl_Position.z = clamp(gl_Position.z / gl_Position.w, -1.0, 1.0) * gl_Position.w;
}
`;

const POLYLINE_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D czm_globeDepthTexture;
uniform vec4 czm_viewport;
uniform mat4 czm_inverseProjection;
uniform mat4 czm_modelViewRelativeToEye;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform float czm_sceneMode;
uniform float czm_pixelRatio;

uniform vec4 c23_lineColor;
uniform float c23_lineWidthMode;
uniform float c23_lineTotalMeters;
uniform float c23_arrowWidthMode;
uniform float c23_arrowLengthPixels;
uniform float c23_arrowHalfWidthPixels;
uniform float c23_arrowLengthMeters;
uniform float c23_arrowHalfWidthMeters;
uniform float c23_lineArrowClipEndEnabled;
uniform float c23_lineArrowClipStartEnabled;
uniform float c23_lineArrowStyleStart;
uniform float c23_lineArrowStyleEnd;
`;

const POLYLINE_FRAGMENT_VARYINGS = /* glsl */ `
in vec4 c23_startPlaneNormalEcAndHalfWidth;
in vec4 c23_endPlaneNormalEcAndBatchId;
in vec4 c23_rightPlaneEC;
in vec4 c23_endEcAndStartEcX;
in vec4 c23_texcoordNormalizationAndStartEcYZ;
`;

/** Depth, horizon, ellipsoid, plane, and CSS-pixel helpers for line membership. */
const POLYLINE_FRAGMENT_HELPERS = /* glsl */ `
const float c23_polylineFarDepthEpsilon = 0.999999;
const float c23_polylineEmptyDepthEpsilon = 0.0000001;
const float c23_polylineScreenEpsilon = 0.0000001;
const float c23_polylineRayEpsilon = 0.0000001;
const float c23_polylineHorizonRadiusMeters = ${ WGS84_X_RADIUS.toFixed( 1 ) };
const float c23_polylineHorizonMarginMeters = 512000.0;
const vec3 c23_oneOverWgs84Radii = vec3(
	${ ( 1.0 / WGS84_X_RADIUS ).toExponential( 16 ) },
	${ ( 1.0 / WGS84_X_RADIUS ).toExponential( 16 ) },
	${ ( 1.0 / WGS84_Z_RADIUS ).toExponential( 16 ) }
);

float c23_unpackDepth(vec4 packedDepth) {
	return dot(packedDepth, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

float c23_planeDistance(vec4 plane, vec3 point) {
	return dot(plane.xyz, point) + plane.w;
}

float c23_planeDistance(vec3 normal, float distance, vec3 point) {
	return dot(normal, point) + distance;
}

float c23_branch(bool condition, float whenTrue, float whenFalse) {
	return condition ? whenTrue : whenFalse;
}

vec2 c23_polylineScreenCoordinate(vec2 fragmentCoordinate) {
	return (fragmentCoordinate - czm_viewport.xy) / czm_viewport.zw;
}

bool c23_polylineScreenCoordinateIsInvalid(vec2 screenCoordinate) {
	return screenCoordinate.x < -c23_polylineScreenEpsilon
		|| screenCoordinate.y < -c23_polylineScreenEpsilon
		|| screenCoordinate.x > 1.0 + c23_polylineScreenEpsilon
		|| screenCoordinate.y > 1.0 + c23_polylineScreenEpsilon;
}

vec4 c23_polylineFetchPackedDepth(vec2 screenCoordinate) {
	ivec2 depthSize = textureSize(czm_globeDepthTexture, 0);
	vec2 maximumTexel = vec2(depthSize) - vec2(1.0);
	vec2 texel = clamp(screenCoordinate * vec2(depthSize), vec2(0.0), maximumTexel);
	return texelFetch(czm_globeDepthTexture, ivec2(floor(texel)), 0);
}

bool c23_polylineDepthIsInvalid(float depth) {
	return depth <= c23_polylineEmptyDepthEpsilon || depth >= c23_polylineFarDepthEpsilon;
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

float c23_metersPerPixel(vec3 positionEC) {
	float top = czm_frustumPlanes.x;
	float bottom = czm_frustumPlanes.y;
	float left = czm_frustumPlanes.z;
	float right = czm_frustumPlanes.w;
	float pixelWidth;
	float pixelHeight;
	if (czm_sceneMode == 2.0) {
		pixelWidth = (right - left) / czm_viewport.z;
		pixelHeight = (top - bottom) / czm_viewport.w;
	} else {
		float inverseNear = 1.0 / czm_currentFrustum.x;
		pixelHeight = 2.0 * -positionEC.z * top * inverseNear / czm_viewport.w;
		pixelWidth = 2.0 * -positionEC.z * right * inverseNear / czm_viewport.z;
	}
	return max(pixelWidth, pixelHeight) * czm_pixelRatio;
}

bool c23_polylineEyePointBeyondHorizon(vec3 eyePoint) {
	vec3 cameraModel = czm_encodedCameraPositionMCHigh + czm_encodedCameraPositionMCLow;
	float cameraRadius = length(cameraModel);
	float horizonDistance = sqrt(max(
		cameraRadius * cameraRadius
			- c23_polylineHorizonRadiusMeters * c23_polylineHorizonRadiusMeters,
		0.0
	));
	return length(eyePoint) > horizonDistance + c23_polylineHorizonMarginMeters;
}

bool c23_polylineRayMissesEllipsoid(vec2 screenCoordinate) {
	vec4 clipCoordinate = vec4(screenCoordinate * 2.0 - 1.0, -1.0, 1.0);
	vec4 eyeCoordinate = czm_inverseProjection * clipCoordinate;
	vec3 eyeDirection = normalize(eyeCoordinate.xyz);
	vec3 rayDirectionModel = normalize(
		transpose(mat3(czm_modelViewRelativeToEye)) * eyeDirection
	);
	vec3 cameraModel = czm_encodedCameraPositionMCHigh + czm_encodedCameraPositionMCLow;
	vec3 scaledOrigin = cameraModel * c23_oneOverWgs84Radii;
	vec3 scaledDirection = normalize(rayDirectionModel * c23_oneOverWgs84Radii);
	float b = dot(scaledOrigin, scaledDirection);
	float c = dot(scaledOrigin, scaledOrigin) - 1.0;
	if (c <= 0.0) return false;
	float discriminant = b * b - c;
	if (discriminant < -c23_polylineRayEpsilon) return true;
	return -b + sqrt(max(discriminant, 0.0)) < 0.0;
}
`;

/**
 * All rejection here belongs to system membership and is legal because line
 * passes do not use stencil. Once this prologue reaches the Material call,
 * transparent user output writes zero color instead of discarding.
 */
const POLYLINE_MAIN_PROLOGUE = /* glsl */ `
vec2 c23_screenCoordinate = c23_polylineScreenCoordinate(gl_FragCoord.xy);
if (c23_polylineScreenCoordinateIsInvalid(c23_screenCoordinate)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(1.0, 0.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}
float c23_depth = c23_unpackDepth(c23_polylineFetchPackedDepth(c23_screenCoordinate));
if (c23_polylineDepthIsInvalid(c23_depth) || c23_polylineRayMissesEllipsoid(c23_screenCoordinate)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(1.0, 0.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_positionEC = c23_reconstructEyePosition(gl_FragCoord.xy, c23_depth);
if (c23_polylineEyePointBeyondHorizon(c23_positionEC)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(1.0, 0.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_ecStart = vec3(
	c23_endEcAndStartEcX.w,
	c23_texcoordNormalizationAndStartEcYZ.zw
);
float c23_mpp = c23_metersPerPixel(c23_positionEC);
float c23_halfWidthMeters = c23_branch(
	c23_lineWidthMode > 0.5,
	c23_startPlaneNormalEcAndHalfWidth.w,
	c23_startPlaneNormalEcAndHalfWidth.w * c23_mpp
);
float c23_acrossMeters = c23_planeDistance(c23_rightPlaneEC, c23_positionEC);
float c23_distanceFromStart = c23_planeDistance(
	c23_startPlaneNormalEcAndHalfWidth.xyz,
	-dot(c23_ecStart, c23_startPlaneNormalEcAndHalfWidth.xyz),
	c23_positionEC
);
float c23_distanceFromEnd = c23_planeDistance(
	c23_endPlaneNormalEcAndBatchId.xyz,
	-dot(c23_endEcAndStartEcX.xyz, c23_endPlaneNormalEcAndBatchId.xyz),
	c23_positionEC
);
if (
	abs(c23_acrossMeters) > c23_halfWidthMeters ||
	c23_distanceFromStart < 0.0 ||
	c23_distanceFromEnd < 0.0
) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(1.0, 0.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_alignedPlaneNormal = cross(
	c23_rightPlaneEC.xyz,
	c23_startPlaneNormalEcAndHalfWidth.xyz
);
c23_alignedPlaneNormal = normalize(cross(c23_alignedPlaneNormal, c23_rightPlaneEC.xyz));
c23_distanceFromStart = c23_planeDistance(
	c23_alignedPlaneNormal,
	-dot(c23_alignedPlaneNormal, c23_ecStart),
	c23_positionEC
);
c23_alignedPlaneNormal = cross(
	c23_rightPlaneEC.xyz,
	c23_endPlaneNormalEcAndBatchId.xyz
);
c23_alignedPlaneNormal = normalize(cross(c23_alignedPlaneNormal, c23_rightPlaneEC.xyz));
c23_distanceFromEnd = c23_planeDistance(
	c23_alignedPlaneNormal,
	-dot(c23_alignedPlaneNormal, c23_endEcAndStartEcX.xyz),
	c23_positionEC
);

float c23_segmentRatio = clamp(
	c23_distanceFromStart / max(c23_distanceFromStart + c23_distanceFromEnd, 1e-6),
	0.0,
	1.0
);
float c23_globalRatio = c23_segmentRatio * c23_texcoordNormalizationAndStartEcYZ.x
	+ c23_texcoordNormalizationAndStartEcYZ.y;
float c23_distanceAlongMeters = c23_globalRatio * c23_lineTotalMeters;

if (c23_lineArrowClipEndEnabled > 0.5) {
	float arrowLength = c23_branch(
		c23_arrowWidthMode > 0.5,
		c23_arrowLengthMeters,
		c23_arrowLengthPixels * c23_mpp
	);
	float distanceFromGlobalEnd = (1.0 - c23_globalRatio) * c23_lineTotalMeters;
	if (distanceFromGlobalEnd < arrowLength && arrowLength > 0.0) {
		if (int(c23_lineArrowStyleEnd + 0.5) == 1) {
			float arrowHalfWidth = c23_branch(
				c23_arrowWidthMode > 0.5,
				c23_arrowHalfWidthMeters,
				c23_arrowHalfWidthPixels * c23_mpp
			);
			if (abs(c23_acrossMeters) > arrowHalfWidth * distanceFromGlobalEnd / arrowLength) discard;
		} else {
			discard;
		}
	}
}
if (c23_lineArrowClipStartEnabled > 0.5) {
	float arrowLength = c23_branch(
		c23_arrowWidthMode > 0.5,
		c23_arrowLengthMeters,
		c23_arrowLengthPixels * c23_mpp
	);
	float distanceFromGlobalStart = c23_globalRatio * c23_lineTotalMeters;
	if (distanceFromGlobalStart < arrowLength && arrowLength > 0.0) {
		if (int(c23_lineArrowStyleStart + 0.5) == 1) {
			float arrowHalfWidth = c23_branch(
				c23_arrowWidthMode > 0.5,
				c23_arrowHalfWidthMeters,
				c23_arrowHalfWidthPixels * c23_mpp
			);
			if (abs(c23_acrossMeters) > arrowHalfWidth * distanceFromGlobalStart / arrowLength) discard;
		} else {
			discard;
		}
	}
}

vec3 c23_derivativeX = dFdx(c23_positionEC);
vec3 c23_derivativeY = dFdy(c23_positionEC);
vec3 c23_normalEC = normalize(cross(c23_derivativeX, c23_derivativeY));
if (dot(c23_normalEC, -c23_positionEC) < 0.0) c23_normalEC = -c23_normalEC;
`;

const POLYLINE_INPUT_ASSIGNMENTS = /* glsl */ `
c23_input.st = vec2(
	c23_lineTotalMeters > 0.0 ? c23_distanceAlongMeters / c23_lineTotalMeters : 0.0,
	c23_halfWidthMeters > 0.0
		? clamp(c23_acrossMeters / (2.0 * c23_halfWidthMeters) + 0.5, 0.0, 1.0)
		: 0.5
);
c23_input.localMeters = vec2(c23_distanceAlongMeters, c23_acrossMeters);
c23_input.baseColor = c23_lineColor;
c23_input.isStroke = 1.0;
c23_input.positionEC = c23_positionEC;
c23_input.positionToEyeEC = -c23_positionEC;
c23_input.normalEC = c23_normalEC;
c23_input.distanceAlongMeters = c23_distanceAlongMeters;
c23_input.distanceAcrossMeters = c23_acrossMeters;
c23_input.lineTotalMeters = c23_lineTotalMeters;
c23_input.metersPerPixel = c23_mpp;
`;

/** Builds the complete safe polyline source pair. */
export function createGroundPolylineShaders(
	material: Pick<CesiumGroundMaterial, 'type' | 'fragmentShader' | 'uniforms' | 'defines'>,
	debugVolume: boolean,
): GroundShaderSourcePair {
	const systemDefines = debugVolume ? [ 'C23_DEBUG_VOLUME 1' ] : [];
	return Object.freeze( {
		vertexShader: assembleGroundVertexShader( {
			kind: 'polyline',
			pass: 'polyline',
			systemDefines,
			sections: {
				declarations: POLYLINE_VERTEX_DECLARATIONS,
				attributes: POLYLINE_ATTRIBUTES,
				varyings: POLYLINE_VARYINGS,
				helpers: POLYLINE_VERTEX_HELPERS,
				main: POLYLINE_VERTEX_MAIN,
			},
		} ),
		fragmentShader: assembleGroundFragmentShader( {
			mode: 'material',
			kind: 'polyline',
			pass: 'polyline',
			material,
			systemDefines,
			sections: {
				declarations: POLYLINE_FRAGMENT_DECLARATIONS,
				varyings: POLYLINE_FRAGMENT_VARYINGS,
				helpers: POLYLINE_FRAGMENT_HELPERS,
				mainPrologue: POLYLINE_MAIN_PROLOGUE,
				inputAssignments: POLYLINE_INPUT_ASSIGNMENTS,
			},
		} ),
	} );
}

// ---------------------------------------------------------------------------
// Arrowhead depth-reconstruction pass
// ---------------------------------------------------------------------------

const ARROW_VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_projection;
uniform mat3 czm_normal;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;
uniform vec4 czm_viewport;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_pixelRatio;

uniform float c23_arrowWidthMode;
uniform float c23_arrowLengthPixels;
uniform float c23_arrowHalfWidthPixels;
uniform float c23_arrowLengthMeters;
uniform float c23_arrowHalfWidthMeters;
`;

const ARROW_ATTRIBUTES = /* glsl */ `
in vec3 arrowTipHigh;
in vec3 arrowTipLow;
in vec3 arrowBackDir;
in vec3 arrowRightDir;
in vec3 arrowUpDir;
in vec3 arrowCorner;
in vec2 arrowTerrainHeights;
in float arrowStyleId;
`;

const ARROW_VARYINGS = /* glsl */ `
out vec3 c23_arrowTipEC;
out vec3 c23_arrowBackEC;
out vec3 c23_arrowRightEC;
flat out float c23_arrowStyle;
`;

/**
 * Builds a conservative terrain-height box around one endpoint. The box is
 * deliberately larger than the final triangle/chevron; the fragment stage
 * performs exact `(a,b)` membership against the reconstructed terrain point.
 */
const ARROW_VERTEX_MAIN = /* glsl */ `
void main() {
	vec4 tipRelativeToEye = c23_translateRelativeToEye(arrowTipHigh, arrowTipLow);
	vec4 tipEC = czm_modelViewRelativeToEye * tipRelativeToEye;
	vec3 backEC = normalize(czm_normal * arrowBackDir);
	vec3 rightEC = normalize(czm_normal * arrowRightDir);
	vec3 upEC = normalize(czm_normal * arrowUpDir);
	c23_arrowTipEC = tipEC.xyz;
	c23_arrowBackEC = backEC;
	c23_arrowRightEC = rightEC;
	c23_arrowStyle = arrowStyleId;

	float metersPerPixel = max(0.0, c23_metersPerPixel(tipEC));
	float lengthMeters = c23_branch(
		c23_arrowWidthMode > 0.5,
		c23_arrowLengthMeters,
		c23_arrowLengthPixels * metersPerPixel
	) * 1.35;
	float halfWidthMeters = c23_branch(
		c23_arrowWidthMode > 0.5,
		c23_arrowHalfWidthMeters,
		c23_arrowHalfWidthPixels * metersPerPixel
	) * 1.35;

	float alongCoefficient = arrowCorner.x;
	float rightSign = arrowCorner.y;
	float topBottomSide = arrowCorner.z;
	vec3 positionEC = tipEC.xyz
		+ backEC * (alongCoefficient * lengthMeters)
		+ rightEC * (rightSign * halfWidthMeters);

	float viewDistance = length(tipRelativeToEye.xyz);
	float extraDrop = min(55000.0, czm_geometricToleranceOverMeter * viewDistance);
	float altitudeOffset = topBottomSide > 0.0
		? arrowTerrainHeights.y
		: arrowTerrainHeights.x - extraDrop;
	positionEC += upEC * altitudeOffset;

	gl_Position = czm_projection * vec4(positionEC, 1.0);
	gl_Position.z = clamp(gl_Position.z / gl_Position.w, -1.0, 1.0) * gl_Position.w;
}
`;

const ARROW_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D czm_globeDepthTexture;
uniform vec4 czm_viewport;
uniform mat4 czm_inverseProjection;
uniform mat4 czm_modelViewRelativeToEye;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform float czm_sceneMode;
uniform float czm_pixelRatio;

uniform float c23_arrowWidthMode;
uniform float c23_arrowLengthPixels;
uniform float c23_arrowHalfWidthPixels;
uniform float c23_arrowLengthMeters;
uniform float c23_arrowHalfWidthMeters;
uniform vec4 c23_arrowColor;
uniform float c23_arrowStrokeHalfPixels;
`;

const ARROW_FRAGMENT_VARYINGS = /* glsl */ `
in vec3 c23_arrowTipEC;
in vec3 c23_arrowBackEC;
in vec3 c23_arrowRightEC;
flat in float c23_arrowStyle;
`;

/**
 * Guard and membership code mirrors the polyline depth contract but evaluates
 * endpoint-local triangle or open-chevron distance. All rejects happen before
 * user Material execution and are legal because arrow has no stencil pass.
 */
const ARROW_MAIN_PROLOGUE = /* glsl */ `
vec2 c23_screenCoordinate = c23_polylineScreenCoordinate(gl_FragCoord.xy);
if (c23_polylineScreenCoordinateIsInvalid(c23_screenCoordinate)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(0.0, 1.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}
float c23_depth = c23_unpackDepth(c23_polylineFetchPackedDepth(c23_screenCoordinate));
if (c23_polylineDepthIsInvalid(c23_depth) || c23_polylineRayMissesEllipsoid(c23_screenCoordinate)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(0.0, 1.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_positionEC = c23_reconstructEyePosition(gl_FragCoord.xy, c23_depth);
if (c23_polylineEyePointBeyondHorizon(c23_positionEC)) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(0.0, 1.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_tipToPosition = c23_positionEC - c23_arrowTipEC;
float c23_arrowA = dot(c23_tipToPosition, c23_arrowBackEC);
float c23_arrowB = dot(c23_tipToPosition, c23_arrowRightEC);
float c23_mpp = c23_metersPerPixel(c23_positionEC);
float c23_arrowLength = c23_branch(
	c23_arrowWidthMode > 0.5,
	c23_arrowLengthMeters,
	c23_arrowLengthPixels * c23_mpp
);
float c23_arrowHalfWidth = c23_branch(
	c23_arrowWidthMode > 0.5,
	c23_arrowHalfWidthMeters,
	c23_arrowHalfWidthPixels * c23_mpp
);

int c23_style = int(c23_arrowStyle + 0.5);
bool c23_insideArrow;
if (c23_style == 1) {
	float c23_lineFactor = c23_arrowLength / max(
		sqrt(
			c23_arrowLength * c23_arrowLength
				+ c23_arrowHalfWidth * c23_arrowHalfWidth
		),
		1e-6
	);
	float c23_edgeDistance = abs(
		abs(c23_arrowB)
			- c23_arrowHalfWidth * (c23_arrowA / max(c23_arrowLength, 1e-6))
	) * c23_lineFactor;
	c23_insideArrow = c23_arrowA >= 0.0
		&& c23_arrowA <= c23_arrowLength
		&& c23_edgeDistance <= c23_arrowStrokeHalfPixels * c23_mpp;
} else {
	c23_insideArrow = c23_arrowA >= 0.0
		&& c23_arrowA <= c23_arrowLength
		&& abs(c23_arrowB) <= c23_arrowHalfWidth
			* (c23_arrowA / max(c23_arrowLength, 1e-6));
}
if (!c23_insideArrow) {
#ifdef C23_DEBUG_VOLUME
	out_FragColor = vec4(0.0, 1.0, 0.0, 0.5);
	return;
#else
	discard;
#endif
}

vec3 c23_derivativeX = dFdx(c23_positionEC);
vec3 c23_derivativeY = dFdy(c23_positionEC);
vec3 c23_normalEC = normalize(cross(c23_derivativeX, c23_derivativeY));
if (dot(c23_normalEC, -c23_positionEC) < 0.0) c23_normalEC = -c23_normalEC;
`;

const ARROW_INPUT_ASSIGNMENTS = /* glsl */ `
c23_input.st = vec2(
	c23_arrowLength > 0.0 ? clamp(c23_arrowA / c23_arrowLength, 0.0, 1.0) : 0.0,
	c23_arrowHalfWidth > 0.0
		? clamp(c23_arrowB / (2.0 * c23_arrowHalfWidth) + 0.5, 0.0, 1.0)
		: 0.5
);
c23_input.localMeters = vec2(c23_arrowA, c23_arrowB);
c23_input.baseColor = c23_arrowColor;
c23_input.isStroke = c23_style == 1 ? 1.0 : 0.0;
c23_input.positionEC = c23_positionEC;
c23_input.positionToEyeEC = -c23_positionEC;
c23_input.normalEC = c23_normalEC;
c23_input.metersPerPixel = c23_mpp;
`;

/** Builds the complete safe arrowhead source pair. */
export function createGroundArrowShaders(
	material: Pick<CesiumGroundMaterial, 'type' | 'fragmentShader' | 'uniforms' | 'defines'>,
	debugVolume: boolean,
): GroundShaderSourcePair {
	const systemDefines = debugVolume ? [ 'C23_DEBUG_VOLUME 1' ] : [];
	return Object.freeze( {
		vertexShader: assembleGroundVertexShader( {
			kind: 'arrow',
			pass: 'arrow',
			systemDefines,
			sections: {
				declarations: ARROW_VERTEX_DECLARATIONS,
				attributes: ARROW_ATTRIBUTES,
				varyings: ARROW_VARYINGS,
				helpers: POLYLINE_VERTEX_HELPERS,
				main: ARROW_VERTEX_MAIN,
			},
		} ),
		fragmentShader: assembleGroundFragmentShader( {
			mode: 'material',
			kind: 'arrow',
			pass: 'arrow',
			material,
			systemDefines,
			sections: {
				declarations: ARROW_FRAGMENT_DECLARATIONS,
				varyings: ARROW_FRAGMENT_VARYINGS,
				helpers: POLYLINE_FRAGMENT_HELPERS,
				mainPrologue: ARROW_MAIN_PROLOGUE,
				inputAssignments: ARROW_INPUT_ASSIGNMENTS,
			},
		} ),
	} );
}
