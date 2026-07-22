// ============================================================
// textured-decal.ts
// 层级：ground 内部的共享纹理贴花几何能力。
// 职责：把米制宽高、中心和旋转转换为 WGS84 表面的 ENU 四角足迹，并生成
//       classification shadow volume 所需的 RTE 几何与平面 UV 映射。
// 被消费：贴地文字与贴地图片点。两者共用同一套高精度几何和采样坐标，避免
//         在地球尺度 ECEF 坐标下出现两套实现逐渐偏离的问题。
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
	Matrix4,
	Vector3,
	Vector4,
} from 'three';

import { createCartographic } from './math/cartographic';
import { cartographicToCartesian } from './math/ellipsoid';
import { eastNorthUpToFixedFrame } from './math/enu-frame';
import { matrix4MultiplyByPoint } from './math/matrix4-helpers';
import { encodePositionsToHighLowArrays, encodeVec3RTE } from './math/rte-encoding';
import type { PlanarExtents } from './types';
import { constructExtrudedTextShadowVolume } from './text/text-construct-extruded';
import type { TextShadowVolumeOptions } from './text/text-options';

/** 纹理贴花在椭球表面的四角足迹及对应局部坐标系。 */
export interface TexturedDecalFootprint {
	swEcef: Vector3;
	seEcef: Vector3;
	nwEcef: Vector3;
	neEcef: Vector3;
	footprintWidthMeters: number;
	footprintHeightMeters: number;
	enuToEcef: Matrix4;
}

/** 计算贴花足迹所需的中心、尺寸、旋转及可选 ENU 偏移。 */
export interface TexturedDecalPlacementOptions {
	anchorLonDegrees: number;
	anchorLatDegrees: number;
	widthMeters: number;
	heightMeters: number;
	rotationRadians?: number;
	centerLocalEastMeters?: number;
	centerLocalNorthMeters?: number;
	offsetEastMeters?: number;
	offsetNorthMeters?: number;
}

const DEG_TO_RAD = Math.PI / 180.0;
const _anchorCartographic = createCartographic();
const _anchorEcef = new Vector3();
const _enuToEcef = new Matrix4();
const _scratchEnu = new Vector3();
const _swHigh = new Vector3();
const _swLow = new Vector3();

/**
 * 计算贴合 WGS84 表面的 ENU 矩形四角。
 *
 * 未旋转时宽度沿东西、高度沿南北，图片顶部指向北方。正旋转角在俯视视角下
 * 为顺时针；中心偏移先应用于局部矩形，再把四角转换到 ECEF。
 */
export function computeTexturedDecalFootprint(
	options: TexturedDecalPlacementOptions,
): TexturedDecalFootprint {
	const widthMeters = requirePositiveFinite( options.widthMeters, 'widthMeters' );
	const heightMeters = requirePositiveFinite( options.heightMeters, 'heightMeters' );
	const halfWidth = widthMeters * 0.5;
	const halfHeight = heightMeters * 0.5;
	const rotation = Number.isFinite( options.rotationRadians )
		? options.rotationRadians as number
		: 0.0;
	const cos = Math.cos( rotation );
	const sin = Math.sin( rotation );

	_anchorCartographic.longitude = options.anchorLonDegrees * DEG_TO_RAD;
	_anchorCartographic.latitude = options.anchorLatDegrees * DEG_TO_RAD;
	_anchorCartographic.height = 0.0;
	cartographicToCartesian( _anchorCartographic, _anchorEcef );
	eastNorthUpToFixedFrame( _anchorEcef, _enuToEcef );

	const centerX = options.centerLocalEastMeters ?? 0.0;
	const centerY = options.centerLocalNorthMeters ?? 0.0;
	const offsetEast = options.offsetEastMeters ?? 0.0;
	const offsetNorth = options.offsetNorthMeters ?? 0.0;
	/**
	 * 单个 box-local 角点 → ECEF。
	 * 步骤：俯视顺时针旋转 rotateCW → 叠加不随旋转的 ENU 全局米偏移
	 * → enuToEcef 变换。模块级 scratch 只参与计算，返回值始终是新 Vector3，
	 * 因而可由文字或图片图元长期持有。
	 */
	const corner = ( x: number, y: number ): Vector3 => {
		// rotateCW(vx,vy,α) = (vx·cosα + vy·sinα, −vx·sinα + vy·cosα)。
		const rotatedEast = x * cos + y * sin;
		const rotatedNorth = - x * sin + y * cos;
		// 全局米偏移在 ENU 系，z=0 落在锚点切平面。
		_scratchEnu.set( rotatedEast + offsetEast, rotatedNorth + offsetNorth, 0.0 );
		return matrix4MultiplyByPoint( _enuToEcef, _scratchEnu, new Vector3() );
	};

	return {
		swEcef: corner( centerX - halfWidth, centerY - halfHeight ),
		seEcef: corner( centerX + halfWidth, centerY - halfHeight ),
		nwEcef: corner( centerX - halfWidth, centerY + halfHeight ),
		neEcef: corner( centerX + halfWidth, centerY + halfHeight ),
		footprintWidthMeters: widthMeters,
		footprintHeightMeters: heightMeters,
		enuToEcef: _enuToEcef.clone(),
	};
}

/**
 * 将足迹转换为 classification 颜色阶段使用的 RTE 平面和完整 [0,1] UV 范围。
 * 纹理原点固定在西南角，eastward/northward 分别沿贴花自身的宽、高方向。
 */
export function computeTexturedDecalPlanarExtents(
	footprint: TexturedDecalFootprint,
): PlanarExtents {
	// eastward = SE − SW（沿旋转后的贴花右方向）。
	const eastward = footprint.seEcef.clone().sub( footprint.swEcef );
	// northward = NW − SW（沿旋转后的贴花上方向）。
	const northward = footprint.nwEcef.clone().sub( footprint.swEcef );
	// SW 角点 RTE 编码（high/low Float32）。
	encodeVec3RTE( footprint.swEcef, _swHigh, _swLow );
	return {
		southWestHigh: _swHigh.clone(),
		southWestLow: _swLow.clone(),
		eastward,
		northward,
		// 整张纹理铺满四角足迹。
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		// color 材质用 zw 做 planarMeters → uv 归一化。
		innerMetersRect: new Vector4(
			0.0,
			0.0,
			footprint.footprintWidthMeters,
			footprint.footprintHeightMeters,
		),
	};
}

/**
 * 构建 classification 的封闭 shadow volume，并将 ECEF 顶点拆为 high/low。
 * 属性名是分类着色器的固定输入契约，文字和图片点必须保持完全一致。
 */
export function buildTexturedDecalShadowVolumeGeometry(
	options: TextShadowVolumeOptions,
): BufferGeometry {
	// 步骤 1 · 棱柱顶点、挤出方向与索引。
	const result = constructExtrudedTextShadowVolume( options );
	// 步骤 2 · RTE split-double：Float64 ECEF → high/low Float32。
	const { high, low } = encodePositionsToHighLowArrays( result.positions );
	// 步骤 3 · 装配 BufferGeometry。
	const geometry = new BufferGeometry();
	const vertexCount = result.positions.length / 3;
	// 这些名称是 ShadowVolumeAppearanceVS.glsl 的输入契约，不可改名。
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	geometry.setAttribute(
		'extrudeDirection',
		new BufferAttribute( result.extrudeDirection, 3 ),
	);
	geometry.setAttribute(
		'batchId',
		// 单个贴花作为一个 batch，所有顶点固定为 0。
		new BufferAttribute( new Float32Array( vertexCount ), 1 ),
	);
	// 合并索引包含 top cap、bottom cap 与四面侧墙。
	geometry.setIndex( new BufferAttribute( result.indices, 1 ) );
	return geometry;
}

/** 统一拒绝零、负数、NaN 与无穷大的米制尺寸。 */
function requirePositiveFinite( value: number, field: string ): number {
	if ( ! Number.isFinite( value ) || value <= 0.0 ) {
		throw new Error( `Textured decal ${ field } must be a positive finite number.` );
	}
	return value;
}
