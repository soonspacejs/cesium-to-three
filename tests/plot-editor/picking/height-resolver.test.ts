import { describe, expect, it, vi } from 'vitest';

import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import {
	HeightResolutionManager,
	resolveFeatureHeights,
	resolvePositionsHeights,
} from '../../../src/lib/plot-editor/picking/height-resolver';
import type {
	HeightSample,
	HeightSampleRequest,
} from '../../../src/lib/plot-editor/picking/types';

const commonStyle = {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
};

function line( id: string, heightReference = HeightReference.RELATIVE_TO_TERRAIN, revision = 0 ) {
	return {
		id,
		type: 'line',
		geometry: { positions: [ [ 179.9, 30, 5 ], [ -179.9, 31, -2 ] ] },
		style: {
			...commonStyle,
			strokeStyle: 'solid',
			showArrow: false,
			startArrowStyle: null,
			endArrowStyle: null,
		},
		heightReference,
		visible: true,
		properties: {},
		revision,
	};
}

function samples(
	request: HeightSampleRequest,
	heights: readonly ( number | null )[] = [ 100, 200 ],
): HeightSample[] {
	return request.positions.map( ( position, index ) => ( {
		longitude: position[ 0 ],
		latitude: position[ 1 ],
		surfaceHeight: heights[ index ],
		source: heights[ index ] === null ? null : 'terrain',
	} ) );
}

function provider(
	implementation: ( request: HeightSampleRequest ) => Promise<readonly HeightSample[]>,
) {
	let listener: ( () => void ) | undefined;
	const unsubscribe = vi.fn();
	return {
		api: {
			sampleHeights: vi.fn( implementation ),
			subscribe: vi.fn( ( next: () => void ) => {
				listener = next;
				return unsubscribe;
			} ),
		},
		invalidate: () => listener?.(),
		unsubscribe,
	};
}

describe( 'resolveFeatureHeights', () => {
	it( '任意草稿 position 列表复用同一套 relative 表面解析', async () => {
		const source = provider( async ( request ) => samples( request ) );
		const result = await resolvePositionsHeights(
			[ [ 179.9, 30, 5 ], [ -179.9, 31, -2 ] ],
			HeightReference.RELATIVE_TO_TERRAIN,
			source.api,
			new AbortController().signal,
		);
		expect( result ).toEqual( {
			status: 'ready',
			effectivePositions: [ [ 179.9, 30, 105 ], [ -179.9, 31, 198 ] ],
		} );
	} );

	it( 'NONE 直接保留作者绝对高度且不访问 provider', async () => {
		const source = provider( async ( request ) => samples( request ) );
		const feature = line( 'line', HeightReference.NONE ) as never;
		const result = await resolveFeatureHeights(
			feature,
			source.api,
			new AbortController().signal,
		);
		expect( result ).toMatchObject( {
			status: 'ready',
			effectivePositions: [ [ 179.9, 30, 5 ], [ -179.9, 31, -2 ] ],
		} );
		expect( source.api.sampleHeights ).not.toHaveBeenCalled();
	} );

	it( 'RELATIVE 将表面绝对高与逐点 offset 相加，作者 feature 保持不变', async () => {
		const source = provider( async ( request ) => samples( request ) );
		const feature = line( 'line' );
		const before = JSON.stringify( feature );
		const result = await resolveFeatureHeights(
			feature as never,
			source.api,
			new AbortController().signal,
		);
		expect( result.effectivePositions ).toEqual( [
			[ 179.9, 30, 105 ],
			[ -179.9, 31, 198 ],
		] );
		expect( result.status ).toBe( 'ready' );
		expect( JSON.stringify( feature ) ).toBe( before );
		expect( source.api.sampleHeights ).toHaveBeenCalledWith( expect.objectContaining( {
			target: 'terrain',
		} ) );
	} );

	it( 'CLAMP 解析运行时表面高度但不使用作者第三维', async () => {
		const source = provider( async ( request ) => samples( request ) );
		const feature = line( 'line', HeightReference.CLAMP_TO_GROUND );
		feature.geometry.positions = [ [ 10, 20, 0 ], [ 11, 21, 0 ] ];
		const result = await resolveFeatureHeights(
			feature as never,
			source.api,
			new AbortController().signal,
		);
		expect( result.effectivePositions.map( ( position ) => position[ 2 ] ) )
			.toEqual( [ 100, 200 ] );
		expect( source.api.sampleHeights.mock.calls[ 0 ][ 0 ].target ).toBe( 'ground' );
	} );

	it( '派生轮廓逐顶点解析表面高度，不把扇心高度复用到整片扇形', async () => {
		const source = provider( async ( request ) => request.positions.map( ( position, index ) => ( {
			longitude: position[ 0 ],
			latitude: position[ 1 ],
			surfaceHeight: 100 + index * 10,
			source: 'terrain' as const,
		} ) ) );
		const feature = {
			id: 'sector', type: 'sector', geometry: {
				center: [ 116, 39, 0 ], radius: 100, startAngle: 0, sectorAngle: 90,
			},
			style: commonStyle,
			heightReference: HeightReference.CLAMP_TO_GROUND,
			visible: true, properties: {}, revision: 0,
		} as const;
		const renderPositions = [
			[ 116, 39, 0 ], [ 116.001, 39, 0 ], [ 116, 39.001, 0 ],
		] as const;
		const result = await resolveFeatureHeights(
			feature as never,
			source.api,
			new AbortController().signal,
			undefined,
			renderPositions,
		);
		expect( result.effectivePositions ).toEqual( [ [ 116, 39, 100 ] ] );
		expect( result.effectiveRenderPositions ).toEqual( [
			[ 116, 39, 100 ], [ 116.001, 39, 110 ], [ 116, 39.001, 120 ],
		] );
		expect( result.status ).toBe( 'ready' );
	} );

	it( 'ground/terrain 首次缺失用椭球零高 pending 兜底', async () => {
		const source = provider( async ( request ) => samples( request, [ null, 200 ] ) );
		const result = await resolveFeatureHeights(
			line( 'line' ) as never,
			source.api,
			new AbortController().signal,
		);
		expect( result.status ).toBe( 'pending' );
		expect( result.surfaceIncomplete ).toBe( true );
		expect( result.effectivePositions ).toEqual( [
			[ 179.9, 30, 5 ],
			[ -179.9, 31, 198 ],
		] );
	} );

	it( 'tile-only 首次缺失 unavailable，有旧完整结果时整幅沿用', async () => {
		const source = provider( async ( request ) => request.positions.map( ( position ) => ( {
			longitude: position[ 0 ], latitude: position[ 1 ], surfaceHeight: null, source: null,
		} ) ) );
		const feature = line( 'line', HeightReference.RELATIVE_TO_3D_TILE ) as never;
		const unavailable = await resolveFeatureHeights(
			feature,
			source.api,
			new AbortController().signal,
		);
		expect( unavailable ).toMatchObject( { status: 'unavailable', effectivePositions: [] } );
		const previous = {
			plotId: 'line', sourceRevision: 0, status: 'ready' as const,
			effectivePositions: [ [ 179.9, 30, 105 ], [ -179.9, 31, 198 ] ] as const,
		};
		const pending = await resolveFeatureHeights(
			feature,
			source.api,
			new AbortController().signal,
			previous,
		);
		expect( pending.status ).toBe( 'pending' );
		expect( pending.effectivePositions ).toEqual( previous.effectivePositions );
	} );

	it( '文档 revision 或作者坐标改变后不复用旧 surface 结果', async () => {
		const source = provider( async ( request ) => samples( request, [ null, null ] ) );
		const changed = line( 'line', HeightReference.RELATIVE_TO_TERRAIN, 1 );
		changed.geometry.positions = [ [ 120, 35, 7 ], [ 121, 36, 8 ] ];
		const previous = {
			plotId: 'line', sourceRevision: 0, status: 'ready' as const,
			effectivePositions: [ [ 179.9, 30, 105 ], [ -179.9, 31, 198 ] ] as const,
		};
		const result = await resolveFeatureHeights(
			changed as never,
			source.api,
			new AbortController().signal,
			previous,
		);
		expect( result ).toMatchObject( {
			plotId: 'line', sourceRevision: 1, status: 'pending',
			effectivePositions: [ [ 120, 35, 7 ], [ 121, 36, 8 ] ],
		} );
	} );

	it.each( [
		[ '数量不一致', async ( request: HeightSampleRequest ) => samples( request ).slice( 0, 1 ) ],
		[ '非有限高度', async ( request: HeightSampleRequest ) => samples( request, [ Number.NaN, 2 ] ) ],
		[ '经纬度错位', async ( request: HeightSampleRequest ) => {
			const result = samples( request );
			result[ 0 ] = { ...result[ 0 ], longitude: 10 };
			return result;
		} ],
		[ '错误 source', async ( request: HeightSampleRequest ) => samples( request ).map(
			( item ) => ( { ...item, source: '3d-tile' as const } ),
		) ],
	] )( '拒绝 provider %s', async ( _name, implementation ) => {
		const source = provider( implementation );
		await expect( resolveFeatureHeights(
			line( 'line' ) as never,
			source.api,
			new AbortController().signal,
		) ).rejects.toThrowError();
	} );
} );

describe( 'HeightResolutionManager 竞态与生命周期', () => {
	it( '只有 id/revision/reference 仍匹配的结果才能发布', async () => {
		let resolveSamples!: ( value: readonly HeightSample[] ) => void;
		const source = provider( ( request ) => new Promise( ( resolve ) => {
			resolveSamples = resolve;
			void request;
		} ) );
		const document = createPlotDocumentStore( {
			id: 'document', features: [ line( 'line' ) ],
		} );
		const onResolved = vi.fn();
		const manager = new HeightResolutionManager( {
			provider: source.api,
			document,
			onResolved,
		} );
		const pending = manager.resolve( document.get( 'line' )! );
		document.commitCandidate( {
			features: [ line( 'line', HeightReference.RELATIVE_TO_TERRAIN, 1 ) as never ],
			order: [ 'line' ],
			label: '外部修改',
			commandType: 'test',
			affectedIds: [ 'line' ],
		} );
		resolveSamples( samples( { positions: [ [ 179.9, 30, 5 ], [ -179.9, 31, -2 ] ], target: 'terrain', signal: new AbortController().signal } ) );
		expect( await pending ).toEqual( { accepted: false } );
		expect( onResolved ).not.toHaveBeenCalled();
	} );

	it( '同一 plot 的新 generation 会 abort 并淘汰旧请求，即使 provider 忽略 abort', async () => {
		const resolvers: Array<( value: readonly HeightSample[] ) => void> = [];
		const requests: HeightSampleRequest[] = [];
		const source = provider( ( request ) => new Promise( ( resolve ) => {
			requests.push( request );
			resolvers.push( resolve );
		} ) );
		const document = createPlotDocumentStore( { id: 'document', features: [ line( 'line' ) ] } );
		const manager = new HeightResolutionManager( { provider: source.api, document } );
		const first = manager.resolve( document.get( 'line' )! );
		const second = manager.resolve( document.get( 'line' )! );
		expect( requests[ 0 ].signal.aborted ).toBe( true );
		resolvers[ 0 ]( samples( requests[ 0 ] ) );
		resolvers[ 1 ]( samples( requests[ 1 ] ) );
		expect( await first ).toEqual( { accepted: false } );
		expect( await second ).toMatchObject( { accepted: true, result: { status: 'ready' } } );
	} );

	it( 'provider invalidate 中止活动请求并增加 surface revision', async () => {
		let request!: HeightSampleRequest;
		const source = provider( ( next ) => new Promise( () => {
			request = next;
		} ) );
		const document = createPlotDocumentStore( { id: 'document', features: [ line( 'line' ) ] } );
		const onInvalidate = vi.fn();
		const manager = new HeightResolutionManager( {
			provider: source.api, document, onInvalidate,
		} );
		void manager.resolve( document.get( 'line' )! );
		source.invalidate();
		expect( request.signal.aborted ).toBe( true );
		expect( manager.surfaceRevision ).toBe( 1 );
		expect( onInvalidate ).toHaveBeenCalledWith( 1 );
	} );

	it( '非 Abort provider 错误只报告诊断，不修改 document', async () => {
		const source = provider( async () => {
			throw new Error( 'provider failed' );
		} );
		const document = createPlotDocumentStore( { id: 'document', features: [ line( 'line' ) ] } );
		const onError = vi.fn();
		const manager = new HeightResolutionManager( { provider: source.api, document, onError } );
		const before = document.snapshot();
		expect( await manager.resolve( document.get( 'line' )! ) ).toEqual( { accepted: false } );
		expect( onError ).toHaveBeenCalledWith( expect.any( Error ), 'line' );
		expect( document.snapshot() ).toEqual( before );
	} );

	it( 'dispose 幂等解除订阅、abort 请求并清空 cache', async () => {
		let request!: HeightSampleRequest;
		const source = provider( ( next ) => new Promise( () => {
			request = next;
		} ) );
		const document = createPlotDocumentStore( { id: 'document', features: [ line( 'line' ) ] } );
		const manager = new HeightResolutionManager( { provider: source.api, document } );
		void manager.resolve( document.get( 'line' )! );
		manager.dispose();
		manager.dispose();
		expect( request.signal.aborted ).toBe( true );
		expect( source.unsubscribe ).toHaveBeenCalledOnce();
		expect( await manager.resolve( document.get( 'line' )! ) ).toEqual( { accepted: false } );
	} );
} );
