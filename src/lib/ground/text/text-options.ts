// ============================================================
// text-options.ts
// 层级：L1（依赖 Three.Vector3 类型 + ground/constants）
// 职责：定义贴地文本 shadow volume 构造选项 —— 4 个 ECEF 角点(文字空间环序
//       SW/SE/NE/NW) + 顶/底高度。比 circle 的 options 简单(无半径/granularity)。
// 依赖：Three.js Vector3。
// 被消费：text-construct-extruded / text-shadow-volume。
// ============================================================

import type { Vector3 } from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from '../constants';

/**
 * 贴地文本 shadow volume 构造选项。
 *
 * 4 个角点必须是 text-placement.computeTextFootprint 产出的同一组，
 * 环序固定 SW(左下) → SE(右下) → NE(右上) → NW(左上)（俯视 CCW）。
 */
export interface TextShadowVolumeOptions {
	/** 文字左下角 ECEF（uv 原点）。 */
	swEcef: Vector3;
	/** 文字右下角 ECEF。 */
	seEcef: Vector3;
	/** 文字右上角 ECEF。 */
	neEcef: Vector3;
	/** 文字左上角 ECEF。 */
	nwEcef: Vector3;
	/** 顶面高度，米。默认 +CESIUM_GLOBE_MINIMUM_ALTITUDE。 */
	maximumHeight?: number;
	/** 底面高度，米。默认 −CESIUM_GLOBE_MINIMUM_ALTITUDE。 */
	minimumHeight?: number;
}

/** 顶面默认高度（米）：与 rectangle/circle 一致，确保 shadow volume 罩住地形。 */
export const TEXT_DEFAULT_MAX_HEIGHT = CESIUM_GLOBE_MINIMUM_ALTITUDE;
/** 底面默认高度（米）：负值，向地心方向延伸。 */
export const TEXT_DEFAULT_MIN_HEIGHT = -CESIUM_GLOBE_MINIMUM_ALTITUDE;
