// ============================================================
// math/enu-frame.ts — 东-北-上(ENU)局部坐标系到 ECEF 的 4×4 矩阵
// 层级:L0(零依赖数学基础)
// 职责:在 ECEF 原点构造 ENU 基底,生成 4×4 列主序矩阵,使得
//      M · (e, n, u, 1)^T = ECEF 位置
//      其中 (e, n, u) 是该原点处的局部东-北-上坐标(米)。
//      完整实现 Cesium 的三个分支:零点退化 / 极点 / 一般情况。
// 依赖:Three.js Matrix4 + Vector3、math/ellipsoid.ts、math/constants.ts
// 被消费:rectangle/rectangle-helpers.ts、rectangle/rectangle-extents.ts
// 算法对应:Cesium Source/Core/Transforms.js#localFrameToFixedFrameGenerator("east","north")
//          + Transforms.eastNorthUpToFixedFrame(L276-279,通过生成器一次性创建)
// ============================================================

import { Matrix4, Vector3 } from 'three';

import { EPSILON14 } from './constants';
import { geodeticSurfaceNormal } from './ellipsoid';
import { vec3MagnitudeSquared } from './vec3-helpers';

// ── 模块级 scratch(三个基底向量复用,无线程安全风险)──
const _enuEast = new Vector3();
const _enuNorth = new Vector3();
const _enuUp = new Vector3();

/**
 * 在给定 ECEF 原点构造 ENU(东-北-上)→ ECEF 变换矩阵。
 *
 * 输出矩阵 M 的列布局:
 *   列 0:east  基底(单位向量)
 *   列 1:north 基底(单位向量)
 *   列 2:up    基底(单位向量,沿椭球面法向)
 *   列 3:平移 = origin
 *
 * 对任意局部 ENU 坐标 (e, n, u),`M · [e, n, u, 1]^T` 给出该点的 ECEF 坐标。
 *
 * 完整实现三个分支(必须全部保留,与 Cesium 字节级对齐):
 *   分支 1:|origin|² < EPSILON14² → 退化为约定基底(east=Y,north=Z,up=X)
 *   分支 2:|origin.x|, |origin.y| < EPSILON14 → 极点约定(east=X,north=±Y,up=±Z)
 *   分支 3:一般情况 → up = geodeticSurfaceNormal(origin),
 *                     east = normalize(-origin.y, origin.x, 0),
 *                     north = up × east
 *
 * Cesium 对应:Transforms.js:99-279(生成器)+ L276-279(具体绑定 east+north)
 *
 * @param origin ECEF 原点(米);可以是椭球表面或上方任意点。
 * @param out    输出 4×4 矩阵(原地写入)。
 * @returns      out(链式调用)。
 */
export function eastNorthUpToFixedFrame(
	origin: Vector3,
	out: Matrix4,
): Matrix4 {
	const east = _enuEast;
	const north = _enuNorth;
	const up = _enuUp;

	if ( vec3MagnitudeSquared( origin ) < EPSILON14 * EPSILON14 ) {
		// 分支 1 · 退化:原点在椭球中心,ENU 无意义。
		// Cesium 约定 east=[0,1,0]、north=[0,0,1]、up=[1,0,0],我们一致。
		east.set( 0.0, 1.0, 0.0 );
		north.set( 0.0, 0.0, 1.0 );
		up.set( 1.0, 0.0, 0.0 );
	} else if (
		Math.abs( origin.x ) < EPSILON14 &&
		Math.abs( origin.y ) < EPSILON14
	) {
		// 分支 2 · 极点:east 无定义(任何水平方向"既东又西")。
		// Cesium 约定 east=[1,0,0],north / up 根据 z 符号取北极 / 南极方向。
		const sign = origin.z < 0.0 ? -1.0 : 1.0;
		east.set( 1.0, 0.0, 0.0 );
		north.set( 0.0, sign, 0.0 );
		up.set( 0.0, 0.0, sign );
	} else {
		// 分支 3 · 一般情况(主路径)
		// up = 椭球面法向(单位向量),由 ellipsoid.ts 提供
		const upResult = geodeticSurfaceNormal( origin, up );
		if ( upResult === undefined ) {
			// 不可能发生:vec3MagnitudeSquared(origin) >= EPSILON14² 已校验过模长,
			// geodeticSurfaceNormal 只在模² < EPSILON14² 时返回 undefined。
			// 但保留兜底以满足 TS strictNullChecks。
			throw new Error(
				'eastNorthUpToFixedFrame: failed to compute surface normal for origin',
			);
		}

		// east = normalize(-origin.y, origin.x, 0)
		// 这个向量垂直于 z 轴与 origin 在赤道面的投影,指向地理东(右手系)。
		east.set( -origin.y, origin.x, 0.0 );
		east.normalize();

		// north = up × east(右手系叉积自动单位向量,因 up ⊥ east)
		north.crossVectors( up, east );
	}

	// 列主序写入 4×4 矩阵。Three Matrix4.set() 是行主序参数顺序
	// (16 个参数按数学习惯逐行写),内部存为列主序 elements[16]。
	out.set(
		east.x, north.x, up.x, origin.x,
		east.y, north.y, up.y, origin.y,
		east.z, north.z, up.z, origin.z,
		0.0,    0.0,     0.0,  1.0,
	);
	return out;
}
