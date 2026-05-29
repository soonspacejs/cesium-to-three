// ============================================================
// circle/circle-extents.ts
// 层级:与 Cesium 耦合的 circle 贴地适配辅助。
// 职责:为 Cesium CircleGeometry shadow volume 计算平面 uniform，
//      同时让几何真源继续保留在 cesium-ground-source 中。
// 依赖:本地 WGS84 数学辅助函数与 Three.js 向量。
// 被消费:primitives.ts 的 CesiumGroundCirclePrimitive。
// ============================================================

import { Matrix4, Vector2, Vector3, Vector4 } from 'three';

import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import { encodeVec3RTE } from '../math/rte-encoding';
import type { PlanarExtents } from '../types';

export interface CirclePlanarExtents {
	extents: PlanarExtents;
	centerMeters: Vector2;
	fillRadiusMeters: number;
	renderRadiusMeters: number;
}

const _circleCenterCarto = createCartographic();
const _circleCenterEcef = new Vector3();
const _circleEnuToEcef = new Matrix4();
const _circleCornerEnu = new Vector3();
const _circleSwEcef = new Vector3();
const _circleSeEcef = new Vector3();
const _circleNwEcef = new Vector3();
const _circleSwHigh = new Vector3();
const _circleSwLow = new Vector3();

/**
 * 计算 Cesium ShadowVolumeAppearance 使用的平面米制坐标框架。
 *
 * 圆形 mesh 本身仍由 Cesium CircleGeometry 生成。这个辅助函数只提供共享
 * classification shader 所需的 Three 侧 batch-table uniform。局部坐标框架以
 * WGS84 圆心为中心，并覆盖渲染半径，包含可选描边带。
 *
 * @param centerLongitudeDegrees 圆心经度，单位度。
 * @param centerLatitudeDegrees 圆心纬度，单位度。
 * @param fillRadiusMeters 公开 Cesium 圆半径，单位米。
 * @param renderRadiusMeters shadow volume 使用的半径，包含描边。
 * @returns 平面 extents，以及同一米制框架中的圆形样式 uniform。
 */
export function computeCirclePlanarExtents(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	fillRadiusMeters: number,
	renderRadiusMeters: number,
): CirclePlanarExtents {
	_circleCenterCarto.longitude = centerLongitudeDegrees * Math.PI / 180.0;
	_circleCenterCarto.latitude = centerLatitudeDegrees * Math.PI / 180.0;
	_circleCenterCarto.height = 0.0;
	cartographicToCartesian( _circleCenterCarto, _circleCenterEcef );
	eastNorthUpToFixedFrame( _circleCenterEcef, _circleEnuToEcef );

	_circleCornerEnu.set( - renderRadiusMeters, - renderRadiusMeters, 0.0 );
	matrix4MultiplyByPoint( _circleEnuToEcef, _circleCornerEnu, _circleSwEcef );

	_circleCornerEnu.set( renderRadiusMeters, - renderRadiusMeters, 0.0 );
	matrix4MultiplyByPoint( _circleEnuToEcef, _circleCornerEnu, _circleSeEcef );

	_circleCornerEnu.set( - renderRadiusMeters, renderRadiusMeters, 0.0 );
	matrix4MultiplyByPoint( _circleEnuToEcef, _circleCornerEnu, _circleNwEcef );

	const eastward = new Vector3(
		_circleSeEcef.x - _circleSwEcef.x,
		_circleSeEcef.y - _circleSwEcef.y,
		_circleSeEcef.z - _circleSwEcef.z,
	);
	const northward = new Vector3(
		_circleNwEcef.x - _circleSwEcef.x,
		_circleNwEcef.y - _circleSwEcef.y,
		_circleNwEcef.z - _circleSwEcef.z,
	);

	encodeVec3RTE( _circleSwEcef, _circleSwHigh, _circleSwLow );

	return {
		extents: {
			southWestHigh: new Vector3( _circleSwHigh.x, _circleSwHigh.y, _circleSwHigh.z ),
			southWestLow: new Vector3( _circleSwLow.x, _circleSwLow.y, _circleSwLow.z ),
			eastward,
			northward,
			uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
			uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
			innerMetersRect: new Vector4(
				renderRadiusMeters - fillRadiusMeters,
				renderRadiusMeters - fillRadiusMeters,
				renderRadiusMeters + fillRadiusMeters,
				renderRadiusMeters + fillRadiusMeters,
			),
		},
		centerMeters: new Vector2( renderRadiusMeters, renderRadiusMeters ),
		fillRadiusMeters,
		renderRadiusMeters,
	};
}
