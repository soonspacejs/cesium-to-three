// ============================================================
// math/wgs84-helpers.ts — Demo / 上层用的(lon°, lat°)→ ECEF 便捷封装
// 层级:L0(零依赖数学基础,基于 ellipsoid.ts)
// 职责:把"度 + 米"输入快速转为 ECEF Vector3 或单位法向。
//      调用方一般在 demo / 静态场景配置中使用,本函数每次新建 Vector3
//      返回,无 scratch 复用约束;若需要零分配版本应直接调用
//      ellipsoid.ts 的底层函数并自带 out 参数。
// 依赖:Three.js Vector3、math/ellipsoid.ts、math/cartographic.ts
// 被消费:ground-demo.ts(经 index.ts re-export)、rectangle/rectangle-helpers.ts、
//        rectangle/rectangle-debug.ts
// 算法对应:Cesium Ellipsoid.WGS84.cartographicToCartesian /
//          geodeticSurfaceNormalCartographic 的 degree-input wrapper
// ============================================================

import { Vector3 } from 'three';

import { createCartographic } from './cartographic';
import {
	cartographicToCartesian,
	geodeticSurfaceNormalCartographic,
} from './ellipsoid';

// 模块级 scratch:cartographic 复用以避免重复分配。Vector3 输出每次新建,
// 因为 caller 通常需要长期持有结果(如 demo 中绑定到相机 lookAt 目标)。
const _wgs84Carto = createCartographic();

/**
 * 把 (lon°, lat°, h) 转为 ECEF Vector3,Three.js 世界坐标系。
 *
 * @param longitudeDegrees 经度,度(范围 [-180, 180])。
 * @param latitudeDegrees  纬度,度(范围 [-90, 90])。
 * @param height           高度,米;默认 0(椭球表面)。
 * @returns                ECEF Vector3(每次新建,可以安全持有)。
 */
export function wgs84PositionFromDegrees(
	longitudeDegrees: number,
	latitudeDegrees: number,
	height = 0.0,
): Vector3 {
	_wgs84Carto.longitude = longitudeDegrees * Math.PI / 180.0;
	_wgs84Carto.latitude = latitudeDegrees * Math.PI / 180.0;
	_wgs84Carto.height = height;

	const result = new Vector3();
	cartographicToCartesian( _wgs84Carto, result );
	return result;
}

/**
 * 把 (lon°, lat°) 转为该地理位置的椭球面单位法向(指向外)。
 *
 * 高度不影响法向,故不接受 height 参数。Up 向量、相机方向、ENU 基底
 * 的 U 轴等场景使用。
 *
 * @param longitudeDegrees 经度,度。
 * @param latitudeDegrees  纬度,度。
 * @returns                单位法向 Vector3(每次新建)。
 */
export function wgs84NormalFromDegrees(
	longitudeDegrees: number,
	latitudeDegrees: number,
): Vector3 {
	_wgs84Carto.longitude = longitudeDegrees * Math.PI / 180.0;
	_wgs84Carto.latitude = latitudeDegrees * Math.PI / 180.0;
	_wgs84Carto.height = 0.0;

	const result = new Vector3();
	geodeticSurfaceNormalCartographic( _wgs84Carto, result );
	return result;
}
