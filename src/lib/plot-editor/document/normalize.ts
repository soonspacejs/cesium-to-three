import {
	PlotEditorValidationError,
	type EditorDiagnostic,
	summarizeDiagnosticValue,
} from './diagnostics';
import { isHeightReferenceClamp } from './height-reference';
import type {
	HeightReference,
	Position3D,
	PositionInput,
} from './types';

export interface PositionNormalizationOptions {
	/** API 默认归零；严格文档解析使用 reject。 */
	readonly clampHeightPolicy?: 'coerce' | 'reject';
	readonly path?: string;
	readonly onDiagnostic?: ( diagnostic: EditorDiagnostic ) => void;
}

/** 将经度规范到半开区间 [-180, 180)。 */
export function wrapLongitudeDegrees( longitude: number ): number {
	assertFiniteNumber( longitude, '/longitude' );
	const wrapped = ( ( longitude + 180 ) % 360 + 360 ) % 360 - 180;
	return normalizeNegativeZero( wrapped );
}

/**
 * 把日期变更线两侧的经度展开为连续序列。
 *
 * 每个点选择与前一点距离最小的 `lon + 360*k`；距离相等时选较小的 k，
 * 因而正好相差 180 度的输入也具有确定结果。
 */
export function unwrapLongitudeDegrees(
	longitudes: readonly number[],
): number[] {
	if ( longitudes.length === 0 ) {
		return [];
	}
	const result = [ wrapLongitudeDegrees( longitudes[ 0 ] ) ];
	for ( let index = 1; index < longitudes.length; index++ ) {
		const longitude = wrapLongitudeDegrees( longitudes[ index ] );
		const previous = result[ index - 1 ];
		const idealK = ( previous - longitude ) / 360;
		const lowerK = Math.floor( idealK );
		const upperK = Math.ceil( idealK );
		const lower = longitude + 360 * lowerK;
		const upper = longitude + 360 * upperK;
		const lowerDistance = Math.abs( lower - previous );
		const upperDistance = Math.abs( upper - previous );
		result.push( lowerDistance <= upperDistance ? lower : upper );
	}
	return result.map( normalizeNegativeZero );
}

export function unwrapPositions(
	positions: readonly Position3D[],
): Position3D[] {
	const longitudes = unwrapLongitudeDegrees(
		positions.map( ( position ) => position[ 0 ] ),
	);
	return positions.map( ( position, index ) => [
		longitudes[ index ],
		position[ 1 ],
		position[ 2 ],
	] );
}

/** 返回两个经度沿短弧的绝对角距离，范围为 [0, 180]。 */
export function wrappedLongitudeDistanceDegrees(
	left: number,
	right: number,
): number {
	const delta = Math.abs( wrapLongitudeDegrees( left ) - wrapLongitudeDegrees( right ) );
	return Math.min( delta, 360 - delta );
}

/**
 * 将二维或三维边界输入转换为严格三元坐标。
 *
 * 返回值始终是新 tuple，调用方后续修改原数组不会污染规范状态。
 */
export function normalizePosition(
	input: PositionInput,
	heightReference: HeightReference,
	options: PositionNormalizationOptions = {},
): Position3D {
	const path = options.path ?? '/position';
	if ( ! Array.isArray( input ) || ( input.length !== 2 && input.length !== 3 ) ) {
		throw invalidCoordinate(
			path,
			'坐标必须是长度为 2 的兼容 tuple 或长度为 3 的规范 tuple。',
			input,
		);
	}

	const longitude = finiteCoordinateComponent( input[ 0 ], `${ path }/0` );
	const latitude = finiteCoordinateComponent( input[ 1 ], `${ path }/1` );
	if ( latitude < -90 || latitude > 90 ) {
		throw invalidCoordinate(
			`${ path }/1`,
			'纬度必须位于 [-90, 90] 度范围内。',
			latitude,
		);
	}
	const suppliedHeight = input.length === 3
		? finiteCoordinateComponent( input[ 2 ], `${ path }/2` )
		: 0;

	let height = suppliedHeight;
	if ( isHeightReferenceClamp( heightReference ) && suppliedHeight !== 0 ) {
		const diagnostic: EditorDiagnostic = {
			code: 'INVALID_COORDINATE',
			severity: options.clampHeightPolicy === 'reject' ? 'error' : 'warning',
			message: 'CLAMP 高度参考的作者高度必须为 0。',
			path: `${ path }/2`,
			valueSummary: summarizeDiagnosticValue( suppliedHeight ),
		};
		if ( options.clampHeightPolicy === 'reject' ) {
			throw new PlotEditorValidationError( diagnostic );
		}
		options.onDiagnostic?.( diagnostic );
		height = 0;
	}

	return [
		wrapLongitudeDegrees( longitude ),
		normalizeNegativeZero( latitude ),
		normalizeNegativeZero( height ),
	];
}

/** 批量归一化先构造完整候选数组，任一点失败都不会暴露半成品。 */
export function normalizePositions(
	inputs: readonly PositionInput[],
	heightReference: HeightReference,
	options: PositionNormalizationOptions = {},
): Position3D[] {
	const basePath = options.path ?? '/positions';
	return inputs.map( ( input, index ) => normalizePosition(
		input,
		heightReference,
		{ ...options, path: `${ basePath }/${ index }` },
	) );
}

function finiteCoordinateComponent( value: unknown, path: string ): number {
	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) {
		throw invalidCoordinate(
			path,
			'坐标分量必须是有限 number，不能是字符串、NaN 或 Infinity。',
			value,
		);
	}
	return value;
}

function assertFiniteNumber( value: unknown, path: string ): asserts value is number {
	finiteCoordinateComponent( value, path );
}

function normalizeNegativeZero( value: number ): number {
	return Object.is( value, -0 ) ? 0 : value;
}

function invalidCoordinate(
	path: string,
	message: string,
	value: unknown,
): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code: 'INVALID_COORDINATE',
		severity: 'error',
		message,
		path,
		valueSummary: summarizeDiagnosticValue( value ),
	} );
}
