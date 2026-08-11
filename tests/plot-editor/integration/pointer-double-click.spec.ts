import { expect, test } from '@playwright/test';

test( '原生 MouseEvent dblclick 可完成绘制且不会触发 Illegal invocation', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => browserErrors.push( error.message ) );

	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	await page.evaluate( () => {
		window.__plotDemo!.controls.enabled = false;
		window.__plotDemo!.editor.activateTool( 'line' );
		window.__plotDemo!.editor.focus();
	} );
	const canvas = page.locator( 'canvas' );
	const box = await canvas.boundingBox();
	if ( box === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const first = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.5 };
	const second = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.5 };
	await page.mouse.click( first.x, first.y );
	await page.mouse.click( second.x, second.y );

	// 直接派发浏览器原生 MouseEvent，覆盖 PointerEvent 原型伪造曾触发的品牌检查异常。
	await canvas.dispatchEvent( 'dblclick', {
		button: 0,
		clientX: second.x,
		clientY: second.y,
	} );

	await expect.poll( () => page.evaluate( () => ( {
		count: window.__plotDemo!.editor.document.getAll().length,
		mode: window.__plotDemo!.editor.mode,
	} ) ) ).toEqual( { count: 9, mode: 'select' } );
	expect( browserErrors ).toEqual( [] );
} );

test( '双击已提交文本进入 textarea 并可提交中文内容', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => browserErrors.push( error.message ) );

	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	const target = await page.evaluate( () => {
		window.__plotDemo!.controls.enabled = false;
		const editor = window.__plotDemo!.editor as unknown as {
			readonly document: { get( id: string ): {
				readonly type: string;
				readonly geometry: { readonly position: readonly [ number, number, number ] };
			} | undefined };
			_createProjectionSnapshot(): { project( position: readonly [ number, number, number ] ): {
				x: number;
				y: number;
				visible: boolean;
			} | null };
		};
		const feature = editor.document.get( 'demo-text' );
		if ( feature?.type !== 'text' ) throw new Error( 'demo-text 不存在。' );
		const projected = editor._createProjectionSnapshot().project( feature.geometry.position );
		if ( projected === null || ! projected.visible ) throw new Error( 'demo-text 不可见。' );
		return { x: projected.x, y: projected.y };
	} );

	await page.mouse.dblclick( target.x, target.y );
	const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( textarea ).toHaveCount( 1 );
	await expect( textarea ).toBeFocused();
	await textarea.fill( '双击编辑中文成功' );
	await textarea.press( 'Control+Enter' );
	await expect( textarea ).toHaveCount( 0 );
	await expect.poll( () => page.evaluate( () => {
		const feature = ( window.__plotDemo!.editor as unknown as {
			readonly document: { get( id: string ): { readonly style?: { readonly content?: string } } | undefined };
		} ).document.get( 'demo-text' );
		return feature?.style?.content;
	} ) ).toBe( '双击编辑中文成功' );
	expect( browserErrors ).toEqual( [] );
} );

declare global {
	interface Window {
		__plotDemo?: {
			readonly controls: { enabled: boolean };
			readonly editor: {
				readonly mode: string;
				readonly document: { getAll(): readonly unknown[] };
				activateTool( tool: string ): void;
				focus(): void;
			};
		};
	}
}
