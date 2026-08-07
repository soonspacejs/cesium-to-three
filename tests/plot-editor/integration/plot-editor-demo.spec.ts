import { expect, test, type Page } from '@playwright/test';

import type { PlotFeature, Position3D } from '../../../src/lib/plot-editor';

interface DemoEditorApi {
	dispose(): void;
	readonly controls: {
		enabled: boolean;
	};
	readonly editor: {
		readonly mode: string;
		readonly selection: ReadonlySet<string>;
		readonly document: {
			readonly revision: number;
			get( id: string ): Readonly<PlotFeature> | undefined;
			getAll(): readonly Readonly<PlotFeature>[];
		};
		activateTool( tool: string ): void;
		clearSelection(): void;
		select( ids: Iterable<string> ): void;
		focus(): void;
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
