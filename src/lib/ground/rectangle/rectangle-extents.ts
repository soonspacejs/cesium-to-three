// ============================================================
// rectangle/rectangle-extents.ts — 矩形 ShadowVolumeAppearance Uniform 计算
// 层级:L4(顶层,基于 math + rectangle-helpers 的组合)
// 职责:把 RectangleRadians(render 用)与 fillRectangle(实心区域)转化为
//      ShadowVolumeAppearanceVS/FS 期望的一组 uniform:
//        u_southWest_HIGH / u_southWest_LOW (vec3,SW 角点 RTE-encoded ECEF)
//        u_eastward (vec3,从 SW 朝东 1 米的 ECEF 位移)
//        u_northward (vec3,从 SW 朝北 1 米的 ECEF 位移)
//        u_uvMinAndExtents (vec4,矩形固定 (0,0,1,1))
//        u_uMaxVmax (vec4,矩形固定 (0,1,1,0))
//        u_innerMetersRect (vec4,fill 区相对 render 区在 ENU 米空间的范围)
//      Border 区域在 fragment shader 中根据 innerMetersRect 裁剪 fill,
//      使得 fill 区显示填充色、border 区显示描边色。
// 依赖:Three.js Vector3 + Vector4 + Matrix4、math/cartographic.ts、
//      math/ellipsoid.ts、math/enu-frame.ts、math/rte-encoding.ts、
//      math/matrix4-helpers.ts、rectangle-radians.ts、types.ts
// 被消费:primitives.ts(CesiumGroundRectanglePrimitive 类,传给 classification 的 SharedUniforms)
// 算法对应:Cesium 内部 ShadowVolumeAppearance.computeRectangleBounds + 现有
//          geometry.ts:649-719 的 computePlanarExtents(矩形分支)
// ============================================================

import { Matrix4, Vector3, Vector4 } from 'three';

import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import { encodeVec3RTE } from '../math/rte-encoding';
import type { PlanarBounds, PlanarExtents } from '../types';
import { rectangleCenter, type RectangleRadians } from './rectangle-radians';

// ── 模块级 scratch ──
// 每次调用复用,避免在 demo 启动期重复分配。每个 PlanarExtents 输出含
// 4 个 Vector3 + 3 个 Vector4 = 7 个新对象(被下游 classification.ts 长期持有),
// 中间变量则复用 scratch。**禁止把 scratch 返回给 caller** — 下次调用会覆盖。
const _peCenterCarto = createCartographic();
const _peCenterEcef = new Vector3();
const _peEnuToEcef = new Matrix4();
const _peEcefToEnu = new Matrix4();
const _peCornerCarto = createCartographic();
const _peCornerEcef = new Vector3();

/**
 * 把矩形 ECEF 8 角点投到 ENU 平面,取 min/max 包围盒。
 *
 * 私有函数,被 `computeRectanglePlanarExtents` 用两次(分别处理 render
 * 矩形与 fill 矩形)。
 *
 * 算法:8 个 cartographic 采样点(4 角 + 4 边中点),逐个变换:
 *   carto → ECEF → ecefToEnu → (x, y)。投到 z=0 平面取 min/max。
 *
 * 8 点而非 4 点:椭球曲率使得矩形边中点的 ENU 投影可能略偏出 4 角的
 * 包围盒。8 点采样保证充分覆盖(对珠峰尺度 ≤ 1 米误差,但对大矩形 / 高纬度
 * 显著)。Cesium 同样 8 点。
 *
 * @param rect      矩形(弧度)。
 * @param height    采样 cartographic 的 height(米,通常 maxHeight)。
 * @param ecefToEnu ECEF → ENU 的 4×4 矩阵。
 * @param out       输出包围盒(原地写入)。
 * @returns         out。
 */
function computeRectanglePlanarBounds(
	rect: RectangleRadians,
	height: number,
	ecefToEnu: Matrix4,
	out: PlanarBounds,
): PlanarBounds {
	const longitudeCenter = ( rect.west + rect.east ) * 0.5;
	const latitudeCenter = ( rect.south + rect.north ) * 0.5;

	const samples: [ number, number ][] = [
		[ rect.west, rect.south ],
		[ rect.west, rect.north ],
		[ rect.east, rect.north ],
		[ rect.east, rect.south ],
		[ longitudeCenter, rect.south ],
		[ longitudeCenter, rect.north ],
		[ rect.west, latitudeCenter ],
		[ rect.east, latitudeCenter ],
	];

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for ( const [ longitude, latitude ] of samples ) {
		_peCornerCarto.longitude = longitude;
		_peCornerCarto.latitude = latitude;
		_peCornerCarto.height = height;
		cartographicToCartesian( _peCornerCarto, _peCornerEcef );
		matrix4MultiplyByPoint( ecefToEnu, _peCornerEcef, _peCornerEcef );
		// 投到 z=0 平面(因 ecefToEnu 已把 origin 平移到原点)
		if ( _peCornerEcef.x < minX ) { minX = _peCornerEcef.x; }
		if ( _peCornerEcef.x > maxX ) { maxX = _peCornerEcef.x; }
		if ( _peCornerEcef.y < minY ) { minY = _peCornerEcef.y; }
		if ( _peCornerEcef.y > maxY ) { maxY = _peCornerEcef.y; }
	}

	out.minX = minX;
	out.maxX = maxX;
	out.minY = minY;
	out.maxY = maxY;
	return out;
}

/**
 * 把 value 钳制到 [min, max]。
 *
 * @param value 输入。
 * @param min   下界。
 * @param max   上界。
 * @returns     钳制后的值。
 */
function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * 计算矩形 ShadowVolume PlanarExtents uniform。
 *
 * 完整 7 步算法:
 *   1. render 矩形中心 cartographic(height = maxHeight)→ ECEF
 *   2. 在 center 处构造 ENU → ECEF 矩阵
 *   3. invert 得到 ECEF → ENU 矩阵
 *   4. render 矩形 8 角点采样到 ENU 平面,取包围盒
 *   5. fill 矩形同样采样
 *   6. SW 角点 ENU → ECEF;再计算 eastward / northward(从 SW 出发的单位 ENU 向量
 *      在 ECEF 中的对应)
 *   7. innerMetersRect = clamp(fillBounds 相对 renderBounds 的 SW 偏移),
 *      并 RTE 编码 SW
 *
 * 输出对应 GLSL uniform:
 *   - u_southWest_HIGH/LOW:SW ECEF 的 RTE 高 / 低分量
 *   - u_eastward:SW 朝东 1 米的 ECEF 位移(模约 1)
 *   - u_northward:SW 朝北 1 米的 ECEF 位移(模约 1)
 *   - u_uvMinAndExtents:矩形固定 (0, 0, 1, 1)
 *   - u_uMaxVmax:矩形固定 (0, 1, 1, 0)
 *   - u_innerMetersRect:fill 区在 render 区中的米偏移(xMin, yMin, xMax, yMax)
 *
 * 当前位置:迁移自 geometry.ts:649-719 的 computePlanarExtents 矩形分支。
 * 逻辑零改动,只是把 Cesium 数学依赖切换到 math/*。
 *
 * @param renderRect    渲染矩形(已外扩 border 的几何用矩形)。
 * @param fillRect      实心矩形(border fragment 用)。
 * @param maximumHeight render 矩形顶面高度,作为 8 点采样的 cartographic.height。
 * @returns             PlanarExtents 完整 uniform 集。
 */
export function computeRectanglePlanarExtents(
	renderRect: RectangleRadians,
	fillRect: RectangleRadians,
	maximumHeight: number,
): PlanarExtents {
	// ── 步骤 1 · render 矩形中心 → cartographic → ECEF ──
	rectangleCenter( renderRect, _peCenterCarto );
	_peCenterCarto.height = maximumHeight;
	cartographicToCartesian( _peCenterCarto, _peCenterEcef );

	// ── 步骤 2 · ENU → ECEF 矩阵 ──
	eastNorthUpToFixedFrame( _peCenterEcef, _peEnuToEcef );

	// ── 步骤 3 · ECEF → ENU 矩阵(求逆)──
	_peEcefToEnu.copy( _peEnuToEcef ).invert();

	// ── 步骤 4 · render 矩形 ENU 包围盒 ──
	const renderBounds: PlanarBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	computeRectanglePlanarBounds( renderRect, maximumHeight, _peEcefToEnu, renderBounds );

	// ── 步骤 5 · fill 矩形 ENU 包围盒 ──
	const fillBounds: PlanarBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	computeRectanglePlanarBounds( fillRect, maximumHeight, _peEcefToEnu, fillBounds );

	const eastExtentMeters = Math.max( renderBounds.maxX - renderBounds.minX, 1.0 );
	const northExtentMeters = Math.max( renderBounds.maxY - renderBounds.minY, 1.0 );

	// ── 步骤 6 · SW 角点 ENU → ECEF,再计算 eastward / northward ──
	// 6.1 · SW 角点
	const swEnu = new Vector3( renderBounds.minX, renderBounds.minY, 0.0 );
	const swEcef = new Vector3();
	matrix4MultiplyByPoint( _peEnuToEcef, swEnu, swEcef );

	// 6.2 · SE 角点(SW.x + extent, SW.y)→ ECEF
	const seEnu = new Vector3( renderBounds.maxX, renderBounds.minY, 0.0 );
	const seEcef = new Vector3();
	matrix4MultiplyByPoint( _peEnuToEcef, seEnu, seEcef );

	// 6.3 · NW 角点(SW.x, SW.y + extent)→ ECEF
	const nwEnu = new Vector3( renderBounds.minX, renderBounds.maxY, 0.0 );
	const nwEcef = new Vector3();
	matrix4MultiplyByPoint( _peEnuToEcef, nwEnu, nwEcef );

	// 6.4 · eastward / northward = (SE - SW) / (NW - SW)
	// 注意:这里**不归一化为单位向量**,而是保留 (extent_meters) 模长。
	// GLSL 中会用 `dot(fragPos - sw, eastward) / dot(eastward, eastward)` 算 u 坐标,
	// 自动除以模长² → 等价于映射到 [0, 1]。
	const eastward = new Vector3( seEcef.x - swEcef.x, seEcef.y - swEcef.y, seEcef.z - swEcef.z );
	const northward = new Vector3( nwEcef.x - swEcef.x, nwEcef.y - swEcef.y, nwEcef.z - swEcef.z );

	// ── 步骤 7 · innerMetersRect 与 RTE 编码 SW ──
	// 7.1 · fill 边界相对 render SW 的米偏移,clamp 到 render 内(避免越界)
	const innerMinX = clampNumber( fillBounds.minX - renderBounds.minX, 0.0, eastExtentMeters );
	const innerMinY = clampNumber( fillBounds.minY - renderBounds.minY, 0.0, northExtentMeters );
	const innerMaxX = clampNumber( fillBounds.maxX - renderBounds.minX, 0.0, eastExtentMeters );
	const innerMaxY = clampNumber( fillBounds.maxY - renderBounds.minY, 0.0, northExtentMeters );

	// 7.2 · RTE 编码 SW ECEF
	const southWestHigh = new Vector3();
	const southWestLow = new Vector3();
	encodeVec3RTE( swEcef, southWestHigh, southWestLow );

	// 7.3 · 矩形路径固定 uv(polygon 路径会有不同值)
	const uvMinAndExtents = new Vector4( 0.0, 0.0, 1.0, 1.0 );
	const uMaxVmax = new Vector4( 0.0, 1.0, 1.0, 0.0 );
	const innerMetersRect = new Vector4( innerMinX, innerMinY, innerMaxX, innerMaxY );

	return {
		southWestHigh,
		southWestLow,
		eastward,
		northward,
		uvMinAndExtents,
		uMaxVmax,
		innerMetersRect,
	};
}
