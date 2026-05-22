// ============================================================
// rectangle/rectangle-grid.ts — 矩形 ECEF 网格采样
// 层级:L2(基于 math/ 的矩形专属算法)
// 职责:把 RectangleRadians + granularity 转化为 (width × height) 网格参数,
//      并提供单点采样函数把 (row, col) 投到椭球面 ECEF。
//      采样算法使用 gamma 投影法(等价于 cartographicToCartesian 在 height=0
//      时的展平版本,展开 cos/sin/sqrt 以避免高频循环中的函数调用开销)。
// 依赖:math/cartographic.ts、math/constants.ts、rectangle-radians.ts、Three.js Vector3
// 被消费:rectangle-construct-cap.ts
// 算法对应:Cesium Source/Core/RectangleGeometryLibrary.js#computeOptions(L152-285)
//          + computePosition(L23-79)
// ============================================================

import type { Vector3 } from 'three';

import { createCartographic, type Cartographic } from '../math/cartographic';
import { cloneRectangleRadians, type RectangleRadians } from './rectangle-radians';

/**
 * 矩形网格的归一化参数(从 Cesium `RectangleGeometryLibrary.computeOptions` 输出对齐)。
 *
 * 字段命名带 `Cos / Sin` 后缀是为了对照 Cesium 源码 — Cesium 支持矩形整体
 * 旋转(rotation)时 `granX/Y` 会被分解为 `cos·step + sin·step`。本期**不支持
 * rotation**,故 `granXSin = granYSin = 0`,但保留字段以便未来扩展且与 Cesium
 * 源码可一行行 diff 比对。
 */
export interface NormalizedRectangleGridOptions {
	/** 经度方向顶点数(包含端点),即网格列数 */
	width: number;

	/** 纬度方向顶点数(包含端点),即网格行数 */
	height: number;

	/** 列方向步长 · cos(rotation);非 rotation 路径 = 经度步长(弧度) */
	granXCos: number;

	/** 行方向步长 · cos(rotation);非 rotation 路径 = 纬度步长(弧度) */
	granYCos: number;

	/** 列方向步长 · sin(rotation);非 rotation 路径恒为 0 */
	granXSin: number;

	/** 行方向步长 · sin(rotation);非 rotation 路径恒为 0 */
	granYSin: number;

	/** 网格起点:矩形 NW 角点(latitude=north, longitude=west, height=0) */
	nwCorner: Cartographic;

	/** 原矩形(克隆),供下游 cap 退化、debug 用 */
	boundingRectangle: RectangleRadians;

	/** north === π/2 时为 true(矩形覆盖北极) */
	northCap: boolean;

	/** south === -π/2 时为 true(矩形覆盖南极) */
	southCap: boolean;
}

/**
 * 计算矩形网格的归一化参数。
 *
 * 流程:
 *   1. 校验输入(granularity > 0,north > south,west < east)
 *   2. 极点判定(north === π/2 → northCap,south === -π/2 → southCap)
 *   3. 网格分辨率 width = ceil(dx/granularity) + 1,同理 height
 *   4. 步长 granularityX = dx / (width-1),同理 Y
 *   5. NW 角点 cartographic
 *
 * Cesium 对应:RectangleGeometryLibrary.js:152-285
 *
 * @param rect        矩形(弧度,west < east, south < north)。
 * @param granularity 网格精度(弧度,> 0)。
 * @returns           归一化网格参数。
 * @throws            granularity ≤ 0 / north ≤ south / 跨 IDL / 矩形过小(width<2 或 height<2)。
 */
export function computeRectangleGridOptions(
	rect: RectangleRadians,
	granularity: number,
): NormalizedRectangleGridOptions {
	// 步骤 1 · 输入校验
	if ( ! Number.isFinite( granularity ) || granularity <= 0.0 ) {
		throw new Error( `granularity must be positive, got ${ granularity }` );
	}
	if ( rect.north <= rect.south ) {
		throw new Error( 'rect.north must be greater than rect.south' );
	}
	if ( rect.west >= rect.east ) {
		// 本期不支持跨 IDL 矩形(west >= east 通常表示跨 ±180° 经线)。
		// Cesium 在此处会做 `dx = 2π − west + east` 路径,我们留待 polygon
		// 抽离期再补,与本期"仅矩形 Cesium 抽离"范围一致。
		throw new Error(
			'Cross-IDL rectangles (west >= east) are not supported in this version',
		);
	}

	// 步骤 2 · 极点判定(严格 ===,与 Cesium 一致)
	const northCap = rect.north === Math.PI / 2.0;
	const southCap = rect.south === -Math.PI / 2.0;

	// 步骤 3 · 计算 dx, dy(非跨 IDL 直接相减)
	const dx = rect.east - rect.west;
	const dy = rect.north - rect.south;

	// 步骤 4 · 网格分辨率
	const width = Math.ceil( dx / granularity ) + 1;
	const height = Math.ceil( dy / granularity ) + 1;

	if ( width < 2 || height < 2 ) {
		throw new Error(
			`rectangle too small for granularity, width=${ width }, height=${ height }`,
		);
	}

	// 步骤 5 · 步长
	const granularityX = dx / ( width - 1 );
	const granularityY = dy / ( height - 1 );

	// 步骤 6 · NW 角点(网格起点)
	const nwCorner = createCartographic( rect.west, rect.north, 0.0 );

	// 步骤 7 · 填充结构
	return {
		width,
		height,
		granXCos: granularityX,
		granYCos: granularityY,
		granXSin: 0.0,
		granYSin: 0.0,
		nwCorner,
		boundingRectangle: cloneRectangleRadians( rect ),
		northCap,
		southCap,
	};
}

/**
 * 对网格上 (row, col) 处采样一个椭球表面 ECEF 点。
 *
 * 算法(gamma 投影,等价 cartographicToCartesian 在 height=0 时的展平版本):
 *   1. 采样点经纬度 = NW 角点经纬度 ± row · granY ± col · granX
 *      (保留完整公式,即便 granXSin/YSin = 0,以便与 Cesium 源码逐行对照)
 *   2. 计算球向量 n = (cosφ·cosλ, cosφ·sinλ, sinφ)
 *   3. k = radiiSquared ⊙ n,即 (a²·n.x, b²·n.y, c²·n.z)
 *   4. gamma = √(n · k),椭球面点 = k / gamma
 *
 * Cesium 对应:RectangleGeometryLibrary.js:23-79
 *
 * 性能:本函数在 (width × height) 双循环中调用,珠峰 demo 9 次,1° × 1° demo
 * 1089 次。展开 cos/sin/sqrt 而非调 cartographicToCartesian 是为了缓存友好
 * 与避免函数栈帧。
 *
 * @param opts          归一化网格参数(来自 computeRectangleGridOptions)。
 * @param row           行索引(0 ≤ row < height)。
 * @param col           列索引(0 ≤ col < width)。
 * @param radiiSquared  椭球半轴平方(a², b², c²),通常由 caller 传 WGS84 常量。
 * @param out           输出 ECEF 点(原地写入)。
 * @returns             out(链式调用)。
 */
export function computeRectangleGridSurfacePosition(
	opts: NormalizedRectangleGridOptions,
	row: number,
	col: number,
	radiiSquared: Vector3,
	out: Vector3,
): Vector3 {
	// 步骤 1 · 采样点经纬度(完整公式保留 granXSin/granYSin,虽然恒为 0)
	const stLatitude =
		opts.nwCorner.latitude -
		opts.granYCos * row +
		col * opts.granXSin;

	const stLongitude =
		opts.nwCorner.longitude +
		row * opts.granYSin +
		col * opts.granXCos;

	// 步骤 2 · 球向量(对应椭球面法向方向,未归一化但方向正确)
	const cosLatitude = Math.cos( stLatitude );
	const nZ = Math.sin( stLatitude );
	const nX = cosLatitude * Math.cos( stLongitude );
	const nY = cosLatitude * Math.sin( stLongitude );

	// 步骤 3 · k = radiiSquared ⊙ n
	const kX = radiiSquared.x * nX;
	const kY = radiiSquared.y * nY;
	const kZ = radiiSquared.z * nZ;

	// 步骤 4 · gamma 因子(等价 √(n · k))与椭球面点
	const gamma = Math.sqrt( kX * nX + kY * nY + kZ * nZ );

	out.x = kX / gamma;
	out.y = kY / gamma;
	out.z = kZ / gamma;
	return out;
}
