import { describe, expect, it, vi } from 'vitest';

import { EditorSurfacePicker } from '../../../src/lib/plot-editor/picking/EditorPicker';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import type {
	PickSurface,
	SurfaceHit,
} from '../../../src/lib/plot-editor/picking/types';

function hit(
	surface: PickSurface,
	distanceFromCamera: number,
	height: number,
): SurfaceHit {
	return {
		surface,
		distanceFromCamera,
		surfacePosition: [ 120, 30, height ],
	};
}

function createPort() {
	return {
		pickTerrain: vi.fn( () => [ hit( 'terrain', 20, 100 ) ] ),
		pickTiles: vi.fn( () => [ hit( '3d-tile', 10, 150 ) ] ),
		pickEllipsoid: vi.fn( () => hit( 'ellipsoid', 30, 0 ) ),
	};
}

describe( 'EditorSurfacePicker 七值目标矩阵', () => {
	it.each( [
		[ HeightReference.NONE, '3d-tile', 150 ],
		[ HeightReference.CLAMP_TO_GROUND, '3d-tile', 0 ],
		[ HeightReference.RELATIVE_TO_GROUND, '3d-tile', 7 ],
		[ HeightReference.CLAMP_TO_TERRAIN, 'terrain', 0 ],
		[ HeightReference.RELATIVE_TO_TERRAIN, 'terrain', 7 ],
		[ HeightReference.CLAMP_TO_3D_TILE, '3d-tile', 0 ],
		[ HeightReference.RELATIVE_TO_3D_TILE, '3d-tile', 7 ],
	] as const )(
		'heightReference=%s 选择 %s 并生成作者高度 %s',
		( heightReference, expectedSurface, expectedAuthorHeight ) => {
			const port = createPort();
			const result = new EditorSurfacePicker( port ).pick(
				{ clientX: 10, clientY: 20 },
				{ heightReference, relativeOffset: 7 },
			);
			expect( result ).toMatchObject( {
				surface: expectedSurface,
				authorPosition: [ 120, 30, expectedAuthorHeight ],
			} );
			if ( heightReference === HeightReference.CLAMP_TO_TERRAIN
				|| heightReference === HeightReference.RELATIVE_TO_TERRAIN ) {
				expect( port.pickTiles ).not.toHaveBeenCalled();
			}
		},
	);

	it( 'NONE 创建取命中绝对高度，编辑可显式保留旧绝对高度', () => {
		const picker = new EditorSurfacePicker( createPort() );
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.NONE,
		} )?.authorPosition[ 2 ] ).toBe( 150 );
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.NONE,
			absoluteHeight: 88,
		} )?.authorPosition[ 2 ] ).toBe( 88 );
	} );

	it( 'GROUND 在 terrain 与 tile 中取射线最近的正距离', () => {
		const port = createPort();
		port.pickTerrain.mockReturnValue( [
			hit( 'terrain', 0, 1 ),
			hit( 'terrain', 5, 2 ),
			hit( 'terrain', Number.NaN, 3 ),
		] );
		port.pickTiles.mockReturnValue( [ hit( '3d-tile', 7, 4 ) ] );
		const result = new EditorSurfacePicker( port ).pick(
			{ clientX: 0, clientY: 0 },
			{ heightReference: HeightReference.CLAMP_TO_GROUND },
		);
		expect( result?.surface ).toBe( 'terrain' );
		expect( result?.surfacePosition[ 2 ] ).toBe( 2 );
	} );

	it( 'terrain/ground 可回退椭球，tile-only 永不跨目标回退', () => {
		const port = createPort();
		port.pickTerrain.mockReturnValue( [] );
		port.pickTiles.mockReturnValue( [] );
		const picker = new EditorSurfacePicker( port );
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} )?.surface ).toBe( 'ellipsoid' );
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.CLAMP_TO_TERRAIN,
			allowEllipsoidFallback: false,
		} ) ).toBeNull();
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.CLAMP_TO_3D_TILE,
		} ) ).toBeNull();
	} );

	it( '丢弃错误 surface 标签、非法坐标和非有限屏幕位置', () => {
		const port = createPort();
		port.pickTerrain.mockReturnValue( [ {
			...hit( '3d-tile', 1, 0 ),
			surfacePosition: [ 0, 100, 0 ],
		} ] );
		port.pickTiles.mockReturnValue( [] );
		port.pickEllipsoid.mockReturnValue( null );
		const picker = new EditorSurfacePicker( port );
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} ) ).toBeNull();
		expect( picker.pick( { clientX: Number.NaN, clientY: 0 }, {
			heightReference: HeightReference.NONE,
		} ) ).toBeNull();
	} );

	it( 'dispose 后不再访问宿主 raycast 端口', () => {
		const port = createPort();
		const picker = new EditorSurfacePicker( port );
		picker.dispose();
		picker.dispose();
		expect( picker.pick( { clientX: 0, clientY: 0 }, {
			heightReference: HeightReference.NONE,
		} ) ).toBeNull();
		expect( port.pickTerrain ).not.toHaveBeenCalled();
	} );
} );
