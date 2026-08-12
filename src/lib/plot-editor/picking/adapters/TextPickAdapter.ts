import type { Material } from 'three';
import { measurePlotTextLayout, type PlotTextMeasure } from '../../../plot/text-layout';
import { createEnuFrame, ecefToGeodetic, enuToEcef } from '../../document/geodesy';
import { HeightReference, type Position3D, type TextFeature } from '../../document/types';
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
		const centerLocalEast = style.anchorX === 'left' ? width / 2
			: style.anchorX === 'right' ? - width / 2 : 0;
		const centerLocalNorth = style.anchorY === 'top' ? - height / 2
			: style.anchorY === 'bottom' ? height / 2 : 0;
		const rotation = style.rotation * Math.PI / 180;
		const cos = Math.cos( rotation );
		const sin = Math.sin( rotation );
		const frame = createEnuFrame( worldPosition );
		const corners = [ [ -width / 2, -height / 2 ], [ width / 2, -height / 2 ],
			[ width / 2, height / 2 ], [ -width / 2, height / 2 ] ] as const;
		const positions = corners.map( ( [ x, y ] ) => {
			// anchor 位移属于文本框局部坐标，必须与四角一同旋转；offset 才是
			// 不随文本旋转的全局 ENU 位移。顺序与贴地文本显示 footprint 完全一致。
			const localEast = centerLocalEast + x;
			const localNorth = centerLocalNorth + y;
			const east = style.offsetX + localEast * cos + localNorth * sin;
			const north = style.offsetY - localEast * sin + localNorth * cos;
			return ecefToGeodetic( enuToEcef( [ east, north, 0 ], frame ), worldPosition[ 0 ] );
		} );
		return createTriangulatedSurface(
			positions, material, isGroundClamp( feature.heightReference ) ? 0.02 : 0,
		);
	}
}

function isGroundClamp( value: HeightReference ): boolean {
	return value === HeightReference.CLAMP_TO_GROUND
		|| value === HeightReference.CLAMP_TO_TERRAIN
		|| value === HeightReference.CLAMP_TO_3D_TILE;
}
