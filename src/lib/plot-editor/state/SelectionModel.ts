import type { PlotDocument } from '../document/PlotDocument';
import type { PlotFeature, PlotFeatureId } from '../document/types';
import type { HitTarget } from './types';

export interface SelectionState {
	/** 稳定去重，并始终按 document order 排序。 */
	readonly ids: readonly PlotFeatureId[];
	readonly primaryId?: PlotFeatureId;
	readonly activeHandleId?: string;
	readonly hoverTarget?: HitTarget;
}

export type SelectionMutation =
	| { readonly kind: 'replace'; readonly ids: readonly PlotFeatureId[] }
	| { readonly kind: 'add'; readonly ids: readonly PlotFeatureId[] }
	| { readonly kind: 'toggle'; readonly id: PlotFeatureId }
	| { readonly kind: 'clear' };

export interface SelectionFilter {
	readonly visibleOnly?: boolean;
	readonly editableOnly?: boolean;
	readonly lockedOnly?: boolean;
	readonly selectThrough?: boolean;
	readonly typeAllowList?: readonly string[];
}

export type SelectionListener = ( state: SelectionState ) => void;

export interface SelectionModelOptions {
	/** 外部 feature 替换或拓扑变化后，用 adapter 校验 transient handle 是否仍存在。 */
	readonly isHandleValid?: (
		feature: Readonly<PlotFeature>,
		handleId: string,
	) => boolean;
}

/** 确定性的选择集合；选择变化不接触 command history。 */
export class SelectionModel {
	private readonly _document: PlotDocument;
	private readonly _isHandleValid?: SelectionModelOptions[ 'isHandleValid' ];
	private readonly _listeners = new Set<SelectionListener>();
	private readonly _unsubscribeDocument: () => void;
	private _ids: PlotFeatureId[] = [];
	private _primaryId: PlotFeatureId | undefined;
	private _activeHandleId: string | undefined;
	private _activeHandleEntityId: PlotFeatureId | undefined;
	private _hoverTarget: HitTarget | undefined;
	private _disposed = false;

	public constructor(
		document: PlotDocument,
		options: SelectionModelOptions = {},
	) {
		this._document = document;
		this._isHandleValid = options.isHandleValid;
		this._unsubscribeDocument = document.subscribe( () => this.reconcile() );
	}

	public get state(): SelectionState {
		return freezeState(
			this._ids,
			this._primaryId,
			this._activeHandleId,
			this._hoverTarget,
		);
	}

	public subscribe( listener: SelectionListener ): () => void {
		this._assertOpen();
		this._listeners.add( listener );
		let active = true;
		return () => {
			if ( ! active ) return;
			active = false;
			this._listeners.delete( listener );
		};
	}

	public apply(
		mutation: SelectionMutation,
		filter: SelectionFilter = {},
	): SelectionState {
		this._assertOpen();
		const previous = this.state;
		const eligibleIds = this._eligibleIds( filter );
		const eligible = new Set( eligibleIds );
		let ids = [ ...this._ids ];
		let primary = this._primaryId;

		switch ( mutation.kind ) {
			case 'clear':
				ids = [];
				primary = undefined;
				break;
			case 'replace': {
				const requested = uniqueEligible( mutation.ids, eligible );
				ids = sortByOrder( requested, eligibleIds );
				primary = lastEligibleRequest( mutation.ids, new Set( ids ) ) ?? ids[ 0 ];
				break;
			}
			case 'add': {
				const requested = uniqueEligible( mutation.ids, eligible );
				ids = sortByOrder( [ ...ids, ...requested ], eligibleIds );
				primary = lastEligibleRequest( mutation.ids, new Set( ids ) ) ?? primary ?? ids[ 0 ];
				break;
			}
			case 'toggle':
				if ( ids.includes( mutation.id ) ) {
					ids = ids.filter( ( id ) => id !== mutation.id );
					if ( primary === mutation.id ) primary = ids.at( -1 );
				} else if ( eligible.has( mutation.id ) ) {
					ids = sortByOrder( [ ...ids, mutation.id ], eligibleIds );
					primary = mutation.id;
				}
				break;
		}

		this._ids = ids;
		this._primaryId = primary !== undefined && ids.includes( primary )
			? primary
			: ids[ 0 ];
		if ( previous.primaryId !== this._primaryId
			|| previous.ids.length !== this._ids.length
			|| previous.ids.some( ( id, index ) => id !== this._ids[ index ] ) ) {
			this._activeHandleId = undefined;
			this._activeHandleEntityId = undefined;
		}
		if ( this._activeHandleEntityId !== undefined
			&& ! this._ids.includes( this._activeHandleEntityId ) ) {
			this._activeHandleId = undefined;
			this._activeHandleEntityId = undefined;
		}
		this._emitIfChanged( previous );
		return this.state;
	}

	public selectAll( filter: SelectionFilter = {} ): SelectionState {
		return this.apply( { kind: 'replace', ids: this._eligibleIds( filter ) }, filter );
	}

	public setActiveHandle(
		handleId: string | undefined,
		entityId: PlotFeatureId | undefined = this._primaryId,
	): void {
		this._assertOpen();
		if ( handleId !== undefined ) {
			if ( handleId.trim().length === 0 ) throw new TypeError( 'handleId 不能为空。' );
			if ( entityId === undefined || ! this._ids.includes( entityId ) ) {
				throw new Error( 'active handle 必须属于当前选中实体。' );
			}
			const feature = this._document.get( entityId );
			if ( feature === undefined
				|| this._isHandleValid?.( feature, handleId ) === false ) {
				throw new Error( 'active handle 已失效或不属于目标图形。' );
			}
		}
		const previous = this.state;
		this._activeHandleId = handleId;
		this._activeHandleEntityId = handleId === undefined ? undefined : entityId;
		if ( entityId !== undefined && this._ids.includes( entityId ) ) {
			this._primaryId = entityId;
		}
		this._emitIfChanged( previous );
	}

	public setHover( target: HitTarget | null ): void {
		this._assertOpen();
		const previous = this.state;
		this._hoverTarget = target === null || target.kind === 'none'
			? undefined
			: Object.freeze( { ...target } );
		this._emitIfChanged( previous );
	}

	/** 文档隐藏、锁定、删除或替换后清除 stale selection/hover/handle。 */
	public reconcile(): void {
		if ( this._disposed ) return;
		const previous = this.state;
		const eligibleIds = this._eligibleIds( {} );
		const eligible = new Set( eligibleIds );
		this._ids = sortByOrder(
			this._ids.filter( ( id ) => eligible.has( id ) ),
			eligibleIds,
		);
		if ( this._primaryId === undefined || ! this._ids.includes( this._primaryId ) ) {
			this._primaryId = this._ids.at( -1 );
		}
		if ( this._activeHandleEntityId !== undefined
			&& ! this._ids.includes( this._activeHandleEntityId ) ) {
			this._activeHandleId = undefined;
			this._activeHandleEntityId = undefined;
		}
		if ( this._activeHandleEntityId !== undefined
			&& this._activeHandleId !== undefined
			&& this._isHandleValid !== undefined ) {
			const feature = this._document.get( this._activeHandleEntityId );
			if ( feature === undefined
				|| ! this._isHandleValid( feature, this._activeHandleId ) ) {
				this._activeHandleId = undefined;
				this._activeHandleEntityId = undefined;
			}
		}
		if ( this._hoverTarget?.entityId !== undefined
			&& ! eligible.has( this._hoverTarget.entityId ) ) {
			this._hoverTarget = undefined;
		}
		this._emitIfChanged( previous );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		this._unsubscribeDocument();
		this._listeners.clear();
		this._ids = [];
		this._primaryId = undefined;
		this._activeHandleId = undefined;
		this._activeHandleEntityId = undefined;
		this._hoverTarget = undefined;
	}

	private _eligibleIds( filter: SelectionFilter ): PlotFeatureId[] {
		const allow = filter.typeAllowList === undefined
			? null
			: new Set( filter.typeAllowList );
		return this._document.getAll()
			.filter( ( feature ) => eligibleFeature( feature, filter, allow ) )
			.map( ( feature ) => feature.id );
	}

	private _emitIfChanged( previous: SelectionState ): void {
		const next = this.state;
		if ( selectionStatesEqual( previous, next ) ) return;
		for ( const listener of [ ...this._listeners ] ) listener( next );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'SelectionModel 已销毁。' );
	}
}

function eligibleFeature(
	feature: Readonly<PlotFeature>,
	filter: SelectionFilter,
	allow: ReadonlySet<string> | null,
): boolean {
	const visible = feature.visible;
	const editable = feature.properties.editable !== false;
	const locked = feature.properties.locked === true;
	if ( ( filter.visibleOnly ?? true ) && ! visible ) return false;
	if ( ( filter.editableOnly ?? true ) && ! editable ) return false;
	// locked 默认仍可被选中以查看属性和获得高亮；编辑控制器会单独拒绝写操作。
	if ( filter.lockedOnly === true && ! locked ) return false;
	return allow === null || allow.has( feature.type );
}

function uniqueEligible(
	ids: readonly PlotFeatureId[],
	eligible: ReadonlySet<PlotFeatureId>,
): PlotFeatureId[] {
	return [ ...new Set( ids.filter( ( id ) => eligible.has( id ) ) ) ];
}

function lastEligibleRequest(
	ids: readonly PlotFeatureId[],
	eligible: ReadonlySet<PlotFeatureId>,
): PlotFeatureId | undefined {
	for ( let index = ids.length - 1; index >= 0; index-- ) {
		if ( eligible.has( ids[ index ] ) ) return ids[ index ];
	}
	return undefined;
}

function sortByOrder(
	ids: readonly PlotFeatureId[],
	order: readonly PlotFeatureId[],
): PlotFeatureId[] {
	const present = new Set( ids );
	return order.filter( ( id ) => present.has( id ) );
}

function freezeState(
	ids: readonly PlotFeatureId[],
	primaryId?: PlotFeatureId,
	activeHandleId?: string,
	hoverTarget?: HitTarget,
): SelectionState {
	return Object.freeze( {
		ids: Object.freeze( [ ...ids ] ),
		...( primaryId === undefined ? {} : { primaryId } ),
		...( activeHandleId === undefined ? {} : { activeHandleId } ),
		...( hoverTarget === undefined ? {} : {
			hoverTarget: Object.freeze( { ...hoverTarget } ),
		} ),
	} );
}

function selectionStatesEqual( left: SelectionState, right: SelectionState ): boolean {
	return left.primaryId === right.primaryId
		&& left.activeHandleId === right.activeHandleId
		&& hitEqual( left.hoverTarget, right.hoverTarget )
		&& left.ids.length === right.ids.length
		&& left.ids.every( ( id, index ) => id === right.ids[ index ] );
}

function hitEqual( left?: HitTarget, right?: HitTarget ): boolean {
	return left === right || ( left !== undefined && right !== undefined
		&& left.kind === right.kind
		&& left.entityId === right.entityId
		&& left.handleId === right.handleId
		&& left.distanceCssPixels === right.distanceCssPixels
		&& left.depth === right.depth
		&& left.zOrder === right.zOrder
		&& left.depthApproximate === right.depthApproximate );
}
