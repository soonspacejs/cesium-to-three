import { describe, expect, it } from 'vitest';

import { ClassificationType } from '../../../src/lib/ground/types';
import {
	legacyClassificationForHeightReference,
	migrateLegacyPlotItem,
} from '../../../src/lib/plot-editor/document/migrations';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

const common = {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
	visible: true,
};

function migrate( type: string, options: Record<string, unknown> ) {
	return migrateLegacyPlotItem(
		{ type, options: { ...common, ...options } },
		{ idGenerator: () => `generated-${ type }` },
	);
}

describe( '旧高度字段迁移', () => {
	it.each( [
		[ undefined, HeightReference.CLAMP_TO_GROUND ],
		[ ClassificationType.BOTH, HeightReference.CLAMP_TO_GROUND ],
		[ ClassificationType.TERRAIN, HeightReference.CLAMP_TO_TERRAIN ],
		[ ClassificationType.CESIUM_3D_TILE, HeightReference.CLAMP_TO_3D_TILE ],
		[ 'TERRAIN', HeightReference.CLAMP_TO_TERRAIN ],
		[ 'CESIUM_3D_TILE', HeightReference.CLAMP_TO_3D_TILE ],
	] )( 'classificationType=%s 映射到对应 CLAMP', ( classificationType, expected ) => {
		const { feature } = migrate( 'circle', {
			points: [ [ 120, 30 ] ],
			radius: 10,
			classificationType,
		} );
		expect( feature.heightReference ).toBe( expected );
		if ( feature.type !== 'circle' ) {
			expect.fail( '应当迁移为 circle' );
		}
		expect( feature.geometry.center ).toEqual( [ 120, 30, 0 ] );
	} );

	it( 'clampToGround=false 将二维点的 heightMeters 写入每点第三维', () => {
		const result = migrate( 'line', {
			points: [ [ 120, 30 ], [ 121, 31 ] ],
			clampToGround: false,
			heightMeters: 88,
			strokeStyle: 'solid',
			showArrow: false,
		} );
		expect( result.feature.heightReference ).toBe( HeightReference.NONE );
		if ( result.feature.type !== 'line' ) {
			expect.fail( '应当迁移为 line' );
		}
		expect( result.feature.geometry.positions ).toEqual( [
			[ 120, 30, 88 ],
			[ 121, 31, 88 ],
		] );
		expect( result.diagnostics.map( ( item ) => item.code ) ).toEqual(
			expect.arrayContaining( [
				'LEGACY_INPUT_MIGRATED',
				'LEGACY_ID_GENERATED',
				'LEGACY_HEIGHT_REFERENCE_INFERRED',
				'LEGACY_HEIGHT_METERS_MIGRATED',
				'LEGACY_2D_POSITION_MIGRATED',
			] ),
		);
	} );

	it( '正式 heightReference 与旧字段冲突时默认拒绝', () => {
		expect( () => migrate( 'circle', {
			points: [ [ 0, 0 ] ],
			radius: 1,
			heightReference: 'NONE',
			clampToGround: true,
		} ) ).toThrowError( /语义冲突/ );
	} );

	it( '人工修复策略可显式保留新 heightReference 并报告 warning', () => {
		const result = migrateLegacyPlotItem( {
			type: 'circle',
			options: {
				...common,
				points: [ [ 0, 0 ] ],
				radius: 1,
				heightReference: 'NONE',
				clampToGround: true,
			},
		}, {
			idGenerator: () => 'fixed',
			heightConflictPolicy: 'prefer-height-reference',
		} );
		expect( result.feature.heightReference ).toBe( HeightReference.NONE );
		expect( result.diagnostics ).toEqual( expect.arrayContaining( [
			expect.objectContaining( {
				code: 'LEGACY_HEIGHT_REFERENCE_CONFLICT_IGNORED',
				severity: 'warning',
			} ),
		] ) );
	} );
} );

describe( '八类旧 plot 快照', () => {
	it.each( [
		[ 'point', { points: [ [ 0, 0 ] ], pointStyle: 'circle', size: 8 } ],
		[ 'line', {
			points: [ [ 0, 0 ], [ 0.01, 0.01 ] ],
			strokeStyle: 'solid',
			showArrow: false,
		} ],
		[ 'polygon', { points: [ [ 0, 0 ], [ 0.01, 0 ], [ 0, 0.01 ] ] } ],
		[ 'rectangle', { points: [
			[ 0, 0 ],
			[ 0.01, 0 ],
			[ 0.01, 0.01 ],
			[ 0, 0.01 ],
		] } ],
		[ 'sector', { points: [ [ 0, 0 ] ], radius: 10, startAngle: 0, sectorAngle: 90 } ],
		[ 'arrow', {
			points: [ [ 0, 0 ], [ 0.01, 0.01 ] ],
			arrowType: 'fine',
			sizeScale: 1,
		} ],
		[ 'text', { points: [ [ 0, 0 ] ], content: '迁移文本' } ],
		[ 'circle', { points: [ [ 0, 0 ] ], radius: 10 } ],
	] )( '完整迁移 %s 并清除旧字段', ( type, options ) => {
		const result = migrate( type, options );
		expect( result.feature.type ).toBe( type );
		expect( result.feature.id ).toBe( `generated-${ type }` );
		expect( result.feature ).not.toHaveProperty( 'options' );
		expect( result.feature ).not.toHaveProperty( 'clampToGround' );
		expect( JSON.stringify( result.feature ) ).not.toContain( 'heightMeters' );
	} );

	it( '保留旧快照已有的稳定 id', () => {
		const result = migrateLegacyPlotItem( {
			id: 'saved-id',
			type: 'circle',
			options: { ...common, points: [ [ 0, 0 ] ], radius: 1 },
		}, { idGenerator: () => 'unused' } );
		expect( result.feature.id ).toBe( 'saved-id' );
		expect( result.diagnostics.some( ( item ) => item.code === 'LEGACY_ID_GENERATED' ) )
			.toBe( false );
	} );

	it( '拒绝模型、tileset 与未知 classification', () => {
		expect( () => migrate( 'model', { points: [ [ 0, 0 ] ] } ) )
			.toThrowError( /不能迁移/ );
		expect( () => migrate( 'circle', {
			points: [ [ 0, 0 ] ], radius: 1, classificationType: 99,
		} ) ).toThrowError( /classificationType/ );
	} );
} );

describe( '旧分类反向适配', () => {
	it( '只投影到现有 renderer 可表达的 classification', () => {
		expect( legacyClassificationForHeightReference( HeightReference.NONE ) ).toBeUndefined();
		expect( legacyClassificationForHeightReference( HeightReference.CLAMP_TO_GROUND ) )
			.toBe( ClassificationType.BOTH );
		expect( legacyClassificationForHeightReference( HeightReference.RELATIVE_TO_TERRAIN ) )
			.toBe( ClassificationType.TERRAIN );
		expect( legacyClassificationForHeightReference( HeightReference.CLAMP_TO_3D_TILE ) )
			.toBe( ClassificationType.CESIUM_3D_TILE );
	} );
} );
