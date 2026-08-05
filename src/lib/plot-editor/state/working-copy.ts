import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { CommandResult } from '../commands/types';
import type { PlotDocument } from '../document/PlotDocument';
import { PlotEditorValidationError } from '../document/diagnostics';
import { normalizeFeature } from '../document/validate';
import type {
	PlotDocumentSnapshot,
	PlotFeature,
	PlotFeatureId,
} from '../document/types';

export interface WorkingCopyUpdateResult {
	readonly ok: boolean;
	readonly feature?: Readonly<PlotFeature>;
	readonly error?: PlotEditorValidationError;
}

/**
 * 连续交互使用的文档工作副本。
 *
 * 工作副本只保存被选中的 feature 候选；preview 更新不会触发 document change，
 * commit 时才把候选合成一份完整 snapshot 并执行一次原子命令。
 */
export class WorkingCopy {
	private readonly _document: PlotDocument;
	private readonly _sourceRevision: number;
	private readonly _source = new Map<PlotFeatureId, PlotFeature>();
	private readonly _working = new Map<PlotFeatureId, PlotFeature>();
	private _closed = false;

	public constructor(
		document: PlotDocument,
		ids: Iterable<PlotFeatureId>,
	) {
		this._document = document;
		this._sourceRevision = document.revision;
		for ( const id of new Set( ids ) ) {
			const feature = document.get( id );
			if ( feature === undefined ) {
				throw workingCopyError( 'FEATURE_NOT_FOUND', `feature 不存在：${ id }。` );
			}
			this._source.set( id, feature as PlotFeature );
			this._working.set( id, feature as PlotFeature );
		}
		if ( this._source.size === 0 ) {
			throw workingCopyError( 'INVALID_COMMAND', 'working copy 至少需要一个 feature。' );
		}
	}

	public get sourceRevision(): number {
		return this._sourceRevision;
	}

	public get closed(): boolean {
		return this._closed;
	}

	public get ids(): readonly PlotFeatureId[] {
		return Object.freeze( [ ...this._working.keys() ] );
	}

	public get( id: PlotFeatureId ): Readonly<PlotFeature> | undefined {
		return this._working.get( id );
	}

	public getAll(): readonly Readonly<PlotFeature>[] {
		return Object.freeze( [ ...this._working.values() ] );
	}

	/** 校验失败时保留上一次合法 preview，不污染工作副本。 */
	public update(
		id: PlotFeatureId,
		producer: ( current: Readonly<PlotFeature> ) => unknown,
	): WorkingCopyUpdateResult {
		this._assertOpen();
		const current = this._working.get( id );
		const source = this._source.get( id );
		if ( current === undefined || source === undefined ) {
			return Object.freeze( {
				ok: false,
				error: workingCopyError( 'FEATURE_NOT_FOUND', `working copy 不包含 feature：${ id }。` ),
			} );
		}
		try {
			const candidate = normalizeFeature( producer( current ), {
				path: `/working/${ id }`,
			} );
			if ( candidate.id !== source.id || candidate.type !== source.type ) {
				throw workingCopyError(
					'INVALID_COMMAND',
					'working copy update 不得改变 feature id 或 type。',
				);
			}
			const normalized = candidate.revision === source.revision + 1
				? candidate
				: normalizeFeature( {
					...candidate,
					revision: source.revision + 1,
				}, { path: `/working/${ id }` } );
			this._working.set( id, normalized );
			return Object.freeze( { ok: true, feature: normalized } );
		} catch ( error ) {
			return Object.freeze( {
				ok: false,
				error: error instanceof PlotEditorValidationError
					? error
					: workingCopyError(
						'INVALID_COMMAND',
						error instanceof Error ? error.message : 'working copy update 失败。',
					),
			} );
		}
	}

	public commit(
		executor: CommandExecutor,
		history: HistoryManager,
		label = '提交工作副本',
	): CommandResult {
		this._assertOpen();
		if ( this._document.revision !== this._sourceRevision ) {
			this._closed = true;
			return failureResult(
				this._document.revision,
				'REVISION_CONFLICT',
				'working copy 期间文档已被外部修改，候选已丢弃。',
			);
		}
		const snapshot = this._createCandidateSnapshot();
		const result = history.execute(
			executor,
			{ type: 'document.replace', snapshot },
			undefined,
			label,
		);
		if ( result.ok ) {
			this._closed = true;
		}
		return result;
	}

	public cancel(): void {
		this._closed = true;
		this._working.clear();
	}

	private _createCandidateSnapshot(): PlotDocumentSnapshot {
		const current = this._document.snapshot();
		const features = current.features.map(
			( feature ) => this._working.get( feature.id ) ?? feature,
		);
		return Object.freeze( {
			...current,
			features: Object.freeze( features ),
		} );
	}

	private _assertOpen(): void {
		if ( this._closed ) {
			throw workingCopyError( 'TRANSACTION_CLOSED', 'working copy 已结束。' );
		}
	}
}

function workingCopyError( code: string, message: string ): PlotEditorValidationError {
	return new PlotEditorValidationError( { code, severity: 'error', message } );
}

function failureResult(
	revision: number,
	code: string,
	message: string,
): CommandResult {
	return Object.freeze( {
		ok: false,
		changed: false,
		revision,
		affectedIds: Object.freeze( [] ),
		error: Object.freeze( { code, message } ),
	} );
}
