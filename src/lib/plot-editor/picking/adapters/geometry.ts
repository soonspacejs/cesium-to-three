import earcut from 'earcut';
import {
	BufferGeometry,
	Float32BufferAttribute,
	Group,
	Mesh,
	type Material,
} from 'three';
import {
	createEnuFrame,
	ecefToEnu,
	geodeticToEcef,
	type Vector3Tuple,
} from '../../document/geodesy';
import type { Position3D } from '../../document/types';

export interface StandardPickObject {
	readonly root: Group;
	readonly geometries: readonly BufferGeometry[];
}

/**
 * 以首点 ECEF 为根平移、其余顶点只保存局部米制差值，避免大地坐标被
 * Float32 position 截断；该变换完全存在于 matrixWorld，原生 raycast 可直接读取。
 */
export function createTriangulatedSurface(
	positions: readonly Position3D[],
	material: Material,
): StandardPickObject | null {
	if ( positions.length < 3 ) return null;
	const frame = createEnuFrame( positions[ 0 ] );
	const ecef = positions.map( geodeticToEcef );
	const flat: number[] = [];
	for ( const point of ecef ) {
		const enu = ecefToEnu( point, frame );
		flat.push( enu[ 0 ], enu[ 1 ] );
	}
	const index = earcut( flat, undefined, 2 );
	if ( index.length < 3 ) return null;
	return createIndexedObject( ecef, index, material );
}

export function createIndexedObject(
	worldPositions: readonly Vector3Tuple[],
	indices: readonly number[],
	material: Material,
): StandardPickObject | null {
	if ( worldPositions.length < 3 || indices.length < 3 ) return null;
	const origin = worldPositions[ 0 ];
	const values = worldPositions.flatMap( ( point ) => [
		point[ 0 ] - origin[ 0 ], point[ 1 ] - origin[ 1 ], point[ 2 ] - origin[ 2 ],
	] );
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( values, 3 ) );
	geometry.setIndex( [ ...indices ] );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	geometry.computeVertexNormals();
	const mesh = new Mesh( geometry, material );
	mesh.name = 'PlotPickSurface';
	const root = new Group();
	root.name = 'PlotPickProxy';
	root.position.set( origin[ 0 ], origin[ 1 ], origin[ 2 ] );
	root.add( mesh );
	return Object.freeze( { root, geometries: Object.freeze( [ geometry ] ) } );
}
