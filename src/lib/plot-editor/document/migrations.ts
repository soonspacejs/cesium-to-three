import { ClassificationType } from '../../ground/types';
import {
	PlotEditorValidationError,
	type EditorDiagnostic,
	summarizeDiagnosticValue,
} from './diagnostics';
import {
	getClassificationType,
	parseHeightReference,
} from './height-reference';
import { normalizeFeature } from './validate';
import {
	HeightReference,
	type PlotFeature,
	type PlotFeatureType,
} from './types';

export interface LegacyMigrationOptions {
	readonly idGenerator: () => string;
	readonly itemIndex?: number;
	/** 默认拒绝新旧高度字段冲突；显式 prefer-height-reference 只用于人工修复工具。 */
	readonly heightConflictPolicy?: 'reject' | 'prefer-height-reference';
}

export interface LegacyMigrationResult {
	readonly feature: PlotFeature;
	readonly diagnostics: readonly EditorDiagnostic[];
}

const DEFAULT_STYLE = Object.freeze( {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
} );

/**
 * 将旧 `{ type, options }` 快照或扁平旧对象迁移为 canonical PlotFeature。
 * 迁移只在 codec/API 边界调用，返回后不会残留二维坐标或旧高度字段。
 */
export function migrateLegacyPlotItem(
	input: unknown,
	options: LegacyMigrationOptions,
): LegacyMigrationResult {
	const index = options.itemIndex ?? 0;
	const path = `/items/${ index }`;
	const outer = expectRecord( input, path );
	const type = expectFeatureType( outer.type, `${ path }/type` );
	const legacy = outer.options === undefined
		? outer
		: expectRecord( outer.options, `${ path }/options` );
	const diagnostics: EditorDiagnostic[] = [ {
		code: 'LEGACY_INPUT_MIGRATED',
		severity: 'deprecated',
		message: '旧 plot 数据已迁移为 version 1 canonical feature。',
		path,
	} ];
	const id = resolveId( outer, legacy, path, options.idGenerator, diagnostics );
	const heightReference = resolveLegacyHeightReference(
		legacy,
		path,
		options.heightConflictPolicy ?? 'reject',
		diagnostics,
	);
	const points = migrateLegacyPoints(
		legacy.points,
		legacy.heightMeters,
		heightReference,
		`${ path }/options/points`,
		diagnostics,
	);
	const candidate = {
		id,
		type,
		geometry: createGeometry( type, points, legacy, `${ path }/options` ),
		style: createStyle( type, legacy ),
		heightReference,
		visible: legacy.visible === undefined ? true : legacy.visible,
		properties: legacy.properties ?? {},
		revision: 0,
	};
	const feature = normalizeFeature( candidate, {
		path,
		onDiagnostic: ( diagnostic ) => diagnostics.push( diagnostic ),
	} );
	return Object.freeze( {
		feature,
		diagnostics: Object.freeze( diagnostics.map( ( diagnostic ) => Object.freeze( {
			...diagnostic,
		} ) ) ),
	} );
}

function resolveLegacyHeightReference(
	legacy: Record<string, unknown>,
	path: string,
	conflictPolicy: 'reject' | 'prefer-height-reference',
	diagnostics: EditorDiagnostic[],
): HeightReference {
	const inferred = inferHeightReferenceFromLegacyFields( legacy, path );
	if ( legacy.heightReference === undefined ) {
		diagnostics.push( {
			code: 'LEGACY_HEIGHT_REFERENCE_INFERRED',
			severity: 'deprecated',
			message: '已从 clampToGround 与 classificationType 推导显式 heightReference。',
			path: `${ path }/options/heightReference`,
		} );
		return inferred;
	}
	const explicit = parseHeightReference( legacy.heightReference );
	const hasLegacySignal = legacy.clampToGround !== undefined
		|| legacy.classificationType !== undefined;
	if ( hasLegacySignal && explicit !== inferred ) {
		if ( conflictPolicy === 'reject' ) {
			throw migrationError(
				`${ path }/options/heightReference`,
				'heightReference 与旧 clampToGround/classificationType 语义冲突。',
				legacy.heightReference,
				'INVALID_HEIGHT_REFERENCE',
			);
		}
		diagnostics.push( {
			code: 'LEGACY_HEIGHT_REFERENCE_CONFLICT_IGNORED',
			severity: 'warning',
			message: '人工修复策略保留了 heightReference，并忽略冲突的旧高度字段。',
			path: `${ path }/options/heightReference`,
		} );
	}
	return explicit;
}

function inferHeightReferenceFromLegacyFields(
	legacy: Record<string, unknown>,
	path: string,
): HeightReference {
	if ( legacy.clampToGround !== undefined && typeof legacy.clampToGround !== 'boolean' ) {
		throw migrationError(
			`${ path }/options/clampToGround`,
			'clampToGround 必须是 boolean。',
			legacy.clampToGround,
			'INVALID_HEIGHT_REFERENCE',
		);
	}
	if ( legacy.clampToGround === false ) {
		return HeightReference.NONE;
	}
	switch ( parseLegacyClassificationType( legacy.classificationType, path ) ) {
		case ClassificationType.TERRAIN:
			return HeightReference.CLAMP_TO_TERRAIN;
		case ClassificationType.CESIUM_3D_TILE:
			return HeightReference.CLAMP_TO_3D_TILE;
		case ClassificationType.BOTH:
			return HeightReference.CLAMP_TO_GROUND;
	}
}

function parseLegacyClassificationType(
	value: unknown,
	path: string,
): ClassificationType {
	if ( value === undefined || value === ClassificationType.BOTH || value === 'BOTH' ) {
		return ClassificationType.BOTH;
	}
	if ( value === ClassificationType.TERRAIN || value === 'TERRAIN' ) {
		return ClassificationType.TERRAIN;
	}
	if ( value === ClassificationType.CESIUM_3D_TILE || value === 'CESIUM_3D_TILE' ) {
		return ClassificationType.CESIUM_3D_TILE;
	}
	throw migrationError(
		`${ path }/options/classificationType`,
		'未知的旧 classificationType。',
		value,
		'INVALID_HEIGHT_REFERENCE',
	);
}

function migrateLegacyPoints(
	input: unknown,
	heightMeters: unknown,
	heightReference: HeightReference,
	path: string,
	diagnostics: EditorDiagnostic[],
): unknown[] {
	if ( ! Array.isArray( input ) ) {
		throw migrationError( path, '旧 points 必须是数组。', input, 'INVALID_COORDINATE' );
	}
	let legacyHeight: number | undefined;
	if ( heightMeters !== undefined ) {
		if ( typeof heightMeters !== 'number' || ! Number.isFinite( heightMeters ) ) {
			throw migrationError(
				path.replace( /\/points$/, '/heightMeters' ),
				'旧 heightMeters 必须是有限 number。',
				heightMeters,
				'INVALID_COORDINATE',
			);
		}
		legacyHeight = heightMeters;
		diagnostics.push( {
			code: 'LEGACY_HEIGHT_METERS_MIGRATED',
			severity: 'deprecated',
			message: heightReference === HeightReference.NONE
				? '旧图形级 heightMeters 已迁移到每个二维点的第三维。'
				: '贴附图形忽略旧 heightMeters，作者高度保持 0。',
			path: path.replace( /\/points$/, '/heightMeters' ),
		} );
	}
	let convertedTwoDimensional = false;
	const result = input.map( ( point, pointIndex ) => {
		if ( ! Array.isArray( point ) ) {
			throw migrationError(
				`${ path }/${ pointIndex }`,
				'旧 point 必须是二维或三维数组。',
				point,
				'INVALID_COORDINATE',
			);
		}
		if ( point.length === 2 ) {
			convertedTwoDimensional = true;
			const height = heightReference === HeightReference.NONE && legacyHeight !== undefined
				? legacyHeight
				: 0;
			return [ point[ 0 ], point[ 1 ], height ];
		}
		return [ ...point ];
	} );
	if ( convertedTwoDimensional ) {
		diagnostics.push( {
			code: 'LEGACY_2D_POSITION_MIGRATED',
			severity: 'deprecated',
			message: '二维坐标已在迁移边界补齐第三维。',
			path,
		} );
	}
	return result;
}

function createGeometry(
	type: PlotFeatureType,
	points: unknown[],
	legacy: Record<string, unknown>,
	path: string,
): Record<string, unknown> {
	switch ( type ) {
		case 'point':
		case 'text':
			return { position: requireFirstPoint( points, path ) };
		case 'circle':
			return { center: requireFirstPoint( points, path ), radius: legacy.radius };
		case 'sector':
			return {
				center: requireFirstPoint( points, path ),
				radius: legacy.radius,
				startAngle: legacy.startAngle,
				sectorAngle: legacy.sectorAngle,
			};
		case 'line':
		case 'polygon':
		case 'rectangle':
			return { positions: points };
		case 'arrow':
			return {
				positions: points,
				arrowType: legacy.arrowType,
				sizeScale: legacy.sizeScale ?? 1,
				curvedBodyWidthFactor: legacy.curvedBodyWidthFactor,
				curvedHeadWidthFactor: legacy.curvedHeadWidthFactor,
				curvedHeadLengthFactor: legacy.curvedHeadLengthFactor,
			};
	}
}

function createStyle(
	type: PlotFeatureType,
	legacy: Record<string, unknown>,
): Record<string, unknown> {
	const common = {
		strokeColor: legacy.strokeColor ?? DEFAULT_STYLE.strokeColor,
		strokeWidth: legacy.strokeWidth ?? DEFAULT_STYLE.strokeWidth,
		strokeOpacity: legacy.strokeOpacity ?? DEFAULT_STYLE.strokeOpacity,
		fillColor: legacy.fillColor ?? DEFAULT_STYLE.fillColor,
		fillOpacity: legacy.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
	};
	if ( type === 'point' ) {
		const pointStyle = legacy.pointStyle ?? 'circle';
		return pointStyle === 'image'
			? {
				...common,
				pointStyle,
				imageUrl: legacy.imageUrl,
				imageWidth: legacy.imageWidth,
				imageHeight: legacy.imageHeight,
				rotation: legacy.rotation ?? 0,
			}
			: { ...common, pointStyle, size: legacy.size ?? 16 };
	}
	if ( type === 'line' ) {
		return {
			...common,
			strokeStyle: legacy.strokeStyle ?? 'solid',
			showArrow: legacy.showArrow ?? false,
			startArrowStyle: legacy.startArrowStyle ?? null,
			endArrowStyle: legacy.endArrowStyle ?? null,
		};
	}
	if ( type === 'text' ) {
		return {
			...common,
			content: legacy.content,
			fontColor: legacy.fontColor ?? '#000000',
			fontSize: legacy.fontSize ?? 24,
			scale: legacy.scale ?? 1,
			textAlign: legacy.textAlign ?? 'left',
			verticalAlign: legacy.verticalAlign ?? 'middle',
			anchorX: legacy.anchorX ?? 'center',
			anchorY: legacy.anchorY ?? 'middle',
			boxWidth: legacy.boxWidth,
			boxHeight: legacy.boxHeight,
			padding: legacy.padding ?? 0,
			layoutDirection: legacy.layoutDirection ?? 'horizontal',
			rotation: legacy.rotation ?? 0,
			offsetX: legacy.offsetX ?? 0,
			offsetY: legacy.offsetY ?? 0,
			showBorder: legacy.showBorder ?? false,
		};
	}
	return common;
}

function resolveId(
	outer: Record<string, unknown>,
	legacy: Record<string, unknown>,
	path: string,
	idGenerator: () => string,
	diagnostics: EditorDiagnostic[],
): string {
	const candidate = outer.id ?? legacy.id;
	if ( candidate !== undefined ) {
		if ( typeof candidate !== 'string' || candidate.trim().length === 0 ) {
			throw migrationError( `${ path }/id`, '旧 id 必须是非空字符串。', candidate, 'INVALID_SCHEMA' );
		}
		return candidate;
	}
	const generated = idGenerator();
	if ( typeof generated !== 'string' || generated.trim().length === 0 ) {
		throw migrationError( `${ path }/id`, 'idGenerator 必须返回非空字符串。', generated, 'INVALID_SCHEMA' );
	}
	diagnostics.push( {
		code: 'LEGACY_ID_GENERATED',
		severity: 'warning',
		message: '旧数据缺少稳定 id，导入器已生成新 id。',
		path: `${ path }/id`,
	} );
	return generated;
}

function requireFirstPoint( points: unknown[], path: string ): unknown {
	if ( points.length === 0 ) {
		throw migrationError( `${ path }/points`, '该图形至少需要一个坐标。', points, 'INVALID_GEOMETRY' );
	}
	return points[ 0 ];
}

function expectRecord( value: unknown, path: string ): Record<string, unknown> {
	if ( value === null || typeof value !== 'object' || Array.isArray( value ) ) {
		throw migrationError( path, '旧 plot item 必须是对象。', value, 'INVALID_SCHEMA' );
	}
	return value as Record<string, unknown>;
}

function expectFeatureType( value: unknown, path: string ): PlotFeatureType {
	if ( value === 'point' || value === 'line' || value === 'polygon'
		|| value === 'rectangle' || value === 'sector' || value === 'arrow'
		|| value === 'text' || value === 'circle' ) {
		return value;
	}
	throw migrationError(
		path,
		'旧数据包含不支持的图形类型；model 和 tileset 不能迁移为 GIS 图形。',
		value,
		'UNSUPPORTED_GRAPHICS_KIND',
	);
}

function migrationError(
	path: string,
	message: string,
	value: unknown,
	code: string,
): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code,
		severity: 'error',
		message,
		path,
		valueSummary: summarizeDiagnosticValue( value ),
	} );
}

/** 供迁移测试和渲染 adapter 核对旧分类映射。 */
export function legacyClassificationForHeightReference(
	heightReference: HeightReference,
): ClassificationType | undefined {
	return getClassificationType( heightReference );
}
