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
import cesiumMetersPerPixel from '../../../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/metersPerPixel.glsl?raw';

import type { IUniform } from 'three';
import {
	CLASSIFICATION_MASK,
	MAX_POLYGON_STYLE_VERTICES,
	SCENE_MODE_3D,
} from './constants';
import type { SharedUniforms } from './types';

/**
 * SharedUniforms 含可选字段（贴地线扩展），Three.js RawShaderMaterial
 * 的 uniforms 字段类型为 `{ [k: string]: IUniform }`（不允许 undefined）。
 * 两边都是「索引签名」，结构上兼容，只是 TS 不能在 `undefined` 通过性上
 * 自动让步。把 SharedUniforms 当成 Three 的 uniform 表传入时统一过一次
 * cast，运行时行为不变（不存在的键就是 undefined，Three 内部把 undefined
 * 跳过）。
 */
function asThreeUniforms( uniforms: SharedUniforms ): { [ k: string ]: IUniform } {
	return uniforms as unknown as { [ k: string ]: IUniform };
}

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

// ── 贴地线 VS 专用 czm 量 + 线 uniform（guard by CESIUM_THREE_POLYLINE 仅在
//    polyline 材质里编译生效；stencil / color / text 编译时这一整段被剔除，
//    与既有材质字节级一致，零回归）。──
#ifdef CESIUM_THREE_POLYLINE
const float czm_sceneMode2D = 2.0;
#define czm_orthographicIn3D 0.0

uniform mat4 czm_projection;
uniform vec4 czm_viewport;
uniform vec4 czm_frustumPlanes;
uniform float czm_pixelRatio;
uniform float u_lineWidthPixels;
uniform float u_lineWidthMode;
uniform float u_lineWidthMeters;
#define GLOBE_MINIMUM_ALTITUDE 55000.0

// POLYLINE_VS 在 EC 内用 czm_planeDistance 选「离当前顶点更近的斜接平面」
// 来推导 normalEC（doc 05 §5），所以 VS 必须引入这一份函数体（FS prefix
// 也独立引入，两边不冲突）。
${ cesiumPlaneDistance }
${ cesiumMetersPerPixel }
#endif

// ── 线端箭头扩展（guard 在 CESIUM_THREE_POLYLINE_ARROW；仅 arrowhead 材质
//    编译时生效。这些 uniform 也写进 SharedUniforms，对线材质（无 ARROW
//    define）是 inactive uniform，与 u_circle*/u_polygon* 同模式零回归）。──
#ifdef CESIUM_THREE_POLYLINE_ARROW
uniform float u_arrowWidthMode;         // 0 = 屏幕像素 / 1 = 世界米
uniform float u_arrowLengthPixels;
uniform float u_arrowHalfWidthPixels;
uniform float u_arrowLengthMeters;
uniform float u_arrowHalfWidthMeters;
uniform vec4  u_arrowColor;
#define ARROW_BOX_PADDING 1.35
#define ARROW_TOP_RISE_METERS 1000.0
#endif
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
uniform float u_polygonMiterStrokeMode;
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
#ifdef CESIUM_THREE_TEXT
uniform sampler2D u_textTexture;
#endif

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

// ── 贴地线 FS 专用 czm 量 + 线 / 虚线 uniform。仅在 polyline 材质中编译。
//    czm_viewport / czm_frustumPlanes / czm_currentFrustum 已在 FS prefix
//    基础块里；这里只补 czm_sceneMode（FS 原本没有，metersPerPixel 依赖）、
//    czm_pixelRatio 等线专属量，以及 u_color（基础 FS prefix 不含——其它
//    材质走 v_color varying；线材质 PER_INSTANCE_COLOR 路径直接读 uniform）。──
#ifdef CESIUM_THREE_POLYLINE
const float czm_sceneMode2D = 2.0;
#define czm_orthographicIn3D 0.0
uniform float czm_sceneMode;
uniform float czm_pixelRatio;
uniform vec4 u_color;
uniform float u_lineWidthMode;
uniform float u_lineWidthMeters;
uniform float u_lineDashEnabled;
uniform float u_lineDashLengthMeters;
uniform float u_lineGapLengthMeters;
uniform float u_lineTotalMeters;

${ cesiumMetersPerPixel }
#endif

// ── 线端箭头 FS uniform（仅 arrowhead 材质编译）。──
#ifdef CESIUM_THREE_POLYLINE_ARROW
uniform float u_arrowWidthMode;
uniform float u_arrowLengthPixels;
uniform float u_arrowHalfWidthPixels;
uniform float u_arrowLengthMeters;
uniform float u_arrowHalfWidthMeters;
uniform vec4  u_arrowColor;
uniform float u_arrowStrokeHalfPixels;  // open 样式：斜边笔宽（像素）
#endif
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
        // Polygon path: the supplied point ring is the final face boundary.
        // In the default inner-stroke mode, fragments stay inside this face;
        // the shader classifies the stroke by distance to that same boundary.
        bool insidePolygon = c23_pointInsidePolygon(planarMeters);
        float edgeDistanceMeters = c23_distanceToPolygonEdges(planarMeters);
        if (u_polygonMiterStrokeMode > 0.5) {
            if (!insidePolygon) {
                discard;
            }
            if (u_borderEnabled > 0.5 && u_borderColor.a > 0.0 && edgeDistanceMeters <= u_borderWidthMeters) {
                color = czm_gammaCorrect(u_borderColor);
            }
        } else if (!insidePolygon) {
            if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0 || edgeDistanceMeters > u_borderWidthMeters) {
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
		uniforms: asThreeUniforms( uniforms ),
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
		uniforms: asThreeUniforms( uniforms ),
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

/**
 * Injects the ground-text fragment branch into Cesium's per-instance color
 * shader. Uses the same `vec4 color = czm_gammaCorrect(v_color);` anchor as
 * `createColorFragmentBody()` so the only difference between rectangle/circle
 * fill and text is the inner branch. The text branch reuses the CPU-plane
 * `planarMeters` path (same precision pipeline as the border path), normalizes
 * to `[0,1]` uv using the footprint meters stored in `u_innerMetersRect.zw`,
 * then samples `u_textTexture` with the V axis flipped (canvas origin is
 * top-left, uv origin is SW).
 *
 * @returns ShadowVolumeAppearanceFS with the text sampling branch inserted.
 * @throws  When the Cesium anchor line is missing (upstream shader churn).
 */
function createTextColorFragmentBody(): string {
	const colorDeclaration = '    vec4 color = czm_gammaCorrect(v_color);';
	const textInjection = /* glsl */ `    vec4 color = czm_gammaCorrect(v_color);
#ifdef CESIUM_THREE_TEXT
#ifdef TEXTURE_COORDINATES
#ifndef SPHERICAL
    // CPU-plane 抖动免疫 planarMeters（与 border 路径同源，Float64 CPU 算出
    // u_cpuWestPlane / u_cpuSouthPlane，避免 v_westPlane 的远视角插值抖动）
    vec3 textEyeCoordinate = eyeCoordinate.xyz / eyeCoordinate.w;
    vec2 textPlanarMeters = vec2(
        czm_planeDistance(u_cpuWestPlane, textEyeCoordinate),
        czm_planeDistance(u_cpuSouthPlane, textEyeCoordinate)
    );
    // 归一化到 [0,1]：足迹米宽/高存于 u_innerMetersRect.zw（见 text-extents）
    vec2 textUv = vec2(
        textPlanarMeters.x / max(u_innerMetersRect.z, 1e-6),
        textPlanarMeters.y / max(u_innerMetersRect.w, 1e-6)
    );
    // 足迹外丢弃（CPU-plane 精度的足迹裁剪）
    if (textUv.x < 0.0 || textUv.x > 1.0 || textUv.y < 0.0 || textUv.y > 1.0) {
        discard;
    }
    // canvas 原点左上、Y 向下；uv 原点 SW、Y 向上 → 翻转 V
    vec4 texel = texture(u_textTexture, vec2(textUv.x, 1.0 - textUv.y));
    // 全透明像素丢弃，避免覆盖底下地形 / 其它贴地图元
    if (texel.a <= 0.0) {
        discard;
    }
    // 颜色空间：CanvasTexture 取样得 sRGB 编码值，直接输出与 fill 路径一致。
    out_FragColor = texel;
    // 预乘 alpha：classification 在半透明地球上的混合约定（与 fill/border 一致）
    out_FragColor.rgb *= out_FragColor.a;
    return;
#endif
#endif
#endif`;

	const shader = cesiumShadowVolumeAppearanceFS.replace( colorDeclaration, textInjection );
	if ( shader === cesiumShadowVolumeAppearanceFS ) {
		throw new Error( 'Cesium shader patch failed: text color hook was not found.' );
	}
	return shader;
}

/**
 * Wraps the text color fragment body with the LOG_DEPTH `main()` postlude so
 * `czm_writeLogDepth()` runs after the texture sampling early-return path.
 *
 * @returns LOG_DEPTH 包装后的文字片元源。
 */
function buildTextColorFragmentShader(): string {
	const innerName = 'czm_shadow_volume_text_main_fs';
	const append = ENABLE_LOG_DEPTH ? 'czm_writeLogDepth();' : '';
	const body = createTextColorFragmentBody();

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( body, innerName, append )
		: body;
}

/**
 * Creates the ground-text color material. Render state matches
 * `createColorMaterial` byte-for-byte so the front-stencil / back-stencil /
 * color command block keeps the same render-order contract; the only delta is
 * the `CESIUM_THREE_TEXT` define and a fragment branch that samples
 * `u_textTexture`. Caller is expected to inject the texture uniform via the
 * shared `extraUniforms` path so the LOG_DEPTH + CPU-plane + Float64-RTE
 * precision pipeline stays unchanged.
 *
 * @param uniforms     Shared uniforms (must include `u_textTexture` value).
 * @param fragmentCull Whether Cesium's `CULL_FRAGMENTS` define is active.
 * @returns            RawShaderMaterial for the text color command.
 */
export function createTextColorMaterial(
	uniforms: SharedUniforms,
	fragmentCull: boolean,
): RawShaderMaterial {
	const defines = combineDefines( [
		'EXTRUDED_GEOMETRY',
		'TEXTURE_COORDINATES',
		fragmentCull ? 'CULL_FRAGMENTS' : '',
		'PER_INSTANCE_COLOR',
		'FLAT',
		'REQUIRES_EC',
		'CESIUM_THREE_TEXT',
	] );

	const vertexShader = buildColorVertexShader();         // 复用 fill 的顶点包装
	const fragmentShader = buildTextColorFragmentShader(); // 文字专属片元

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: asThreeUniforms( uniforms ),
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
		transparent: false,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumGroundTextColorMaterial';
	return material;
}

// ============================================================
// 贴地线 polyline shader bodies + material factory（doc 05-07）
//
// 这是一条与 stencil 管线**正交**的单 pass 管线：每段 8 顶点 box，VS 按
// 屏宽挤出 + czm_projection 投影，FS 采样全局地形深度纹理重建地形点 EC、
// 用三平面距离裁切并上色。无 stencil，BackSide 渲染反绕几何（相机进入
// 盒子内部仍覆盖），depthTest = false（深度比对在 FS 内手动做）。
// ============================================================

/**
 * 贴地线 VS 主体。删除 `COLUMBUS_VIEW_2D` 分支（项目 3D-only），其余逐字
 * 对齐 Cesium `PolylineShadowVolumeVS.glsl`。屏宽 / 世界宽通过
 * `u_lineWidthMode` 双分支均完整实现。
 */
const POLYLINE_VS = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;

in vec4 startHiAndForwardOffsetX;
in vec4 startLoAndForwardOffsetY;
in vec4 startNormalAndForwardOffsetZ;
in vec4 endNormalAndTextureCoordinateNormalizationX;
in vec4 rightNormalAndTextureCoordinateNormalizationY;
in float batchId;

out vec4 v_startPlaneNormalEcAndHalfWidth;
out vec4 v_endPlaneNormalEcAndBatchId;
out vec4 v_rightPlaneEC;
out vec4 v_endEcAndStartEcX;
out vec4 v_texcoordNormalizationAndStartEcYZ;

void main() {
	// 1) 段起点（EC）：RTE 编码 → relative-to-eye → 视图旋转。
	vec3 ecStart = ( czm_modelViewRelativeToEye *
		czm_translateRelativeToEye( startHiAndForwardOffsetX.xyz, startLoAndForwardOffsetY.xyz ) ).xyz;
	vec3 offset = czm_normal * vec3(
		startHiAndForwardOffsetX.w,
		startLoAndForwardOffsetY.w,
		startNormalAndForwardOffsetZ.w
	);
	vec3 ecEnd = ecStart + offset;
	vec3 forwardDirectionEC = normalize( offset );

	// 2) 三平面（EC, Hessian）。w = -dot(n, plane-point)
	vec4 startPlaneEC;
	startPlaneEC.xyz = czm_normal * startNormalAndForwardOffsetZ.xyz;
	startPlaneEC.w = - dot( startPlaneEC.xyz, ecStart );

	vec4 endPlaneEC;
	endPlaneEC.xyz = czm_normal * endNormalAndTextureCoordinateNormalizationX.xyz;
	endPlaneEC.w = - dot( endPlaneEC.xyz, ecEnd );

	v_rightPlaneEC.xyz = czm_normal * rightNormalAndTextureCoordinateNormalizationY.xyz;
	v_rightPlaneEC.w = - dot( v_rightPlaneEC.xyz, ecStart );

	// 3) 透传 texcoord 归一 + 起止点（FS s/t 用）
	v_texcoordNormalizationAndStartEcYZ.x = abs( endNormalAndTextureCoordinateNormalizationX.w );
	v_texcoordNormalizationAndStartEcYZ.y = rightNormalAndTextureCoordinateNormalizationY.w;
	v_endEcAndStartEcX.xyz = ecEnd;
	v_endEcAndStartEcX.w = ecStart.x;
	v_texcoordNormalizationAndStartEcYZ.zw = ecStart.yz;

	// 4) 当前顶点 EC（box 8 角之一）。
	vec4 positionRelativeToEye = czm_computePosition();
	vec4 positionEC = czm_modelViewRelativeToEye * positionRelativeToEye;

	// 5) 选离当前顶点更近的斜接平面，叉乘出挤出法线 normalEC（朝右）。
	float absStart = abs( czm_planeDistance( startPlaneEC, positionEC.xyz ) );
	float absEnd = abs( czm_planeDistance( endPlaneEC, positionEC.xyz ) );
	vec3 planeDirection = czm_branchFreeTernary( absStart < absEnd, startPlaneEC.xyz, endPlaneEC.xyz );
	vec3 upOrDown = normalize( cross( v_rightPlaneEC.xyz, planeDirection ) );
	vec3 normalEC = normalize( cross( planeDirection, upOrDown ) );

	// 6) 底部下沿顶点向下延伸（视距驱动，与 GroundPrimitive 同理）。仅
	//    texcoordNormalization.y 越界（< 0 或 > 1）的顶点才参与延伸。
	upOrDown = cross( forwardDirectionEC, normalEC );
	upOrDown = float(
		v_texcoordNormalizationAndStartEcYZ.y > 1.0 ||
		v_texcoordNormalizationAndStartEcYZ.y < 0.0
	) * upOrDown;
	upOrDown = min(
		GLOBE_MINIMUM_ALTITUDE,
		czm_geometricToleranceOverMeter * length( positionRelativeToEye.xyz )
	) * upOrDown;
	positionEC.xyz += upOrDown;

	// 复原 texcoordNormalization.y：> 1 的哨兵（9.0）→ 0.0，其余取 abs。
	v_texcoordNormalizationAndStartEcYZ.y = czm_branchFreeTernary(
		v_texcoordNormalizationAndStartEcYZ.y > 1.0,
		0.0,
		abs( v_texcoordNormalizationAndStartEcYZ.y )
	);

	// 7) 半宽透传给 FS（FS 用 halfMaxWidth 做横向裁切）。screen 模式存像素半宽，
	//    world 模式存米半宽。盒子的顶点位置在 §8 用「全宽」（×2）推开——
	//    Cesium VS 注释：「Make volumes about double pixel width for a
	//    conservative fit」，盒子比线本身宽 2× 才能避免 subpixel 漂移时 FS
	//    错过线两侧边缘像素，否则线在缩放过程中会闪烁。
	float fullWidth = czm_branchFreeTernary(
		u_lineWidthMode > 0.5,
		u_lineWidthMeters,
		u_lineWidthPixels
	);
	v_startPlaneNormalEcAndHalfWidth.xyz = startPlaneEC.xyz;
	v_startPlaneNormalEcAndHalfWidth.w = fullWidth * 0.5;

	v_endPlaneNormalEcAndBatchId.xyz = endPlaneEC.xyz;
	v_endPlaneNormalEcAndBatchId.w = batchId;

	// 8) 顶点挤出：把盒子做成「2× 线宽」的保险范围。screen 模式下用
	//    metersPerPixel(positionEC) 把像素换算成米；world 模式直接用米。
	//    再除以 dot(normalEC, rightPlane) 做斜接补偿（normalEC 在拐角处
	//    不等于 rightNormal，需要把沿右法线的距离换算成沿 normalEC 的距离）。
	float pushMeters = czm_branchFreeTernary(
		u_lineWidthMode > 0.5,
		fullWidth,
		fullWidth * max( 0.0, czm_metersPerPixel( positionEC ) )
	);
	pushMeters = pushMeters / dot( normalEC, v_rightPlaneEC.xyz );

	// 左 / 右半边由 endNormalAndTextureCoordinateNormalizationX.w 的符号决定。
	normalEC *= sign( endNormalAndTextureCoordinateNormalizationX.w );
	positionEC.xyz += pushMeters * normalEC;

	// 9) 用 czm_projection（纯投影，Float64 每帧刷新）+ depthClamp + log-depth。
	gl_Position = czm_depthClamp( czm_projection * positionEC );
#ifdef LOG_DEPTH
	czm_vertexLogDepth();
#endif
}
`;

/**
 * 贴地线 FS 主体。深度重建分类法 + 三平面距离裁切 + 沿线 s/t 归一 +
 * PER_INSTANCE_COLOR 纯色 / 材质虚线两路。
 */
const POLYLINE_FS = /* glsl */ `
in vec4 v_startPlaneNormalEcAndHalfWidth;
in vec4 v_endPlaneNormalEcAndBatchId;
in vec4 v_rightPlaneEC;
in vec4 v_endEcAndStartEcX;
in vec4 v_texcoordNormalizationAndStartEcYZ;

void main() {
	// 1) 采样全局地形深度纹理：屏幕 UV = gl_FragCoord.xy / czm_viewport.zw。
	float logDepthOrDepth = czm_unpackDepth(
		texture( czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw )
	);
	vec3 ecStart = vec3( v_endEcAndStartEcX.w, v_texcoordNormalizationAndStartEcYZ.zw );

	// 2) 天空（无地形写入处）→ discard。
	if ( logDepthOrDepth == 0.0 ) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 1.0, 0.0, 0.0, 0.5 );
		return;
#else
		discard;
#endif
	}

	// 3) 重建当前像素下的地形点（EC）。算法的核心 —— 后续三平面距离判定都
	//    跑在「真实地形点」上而非盒子顶点本身。
	vec4 eyeCoordinate = czm_windowToEyeCoordinates( gl_FragCoord.xy, logDepthOrDepth );
	eyeCoordinate /= eyeCoordinate.w;

	// 4) 半宽换算：屏宽模式下乘 metersPerPixel(地形点)；世界宽模式直接拿米。
	float halfMaxWidth = czm_branchFreeTernary(
		u_lineWidthMode > 0.5,
		v_startPlaneNormalEcAndHalfWidth.w,
		v_startPlaneNormalEcAndHalfWidth.w * czm_metersPerPixel( eyeCoordinate )
	);

	// 5) 地形点到「右平面」的横向距离（决定是否在线宽内）。
	float widthwiseDistance = czm_planeDistance( v_rightPlaneEC, eyeCoordinate.xyz );

	// 6) 地形点到「起 / 止斜接平面」的距离（决定是否在段长范围内）。
	float distanceFromStart = czm_planeDistance(
		v_startPlaneNormalEcAndHalfWidth.xyz,
		- dot( ecStart, v_startPlaneNormalEcAndHalfWidth.xyz ),
		eyeCoordinate.xyz
	);
	float distanceFromEnd = czm_planeDistance(
		v_endPlaneNormalEcAndBatchId.xyz,
		- dot( v_endEcAndStartEcX.xyz, v_endPlaneNormalEcAndBatchId.xyz ),
		eyeCoordinate.xyz
	);

	// 7) 裁切：横向超半宽，或越过起 / 止端面 → 丢弃。
	if (
		abs( widthwiseDistance ) > halfMaxWidth ||
		distanceFromStart < 0.0 ||
		distanceFromEnd < 0.0
	) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 1.0, 0.0, 0.0, 0.5 );
		return;
#else
		discard;
#endif
	}

	// 8) 对齐平面（aligned plane）：把斜接平面「掰正」到与 right 平面正交且
	//    更朝向 forward 方向。用它重算 distanceFromStart/End，得到无斜接畸变
	//    的沿线距离（供 s 归一）。
	vec3 alignedPlaneNormal;

	alignedPlaneNormal = cross( v_rightPlaneEC.xyz, v_startPlaneNormalEcAndHalfWidth.xyz );
	alignedPlaneNormal = normalize( cross( alignedPlaneNormal, v_rightPlaneEC.xyz ) );
	distanceFromStart = czm_planeDistance(
		alignedPlaneNormal, - dot( alignedPlaneNormal, ecStart ), eyeCoordinate.xyz
	);

	alignedPlaneNormal = cross( v_rightPlaneEC.xyz, v_endPlaneNormalEcAndBatchId.xyz );
	alignedPlaneNormal = normalize( cross( alignedPlaneNormal, v_rightPlaneEC.xyz ) );
	distanceFromEnd = czm_planeDistance(
		alignedPlaneNormal, - dot( alignedPlaneNormal, v_endEcAndStartEcX.xyz ), eyeCoordinate.xyz
	);

	// 9) 沿线 s / 横向 t 归一坐标。s 是整条线 [0,1] 的弧长参数（供虚线 / 渐变用）。
	float s = clamp( distanceFromStart / ( distanceFromStart + distanceFromEnd ), 0.0, 1.0 );
	s = ( s * v_texcoordNormalizationAndStartEcYZ.x ) + v_texcoordNormalizationAndStartEcYZ.y;
	// 当前未读 t，但保留计算以便未来扩展（移除掉避免「变量未使用」告警）。
	float t = ( widthwiseDistance + halfMaxWidth ) / ( 2.0 * halfMaxWidth );
	t = clamp( t, 0.0, 1.0 );

	vec4 col = u_color;

	// 10) 虚线：沿线米相位 mod(along, period) > dash → discard。
	if ( u_lineDashEnabled > 0.5 && u_lineTotalMeters > 0.0 ) {
		float along = s * u_lineTotalMeters;
		float period = u_lineDashLengthMeters + u_lineGapLengthMeters;
		if ( period > 0.0 ) {
			float phase = mod( along, period );
			if ( phase > u_lineDashLengthMeters ) {
				discard;
			}
		}
	}

	// 11) 预乘 alpha（与 polygon colorMesh 一致，配合 blendSrc=ONE）。
	col.rgb *= col.a;
	out_FragColor = col;

#ifdef LOG_DEPTH
	czm_writeLogDepth();
#endif
}
`;

/**
 * Creates the polyline material — single mesh, BackSide, no stencil, depthTest
 * off, premultiplied blend. Reuses createVertexPrefix / createFragmentPrefix
 * via the `CESIUM_THREE_POLYLINE` define to bring in metersPerPixel + line
 * uniforms while keeping stencil / color material outputs byte-identical.
 *
 * @param uniforms     Shared uniforms map (must include `czm_projection`,
 *                     `czm_pixelRatio`, `u_lineWidthPixels`, `u_lineWidthMode`,
 *                     `u_lineWidthMeters`, dash uniforms, `u_lineTotalMeters`).
 * @param debugVolume  When true，FS 用半透红色直接绘制盒子的所有像素（不做
 *                     terrain depth 重建 / 平面距离裁切），方便诊断「盒子有没有
 *                     盖到该屏幕区域」「FS 是不是被裁切掉」这类几何 / 着色器问题。
 * @returns            RawShaderMaterial driving the depth-reconstruction line pass.
 */
export function createPolylineMaterial(
	uniforms: SharedUniforms,
	debugVolume = false,
): RawShaderMaterial {
	const defines = combineDefines( [
		'PER_INSTANCE_COLOR',
		'CESIUM_THREE_POLYLINE',
		debugVolume ? 'DEBUG_SHOW_VOLUME' : '',
	] );

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: asThreeUniforms( uniforms ),
		vertexShader: `${ createVertexPrefix( defines ) }\n${ POLYLINE_VS }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ POLYLINE_FS }`,
		// Cesium 原版用 BackSide + 反绕 winding 让「相机在盒外」时看到背面；
		// 但相机部分维度进入盒内时（地形紧贴盒子 + 大 widthMeters 让横向也
		// 把相机包进去），BackSide 会把所有面 cull 掉，盒子整段消失（实测
		// seg 1 在 world widthMeters=50 时遇到）。改成 DoubleSide 两面都画，
		// FS 自己负责 terrain depth 重建 + 平面距离裁切，多画一面 GPU 开销
		// 可忽略，但相机任意位置都能保证 FS 跑到。
		side: DoubleSide,
		colorWrite: true,
		depthWrite: false,               // Cesium depthMask: false
		depthTest: false,                // 地形比对在 FS（采样深度纹理）
		stencilWrite: false,             // 不碰模板缓冲
		transparent: true,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumGroundPolylineMaterial';
	return material;
}

// ============================================================
// 线端箭头 ARROWHEAD_VS / ARROWHEAD_FS / createArrowHeadMaterial
//
// 每个箭头端 = 一个 8 顶点薄盒，盒子尺寸由 VS 用 `czm_metersPerPixel(tip)`
// 动态挤出（屏幕像素恒定）。FS 把当前像素下重建的地形点投到端点切平面
// `(a=沿线内向, b=横向)`，做实心三角形成员判定。屏幕恒定来源与线一致。
// ============================================================

/**
 * 线端箭头 VS。从 RTE-encoded tip 重建 EC，端点标架旋到 EC，按 metersPerPixel
 * 把盒子在切平面里挤成「箭头三角形外接矩形」，并把盒子上 / 下沿沿 up 方向
 * 拉成「穿过地表的薄墙」，确保 FS 在箭头屏幕区域被调用。
 */
const ARROWHEAD_VS = /* glsl */ `
in vec3 arrowTipHigh;
in vec3 arrowTipLow;
in vec3 arrowBackDir;
in vec3 arrowRightDir;
in vec3 arrowUpDir;
in vec3 arrowCorner;            // (aCoef, bSign, topBottomSide)

out vec3 v_arrowTipEC;
out vec3 v_arrowBackEC;
out vec3 v_arrowRightEC;

void main() {
	// 1) tip EC：RTE 解码（与线 ecStart 同路径），消除高 zoom 抖动。
	vec4 tipRTE = czm_translateRelativeToEye( arrowTipHigh, arrowTipLow );
	vec4 tipEC = czm_modelViewRelativeToEye * tipRTE;

	// 2) 端点标架（世界单位向量）旋到 EC，FS 用它做投影。
	vec3 backEC  = normalize( czm_normal * arrowBackDir );
	vec3 rightEC = normalize( czm_normal * arrowRightDir );
	vec3 upEC    = normalize( czm_normal * arrowUpDir );
	v_arrowTipEC   = tipEC.xyz;
	v_arrowBackEC  = backEC;
	v_arrowRightEC = rightEC;

	// 3) 像素 → 米：用尖端处 metersPerPixel 代表整个小箭头，乘保险放大系数
	//    ARROW_BOX_PADDING——因为 FS 用「地形点处的」metersPerPixel 算三角形，
	//    与 tipEC 处的 mpp 略有差异；盒子放大 1.35× 确保 FS 三角形恒落在盒覆盖
	//    的屏幕像素内。
	float mpp = max( 0.0, czm_metersPerPixel( tipEC ) );
	float Lm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowLengthMeters,
		u_arrowLengthPixels * mpp
	) * ARROW_BOX_PADDING;
	float Wm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowHalfWidthMeters,
		u_arrowHalfWidthPixels * mpp
	) * ARROW_BOX_PADDING;

	// 4) 切平面内挤出盒底面四角：tip + back·(aCoef·Lm) + right·(bSign·Wm)。
	float aCoef = arrowCorner.x;
	float bSign = arrowCorner.y;
	float tb    = arrowCorner.z;
	vec3 positionEC = tipEC.xyz
		+ backEC * ( aCoef * Lm )
		+ rightEC * ( bSign * Wm );

	// 5) 竖直薄墙：顶沿(tb>0)抬 ARROW_TOP_RISE_METERS，底沿(tb<0)按视距下延
	//    （与线一致：min(GLOBE_MINIMUM_ALTITUDE, geometricToleranceOverMeter·视距)）。
	//    保证薄墙穿过地表、FS 在箭头屏幕区域被调用。
	float viewDist = length( tipRTE.xyz );
	float drop = min(
		GLOBE_MINIMUM_ALTITUDE,
		czm_geometricToleranceOverMeter * viewDist
	);
	positionEC += upEC * czm_branchFreeTernary(
		tb > 0.0,
		ARROW_TOP_RISE_METERS,
		- drop
	);

	// 6) 投影 + depthClamp + log-depth（与线同协议，必须配对）。
	gl_Position = czm_depthClamp( czm_projection * vec4( positionEC, 1.0 ) );
#ifdef LOG_DEPTH
	czm_vertexLogDepth();
#endif
}
`;

/**
 * 线端箭头 FS。深度纹理重建 + 端点切平面 (a,b) 投影 + 实心三角形成员判定。
 * 屏幕恒定来自「FS 用地形点 EC 算 metersPerPixel」（与线 halfMaxWidth 同口径）。
 * `ARROW_OPEN` define 切换为「开口雪佛龙」样式（仅画到两条斜边的笔宽内）。
 */
const ARROWHEAD_FS = /* glsl */ `
in vec3 v_arrowTipEC;
in vec3 v_arrowBackEC;
in vec3 v_arrowRightEC;

void main() {
	// 1) 采样全局地形深度纹理（与线 FS 完全一致）。
	float depth = czm_unpackDepth(
		texture( czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw )
	);

	// 2) 天空（无地形写入处）→ discard，否则箭头糊在天空背景。
	if ( depth == 0.0 ) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 0.0, 1.0, 0.0, 0.5 );   // 调试染绿（区别于线的红）
		return;
#else
		discard;
#endif
	}

	// 3) 重建当前像素下的地形点（EC）。
	vec4 P = czm_windowToEyeCoordinates( gl_FragCoord.xy, depth );
	P /= P.w;

	// 4) 把地形点投到端点切平面坐标：a 沿线内向、b 横向。
	vec3 v = P.xyz - v_arrowTipEC;
	float a = dot( v, v_arrowBackEC );
	float b = dot( v, v_arrowRightEC );

	// 5) 像素 → 米（用地形点处 mpp，屏幕恒定的来源）。
	float mpp = czm_metersPerPixel( P );
	float Lm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowLengthMeters,
		u_arrowLengthPixels * mpp
	);
	float Wm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowHalfWidthMeters,
		u_arrowHalfWidthPixels * mpp
	);

	// 6) 三角形成员判定。
#ifdef ARROW_OPEN
	// 开口雪佛龙：只画三角形两条斜边附近的笔宽内像素。
	// edge = |b| - Wm·(a/Lm) 的「垂直距离」（除以斜边的长度比 Lm/sqrt(Lm²+Wm²)）。
	float lineFactor = Lm / sqrt( Lm * Lm + Wm * Wm );
	float edgeDistance = abs( abs( b ) - Wm * ( a / Lm ) ) * lineFactor;
	if ( a < 0.0 || a > Lm || edgeDistance > u_arrowStrokeHalfPixels * mpp ) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 0.0, 1.0, 0.0, 0.5 );
		return;
#else
		discard;
#endif
	}
#else
	// 实心三角（默认）：0 ≤ a ≤ Lm 且 |b| ≤ Wm·(a/Lm)（基底向尖端线性收窄）。
	if ( a < 0.0 || a > Lm || abs( b ) > Wm * ( a / Lm ) ) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 0.0, 1.0, 0.0, 0.5 );
		return;
#else
		discard;
#endif
	}
#endif

	// 7) 上色（预乘 alpha，配合 blendSrc=ONE）+ log-depth。
	vec4 col = u_arrowColor;
	col.rgb *= col.a;
	out_FragColor = col;

#ifdef LOG_DEPTH
	czm_writeLogDepth();
#endif
}
`;

/**
 * 创建线端箭头材质。与线材质字节级相同的渲染状态，只换 shader 主体 + 加
 * `CESIUM_THREE_POLYLINE_ARROW` define 拉出 arrow uniform。
 *
 * @param uniforms     共享 uniforms（与同一 polyline 实例共用）。
 * @param debugVolume  把盒子整体染绿调试用。
 * @param open         true → 走开口雪佛龙样式（`ARROW_OPEN`）；默认实心三角。
 * @returns            RawShaderMaterial。
 */
export function createArrowHeadMaterial(
	uniforms: SharedUniforms,
	debugVolume = false,
	open = false,
): RawShaderMaterial {
	const defines = combineDefines( [
		'PER_INSTANCE_COLOR',
		'CESIUM_THREE_POLYLINE',
		'CESIUM_THREE_POLYLINE_ARROW',
		open ? 'ARROW_OPEN' : '',
		debugVolume ? 'DEBUG_SHOW_VOLUME' : '',
	] );

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms: asThreeUniforms( uniforms ),
		vertexShader: `${ createVertexPrefix( defines ) }\n${ ARROWHEAD_VS }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ ARROWHEAD_FS }`,
		// 与线材质同样的 DoubleSide，避免相机在薄墙某一侧时 BackSide 把面 cull 光。
		side: DoubleSide,
		colorWrite: true,
		depthWrite: false,
		depthTest: false,
		stencilWrite: false,
		transparent: true,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumGroundPolylineArrowMaterial';
	return material;
}

export { ENABLE_LOG_DEPTH };
