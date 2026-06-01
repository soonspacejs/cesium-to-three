// ============================================================
// shadow-volume-glsl.ts — 贴地 shadow-volume GLSL 源码(本地内联,去 cesium-ground-source 构建依赖)
// 层级:Cesium-to-Three 贴地适配器 · 着色器源。
// 职责:把 materials.ts 原先用 `?raw` 从 cesium-ground-source/ 导入的 12 段 GLSL
//      内联为本模块的导出字符串常量,使构建图不再触达 cesium-ground-source/。
//      导出标识符与原 import 名保持一致,materials.ts 仅需改 import 来源,逻辑零改动。
// 依赖:无(纯字符串)。
// 被消费:materials.ts(VS/FS 前缀注入 + wrapShaderMain + colorDeclaration 替换)。
//
// ── 行为等价性 ──
//   字符串内容为 Cesium 原 GLSL 的逐字节快照(仅把 CRLF 统一为 LF;GLSL 编译
//   与 materials.ts 的 wrapShaderMain 正则 / colorDeclaration 子串替换均与行尾无关)。
//   因此在相同的 GLSL define 下产生与旧版字节级一致的着色器,可用 Spector.js 抓帧验证。
//
//   注:appearance FS 文本里仍包含 czm_getMaterial / czm_phong /
//   czm_eastNorthUpToEyeCoordinates 等 Cesium 材质系统符号,但它们只出现在
//   PER_INSTANCE_COLOR 的非-FLAT 分支与材质 #else 分支中。本项目恒以
//   `TEXTURE_COORDINATES + PER_INSTANCE_COLOR + FLAT + REQUIRES_EC` 编译,
//   这些分支被预处理器删除,不进编译器,故无需提供这些符号(与旧版相同)。
//
// ── 来源与许可 ──
//   源自 CesiumJS(Apache License 2.0),Copyright Cesium GS, Inc. 及贡献者。
//   依 Apache-2.0 第 4 条保留版权与许可声明。仅做相对路径搬迁与行尾规整,未改算法。
// ============================================================

/**
 * 贴地 classification 主顶点着色器:RTE 顶点重建 + EXTRUDED 挤出 + 平面/球面 UV + depthClamp。
 *
 * 来源:Cesium Source/Shaders/ShadowVolumeAppearanceVS.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumShadowVolumeAppearanceVS = /* glsl */ `in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;

#ifdef EXTRUDED_GEOMETRY
in vec3 extrudeDirection;

uniform float u_globeMinimumAltitude;
#endif // EXTRUDED_GEOMETRY

#ifdef PER_INSTANCE_COLOR
out vec4 v_color;
#endif // PER_INSTANCE_COLOR

#ifdef TEXTURE_COORDINATES
#ifdef SPHERICAL
out vec4 v_sphericalExtents;
#else // SPHERICAL
out vec2 v_inversePlaneExtents;
out vec4 v_westPlane;
out vec4 v_southPlane;
#endif // SPHERICAL
out vec3 v_uvMinAndSphericalLongitudeRotation;
out vec3 v_uMaxAndInverseDistance;
out vec3 v_vMaxAndInverseDistance;
#endif // TEXTURE_COORDINATES

void main()
{
    vec4 position = czm_computePosition();

#ifdef EXTRUDED_GEOMETRY
    float delta = min(u_globeMinimumAltitude, czm_geometricToleranceOverMeter * length(position.xyz));
    delta *= czm_sceneMode == czm_sceneMode3D ? 1.0 : 0.0;

    //extrudeDirection is zero for the top layer
    position = position + vec4(extrudeDirection * delta, 0.0);
#endif

#ifdef TEXTURE_COORDINATES
#ifdef SPHERICAL
    v_sphericalExtents = czm_batchTable_sphericalExtents(batchId);
    v_uvMinAndSphericalLongitudeRotation.z = czm_batchTable_longitudeRotation(batchId);
#else // SPHERICAL
#ifdef COLUMBUS_VIEW_2D
    vec4 planes2D_high = czm_batchTable_planes2D_HIGH(batchId);
    vec4 planes2D_low = czm_batchTable_planes2D_LOW(batchId);

    // If the primitive is split across the IDL (planes2D_high.x > planes2D_high.w):
    // - If this vertex is on the east side of the IDL (position3DLow.y > 0.0, comparison with position3DHigh may produce artifacts)
    // - existing "east" is on the wrong side of the world, far away (planes2D_high/low.w)
    // - so set "east" as beyond the eastmost extent of the projection (idlSplitNewPlaneHiLow)
    vec2 idlSplitNewPlaneHiLow = vec2(EAST_MOST_X_HIGH - (WEST_MOST_X_HIGH - planes2D_high.w), EAST_MOST_X_LOW - (WEST_MOST_X_LOW - planes2D_low.w));
    bool idlSplit = planes2D_high.x > planes2D_high.w && position3DLow.y > 0.0;
    planes2D_high.w = czm_branchFreeTernary(idlSplit, idlSplitNewPlaneHiLow.x, planes2D_high.w);
    planes2D_low.w = czm_branchFreeTernary(idlSplit, idlSplitNewPlaneHiLow.y, planes2D_low.w);

    // - else, if this vertex is on the west side of the IDL (position3DLow.y < 0.0)
    // - existing "west" is on the wrong side of the world, far away (planes2D_high/low.x)
    // - so set "west" as beyond the westmost extent of the projection (idlSplitNewPlaneHiLow)
    idlSplit = planes2D_high.x > planes2D_high.w && position3DLow.y < 0.0;
    idlSplitNewPlaneHiLow = vec2(WEST_MOST_X_HIGH - (EAST_MOST_X_HIGH - planes2D_high.x), WEST_MOST_X_LOW - (EAST_MOST_X_LOW - planes2D_low.x));
    planes2D_high.x = czm_branchFreeTernary(idlSplit, idlSplitNewPlaneHiLow.x, planes2D_high.x);
    planes2D_low.x = czm_branchFreeTernary(idlSplit, idlSplitNewPlaneHiLow.y, planes2D_low.x);

    vec3 southWestCorner = (czm_modelViewRelativeToEye * czm_translateRelativeToEye(vec3(0.0, planes2D_high.xy), vec3(0.0, planes2D_low.xy))).xyz;
    vec3 northWestCorner = (czm_modelViewRelativeToEye * czm_translateRelativeToEye(vec3(0.0, planes2D_high.x, planes2D_high.z), vec3(0.0, planes2D_low.x, planes2D_low.z))).xyz;
    vec3 southEastCorner = (czm_modelViewRelativeToEye * czm_translateRelativeToEye(vec3(0.0, planes2D_high.w, planes2D_high.y), vec3(0.0, planes2D_low.w, planes2D_low.y))).xyz;
#else // COLUMBUS_VIEW_2D
    // 3D case has smaller "plane extents," so planes encoded as a 64 bit position and 2 vec3s for distances/direction
    vec3 southWestCorner = (czm_modelViewRelativeToEye * czm_translateRelativeToEye(czm_batchTable_southWest_HIGH(batchId), czm_batchTable_southWest_LOW(batchId))).xyz;
    vec3 northWestCorner = czm_normal * czm_batchTable_northward(batchId) + southWestCorner;
    vec3 southEastCorner = czm_normal * czm_batchTable_eastward(batchId) + southWestCorner;
#endif // COLUMBUS_VIEW_2D

    vec3 eastWard = southEastCorner - southWestCorner;
    float eastExtent = length(eastWard);
    eastWard /= eastExtent;

    vec3 northWard = northWestCorner - southWestCorner;
    float northExtent = length(northWard);
    northWard /= northExtent;

    v_westPlane = vec4(eastWard, -dot(eastWard, southWestCorner));
    v_southPlane = vec4(northWard, -dot(northWard, southWestCorner));
    v_inversePlaneExtents = vec2(1.0 / eastExtent, 1.0 / northExtent);
#endif // SPHERICAL
    vec4 uvMinAndExtents = czm_batchTable_uvMinAndExtents(batchId);
    vec4 uMaxVmax = czm_batchTable_uMaxVmax(batchId);

    v_uMaxAndInverseDistance = vec3(uMaxVmax.xy, uvMinAndExtents.z);
    v_vMaxAndInverseDistance = vec3(uMaxVmax.zw, uvMinAndExtents.w);
    v_uvMinAndSphericalLongitudeRotation.xy = uvMinAndExtents.xy;
#endif // TEXTURE_COORDINATES

#ifdef PER_INSTANCE_COLOR
    v_color = czm_batchTable_color(batchId);
#endif

    gl_Position = czm_depthClamp(czm_modelViewProjectionRelativeToEye * position);
}
`;

/**
 * 贴地 classification 主片元着色器:从 globe depth 重建 EC、平面距离算 UV、CULL_FRAGMENTS 裁剪、着色。
 *
 * 来源:Cesium Source/Shaders/ShadowVolumeAppearanceFS.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumShadowVolumeAppearanceFS = /* glsl */ `#ifdef TEXTURE_COORDINATES
#ifdef SPHERICAL
in vec4 v_sphericalExtents;
#else // SPHERICAL
in vec2 v_inversePlaneExtents;
in vec4 v_westPlane;
in vec4 v_southPlane;
#endif // SPHERICAL
in vec3 v_uvMinAndSphericalLongitudeRotation;
in vec3 v_uMaxAndInverseDistance;
in vec3 v_vMaxAndInverseDistance;
#endif // TEXTURE_COORDINATES

#ifdef PER_INSTANCE_COLOR
in vec4 v_color;
#endif

#ifdef NORMAL_EC
vec3 getEyeCoordinate3FromWindowCoordinate(vec2 fragCoord, float logDepthOrDepth) {
    vec4 eyeCoordinate = czm_windowToEyeCoordinates(fragCoord, logDepthOrDepth);
    return eyeCoordinate.xyz / eyeCoordinate.w;
}

vec3 vectorFromOffset(vec4 eyeCoordinate, vec2 positiveOffset) {
    vec2 glFragCoordXY = gl_FragCoord.xy;
    // Sample depths at both offset and negative offset
    float upOrRightLogDepth = czm_unpackDepth(texture(czm_globeDepthTexture, (glFragCoordXY + positiveOffset) / czm_viewport.zw));
    float downOrLeftLogDepth = czm_unpackDepth(texture(czm_globeDepthTexture, (glFragCoordXY - positiveOffset) / czm_viewport.zw));
    // Explicitly evaluate both paths
    // Necessary for multifrustum and for edges of the screen
    bvec2 upOrRightInBounds = lessThan(glFragCoordXY + positiveOffset, czm_viewport.zw);
    float useUpOrRight = float(upOrRightLogDepth > 0.0 && upOrRightInBounds.x && upOrRightInBounds.y);
    float useDownOrLeft = float(useUpOrRight == 0.0);
    vec3 upOrRightEC = getEyeCoordinate3FromWindowCoordinate(glFragCoordXY + positiveOffset, upOrRightLogDepth);
    vec3 downOrLeftEC = getEyeCoordinate3FromWindowCoordinate(glFragCoordXY - positiveOffset, downOrLeftLogDepth);
    return (upOrRightEC - (eyeCoordinate.xyz / eyeCoordinate.w)) * useUpOrRight + ((eyeCoordinate.xyz / eyeCoordinate.w) - downOrLeftEC) * useDownOrLeft;
}
#endif // NORMAL_EC

void main(void)
{
#ifdef REQUIRES_EC
    float logDepthOrDepth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
    vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, logDepthOrDepth);
#endif

#ifdef REQUIRES_WC
    vec4 worldCoordinate4 = czm_inverseView * eyeCoordinate;
    vec3 worldCoordinate = worldCoordinate4.xyz / worldCoordinate4.w;
#endif

#ifdef TEXTURE_COORDINATES
    vec2 uv;
#ifdef SPHERICAL
    // Treat world coords as a sphere normal for spherical coordinates
    vec2 sphericalLatLong = czm_approximateSphericalCoordinates(worldCoordinate);
    sphericalLatLong.y += v_uvMinAndSphericalLongitudeRotation.z;
    sphericalLatLong.y = czm_branchFreeTernary(sphericalLatLong.y < czm_pi, sphericalLatLong.y, sphericalLatLong.y - czm_twoPi);
    uv.x = (sphericalLatLong.y - v_sphericalExtents.y) * v_sphericalExtents.w;
    uv.y = (sphericalLatLong.x - v_sphericalExtents.x) * v_sphericalExtents.z;
#else // SPHERICAL
    // Unpack planes and transform to eye space
    uv.x = czm_planeDistance(v_westPlane, eyeCoordinate.xyz / eyeCoordinate.w) * v_inversePlaneExtents.x;
    uv.y = czm_planeDistance(v_southPlane, eyeCoordinate.xyz / eyeCoordinate.w) * v_inversePlaneExtents.y;
#endif // SPHERICAL
#endif // TEXTURE_COORDINATES

#ifdef CULL_FRAGMENTS
    // When classifying translucent geometry, logDepthOrDepth == 0.0
    // indicates a region that should not be classified, possibly due to there
    // being opaque pixels there in another buffer.
    if (uv.x <= 0.0 || 1.0 <= uv.x || uv.y <= 0.0 || 1.0 <= uv.y || logDepthOrDepth == 0.0) {
        discard;
    }
#endif

#ifdef PICK
    out_FragColor.a = 1.0; // Explicitly set the alpha, otherwise this may be discarded by ShaderSource.createPickFragmentShaderSource
#ifdef CULL_FRAGMENTS
    czm_writeDepthClamp();
#endif // CULL_FRAGMENTS
#else // PICK

#ifdef NORMAL_EC
    // Compute normal by sampling adjacent pixels in 2x2 block in screen space
    vec3 downUp = vectorFromOffset(eyeCoordinate, vec2(0.0, 1.0));
    vec3 leftRight = vectorFromOffset(eyeCoordinate, vec2(1.0, 0.0));
    vec3 normalEC = normalize(cross(leftRight, downUp));
#endif


#ifdef PER_INSTANCE_COLOR

    vec4 color = czm_gammaCorrect(v_color);
#ifdef FLAT
    out_FragColor = color;
#else // FLAT
    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = -eyeCoordinate.xyz;
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = color.rgb;
    material.alpha = color.a;

    out_FragColor = czm_phong(normalize(-eyeCoordinate.xyz), material, czm_lightDirectionEC);
#endif // FLAT

    // Premultiply alpha. Required for classification primitives on translucent globe.
    out_FragColor.rgb *= out_FragColor.a;

#else // PER_INSTANCE_COLOR

    // Material support.
    // USES_ is distinct from REQUIRES_, because some things are dependencies of each other or
    // dependencies for culling but might not actually be used by the material.

    czm_materialInput materialInput;

#ifdef USES_NORMAL_EC
    materialInput.normalEC = normalEC;
#endif

#ifdef USES_POSITION_TO_EYE_EC
    materialInput.positionToEyeEC = -eyeCoordinate.xyz;
#endif

#ifdef USES_TANGENT_TO_EYE
    materialInput.tangentToEyeMatrix = czm_eastNorthUpToEyeCoordinates(worldCoordinate, normalEC);
#endif

#ifdef USES_ST
    // Remap texture coordinates from computed (approximately aligned with cartographic space) to the desired
    // texture coordinate system, which typically forms a tight oriented bounding box around the geometry.
    // Shader is provided a set of reference points for remapping.
    materialInput.st.x = czm_lineDistance(v_uvMinAndSphericalLongitudeRotation.xy, v_uMaxAndInverseDistance.xy, uv) * v_uMaxAndInverseDistance.z;
    materialInput.st.y = czm_lineDistance(v_uvMinAndSphericalLongitudeRotation.xy, v_vMaxAndInverseDistance.xy, uv) * v_vMaxAndInverseDistance.z;
#endif

    czm_material material = czm_getMaterial(materialInput);

#ifdef FLAT
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
#else // FLAT
    out_FragColor = czm_phong(normalize(-eyeCoordinate.xyz), material, czm_lightDirectionEC);
#endif // FLAT

    // Premultiply alpha. Required for classification primitives on translucent globe.
    out_FragColor.rgb *= out_FragColor.a;

#endif // PER_INSTANCE_COLOR
    czm_writeDepthClamp();
#endif // PICK
}
`;

/**
 * shadow-volume stencil pass 片元着色器(仅写颜色 + writeDepthClamp)。
 *
 * 来源:Cesium Source/Shaders/ShadowVolumeFS.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumShadowVolumeFS = /* glsl */ `#ifdef VECTOR_TILE
uniform vec4 u_highlightColor;
#endif

void main(void)
{
#ifdef VECTOR_TILE
    out_FragColor = czm_gammaCorrect(u_highlightColor);
#else
    out_FragColor = vec4(1.0);
#endif
    czm_writeDepthClamp();
}
`;

/**
 * czm_depthClamp:WebGL 无 GL_DEPTH_CLAMP,用 emulated-noperspective 把屏幕 z 传到 FS 端钳制。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/depthClamp.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumDepthClamp = /* glsl */ `// emulated noperspective
#if (__VERSION__ == 300 || defined(GL_EXT_frag_depth)) && !defined(LOG_DEPTH)
out float v_WindowZ;
#endif

/**
 * Emulates GL_DEPTH_CLAMP, which is not available in WebGL 1 or 2.
 * GL_DEPTH_CLAMP clamps geometry that is outside the near and far planes, 
 * capping the shadow volume. More information here: 
 * https://www.khronos.org/registry/OpenGL/extensions/ARB/ARB_depth_clamp.txt.
 *
 * When GL_EXT_frag_depth is available we emulate GL_DEPTH_CLAMP by ensuring 
 * no geometry gets clipped by setting the clip space z value to 0.0 and then
 * sending the unaltered screen space z value (using emulated noperspective
 * interpolation) to the frag shader where it is clamped to [0,1] and then
 * written with gl_FragDepth (see czm_writeDepthClamp). This technique is based on:
 * https://stackoverflow.com/questions/5960757/how-to-emulate-gl-depth-clamp-nv.
 *
 * When GL_EXT_frag_depth is not available, which is the case on some mobile 
 * devices, we must attempt to fix this only in the vertex shader. 
 * The approach is to clamp the z value to the far plane, which closes the 
 * shadow volume but also distorts the geometry, so there can still be artifacts
 * on frustum seams.
 *
 * @name czm_depthClamp
 * @glslFunction
 *
 * @param {vec4} coords The vertex in clip coordinates.
 * @returns {vec4} The modified vertex.
 *
 * @example
 * gl_Position = czm_depthClamp(czm_modelViewProjection * vec4(position, 1.0));
 *
 * @see czm_writeDepthClamp
 */
vec4 czm_depthClamp(vec4 coords)
{
#ifndef LOG_DEPTH
#if __VERSION__ == 300 || defined(GL_EXT_frag_depth)
    v_WindowZ = (0.5 * (coords.z / coords.w) + 0.5) * coords.w;
    coords.z = 0.0;
#else
    coords.z = min(coords.z, coords.w);
#endif
#endif
    return coords;
}
`;

/**
 * czm_writeDepthClamp:在 FS 把 v_WindowZ 钳到 [0,1] 写入 gl_FragDepth。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/writeDepthClamp.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumWriteDepthClamp = /* glsl */ `// emulated noperspective
#if !defined(LOG_DEPTH)
in float v_WindowZ;
#endif

/**
 * Emulates GL_DEPTH_CLAMP. Clamps a fragment to the near and far plane
 * by writing the fragment's depth. See czm_depthClamp for more details.
 *
 * @name czm_writeDepthClamp
 * @glslFunction
 *
 * @example
 * out_FragColor = color;
 * czm_writeDepthClamp();
 *
 * @see czm_depthClamp
 */
void czm_writeDepthClamp()
{
#if (!defined(LOG_DEPTH) && (__VERSION__ == 300 || defined(GL_EXT_frag_depth)))
    gl_FragDepth = clamp(v_WindowZ * gl_FragCoord.w, 0.0, 1.0);
#endif
}
`;

/**
 * czm_translateRelativeToEye:GPU RTE,high/low 双精度分量相对相机做差消抖。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/translateRelativeToEye.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumTranslateRelativeToEye = /* glsl */ `/**
 * Translates a position (or any <code>vec3</code>) that was encoded with {@link EncodedCartesian3},
 * and then provided to the shader as separate <code>high</code> and <code>low</code> bits to
 * be relative to the eye.  As shown in the example, the position can then be transformed in eye
 * or clip coordinates using {@link czm_modelViewRelativeToEye} or {@link czm_modelViewProjectionRelativeToEye},
 * respectively.
 * <p>
 * This technique, called GPU RTE, eliminates jittering artifacts when using large coordinates as
 * described in {@link http://help.agi.com/AGIComponents/html/BlogPrecisionsPrecisions.htm|Precisions, Precisions}.
 * </p>
 *
 * @name czm_translateRelativeToEye
 * @glslFunction
 *
 * @param {vec3} high The position's high bits.
 * @param {vec3} low The position's low bits.
 * @returns {vec3} The position translated to be relative to the camera's position.
 *
 * @example
 * in vec3 positionHigh;
 * in vec3 positionLow;
 *
 * void main()
 * {
 *   vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
 *   gl_Position = czm_modelViewProjectionRelativeToEye * p;
 * }
 *
 * @see czm_modelViewRelativeToEye
 * @see czm_modelViewProjectionRelativeToEye
 * @see czm_computePosition
 * @see EncodedCartesian3
 */
vec4 czm_translateRelativeToEye(vec3 high, vec3 low)
{
    vec3 highDifference = high - czm_encodedCameraPositionMCHigh;
    // This check handles the case when NaN values have gotten into \`highDifference\`.
    // Such a thing could happen on devices running iOS.
    if (length(highDifference) == 0.0) {  
        highDifference = vec3(0);  
    }
    vec3 lowDifference = low - czm_encodedCameraPositionMCLow;

    return vec4(highDifference + lowDifference, 1.0);
}
`;

/**
 * czm_windowToEyeCoordinates:窗口坐标 + (log)depth 反算到眼坐标。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/windowToEyeCoordinates.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumWindowToEyeCoordinates = /* glsl */ `vec4 czm_screenToEyeCoordinates(vec4 screenCoordinate)
{
    // Reconstruct NDC coordinates
    float x = 2.0 * screenCoordinate.x - 1.0;
    float y = 2.0 * screenCoordinate.y - 1.0;
    float z = (screenCoordinate.z - czm_viewportTransformation[3][2]) / czm_viewportTransformation[2][2];
    vec4 q = vec4(x, y, z, 1.0);

    // Reverse the perspective division to obtain clip coordinates.
    q /= screenCoordinate.w;

    // Reverse the projection transformation to obtain eye coordinates.
    if (!(czm_inverseProjection == mat4(0.0))) // IE and Edge sometimes do something weird with != between mat4s
    {
        q = czm_inverseProjection * q;
    }
    else
    {
        float top = czm_frustumPlanes.x;
        float bottom = czm_frustumPlanes.y;
        float left = czm_frustumPlanes.z;
        float right = czm_frustumPlanes.w;

        float near = czm_currentFrustum.x;
        float far = czm_currentFrustum.y;

        q.x = (q.x * (right - left) + left + right) * 0.5;
        q.y = (q.y * (top - bottom) + bottom + top) * 0.5;
        q.z = (q.z * (near - far) - near - far) * 0.5;
        q.w = 1.0;
    }

    return q;
}

/**
 * Transforms a position from window to eye coordinates.
 * The transform from window to normalized device coordinates is done using components
 * of (@link czm_viewport} and {@link czm_viewportTransformation} instead of calculating
 * the inverse of <code>czm_viewportTransformation</code>. The transformation from
 * normalized device coordinates to clip coordinates is done using <code>fragmentCoordinate.w</code>,
 * which is expected to be the scalar used in the perspective divide. The transformation
 * from clip to eye coordinates is done using {@link czm_inverseProjection}.
 *
 * @name czm_windowToEyeCoordinates
 * @glslFunction
 *
 * @param {vec4} fragmentCoordinate The position in window coordinates to transform.
 *
 * @returns {vec4} The transformed position in eye coordinates.
 *
 * @see czm_modelToWindowCoordinates
 * @see czm_eyeToWindowCoordinates
 * @see czm_inverseProjection
 * @see czm_viewport
 * @see czm_viewportTransformation
 *
 * @example
 * vec4 positionEC = czm_windowToEyeCoordinates(gl_FragCoord);
 */
vec4 czm_windowToEyeCoordinates(vec4 fragmentCoordinate)
{
    vec2 screenCoordXY = (fragmentCoordinate.xy - czm_viewport.xy) / czm_viewport.zw;
    return czm_screenToEyeCoordinates(vec4(screenCoordXY, fragmentCoordinate.zw));
}

vec4 czm_screenToEyeCoordinates(vec2 screenCoordinateXY, float depthOrLogDepth)
{
    // See reverseLogDepth.glsl. This is separate to re-use the pow.
#if defined(LOG_DEPTH) || defined(LOG_DEPTH_READ_ONLY)
    float near = czm_currentFrustum.x;
    float far = czm_currentFrustum.y;
    float log2Depth = depthOrLogDepth * czm_log2FarDepthFromNearPlusOne;
    float depthFromNear = exp2(log2Depth) - 1.0;
    float depthFromCamera = depthFromNear + near;
    vec4 screenCoord = vec4(screenCoordinateXY, far * (1.0 - near / depthFromCamera) / (far - near), 1.0);
    vec4 eyeCoordinate = czm_screenToEyeCoordinates(screenCoord);
    eyeCoordinate.w = 1.0 / depthFromCamera; // Better precision
#else
    vec4 screenCoord = vec4(screenCoordinateXY, depthOrLogDepth, 1.0);
    vec4 eyeCoordinate = czm_screenToEyeCoordinates(screenCoord);
#endif
    return eyeCoordinate;
}

/**
 * Transforms a position given as window x/y and a depth or a log depth from window to eye coordinates.
 * This function produces more accurate results for window positions with log depth than
 * conventionally unpacking the log depth using czm_reverseLogDepth and using the standard version
 * of czm_windowToEyeCoordinates.
 *
 * @name czm_windowToEyeCoordinates
 * @glslFunction
 *
 * @param {vec2} fragmentCoordinateXY The XY position in window coordinates to transform.
 * @param {float} depthOrLogDepth A depth or log depth for the fragment.
 *
 * @see czm_modelToWindowCoordinates
 * @see czm_eyeToWindowCoordinates
 * @see czm_inverseProjection
 * @see czm_viewport
 * @see czm_viewportTransformation
 *
 * @returns {vec4} The transformed position in eye coordinates.
 */
vec4 czm_windowToEyeCoordinates(vec2 fragmentCoordinateXY, float depthOrLogDepth)
{
    vec2 screenCoordXY = (fragmentCoordinateXY.xy - czm_viewport.xy) / czm_viewport.zw;
    return czm_screenToEyeCoordinates(screenCoordXY, depthOrLogDepth);
}
`;

/**
 * czm_unpackDepth:RGBA → float 深度解包。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/unpackDepth.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumUnpackDepth = /* glsl */ `/**
 * Unpacks a vec4 depth value to a float in [0, 1) range.
 *
 * @name czm_unpackDepth
 * @glslFunction
 *
 * @param {vec4} packedDepth The packed depth.
 *
 * @returns {float} The floating-point depth in [0, 1) range.
 */
float czm_unpackDepth(vec4 packedDepth)
{
    // See Aras Pranckevičius' post Encoding Floats to RGBA
    // http://aras-p.info/blog/2009/07/30/encoding-floats-to-rgba-the-final/
    return dot(packedDepth, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
`;

/**
 * czm_packDepth:float → RGBA 深度打包。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/packDepth.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumPackDepth = /* glsl */ `/**
 * Packs a depth value into a vec4 that can be represented by unsigned bytes.
 *
 * @name czm_packDepth
 * @glslFunction
 *
 * @param {float} depth The floating-point depth.
 * @returns {vec4} The packed depth.
 */
vec4 czm_packDepth(float depth)
{
    // See Aras Pranckevičius' post Encoding Floats to RGBA
    // http://aras-p.info/blog/2009/07/30/encoding-floats-to-rgba-the-final/
    vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * depth;
    enc = fract(enc);
    enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
    return enc;
}
`;

/**
 * czm_planeDistance:点到 Hessian 平面的有符号距离(两个重载)。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/planeDistance.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumPlaneDistance = /* glsl */ `/**
 * Computes distance from a point to a plane.
 *
 * @name czm_planeDistance
 * @glslFunction
 *
 * param {vec4} plane A Plane in Hessian Normal Form. See Plane.js
 * param {vec3} point A point in the same space as the plane.
 * returns {float} The distance from the point to the plane.
 */
float czm_planeDistance(vec4 plane, vec3 point) {
    return (dot(plane.xyz, point) + plane.w);
}

/**
 * Computes distance from a point to a plane.
 *
 * @name czm_planeDistance
 * @glslFunction
 *
 * param {vec3} planeNormal Normal for a plane in Hessian Normal Form. See Plane.js
 * param {float} planeDistance Distance for a plane in Hessian Normal form. See Plane.js
 * param {vec3} point A point in the same space as the plane.
 * returns {float} The distance from the point to the plane.
 */
float czm_planeDistance(vec3 planeNormal, float planeDistance, vec3 point) {
    return (dot(planeNormal, point) + planeDistance);
}
`;

/**
 * czm_gammaCorrect:HDR 下 RGB→线性(非 HDR 直通)。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/gammaCorrect.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumGammaCorrect = /* glsl */ `/**
 * Converts a color from RGB space to linear space.
 *
 * @name czm_gammaCorrect
 * @glslFunction
 *
 * @param {vec3} color The color in RGB space.
 * @returns {vec3} The color in linear space.
 */
vec3 czm_gammaCorrect(vec3 color) {
#ifdef HDR
    color = pow(color, vec3(czm_gamma));
#endif
    return color;
}

vec4 czm_gammaCorrect(vec4 color) {
#ifdef HDR
    color.rgb = pow(color.rgb, vec3(czm_gamma));
#endif
    return color;
}
`;

/**
 * czm_metersPerPixel:给定眼坐标位置算每像素覆盖的米数。
 *
 * 来源:Cesium Source/Shaders/Builtin/Functions/metersPerPixel.glsl（Apache-2.0,逐字节快照,仅 CRLF→LF）。
 */
export const cesiumMetersPerPixel = /* glsl */ `/**
 * Computes the size of a pixel in meters at a distance from the eye.
 * <p>
 * Use this version when passing in a custom pixel ratio. For example, passing in 1.0 will return meters per native device pixel.
 * </p>
 * @name czm_metersPerPixel
 * @glslFunction
 *
 * @param {vec3} positionEC The position to get the meters per pixel in eye coordinates.
 * @param {float} pixelRatio The scaling factor from pixel space to coordinate space
 *
 * @returns {float} The meters per pixel at positionEC.
 */
float czm_metersPerPixel(vec4 positionEC, float pixelRatio)
{
    float width = czm_viewport.z;
    float height = czm_viewport.w;
    float pixelWidth;
    float pixelHeight;

    float top = czm_frustumPlanes.x;
    float bottom = czm_frustumPlanes.y;
    float left = czm_frustumPlanes.z;
    float right = czm_frustumPlanes.w;

    if (czm_sceneMode == czm_sceneMode2D || czm_orthographicIn3D == 1.0)
    {
        float frustumWidth = right - left;
        float frustumHeight = top - bottom;
        pixelWidth = frustumWidth / width;
        pixelHeight = frustumHeight / height;
    }
    else
    {
        float distanceToPixel = -positionEC.z;
        float inverseNear = 1.0 / czm_currentFrustum.x;
        float tanTheta = top * inverseNear;
        pixelHeight = 2.0 * distanceToPixel * tanTheta / height;
        tanTheta = right * inverseNear;
        pixelWidth = 2.0 * distanceToPixel * tanTheta / width;
    }

    return max(pixelWidth, pixelHeight) * pixelRatio;
}

/**
 * Computes the size of a pixel in meters at a distance from the eye.
 * <p>
 * Use this version when scaling by pixel ratio.
 * </p>
 * @name czm_metersPerPixel
 * @glslFunction
 *
 * @param {vec3} positionEC The position to get the meters per pixel in eye coordinates.
 *
 * @returns {float} The meters per pixel at positionEC.
 */
float czm_metersPerPixel(vec4 positionEC)
{
    return czm_metersPerPixel(positionEC, czm_pixelRatio);
}
`;
