// ============================================================
// geometry.ts
// 层级:Cesium-to-Three 贴地几何 RTE 编码器。
// 职责:导出与 Cesium EncodedCartesian3.encode 等价的辅助函数，用于
//      classification 运行时把相机位置拆成 high / low 两个 Float32 分量。
//      原本放在这里的矩形、多边形、平面范围和调试网格逻辑已迁移到
//      `math/`、`rectangle/`、`polygon/` 子模块；本文件刻意保持很小，
//      只保证 classification.ts 的精度关键导入路径不变。
// 依赖:Three.js Vector3 类型。
// 被消费:classification.ts 的精度路径。
// ============================================================

import type { Vector3 } from 'three';

import type { EncodedScalar } from './types';

/**
 * 使用 Cesium EncodedCartesian3.encode 算法编码一个浮点数。
 *
 * @param value 模型坐标中的 64-bit JavaScript number。
 * @returns 供 czm_translateRelativeToEye 消费的 high / low 分量。
 */
function encodeCesiumFloat( value: number ): EncodedScalar {
	let doubleHigh: number;

	if ( value >= 0.0 ) {
		doubleHigh = Math.floor( value / 65536.0 ) * 65536.0;
		return { high: doubleHigh, low: value - doubleHigh };
	}

	doubleHigh = Math.floor( - value / 65536.0 ) * 65536.0;
	return { high: - doubleHigh, low: value + doubleHigh };
}

/**
 * 使用 Cesium 相同的定点拆分方式编码 Three 向量。
 *
 * 保留在本模块中，方便 classification.ts 沿用原导入路径。
 *
 * @param source ECEF / 模型坐标向量。
 * @param high 输出 high 向量。
 * @param low 输出 low 向量。
 */
export function encodeCesiumVector3( source: Vector3, high: Vector3, low: Vector3 ): void {
	const x = encodeCesiumFloat( source.x );
	const y = encodeCesiumFloat( source.y );
	const z = encodeCesiumFloat( source.z );

	high.set( x.high, y.high, z.high );
	low.set( x.low, y.low, z.low );
}
