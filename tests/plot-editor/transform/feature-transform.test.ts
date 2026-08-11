import { describe, expect, it } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { geodesicDistanceMeters } from '../../../src/lib/plot-editor/document/geodesy';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { applyEnuTransformToFeature } from '../../../src/lib/plot-editor/transform/feature-transform';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );
const adapters = createBuiltinGeometryAdapterRegistry();

function base( patch: Record<string, unknown> ): PlotFeature {
	return normalizeFeature( {
		id: 'feature', type: 'circle', geometry: { center: [ 0, 0, 0 ], radius: 100 },
		style: STYLE, heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 3,
		...patch,
	} );
}

describe( 'applyEnuTransformToFeature', () => {
	it( '日期变更线附近 East 平移经 ECEF/ENU 计算并保持作者高度', () => {
		const source = base( { geometry: { center: [ 179.99, 0, 123 ], radius: 100 } } );
		const moved = applyEnuTransformToFeature( source, {
			pivot: [ 179.99, 0, 0 ], translationMeters: [ 5_000, 0, 0 ],
		}, adapters );
		if ( moved.type !== 'circle' || source.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( moved.geometry.center[ 0 ] ).toBeLessThan( -179.9 );
		expect( geodesicDistanceMeters( source.geometry.center, moved.geometry.center ) )
			.toBeCloseTo( 5_000, -1 );
		expect( moved.geometry.center[ 2 ] ).toBe( 123 );
		expect( moved.revision ).toBe( 4 );
	} );

	it( 'clamp 允许 East/North 且 author height 恒为 0，明确拒绝 Up', () => {
		const source = base( {
			heightReference: HeightReference.CLAMP_TO_TERRAIN,
			geometry: { center: [ 10, 20, 0 ], radius: 100 },
		} );
		const moved = applyEnuTransformToFeature( source, {
			pivot: [ 10, 20, 0 ], translationMeters: [ 100, 50, 0 ],
		}, adapters );
		if ( moved.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( moved.geometry.center[ 2 ] ).toBe( 0 );
		expect( () => applyEnuTransformToFeature( source, {
			pivot: [ 10, 20, 0 ], translationMeters: [ 0, 0, 1 ],
		}, adapters ) ).toThrow( /TRANSFORM_CAPABILITY_BLOCKED/ );
	} );

	it( 'absolute/relative Up 平移修改第三维，pitch/roll 只对支持的 adapter 开放', () => {
		const relative = base( {
			heightReference: HeightReference.RELATIVE_TO_GROUND,
			geometry: { center: [ 0, 0, 10 ], radius: 100 },
		} );
		const raised = applyEnuTransformToFeature( relative, {
			pivot: [ 0, 0, 10 ], translationMeters: [ 0, 0, 25 ],
		}, adapters );
		if ( raised.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( raised.geometry.center[ 2 ] ).toBeCloseTo( 35, 5 );

		const line = base( {
			type: 'line',
			geometry: { positions: [ [ 0, 0, 10 ], [ 0, 0.01, 10 ] ] },
			style: {
				...STYLE, strokeStyle: 'solid', showArrow: false,
				startArrowStyle: null, endArrowStyle: null,
			},
		} );
		const pitched = applyEnuTransformToFeature( line, {
			pivot: [ 0, 0, 10 ], rotationDegrees: [ 0, 30, 0 ],
		}, adapters );
		if ( pitched.type !== 'line' ) expect.fail( '应为 line' );
		expect( pitched.geometry.positions[ 1 ][ 2 ] ).toBeGreaterThan( 100 );
		expect( () => applyEnuTransformToFeature( relative, {
			pivot: [ 0, 0, 10 ], rotationDegrees: [ 0, 10, 0 ],
		}, adapters ) ).toThrow( /TRANSFORM_CAPABILITY_BLOCKED/ );
	} );

	it( 'heading 绕公共 pivot 旋转 source points，并更新参数化 heading', () => {
		const point = base( {
			type: 'point', geometry: { position: [ 0.01, 0, 0 ] },
			style: {
				...STYLE, pointStyle: 'image', imageUrl: '/pin.png',
				imageWidth: 20, imageHeight: 30, rotation: 350,
			},
		} );
		const rotated = applyEnuTransformToFeature( point, {
			pivot: [ 0, 0, 0 ], rotationDegrees: [ 20, 0, 0 ],
		}, adapters );
		if ( rotated.type !== 'point' || rotated.style.pointStyle !== 'image' ) expect.fail( '应为 image point' );
		expect( rotated.style.rotation ).toBeCloseTo( 10 );
		expect( rotated.geometry.position[ 1 ] ).toBeLessThan( 0 );
	} );

	it( 'circle/sector 仅允许等比水平缩放，半径和 startAngle 同步', () => {
		const circle = base( {} );
		expect( () => applyEnuTransformToFeature( circle, {
			pivot: [ 0, 0, 0 ], scale: [ 2, 1, 1 ],
		}, adapters ) ).toThrow( /TRANSFORM_INCOMPATIBLE_ADAPTER/ );
		const scaled = applyEnuTransformToFeature( circle, {
			pivot: [ 0, 0, 0 ], scale: [ 2, 2, 1 ],
		}, adapters );
		if ( scaled.type !== 'circle' ) expect.fail( '应为 circle' );
		expect( scaled.geometry.radius ).toBe( 200 );

		const sector = base( {
			type: 'sector',
			geometry: { center: [ 0, 0, 0 ], radius: 50, startAngle: 350, sectorAngle: 60 },
		} );
		const transformed = applyEnuTransformToFeature( sector, {
			pivot: [ 0, 0, 0 ], rotationDegrees: [ 20, 0, 0 ], scale: [ 3, 3, 1 ],
		}, adapters );
		if ( transformed.type !== 'sector' ) expect.fail( '应为 sector' );
		expect( transformed.geometry ).toMatchObject( { radius: 150, startAngle: 10, sectorAngle: 60 } );
	} );

	it( '箭头只变换 source controls，JSON 不会写入 generated ring', () => {
		const arrow = base( {
			type: 'arrow',
			geometry: {
				positions: [ [ 0, 0, 0 ], [ 0.01, 0, 0 ] ],
				arrowType: 'fine', sizeScale: 1,
			},
		} );
		const transformed = applyEnuTransformToFeature( arrow, {
			pivot: [ 0, 0, 0 ], translationMeters: [ 10, 20, 0 ],
		}, adapters );
		if ( transformed.type !== 'arrow' ) expect.fail( '应为 arrow' );
		expect( transformed.geometry.positions ).toHaveLength( 2 );
		expect( JSON.stringify( transformed ) ).not.toContain( 'generated' );
	} );

	it( '拒绝非正、过大或非有限 scale', () => {
		const circle = base( {} );
		for ( const scale of [ [ 0, 1, 1 ], [ 1e9, 1e9, 1 ], [ Number.NaN, 1, 1 ] ] ) {
			expect( () => applyEnuTransformToFeature( circle, {
				pivot: [ 0, 0, 0 ], scale: scale as [ number, number, number ],
			}, adapters ) ).toThrow( /TRANSFORM_INVALID/ );
		}
	} );
} );
