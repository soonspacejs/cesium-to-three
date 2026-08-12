import type { Material } from 'three';
import { measurePlotTextLayout, type PlotTextMeasure } from '../../../plot/text-layout';
import { createEnuFrame, ecefToGeodetic, enuToEcef } from '../../document/geodesy';
import type { Position3D, TextFeature } from '../../document/types';
import { createTriangulatedSurface, type StandardPickObject } from './geometry';

export interface TextPickAdapterOptions {
	readonly measureText: PlotTextMeasure;
}

/** 文本代理严格消费与显示纹理相同的排版宽高、锚点、偏移和旋转语义。 */
export class TextPickAdapter {
	private readonly _measureText: PlotTextMeasure;

	public constructor( options: TextPickAdapterOptions ) {
		this._measureText = options.measureText;
	}

	public build(
		feature: Readonly<TextFeature>,
		worldPosition: Position3D,
		material: Material,
	): StandardPickObject | null {
		const style = feature.style;
		const layout = measurePlotTextLayout( style, this._measureText );
		const width = layout.width * style.scale;
		const height = layout.height * style.scale;
		const centerEast = style.offsetX + ( style.anchorX === 'left' ? width / 2
			: style.anchorX === 'right' ? - width / 2 : 0 );
		const centerNorth = style.offsetY + ( style.anchorY === 'top' ? - height / 2
			: style.anchorY === 'bottom' ? height / 2 : 0 );
		const rotation = style.rotation * Math.PI / 180;
		const cos = Math.cos( rotation );
		const sin = Math.sin( rotation );
		const frame = createEnuFrame( worldPosition );
		const corners = [ [ -width / 2, -height / 2 ], [ width / 2, -height / 2 ],
			[ width / 2, height / 2 ], [ -width / 2, height / 2 ] ] as const;
		const positions = corners.map( ( [ x, y ] ) => {
			const east = centerEast + x * cos + y * sin;
			const north = centerNorth - x * sin + y * cos;
			return ecefToGeodetic( enuToEcef( [ east, north, 0 ], frame ), worldPosition[ 0 ] );
		} );
		return createTriangulatedSurface( positions, material );
	}
}
