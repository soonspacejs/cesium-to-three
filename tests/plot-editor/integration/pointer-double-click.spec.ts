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
