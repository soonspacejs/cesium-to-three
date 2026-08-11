import { describe, expect, it } from 'vitest';
import { ClassificationType } from '../../../src/lib/ground/types';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature, type ResolvedPlotGeometry } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import {
	PlotRenderProjection,
	RenderDirtyFlag,
	diffRenderFeature,
} from '../../../src/lib/plot-editor/render/RenderProjection';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );
const projection = new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() );

function circle(
	heightReference = HeightReference.NONE,
	revision = 0,
): PlotFeature {
	return normalizeFeature( {
		id: 'circle', type: 'circle', geometry: { center: [ 10, 20, heightReference === HeightReference.NONE ? 30 : 0 ], radius: 1_000 },
		style: STYLE, heightReference, visible: true, properties: {}, revision,
	} );
}

function resolved(
	revision: number,
	height: number,
	status: ResolvedPlotGeometry[ 'status' ] = 'ready',
): ResolvedPlotGeometry {
	return Object.freeze( {
		plotId: 'circle', sourceRevision: revision,
		effectivePositions: Object.freeze( status === 'unavailable' ? [] : [ [ 10, 20, height ] ] ),
		status,
	} );
}

describe( 'PlotRenderProjection', () => {
	it( '七值高度参考逐项选择稳定渲染路径并分离作者高度与世界高度', () => {
		const cases = [
			[ HeightReference.NONE, 'plain-rte', undefined, 30, 30 ],
			[ HeightReference.CLAMP_TO_GROUND, 'ground-classification', ClassificationType.BOTH, 0, 100 ],
			[ HeightReference.RELATIVE_TO_GROUND, 'plain-rte', undefined, 7, 100 ],
			[ HeightReference.CLAMP_TO_TERRAIN, 'ground-classification', ClassificationType.TERRAIN, 0, 100 ],
			[ HeightReference.RELATIVE_TO_TERRAIN, 'plain-rte', undefined, 7, 100 ],
			[ HeightReference.CLAMP_TO_3D_TILE, 'ground-classification', ClassificationType.CESIUM_3D_TILE, 0, 100 ],
			[ HeightReference.RELATIVE_TO_3D_TILE, 'plain-rte', undefined, 7, 100 ],
		] as const;

		for ( const [ heightReference, path, classificationType, authorHeight, worldHeight ] of cases ) {
			const feature = heightReference === HeightReference.NONE
				? circle( heightReference )
				: normalizeFeature( {
					...circle( heightReference ),
					geometry: { center: [ 10, 20, authorHeight ], radius: 1_000 },
				} );
			const render = projection.projectFeature( feature, heightReference === HeightReference.NONE
				? undefined
				: { resolved: new Map( [ [ 'circle', resolved( 0, worldHeight ) ] ] ) } );
			expect( render ).toMatchObject( {
				path,
				surfaceStatus: 'ready',
				visible: true,
			} );
			expect( render.classificationType ).toBe( classificationType );
			expect( render.vertices.every( ( vertex ) =>
				vertex.authorHeight === authorHeight
				&& vertex.resolvedWorldHeight === worldHeight ) ).toBe( true );
		}
	} );

	it( 'NONE 明确走 Plain/RTE，author/world 高度分栏且相等', () => {
		const render = projection.projectFeature( circle() );
		expect( render ).toMatchObject( {
			id: 'circle', type: 'circle', path: 'plain-rte',
			surfaceStatus: 'ready', surfacePending: false, visible: true,
		} );
		expect( render.vertices.every( ( vertex ) =>
			vertex.authorHeight === 30 && vertex.resolvedWorldHeight === 30 ) ).toBe( true );
	} );

	it( '三种 clamp 走 classification，author height 仍为 0', () => {
		const cases = [
			[ HeightReference.CLAMP_TO_GROUND, ClassificationType.BOTH ],
			[ HeightReference.CLAMP_TO_TERRAIN, ClassificationType.TERRAIN ],
			[ HeightReference.CLAMP_TO_3D_TILE, ClassificationType.CESIUM_3D_TILE ],
		] as const;
		for ( const [ heightReference, classificationType ] of cases ) {
			const feature = circle( heightReference );
			const result = resolved( 0, 88 );
			const render = projection.projectFeature( feature, {
				resolved: new Map( [ [ 'circle', result ] ] ),
			} );
			expect( render ).toMatchObject( {
				path: 'ground-classification', classificationType,
				surfaceStatus: 'ready',
			} );
			expect( render.vertices.every( ( vertex ) =>
				vertex.authorHeight === 0 && vertex.resolvedWorldHeight === 88 ) ).toBe( true );
		}
	} );

	it( 'relative 保留 author offset，resolved world = surface + offset', () => {
		const feature = normalizeFeature( {
			...circle( HeightReference.RELATIVE_TO_TERRAIN ),
			geometry: { center: [ 10, 20, 12 ], radius: 1_000 },
		} );
		const render = projection.projectFeature( feature, {
			resolved: new Map( [ [ 'circle', resolved( 0, 112 ) ] ] ),
		} );
		expect( render.path ).toBe( 'plain-rte' );
		expect( render.sourceVertices[ 0 ] ).toMatchObject( {
			authorHeight: 12, resolvedWorldHeight: 112,
		} );
		expect( render.vertices.every( ( vertex ) =>
			vertex.authorHeight === 12 && vertex.resolvedWorldHeight === 112 ) ).toBe( true );
	} );

	it( 'ground/terrain 缺样本明确 pending fallback；3D Tile 缺样本 unavailable 隐藏', () => {
		const terrain = projection.projectFeature( circle( HeightReference.CLAMP_TO_TERRAIN ) );
		expect( terrain ).toMatchObject( {
			surfaceStatus: 'pending', surfacePending: true, visible: true,
		} );
		const tile = projection.projectFeature( circle( HeightReference.CLAMP_TO_3D_TILE ) );
		expect( tile ).toMatchObject( {
			surfaceStatus: 'unavailable', surfacePending: false, visible: false,
		} );
	} );

	it( 'stale resolved revision 被拒绝，不会覆盖新 feature', () => {
		const feature = circle( HeightReference.RELATIVE_TO_GROUND, 2 );
		const render = projection.projectFeature( feature, {
			resolved: new Map( [ [ 'circle', resolved( 1, 999 ) ] ] ),
		} );
		expect( render.surfaceStatus ).toBe( 'pending' );
		expect( render.vertices[ 0 ].resolvedWorldHeight ).toBe( 0 );
	} );

	it( 'arrow DTO 只从 source controls 派生 footprint，不向文档写 generated 字段', () => {
		const arrow = normalizeFeature( {
			id: 'arrow', type: 'arrow',
			geometry: {
				positions: [ [ 0, 0, 0 ], [ 0.01, 0, 0 ] ],
				arrowType: 'fine', sizeScale: 1,
			},
			style: STYLE, heightReference: HeightReference.NONE,
			visible: true, properties: {}, revision: 0,
		} );
		const render = projection.projectFeature( arrow );
		expect( render.generated ).toBe( true );
		expect( render.vertices.length ).toBeGreaterThan( render.sourceVertices.length );
		expect( JSON.stringify( arrow ) ).not.toContain( 'generated' );
	} );

	it( 'surface 重采样单独标记 HeightResolution，不要求 document revision 变化', () => {
		const feature = circle( HeightReference.RELATIVE_TO_GROUND );
		const previous = projection.projectFeature( feature, {
			resolved: new Map( [ [ 'circle', resolved( 0, 10 ) ] ] ),
		} );
		const next = projection.projectFeature( feature, {
			resolved: new Map( [ [ 'circle', resolved( 0, 20 ) ] ] ),
		} );
		const dirty = diffRenderFeature( previous, next );
		expect( dirty & RenderDirtyFlag.HeightResolution ).not.toBe( 0 );
		expect( dirty & RenderDirtyFlag.Geometry ).toBe( 0 );
	} );
} );
