// ============================================================
// materials.ts
// Layer: Cesium-to-Three ground shader/material bridge.
// Role: translate Cesium GroundPrimitive shader snippets into Three
//       RawShaderMaterial instances while preserving Cesium stencil/color
//       command semantics, including the Cesium LOG_DEPTH path.
// Dependencies: Three.js material state and unmodified Cesium GLSL sources.
// Consumed by: classification.ts and depth.ts.
// ============================================================

import {
	AddEquation,
	AlwaysStencilFunc,
	CustomBlending,
	DoubleSide,
	KeepStencilOp,
	LessEqualDepth,
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

// Three.js's RawShaderMaterial does not run Cesium ShaderSource's automatic
// LOG_DEPTH wrapping (which adds czm_vertexLogDepth() / czm_writeLogDepth()
// calls to main()). We replicate that injection manually below. The
// `LOG_DEPTH` define controls whether the gl_FragDepth path is active in
// both the GLSL source and the matching Three render state.
const ENABLE_LOG_DEPTH = true;

/**
 * Cesium-equivalent log-depth helpers expressed in GLSL3. Behaviour matches
 * the stock Cesium snippets byte-for-byte in the parts that affect the
 * Z-fail stencil shadow volume pipeline:
 *
 * - `czm_vertexLogDepth()` writes `v_depthFromNearPlusOne` and clamps
 *   `gl_Position.z` to `[-w, w]` so a vertex that landed outside that
 *   range due to log-depth precision still reaches the fragment shader
 *   (emulates GL_DEPTH_CLAMP for the vertex stage; matches
 *   {@link czm_updatePositionDepth} in Cesium's vertexLogDepth.glsl).
 *
 * - `czm_writeLogDepth()` uses Cesium's `log2(depth) /
 *   log2(czm_farDepthFromNearPlusOne)` formula and **discards** fragments
 *   outside the frustum. This is **the critical bit** for shadow volumes:
 *   a previous revision of this file clamped to `gl_FragDepth = 0.0` /
 *   `1.0` instead, with a comment claiming it kept stencil counts intact
 *   under a single frustum. That reasoning was wrong:
 *     - A *back* face that crosses the far plane, clamped to
 *       `gl_FragDepth = 1.0`, **fails** the LessEqual depth test
 *       (`1.0 > terrain_depth`) and runs `stencilZFail = INCR_WRAP`. That
 *       contributes an extra +1 to the stencil for the pixel.
 *     - A *front* face that crosses the far plane gives the symmetric
 *       extra -1 (DECR_WRAP).
 *     - The two only cancel when both faces project onto the same pixel.
 *       For a shadow-volume box clipped asymmetrically by the far plane
 *       (the far-camera side of the box past the plane, the near-camera
 *       side still in-frustum), some terrain pixels are only touched by
 *       the clipped face's stray ±1, while other pixels see only the
 *       in-frustum face's normal contribution. The mismatch leaves a
 *       visible curved band where the stencil net flips between
 *       "inside" and "outside" the volume — exactly the artefact
 *       observed when the arrow primitives' tall shadow volumes started
 *       getting clipped by `camera.far = horizonDistance + 0.1`.
 *
 *   Cesium's discard avoids this entirely: the clipped face simply
 *   doesn't write to the stencil at all, so it neither over- nor
 *   under-counts.
 *
 * - **Terrain log-depth** in `terrain-log-depth.ts` still uses the
 *   clamp-to-0/1 form on purpose: terrain has no stencil pass, and the
 *   clamp prevents log-depth precision rounding from accidentally
 *   discarding terrain that *just barely* oversteps the frustum (the
 *   original justification for clamping). The shadow-volume stencil
 *   pass has a stricter correctness requirement and must discard.
 */
const LOG_DEPTH_VERTEX_HELPERS = /* glsl */ `
#ifdef LOG_DEPTH
out float v_depthFromNearPlusOne;

void czm_vertexLogDepth() {
	v_depthFromNearPlusOne = ( gl_Position.w - czm_currentFrustum.x ) + 1.0;
	gl_Position.z = clamp( gl_Position.z / gl_Position.w, - 1.0, 1.0 ) * gl_Position.w;
}
#endif
`;

const LOG_DEPTH_FRAGMENT_HELPERS = /* glsl */ `
#ifdef LOG_DEPTH
in float v_depthFromNearPlusOne;

void czm_writeLogDepth( float depth ) {
	// Match Cesium writeLogDepth.glsl exactly: drop the fragment when its
	// log-depth value sits past the near or far plane. For shadow-volume
	// stencil correctness we'd rather miss a fragment entirely (= zero
	// contribution to the +1/-1 stencil tally) than synthesize a
	// fake-far-plane fragment that always depth-fails and feeds a
	// phantom DECR_WRAP / INCR_WRAP into the stencil.
	if ( depth <= 0.9999999 || depth > czm_farDepthFromNearPlusOne ) {
		discard;
	}
	gl_FragDepth = log2( depth ) * czm_oneOverLog2FarDepthFromNearPlusOne;
}

void czm_writeLogDepth() {
	czm_writeLogDepth( v_depthFromNearPlusOne );
}
#endif
`;

/**
 * Wraps a shader's `main()` into a renamed inner function and replaces it
 * with a new `main()` that calls the inner function then runs `appended`.
 * Mirrors Cesium ShaderSource.replaceMain + DerivedCommand log depth wrap.
 *
 * @param source GLSL source containing exactly one `void main()` definition.
 * @param innerName Replacement name for the original `main()` body.
 * @param appended GLSL statements injected after the original main runs.
 * @returns Wrapped GLSL with a new `void main()` calling the renamed body.
 */
function wrapShaderMain( source: string, innerName: string, appended: string ): string {
	const pattern = /void\s+main\s*\(\s*(?:void\s*)?\)/;
	if ( ! pattern.test( source ) ) {
		throw new Error( `Cesium shader wrap failed: no void main() found while injecting ${ innerName }.` );
	}
	const renamed = source.replace( pattern, `void ${ innerName }()` );

	return /* glsl */ `${ renamed }
void main() {
	${ innerName }();
	${ appended }
}
`;
}

/**
 * Creates the vertex prefix that supplies Cesium automatic uniforms, batch
 * table hooks, and LOG_DEPTH helpers to the shadow-volume vertex shader.
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
uniform vec3 czm_currentFrustum;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;

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

${ LOG_DEPTH_VERTEX_HELPERS }
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
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
uniform vec4 u_borderColor;
uniform float u_borderEnabled;
uniform float u_borderWidthMeters;
uniform vec4 u_innerMetersRect;
uniform vec4 u_cpuWestPlane;
uniform vec4 u_cpuSouthPlane;
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

// Wraps an angle into [0, 2π) so circle sector tests can compare a
// fragment's azimuth against the configured start without sign confusion.
float c23_wrappedPositiveAngle(float radians) {
	float wrapped = mod(radians, czm_twoPi);
	return wrapped < 0.0 ? wrapped + czm_twoPi : wrapped;
}

// Even-odd ray-casting point-in-polygon test against the planar-meter fill
// vertices supplied via setPolygonBorderPoints. Iterating up to
// MAX_POLYGON_STYLE_VERTICES with an early break keeps the loop bounded for
// older WebGL drivers that disallow non-constant loop bounds.
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

float c23_distanceToPolygonEdges(vec2 point) {
	float minDistance = 1.0e20;
	int count = int(u_polygonPointCount);

	for (int i = 0; i < ${ MAX_POLYGON_STYLE_VERTICES }; i++) {
		if (i >= count) {
			break;
		}

		int nextIndex = i + 1 >= count ? 0 : i + 1;
		vec2 start = u_polygonPoints[i];
		vec2 end = u_polygonPoints[nextIndex];
		vec2 edge = end - start;
		float edgeLengthSquared = dot(edge, edge);
		float segmentT = edgeLengthSquared > 1e-12
			? clamp(dot(point - start, edge) / edgeLengthSquared, 0.0, 1.0)
			: 0.0;
		vec2 closest = start + edge * segmentT;
		minDistance = min(minDistance, distance(point, closest));
	}

	return minDistance;
}

${ cesiumUnpackDepth }
${ cesiumWindowToEyeCoordinates }
${ cesiumPlaneDistance }
${ cesiumGammaCorrect }

${ LOG_DEPTH_FRAGMENT_HELPERS }
`;
}

/**
 * Creates a shader that packs gl_FragCoord.z with Cesium czm_packDepth in
 * non-log-depth mode, or packs the Cesium log-depth value when LOG_DEPTH is
 * active. Either way, the result mirrors what czm_unpackDepth in
 * ShadowVolumeAppearanceFS expects, so czm_screenToEyeCoordinates can rebuild
 * eye coordinates correctly inside the color command's fragment shader.
 *
 * @returns RawShaderMaterial used by the globe depth pass.
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

// Globe-depth pack pass: discards out-of-frustum terrain fragments so the
// packed-color render target stays at its cleared sentinel (0,0,0,0)
// (set in depth.ts via setClearColor(0x000000, 0.0), matching Cesium's
// GlobeDepth.js:226 Color(0,0,0,0) clear).
//
// Why discard instead of clamping to 0.0 / 1.0:
//   The classification color pass reads this packed depth and reconstructs
//   the terrain world position via czm_unpackDepth + czm_windowToEye-
//   Coordinates. The Cesium ShadowVolumeAppearanceFS CULL_FRAGMENTS branch
//   only honours ONE sentinel (logDepthOrDepth == 0.0) to mean "no terrain
//   here, skip". Past-far-plane fragments written as 1.0 sneak past that
//   check and feed czm_windowToEyeCoordinates(fragCoord, 1.0) - a fake
//   position parked AT the far plane in the camera's view direction. The
//   shape-specific bounds test then runs on that fake uv:
//     - Circle's radius test happens to discard for far-away fake positions
//       (rotationally symmetric, robust)
//     - Polygon's point-in-polygon and rectangle's axis-aligned-bbox tests
//       can give either result depending on where camera-forward points,
//       which produces a wrong fill outline along the camera-far-plane ×
//       ellipsoid curve.
//
//   Cesium-style discard keeps the packed-color at cleared-0 so the same
//   CULL_FRAGMENTS check catches both "no terrain" AND "terrain past
//   frustum" with one branch, no shape-specific tuning needed.
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
    vec3 cpuPlaneEyeCoordinate = eyeCoordinate.xyz / eyeCoordinate.w;
    vec2 planarMeters = vec2(
        czm_planeDistance(u_cpuWestPlane, cpuPlaneEyeCoordinate),
        czm_planeDistance(u_cpuSouthPlane, cpuPlaneEyeCoordinate)
    );
    if (u_circleBorderMode > 0.5) {
        // Circle path: ring + sector decoration in the planar meter frame.
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
        // Polygon stroke path: planar-meter point-in-polygon test against the
        // original fill ring. Fragments outside the fill ring become the
        // border colour up to u_borderWidthMeters away from the edge, then
        // discard so the extruded shadow volume does not paint past the
        // requested stroke band.
        bool insideFillPolygon = c23_pointInsidePolygon(planarMeters);
        if (!insideFillPolygon) {
            float outsideDistanceMeters = c23_distanceToPolygonEdges(planarMeters);
            if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0 || outsideDistanceMeters > u_borderWidthMeters) {
                discard;
            }
            color = czm_gammaCorrect(u_borderColor);
        }
    } else {
        // Rectangle (axis-aligned) stroke path: unchanged behaviour.
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
 * Combines all shared defines, including LOG_DEPTH when enabled.
 */
function combineDefines( ...lists: readonly ( string | undefined )[][] ): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	for ( const list of lists ) {
		for ( const define of list ) {
			if ( typeof define !== 'string' || define.length === 0 ) {
				continue;
			}
			if ( seen.has( define ) ) {
				continue;
			}
			seen.add( define );
			out.push( define );
		}
	}

	if ( ENABLE_LOG_DEPTH && ! seen.has( 'LOG_DEPTH' ) ) {
		out.push( 'LOG_DEPTH' );
	}

	return out;
}

/**
 * Wraps the Cesium shadow-volume vertex source with the LOG_DEPTH main()
 * postlude so czm_vertexLogDepth() runs after gl_Position is finalized.
 */
function buildStencilVertexShader(): string {
	const innerName = 'czm_shadow_volume_stencil_main_vs';
	const append = ENABLE_LOG_DEPTH ? 'czm_vertexLogDepth();' : '';

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( cesiumShadowVolumeAppearanceVS, innerName, append )
		: cesiumShadowVolumeAppearanceVS;
}

function buildColorVertexShader(): string {
	const innerName = 'czm_shadow_volume_color_main_vs';
	const append = ENABLE_LOG_DEPTH ? 'czm_vertexLogDepth();' : '';

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( cesiumShadowVolumeAppearanceVS, innerName, append )
		: cesiumShadowVolumeAppearanceVS;
}

function buildStencilFragmentShader(): string {
	const innerName = 'czm_shadow_volume_stencil_main_fs';
	const append = ENABLE_LOG_DEPTH ? 'czm_writeLogDepth();' : '';

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( cesiumShadowVolumeFS, innerName, append )
		: cesiumShadowVolumeFS;
}

function buildColorFragmentShader(): string {
	const innerName = 'czm_shadow_volume_color_main_fs';
	const append = ENABLE_LOG_DEPTH ? 'czm_writeLogDepth();' : '';
	const body = createColorFragmentBody();

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( body, innerName, append )
		: body;
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
	const defines = combineDefines( [ 'EXTRUDED_GEOMETRY' ] );
	const vertexShader = buildStencilVertexShader();
	const fragmentShader = buildStencilFragmentShader();

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( defines ) }\n${ vertexShader }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ fragmentShader }`,
		side,
		colorWrite: false,
		depthWrite: false,
		depthTest: true,
		// Cesium getStencilDepthRenderState uses DepthFunction.LESS_OR_EQUAL.
		// Three.js defaults to LessDepth, which silently drops the stencil
		// op whenever the shadow volume face coincides with terrain depth.
		depthFunc: LessEqualDepth,
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
	const defines = combineDefines( [
		'EXTRUDED_GEOMETRY',
		'TEXTURE_COORDINATES',
		fragmentCull ? 'CULL_FRAGMENTS' : '',
		'PER_INSTANCE_COLOR',
		'FLAT',
		'REQUIRES_EC',
		'CESIUM_THREE_BORDER',
	] );

	const vertexShader = buildColorVertexShader();
	const fragmentShader = buildColorFragmentShader();

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( defines ) }\n${ vertexShader }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ fragmentShader }`,
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

export { ENABLE_LOG_DEPTH };
