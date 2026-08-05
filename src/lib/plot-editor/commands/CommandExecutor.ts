import type { PlotDocumentStore } from '../document/PlotDocument';
import {
	PlotEditorValidationError,
	type EditorDiagnostic,
} from '../document/diagnostics';
import { normalizePosition } from '../document/normalize';
import { normalizeFeature } from '../document/validate';
import type {
	ArrowFeature,
	LineFeature,
	PlotFeature,
	PlotFeatureId,
	PlotDocumentSnapshot,
	PolygonFeature,
	Position3D,
	VertexId,
} from '../document/types';
import type {
	CommandResult,
	EditorCommand,
	EditorError,
	FeatureTransform,
	PlotPatch,
} from './types';

export interface CommandExecutorOptions {
	readonly transformFeature?: FeatureTransform;
}

/** 创建当前 snapshot 内稳定、可读的顶点身份。 */
export function createVertexId( index: number ): VertexId {
	if ( ! Number.isSafeInteger( index ) || index < 0 ) {
		throw new RangeError( 'vertex index 必须是非负安全整数。' );
	}
	return `vertex:${ index }`;
}

export function parseVertexId( id: VertexId ): number {
	if ( typeof id !== 'string' || ! /^vertex:\d+$/.test( id ) ) {
		throw commandValidationError( 'INVALID_COMMAND', '顶点 id 格式必须为 vertex:<index>。' );
	}
	const index = Number( id.slice( 'vertex:'.length ) );
	if ( ! Number.isSafeInteger( index ) ) {
		throw commandValidationError( 'INVALID_COMMAND', '顶点索引超出安全整数范围。' );
	}
	return index;
}

/** 全量预验证并原子提交文档命令。 */
export class CommandExecutor {
	private readonly _document: PlotDocumentStore;
	private readonly _transformFeature?: FeatureTransform;
	private _executing = false;
	private _disposed = false;

	public constructor(
		document: PlotDocumentStore,
		options: CommandExecutorOptions = {},
	) {
		this._document = document;
		this._transformFeature = options.transformFeature;
	}

	public execute( command: EditorCommand ): CommandResult {
		if ( this._disposed ) {
			return this._failure( 'EDITOR_DISPOSED', '命令执行器已经销毁。' );
		}
		if ( this._executing ) {
			return this._failure( 'REENTRANT_COMMAND', '同一次命令 dispatch 中不允许重入写操作。' );
		}
		this._executing = true;
		try {
			return this._executeAtomic( command );
		} catch ( error ) {
			return this._fromThrownError( error );
		} finally {
			this._executing = false;
		}
	}

	public dispose(): void {
		this._disposed = true;
	}

	private _executeAtomic( command: EditorCommand ): CommandResult {
		const current = this._document.getAll() as readonly PlotFeature[];
		const order = current.map( ( feature ) => feature.id );
		const diagnostics: EditorDiagnostic[] = [];
		let next: readonly PlotFeature[];
		let nextOrder: readonly PlotFeatureId[] = order;
		let affectedIds: readonly PlotFeatureId[];
		let nextMetadata: PlotDocumentSnapshot[ 'metadata' ] | undefined;

		switch ( command.type ) {
			case 'feature.add': {
				const candidate = normalizeFeature( command.feature, {
					path: '/command/feature',
					onDiagnostic: ( diagnostic ) => diagnostics.push( diagnostic ),
				} );
				if ( this._document.has( candidate.id ) ) {
					throw commandValidationError( 'ID_CONFLICT', `feature id 已存在：${ candidate.id }。` );
				}
				next = [ ...current, candidate ];
				nextOrder = [ ...order, candidate.id ];
				affectedIds = [ candidate.id ];
				break;
			}
			case 'feature.remove': {
				const ids = uniqueIds( command.ids );
				if ( ids.length === 0 ) {
					return this._success( false, [], diagnostics );
				}
				assertFeaturesExist( this._document, ids );
				const removed = new Set( ids );
				next = current.filter( ( feature ) => ! removed.has( feature.id ) );
				nextOrder = order.filter( ( id ) => ! removed.has( id ) );
				affectedIds = ids;
				break;
			}
			case 'feature.patch': {
				const before = requireFeature( this._document, command.id );
				assertRevision( before, command.beforeRevision );
				const patched = patchFeature( before, command.patch, diagnostics );
				next = replaceFeatures( current, new Map( [ [ before.id, patched ] ] ) );
				affectedIds = [ before.id ];
				break;
			}
			case 'feature.transform': {
				if ( this._transformFeature === undefined ) {
					throw commandValidationError(
						'UNSUPPORTED_TRANSFORM',
						'当前 CommandExecutor 未配置 ENU feature transform 策略。',
					);
				}
				const ids = uniqueIds( command.ids );
				if ( ids.length === 0 ) {
					return this._success( false, [], diagnostics );
				}
				assertFeaturesExist( this._document, ids );
				const replacements = new Map<PlotFeatureId, PlotFeature>();
				for ( const id of ids ) {
					const before = requireFeature( this._document, id );
					const expectedRevision = command.beforeRevisions?.[ id ];
					if ( expectedRevision !== undefined ) {
						assertRevision( before, expectedRevision );
					}
					const transformed = this._transformFeature( before, command.transform );
					if ( transformed.id !== before.id || transformed.type !== before.type ) {
						throw commandValidationError(
							'INVALID_COMMAND',
							'transform 策略不得改变 feature id 或 type。',
						);
					}
					replacements.set( id, normalizeFeature( {
						...transformed,
						revision: before.revision + 1,
					}, { path: `/command/features/${ id }` } ) );
				}
				next = replaceFeatures( current, replacements );
				affectedIds = ids;
				break;
			}
			case 'vertex.insert':
			case 'vertex.remove': {
				const before = requireFeature( this._document, command.id );
				assertRevision( before, command.beforeRevision );
				const patched = command.type === 'vertex.insert'
					? insertVertex( before, command.after, command.position )
					: removeVertex( before, command.vertex );
				next = replaceFeatures( current, new Map( [ [ before.id, patched ] ] ) );
				affectedIds = [ before.id ];
				break;
			}
			case 'document.replace': {
				if ( command.snapshot.schema !== 'cesium-to-three/plot-document'
					|| command.snapshot.version !== 1 ) {
					throw commandValidationError( 'INVALID_SCHEMA', '只能替换为 plot-document version 1。' );
				}
				if ( command.snapshot.documentId !== this._document.id ) {
					throw commandValidationError( 'INVALID_SCHEMA', 'document.replace 不得改变 documentId。' );
				}
				next = command.snapshot.features;
				nextOrder = command.snapshot.order;
				nextMetadata = command.snapshot.metadata ?? Object.freeze( {} );
				affectedIds = [ ...new Set( [ ...order, ...nextOrder ] ) ];
				break;
			}
			default:
				throw commandValidationError( 'INVALID_COMMAND', '未知 editor command。' );
		}

		const changed = this._document.commitCandidate( {
			features: next,
			order: nextOrder,
			label: commandLabel( command ),
			commandType: command.type,
			affectedIds,
			...( nextMetadata === undefined ? {} : { metadata: nextMetadata } ),
		} );
		return this._success( changed, affectedIds, diagnostics );
	}

	private _success(
		changed: boolean,
		affectedIds: readonly PlotFeatureId[],
		diagnostics: readonly EditorDiagnostic[],
	): CommandResult {
		return Object.freeze( {
			ok: true,
			changed,
			revision: this._document.revision,
			affectedIds: Object.freeze( [ ...affectedIds ] ),
			...( diagnostics.length > 0
				? { diagnostics: Object.freeze( [ ...diagnostics ] ) }
				: {} ),
		} );
	}

	private _failure( code: string, message: string, path?: string ): CommandResult {
		const error: EditorError = Object.freeze( { code, message, ...( path ? { path } : {} ) } );
		return Object.freeze( {
			ok: false,
			changed: false,
			revision: this._document.revision,
			affectedIds: Object.freeze( [] ),
			error,
		} );
	}

	private _fromThrownError( error: unknown ): CommandResult {
		if ( error instanceof PlotEditorValidationError ) {
			return this._failure(
				error.diagnostic.code,
				error.diagnostic.message,
				error.diagnostic.path,
			);
		}
		return this._failure(
			'INVALID_COMMAND',
			error instanceof Error ? error.message : '命令执行失败。',
		);
	}
}

function patchFeature(
	before: PlotFeature,
	patch: PlotPatch,
	diagnostics: EditorDiagnostic[],
): PlotFeature {
	if ( patch === null || typeof patch !== 'object' || Array.isArray( patch ) ) {
		throw commandValidationError( 'INVALID_COMMAND', 'feature.patch 必须提供对象 patch。' );
	}
	const candidate = {
		...before,
		...( patch.heightReference === undefined ? {} : { heightReference: patch.heightReference } ),
		...( patch.visible === undefined ? {} : { visible: patch.visible } ),
		...( patch.properties === undefined ? {} : { properties: patch.properties } ),
		geometry: patch.geometry === undefined
			? before.geometry
			: { ...before.geometry, ...patch.geometry },
		style: patch.style === undefined
			? before.style
			: { ...before.style, ...patch.style },
		revision: before.revision + 1,
	};
	return normalizeFeature( candidate, {
		path: `/features/${ before.id }`,
		onDiagnostic: ( diagnostic ) => diagnostics.push( diagnostic ),
	} );
}

function insertVertex(
	before: PlotFeature,
	after: VertexId,
	positionInput: readonly number[],
): PlotFeature {
	const positions = editablePositions( before );
	if ( before.type === 'rectangle' ) {
		throw commandValidationError( 'INVALID_COMMAND', '矩形不允许插入第五个顶点。' );
	}
	if ( before.type === 'arrow'
		&& ( before.geometry.arrowType === 'fine'
			|| before.geometry.arrowType === 'assaultDirection' ) ) {
		throw commandValidationError( 'INVALID_COMMAND', '二点箭头不允许插入控制点。' );
	}
	const index = parseVertexId( after );
	if ( index < 0 || index >= positions.length ) {
		throw commandValidationError( 'INVALID_COMMAND', 'after 顶点不存在。' );
	}
	const position = normalizePosition(
		positionInput as never,
		before.heightReference,
		{ path: '/command/position' },
	);
	const nextPositions = [
		...positions.slice( 0, index + 1 ),
		position,
		...positions.slice( index + 1 ),
	];
	return replaceFeaturePositions( before, nextPositions );
}

function removeVertex( before: PlotFeature, vertex: VertexId ): PlotFeature {
	const positions = editablePositions( before );
	if ( before.type === 'rectangle' ) {
		throw commandValidationError( 'INVALID_COMMAND', '矩形不允许删除角点。' );
	}
	const index = parseVertexId( vertex );
	if ( index < 0 || index >= positions.length ) {
		throw commandValidationError( 'INVALID_COMMAND', '待删除顶点不存在。' );
	}
	const minimum = before.type === 'polygon'
		|| before.type === 'arrow' && ( before.geometry.arrowType === 'attack'
			|| before.geometry.arrowType === 'swallowtailAttack' )
		? 3
		: 2;
	if ( positions.length <= minimum ) {
		throw commandValidationError( 'INVALID_GEOMETRY', `该图形至少需要 ${ minimum } 个控制点。` );
	}
	return replaceFeaturePositions( before, positions.filter( ( _, current ) => current !== index ) );
}

function editablePositions(
	feature: PlotFeature,
): readonly Position3D[] {
	if ( feature.type === 'line' || feature.type === 'polygon'
		|| feature.type === 'rectangle' || feature.type === 'arrow' ) {
		return feature.geometry.positions;
	}
	throw commandValidationError( 'INVALID_COMMAND', `${ feature.type } 没有可插入或删除的顶点列表。` );
}

function replaceFeaturePositions(
	before: LineFeature | PolygonFeature | ArrowFeature | PlotFeature,
	positions: readonly Position3D[],
): PlotFeature {
	return normalizeFeature( {
		...before,
		geometry: { ...before.geometry, positions },
		revision: before.revision + 1,
	}, { path: `/features/${ before.id }` } );
}

function replaceFeatures(
	current: readonly PlotFeature[],
	replacements: ReadonlyMap<PlotFeatureId, PlotFeature>,
): PlotFeature[] {
	return current.map( ( feature ) => replacements.get( feature.id ) ?? feature );
}

function requireFeature(
	document: PlotDocumentStore,
	id: PlotFeatureId,
): PlotFeature {
	const feature = document.get( id );
	if ( feature === undefined ) {
		throw commandValidationError( 'FEATURE_NOT_FOUND', `feature 不存在：${ id }。` );
	}
	return feature as PlotFeature;
}

function assertFeaturesExist(
	document: PlotDocumentStore,
	ids: readonly PlotFeatureId[],
): void {
	for ( const id of ids ) {
		requireFeature( document, id );
	}
}

function assertRevision( feature: PlotFeature, expected: number ): void {
	if ( feature.revision !== expected ) {
		throw commandValidationError(
			'REVISION_CONFLICT',
			`feature ${ feature.id } revision 已从 ${ expected } 变为 ${ feature.revision }。`,
		);
	}
}

function uniqueIds( ids: readonly PlotFeatureId[] ): PlotFeatureId[] {
	if ( ! Array.isArray( ids ) || ids.some( ( id ) => typeof id !== 'string' ) ) {
		throw commandValidationError( 'INVALID_COMMAND', 'ids 必须是字符串数组。' );
	}
	return [ ...new Set( ids ) ];
}

function commandLabel( command: EditorCommand ): string {
	switch ( command.type ) {
		case 'feature.add': return '添加图形';
		case 'feature.remove': return '删除图形';
		case 'feature.patch': return '修改图形';
		case 'feature.transform': return '变换图形';
		case 'vertex.insert': return '插入顶点';
		case 'vertex.remove': return '删除顶点';
		case 'document.replace': return '替换文档';
	}
}

function commandValidationError( code: string, message: string ): PlotEditorValidationError {
	return new PlotEditorValidationError( {
		code,
		severity: 'error',
		message,
	} );
}
