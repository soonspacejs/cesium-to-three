import type { PlotDocumentSnapshot } from '../document/types';

export interface SaveCoordinatorState {
	readonly pendingCount: number;
	readonly latestRequestedRevision: number;
	readonly latestSavedRevision: number;
}

export interface SaveRequestOutcome {
	readonly revision: number;
	readonly acceptedAsLatest: boolean;
}

/** 异步保存可乱序完成；旧请求完成永远不会把较新 revision 标记成已保存。 */
export class SaveCoordinator {
	private readonly _save: ( snapshot: PlotDocumentSnapshot ) => void | Promise<void>;
	private _pending = 0;
	private _latestRequestedRevision = -1;
	private _latestSavedRevision = -1;
	private _disposed = false;

	public constructor( save: ( snapshot: PlotDocumentSnapshot ) => void | Promise<void> ) {
		this._save = save;
	}

	public get state(): SaveCoordinatorState {
		return Object.freeze( {
			pendingCount: this._pending,
			latestRequestedRevision: this._latestRequestedRevision,
			latestSavedRevision: this._latestSavedRevision,
		} );
	}

	public async request( snapshot: PlotDocumentSnapshot ): Promise<SaveRequestOutcome> {
		if ( this._disposed ) throw new Error( 'SaveCoordinator 已销毁。' );
		const revision = snapshot.revision;
		this._latestRequestedRevision = Math.max( this._latestRequestedRevision, revision );
		this._pending++;
		try {
			await this._save( snapshot );
			const accepted = revision >= this._latestSavedRevision
				&& revision === this._latestRequestedRevision;
			if ( accepted ) this._latestSavedRevision = revision;
			return Object.freeze( { revision, acceptedAsLatest: accepted } );
		} finally {
			this._pending--;
		}
	}

	public dispose(): void {
		this._disposed = true;
	}
}
