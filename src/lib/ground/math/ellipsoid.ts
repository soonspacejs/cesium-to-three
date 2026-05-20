// ============================================================
// math/ellipsoid.ts — WGS84 椭球函数集
// 层级:L0(零依赖数学基础)
// 职责:cartographic ↔ ECEF 转换、geodetic surface normal、
//      Newton 投影到椭球表面、按高度缩放点数组。
//      所有函数是模块级 pure function,无类,所有椭球参数从 constants.ts 取。
// 依赖:Three.js Vector3、math/constants.ts、math/vec3-helpers.ts、math/cartographic.ts
// 被消费:math/enu-frame.ts、rectangle/*、math/wgs84-helpers.ts
// 算法对应:Cesium Source/Core/Ellipsoid.js + Source/Core/scaleToGeodeticSurface.js
//          + Source/Core/PolygonPipeline.js#scaleToGeodeticHeight
// ============================================================

import { Vector3 } from 'three';

import type { Cartographic } from './cartographic';
import {
	CENTER_TOLERANCE_SQUARED,
	EPSILON12,
	EPSILON14,
	NEWTON_MAX_ITERATIONS,
	WGS84_ONE_OVER_RADII_X,
	WGS84_ONE_OVER_RADII_X_SQ,
	WGS84_ONE_OVER_RADII_Y,
	WGS84_ONE_OVER_RADII_Y_SQ,
	WGS84_ONE_OVER_RADII_Z,
	WGS84_ONE_OVER_RADII_Z_SQ,
	WGS84_RADII_X_SQ,
	WGS84_RADII_Y_SQ,
	WGS84_RADII_Z_SQ,
} from './constants';
import { vec3MagnitudeSquared } from './vec3-helpers';

// ── 模块级 scratch(Cesium 风格闭包变量,JavaScript 单线程下安全)──
// 所有椭球函数共享这一组 scratch,避免每次调用都分配新对象。禁止在
// async 函数中跨 await 持有 scratch — 矩形路径全部同步,无此风险。

// cartographicToCartesian 使用:n = 单位法向,k = 椭球半轴²加权后的偏移
const _c2cartesianN = new Vector3();
const _c2cartesianK = new Vector3();

// scaleToGeodeticSurface 使用:Newton 迭代中间向量
const _s2gsIntersection = new Vector3();
const _s2gsGradient = new Vector3();

// cartesianToCartographic 使用:Newton 投影点 / 法向 / 高度偏移
const _c2cartoP = new Vector3();
const _c2cartoN = new Vector3();
const _c2cartoH = new Vector3();

// scaleToGeodeticHeight 使用:单点 scratch
const _s2ghN = new Vector3();
const _s2ghP = new Vector3();

/**
 * 由 Cartographic(λ, φ)算椭球表面 (λ, φ) 处的单位法向(指向外)。
 *
 * 算法:用参数化球向量 (cosφ·cosλ, cosφ·sinλ, sinφ) 作为初始方向,
 * 然后 normalize。在椭球(a ≠ c)上,这个球向量长度并非 1,但
 * **方向**恰好沿椭球面法向(因为椭球隐式方程的梯度与该球向量共线)。
 *
 * Cesium 对应:Ellipsoid.js:321-341
 *
 * @param carto 经度 / 纬度(弧度),height 字段被忽略。
 * @param out   输出单位向量(模 1)。
 * @returns     out。
 */
export function geodeticSurfaceNormalCartographic(
	carto: Cartographic,
	out: Vector3,
): Vector3 {
	const longitude = carto.longitude;
	const latitude = carto.latitude;
	const cosLatitude = Math.cos( latitude );

	const x = cosLatitude * Math.cos( longitude );
	const y = cosLatitude * Math.sin( longitude );
	const z = Math.sin( latitude );

	out.set( x, y, z );
	out.normalize();
	return out;
}

/**
 * 由 ECEF 点计算椭球表面在该点的单位法向。
 *
 * 椭球隐式方程 F(x,y,z) = (x/a)² + (y/b)² + (z/c)² − 1 = 0 的梯度
 * ∇F = (2x/a², 2y/b², 2z/c²) 方向即法向;归一化后即单位向量。
 * 系数 2 不影响方向,省略。
 *
 * Cesium 对应:Ellipsoid.js:350-371
 *
 * @param cart ECEF 点(米);若位于椭球中心附近(模² < EPSILON14²)返回 undefined。
 * @param out  输出单位向量。
 * @returns    out 或 undefined(中心退化)。
 */
export function geodeticSurfaceNormal(
	cart: Vector3,
	out: Vector3,
): Vector3 | undefined {
	// 退化判定:点在椭球中心附近无法定义法向。EPSILON14² = 1e-28。
	if ( vec3MagnitudeSquared( cart ) < EPSILON14 * EPSILON14 ) {
		return undefined;
	}

	// ∇F 方向 = (x/a², y/b², z/c²)。展开三行以避免在热路径上
	// 调用 vec3MultiplyComponents 的函数栈帧开销。
	out.x = cart.x * WGS84_ONE_OVER_RADII_X_SQ;
	out.y = cart.y * WGS84_ONE_OVER_RADII_Y_SQ;
	out.z = cart.z * WGS84_ONE_OVER_RADII_Z_SQ;

	out.normalize();
	return out;
}

/**
 * Newton 投影:把任意 ECEF 点投影到椭球表面(垂足投影)。
 *
 * 物理意义:求 cart 到椭球面的最近点(沿椭球法向回退)。
 * 数值方法:设 P' = (px/(1 + λ/a²), py/(1 + λ/b²), pz/(1 + λ/c²)),
 * 代入椭球方程得 func(λ) = 0,用 Newton-Raphson 迭代求 λ。每次迭代
 * 精度平方提升,通常 2-3 次即收敛到 |func| ≤ EPSILON12(1e-12)。
 *
 * Cesium 对应:scaleToGeodeticSurface.js:25-146
 *
 * @param cart ECEF 输入点。
 * @param out  输出椭球表面点(可与 cart 同实例)。
 * @returns    out 或 undefined(中心点 + 非有限 ratio 兜底)。
 */
export function scaleToGeodeticSurface(
	cart: Vector3,
	out: Vector3,
): Vector3 | undefined {
	// 步骤 1 · 计算椭球范数平方(把 cart 折算到单位椭球坐标的平方和)
	const px = cart.x;
	const py = cart.y;
	const pz = cart.z;

	const positionX2 = ( px * WGS84_ONE_OVER_RADII_X ) * ( px * WGS84_ONE_OVER_RADII_X );
	const positionY2 = ( py * WGS84_ONE_OVER_RADII_Y ) * ( py * WGS84_ONE_OVER_RADII_Y );
	const positionZ2 = ( pz * WGS84_ONE_OVER_RADII_Z ) * ( pz * WGS84_ONE_OVER_RADII_Z );
	const squaredNorm = positionX2 + positionY2 + positionZ2;
	const ratio = Math.sqrt( 1.0 / squaredNorm );

	// 步骤 2 · 初始径向投影
	const intersection = _s2gsIntersection;
	intersection.set( px * ratio, py * ratio, pz * ratio );

	// 步骤 3 · 退化判定:squaredNorm 极小 → cart 接近椭球中心,Newton 不收敛
	if ( squaredNorm < CENTER_TOLERANCE_SQUARED ) {
		if ( Number.isFinite( ratio ) ) {
			out.copy( intersection );
			return out;
		}
		// ratio 非有限(squaredNorm = 0 + 上面除法已是 Infinity 的 sqrt = Infinity)
		// → cart 是 (0, 0, 0),无法定义投影方向
		return undefined;
	}

	// 步骤 4 · 初始梯度 ∇F(intersection) = 2 · (intersection.x/a², ..., z/c²)
	const gradient = _s2gsGradient;
	gradient.x = intersection.x * WGS84_ONE_OVER_RADII_X_SQ * 2.0;
	gradient.y = intersection.y * WGS84_ONE_OVER_RADII_Y_SQ * 2.0;
	gradient.z = intersection.z * WGS84_ONE_OVER_RADII_Z_SQ * 2.0;

	// 步骤 5 · 初始 lambda(沿内法向方向从 cart 到椭球面的"法向单位"数)
	const cartMagnitude = Math.sqrt( px * px + py * py + pz * pz );
	const gradientMagnitude = Math.sqrt(
		gradient.x * gradient.x +
		gradient.y * gradient.y +
		gradient.z * gradient.z,
	);
	let lambda = ( ( 1.0 - ratio ) * cartMagnitude ) / ( 0.5 * gradientMagnitude );
	let correction = 0.0;

	// Newton 迭代变量(展开存放以匹配 Cesium 源码命名)
	let xMul = 0.0;
	let yMul = 0.0;
	let zMul = 0.0;
	let func = 0.0;
	let iteration = 0;

	// 步骤 6 · Newton 主循环(do-while:至少跑一次,直到 |func| ≤ EPSILON12)
	do {
		lambda -= correction;

		xMul = 1.0 / ( 1.0 + lambda * WGS84_ONE_OVER_RADII_X_SQ );
		yMul = 1.0 / ( 1.0 + lambda * WGS84_ONE_OVER_RADII_Y_SQ );
		zMul = 1.0 / ( 1.0 + lambda * WGS84_ONE_OVER_RADII_Z_SQ );

		const xMul2 = xMul * xMul;
		const yMul2 = yMul * yMul;
		const zMul2 = zMul * zMul;

		const xMul3 = xMul2 * xMul;
		const yMul3 = yMul2 * yMul;
		const zMul3 = zMul2 * zMul;

		// func(λ) = Σ (p_i² / a_i²) · (1/(1 + λ/a_i²))² − 1
		func = positionX2 * xMul2 + positionY2 * yMul2 + positionZ2 * zMul2 - 1.0;

		// denominator = Σ (p_i² / a_i²) · (1/(1 + λ/a_i²))³ / a_i²
		// derivative = −2 · denominator(因 d/dλ [(1 + λ/a²)^(−2)] = −2/a² · (1 + λ/a²)^(−3))
		const denominator =
			positionX2 * xMul3 * WGS84_ONE_OVER_RADII_X_SQ +
			positionY2 * yMul3 * WGS84_ONE_OVER_RADII_Y_SQ +
			positionZ2 * zMul3 * WGS84_ONE_OVER_RADII_Z_SQ;

		const derivative = -2.0 * denominator;
		correction = func / derivative;

		iteration += 1;
		if ( iteration > NEWTON_MAX_ITERATIONS ) {
			throw new Error(
				`scaleToGeodeticSurface did not converge within ${ NEWTON_MAX_ITERATIONS } iterations`,
			);
		}
	} while ( Math.abs( func ) > EPSILON12 );

	// 步骤 7 · 输出椭球表面点
	out.x = px * xMul;
	out.y = py * yMul;
	out.z = pz * zMul;
	return out;
}

/**
 * Cartographic (λ, φ, h) → ECEF (x, y, z),即 Cesium 著名的 gamma 投影法。
 *
 * 算法:n = 单位法向(球向量),k = (a²·n.x, b²·n.y, c²·n.z),
 * gamma = √(n · k),椭球表面点 P = k / gamma,加高度偏移 h · n 即得。
 *
 * Cesium 对应:Ellipsoid.js:385-399
 *
 * @param carto 输入 cartographic。
 * @param out   输出 ECEF 点。
 * @returns     out。
 */
export function cartographicToCartesian(
	carto: Cartographic,
	out: Vector3,
): Vector3 {
	const n = _c2cartesianN;
	const k = _c2cartesianK;

	// 单位法向(球向量 normalize 后)
	geodeticSurfaceNormalCartographic( carto, n );

	// k = (a², b², c²) ⊙ n
	k.x = WGS84_RADII_X_SQ * n.x;
	k.y = WGS84_RADII_Y_SQ * n.y;
	k.z = WGS84_RADII_Z_SQ * n.z;

	// gamma = √(n · k)
	const gamma = Math.sqrt( n.x * k.x + n.y * k.y + n.z * k.z );

	// k /= gamma → 此时 k 在椭球表面
	k.x /= gamma;
	k.y /= gamma;
	k.z /= gamma;

	// n *= height → 高度偏移向量
	const h = carto.height;
	n.x *= h;
	n.y *= h;
	n.z *= h;

	// out = k + n
	out.x = k.x + n.x;
	out.y = k.y + n.y;
	out.z = k.z + n.z;
	return out;
}

/**
 * ECEF → Cartographic(经纬度 + 高度)。
 *
 * 步骤:
 *   1. Newton 投影到椭球面 → 表面点 P
 *   2. 在 P 处计算单位法向 n(此时 n 指向 cart 方向)
 *   3. 高度偏移 h_vec = cart − P;|h_vec| · sign(h_vec · cart) 即高度
 *   4. 经度 = atan2(n.y, n.x);纬度 = asin(n.z)
 *
 * Cesium 对应:Ellipsoid.js:443-499
 *
 * @param cart 输入 ECEF 点。
 * @param out  输出 cartographic。
 * @returns    out 或 undefined(scaleToGeodeticSurface 返回 undefined 时)。
 */
export function cartesianToCartographic(
	cart: Vector3,
	out: Cartographic,
): Cartographic | undefined {
	const p = scaleToGeodeticSurface( cart, _c2cartoP );
	if ( p === undefined ) {
		return undefined;
	}

	const n = geodeticSurfaceNormal( p, _c2cartoN );
	if ( n === undefined ) {
		// 极罕见:Newton 投影出的表面点又在椭球中心 — 不可能发生,但保留兜底
		return undefined;
	}

	const h = _c2cartoH;
	h.x = cart.x - p.x;
	h.y = cart.y - p.y;
	h.z = cart.z - p.z;

	// 经度:n = (cosφ·cosλ, cosφ·sinλ, sinφ),前两项 atan2 即 λ
	out.longitude = Math.atan2( n.y, n.x );

	// 纬度:n.z = sinφ
	out.latitude = Math.asin( n.z );

	// 高度:|h| · sign(h · cart);cart 在外时 h 与 cart 同向(正),在内时反向(负)
	const hMagnitude = Math.sqrt( h.x * h.x + h.y * h.y + h.z * h.z );
	const hDotCart = h.x * cart.x + h.y * cart.y + h.z * cart.z;
	const sign = hDotCart >= 0.0 ? 1.0 : -1.0;
	out.height = sign * hMagnitude;

	return out;
}

/**
 * 把一个 Float64 ECEF 点数组(原地)按 height 提升或降低。
 *
 * 调用规则:
 *   - scaleToSurface = false:假设输入点已在椭球面,直接加 height · normal
 *   - scaleToSurface = true:先 Newton 投影到椭球面再加 height · normal
 *
 * 矩形 extruded 路径中:
 *   - top 层用 false(顶点来自 grid 采样,确实在表面)
 *   - bottom 层用 true(同 buffer 已被前一步污染过,Newton 兜底;实际是 no-op)
 *
 * Cesium 对应:PolygonPipeline.js:593-631
 *
 * @param positions     ECEF 点数组(长度必须是 3 的倍数,原地修改)。
 * @param height        高度偏移,米。
 * @param scaleToSurface 见上述调用规则。
 * @returns             原 positions(链式调用)。
 */
export function scaleToGeodeticHeight(
	positions: Float64Array,
	height: number,
	scaleToSurface: boolean,
): Float64Array {
	const length = positions.length;
	const p = _s2ghP;
	const n = _s2ghN;

	for ( let i = 0; i < length; i += 3 ) {
		p.set( positions[ i ], positions[ i + 1 ], positions[ i + 2 ] );

		if ( scaleToSurface ) {
			const projected = scaleToGeodeticSurface( p, p );
			if ( projected === undefined ) {
				// 中心退化:Cesium 不显式处理,我们写出来 — 保留原值并继续下一个点。
				positions[ i ] = p.x;
				positions[ i + 1 ] = p.y;
				positions[ i + 2 ] = p.z;
				continue;
			}
		}

		if ( height !== 0.0 ) {
			const normal = geodeticSurfaceNormal( p, n );
			if ( normal !== undefined ) {
				p.x += normal.x * height;
				p.y += normal.y * height;
				p.z += normal.z * height;
			}
		}

		positions[ i ] = p.x;
		positions[ i + 1 ] = p.y;
		positions[ i + 2 ] = p.z;
	}

	return positions;
}
