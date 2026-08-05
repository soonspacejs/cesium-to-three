import { describe, expect, it } from 'vitest';
import { ClassificationType } from '../../../src/lib/ground/types';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { adaptRenderFeatureToLegacyPlot } from '../../../src/lib/plot-editor/render/LegacyPlotAdapter';
import { PlotRenderProjection } from '../../../src/lib/plot-editor/render/RenderProjection';

const STYLE = Object.freeze( {
	strokeColor: '#fff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#08f', fillOpacity: 40,
} );
const projection = new PlotRenderProjection( createBuiltinGeometryAdapterRegistry() );

function allFeatures(): readonly PlotFeature[] {
	const common = {
		style: STYLE, heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0,
	};
	return [
		normalizeFeature( {
			...common, id: 'point', type: 'point', geometry: { position: [ 0, 0, 5 ] },
			style: { ...STYLE, pointStyle: 'circle', size: 10 },
		} ),
		normalizeFeature( {
			...common, id: 'line', type: 'line', geometry: { positions: [ [ 0, 0, 5 ], [ 1, 0, 5 ] ] },
			style: {
				...STYLE, strokeStyle: 'solid', showArrow: false,
				startArrowStyle: null, endArrowStyle: null,
			},
		} ),
		normalizeFeature( {
			...common, id: 'polygon', type: 'polygon',
			geometry: { positions: [ [ 0, 0, 5 ], [ 1, 0, 5 ], [ 0, 1, 5 ] ] },
		} ),
		normalizeFeature( {
			...common, id: 'rectangle', type: 'rectangle',
			geometry: { positions: [ [ 0, 0, 5 ], [ 1, 0, 5 ], [ 1, 1, 5 ], [ 0, 1, 5 ] ] },
		} ),
		normalizeFeature( {
			...common, id: 'circle', type: 'circle', geometry: { center: [ 0, 0, 5 ], radius: 100 },
		} ),
		normalizeFeature( {
			...common, id: 'sector', type: 'sector',
			geometry: { center: [ 0, 0, 5 ], radius: 100, startAngle: 10, sectorAngle: 90 },
		} ),
		normalizeFeature( {
			...common, id: 'arrow', type: 'arrow',
			geometry: {
				positions: [ [ 0, 0, 5 ], [ 1, 0, 5 ] ],
				arrowType: 'fine', sizeScale: 1,
			},
		} ),
		normalizeFeature( {
			...common, id: 'text', type: 'text', geometry: { position: [ 0, 0, 5 ] },
			style: {
				...STYLE, content: '中文', fontColor: '#fff', fontSize: 16, scale: 1,
				textAlign: 'center', verticalAlign: 'middle', anchorX: 'center', anchorY: 'middle',
				boxWidth: 120, boxHeight: 40, padding: [ 1, 2, 3, 4 ],
				layoutDirection: 'horizontal', rotation: 0, offsetX: 0, offsetY: 0,
				showBorder: true,
			},
		} ),
	];
}

describe( 'adaptRenderFeatureToLegacyPlot', () => {
	it( '八类 canonical feature 均映射旧判别联合，统一高度不丢失', () => {
		for ( const feature of allFeatures() ) {
			const render = projection.projectFeature( feature );
			const result = adaptRenderFeatureToLegacyPlot( feature, render );
			expect( result.supported ).toBe( true );
			if ( ! result.supported ) continue;
			expect( result.options.type ).toBe( feature.type );
			expect( result.options.heightMeters ).toBe( 5 );
			expect( result.options.clampToGround ).toBe( false );
			expect( result.options.points.every( ( point ) => point.length === 2 ) ).toBe( true );
		}
	} );

	it( 'clamp 明确映射 classificationType，不携带伪造高度', () => {
		const feature = normalizeFeature( {
			...allFeatures().find( ( candidate ) => candidate.type === 'circle' ),
			heightReference: HeightReference.CLAMP_TO_3D_TILE,
			geometry: { center: [ 0, 0, 0 ], radius: 100 },
		} );
		const render = projection.projectFeature( feature, {
			resolved: new Map( [ [ feature.id, {
				plotId: feature.id, sourceRevision: 0,
				effectivePositions: [ [ 0, 0, 88 ] ], status: 'ready' as const,
			} ] ] ),
		} );
		const result = adaptRenderFeatureToLegacyPlot( feature, render );
		if ( ! result.supported ) expect.fail( result.message );
		expect( result.options ).toMatchObject( {
			clampToGround: true,
			classificationType: ClassificationType.CESIUM_3D_TILE,
		} );
		expect( 'heightMeters' in result.options ).toBe( false );
	} );

	it( '逐顶点高度明确拒绝旧 heightMeters，不取平均值', () => {
		const feature = normalizeFeature( {
			...allFeatures().find( ( candidate ) => candidate.type === 'line' ),
			heightReference: HeightReference.RELATIVE_TO_TERRAIN,
			geometry: { positions: [ [ 0, 0, 1 ], [ 1, 0, 2 ] ] },
		} );
		const render = projection.projectFeature( feature, {
			resolved: new Map( [ [ feature.id, {
				plotId: feature.id, sourceRevision: 0,
				effectivePositions: [ [ 0, 0, 101 ], [ 1, 0, 202 ] ], status: 'ready' as const,
			} ] ] ),
		} );
		expect( adaptRenderFeatureToLegacyPlot( feature, render ) ).toMatchObject( {
			supported: false, reason: 'VARIABLE_VERTEX_HEIGHT',
		} );
	} );

	it( '3D Tile surface unavailable 时不创建错误 fallback 图元', () => {
		const feature = normalizeFeature( {
			...allFeatures().find( ( candidate ) => candidate.type === 'circle' ),
			heightReference: HeightReference.RELATIVE_TO_3D_TILE,
			geometry: { center: [ 0, 0, 0 ], radius: 100 },
		} );
		const render = projection.projectFeature( feature );
		expect( adaptRenderFeatureToLegacyPlot( feature, render ) ).toMatchObject( {
			supported: false, reason: 'SURFACE_UNAVAILABLE',
		} );
	} );
} );
