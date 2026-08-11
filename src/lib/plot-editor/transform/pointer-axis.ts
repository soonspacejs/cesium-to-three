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

export interface ScreenRayPlaneOptions {
	readonly raycaster: Raycaster;
	readonly camera: Camera;
	readonly canvas: HTMLCanvasElement;
	readonly screen: ScreenPoint;
	readonly planeOrigin: Vector3Tuple;
	readonly planeNormal: Vector3Tuple;
}

interface WorldRay {
	readonly origin: Vector3Tuple;
	readonly direction: Vector3Tuple;
}

/**
 * 把画布 CSS 坐标转换为相机射线，并返回该射线最接近目标轴时的有符号轴参数（米）。
 * 轴参数以 axisOrigin 为 0，沿 axisDirection 正向为正；无稳定解时返回 null。
 */
export function screenRayAxisParameterMeters( options: ScreenRayAxisOptions ): number | null {
	const ray = screenCameraRay( options );
	if ( ray === null ) return null;
	return closestRayAxisParameterMeters(
		ray.origin,
		ray.direction,
		options.axisOrigin,
		options.axisDirection,
	);
}

/** 返回相机射线与旋转平面交点相对 pivot 的单位方向。 */
export function screenRayPlaneDirection( options: ScreenRayPlaneOptions ): Vector3Tuple | null {
	const ray = screenCameraRay( options );
	if ( ray === null ) return null;
	return rayPlaneDirection(
		ray.origin, ray.direction, options.planeOrigin, options.planeNormal,
	);
}

function screenCameraRay( options: Pick<
	ScreenRayAxisOptions,
	'raycaster' | 'camera' | 'canvas' | 'screen'
> ): WorldRay | null {
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
	return Object.freeze( {
		origin: [ ray.origin.x, ray.origin.y, ray.origin.z ] as Vector3Tuple,
		direction: [ ray.direction.x, ray.direction.y, ray.direction.z ] as Vector3Tuple,
	} );
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

/** 求射线与平面交点相对 planeOrigin 的单位方向。 */
export function rayPlaneDirection(
	rayOrigin: Vector3Tuple,
	rayDirection: Vector3Tuple,
	planeOrigin: Vector3Tuple,
	planeNormal: Vector3Tuple,
): Vector3Tuple | null {
	if ( ! [ ...rayOrigin, ...rayDirection, ...planeOrigin, ...planeNormal ].every( Number.isFinite ) ) {
		return null;
	}
	const rayLength = Math.hypot( ...rayDirection );
	const normalLength = Math.hypot( ...planeNormal );
	if ( rayLength <= 0 || normalLength <= 0 ) return null;
	const ray = scale( rayDirection, 1 / rayLength );
	const normal = scale( planeNormal, 1 / normalLength );
	const denominator = dot( normal, ray );
	if ( Math.abs( denominator ) <= PARALLEL_EPSILON ) return null;
	const toPlane: Vector3Tuple = [
		planeOrigin[ 0 ] - rayOrigin[ 0 ],
		planeOrigin[ 1 ] - rayOrigin[ 1 ],
		planeOrigin[ 2 ] - rayOrigin[ 2 ],
	];
	const rayParameter = dot( normal, toPlane ) / denominator;
	if ( ! Number.isFinite( rayParameter ) || rayParameter < 0 ) return null;
	const radial: Vector3Tuple = [
		rayOrigin[ 0 ] + ray[ 0 ] * rayParameter - planeOrigin[ 0 ],
		rayOrigin[ 1 ] + ray[ 1 ] * rayParameter - planeOrigin[ 1 ],
		rayOrigin[ 2 ] + ray[ 2 ] * rayParameter - planeOrigin[ 2 ],
	];
	const radialLength = Math.hypot( ...radial );
	return radialLength <= 0 ? null : scale( radial, 1 / radialLength );
}

/** 计算绕 normal 从 start 到 current 的最短有符号角，范围为 [-180, 180]。 */
export function signedPlaneAngleDegrees(
	start: Vector3Tuple,
	current: Vector3Tuple,
	normal: Vector3Tuple,
): number | null {
	if ( ! [ ...start, ...current, ...normal ].every( Number.isFinite ) ) return null;
	const startLength = Math.hypot( ...start );
	const currentLength = Math.hypot( ...current );
	const normalLength = Math.hypot( ...normal );
	if ( startLength <= 0 || currentLength <= 0 || normalLength <= 0 ) return null;
	const first = scale( start, 1 / startLength );
	const second = scale( current, 1 / currentLength );
	const axis = scale( normal, 1 / normalLength );
	const crossValue = cross( first, second );
	const angle = Math.atan2( dot( axis, crossValue ), dot( first, second ) ) * 180 / Math.PI;
	return Object.is( angle, -0 ) ? 0 : angle;
}

/** 把连续的 wrapped 角增量累加为不跨 ±180° 跳变的角度。 */
export function unwrapAngleDegrees(
	previousWrapped: number,
	previousUnwrapped: number,
	currentWrapped: number,
): number {
	let delta = ( ( currentWrapped - previousWrapped + 180 ) % 360 + 360 ) % 360 - 180;
	if ( delta === -180 && currentWrapped - previousWrapped > 0 ) delta = 180;
	const unwrapped = previousUnwrapped + delta;
	return Object.is( unwrapped, -0 ) ? 0 : unwrapped;
}

function dot( left: Vector3Tuple, right: Vector3Tuple ): number {
	return left[ 0 ] * right[ 0 ] + left[ 1 ] * right[ 1 ] + left[ 2 ] * right[ 2 ];
}

function scale( value: Vector3Tuple, factor: number ): Vector3Tuple {
	return [ value[ 0 ] * factor, value[ 1 ] * factor, value[ 2 ] * factor ];
}

function cross( left: Vector3Tuple, right: Vector3Tuple ): Vector3Tuple {
	return [
		left[ 1 ] * right[ 2 ] - left[ 2 ] * right[ 1 ],
		left[ 2 ] * right[ 0 ] - left[ 0 ] * right[ 2 ],
		left[ 0 ] * right[ 1 ] - left[ 1 ] * right[ 0 ],
	];
}
