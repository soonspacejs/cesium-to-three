import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { CommandResult } from '../commands/types';
import type { ShapeEditController } from '../editing/ShapeEditController';
import {
	SelectionModel,
	type SelectionFilter,
	type SelectionState,
} from '../state/SelectionModel';
import type { HitTarget, ScreenPoint, SelectionOperation } from '../state/types';
import {
	MarqueeSelectionProjector,
	type MarqueeSelectionOptions,
	type MarqueeSelectionResult,
} from './MarqueeSelectionProjector';
import type { EditorProjectionSnapshot } from './ProjectionSnapshot';

export interface SelectionControllerOptions {
	readonly model: SelectionModel;
	readonly marqueeProjector: MarqueeSelectionProjector;
	readonly shapeEditor: ShapeEditController;
}

export interface SelectAtResult {
	readonly hit: HitTarget | null;
	readonly selection: SelectionState;
}

export interface SelectBoxResult extends MarqueeSelectionResult {
	readonly selection: SelectionState;
}

/** 将 click/box/delete 语义组合到 SelectionModel，但选择变化本身永远不写 history。 */
export class SelectionController {
	private readonly _model: SelectionModel;
	private readonly _marqueeProjector: MarqueeSelectionProjector;
	private readonly _shapeEditor: ShapeEditController;
	private _disposed = false;

	public constructor( options: SelectionControllerOptions ) {
		this._model = options.model;
		this._marqueeProjector = options.marqueeProjector;
		this._shapeEditor = options.shapeEditor;
	}

	public get state(): SelectionState {
		return this._model.state;
	}

	public applyHit(
		hit: HitTarget | null,
		operation: SelectionOperation,
		filter: SelectionFilter = {},
	): SelectAtResult {
		this._assertOpen();
		const id = selectableEntityId( hit );
		if ( id === undefined ) {
			if ( operation === 'replace' ) this._model.apply( { kind: 'clear' }, filter );
			return Object.freeze( { hit, selection: this._model.state } );
		}

		switch ( operation ) {
			case 'replace': this._model.apply( { kind: 'replace', ids: [ id ] }, filter ); break;
			case 'add': this._model.apply( { kind: 'add', ids: [ id ] }, filter ); break;
			case 'toggle': this._model.apply( { kind: 'toggle', id }, filter ); break;
		}
		if ( hit?.handleId !== undefined && this._model.state.ids.includes( id ) ) {
			try {
				this._model.setActiveHandle( hit.handleId, id );
			} catch {
				// Gizmo proxy 可能不是 shape adapter handle；其事务由 transform controller 持有。
			}
		}
		return Object.freeze( { hit, selection: this._model.state } );
	}

	public selectBox(
		start: ScreenPoint,
		end: ScreenPoint,
		projection: EditorProjectionSnapshot,
		operation: SelectionOperation,
		options: MarqueeSelectionOptions = {},
	): SelectBoxResult {
		this._assertOpen();
		const result = this._marqueeProjector.select( start, end, projection, options );
		if ( operation === 'replace' ) {
			this._model.apply( { kind: 'replace', ids: result.ids }, options.filter );
		} else if ( operation === 'add' ) {
			this._model.apply( { kind: 'add', ids: result.ids }, options.filter );
		} else {
			for ( const id of result.ids ) this._model.apply( { kind: 'toggle', id }, options.filter );
		}
		return Object.freeze( { ...result, selection: this._model.state } );
	}

	public selectAll( filter: SelectionFilter = {} ): SelectionState {
		this._assertOpen();
		return this._model.selectAll( filter );
	}

	public clear(): SelectionState {
		this._assertOpen();
		return this._model.apply( { kind: 'clear' } );
	}

	/** Delete 优先删除活动 source vertex；没有活动 vertex 时原子删除全部 selection。 */
	public deleteContext(): CommandResult {
		this._assertOpen();
		const state = this._model.state;
		if ( state.activeHandleId?.startsWith( 'vertex:' ) === true
			&& state.primaryId !== undefined ) {
			const result = this._shapeEditor.removeVertex(
				state.primaryId,
				state.activeHandleId,
			);
			if ( result.ok ) this._model.setActiveHandle( undefined );
			return result;
		}
		return this._shapeEditor.deleteFeatures( state.ids );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'SelectionController 已销毁。' );
	}
}

/** 用内置 adapter 构造可自动清理 stale handle 的 SelectionModel。 */
export function createAdapterAwareSelectionModel(
	document: ConstructorParameters<typeof SelectionModel>[ 0 ],
	adapters: GeometryAdapterRegistry,
): SelectionModel {
	return new SelectionModel( document, {
		isHandleValid: ( feature, handleId ) => adapters
			.require( feature.type )
			.listHandles( feature as never )
			.some( ( handle ) => handle.id === handleId ),
	} );
}

function selectableEntityId( hit: HitTarget | null ): string | undefined {
	if ( hit === null || hit.kind === 'none' || hit.kind === 'surface' ) return undefined;
	return hit.entityId;
}
