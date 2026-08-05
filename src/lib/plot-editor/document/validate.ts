import {
	createEnuFrame,
	ecefToEnu,
	geodesicDistanceMeters,
	geodeticToEcef,
} from './geodesy';
import {
	PlotEditorValidationError,
	type EditorDiagnostic,
	summarizeDiagnosticValue,
} from './diagnostics';
import { parseHeightReference } from './height-reference';
import {
	normalizePosition,
	normalizePositions,
	type PositionNormalizationOptions,
} from './normalize';
import type {
	ArrowGeometry,
	ArrowType,
	CircleGeometry,
	HeightReference,
	JsonValue,
	LineGeometry,
	LineStyle,
	PlotFeature,
	PlotFeatureType,
	PlotGeometry,
	PlotStyle,
	PointGeometry,
	PointStyle,
	PolygonGeometry,
	Position3D,
	RectangleGeometry,
	SectorGeometry,
	TextGeometry,
	TextHorizontalAlign,
	TextLayoutDirection,
	TextStyle,
	TextVerticalAlign,
} from './types';

const GEODESIC_EPSILON_METERS = 1e-3;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const FEATURE_TYPES: readonly PlotFeatureType[] = [
	'point',
	'line',
	'polygon',
	'rectangle',
	'sector',
	'arrow',
	'text',
	'circle',
];
const ARROW_TYPES: readonly ArrowType[] = [
	'fine',
	'assaultDirection',
	'attack',
	'swallowtailAttack',
	'curved',
];

export interface FeatureNormalizationOptions extends PositionNormalizationOptions {
	readonly path?: string;
}

/**
 * 对外部 feature 做全量校验、规范化、深复制和冻结。
 *
 * 该函数先构造完整候选对象，最后才返回；调用方可以据此保证命令应用的原子性。
 */
export function normalizeFeature(
	input: unknown,
	options: FeatureNormalizationOptions = {},
): PlotFeature {
	const path = options.path ?? '/feature';
	const record = expectRecord( input, path, 'INVALID_SCHEMA' );
	const id = expectNonEmptyString( record.id, `${ path }/id`, 'INVALID_SCHEMA' );
	const type = expectEnum(
		record.type,
		FEATURE_TYPES,
		`${ path }/type`,
		'UNSUPPORTED_GRAPHICS_KIND',
	) as PlotFeatureType;
	const heightReference = parseHeightReferenceAt(
		record.heightReference,
		`${ path }/heightReference`,
	);
	const revision = expectSafeInteger(
		record.revision,
		`${ path }/revision`,
		0,
		'INVALID_SCHEMA',
	);
	const visible = expectBoolean(
		record.visible,
		`${ path }/visible`,
		'INVALID_SCHEMA',
	);
	const geometry = normalizeGeometry(
		type,
		record.geometry,
		heightReference,
		{ ...options, path: `${ path }/geometry` },
	);
	const style = normalizeStyle( type, record.style, `${ path }/style` );
	const properties = normalizeProperties( record.properties, `${ path }/properties` );

	return deepFreeze( {
		id,
		type,
		geometry,
		style,
		heightReference,
		visible,
		properties,
		revision,
	} as PlotFeature );
}

export function normalizeGeometry(
	type: PlotFeatureType,
	input: unknown,
	heightReference: HeightReference,
	options: FeatureNormalizationOptions = {},
): PlotGeometry {
	const path = options.path ?? '/geometry';
	const record = expectRecord( input, path, 'INVALID_GEOMETRY' );
	const positionOptions = {
		clampHeightPolicy: options.clampHeightPolicy,
		onDiagnostic: options.onDiagnostic,
	};

	switch ( type ) {
		case 'point':
			return deepFreeze( {
				position: normalizePosition(
					record.position as never,
					heightReference,
					{ ...positionOptions, path: `${ path }/position` },
				),
			} satisfies PointGeometry );
		case 'line': {
			const positions = normalizePositionArray(
				record.positions,
				heightReference,
				2,
				`${ path }/positions`,
				positionOptions,
			);
			validateAdjacentPositions( positions, `${ path }/positions` );
			return deepFreeze( { positions } satisfies LineGeometry );
		}
		case 'polygon': {
			const positions = normalizePositionArray(
				record.positions,
				heightReference,
				3,
				`${ path }/positions`,
				positionOptions,
			);
			validatePolygon( positions, `${ path }/positions` );
			return deepFreeze( { positions } satisfies PolygonGeometry );
		}
		case 'rectangle': {
			const positions = normalizePositionArray(
				record.positions,
				heightReference,
				4,
				`${ path }/positions`,
				positionOptions,
				4,
			);
			validateRectangle( positions, `${ path }/positions` );
			return deepFreeze( {
				positions: positions as unknown as RectangleGeometry[ 'positions' ],
			} satisfies RectangleGeometry );
		}
		case 'sector': {
			const center = normalizePosition(
				record.center as never,
				heightReference,
				{ ...positionOptions, path: `${ path }/center` },
			);
			const radius = expectPositiveNumber(
				record.radius,
				`${ path }/radius`,
				'INVALID_GEOMETRY',
			);
			const startAngle = expectNumberInRange(
				record.startAngle,
				`${ path }/startAngle`,
				0,
				360,
				false,
				'INVALID_GEOMETRY',
			);
			const sectorAngle = expectNumberInRange(
				record.sectorAngle,
				`${ path }/sectorAngle`,
				0,
				360,
				true,
				'INVALID_GEOMETRY',
			);
			return deepFreeze( {
				center,
				radius,
				startAngle,
				sectorAngle,
			} satisfies SectorGeometry );
		}
		case 'arrow': {
			const arrowType = expectEnum(
				record.arrowType,
				ARROW_TYPES,
				`${ path }/arrowType`,
				'INVALID_GEOMETRY',
			) as ArrowType;
			const minimum = arrowType === 'attack' || arrowType === 'swallowtailAttack'
				? 3
				: 2;
			const positions = normalizePositionArray(
				record.positions,
				heightReference,
				minimum,
				`${ path }/positions`,
				positionOptions,
			);
			validateAdjacentPositions( positions, `${ path }/positions` );
			const geometry: ArrowGeometry = {
				positions,
				arrowType,
				sizeScale: expectPositiveNumber(
					record.sizeScale,
					`${ path }/sizeScale`,
					'INVALID_GEOMETRY',
				),
				...optionalPositiveNumberProperty(
					record,
					'curvedBodyWidthFactor',
					path,
				),
				...optionalPositiveNumberProperty(
					record,
					'curvedHeadWidthFactor',
					path,
				),
				...optionalPositiveNumberProperty(
					record,
					'curvedHeadLengthFactor',
					path,
				),
			};
			return deepFreeze( geometry );
		}
		case 'text':
			return deepFreeze( {
				position: normalizePosition(
					record.position as never,
					heightReference,
					{ ...positionOptions, path: `${ path }/position` },
				),
			} satisfies TextGeometry );
		case 'circle':
			return deepFreeze( {
				center: normalizePosition(
					record.center as never,
					heightReference,
					{ ...positionOptions, path: `${ path }/center` },
				),
				radius: expectPositiveNumber(
					record.radius,
					`${ path }/radius`,
					'INVALID_GEOMETRY',
				),
			} satisfies CircleGeometry );
	}
}

export function normalizeStyle(
	type: PlotFeatureType,
	input: unknown,
	path = '/style',
): PlotStyle {
	const record = expectRecord( input, path, 'INVALID_STYLE' );
	const common = normalizeCommonStyle( record, path );
	if ( type === 'point' ) {
		const pointStyle = expectEnum(
			record.pointStyle,
			[ 'circle', 'square', 'image' ] as const,
			`${ path }/pointStyle`,
			'INVALID_STYLE',
		);
		if ( pointStyle === 'image' ) {
			return deepFreeze( {
				...common,
				pointStyle,
				imageUrl: expectNonEmptyString(
					record.imageUrl,
					`${ path }/imageUrl`,
					'INVALID_STYLE',
				),
				imageWidth: expectPositiveNumber(
					record.imageWidth,
					`${ path }/imageWidth`,
					'INVALID_STYLE',
				),
				imageHeight: expectPositiveNumber(
					record.imageHeight,
					`${ path }/imageHeight`,
					'INVALID_STYLE',
				),
				rotation: expectFiniteNumber(
					record.rotation,
					`${ path }/rotation`,
					'INVALID_STYLE',
				),
			} satisfies PointStyle );
		}
		return deepFreeze( {
			...common,
			pointStyle,
			size: expectPositiveNumber(
				record.size,
				`${ path }/size`,
				'INVALID_STYLE',
			),
		} satisfies PointStyle );
	}
	if ( type === 'line' ) {
		return deepFreeze( {
			...common,
			strokeStyle: expectEnum(
				record.strokeStyle,
				[ 'solid', 'dashed' ] as const,
				`${ path }/strokeStyle`,
				'INVALID_STYLE',
			),
			showArrow: expectBoolean(
				record.showArrow,
				`${ path }/showArrow`,
				'INVALID_STYLE',
			),
			startArrowStyle: expectNullableArrowStyle(
				record.startArrowStyle,
				`${ path }/startArrowStyle`,
			),
			endArrowStyle: expectNullableArrowStyle(
				record.endArrowStyle,
				`${ path }/endArrowStyle`,
			),
		} satisfies LineStyle );
	}
	if ( type === 'text' ) {
		return deepFreeze( {
			...common,
			content: expectNonEmptyString(
				record.content,
				`${ path }/content`,
				'INVALID_STYLE',
			),
			fontColor: expectNonEmptyString(
				record.fontColor,
				`${ path }/fontColor`,
				'INVALID_STYLE',
			),
			fontSize: expectPositiveNumber(
				record.fontSize,
				`${ path }/fontSize`,
				'INVALID_STYLE',
			),
			scale: expectPositiveNumber(
				record.scale,
				`${ path }/scale`,
				'INVALID_STYLE',
			),
			textAlign: expectEnum(
				record.textAlign,
				[ 'left', 'center', 'right' ] as const,
				`${ path }/textAlign`,
				'INVALID_STYLE',
			) as TextHorizontalAlign,
			verticalAlign: expectEnum(
				record.verticalAlign,
				[ 'top', 'middle', 'bottom' ] as const,
				`${ path }/verticalAlign`,
				'INVALID_STYLE',
			) as TextVerticalAlign,
			anchorX: expectEnum(
				record.anchorX,
				[ 'left', 'center', 'right' ] as const,
				`${ path }/anchorX`,
				'INVALID_STYLE',
			) as TextHorizontalAlign,
			anchorY: expectEnum(
				record.anchorY,
				[ 'top', 'middle', 'bottom' ] as const,
				`${ path }/anchorY`,
				'INVALID_STYLE',
			) as TextVerticalAlign,
			...optionalPositiveNumberProperty( record, 'boxWidth', path ),
			...optionalPositiveNumberProperty( record, 'boxHeight', path ),
			padding: normalizePadding( record.padding, `${ path }/padding` ),
			layoutDirection: expectEnum(
				record.layoutDirection,
				[ 'horizontal', 'vertical-rl', 'vertical-lr' ] as const,
				`${ path }/layoutDirection`,
				'INVALID_STYLE',
			) as TextLayoutDirection,
			rotation: expectFiniteNumber(
				record.rotation,
				`${ path }/rotation`,
				'INVALID_STYLE',
			),
			offsetX: expectFiniteNumber(
				record.offsetX,
				`${ path }/offsetX`,
				'INVALID_STYLE',
			),
			offsetY: expectFiniteNumber(
				record.offsetY,
				`${ path }/offsetY`,
				'INVALID_STYLE',
			),
			showBorder: expectBoolean(
				record.showBorder,
				`${ path }/showBorder`,
				'INVALID_STYLE',
			),
		} satisfies TextStyle );
	}
	return deepFreeze( common );
}

export function normalizeProperties(
	input: unknown,
	path = '/properties',
): Readonly<Record<string, JsonValue>> {
	const record = expectRecord( input, path, 'INVALID_PROPERTIES' );
	const seen = new Set<object>();
	const counter = { value: 0 };
	const result: Record<string, JsonValue> = {};
	seen.add( record );
	for ( const [ key, value ] of Object.entries( record ) ) {
		result[ key ] = cloneJsonValue( value, `${ path }/${ escapeJsonPointer( key ) }`, 1, seen, counter );
	}
	seen.delete( record );
	return deepFreeze( result );
}

function normalizePositionArray(
	input: unknown,
	heightReference: HeightReference,
	minimum: number,
	path: string,
	options: Omit<FeatureNormalizationOptions, 'path'>,
	exact?: number,
): Position3D[] {
	if ( ! Array.isArray( input ) ) {
		throw validationError( 'INVALID_GEOMETRY', path, 'positions 必须是坐标数组。', input );
	}
	if ( input.length < minimum || ( exact !== undefined && input.length !== exact ) ) {
		throw validationError(
			'INVALID_GEOMETRY',
			path,
			exact === undefined
				? `positions 至少需要 ${ minimum } 个坐标。`
				: `positions 必须恰好包含 ${ exact } 个坐标。`,
			input,
		);
	}
	return normalizePositions(
		input as never[],
		heightReference,
		{ ...options, path },
	);
}

function validateAdjacentPositions( positions: readonly Position3D[], path: string ): void {
	for ( let index = 1; index < positions.length; index++ ) {
		if ( geodesicDistanceMeters( positions[ index - 1 ], positions[ index ] )
			<= GEODESIC_EPSILON_METERS ) {
			throw validationError(
				'INVALID_GEOMETRY',
				`${ path }/${ index }`,
				'相邻控制点不能在测地线容差内重合。',
				positions[ index ],
			);
		}
	}
}

function validatePolygon( positions: readonly Position3D[], path: string ): void {
	validateAdjacentPositions( positions, path );
	if ( geodesicDistanceMeters( positions[ 0 ], positions[ positions.length - 1 ] )
		<= GEODESIC_EPSILON_METERS ) {
		throw validationError(
			'INVALID_GEOMETRY',
			`${ path }/${ positions.length - 1 }`,
			'多边形不得重复保存首点作为闭合终点。',
			positions[ positions.length - 1 ],
		);
	}
	const planar = projectToLocalPlane( positions );
	let twiceArea = 0;
	for ( let index = 0; index < planar.length; index++ ) {
		const next = ( index + 1 ) % planar.length;
		twiceArea += planar[ index ][ 0 ] * planar[ next ][ 1 ]
			- planar[ next ][ 0 ] * planar[ index ][ 1 ];
	}
	if ( Math.abs( twiceArea ) <= GEODESIC_EPSILON_METERS ** 2 ) {
		throw validationError(
			'INVALID_GEOMETRY',
			path,
			'多边形不能共线或具有零面积。',
			positions,
		);
	}
	for ( let first = 0; first < planar.length; first++ ) {
		const firstNext = ( first + 1 ) % planar.length;
		for ( let second = first + 1; second < planar.length; second++ ) {
			const secondNext = ( second + 1 ) % planar.length;
			if ( first === second || firstNext === second || secondNext === first ) {
				continue;
			}
			if ( segmentsIntersect(
				planar[ first ],
				planar[ firstNext ],
				planar[ second ],
				planar[ secondNext ],
			) ) {
				throw validationError(
					'INVALID_GEOMETRY',
					path,
					'多边形外环不能自交。',
					positions,
				);
			}
		}
	}
}

function validateRectangle( positions: readonly Position3D[], path: string ): void {
	validatePolygon( positions, path );
	const planar = projectToLocalPlane( positions );
	const edges = planar.map( ( point, index ) => {
		const next = planar[ ( index + 1 ) % planar.length ];
		return [ next[ 0 ] - point[ 0 ], next[ 1 ] - point[ 1 ] ] as const;
	} );
	const lengths = edges.map( ( edge ) => Math.hypot( edge[ 0 ], edge[ 1 ] ) );
	if ( lengths.some( ( length ) => length <= GEODESIC_EPSILON_METERS ) ) {
		throw validationError( 'INVALID_GEOMETRY', path, '矩形宽和高必须大于零。', positions );
	}
	for ( let index = 0; index < edges.length; index++ ) {
		const next = ( index + 1 ) % edges.length;
		const normalizedDot = Math.abs(
			( edges[ index ][ 0 ] * edges[ next ][ 0 ]
				+ edges[ index ][ 1 ] * edges[ next ][ 1 ] )
			/ ( lengths[ index ] * lengths[ next ] ),
		);
		if ( normalizedDot > 0.02 ) {
			throw validationError(
				'INVALID_GEOMETRY',
				path,
				'矩形相邻边必须在局部 ENU 中保持正交。',
				positions,
			);
		}
	}
	if ( relativeDifference( lengths[ 0 ], lengths[ 2 ] ) > 0.02
		|| relativeDifference( lengths[ 1 ], lengths[ 3 ] ) > 0.02 ) {
		throw validationError(
			'INVALID_GEOMETRY',
			path,
			'矩形两组对边必须分别等长。',
			positions,
		);
	}
}

function projectToLocalPlane(
	positions: readonly Position3D[],
): readonly ( readonly [ number, number ] )[] {
	const frame = createEnuFrame( positions[ 0 ] );
	return positions.map( ( position ) => {
		const local = ecefToEnu( geodeticToEcef( position ), frame );
		return [ local[ 0 ], local[ 1 ] ] as const;
	} );
}

function segmentsIntersect(
	a: readonly [ number, number ],
	b: readonly [ number, number ],
	c: readonly [ number, number ],
	d: readonly [ number, number ],
): boolean {
	const abC = orientation( a, b, c );
	const abD = orientation( a, b, d );
	const cdA = orientation( c, d, a );
	const cdB = orientation( c, d, b );
	return abC * abD < 0 && cdA * cdB < 0;
}

function orientation(
	a: readonly [ number, number ],
	b: readonly [ number, number ],
	c: readonly [ number, number ],
): number {
	return ( b[ 0 ] - a[ 0 ] ) * ( c[ 1 ] - a[ 1 ] )
		- ( b[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] );
}

function relativeDifference( left: number, right: number ): number {
	return Math.abs( left - right ) / Math.max( left, right );
}

function normalizeCommonStyle(
	record: Record<string, unknown>,
	path: string,
): PlotStyle {
	return {
		strokeColor: expectNonEmptyString(
			record.strokeColor,
			`${ path }/strokeColor`,
			'INVALID_STYLE',
		),
		strokeWidth: expectNumberInRange(
			record.strokeWidth,
			`${ path }/strokeWidth`,
			0,
			Number.POSITIVE_INFINITY,
			false,
			'INVALID_STYLE',
		),
		strokeOpacity: expectNumberInRange(
			record.strokeOpacity,
			`${ path }/strokeOpacity`,
			0,
			100,
			false,
			'INVALID_STYLE',
		),
		fillColor: expectNonEmptyString(
			record.fillColor,
			`${ path }/fillColor`,
			'INVALID_STYLE',
		),
		fillOpacity: expectNumberInRange(
			record.fillOpacity,
			`${ path }/fillOpacity`,
			0,
			100,
			false,
			'INVALID_STYLE',
		),
	};
}

function normalizePadding(
	input: unknown,
	path: string,
): number | readonly [ number, number, number, number ] {
	if ( typeof input === 'number' ) {
		return expectNumberInRange( input, path, 0, Number.POSITIVE_INFINITY, false, 'INVALID_STYLE' );
	}
	if ( ! Array.isArray( input ) || input.length !== 4 ) {
		throw validationError(
			'INVALID_STYLE',
			path,
			'padding 必须是非负 number 或长度为 4 的非负 tuple。',
			input,
		);
	}
	return input.map( ( value, index ) => expectNumberInRange(
		value,
		`${ path }/${ index }`,
		0,
		Number.POSITIVE_INFINITY,
		false,
		'INVALID_STYLE',
	) ) as [ number, number, number, number ];
}

function normalizePropertiesRecordKey( key: string ): string {
	return key;
}

function cloneJsonValue(
	value: unknown,
	path: string,
	depth: number,
	seen: Set<object>,
	counter: { value: number },
): JsonValue {
	counter.value++;
	if ( counter.value > MAX_JSON_NODES || depth > MAX_JSON_DEPTH ) {
		throw validationError(
			'INVALID_PROPERTIES',
			path,
			'properties 超过允许的深度或节点数量。',
			value,
		);
	}
	if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) {
		return value;
	}
	if ( typeof value === 'number' ) {
		if ( ! Number.isFinite( value ) ) {
			throw validationError( 'INVALID_PROPERTIES', path, 'JSON number 必须有限。', value );
		}
		return Object.is( value, -0 ) ? 0 : value;
	}
	if ( typeof value !== 'object' ) {
		throw validationError(
			'INVALID_PROPERTIES',
			path,
			'properties 不允许 undefined、函数、symbol 或 bigint。',
			value,
		);
	}
	if ( seen.has( value ) ) {
		throw validationError( 'INVALID_PROPERTIES', path, 'properties 不允许循环引用。', value );
	}
	seen.add( value );
	if ( Array.isArray( value ) ) {
		const result = value.map( ( item, index ) => cloneJsonValue(
			item,
			`${ path }/${ index }`,
			depth + 1,
			seen,
			counter,
		) );
		seen.delete( value );
		return result;
	}
	const prototype = Object.getPrototypeOf( value );
	if ( prototype !== Object.prototype && prototype !== null ) {
		throw validationError(
			'INVALID_PROPERTIES',
			path,
			'properties 只接受普通对象，不接受类实例、Map、Set 或 DOM 对象。',
			value,
		);
	}
	const result: Record<string, JsonValue> = {};
	for ( const [ key, item ] of Object.entries( value ) ) {
		result[ normalizePropertiesRecordKey( key ) ] = cloneJsonValue(
			item,
			`${ path }/${ escapeJsonPointer( key ) }`,
			depth + 1,
			seen,
			counter,
		);
	}
	seen.delete( value );
	return result;
}

function optionalPositiveNumberProperty(
	record: Record<string, unknown>,
	key: string,
	path: string,
): Record<string, number> {
	if ( record[ key ] === undefined ) {
		return {};
	}
	return {
		[ key ]: expectPositiveNumber(
			record[ key ],
			`${ path }/${ key }`,
			key.startsWith( 'box' ) ? 'INVALID_STYLE' : 'INVALID_GEOMETRY',
		),
	};
}

function expectNullableArrowStyle(
	value: unknown,
	path: string,
): 'filledArrow' | 'unfilledArrow' | null {
	if ( value === null ) {
		return null;
	}
	return expectEnum(
		value,
		[ 'filledArrow', 'unfilledArrow' ] as const,
		path,
		'INVALID_STYLE',
	);
}

function expectRecord(
	value: unknown,
	path: string,
	code: string,
): Record<string, unknown> {
	if ( value === null || typeof value !== 'object' || Array.isArray( value ) ) {
		throw validationError( code, path, '必须提供普通对象。', value );
	}
	const prototype = Object.getPrototypeOf( value );
	if ( prototype !== Object.prototype && prototype !== null ) {
		throw validationError( code, path, '不接受类实例或带自定义原型的对象。', value );
	}
	return value as Record<string, unknown>;
}

function expectNonEmptyString( value: unknown, path: string, code: string ): string {
	if ( typeof value !== 'string' || value.trim().length === 0 ) {
		throw validationError( code, path, '必须是非空字符串。', value );
	}
	return value;
}

function expectBoolean( value: unknown, path: string, code: string ): boolean {
	if ( typeof value !== 'boolean' ) {
		throw validationError( code, path, '必须是 boolean。', value );
	}
	return value;
}

function expectFiniteNumber( value: unknown, path: string, code: string ): number {
	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) {
		throw validationError( code, path, '必须是有限 number。', value );
	}
	return Object.is( value, -0 ) ? 0 : value;
}

function expectPositiveNumber( value: unknown, path: string, code: string ): number {
	const result = expectFiniteNumber( value, path, code );
	if ( result <= 0 ) {
		throw validationError( code, path, '必须是大于 0 的 number。', value );
	}
	return result;
}

function expectNumberInRange(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
	exclusiveMinimum: boolean,
	code: string,
): number {
	const result = expectFiniteNumber( value, path, code );
	const below = exclusiveMinimum ? result <= minimum : result < minimum;
	if ( below || result > maximum || result === maximum && maximum === 360 && path.endsWith( 'startAngle' ) ) {
		throw validationError(
			code,
			path,
			`数值必须位于 ${ exclusiveMinimum ? '(' : '[' }${ minimum }, ${ maximum }${ path.endsWith( 'startAngle' ) ? ')' : ']' }。`,
			value,
		);
	}
	return result;
}

function expectSafeInteger(
	value: unknown,
	path: string,
	minimum: number,
	code: string,
): number {
	if ( ! Number.isSafeInteger( value ) || ( value as number ) < minimum ) {
		throw validationError( code, path, `必须是大于等于 ${ minimum } 的安全整数。`, value );
	}
	return value as number;
}

function expectEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	code: string,
): T {
	if ( typeof value !== 'string' || ! allowed.includes( value as T ) ) {
		throw validationError(
			code,
			path,
			`必须是以下值之一：${ allowed.join( '、' ) }。`,
			value,
		);
	}
	return value as T;
}

function parseHeightReferenceAt( value: unknown, path: string ): HeightReference {
	try {
		return parseHeightReference( value );
	} catch ( error ) {
		if ( error instanceof PlotEditorValidationError ) {
			throw new PlotEditorValidationError( {
				...error.diagnostic,
				path,
			} );
		}
		throw error;
	}
}

function validationError(
	code: string,
	path: string,
	message: string,
	value: unknown,
): PlotEditorValidationError {
	const diagnostic: EditorDiagnostic = {
		code,
		severity: 'error',
		message,
		path,
		valueSummary: summarizeDiagnosticValue( value ),
	};
	return new PlotEditorValidationError( diagnostic );
}

function escapeJsonPointer( value: string ): string {
	return value.replaceAll( '~', '~0' ).replaceAll( '/', '~1' );
}

function deepFreeze<T>( value: T ): T {
	if ( value !== null && typeof value === 'object' && ! Object.isFrozen( value ) ) {
		Object.freeze( value );
		for ( const nested of Object.values( value as Record<string, unknown> ) ) {
			deepFreeze( nested );
		}
	}
	return value;
}
