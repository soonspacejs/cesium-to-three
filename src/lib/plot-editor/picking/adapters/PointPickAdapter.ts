import type { Material } from 'three';
import {
	createEnuFrame,
	ecefToGeodetic,
	enuToEcef,
} from '../../document/geodesy';
import type { PointFeature, Position3D } from '../../document/types';
import { HeightReference } from '../../document/types';
import { createTriangulatedSurface, type StandardPickObject } from './geometry';

const POINT_CIRCLE_SEGMENTS = 48;

/** 点图形使用真实世界尺寸的标准面代理，不引入任何 CSS 像素命中半径。 */
export class PointPickAdapter {
	public build(
		feature: Readonly<PointFeature>,
		worldPosition: Position3D,
		material: Material,
	): StandardPickObject | null {
		const style = feature.style;
		const surfaceOffset = isGroundClamp( feature.heightReference ) ? 0.02 : 0;
		if ( style.pointStyle === 'circle' ) {
			return createTriangulatedSurface(
				ellipseRing( worldPosition, style.size, style.size, 0, POINT_CIRCLE_SEGMENTS ),
				material, surfaceOffset,
			);
		}
		const width = style.pointStyle === 'image' ? style.imageWidth : style.size;
		const height = style.pointStyle === 'image' ? style.imageHeight : style.size;
		const rotation = style.pointStyle === 'image' ? style.rotation : 0;
		return createTriangulatedSurface(
			ellipseRing( worldPosition, width, height, rotation, 4 ), material, surfaceOffset,
		);
	}
}

function isGroundClamp( value: HeightReference ): boolean {
	return value === HeightReference.CLAMP_TO_GROUND
		|| value === HeightReference.CLAMP_TO_TERRAIN
		|| value === HeightReference.CLAMP_TO_3D_TILE;
}

function ellipseRing(
	center: Position3D,
	width: number,
	height: number,
	rotationDegrees: number,
	segments: number,
): readonly Position3D[] {
	const frame = createEnuFrame( center );
	const rotation = rotationDegrees * Math.PI / 180;
	const cosRotation = Math.cos( rotation );
	const sinRotation = Math.sin( rotation );
	const samples = segments === 4
		? [ [ -width / 2, -height / 2 ], [ width / 2, -height / 2 ],
			[ width / 2, height / 2 ], [ -width / 2, height / 2 ] ] as const
		: Array.from( { length: segments }, ( _, index ) => {
			const angle = index / segments * Math.PI * 2;
			return [ Math.cos( angle ) * width / 2, Math.sin( angle ) * height / 2 ] as const;
		} );
	return Object.freeze( samples.map( ( [ x, y ] ) => {
		const east = x * cosRotation + y * sinRotation;
		const north = - x * sinRotation + y * cosRotation;
		const ecef = enuToEcef( [ east, north, 0 ], frame );
		return Object.freeze( [ ...ecefToGeodetic( ecef, center[ 0 ] ) ] as Position3D );
	} ) );
}
