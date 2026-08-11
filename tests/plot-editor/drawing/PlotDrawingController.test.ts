import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { CommandExecutor } from '../../../src/lib/plot-editor/commands/CommandExecutor';
import { HistoryManager } from '../../../src/lib/plot-editor/commands/HistoryManager';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import {
	isHeightReferenceClamp,
	isHeightReferenceRelative,
} from '../../../src/lib/plot-editor/document/height-reference';
import { HeightReference, type Position3D } from '../../../src/lib/plot-editor/document/types';
import { PlotDrawingController } from '../../../src/lib/plot-editor/drawing/PlotDrawingController';
import type { PlotPickResult } from '../../../src/lib/plot-editor/picking/types';

function setup( createFeatureId?: () => string ) {
	const document = createPlotDocumentStore( { id: 'drawing-controller' } );
	const executor = new CommandExecutor( document );
	const history = new HistoryManager( document );
	const onDraftChange = vi.fn();
	const controller = new PlotDrawingController( {
		registry: createBuiltinGeometryAdapterRegistry(),
		document, executor, history, createFeatureId, onDraftChange,
	} );
	return { document, history, controller, onDraftChange };
}

function pick(
	position: Position3D,
	heightReference = HeightReference.CLAMP_TO_GROUND,
): PlotPickResult {
	return {
		authorPosition: position,
		surfacePosition: [ position[ 0 ], position[ 1 ], 999 ],
		surface: 'terrain',
		heightReference,
	};
}

describe( '内置 GeometryAdapter registry', () => {
	it( '完整注册八类且顺序固定', () => {
		expect( createBuiltinGeometryAdapterRegistry().kinds ).toEqual( [
			'point', 'line', 'polygon', 'rectangle',
			'sector', 'arrow', 'text', 'circle',
		] );
	} );
} );

describe( 'PlotDrawingController', () => {
	it.each( Object.values( HeightReference ) )(
		'heightReference=%s 的绘制 preview 分离作者高度与运行时表面高度',
		( heightReference ) => {
			const { controller } = setup();
			controller.arm( {
				type: 'point', heightReference,
				options: { pointStyle: 'circle', size: 10 },
			} );
			controller.addPick( pick( [ 10, 20, 42 ], heightReference ) );
			const expectedAuthorHeight = isHeightReferenceClamp( heightReference ) ? 0 : 42;
			const expectedWorldHeight = isHeightReferenceRelative( heightReference )
				? 999 + expectedAuthorHeight
				: heightReference === HeightReference.NONE ? expectedAuthorHeight : 999;
			expect( controller.session?.draft.points ).toEqual( [ [ 10, 20, expectedAuthorHeight ] ] );
			expect( controller.session?.resolvedPositions ).toEqual( [ [ 10, 20, expectedWorldHeight ] ] );
			controller.cancel();
		},
	);

	it( 'arm/cancel 只创建 transient session，不分配 id、不写文档/history', () => {
		const createId = vi.fn( () => 'never' );
		const { controller, document, history, onDraftChange } = setup( createId );
		const sessionId = controller.arm( {
			type: 'point', heightReference: HeightReference.CLAMP_TO_GROUND,
			options: { pointStyle: 'circle', size: 10 },
		} );
		expect( sessionId ).toBe( 'drawing-1' );
		expect( controller.session ).toMatchObject( { type: 'point' } );
		expect( document.getAll() ).toEqual( [] );
		expect( history.state.undoCount ).toBe( 0 );
		expect( createId ).not.toHaveBeenCalled();
		controller.cancel();
		expect( controller.session ).toBeNull();
		expect( onDraftChange ).toHaveBeenLastCalledWith( null );
	} );

	it( 'surface miss 与混用 HeightReference 保留现有 draft', () => {
		const { controller } = setup();
		controller.arm( {
			type: 'line', heightReference: HeightReference.CLAMP_TO_TERRAIN,
		} );
		expect( controller.addPick( null ).validation?.code ).toBe( 'DRAW_PICK_MISS' );
		expect( controller.addPick( pick(
			[ 0, 0, 0 ], HeightReference.CLAMP_TO_3D_TILE,
		) ).validation?.code ).toBe( 'DRAW_INVALID_HEIGHT' );
		expect( controller.session?.draft.points ).toEqual( [] );
	} );

	it( '非派生 preview 保留 picker 的运行时 surface height 但不污染 author 点', () => {
		const { controller } = setup();
		controller.arm( {
			type: 'line', heightReference: HeightReference.RELATIVE_TO_TERRAIN,
		} );
		controller.addPick( {
			...pick( [ 10, 20, 7 ], HeightReference.RELATIVE_TO_TERRAIN ),
			surfacePosition: [ 10, 20, 100 ],
		} );
		controller.movePick( {
			...pick( [ 11, 21, 9 ], HeightReference.RELATIVE_TO_TERRAIN ),
			surfacePosition: [ 11, 21, 200 ],
		} );

		expect( controller.session?.draft.points ).toEqual( [ [ 10, 20, 7 ] ] );
		expect( controller.session?.resolvedPositions ).toEqual( [
			[ 10, 20, 107 ], [ 11, 21, 209 ],
		] );
	} );

	it( '合法 circle 只用一条 feature.add history 提交，undo 恢复空文档', () => {
		const { controller, document, history } = setup( () => 'circle-a' );
		controller.arm( {
			type: 'circle', heightReference: HeightReference.CLAMP_TO_GROUND,
		} );
		controller.addPick( pick( [ 0, 0, 100 ] ) );
		controller.movePick( pick( [ 0.1, 0, 100 ] ) );
		controller.addPick( pick( [ 0.1, 0, 100 ] ) );
		const result = controller.finish();
		expect( result ).toMatchObject( { ok: true, id: 'circle-a' } );
		expect( controller.session ).toBeNull();
		expect( document.getAll() ).toHaveLength( 1 );
		expect( document.get( 'circle-a' ) ).toMatchObject( {
			type: 'circle', geometry: { center: [ 0, 0, 0 ] },
		} );
		expect( history.state.undoCount ).toBe( 1 );
		expect( history.undo().ok ).toBe( true );
		expect( document.getAll() ).toEqual( [] );
	} );

	it( '非法 finish 保留 session，且不会提前调用 id factory', () => {
		const createId = vi.fn( () => 'line-a' );
		const { controller, document } = setup( createId );
		controller.arm( {
			type: 'line', heightReference: HeightReference.CLAMP_TO_GROUND,
		} );
		controller.addPick( pick( [ 0, 0, 0 ] ) );
		const result = controller.finish();
		expect( result ).toMatchObject( {
			ok: false, validation: { code: 'DRAW_TOO_FEW_POINTS' },
		} );
		expect( controller.session ).not.toBeNull();
		expect( createId ).not.toHaveBeenCalled();
		expect( document.getAll() ).toEqual( [] );
	} );

	it( 'id factory 异常转为结构化失败并保留 session', () => {
		const createId = vi.fn()
			.mockImplementationOnce( () => { throw new Error( 'id 服务不可用' ); } )
			.mockReturnValueOnce( 'point-a' );
		const { controller, document } = setup( createId );
		controller.arm( {
			type: 'point', heightReference: HeightReference.NONE,
			options: { pointStyle: 'circle', size: 10 },
		} );
		controller.addPick( pick( [ 0, 0, 3 ], HeightReference.NONE ) );

		expect( controller.finish() ).toMatchObject( {
			ok: false,
			validation: { code: 'DRAW_INVALID_PARAMETER', message: 'id 服务不可用' },
		} );
		expect( controller.session ).not.toBeNull();
		expect( document.getAll() ).toEqual( [] );
		expect( controller.finish() ).toMatchObject( { ok: true, id: 'point-a' } );
	} );

	it( 'text 内容通过 adapter 的 native/IME 更新入口后提交', () => {
		const { controller, document } = setup( () => 'text-a' );
		controller.arm( {
			type: 'text', heightReference: HeightReference.NONE,
			options: { content: '' },
		} );
		controller.addPick( pick( [ 10, 20, 30 ], HeightReference.NONE ) );
		expect( controller.finish().validation?.code ).toBe( 'DRAW_TEXT_INPUT_REQUIRED' );
		expect( controller.updateText( '你好，GIS' ).ok ).toBe( true );
		expect( controller.finish().ok ).toBe( true );
		expect( document.get( 'text-a' ) ).toMatchObject( {
			type: 'text', style: { content: '你好，GIS' },
		} );
	} );

	it( '重复 dispose 幂等，销毁后拒绝新 session', () => {
		const { controller } = setup();
		controller.arm( {
			type: 'point', heightReference: HeightReference.NONE,
			options: { pointStyle: 'circle', size: 1 },
		} );
		controller.dispose();
		controller.dispose();
		expect( controller.session ).toBeNull();
		expect( () => controller.arm( {
			type: 'circle', heightReference: HeightReference.NONE,
		} ) ).toThrow( /已销毁/ );
	} );
} );
