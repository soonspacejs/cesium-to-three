// ============================================================
// math/rte-encoding.ts — Relative-To-Eye 双精度编码
// 层级:L0(零依赖数学基础)
// 职责:把 IEEE-754 Float64 ECEF 位置拆为两个 Float32 (high32, low32),
//      使 GPU Float32 着色器能够在椭球量级(1e7 米)坐标下保留
//      ≤ 1 米精度。采用 65536 fixed-point 拆分(非 IEEE Math.fround 拆分),
//      与 Cesium EncodedCartesian3 字节级一致。
//
// 拆分原理(以正数为例):
//      high = floor(value / 65536) · 65536    (低 16 位清零的"高"部分)
//      low  = value − high                    (|low| < 65536,可含小数)
//   合并:high + low === value(Float64 精度)。
//   high 是 65536 的整数倍,最大 ~6.36e6 < 2²⁴ = 16777216,Float32 精确表示。
//   |low| < 65536 < 2²⁴,Float32 精确表示。
//
// GPU 端用 `(p.high − eye.high) + (p.low − eye.low)` 算 RTE 偏移,
// 大数差(high − high)+ 小数差(low − low)→ 最终亚米精度。
// 依赖:Three.js Vector3
// 被消费:rectangle/rectangle-shadow-volume.ts、rectangle/rectangle-extents.ts、
//        classification.ts(每帧编码相机位置 RTE)
// 算法对应:Cesium Source/Core/EncodedCartesian3.js#encode(L52-76)
//          + EncodedCartesian3.fromCartesian(L98-110)
//          + Source/Core/GeometryPipeline.js#encodeAttribute(L727-788)
// ============================================================

import type { Vector3 } from 'three';

/**
 * 把一个 Float64 标量拆为 (high, low) 两个 Float32 等价分量。
 *
 * 算法逐字复刻 Cesium `EncodedCartesian3.encode`:
 *   - 正数:doubleHigh = floor(value / 65536) · 65536;return (doubleHigh, value − doubleHigh)
 *   - 负数:对称处理(对 −value 取 doubleHigh,然后 high = −doubleHigh,low = value + doubleHigh)
 *
 * 验证:high + low === value(Float64 精度无损)。
 *
 * @param value 任意 Float64 标量(米尺度典型 ±1e7)。
 * @returns     高低分量对象。返回新对象,V8 逃逸分析后栈分配。
 */
export function encodeScalarRTE( value: number ): { high: number; low: number } {
	let doubleHigh: number;

	if ( value >= 0.0 ) {
		doubleHigh = Math.floor( value / 65536.0 ) * 65536.0;
		return { high: doubleHigh, low: value - doubleHigh };
	}

	doubleHigh = Math.floor( -value / 65536.0 ) * 65536.0;
	return { high: -doubleHigh, low: value + doubleHigh };
}

/**
 * 把一个 Vector3 的三个分量分别 RTE 编码,写入 outHigh / outLow。
 *
 * 等价 Cesium `EncodedCartesian3.fromCartesian(source, result)`。
 *
 * 使用场景:
 *   - 每帧:classification.ts 中编码相机位置(czm_encodedCameraPositionMC*)
 *   - 一次性:computeRectanglePlanarExtents 中编码 SW 角点(u_southWest_*)
 *
 * @param source  输入 ECEF 向量(米)。
 * @param outHigh 输出高分量向量。
 * @param outLow  输出低分量向量。
 */
export function encodeVec3RTE(
	source: Vector3,
	outHigh: Vector3,
	outLow: Vector3,
): void {
	const x = encodeScalarRTE( source.x );
	const y = encodeScalarRTE( source.y );
	const z = encodeScalarRTE( source.z );

	outHigh.set( x.high, y.high, z.high );
	outLow.set( x.low, y.low, z.low );
}

/**
 * 把一整个 Float64Array(ECEF 顶点数组)拆为两个等长 Float32Array。
 *
 * 等价 Cesium `GeometryPipeline.encodeAttribute(geom, 'position', 'position3DHigh', 'position3DLow')`,
 * 但解耦自 Cesium 的 Geometry 容器 — 直接返回两个 Float32Array,
 * 由 caller 装入 Three BufferGeometry。
 *
 * 类型转换说明:
 *   `high[i] = hi`(hi 是 Float64)在 TypedArray 隐式转换时截断到 Float32。
 *   由于 hi 永远是 65536 的整数倍且 |hi| < 1e7 < 2²⁴,Float32 精确表示无损。
 *   `low[i] = lo` 同理(|lo| < 65536)。
 *
 * @param positions ECEF 顶点数组(长度 = 3 × vertexCount)。
 * @returns         两个 Float32Array,长度同输入。
 */
export function encodePositionsToHighLowArrays(
	positions: Float64Array,
): { high: Float32Array; low: Float32Array } {
	const length = positions.length;
	const high = new Float32Array( length );
	const low = new Float32Array( length );

	for ( let i = 0; i < length; i++ ) {
		const encoded = encodeScalarRTE( positions[ i ] );
		high[ i ] = encoded.high;
		low[ i ] = encoded.low;
	}

	return { high, low };
}
