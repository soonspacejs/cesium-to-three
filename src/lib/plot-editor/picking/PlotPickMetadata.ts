import type { Object3D } from 'three';
import type {
	PlotFeature,
	PlotFeatureId,
} from '../document/types';

export type PlotPickSource = 'visual' | 'proxy';
export type PlotPickPart = 'body' | 'fill' | 'stroke' | 'label' | 'icon';

/**
 * 挂在 feature 级拾取根对象上的只读业务元数据。
 * 子对象不重复保存；射线命中后沿父链解析，避免对象名成为隐式协议。
 */
export interface PlotPickMetadata {
	readonly kind: 'plot-entity';
	readonly featureId: PlotFeatureId;
	readonly featureType: PlotFeature[ 'type' ];
	readonly source: PlotPickSource;
	readonly part: PlotPickPart;
	readonly pickPriority: number;
	readonly plotOrder: number;
}

export const PLOT_PICK_METADATA_KEY = 'plotPick';

export function setPlotPickMetadata(
	object: Object3D,
	metadata: PlotPickMetadata,
): void {
	object.userData[ PLOT_PICK_METADATA_KEY ] = Object.freeze( { ...metadata } );
}

export function clearPlotPickMetadata( object: Object3D ): void {
	delete object.userData[ PLOT_PICK_METADATA_KEY ];
}

/** 从实际交点向父级查找 feature 根，返回值始终是不可变快照。 */
export function resolvePlotPickMetadata(
	object: Object3D | null,
): PlotPickMetadata | null {
	let current = object;
	while ( current !== null ) {
		const value = current.userData[ PLOT_PICK_METADATA_KEY ];
		if ( isPlotPickMetadata( value ) ) return value;
		current = current.parent;
	}
	return null;
}

function isPlotPickMetadata( value: unknown ): value is PlotPickMetadata {
	if ( value === null || typeof value !== 'object' ) return false;
	const candidate = value as Partial<PlotPickMetadata>;
	return candidate.kind === 'plot-entity'
		&& typeof candidate.featureId === 'string'
		&& typeof candidate.featureType === 'string'
		&& ( candidate.source === 'visual' || candidate.source === 'proxy' )
		&& typeof candidate.part === 'string'
		&& typeof candidate.pickPriority === 'number'
		&& typeof candidate.plotOrder === 'number';
}
