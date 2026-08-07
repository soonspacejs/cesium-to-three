import { expect, test, type Page } from '@playwright/test';

import type { PlotFeature, Position3D } from '../../../src/lib/plot-editor';

interface DemoEditorApi {
	dispose(): void;
	readonly renderer: {
		getContext(): WebGL2RenderingContext;
		render( scene: object, camera: object ): void;
	};
	readonly scene: {
		readonly children: readonly { readonly name: string }[];
		getObjectByName( name: string ): { readonly children: readonly unknown[] } | undefined;
	};
	readonly camera: {
		updateMatrixWorld(): void;
		readonly position: { toArray(): number[] };
		readonly quaternion: { toArray(): number[] };
	};
	readonly controls: {
		enabled: boolean;
	};
	readonly editor: {
		readonly mode: string;
		readonly selection: ReadonlySet<string>;
		readonly selectionState: { readonly activeHandleId?: string };
		readonly document: {
			readonly revision: number;
			get( id: string ): Readonly<PlotFeature> | undefined;
			getAll(): readonly Readonly<PlotFeature>[];
		};
		activateTool( tool: string ): void;
		clearSelection(): void;
		dispose(): void;
		select( ids: Iterable<string> ): void;
		enterVertexEdit( id: string ): void;
		focus(): void;
		readonly _pointer: { readonly activePointerId: number | null };
		_createProjectionSnapshot(): {
			project( position: readonly [ number, number, number ] ): {
				x: number;
				y: number;
				visible: boolean;
			} | null;
		};
	};
}

test.afterEach( async ( { page } ) => {
	await page.evaluate( () => window.__plotDemo?.dispose() );
} );

declare global {
	interface Window {
		__plotDemo?: DemoEditorApi;
	}
}

test( '八类图形的可见内部点均经 DOM pointer 命中 canonical selection', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const targets = await page.evaluate( () => {
		const editor = window.__plotDemo!.editor;
		const projection = editor._createProjectionSnapshot();
		return editor.document.getAll().map( ( feature ) => {
			let position: Position3D;
			if ( feature.type === 'point' || feature.type === 'text' ) {
				position = feature.geometry.position;
			} else if ( feature.type === 'circle' || feature.type === 'sector' ) {
				position = feature.geometry.center;
			} else if ( feature.type === 'line' || feature.type === 'arrow' ) {
				position = feature.geometry.positions[ Math.floor( feature.geometry.positions.length / 2 ) ];
			} else {
				const positions = feature.geometry.positions;
				position = [
					positions.reduce( ( sum, point ) => sum + point[ 0 ], 0 ) / positions.length,
					positions.reduce( ( sum, point ) => sum + point[ 1 ], 0 ) / positions.length,
					0,
				];
			}
			return { id: feature.id as string, type: feature.type as string, point: projection.project( position ) };
		} );
	} );

	for ( const target of targets ) {
		expect( target.point, `${ target.type } 缺少可见 CSS 投影` ).not.toBeNull();
		expect( target.point?.visible, `${ target.type } 投影不在相机前方` ).toBe( true );
		await page.evaluate( () => window.__plotDemo!.editor.clearSelection() );
		await page.mouse.click( target.point!.x, target.point!.y );
		await expect.poll( () => page.evaluate( () => [ ...window.__plotDemo!.editor.selection ] ) )
			.toEqual( [ target.id ] );
	}

	const renderEvidence = await page.evaluate( () => {
		const demo = window.__plotDemo!;
		demo.renderer.render( demo.scene, demo.camera );
		const gl = demo.renderer.getContext();
		const pixels = new Uint8Array( gl.drawingBufferWidth * gl.drawingBufferHeight * 4 );
		gl.finish();
		gl.readPixels(
			0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
			gl.RGBA, gl.UNSIGNED_BYTE, pixels,
		);
		let opaquePixels = 0;
		let nonDarkPixels = 0;
		for ( let offset = 0; offset < pixels.length; offset += 4 ) {
			if ( pixels[ offset + 3 ] > 0 ) opaquePixels++;
			if ( pixels[ offset ] + pixels[ offset + 1 ] + pixels[ offset + 2 ] > 90 ) {
				nonDarkPixels++;
			}
		}
		return {
			pixelCount: pixels.length / 4,
			opaquePixels,
			nonDarkPixels,
			rootNames: demo.scene.children.map( ( child ) => child.name ).filter(
				( name ) => name.startsWith( 'plot' ),
			),
		};
	} );
	expect( renderEvidence.opaquePixels ).toBeGreaterThan( renderEvidence.pixelCount * 0.95 );
	expect( renderEvidence.nonDarkPixels ).toBeGreaterThan( 1000 );
	expect( renderEvidence.rootNames ).toEqual( [
		'plotCommittedRoot',
		'plotDraftRoot',
		'plotSelectionRoot',
		'plotHandleRoot',
		'plotGizmoRoot',
	] );
	await page.evaluate( () => window.__plotDemo!.editor.enterVertexEdit( 'demo-line' ) );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.scene
		.getObjectByName( 'plotHandleRoot' )?.children.length ?? 0 ) ).toBeGreaterThanOrEqual( 5 );

	expect( browserErrors ).toEqual( [] );
} );

test( '绘制、历史、原生文本和键盘变换形成完整浏览器闭环', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const before = await snapshot( page );
	expect( before ).toMatchObject( { revision: 0, count: 8, mode: 'select' } );

	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'point' );
		window.__plotDemo!.editor.focus();
	} );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const drawingPoint = {
		x: canvas.x + canvas.width * 0.85,
		y: canvas.y + canvas.height * 0.75,
	};
	await page.mouse.click( drawingPoint.x, drawingPoint.y );
	await page.mouse.click( drawingPoint.x, drawingPoint.y, { button: 'right' } );
	await expect.poll( () => snapshot( page ) ).toMatchObject( {
		revision: 1, count: 9, mode: 'select',
	} );

	await page.keyboard.press( 'Control+z' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 2, count: 8 } );
	await page.keyboard.press( 'Control+y' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 3, count: 9 } );

	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'text' );
		window.__plotDemo!.editor.focus();
	} );
	// 相机中心射线稳定命中 WGS84 椭球，避免用任意屏幕百分比误点天空。
	await page.mouse.click( canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5 );
	const draftTextarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( draftTextarea ).toHaveCount( 1 );
	await draftTextarea.fill( '浏览器新建文本' );
	await draftTextarea.press( 'Control+Enter' );
	await expect( draftTextarea ).toHaveCount( 0 );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 4, count: 10, mode: 'select' } );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.getAll()
		.some( ( feature ) => feature.type === 'text' && feature.style.content === '浏览器新建文本' ) ) )
		.toBe( true );

	await page.evaluate( () => {
		window.__plotDemo!.editor.select( [ 'demo-text' ] );
		window.__plotDemo!.editor.focus();
	} );
	await page.keyboard.press( 'F2' );
	const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( textarea ).toHaveCount( 1 );
	await textarea.fill( '浏览器中文输入' );
	await textarea.press( 'Control+Enter' );
	await expect( textarea ).toHaveCount( 0 );
	await expect.poll( () => page.evaluate( () => {
		const feature = window.__plotDemo!.editor.document.get( 'demo-text' );
		return feature?.type === 'text' ? feature.style.content : null;
	} ) ).toBe( '浏览器中文输入' );

	const transformBefore = await page.evaluate( () => {
		const editor = window.__plotDemo!.editor;
		editor.select( [ 'demo-point' ] );
		editor.focus();
		const feature = editor.document.get( 'demo-point' );
		return feature?.type === 'point' ? [ ...feature.geometry.position ] : null;
	} );
	await page.keyboard.press( 'g' );
	await page.keyboard.press( 'ArrowRight' );
	await page.keyboard.press( 'Enter' );
	const transformAfter = await page.evaluate( () => {
		const feature = window.__plotDemo!.editor.document.get( 'demo-point' );
		return feature?.type === 'point' ? [ ...feature.geometry.position ] : null;
	} );
	expect( transformAfter ).not.toEqual( transformBefore );
	expect( ( await snapshot( page ) ).mode ).toBe( 'select' );
	expect( browserErrors ).toEqual( [] );
} );

test( '八类图形经 DOM pointer 采点后均由键盘完成提交', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const at = ( x: number, y: number ) => ( {
		x: canvas.x + canvas.width * 0.5 + x,
		y: canvas.y + canvas.height * 0.5 + y,
	} );
	const cases = [
		{ type: 'point', points: [ at( -80, -45 ) ] },
		{ type: 'line', points: [ at( -60, -20 ), at( -20, -35 ) ] },
		{ type: 'polygon', points: [ at( 0, -30 ), at( 38, -20 ), at( 20, 12 ) ] },
		{ type: 'rectangle', points: [ at( -45, 5 ), at( -10, 35 ) ] },
		{ type: 'circle', points: [ at( 20, 30 ), at( 48, 30 ) ] },
		{ type: 'sector', points: [ at( 65, 5 ), at( 90, 5 ), at( 65, -20 ) ] },
		{ type: 'arrow', points: [ at( -90, 55 ), at( -45, 60 ) ] },
		{ type: 'text', points: [ at( 65, 55 ) ] },
	] as const;

	for ( const item of cases ) {
		const countBefore = await page.evaluate( () => window.__plotDemo!.editor.document.getAll().length );
		await page.evaluate( ( type ) => {
			window.__plotDemo!.editor.activateTool( type );
			window.__plotDemo!.editor.focus();
		}, item.type );
		for ( const point of item.points ) await page.mouse.click( point.x, point.y );
		if ( item.type === 'text' ) {
			const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
			await expect( textarea ).toHaveCount( 1 );
			await textarea.fill( '八类键盘完成' );
			await textarea.press( 'Control+Enter' );
		} else {
			await page.keyboard.press( 'Enter' );
		}
		await expect.poll( () => snapshot( page ) ).toMatchObject( {
			count: countBefore + 1,
			mode: 'select',
		} );
	}

	const createdTypes = await page.evaluate( () => window.__plotDemo!.editor.document.getAll()
		.slice( 8 ).map( ( feature ) => feature.type ) );
	expect( createdTypes ).toEqual( cases.map( ( item ) => item.type ) );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 8 );
	expect( browserErrors ).toEqual( [] );
} );

test( '绘制中右键拖拽只导航，右键单击才完成草稿', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const center = {
		x: canvas.x + canvas.width * 0.5,
		y: canvas.y + canvas.height * 0.5,
	};
	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'line' );
		window.__plotDemo!.editor.focus();
	} );
	await page.mouse.click( center.x - 45, center.y );
	await page.mouse.click( center.x + 45, center.y );
	expect( await snapshot( page ) ).toEqual( { revision: 0, count: 8, mode: 'draw:line' } );

	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeDrag = await cameraPose( page );
	await page.mouse.move( center.x, center.y );
	await page.mouse.down( { button: 'right' } );
	await page.mouse.move( center.x + 48, center.y + 24, { steps: 5 } );
	await page.mouse.up( { button: 'right' } );
	await expect.poll( () => cameraPose( page ) ).not.toEqual( cameraBeforeDrag );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	expect( await snapshot( page ) ).toEqual( { revision: 0, count: 8, mode: 'draw:line' } );

	await page.mouse.click( center.x, center.y, { button: 'right' } );
	await expect.poll( () => snapshot( page ) ).toEqual( {
		revision: 1, count: 9, mode: 'select',
	} );
	expect( browserErrors ).toEqual( [] );
} );

test( '控制点拖拽只更新图形，且相机姿态保持不变', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	const initialVertex = await firstVertexPosition( page, 'demo-line' );
	const initialRevision = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeHandleDrag = await cameraPose( page );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await expect.poll( () => page.evaluate(
		() => window.__plotDemo!.editor.selectionState.activeHandleId,
	) ).toBe( 'vertex:0' );
	await page.mouse.move( handle.x + 24, handle.y + 8, { steps: 4 } );
	await page.mouse.up();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( initialRevision + 1 );
	expect( await linePositions( page, 'demo-line' ) ).not.toContainEqual( initialVertex );
	expectPoseEqual( await cameraPose( page ), cameraBeforeHandleDrag );
	expect( browserErrors ).toEqual( [] );
} );

test( 'Space 从控制点起步时只导航相机，不修改图形', async ( { page } ) => {
	test.slow();
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	// Space 必须在 pointerdown 前固定 owner；即使从 handle 起步也只允许相机响应。
	const vertexBeforeNavigation = await firstVertexPosition( page, 'demo-line' );
	const revisionBeforeNavigation = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeNavigation = await cameraPose( page );
	await page.keyboard.down( 'Space' );
	await page.mouse.down();
	expect( await page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await page.mouse.move( handle.x + 36, handle.y + 18, { steps: 5 } );
	await page.mouse.up();
	await page.keyboard.up( 'Space' );
	await expect.poll( () => cameraPose( page ) ).not.toEqual( cameraBeforeNavigation );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBeforeNavigation );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( revisionBeforeNavigation );
	expect( browserErrors ).toEqual( [] );
} );

for ( const [ label, reason ] of [
	[ 'window blur', 'blur' ],
	[ 'document hidden', 'hidden' ],
	[ 'lostpointercapture', 'lost-capture' ],
] as const ) {
	test( `${ label } 回滚控制点 working copy 并恢复相机`, async ( { page } ) => {
		const browserErrors = collectBrowserErrors( page );
		const handle = await prepareLineVertexEdit( page );
		const vertexBefore = await firstVertexPosition( page, 'demo-line' );
		const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
		await page.mouse.move( handle.x, handle.y );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
		await page.mouse.down();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
		await expect.poll( () => page.evaluate(
			() => window.__plotDemo!.editor.selectionState.activeHandleId,
		) ).toBe( 'vertex:0' );
		await page.mouse.move( handle.x + 28, handle.y - 10, { steps: 4 } );
		if ( reason === 'blur' ) {
			await page.evaluate( () => window.dispatchEvent( new Event( 'blur' ) ) );
		} else if ( reason === 'hidden' ) {
			await page.evaluate( () => {
				Object.defineProperty( document, 'visibilityState', {
					configurable: true,
					value: 'hidden',
				} );
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
		} else {
			await page.evaluate( () => {
				const editor = window.__plotDemo!.editor;
				const pointerId = editor._pointer.activePointerId;
				if ( pointerId === null ) throw new Error( 'lost capture 前缺少 active pointer。' );
				const canvas = document.querySelector( 'canvas' );
				if ( canvas === null ) throw new Error( 'Plot demo canvas 不存在。' );
				canvas.dispatchEvent( new PointerEvent( 'lostpointercapture', {
					pointerId,
					pointerType: 'mouse',
				} ) );
			} );
		}
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
		expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBefore );
		expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
			.toBe( revisionBefore );
		await page.mouse.up();
		expect( browserErrors ).toEqual( [] );
	} );
}

test( 'active drag 中 dispose 回滚 working copy 并恢复相机', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	const vertexBefore = await firstVertexPosition( page, 'demo-line' );
	const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await page.mouse.move( handle.x + 28, handle.y - 10, { steps: 4 } );

	await page.evaluate( () => window.__plotDemo!.editor.dispose() );

	expect( await page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBefore );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( revisionBefore );
	await page.mouse.up();
	expect( browserErrors ).toEqual( [] );
} );

function collectBrowserErrors( page: Page ): string[] {
	const errors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) errors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => errors.push( error.message ) );
	return errors;
}

async function openDemo( page: Page ): Promise<void> {
	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	await page.waitForTimeout( 250 );
	// SwiftShader 下持续启用相机控制会让 demo 每帧重绘；集成测试只在编辑器失效时按需渲染。
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
}

async function snapshot( page: Page ): Promise<{
	revision: number;
	count: number;
	mode: string;
}> {
	return page.evaluate( () => ( {
		revision: window.__plotDemo!.editor.document.revision,
		count: window.__plotDemo!.editor.document.getAll().length,
		mode: window.__plotDemo!.editor.mode,
	} ) );
}

async function prepareLineVertexEdit( page: Page ): Promise<{ x: number; y: number }> {
	await openDemo( page );
	await page.evaluate( () => {
		window.__plotDemo!.editor.enterVertexEdit( 'demo-line' );
	} );
	return firstVertexProjection( page, 'demo-line' );
}

async function firstVertexPosition( page: Page, id: string ): Promise<number[]> {
	return ( await linePositions( page, id ) )[ 0 ];
}

async function linePositions( page: Page, id: string ): Promise<number[][]> {
	return page.evaluate( ( featureId ) => {
		const feature = window.__plotDemo!.editor.document.get( featureId );
		if ( feature?.type !== 'line' ) throw new Error( `${ featureId } 不是 line。` );
		return feature.geometry.positions.map( ( position ) => [ ...position ] );
	}, id );
}

async function firstVertexProjection( page: Page, id: string ): Promise<{ x: number; y: number }> {
	return page.evaluate( ( featureId ) => {
		const editor = window.__plotDemo!.editor;
		const feature = editor.document.get( featureId );
		if ( feature?.type !== 'line' ) throw new Error( `${ featureId } 不是 line。` );
		const projected = editor._createProjectionSnapshot().project( feature.geometry.positions[ 0 ] );
		if ( projected === null || ! projected.visible ) throw new Error( `${ featureId } 不可见。` );
		return { x: projected.x, y: projected.y };
	}, id );
}

async function cameraPose( page: Page ): Promise<{ position: number[]; quaternion: number[] }> {
	return page.evaluate( () => {
		const camera = window.__plotDemo!.camera;
		camera.updateMatrixWorld();
		return {
			position: camera.position.toArray(),
			quaternion: camera.quaternion.toArray(),
		};
	} );
}

function expectPoseEqual(
	actual: { position: number[]; quaternion: number[] },
	expected: { position: number[]; quaternion: number[] },
): void {
	for ( let index = 0; index < actual.position.length; index++ ) {
		expect( actual.position[ index ] ).toBeCloseTo( expected.position[ index ], 9 );
	}
	for ( let index = 0; index < actual.quaternion.length; index++ ) {
		expect( actual.quaternion[ index ] ).toBeCloseTo( expected.quaternion[ index ], 12 );
	}
}
