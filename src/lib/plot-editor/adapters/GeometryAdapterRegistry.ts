import type { PlotFeature, PlotFeatureType } from '../document/types';
import type { DrawingDraft, GeometryAdapter } from './types';

const EDITABLE_KINDS: readonly PlotFeatureType[] = Object.freeze( [
	'point', 'line', 'polygon', 'rectangle', 'sector', 'arrow', 'text', 'circle',
] );

/** 只接受 GIS Graphics；model/3D Tiles 永远不能注册成可编辑图形。 */
export class GeometryAdapterRegistry {
	private readonly _adapters = new Map<PlotFeatureType, GeometryAdapter>();

	public register( adapter: GeometryAdapter<any, any> ): void {
		if ( ! EDITABLE_KINDS.includes( adapter.kind ) ) {
			throw new Error( `UNSUPPORTED_GRAPHICS_KIND：${ String( adapter.kind ) }。` );
		}
		if ( adapter.capabilities.editable !== true ) {
			throw new Error( `adapter ${ adapter.kind } 必须声明 editable=true。` );
		}
		if ( this._adapters.has( adapter.kind ) ) {
			throw new Error( `adapter 已注册：${ adapter.kind }。` );
		}
		this._adapters.set( adapter.kind, adapter as GeometryAdapter );
	}

	public unregister( kind: PlotFeatureType ): boolean {
		return this._adapters.delete( kind );
	}

	public has( kind: PlotFeatureType ): boolean {
		return this._adapters.has( kind );
	}

	public get<
		TDraft extends DrawingDraft = DrawingDraft,
		TFeature extends PlotFeature = PlotFeature,
	>( kind: TFeature[ 'type' ] ): GeometryAdapter<TDraft, TFeature> | undefined {
		return this._adapters.get( kind ) as GeometryAdapter<TDraft, TFeature> | undefined;
	}

	public require<
		TDraft extends DrawingDraft = DrawingDraft,
		TFeature extends PlotFeature = PlotFeature,
	>( kind: TFeature[ 'type' ] ): GeometryAdapter<TDraft, TFeature> {
		const adapter = this.get<TDraft, TFeature>( kind );
		if ( adapter === undefined ) {
			throw new Error( `UNSUPPORTED_GRAPHICS_KIND：${ kind }。` );
		}
		return adapter;
	}

	public get kinds(): readonly PlotFeatureType[] {
		return Object.freeze( EDITABLE_KINDS.filter( ( kind ) => this._adapters.has( kind ) ) );
	}

	public get size(): number {
		return this._adapters.size;
	}
}
