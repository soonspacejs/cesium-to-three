// ============================================================
// materials.ts
// 层级:Cesium-to-Three 贴地 shader/material 桥接层。
// 职责:把 Cesium GroundPrimitive 着色器片段转换成 Three RawShaderMaterial,
//       同时保留 Cesium stencil/color 命令语义,包括 Cesium LOG_DEPTH 路径。
// 依赖:Three.js 材质状态与未改动的 Cesium GLSL 源码。
// 被消费:classification.ts 与 depth.ts。
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

import {
	cesiumShadowVolumeAppearanceVS,
	cesiumShadowVolumeAppearanceFS,
	cesiumShadowVolumeFS,
	cesiumDepthClamp,
	cesiumWriteDepthClamp,
	cesiumTranslateRelativeToEye,
	cesiumWindowToEyeCoordinates,
	cesiumUnpackDepth,
	cesiumPackDepth,
	cesiumPlaneDistance,
	cesiumGammaCorrect,
	cesiumMetersPerPixel,
} from './shaders/shadow-volume-glsl';

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

// Three.js 的 RawShaderMaterial 不会执行 Cesium ShaderSource 的自动
// LOG_DEPTH 包装(也就是向 main() 添加 czm_vertexLogDepth() /
// czm_writeLogDepth() 调用)。下面手动复刻这段注入逻辑。`LOG_DEPTH`
// define 同时控制 GLSL 源码与对应 Three 渲染状态中的 gl_FragDepth 路径。
const ENABLE_LOG_DEPTH = true;

/**
 * 用 GLSL3 表达的 Cesium 等价对数深度辅助代码。对影响 Z-fail stencil
 * 阴影体管线的部分,行为与 Cesium 原始片段逐字节对齐:
 *
 * - `czm_vertexLogDepth()` 写入 `v_depthFromNearPlusOne`,并把
 *   `gl_Position.z` clamp 到 `[-w, w]`,让因对数深度精度落到范围外的顶点
 *   仍能进入片元着色器(在顶点阶段模拟 GL_DEPTH_CLAMP;对齐 Cesium
 *   vertexLogDepth.glsl 中的 {@link czm_updatePositionDepth})。
 *
 * - `czm_writeLogDepth()` 使用 Cesium 的 `log2(depth) /
 *   log2(czm_farDepthFromNearPlusOne)` 公式,并 **discard** 视锥外片元。
 *   这是阴影体正确性的关键:此文件早期版本曾改为 clamp 到
 *   `gl_FragDepth = 0.0` / `1.0`,并认为单视锥下 stencil 计数仍会保持
 *   完整。这个推理是错的:
 *     - 穿过远平面的 *back* face 被 clamp 到 `gl_FragDepth = 1.0` 后,
 *       会 **失败** LessEqual 深度测试(`1.0 > terrain_depth`),于是执行
 *       `stencilZFail = INCR_WRAP`,给该像素额外贡献 +1。
 *     - 穿过远平面的 *front* face 会对称地产生额外 -1(DECR_WRAP)。
 *     - 只有两面投影到同一像素时二者才会抵消。对于被远平面非对称裁剪的
 *       阴影体盒(远离相机的一侧越过远平面,靠近相机的一侧仍在视锥内),
 *       某些地形像素只受到被裁剪面的游离 ±1 影响,另一些像素只看到视锥内
 *       面的正常贡献。这种不匹配会留下可见弧带,让 stencil 净值在体积
 *       "内部" 与 "外部" 之间翻转;这正是箭头图元高阴影体开始被
 *       `camera.far = horizonDistance + 0.1` 裁剪时观察到的伪影。
 *
 *   Cesium 的 discard 会完全避开这个问题:被裁剪面根本不写 stencil,
 *   因此既不会多计也不会少计。
 *
 * - `terrain-log-depth.ts` 中的 **地形 log-depth** 仍有意使用 clamp-to-0/1
 *   形式:地形没有 stencil pass,clamp 可避免对数深度精度舍入意外丢弃那些
 *   *刚刚* 越过视锥的地形片元(这是 clamp 的原始理由)。阴影体 stencil
 *   pass 对正确性要求更严格,必须 discard。
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
	// 精确匹配 Cesium writeLogDepth.glsl:当 log-depth 值越过近/远平面时丢弃片元。
	// 为了阴影体 stencil 正确性,宁可完全漏掉一个片元(对 +1/-1 stencil 计数贡献为 0),
	// 也不能合成一个必定深度失败的伪远平面片元,再把虚假的 DECR_WRAP / INCR_WRAP 写进 stencil。
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
 * 把 shader 的 `main()` 包装成重命名的内部函数,再替换为新的 `main()`:
 * 先调用内部函数,再执行 `appended`。复刻 Cesium ShaderSource.replaceMain
 * 与 DerivedCommand 对数深度包装。
 *
 * @param source 包含且仅包含一个 `void main()` 定义的 GLSL 源码。
 * @param innerName 原 `main()` 函数体的替换名称。
 * @param appended 原 main 执行后注入的 GLSL 语句。
 * @returns 包装后的 GLSL,新的 `void main()` 会调用被重命名的函数体。
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
 * 创建顶点前缀,向阴影体顶点着色器提供 Cesium 自动 uniform、batch table
 * hook 与 LOG_DEPTH 辅助函数。
 *
 * @param defines 像 Cesium ShaderSource 一样前置的 GLSL define。
 * @returns GLSL 源码前缀。
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
//    与既有材质字节级一致，零回归）。箭头相关 uniform 也放进来——线材质 FS
//    需要它们来做 OPEN arrow V 形收口裁剪，箭头材质自然也用得到。──
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
// 线 + 箭头共享 uniform（线 FS 也用 u_arrow* 算 OPEN clip）
uniform float u_arrowWidthMode;         // 0 = 屏幕像素 / 1 = 世界米
uniform float u_arrowLengthPixels;
uniform float u_arrowHalfWidthPixels;
uniform float u_arrowLengthMeters;
uniform float u_arrowHalfWidthMeters;
#define GLOBE_MINIMUM_ALTITUDE 55000.0

// POLYLINE_VS 在 EC 内用 czm_planeDistance 选「离当前顶点更近的斜接平面」
// 来推导 normalEC（doc 05 §5），所以 VS 必须引入这一份函数体（FS prefix
// 也独立引入，两边不冲突）。
${ cesiumPlaneDistance }
${ cesiumMetersPerPixel }
#endif

// ── 线端箭头扩展（guard 在 CESIUM_THREE_POLYLINE_ARROW；仅 arrowhead 材质
//    编译时生效。箭头专用的 macro 留这里；公共 uniform 上移到 POLYLINE 块）──
#ifdef CESIUM_THREE_POLYLINE_ARROW
uniform vec4  u_arrowColor;
#define ARROW_BOX_PADDING 1.35
#define ARROW_TOP_RISE_METERS 1000.0
#endif
`;
}

/**
 * 为 Cesium 阴影体 color 或 stencil 着色器创建片元前缀。
 *
 * @param defines 像 Cesium ShaderSource 一样前置的 GLSL define。
 * @returns GLSL 源码前缀。
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

// 把角度包装到 [0, 2π),让圆扇区测试比较片元方位角与配置起点时不会受符号干扰。
float c23_wrappedPositiveAngle(float radians) {
	float wrapped = mod(radians, czm_twoPi);
	return wrapped < 0.0 ? wrapped + czm_twoPi : wrapped;
}

// 对 setPolygonBorderPoints 提供的平面米制填充顶点执行奇偶射线法点在多边形内测试。
// 循环最多跑到 MAX_POLYGON_STYLE_VERTICES 并提前 break,可兼容不允许非常量循环边界的旧 WebGL 驱动。
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
//    材质走 v_color varying；线材质 PER_INSTANCE_COLOR 路径直接读 uniform）。
//    箭头相关 uniform 也放在这里——线 FS 用它们做 OPEN arrow V 形收口裁剪，
//    箭头 FS 也用同一份声明（两者都定义 CESIUM_THREE_POLYLINE）。──
#ifdef CESIUM_THREE_POLYLINE
const float czm_sceneMode2D = 2.0;
#define czm_orthographicIn3D 0.0
uniform float czm_sceneMode;
uniform float czm_pixelRatio;
uniform vec4 u_color;
uniform float u_lineWidthMode;
uniform float u_lineWidthMeters;
uniform float u_lineWidthPixels;
uniform float u_lineDashEnabled;
uniform float u_lineDashLengthMeters;
uniform float u_lineGapLengthMeters;
uniform float u_lineTotalMeters;
// 线 + 箭头共享 uniform
uniform float u_arrowWidthMode;
uniform float u_arrowLengthPixels;
uniform float u_arrowHalfWidthPixels;
uniform float u_arrowLengthMeters;
uniform float u_arrowHalfWidthMeters;
// 箭头样式 id 常量——与 TS 端 ARROW_STYLE_ID 逐值对齐（line-arrowhead.ts）。
// 新增样式时这里加一个同值 define，FS 加一个判定分支。线 FS 收口 + 箭头 FS
// 成员判定都引用这套常量（两者都定义 CESIUM_THREE_POLYLINE）。
#define ARROW_STYLE_SOLID 0
#define ARROW_STYLE_OPEN  1
// 线 FS 专用：是否对起 / 终端做 arrow 收口裁剪
// （> 0.5 启用；arrowMode 包含对应端时启用）
uniform float u_lineArrowClipEndEnabled;
uniform float u_lineArrowClipStartEnabled;
// 线 FS 专用：起 / 终端各自的箭头样式 id（ARROW_STYLE_*）。两端可不同——
// 起点实心、终点空心时收口策略也要分别按各自样式走，不能共用一个标志。
// solid 类：线在箭头长度内整段收平到 base，避免线体在三角形内那层与实心箭头
// 叠加导致半透明翻倍；open 类：线收窄成 V 形嵌进 chevron 保持连续。
uniform float u_lineArrowStyleStart;
uniform float u_lineArrowStyleEnd;

${ cesiumMetersPerPixel }
#endif

// ── 线端箭头 FS uniform（仅 arrowhead 材质编译）。──
#ifdef CESIUM_THREE_POLYLINE_ARROW
uniform vec4  u_arrowColor;
uniform float u_arrowStrokeHalfPixels;  // open 样式：斜边笔宽（像素）
#endif
`;
}

/**
 * 创建深度打包 shader:非 log-depth 模式下用 Cesium czm_packDepth 打包
 * gl_FragCoord.z;启用 LOG_DEPTH 时打包 Cesium 对数深度值。两种情况下结果都
 * 对齐 ShadowVolumeAppearanceFS 中 czm_unpackDepth 的预期,让 color 命令的
 * 片元着色器能通过 czm_screenToEyeCoordinates 正确重建 eye 坐标。
 *
 * @returns globe depth pass 使用的 RawShaderMaterial。
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

// 地球深度打包 pass:丢弃视锥外地形片元,让 packed-color render target
// 保持清屏哨兵值 (0,0,0,0)(在 depth.ts 中通过 setClearColor(0x000000, 0.0)
// 设置,对齐 Cesium GlobeDepth.js:226 的 Color(0,0,0,0) clear)。
//
// 为什么 discard 而不是 clamp 到 0.0 / 1.0:
//   classification color pass 会读取这个打包深度,并通过 czm_unpackDepth +
//   czm_windowToEyeCoordinates 重建地形世界位置。Cesium ShadowVolumeAppearanceFS
//   的 CULL_FRAGMENTS 分支只认可一个哨兵值(logDepthOrDepth == 0.0)表示
//   "这里没有地形,跳过"。如果把远平面外片元写成 1.0,它会绕过该检查,并喂给
//   czm_windowToEyeCoordinates(fragCoord, 1.0) 一个伪位置:正好停在相机视线
//   方向上的远平面处。之后形状专用边界测试会在这个假 uv 上运行:
//     - 圆的半径测试通常会丢弃远处假位置(旋转对称,较稳健)。
//     - 多边形的点内测试与矩形的轴对齐 bbox 测试会随 camera-forward 指向不同
//       得到不同结果,从而沿 camera-far-plane × ellipsoid 曲线产生错误填充轮廓。
//
//   Cesium 风格的 discard 会让 packed-color 保持清屏后的 0,于是同一个
//   CULL_FRAGMENTS 分支可以同时捕获 "无地形" 和 "地形越过视锥",不需要按形状调参。
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
 * 向 Cesium per-instance color 分支注入适配层边框样式。
 *
 * 几何生成、stencil 更新与 globe-depth 分类仍使用 Cesium 阴影体。边框只是
 * 材质样式,基于 Cesium planar uv 重建出的局部米制坐标计算。
 *
 * @returns 插入了一个 Three 侧边框样式 hook 的 ShadowVolumeAppearanceFS。
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
 * 用 LOG_DEPTH main() 后处理包装 Cesium 阴影体顶点源码,确保
 * czm_vertexLogDepth() 在 gl_Position 最终确定后执行。
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
 * 为 Cesium stencil-depth 命令创建一个面向特定面的材质。
 *
 * @param uniforms 所有 classification 命令共享的 uniforms。
 * @param side 与 Cesium front/back 命令匹配的 Three 面选择。
 * @param stencilZFail 深度测试失败时执行的 stencil 操作。
 * @param name 材质调试名称。
 * @returns 匹配 Cesium z-fail 命令半边的 RawShaderMaterial。
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
		// Cesium getStencilDepthRenderState 使用 DepthFunction.LESS_OR_EQUAL。
		// Three.js 默认是 LessDepth,当阴影体面与地形深度重合时会静默丢掉 stencil 操作。
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
 * 为 Cesium 最终 color classification 命令创建材质。
 *
 * @param uniforms 所有 classification 命令共享的 uniforms。
 * @param fragmentCull Cesium fragment-culling shader define 是否启用。
 * @returns 匹配 Cesium color pass 渲染状态的 RawShaderMaterial。
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
		// 最终 color 命令仍然混合,但必须留在 Three 的 opaque 渲染列表中,
		// 这样 renderOrder 才能让每个标绘对象的 stencil 与 color 命令保持连续。
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
 * 把贴地文字片元分支注入 Cesium per-instance color shader。它与
 * `createColorFragmentBody()` 使用同一个 `vec4 color = czm_gammaCorrect(v_color);`
 * 锚点,因此矩形/圆填充与文字之间只差内部片元分支。文字分支复用 CPU-plane
 * 的 `planarMeters` 路径(与边框路径同一套精度管线),使用 `u_innerMetersRect.zw`
 * 中存储的 footprint 米制尺寸归一化到 `[0,1]` uv,随后在翻转 V 轴后采样
 * `u_textTexture`(canvas 原点在左上,uv 原点在 SW)。
 *
 * @returns 插入文字采样分支后的 ShadowVolumeAppearanceFS。
 * @throws  当 Cesium 锚点行缺失时抛出(上游 shader 发生变化)。
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
    // 足迹外写透明色：颜色不落屏，但 color pass 仍会执行 ZeroStencilOp。
    if (textUv.x < 0.0 || textUv.x > 1.0 || textUv.y < 0.0 || textUv.y > 1.0) {
        out_FragColor = vec4(0.0);
        return;
    }
    // canvas 原点左上、Y 向下；uv 原点 SW、Y 向上 → 翻转 V
    vec4 texel = texture(u_textTexture, vec2(textUv.x, 1.0 - textUv.y));
    // 透明纹素写透明色：预乘混合下不改变颜色缓冲，但会清掉 stencil。
    if (texel.a <= 0.0) {
        out_FragColor = vec4(0.0);
        return;
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
 * 用 LOG_DEPTH `main()` 后处理包装文字 color 片元主体,确保
 * `czm_writeLogDepth()` 在纹理采样 early-return 路径之后执行。
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
 * 创建贴地文字 color 材质。渲染状态逐字节匹配 `createColorMaterial`,让
 * front-stencil / back-stencil / color 命令块保持同一 render-order 契约;
 * 唯一差异是 `CESIUM_THREE_TEXT` define 与采样 `u_textTexture` 的片元分支。
 * 调用方应通过共享 `extraUniforms` 路径注入纹理 uniform,从而保持
 * LOG_DEPTH + CPU-plane + Float64-RTE 精度管线不变。
 *
 * @param uniforms     共享 uniforms(必须包含 `u_textTexture` 值)。
 * @param fragmentCull Cesium `CULL_FRAGMENTS` define 是否启用。
 * @returns            文字 color 命令使用的 RawShaderMaterial。
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

	// 9.5) Arrow 收口裁剪：在线**全局**起 / 终端的 Lm 米内,按 style 裁线,
	//      避免线体与箭头在同一像素叠加(半透明翻倍)。
	//        - SOLID：整段裁掉,线在箭头 base 处收平,实心三角独占箭头长度区域。
	//          这是修复「箭头与线重叠处透明度叠加」的关键——之前这里把线收窄成
	//          一个与实心三角完全重合的薄片并保留,箭头再画上去 → 重叠区 alpha 翻倍。
	//        - OPEN：横向半宽线性收窄到 Wm·(dist / Lm) 之内,线收成尖角嵌进 chevron,
	//          保持线在 chevron 内连续(否则线端与 chevron 之间会出现断口)。
	//      用全局 s × u_lineTotalMeters 算「沿线到端点的米距离」，避免多段
	//      polyline 在中间段的 distanceFromStart / End 误触发裁剪。
	//      Lm / Wm 跟随 u_arrowWidthMode：world 直接用米、screen 用 px×mpp(P)。
	//      仅在 u_lineArrowClip*Enabled > 0.5 时执行——对应端没有箭头时跳过。
	if ( u_lineArrowClipEndEnabled > 0.5 ) {
		float arrowLm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
			u_arrowLengthMeters,
			u_arrowLengthPixels * czm_metersPerPixel( eyeCoordinate )
		);
		float distFromGlobalEnd = ( 1.0 - s ) * u_lineTotalMeters;
		if ( distFromGlobalEnd < arrowLm && arrowLm > 0.0 ) {
			// 终端按**终端自己的**样式 id 收口（与起端独立）。
			if ( int( u_lineArrowStyleEnd + 0.5 ) == ARROW_STYLE_OPEN ) {
				// OPEN：横向半宽线性收窄成 V 形嵌进 chevron,保持线在 chevron 内连续。
				float arrowWm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
					u_arrowHalfWidthMeters,
					u_arrowHalfWidthPixels * czm_metersPerPixel( eyeCoordinate )
				);
				float allowedHalfWidth = arrowWm * ( distFromGlobalEnd / arrowLm );
				if ( abs( widthwiseDistance ) > allowedHalfWidth ) {
					discard;
				}
			} else {
				// SOLID（及其它实心类，默认）：整段裁掉,线在箭头 base 处收平,让实心
				// 三角独占该区域。否则线在三角形内保留的那层会与箭头叠加 → 半透明翻倍。
				discard;
			}
		}
	}
	if ( u_lineArrowClipStartEnabled > 0.5 ) {
		float arrowLm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
			u_arrowLengthMeters,
			u_arrowLengthPixels * czm_metersPerPixel( eyeCoordinate )
		);
		float distFromGlobalStart = s * u_lineTotalMeters;
		if ( distFromGlobalStart < arrowLm && arrowLm > 0.0 ) {
			// 起端按**起端自己的**样式 id 收口（与终端独立）。
			if ( int( u_lineArrowStyleStart + 0.5 ) == ARROW_STYLE_OPEN ) {
				float arrowWm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
					u_arrowHalfWidthMeters,
					u_arrowHalfWidthPixels * czm_metersPerPixel( eyeCoordinate )
				);
				float allowedHalfWidth = arrowWm * ( distFromGlobalStart / arrowLm );
				if ( abs( widthwiseDistance ) > allowedHalfWidth ) {
					discard;
				}
			} else {
				discard;
			}
		}
	}

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
 * 创建贴地线材质:单 mesh、BackSide、无 stencil、depthTest 关闭、预乘混合。
 * 通过 `CESIUM_THREE_POLYLINE` define 复用 createVertexPrefix /
 * createFragmentPrefix,引入 metersPerPixel 与线 uniform,同时保持 stencil /
 * color 材质输出逐字节一致。
 *
 * @param uniforms     共享 uniforms 映射(必须包含 `czm_projection`,
 *                     `czm_pixelRatio`, `u_lineWidthPixels`, `u_lineWidthMode`,
 *                     `u_lineWidthMeters`, dash uniforms, `u_lineTotalMeters`).
 * @param debugVolume  When true，FS 用半透红色直接绘制盒子的所有像素（不做
 *                     terrain depth 重建 / 平面距离裁切），方便诊断「盒子有没有
 *                     盖到该屏幕区域」「FS 是不是被裁切掉」这类几何 / 着色器问题。
 * @returns            驱动深度重建线 pass 的 RawShaderMaterial。
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
in vec3 arrowCorner;             // (aCoef, bSign, topBottomSide)
in vec2 arrowTerrainHeights;     // (minHeight, maxHeight) 端点处地形高度窗口（米）
in float arrowStyleId;           // 逐盒样式 id（见 ARROW_STYLE_ID / ARROW_STYLE_* define）

out vec3 v_arrowTipEC;
out vec3 v_arrowBackEC;
out vec3 v_arrowRightEC;
// 逐盒常量（同一盒 8 顶点同值），flat 直透 FS——两端可不同样式。
flat out float v_arrowStyle;

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
	v_arrowStyle   = arrowStyleId;

	// 3) 像素 → 米：盒子放大 ARROW_BOX_PADDING 倍包住 FS 三角形。
	//    *关键*：tip 在 alt=0（椭球面），相机若高于 tip 又看着地形，则 mpp(tipEC)
	//    用的是「相机到 tip」的远距离 → 盒子米数大。FS 用 mpp(P) 用的是「相机到
	//    地形」的近距离 → 三角形米数小。两者错位会造成「箭头跟着缩放变大」「顶部
	//    冒线段」等 alignment 伪影。我们仍用 mpp(tipEC) 算盒子大小（盒子和 tip 都
	//    在 alt=0 平面），但通过 §5 把盒子竖直拉到 terrain 高度窗口，**让盒子在
	//    屏幕上贯穿 tip 和 terrain 两个高度的投影**，从而覆盖 FS 三角形会出现的
	//    屏幕像素。
	float mpp = max( 0.0, czm_metersPerPixel( tipEC ) );
	float Lm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowLengthMeters,
		u_arrowLengthPixels * mpp
	) * ARROW_BOX_PADDING;
	float Wm = czm_branchFreeTernary( u_arrowWidthMode > 0.5,
		u_arrowHalfWidthMeters,
		u_arrowHalfWidthPixels * mpp
	) * ARROW_BOX_PADDING;

	// 3.5) 箭头 apex 落在线端点上（aOffset = 0）。
	//      早期版本曾按 lineHalfW * Lm / (Wm - lineHalfW) 把 apex 推到端点
	//      之外、想用箭头宽度盖住线段端点的「肩膀」露头，但这条公式把箭头长度
	//      隐式耦合到了线宽：用户调整 arrowWidth 时分母变化、aOffset 突变，
	//      触发 min(.., Lm) cap 时整个箭头长度甚至会从 Lm 跳到 2*Lm，视觉上
	//      变得「调宽度时长度也乱跳」（用户实测反馈）。
	//      所以这里直接 aOffset=0：箭头长度只跟 Lm 走，不耦合线宽。代价是
	//      SOLID 端点处宽度从 0 起步、Wm*(a/Lm) 没那么快盖到 ±lineHalfW，可能
	//      露出几像素的「线肩」；这块由 line FS 的 OPEN 收口裁剪去补（在
	//      POLYLINE_FS §9.5），不再让箭头自身长度做这件事。
	float aOffset = 0.0;

	// 4) 切平面内挤出盒底面四角：tip + back·((aCoef·Lm) − [aCoef=0]·aOffset)
	//    + right·(bSign·Wm)。aCoef=0 的 4 角再额外向 -back 推 aOffset 米，
	//    让盒子的 -back 端面盖到 tip 之外的「外延三角形顶点」屏幕区域。
	float aCoef = arrowCorner.x;
	float bSign = arrowCorner.y;
	float tb    = arrowCorner.z;
	float aPosition = aCoef * Lm + czm_branchFreeTernary( aCoef < 0.5, - aOffset, 0.0 );
	vec3 positionEC = tipEC.xyz
		+ backEC * aPosition
		+ rightEC * ( bSign * Wm );

	// 5) 竖直薄墙：把盒子顶/底沿 up 推到端点处的「地形高度窗口」——与线 segment
	//    用同套 ApproximateTerrainHeights 数据。**这是修复「箭头随缩放变形」
	//    的关键**：tip 在椭球面（h=0），但 FS 重建的地形点在 terrain（如尼泊尔
	//    5 km），盒子必须竖直贯穿这两个高度，FS 才能在地形屏幕像素跑到。底沿
	//    再按视距额外下延一点（与线一致），覆盖远视距下地形起伏。
	float minH = arrowTerrainHeights.x;
	float maxH = arrowTerrainHeights.y;
	float viewDist = length( tipRTE.xyz );
	float extraDrop = min(
		GLOBE_MINIMUM_ALTITUDE,
		czm_geometricToleranceOverMeter * viewDist
	);
	// tb > 0 → 顶沿推到 maxH；tb < 0 → 底沿推到 minH 再额外下延。
	float altOffset = czm_branchFreeTernary(
		tb > 0.0,
		maxH,
		minH - extraDrop
	);
	positionEC += upEC * altOffset;

	// 6) 投影 + depthClamp + log-depth（与线同协议，必须配对）。
	gl_Position = czm_depthClamp( czm_projection * vec4( positionEC, 1.0 ) );
#ifdef LOG_DEPTH
	czm_vertexLogDepth();
#endif
}
`;

/**
 * 线端箭头 FS。深度纹理重建 + 端点切平面 (a,b) 投影 + 逐盒成员判定。
 * 屏幕恒定来自「FS 用地形点 EC 算 metersPerPixel」（与线 halfMaxWidth 同口径）。
 * 样式由 `v_arrowStyle`（逐盒 `arrowStyleId`）运行时分派：ARROW_STYLE_SOLID 实心
 * 三角、ARROW_STYLE_OPEN 开口雪佛龙——同一 mesh 内两端可不同样式。
 */
const ARROWHEAD_FS = /* glsl */ `
in vec3 v_arrowTipEC;
in vec3 v_arrowBackEC;
in vec3 v_arrowRightEC;
flat in float v_arrowStyle;      // 逐盒样式 id（见 ARROW_STYLE_* define）

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

	// 5.5) 箭头 apex 落在线端点（aOffset = 0）。详见 VS §3.5 的注释——之前那条
	//      lineHalfW * Lm / (Wm - lineHalfW) 公式让 arrowWidth 拖动时长度突变，
	//      已剥离。线肩问题由 line FS 收口裁剪兜底。
	float aOffset = 0.0;
	// 等效新坐标：apex 在 aShift=0（a=-aOffset），base 在 aShift=LmShift（a=Lm）。
	float aShift   = a + aOffset;
	float LmShift  = Lm + aOffset;

	// 6) 成员判定（用 aShift / LmShift；几何意义不变，只是 apex 外移了）。
	//    逐盒按样式 id 分派——同一 mesh 里两端可不同样式（起点实心、终点空心）。
	//    新增样式：加一个 else-if ( style == ARROW_STYLE_X ) 分支即可，默认落回
	//    实心三角。insideArrow 为 true 表示该像素属于箭头，留下；否则 discard。
	int style = int( v_arrowStyle + 0.5 );
	bool insideArrow;
	if ( style == ARROW_STYLE_OPEN ) {
		// 开口雪佛龙：只画三角形两条斜边附近的笔宽内像素。V 形保留完整作为边界，
		// 让线 FS 在端点附近按 V 形收口（线 FS 自带 arrow Lm/Wm uniform 做裁剪）。
		float lineFactor = LmShift / sqrt( LmShift * LmShift + Wm * Wm );
		float edgeDistance = abs( abs( b ) - Wm * ( aShift / LmShift ) ) * lineFactor;
		insideArrow = aShift >= 0.0 && aShift <= LmShift
			&& edgeDistance <= u_arrowStrokeHalfPixels * mpp;
	} else {
		// 实心三角（ARROW_STYLE_SOLID，默认）：0 ≤ aShift ≤ LmShift 且
		// |b| ≤ Wm·(aShift/LmShift)（基底向 apex 线性收窄；apex 落在端点处）。
		insideArrow = aShift >= 0.0 && aShift <= LmShift
			&& abs( b ) <= Wm * ( aShift / LmShift );
	}
	if ( ! insideArrow ) {
#ifdef DEBUG_SHOW_VOLUME
		out_FragColor = vec4( 0.0, 1.0, 0.0, 0.5 );
		return;
#else
		discard;
#endif
	}

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
 * 样式不再走 define 分支：每个盒子的样式由顶点属性 `arrowStyleId` 携带，FS 按 id
 * 分派——单材质即可同时渲染两端不同样式（起点实心、终点空心）。
 *
 * @param uniforms     共享 uniforms（与同一 polyline 实例共用）。
 * @param debugVolume  把盒子整体染绿调试用。
 * @returns            RawShaderMaterial。
 */
export function createArrowHeadMaterial(
	uniforms: SharedUniforms,
	debugVolume = false,
): RawShaderMaterial {
	const defines = combineDefines( [
		'PER_INSTANCE_COLOR',
		'CESIUM_THREE_POLYLINE',
		'CESIUM_THREE_POLYLINE_ARROW',
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
