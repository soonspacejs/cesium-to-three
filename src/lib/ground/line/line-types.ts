// ============================================================
// line/line-types.ts — 贴地线内部几何数据类型
// 层级：L4（贴地线几何子模块内部契约，不公开）
// 职责：在 preprocess → densify → normals → segment-attributes 各阶段
//        间传递的中间结构。每个字段都按 doc 02-04 精确语义命名。
// 依赖：仅 Three.js / 本目录其它类型。
// 被消费：line/* 内部、primitives.ts 的 CesiumGroundPolylinePrimitive。
// 算法对应：Cesium GroundPolylineGeometry.createGeometry 中间产物。
// ============================================================

import type { LonLatPoint } from '../types';

/** 折线连线方式。对外字符串经 `resolvePublicLineOptions` 映射到枚举。 */
export const ArcType = {
	/** 直连（ECEF 弦），仅当极短或调用方显式要求时用。 */
	NONE: 0,
	/** 大地线（最短路径，Vincenty）。默认。 */
	GEODESIC: 1,
	/** 恒向线（罗盘恒定方位角）。 */
	RHUMB: 2,
} as const;
/* eslint-disable-next-line @typescript-eslint/no-redeclare */
export type ArcType = typeof ArcType[ keyof typeof ArcType ];

/** 线宽语义：屏宽（像素恒定）或世界宽（米恒定）。 */
export const LineWidthMode = {
	SCREEN: 0,
	WORLD: 1,
} as const;
/* eslint-disable-next-line @typescript-eslint/no-redeclare */
export type LineWidthMode = typeof LineWidthMode[ keyof typeof LineWidthMode ];

/**
 * `buildLineShadowVolumeGeometry` 入参（内部）。`resolvePublicLineOptions`
 * 把公开 `CesiumGroundPolylineOptions` 转成这个形态后传给 facade。
 */
export interface LineShadowVolumeOptions {
	/** lon/lat 折点（度），≥ 2 个。 */
	points: LonLatPoint[];
	/** 是否闭合成环。 */
	loop: boolean;
	/** 加密 arc 类型。 */
	arcType: ArcType;
	/** 加密角分辨率（弧度）。 */
	granularity: number;
	/** 高度窗口下限（米）。 */
	minimumHeight: number;
	/** 高度窗口上限（米）。 */
	maximumHeight: number;
}

/**
 * 加密 + 法线后的密集折线数据。每个数组都是「扁平 Float64 / number[]」，
 * 长度对齐为 `pointCount * 3`（normals / bottom / top）或 `pointCount * 2`
 * （cartographics，顺序是 [lat, lon, ...]）。
 *
 * 注意：`cartographicsArray` 的「lat 在前 lon 在后」顺序逐字对齐 Cesium，
 * 不能反——doc 04 计算段外接矩形时按这个顺序读取。
 */
export interface DensifiedLine {
	/** 每点的几何法线 [nx, ny, nz, ...]。 */
	normalsArray: number[];
	/** 每点在 minHeight 处的 ECEF 位置 [x, y, z, ...]。 */
	bottomPositionsArray: number[];
	/** 每点在 maxHeight 处的 ECEF 位置 [x, y, z, ...]。 */
	topPositionsArray: number[];
	/** 每点 cartographic，顺序 [lat, lon, ...]（弧度）。 */
	cartographicsArray: number[];
	/** 是否闭合（与入参 loop 相同；2 点强制 false 在更上层处理）。 */
	loop: boolean;
	/** 加密后的点数 = bottomPositionsArray.length / 3。 */
	pointCount: number;
}

/**
 * 每段 8 顶点 box 装配产出。`positions` 是 box 8 角的 Float64 ECEF，
 * 五个 Float32 vec4 描述符与 batchId / 索引按 doc 04 §9 契约打包。
 */
export interface SegmentBoxAttributes {
	vertexCount: number;
	positions: Float64Array;
	startHiFwdX: Float32Array;
	startLoFwdY: Float32Array;
	startNormFwdZ: Float32Array;
	endNormTexX: Float32Array;
	rightNormTexY: Float32Array;
	indices: Uint16Array | Uint32Array;
	/** 全线长度（米）。供 FS 虚线 / 渐变模式作为 `u_lineTotalMeters` 使用。 */
	length3D: number;
}
