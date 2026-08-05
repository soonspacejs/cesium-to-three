import { ClassificationType } from '../../ground/types';
import {
	PlotEditorValidationError,
	summarizeDiagnosticValue,
} from './diagnostics';
import {
	HeightReference,
	type HeightMode,
	type HeightReferenceName,
	type HeightSurface,
} from './types';

const HEIGHT_REFERENCE_NAMES = Object.freeze(
	Object.keys( HeightReference ) as HeightReferenceName[],
);

/** 判断未知值是否为合法的七值高度参考。 */
export function isHeightReference( value: unknown ): value is HeightReference {
	return typeof value === 'number'
		&& Number.isInteger( value )
		&& value >= HeightReference.NONE
		&& value <= HeightReference.RELATIVE_TO_3D_TILE;
}

/** 判断高度参考是否要求作者高度恒为零。 */
export function isHeightReferenceClamp( value: HeightReference ): boolean {
	return value === HeightReference.CLAMP_TO_GROUND
		|| value === HeightReference.CLAMP_TO_TERRAIN
		|| value === HeightReference.CLAMP_TO_3D_TILE;
}

/** 判断第三维是否表示相对目标表面的米制偏移。 */
export function isHeightReferenceRelative( value: HeightReference ): boolean {
	return value === HeightReference.RELATIVE_TO_GROUND
		|| value === HeightReference.RELATIVE_TO_TERRAIN
		|| value === HeightReference.RELATIVE_TO_3D_TILE;
}

export function getHeightMode( value: HeightReference ): HeightMode {
	assertHeightReference( value );
	if ( value === HeightReference.NONE ) {
		return 'absolute';
	}
	return isHeightReferenceClamp( value ) ? 'clamp' : 'relative';
}

export function getHeightSurface( value: HeightReference ): HeightSurface {
	assertHeightReference( value );
	switch ( value ) {
		case HeightReference.NONE:
			return 'ellipsoid';
		case HeightReference.CLAMP_TO_GROUND:
		case HeightReference.RELATIVE_TO_GROUND:
			return 'ground';
		case HeightReference.CLAMP_TO_TERRAIN:
		case HeightReference.RELATIVE_TO_TERRAIN:
			return 'terrain';
		case HeightReference.CLAMP_TO_3D_TILE:
		case HeightReference.RELATIVE_TO_3D_TILE:
			return '3d-tile';
	}
}

/** 将高度参考投影为现有 Ground 渲染器的 classification 目标。 */
export function getClassificationType(
	value: HeightReference,
): ClassificationType | undefined {
	switch ( getHeightSurface( value ) ) {
		case 'ellipsoid':
			return undefined;
		case 'ground':
			return ClassificationType.BOTH;
		case 'terrain':
			return ClassificationType.TERRAIN;
		case '3d-tile':
			return ClassificationType.CESIUM_3D_TILE;
	}
}

/** 取得稳定的序列化名称。 */
export function getHeightReferenceName(
	value: HeightReference,
): HeightReferenceName {
	assertHeightReference( value );
	const name = HEIGHT_REFERENCE_NAMES.find(
		( candidate ) => HeightReference[ candidate ] === value,
	);
	if ( name === undefined ) {
		throw createInvalidHeightReferenceError( value );
	}
	return name;
}

/** 接受公共 API 的数值或 JSON 中的稳定字符串名。 */
export function parseHeightReference( value: unknown ): HeightReference {
	if ( isHeightReference( value ) ) {
		return value;
	}
	if ( typeof value === 'string'
		&& Object.prototype.hasOwnProperty.call( HeightReference, value ) ) {
		return HeightReference[ value as HeightReferenceName ];
	}
	throw createInvalidHeightReferenceError( value );
}

function assertHeightReference(
	value: HeightReference,
): asserts value is HeightReference {
	if ( ! isHeightReference( value ) ) {
		throw createInvalidHeightReferenceError( value );
	}
}

function createInvalidHeightReferenceError(
	value: unknown,
): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code: 'INVALID_HEIGHT_REFERENCE',
		severity: 'error',
		message: 'heightReference 必须是 0..6 的整数或对应的稳定名称。',
		path: '/heightReference',
		valueSummary: summarizeDiagnosticValue( value ),
	} );
}
