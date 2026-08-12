import { Vector3, type Material } from 'three';
import { geodeticToEcef, type Vector3Tuple } from '../../document/geodesy';
import type { RenderFeature } from '../../render/RenderProjection';
import { createIndexedObject, type StandardPickObject } from './geometry';

const MITER_LIMIT = 4;
const DASH_LENGTH_METERS = 60;
const DASH_GAP_METERS = 40;

/** 以实际 strokeWidth 构造标准带状 Mesh，避免无限细 Line 和 CSS 容差。 */
export class LinePickAdapter {
	public build( render: RenderFeature, material: Material ): StandardPickObject | null {
		if ( render.type !== 'line' || render.vertices.length < 2 ) return null;
		const width = Number( render.style.strokeWidth );
		if ( ! Number.isFinite( width ) || width <= 0 ) return null;
		const centers = render.vertices.map( ( vertex ) => new Vector3().fromArray(
			geodeticToEcef( [ vertex.longitude, vertex.latitude, vertex.resolvedWorldHeight ] ),
		) );
		const dashed = render.style.strokeStyle === 'dashed';
		const runs = dashed ? createDashedRuns( centers ) : [ centers ];
		const positions: Vector3[] = [];
		const indices: number[] = [];
		for ( const run of runs ) {
			if ( run.length < 2 ) continue;
			const base = positions.length;
			positions.push( ...buildStripVertices( run, width / 2 ) );
			for ( let index = 0; index < run.length - 1; index++ ) {
				const left0 = base + index * 2;
				const right0 = left0 + 1;
				const left1 = left0 + 2;
				const right1 = left0 + 3;
				indices.push( left0, right0, left1, right0, right1, left1 );
			}
		}
		return createIndexedObject(
			positions.map( ( point ) => point.toArray() as Vector3Tuple ), indices, material,
		);
	}
}

/** 与 PlainPlotPrimitive 的 60m/40m 显示规则共享相同世界尺度。 */
function createDashedRuns( centers: readonly Vector3[] ): readonly Vector3[][] {
	const runs: Vector3[][] = [];
	let drawing = true;
	let remaining = DASH_LENGTH_METERS;
	let active: Vector3[] | null = [ centers[ 0 ].clone() ];
	for ( let index = 0; index < centers.length - 1; index++ ) {
		const start = centers[ index ];
		const end = centers[ index + 1 ];
		const length = start.distanceTo( end );
		if ( length <= 1e-9 ) continue;
		let traveled = 0;
		while ( traveled < length - 1e-9 ) {
			const step = Math.min( remaining, length - traveled );
			traveled += step;
			const point = start.clone().lerp( end, traveled / length );
			if ( drawing ) active?.push( point );
			remaining -= step;
			if ( remaining <= 1e-9 ) {
				if ( drawing && active !== null && active.length >= 2 ) runs.push( active );
				drawing = ! drawing;
				remaining = drawing ? DASH_LENGTH_METERS : DASH_GAP_METERS;
				active = drawing ? [ point.clone() ] : null;
			}
		}
		if ( drawing && active !== null && active.length > 0
			&& ! active[ active.length - 1 ].equals( end ) ) active.push( end.clone() );
	}
	if ( drawing && active !== null && active.length >= 2 ) runs.push( active );
	return runs;
}

function buildStripVertices( centers: readonly Vector3[], halfWidth: number ): Vector3[] {
	const rights = centers.slice( 0, -1 ).map( ( point, index ) => segmentRight(
		point, centers[ index + 1 ],
	) );
	const result: Vector3[] = [];
	for ( let index = 0; index < centers.length; index++ ) {
		let offset: Vector3;
		if ( index === 0 ) offset = rights[ 0 ].clone().multiplyScalar( halfWidth );
		else if ( index === centers.length - 1 ) {
			offset = rights[ rights.length - 1 ].clone().multiplyScalar( halfWidth );
		} else {
			const miter = rights[ index - 1 ].clone().add( rights[ index ] );
			if ( miter.lengthSq() < 1e-12 ) miter.copy( rights[ index ] );
			miter.normalize();
			const denominator = miter.dot( rights[ index ] );
			const length = Math.abs( denominator ) < 1e-4
				? halfWidth : Math.min( halfWidth / denominator, halfWidth * MITER_LIMIT );
			offset = miter.multiplyScalar( length );
		}
		result.push( centers[ index ].clone().add( offset ), centers[ index ].clone().sub( offset ) );
	}
	return result;
}

function segmentRight( start: Vector3, end: Vector3 ): Vector3 {
	const direction = end.clone().sub( start ).normalize();
	const up = start.clone().add( end ).multiplyScalar( 0.5 ).normalize();
	const right = new Vector3().crossVectors( direction, up );
	return right.lengthSq() < 1e-12
		? new Vector3( 1, 0, 0 ) : right.normalize();
}
