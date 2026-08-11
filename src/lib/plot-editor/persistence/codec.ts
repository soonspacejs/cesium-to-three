import {
	PlotEditorValidationError,
	type EditorDiagnostic,
	summarizeDiagnosticValue,
} from '../document/diagnostics';
import { getHeightReferenceName } from '../document/height-reference';
import { migrateLegacyPlotItem } from '../document/migrations';
import { createPlotDocumentStore } from '../document/PlotDocument';
import type {
	HeightReferenceName,
	JsonValue,
	PlotDocumentSnapshot,
	PlotFeature,
	PlotFeatureId,
} from '../document/types';
import { normalizeFeature } from '../document/validate';

export interface PlotCodecLimits {
	readonly maxBytes?: number;
	readonly maxDepth?: number;
	readonly maxNodes?: number;
	readonly maxFeatures?: number;
	readonly maxVertices?: number;
	readonly maxStringLength?: number;
}

export interface DecodePlotDocumentOptions {
	readonly limits?: PlotCodecLimits;
	readonly idGenerator?: () => PlotFeatureId;
}

export interface DecodePlotDocumentResult {
	readonly snapshot: PlotDocumentSnapshot;
	readonly diagnostics: readonly EditorDiagnostic[];
	readonly migrated: boolean;
}

export type TryDecodePlotDocumentResult =
	| ( { readonly ok: true } & DecodePlotDocumentResult )
	| { readonly ok: false; readonly diagnostics: readonly EditorDiagnostic[] };

export interface SerializedPlotFeatureV1 extends Omit<PlotFeature, 'heightReference'> {
	readonly heightReference: HeightReferenceName;
}

export interface SerializedPlotDocumentV1 {
	readonly schema: 'cesium-to-three/plot-document';
	readonly version: 1;
	readonly documentId: string;
	readonly revision: number;
	readonly features: readonly SerializedPlotFeatureV1[];
	readonly order: readonly PlotFeatureId[];
	readonly metadata?: Readonly<Record<string, JsonValue>>;
}

const DEFAULT_LIMITS = Object.freeze( {
	maxBytes: 16 * 1024 * 1024,
	maxDepth: 64,
	maxNodes: 250_000,
	maxFeatures: 10_000,
	maxVertices: 250_000,
	maxStringLength: 1_000_000,
} );

const FORBIDDEN_KEYS = new Set( [ '__proto__', 'prototype', 'constructor' ] );

/** 以固定顶层/feature 字段顺序和稳定 HeightReference 名称生成可持久对象。 */
export function encodePlotDocument(
	snapshot: PlotDocumentSnapshot,
): SerializedPlotDocumentV1 {
	const validated = decodeCanonicalDocument( snapshot, resolveLimits(), [] ).snapshot;
	const byId = new Map( validated.features.map( ( feature ) => [ feature.id, feature ] ) );
	const features = validated.order.map( ( id ) => serializeFeature(
		byId.get( id ) as PlotFeature,
	) );
	return Object.freeze( {
		schema: 'cesium-to-three/plot-document' as const,
		version: 1 as const,
		documentId: validated.documentId,
		revision: validated.revision,
		features: Object.freeze( features ),
		order: Object.freeze( [ ...validated.order ] ),
		...( validated.metadata === undefined ? {} : {
			metadata: canonicalJsonObject( validated.metadata ),
		} ),
	} );
}

export function stringifyPlotDocument(
	snapshot: PlotDocumentSnapshot,
	space?: number,
): string {
	const indentation = space === undefined ? 0 : Math.min( 10, Math.max( 0, space ) );
	return JSON.stringify( encodePlotDocument( snapshot ), null, indentation );
}

/** parse -> 安全限制 -> schema/migration -> 全量规范化；任何失败都不暴露半成品。 */
export function decodePlotDocument(
	input: unknown,
	options: DecodePlotDocumentOptions = {},
): DecodePlotDocumentResult {
	const limits = resolveLimits( options.limits );
	let parsed = input;
	if ( typeof input === 'string' ) {
		if ( utf8ByteLength( input ) > limits.maxBytes ) {
			throw codecError( 'INVALID_SCHEMA', '/','输入 JSON 超过 maxBytes。', input.length );
		}
		try {
			parsed = JSON.parse( input ) as unknown;
		} catch ( error ) {
			throw codecError(
				'INVALID_SCHEMA', '/',
				error instanceof Error ? `JSON 解析失败：${ error.message }` : 'JSON 解析失败。',
				input.slice( 0, 80 ),
			);
		}
	}
	assertSafeTree( parsed, limits );
	if ( typeof input !== 'string' && estimateJsonBytes( parsed ) > limits.maxBytes ) {
		throw codecError( 'INVALID_SCHEMA', '/', '输入对象超过 maxBytes。', parsed );
	}
	const diagnostics: EditorDiagnostic[] = [];
	if ( isCanonicalEnvelope( parsed ) ) {
		return decodeCanonicalDocument( parsed, limits, diagnostics );
	}
	if ( hasCanonicalSchema( parsed ) ) {
		const record = parsed as Record<string, unknown>;
		throw codecError(
			'UNSUPPORTED_VERSION', '/version',
			'不支持该 plot-document version。', record.version,
		);
	}
	return decodeLegacyDocument( parsed, limits, diagnostics, options.idGenerator );
}

export function tryDecodePlotDocument(
	input: unknown,
	options: DecodePlotDocumentOptions = {},
): TryDecodePlotDocumentResult {
	try {
		return Object.freeze( { ok: true as const, ...decodePlotDocument( input, options ) } );
	} catch ( error ) {
		const diagnostic = error instanceof PlotEditorValidationError
			? error.diagnostic
			: Object.freeze( {
				code: 'INVALID_SCHEMA', severity: 'error' as const,
				message: error instanceof Error ? error.message : '文档解码失败。',
			} );
		return Object.freeze( {
			ok: false as const,
			diagnostics: Object.freeze( [ diagnostic ] ),
		} );
	}
}

interface ResolvedCodecLimits {
	readonly maxBytes: number;
	readonly maxDepth: number;
	readonly maxNodes: number;
	readonly maxFeatures: number;
	readonly maxVertices: number;
	readonly maxStringLength: number;
}

function decodeCanonicalDocument(
	input: unknown,
	limits: ResolvedCodecLimits,
	diagnostics: EditorDiagnostic[],
): DecodePlotDocumentResult {
	const record = expectRecord( input, '/' );
	if ( record.schema !== 'cesium-to-three/plot-document' ) {
		throw codecError( 'INVALID_SCHEMA', '/schema', 'schema 必须是 cesium-to-three/plot-document。', record.schema );
	}
	if ( record.version !== 1 ) {
		throw codecError( 'UNSUPPORTED_VERSION', '/version', '只支持 plot-document version 1。', record.version );
	}
	if ( ! Array.isArray( record.features ) ) {
		throw codecError( 'INVALID_SCHEMA', '/features', 'features 必须是数组。', record.features );
	}
	if ( record.features.length > limits.maxFeatures ) {
		throw codecError( 'INVALID_SCHEMA', '/features', 'feature 数超过 maxFeatures。', record.features.length );
	}
	let vertexCount = 0;
	const features = record.features.map( ( raw, index ) => {
		assertCanonicalTriples( raw, `/features/${ index }` );
		const feature = normalizeFeature( raw, {
			path: `/features/${ index }`,
			clampHeightPolicy: 'reject',
		} );
		vertexCount += countFeatureVertices( feature );
		if ( vertexCount > limits.maxVertices ) {
			throw codecError( 'INVALID_SCHEMA', '/features', '顶点总数超过 maxVertices。', vertexCount );
		}
		return feature;
	} );
	if ( ! Array.isArray( record.order ) ) {
		throw codecError( 'INVALID_SCHEMA', '/order', 'order 必须是 feature id 数组。', record.order );
	}
	const store = createPlotDocumentStore( {
		id: record.documentId as string,
		revision: record.revision as number,
		features,
		order: record.order as PlotFeatureId[],
		...( record.metadata === undefined ? {} : {
			metadata: record.metadata as Record<string, JsonValue>,
		} ),
	} );
	return Object.freeze( {
		snapshot: store.snapshot(),
		diagnostics: Object.freeze( diagnostics.map( freezeDiagnostic ) ),
		migrated: false,
	} );
}

function decodeLegacyDocument(
	input: unknown,
	limits: ResolvedCodecLimits,
	diagnostics: EditorDiagnostic[],
	idGenerator?: () => PlotFeatureId,
): DecodePlotDocumentResult {
	const record = Array.isArray( input ) ? null : expectRecord( input, '/' );
	if ( record?.schema !== undefined && record.schema !== 'cesium-to-three/plot' ) {
		throw codecError( 'INVALID_SCHEMA', '/schema', '未知的 plot schema。', record.schema );
	}
	if ( record?.version !== undefined && record.version !== 1 ) {
		throw codecError( 'UNSUPPORTED_VERSION', '/version', '不支持该旧 plot version。', record.version );
	}
	const items = Array.isArray( input ) ? input : record?.items;
	if ( ! Array.isArray( items ) ) {
		throw codecError( 'INVALID_SCHEMA', '/items', '旧格式必须是 item 数组或包含 items。', items );
	}
	if ( items.length > limits.maxFeatures ) {
		throw codecError( 'INVALID_SCHEMA', '/items', 'feature 数超过 maxFeatures。', items.length );
	}
	let nextId = 1;
	const generate = idGenerator ?? ( () => `imported-${ nextId++ }` );
	const features: PlotFeature[] = [];
	let vertexCount = 0;
	for ( let index = 0; index < items.length; index++ ) {
		const migrated = migrateLegacyPlotItem( items[ index ], {
			idGenerator: generate,
			itemIndex: index,
		} );
		features.push( migrated.feature );
		diagnostics.push( ...migrated.diagnostics );
		vertexCount += countFeatureVertices( migrated.feature );
		if ( vertexCount > limits.maxVertices ) {
			throw codecError( 'INVALID_SCHEMA', '/items', '顶点总数超过 maxVertices。', vertexCount );
		}
	}
	const documentId = typeof record?.documentId === 'string'
		? record.documentId
		: 'migrated-plot-document';
	const store = createPlotDocumentStore( {
		id: documentId,
		features,
		order: features.map( ( feature ) => feature.id ),
	} );
	return Object.freeze( {
		snapshot: store.snapshot(),
		diagnostics: Object.freeze( diagnostics.map( freezeDiagnostic ) ),
		migrated: true,
	} );
}

function serializeFeature( feature: PlotFeature ): SerializedPlotFeatureV1 {
	return Object.freeze( {
		id: feature.id,
		type: feature.type,
		geometry: canonicalJsonObject( feature.geometry ) as PlotFeature[ 'geometry' ],
		style: canonicalJsonObject( feature.style ) as PlotFeature[ 'style' ],
		heightReference: getHeightReferenceName( feature.heightReference ),
		visible: feature.visible,
		properties: canonicalJsonObject( feature.properties ),
		revision: feature.revision,
	} ) as SerializedPlotFeatureV1;
}

function assertCanonicalTriples( raw: unknown, path: string ): void {
	const record = expectRecord( raw, path );
	const type = record.type;
	const geometry = expectRecord( record.geometry, `${ path }/geometry` );
	const positions = type === 'point' || type === 'text'
		? [ geometry.position ]
		: type === 'circle' || type === 'sector'
			? [ geometry.center ]
			: geometry.positions;
	if ( ! Array.isArray( positions ) ) {
		throw codecError( 'INVALID_SCHEMA', `${ path }/geometry`, '几何坐标缺失。', positions );
	}
	for ( let index = 0; index < positions.length; index++ ) {
		const position = positions[ index ];
		if ( ! Array.isArray( position ) || position.length !== 3 ) {
			throw codecError(
				'INVALID_COORDINATE', `${ path }/geometry/positions/${ index }`,
				'正式 v1 文档只接受三元坐标。', position,
			);
		}
	}
}

function countFeatureVertices( feature: PlotFeature ): number {
	switch ( feature.type ) {
		case 'point':
		case 'text':
		case 'circle':
		case 'sector': return 1;
		case 'line':
		case 'polygon':
		case 'rectangle':
		case 'arrow': return feature.geometry.positions.length;
	}
}

function assertSafeTree( input: unknown, limits: ResolvedCodecLimits ): void {
	let nodes = 0;
	const ancestors = new Set<object>();
	const visit = ( value: unknown, path: string, depth: number ): void => {
		nodes++;
		if ( nodes > limits.maxNodes ) throw codecError( 'INVALID_SCHEMA', path, '输入节点数超过 maxNodes。', nodes );
		if ( depth > limits.maxDepth ) throw codecError( 'INVALID_SCHEMA', path, '输入嵌套深度超过 maxDepth。', depth );
		if ( typeof value === 'string' ) {
			if ( value.length > limits.maxStringLength ) {
				throw codecError( 'INVALID_SCHEMA', path, '字符串超过 maxStringLength。', value.length );
			}
			return;
		}
		if ( typeof value === 'number' && ! Number.isFinite( value ) ) {
			throw codecError( 'INVALID_SCHEMA', path, '文档不允许 NaN/Infinity。', value );
		}
		if ( value === null || typeof value !== 'object' ) return;
		if ( ancestors.has( value ) ) throw codecError( 'INVALID_SCHEMA', path, '文档不允许循环引用。', value );
		ancestors.add( value );
		if ( Array.isArray( value ) ) {
			value.forEach( ( child, index ) => visit( child, `${ path }/${ index }`, depth + 1 ) );
		} else {
			for ( const [ key, child ] of Object.entries( value ) ) {
				if ( key.length > limits.maxStringLength ) {
					throw codecError( 'INVALID_SCHEMA', path, '字段名超过 maxStringLength。', key.length );
				}
				if ( FORBIDDEN_KEYS.has( key ) ) {
					throw codecError( 'INVALID_PROPERTIES', `${ path }/${ key }`, '拒绝原型污染键。', key );
				}
				visit( child, `${ path }/${ escapeJsonPointer( key ) }`, depth + 1 );
			}
		}
		ancestors.delete( value );
	};
	visit( input, '', 0 );
}

/** 对已经通过安全树检查的对象估算其紧凑 JSON UTF-8 字节数，不触发 toJSON。 */
function estimateJsonBytes( value: unknown ): number {
	if ( value === null ) return 4;
	switch ( typeof value ) {
		case 'string': return utf8ByteLength( JSON.stringify( value ) );
		case 'number': return Number.isFinite( value )
			? utf8ByteLength( JSON.stringify( value ) )
			: 4;
		case 'boolean': return value ? 4 : 5;
		case 'bigint': return utf8ByteLength( value.toString() );
		case 'undefined':
		case 'function':
		case 'symbol': return 4;
		case 'object': {
			if ( Array.isArray( value ) ) {
				return 2 + Math.max( 0, value.length - 1 )
					+ value.reduce( ( total, child ) => total + estimateJsonBytes( child ), 0 );
			}
			const entries = Object.entries( value );
			return 2 + Math.max( 0, entries.length - 1 ) + entries.reduce(
				( total, [ key, child ] ) => total
					+ utf8ByteLength( JSON.stringify( key ) )
					+ 1
					+ estimateJsonBytes( child ),
				0,
			);
		}
	}
	return 0;
}

function canonicalJsonObject<T extends object>( value: T ): Readonly<T> {
	return canonicalJsonValue( value ) as Readonly<T>;
}

function canonicalJsonValue( value: unknown ): unknown {
	if ( Array.isArray( value ) ) return Object.freeze( value.map( canonicalJsonValue ) );
	if ( value !== null && typeof value === 'object' ) {
		const output: Record<string, unknown> = Object.create( null ) as Record<string, unknown>;
		for ( const key of Object.keys( value ).sort() ) {
			output[ key ] = canonicalJsonValue( ( value as Record<string, unknown> )[ key ] );
		}
		return Object.freeze( output );
	}
	return value;
}

function resolveLimits( input: PlotCodecLimits = {} ): ResolvedCodecLimits {
	const result = { ...DEFAULT_LIMITS, ...input };
	for ( const [ name, value ] of Object.entries( result ) ) {
		if ( ! Number.isSafeInteger( value ) || value <= 0 ) {
			throw new RangeError( `${ name } 必须是正安全整数。` );
		}
	}
	return result;
}

function isCanonicalEnvelope( value: unknown ): boolean {
	return hasCanonicalSchema( value ) && ( value as Record<string, unknown> ).version === 1;
}

function hasCanonicalSchema( value: unknown ): boolean {
	return value !== null && typeof value === 'object' && ! Array.isArray( value )
		&& ( value as Record<string, unknown> ).schema === 'cesium-to-three/plot-document';
}

function expectRecord( value: unknown, path: string ): Record<string, unknown> {
	if ( value === null || typeof value !== 'object' || Array.isArray( value ) ) {
		throw codecError( 'INVALID_SCHEMA', path, '必须是对象。', value );
	}
	return value as Record<string, unknown>;
}

function codecError(
	code: string,
	path: string,
	message: string,
	value: unknown,
): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code,
		severity: 'error',
		message,
		path,
		valueSummary: summarizeDiagnosticValue( value ),
	} );
}

function freezeDiagnostic( value: EditorDiagnostic ): EditorDiagnostic {
	return Object.freeze( { ...value } );
}

function escapeJsonPointer( value: string ): string {
	return value.replace( /~/g, '~0' ).replace( /\//g, '~1' );
}

function utf8ByteLength( value: string ): number {
	return new TextEncoder().encode( value ).byteLength;
}
