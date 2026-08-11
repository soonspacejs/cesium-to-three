import {
	Raycaster,
	Vector2,
	type Camera,
} from 'three';
import type { Vector3Tuple } from '../document/geodesy';
import type { ScreenPoint } from '../state/types';

const PARALLEL_EPSILON = 1e-8;

export interface ScreenRayAxisOptions {
	readonly raycaster: Raycaster;
	readonly camera: Camera;
	readonly canvas: HTMLCanvasElement;
	readonly screen: ScreenPoint;
	readonly axisOrigin: Vector3Tuple;
	readonly axisDirection: Vector3Tuple;
}

/**
 * 把画布 CSS 坐标转换为相机射线，并返回该射线最接近目标轴时的有符号轴参数（米）。
 * 轴参数以 axisOrigin 为 0，沿 axisDirection 正向为正；无稳定解时返回 null。
 */
export function screenRayAxisParameterMeters( options: ScreenRayAxisOptions ): number | null {
	const rect = options.canvas.getBoundingClientRect();
	const width = rect.width || options.canvas.clientWidth;
	const height = rect.height || options.canvas.clientHeight;
	if ( ! Number.isFinite( width ) || ! Number.isFinite( height ) || width <= 0 || height <= 0 ) {
		return null;
	}
	if ( ! Number.isFinite( options.screen.x ) || ! Number.isFinite( options.screen.y ) ) {
		return null;
	}
	options.camera.updateMatrixWorld();
	options.raycaster.setFromCamera( new Vector2(
		options.screen.x / width * 2 - 1,
		1 - options.screen.y / height * 2,
	), options.camera );
	const ray = options.raycaster.ray;
	return closestRayAxisParameterMeters(
		[ ray.origin.x, ray.origin.y, ray.origin.z ],
		[ ray.direction.x, ray.direction.y, ray.direction.z ],
		options.axisOrigin,
		options.axisDirection,
	);
}

/**
 * 求半无限相机射线与无限 Gizmo 轴的最近点轴参数。
 * 两方向近乎平行或最近点落在射线原点后方时返回 null，调用方应保留上一帧合法预览。
 */
export function closestRayAxisParameterMeters(
	rayOrigin: Vector3Tuple,
	rayDirection: Vector3Tuple,
	axisOrigin: Vector3Tuple,
	axisDirection: Vector3Tuple,
): number | null {
	if ( ! [ ...rayOrigin, ...rayDirection, ...axisOrigin, ...axisDirection ].every( Number.isFinite ) ) {
		return null;
	}
	const rayLength = Math.hypot( ...rayDirection );
	const axisLength = Math.hypot( ...axisDirection );
	if ( rayLength <= 0 || axisLength <= 0 ) return null;
	const ray = scale( rayDirection, 1 / rayLength );
	const axis = scale( axisDirection, 1 / axisLength );
	const between: Vector3Tuple = [
		axisOrigin[ 0 ] - rayOrigin[ 0 ],
		axisOrigin[ 1 ] - rayOrigin[ 1 ],
		axisOrigin[ 2 ] - rayOrigin[ 2 ],
	];
	const directionDot = dot( axis, ray );
	const denominator = 1 - directionDot * directionDot;
	if ( denominator <= PARALLEL_EPSILON ) return null;
	const axisDot = dot( axis, between );
	const rayDot = dot( ray, between );
	const axisParameter = ( directionDot * rayDot - axisDot ) / denominator;
	const rayParameter = rayDot + directionDot * axisParameter;
	if ( ! Number.isFinite( axisParameter ) || ! Number.isFinite( rayParameter ) || rayParameter < 0 ) {
		return null;
	}
	return Object.is( axisParameter, -0 ) ? 0 : axisParameter;
}

function dot( left: Vector3Tuple, right: Vector3Tuple ): number {
	return left[ 0 ] * right[ 0 ] + left[ 1 ] * right[ 1 ] + left[ 2 ] * right[ 2 ];
}

function scale( value: Vector3Tuple, factor: number ): Vector3Tuple {
	return [ value[ 0 ] * factor, value[ 1 ] * factor, value[ 2 ] * factor ];
}
