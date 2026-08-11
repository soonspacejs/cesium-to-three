import type { InteractionModifiers } from '../state/types';
import type { Vector3Tuple } from '../document/geodesy';

const ROTATION_SNAP_DEGREES = 15;
const SCALE_PIXELS_TO_EXPONENT = 0.01;
const MINIMUM_POINTER_SCALE = 0.01;

/** Shift/Alt 与键盘微调共用 10 倍、0.1 倍规则；同时按下时回到 1 倍。 */
export function pointerModifierMultiplier( modifiers: InteractionModifiers ): number {
	return ( modifiers.shift ? 10 : 1 ) * ( modifiers.alt ? 0.1 : 1 );
}

/** 平移 delta 始终相对 pointerdown，倍率切换不会累计前一帧误差。 */
export function constrainPointerTranslation(
	delta: Vector3Tuple,
	modifiers: InteractionModifiers,
): Vector3Tuple {
	const multiplier = pointerModifierMultiplier( modifiers );
	return [ delta[ 0 ] * multiplier, delta[ 1 ] * multiplier, delta[ 2 ] * multiplier ];
}

/**
 * 屏幕旋转默认吸附到 15°；Alt 临时关闭吸附，供精细调整。
 * Shift 先改变灵敏度再吸附，符合拖拽与键盘统一倍率约定。
 */
export function pointerRotationDegrees(
	deltaXCssPixels: number,
	deltaYCssPixels: number,
	modifiers: InteractionModifiers,
): Vector3Tuple {
	const multiplier = pointerModifierMultiplier( modifiers );
	const raw: Vector3Tuple = [
		deltaXCssPixels * multiplier,
		-deltaYCssPixels * multiplier,
		deltaXCssPixels * multiplier,
	];
	if ( modifiers.alt ) return raw;
	return [ snapRotation( raw[ 0 ] ), snapRotation( raw[ 1 ] ), snapRotation( raw[ 2 ] ) ];
}

/** 缩放保持严格正数，并用指数曲线避免跨过零点。 */
export function pointerScaleFactor(
	deltaXCssPixels: number,
	modifiers: InteractionModifiers,
): number {
	const exponent = deltaXCssPixels * SCALE_PIXELS_TO_EXPONENT
		* pointerModifierMultiplier( modifiers );
	return Math.max( MINIMUM_POINTER_SCALE, Math.exp( exponent ) );
}

function snapRotation( value: number ): number {
	const snapped = Math.round( value / ROTATION_SNAP_DEGREES ) * ROTATION_SNAP_DEGREES;
	return Object.is( snapped, -0 ) ? 0 : snapped;
}
