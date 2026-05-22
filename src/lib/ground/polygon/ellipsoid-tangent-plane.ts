// ============================================================
// polygon/ellipsoid-tangent-plane.ts — 椭球切平面与"径向"投影
// 层级:L1(基于 math/ellipsoid + math/enu-frame 的几何工具)
// 职责:在给定 ECEF 点集的"AABB 中心"附近,把中心投到椭球面建立局部
//      切平面(给 earcut 2D 三角剖分用)。
//      提供两个能力:
//        1. tangentPlaneFromPoints — 构造切平面(origin / normal / xAxis / yAxis / distance)
//        2. projectPointsOntoPlane — 把 ECEF 点序列投影到切平面 2D
//                                    (沿"从地心向点的方向" ray-plane 求交,
//                                     与 Cesium 字节级一致)
// 依赖:Three.js Vector3 / Vector2 / Matrix4,math/ellipsoid.ts,
//      math/enu-frame.ts,math/vec3-helpers.ts
// 被消费:polygon-rings.ts、polygon-construct-extruded.ts
// 算法对应:Cesium Source/Core/EllipsoidTangentPlane.js
//          + Source/Core/IntersectionTests.js#rayPlane
//          + Source/Core/AxisAlignedBoundingBox.js#fromPoints(取 (min + max) / 2 作中心)
//          + Source/Core/Plane.js#fromPointNormal(plane.distance = -dot(origin, normal))
// ============================================================

import { Matrix4, Vector2, Vector3 } from 'three';

import { scaleToGeodeticSurface } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';

// Cesium `Math.EPSILON15 = 1e-15`,用于 rayPlane 平行性判定
// (|dot(normal, direction)| < EPSILON15 视为 ray 与 plane 平行)。
// 此处局部定义,避免动到 math/constants.ts(V7 要求 math/ 不动)。
const EPSILON15 = 1e-15;

/**
 * 椭球切平面数据结构。
 *
 * 数学不变量:
 *   - `origin` 在椭球面上(由 scaleToGeodeticSurface 保证)
 *   - `normal` 是 origin 处的椭球面外法向(单位向量)
 *   - `xAxis` / `yAxis` 在切平面内,正交,单位向量,且 `xAxis × yAxis = normal`(右手系)
 *   - `xAxis` 对齐 ENU 的 east 基底,`yAxis` 对齐 ENU 的 north 基底
 *   - `distance` 是 Cesium Plane 公式中的常数项:`distance = -dot(origin, normal)`
 *     ⇒ 平面方程为 `dot(P, normal) + distance = 0`
 */
export interface EllipsoidTangentPlane {
	/** 切点(椭球面上的 ECEF 位置,米) */
	origin: Vector3;

	/** 切平面外法向(单位向量,沿椭球面在 origin 处的法线) */
	normal: Vector3;

	/** 切平面 "east" 基底(单位向量,正交于 normal) */
	xAxis: Vector3;

	/** 切平面 "north" 基底(单位向量,正交于 normal 与 xAxis,组成右手系) */
	yAxis: Vector3;

	/** Cesium Plane 公式常数项:plane(P) = dot(P, normal) + distance = 0 */
	distance: number;
}

// ── 模块级 scratch:tangentPlaneFromPoints 内部反复使用 ──
// JS 单线程下安全。请不要在 async 跨 await 持有这些引用。
const _centerScratch = new Vector3();
const _originScratch = new Vector3();
const _enuMatrixScratch = new Matrix4();

// ── 模块级 scratch:projectPointsOntoPlane 内部反复使用 ──
const _rayDirScratch = new Vector3();
const _intersectionScratch = new Vector3();

/**
 * 由一组 ECEF 点构造切平面,中心取 AABB(轴对齐包围盒)中心。
 *
 * 复刻 Cesium `EllipsoidTangentPlane.fromPoints` 调用 `AxisAlignedBoundingBox.fromPoints`
 * 取 `box.center = (box.minimum + box.maximum) / 2` 这一精确路径。**不要**用算术平均
 * (`Σ p_i / N`),否则会与 Cesium 字节级输出有微差(R2)。
 *
 * 算法 6 步:
 *   1. AABB 扫描:遍历 points 求 (minX, minY, minZ) 与 (maxX, maxY, maxZ)
 *   2. center = ((min + max) / 2)
 *   3. origin = scaleToGeodeticSurface(center)  ◄── math/ellipsoid.ts
 *   4. 在 origin 上构造 ENU → ECEF 矩阵   ◄── math/enu-frame.ts
 *   5. 从矩阵列 0/1/2 取 xAxis (east) / yAxis (north) / normal (up)
 *   6. distance = -dot(origin, normal)
 *
 * 数值示例(珠峰 5 顶点 polygon):
 *   AABB.min ≈ (+299870, +5627990, +2971890)
 *   AABB.max ≈ (+304850, +5628570, +2977340)
 *   center  ≈ (+302360, +5628280, +2974615)
 *   origin  = scaleToGeodeticSurface(center) ≈ 几乎不变(已在椭球面附近)
 *   normal  ≈ (+0.0473, +0.8830, +0.4670)    ≈ (cos27.99°cos86.92°, cos27.99°sin86.92°, sin27.99°)
 *   xAxis   ≈ (+0.9988, -0.0537, +0.0000)    ≈ ENU east
 *   yAxis   ≈ (-0.0251, -0.4664, +0.8842)    ≈ ENU north
 *
 * @param points 输入 ECEF 点数组(非空,典型为 polygon outer ring)。
 * @returns      构造好的切平面(原 Vector3 实例,可安全持有)。
 * @throws       points 为空 / origin 在椭球中心退化时。
 */
export function tangentPlaneFromPoints( points: readonly Vector3[] ): EllipsoidTangentPlane {
	if ( points.length === 0 ) {
		throw new Error(
			'tangentPlaneFromPoints: input points array must contain at least one point.',
		);
	}

	// 步骤 1 · AABB 扫描
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;

	for ( let i = 0; i < points.length; i++ ) {
		const p = points[ i ];
		if ( p.x < minX ) { minX = p.x; }
		if ( p.x > maxX ) { maxX = p.x; }
		if ( p.y < minY ) { minY = p.y; }
		if ( p.y > maxY ) { maxY = p.y; }
		if ( p.z < minZ ) { minZ = p.z; }
		if ( p.z > maxZ ) { maxZ = p.z; }
	}

	// 步骤 2 · AABB 中心
	_centerScratch.set(
		( minX + maxX ) * 0.5,
		( minY + maxY ) * 0.5,
		( minZ + maxZ ) * 0.5,
	);

	// 步骤 3 · 投影到椭球面
	const origin = new Vector3();
	const projected = scaleToGeodeticSurface( _centerScratch, origin );
	if ( projected === undefined ) {
		throw new Error(
			'tangentPlaneFromPoints: AABB center is at or near the ellipsoid center (degenerate).',
		);
	}

	// 步骤 4 · ENU 矩阵(列 0 = east、列 1 = north、列 2 = up,列主序)
	// _originScratch 是给 enu-frame 用的;但 origin 已是独立 Vector3,
	// 直接传 origin 也无问题(enu-frame 只读不持有)。
	_originScratch.copy( origin );
	eastNorthUpToFixedFrame( _originScratch, _enuMatrixScratch );

	// 步骤 5 · 从矩阵抽取列向量
	// Three.js Matrix4.elements 是列主序 Float64?其实 elements 默认是 number[16],
	// 列 j 的 (x, y, z) 在 elements[j*4..j*4+2]。matrix.set() 内部把行参数转列存储。
	const e = _enuMatrixScratch.elements;
	const xAxis = new Vector3( e[ 0 ], e[ 1 ], e[ 2 ] );   // 列 0:east
	const yAxis = new Vector3( e[ 4 ], e[ 5 ], e[ 6 ] );   // 列 1:north
	const normal = new Vector3( e[ 8 ], e[ 9 ], e[ 10 ] ); // 列 2:up(= 椭球面外法向)

	// 步骤 6 · Cesium Plane 常数项:distance = -dot(origin, normal)
	// 平面方程 dot(P, normal) + distance = 0 在 P = origin 时恒等。
	const distance = -( origin.x * normal.x + origin.y * normal.y + origin.z * normal.z );

	return {
		origin,
		normal,
		xAxis,
		yAxis,
		distance,
	};
}

/**
 * Ray-plane 求交:ray 从 P 出发,方向 = `normalize(P)`(从地心向 P 的径向);
 * 若 t < 0(交点在 ray 反向)或 ray 平行平面,Cesium 会调用方再用反向 ray 重试一次。
 *
 * 复刻 Cesium IntersectionTests.rayPlane(L27-58)字节级:
 *   denominator = dot(normal, direction)
 *   if |denominator| < EPSILON15:  return undefined   // 平行
 *   t = -(distance + dot(normal, origin)) / denominator
 *   if t < 0:                       return undefined  // 交点在反向
 *   intersection = origin + t · direction
 *
 * @param rayOrigin    Ray 起点(被投影点 P)。
 * @param rayDirection Ray 方向(单位向量)。
 * @param normal       平面法向(单位向量)。
 * @param distance     Cesium 平面常数项。
 * @param out          输出交点(原地写入)。
 * @returns            out(成功)或 undefined(平行 / t < 0)。
 */
function rayPlaneIntersection(
	rayOrigin: Vector3,
	rayDirection: Vector3,
	normal: Vector3,
	distance: number,
	out: Vector3,
): Vector3 | undefined {
	const denominator =
		normal.x * rayDirection.x +
		normal.y * rayDirection.y +
		normal.z * rayDirection.z;

	if ( Math.abs( denominator ) < EPSILON15 ) {
		return undefined;
	}

	const t = ( -distance -
		( normal.x * rayOrigin.x + normal.y * rayOrigin.y + normal.z * rayOrigin.z )
	) / denominator;

	if ( t < 0.0 ) {
		return undefined;
	}

	out.x = rayOrigin.x + t * rayDirection.x;
	out.y = rayOrigin.y + t * rayDirection.y;
	out.z = rayOrigin.z + t * rayDirection.z;
	return out;
}

/**
 * 把一组 ECEF 点投影到切平面 2D 坐标系。
 *
 * 复刻 Cesium EllipsoidTangentPlane.projectPointsOntoPlane(L215-238) +
 * projectPointOntoPlane(L160-203):**逐点构造一条从 P 出发、方向 = normalize(P)
 * 的 ray,与切平面求交**,然后把交点减去 origin 后投影到 (xAxis, yAxis) 得 2D 坐标。
 *
 * **关键不变量**:对 polygon-rings.ts 已 scaleToGeodeticSurface 过的输入,所有 P
 * 都在椭球面上、且离 tangentPlane.origin ≤ 数 km 量级,ray 永远会成功命中切平面。
 * Cesium 把"投影失败的点"从输出数组中剔除(`projectPointsOntoPlane` 内部 `count++`
 * 跳过 undefined);本实现也保留同样语义(返回的数组长度可能小于输入)。
 *
 * @param tangentPlane 切平面(由 tangentPlaneFromPoints 产出)。
 * @param points       输入 ECEF 点序列。
 * @returns            2D 切平面坐标数组(长度 ≤ points.length,失败点被剔除)。
 */
export function projectPointsOntoPlane(
	tangentPlane: EllipsoidTangentPlane,
	points: readonly Vector3[],
): Vector2[] {
	const result: Vector2[] = [];

	for ( let i = 0; i < points.length; i++ ) {
		const p = points[ i ];

		// ray.direction = normalize(P)。Cesium 用 `Cartesian3.normalize(cartesian, ray.direction)`。
		_rayDirScratch.copy( p ).normalize();

		// 第一次尝试:从 P 出发沿径向外
		let intersection = rayPlaneIntersection(
			p,
			_rayDirScratch,
			tangentPlane.normal,
			tangentPlane.distance,
			_intersectionScratch,
		);

		// 第二次尝试:反向 ray(Cesium L178:`Cartesian3.negate(ray.direction, ray.direction)`)
		// 用于 P 位于切平面上方(t < 0)、需要朝地心方向才能击中切平面的情况。
		if ( intersection === undefined ) {
			_rayDirScratch.negate();
			intersection = rayPlaneIntersection(
				p,
				_rayDirScratch,
				tangentPlane.normal,
				tangentPlane.distance,
				_intersectionScratch,
			);
		}

		// 两次都失败 → 跳过此点(与 Cesium projectPointsOntoPlane 行为一致)
		if ( intersection === undefined ) {
			continue;
		}

		// v = intersection - origin
		const vx = intersection.x - tangentPlane.origin.x;
		const vy = intersection.y - tangentPlane.origin.y;
		const vz = intersection.z - tangentPlane.origin.z;

		// 2D 坐标 = (dot(v, xAxis), dot(v, yAxis))
		const x =
			vx * tangentPlane.xAxis.x +
			vy * tangentPlane.xAxis.y +
			vz * tangentPlane.xAxis.z;
		const y =
			vx * tangentPlane.yAxis.x +
			vy * tangentPlane.yAxis.y +
			vz * tangentPlane.yAxis.z;

		result.push( new Vector2( x, y ) );
	}

	return result;
}
