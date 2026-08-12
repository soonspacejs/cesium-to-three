import type { Material } from 'three';
import type { RenderFeature } from '../../render/RenderProjection';
import type { Position3D } from '../../document/types';
import { createTriangulatedSurface, type StandardPickObject } from './geometry';

/** 面、矩形、圆、扇形与箭头统一消费 RenderProjection 已派生的最终表面。 */
export class AreaPickAdapter {
	public readonly kinds = Object.freeze( [
		'polygon', 'rectangle', 'circle', 'sector', 'arrow',
	] as const );

	public build( render: RenderFeature, material: Material ): StandardPickObject | null {
		if ( ! this.kinds.includes( render.type as typeof this.kinds[ number ] ) ) return null;
		const positions = render.vertices.map( ( vertex ) => Object.freeze( [
			vertex.longitude, vertex.latitude, vertex.resolvedWorldHeight,
		] as Position3D ) );
		return createTriangulatedSurface(
			positions, material, render.path === 'ground-classification' ? 0.02 : 0,
		);
	}
}
