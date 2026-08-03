// ============================================================
// shadow-volume-glsl.ts
// Purpose: retain the one Cesium GLSL helper still consumed by the standalone
//          packed-depth pass. Classification shaders now live in explicit,
//          section-based Ground system sources and no longer patch snapshots.
// ============================================================

/**
 * `czm_packDepth`: float to RGBA depth packing.
 *
 * Source: Cesium Source/Shaders/Builtin/Functions/packDepth.glsl
 * (Apache-2.0; line endings normalized to LF).
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
