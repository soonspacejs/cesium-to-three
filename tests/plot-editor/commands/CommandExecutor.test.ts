import { describe, expect, it, vi } from 'vitest';

import {
	CommandExecutor,
	createVertexId,
} from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';

const commonStyle = {
	strokeColor: '#ffffff',
	strokeWidth: 2,
	strokeOpacity: 100,
	fillColor: '#3388ff',
	fillOpacity: 50,
};

function circle( id: string, longitude = 0, heightReference = HeightReference.NONE ) {
	return {
		id,
		type: 'circle',
		geometry: { center: [ longitude, 30, 0 ], radius: 100 },
		style: commonStyle,
		heightReference,
		visible: true,
		properties: {},
		revision: 0,
	};
}

function line( id: string ) {
	return {
		id,
		type: 'line',
		geometry: { positions: [ [ 0, 0, 0 ], [ 1, 1, 0 ], [ 2, 1, 0 ] ] },
		style: {
			...commonStyle,
			strokeStyle: 'solid',
			showArrow: false,
			startArrowStyle: null,
			endArrowStyle: null,
		},
		heightReference: HeightReference.NONE,
		visible: true,
		properties: {},
		revision: 0,
	};
}

describe( 'CommandExecutor 原子 CRUD', () => {
	it( '添加图形后拒绝重复 id', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		const added = executor.execute( { type: 'feature.add', feature: circle( 'a' ) as never } );
		expect( added ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'a' ] );
		const duplicate = executor.execute( { type: 'feature.add', feature: circle( 'a' ) as never } );
		expect( duplicate ).toMatchObject( {
			ok: false,
			changed: false,
			revision: 1,
			error: { code: 'ID_CONFLICT' },
		} );
		expect( document.getAll() ).toHaveLength( 1 );
	} );

	it( '批量删除任一 id 缺失时全部不变', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ), circle( 'b' ) ],
		} );
		const executor = new CommandExecutor( document );
		const before = document.snapshot();
		const result = executor.execute( {
			type: 'feature.remove', ids: [ 'a', 'missing' ],
		} );
		expect( result.error?.code ).toBe( 'FEATURE_NOT_FOUND' );
		expect( document.snapshot() ).toEqual( before );
	} );

	it( '空批量删除是成功 no-op', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const result = new CommandExecutor( document ).execute( {
			type: 'feature.remove', ids: [],
		} );
		expect( result ).toMatchObject( { ok: true, changed: false, revision: 0 } );
	} );

	it( 'patch 检查 feature revision 并原子切换 CLAMP', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ) ],
		} );
		const executor = new CommandExecutor( document );
		const stale = executor.execute( {
			type: 'feature.patch', id: 'a', beforeRevision: 2, patch: { visible: false },
		} );
		expect( stale.error?.code ).toBe( 'REVISION_CONFLICT' );
		expect( document.revision ).toBe( 0 );

		const changed = executor.execute( {
			type: 'feature.patch',
			id: 'a',
			beforeRevision: 0,
			patch: {
				heightReference: HeightReference.CLAMP_TO_TERRAIN,
				geometry: { center: [ 10, 20, 88 ] },
				style: { fillOpacity: 75 },
			},
		} );
		expect( changed ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( changed.diagnostics ).toEqual( expect.arrayContaining( [
			expect.objectContaining( { severity: 'warning' } ),
		] ) );
		const current = document.get( 'a' );
		expect( current?.revision ).toBe( 1 );
		if ( current?.type !== 'circle' ) {
			expect.fail( '应当保留 circle' );
		}
		expect( current.geometry.center ).toEqual( [ 10, 20, 0 ] );
		expect( current.style.fillOpacity ).toBe( 75 );
	} );
} );

describe( '顶点拓扑命令', () => {
	it( '插入和删除使用稳定 vertex:<index> 身份', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ line( 'line' ) ] } );
		const executor = new CommandExecutor( document );
		expect( executor.execute( {
			type: 'vertex.insert',
			id: 'line',
			beforeRevision: 0,
			after: createVertexId( 0 ),
			position: [ 0.5, 0.5, 10 ],
		} ).ok ).toBe( true );
		let current = document.get( 'line' );
		if ( current?.type !== 'line' ) {
			expect.fail( '应当保留 line' );
		}
		expect( current.geometry.positions[ 1 ] ).toEqual( [ 0.5, 0.5, 10 ] );
		expect( current.revision ).toBe( 1 );

		expect( executor.execute( {
			type: 'vertex.remove',
			id: 'line',
			beforeRevision: 1,
			vertex: createVertexId( 1 ),
		} ).ok ).toBe( true );
		current = document.get( 'line' );
		if ( current?.type !== 'line' ) {
			expect.fail( '应当保留 line' );
		}
		expect( current.geometry.positions ).toHaveLength( 3 );
		expect( current.geometry.positions[ 1 ] ).toEqual( [ 1, 1, 0 ] );
	} );

	it( '拓扑下限、非法 id 与不支持类别均返回明确失败', () => {
		const twoPointLine = line( 'line' );
		twoPointLine.geometry.positions = twoPointLine.geometry.positions.slice( 0, 2 );
		const document = createPlotDocumentStore( {
			id: 'document', features: [ twoPointLine, circle( 'circle' ) ],
		} );
		const executor = new CommandExecutor( document );
		expect( executor.execute( {
			type: 'vertex.remove', id: 'line', beforeRevision: 0, vertex: createVertexId( 0 ),
		} ).error?.code ).toBe( 'INVALID_GEOMETRY' );
		expect( executor.execute( {
			type: 'vertex.insert', id: 'line', beforeRevision: 0, after: 'bad', position: [ 0, 0, 0 ],
		} ).error?.code ).toBe( 'INVALID_COMMAND' );
		expect( executor.execute( {
			type: 'vertex.remove', id: 'circle', beforeRevision: 0, vertex: createVertexId( 0 ),
		} ).error?.code ).toBe( 'INVALID_COMMAND' );
		expect( document.revision ).toBe( 0 );
	} );
} );

describe( '变换、替换与生命周期', () => {
	it( '批量 transform 先计算全部候选再一次提交', () => {
		const transformFeature = vi.fn( ( input: any, transform: any ) => ( {
			...input,
			geometry: {
				...input.geometry,
				center: [
					input.geometry.center[ 0 ] + transform.translationMeters[ 0 ],
					input.geometry.center[ 1 ],
					input.geometry.center[ 2 ],
				],
			},
		} ) );
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ), circle( 'b', 1 ) ],
		} );
		const listener = vi.fn();
		document.subscribe( listener );
		const executor = new CommandExecutor( document, { transformFeature } );
		const result = executor.execute( {
			type: 'feature.transform',
			ids: [ 'a', 'b' ],
			beforeRevisions: { a: 0, b: 0 },
			transform: {
				pivot: [ 0, 30, 0 ],
				translationMeters: [ 1, 0, 0 ],
			},
		} );
		expect( result ).toMatchObject( { ok: true, changed: true, revision: 1 } );
		expect( transformFeature ).toHaveBeenCalledTimes( 2 );
		expect( listener ).toHaveBeenCalledOnce();
		expect( document.get( 'a' )?.revision ).toBe( 1 );
		expect( document.get( 'b' )?.revision ).toBe( 1 );
	} );

	it( 'transform 策略失败时不提交任何目标', () => {
		const document = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'a' ), circle( 'b', 1 ) ],
		} );
		const executor = new CommandExecutor( document, {
			transformFeature: ( input ) => {
				if ( input.id === 'b' ) throw new Error( 'second failed' );
				return { ...input, visible: false } as never;
			},
		} );
		const before = document.snapshot();
		const result = executor.execute( {
			type: 'feature.transform', ids: [ 'a', 'b' ], transform: { pivot: [ 0, 0, 0 ] },
		} );
		expect( result.ok ).toBe( false );
		expect( document.snapshot() ).toEqual( before );
	} );

	it( 'document.replace 原子替换内容但保持 documentId', () => {
		const document = createPlotDocumentStore( { id: 'document', features: [ circle( 'a' ) ] } );
		const replacement = createPlotDocumentStore( {
			id: 'document', features: [ circle( 'b', 2 ), circle( 'c', 3 ) ], order: [ 'c', 'b' ],
		} );
		const result = new CommandExecutor( document ).execute( {
			type: 'document.replace', snapshot: replacement.snapshot(),
		} );
		expect( result.ok ).toBe( true );
		expect( document.getAll().map( ( item ) => item.id ) ).toEqual( [ 'c', 'b' ] );
		expect( document.revision ).toBe( 1 );
	} );

	it( '事件 listener 中的重入写入被拒绝', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		let nested: ReturnType<CommandExecutor[ 'execute' ]> | undefined;
		document.subscribe( () => {
			nested = executor.execute( { type: 'feature.add', feature: circle( 'b' ) as never } );
		} );
		executor.execute( { type: 'feature.add', feature: circle( 'a' ) as never } );
		expect( nested?.error?.code ).toBe( 'REENTRANT_COMMAND' );
		expect( document.has( 'b' ) ).toBe( false );
	} );

	it( 'dispose 后所有命令一致返回 EDITOR_DISPOSED', () => {
		const document = createPlotDocumentStore( { id: 'document' } );
		const executor = new CommandExecutor( document );
		executor.dispose();
		executor.dispose();
		expect( executor.execute( {
			type: 'feature.add', feature: circle( 'a' ) as never,
		} ).error?.code ).toBe( 'EDITOR_DISPOSED' );
	} );
} );
