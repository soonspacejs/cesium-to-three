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

test( '浮动文本面板支持输入、Escape 取消、保存按钮和点击外部确认', async ( { page } ) => {
	test.slow( true, 'SwiftShader 冷启动后需连续验证四轮完整文本编辑生命周期。' );
	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	const target = await textScreenPosition( page );

	await page.mouse.dblclick( target.x, target.y );
	const panel = page.locator( '[data-plot-editor-text-panel]' );
	const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( panel ).toBeVisible();
	await expect( panel.getByText( '编辑文本', { exact: true } ) ).toBeVisible();
	await expect( panel.getByRole( 'button', { name: '保存' } ) ).toBeVisible();
	await expect( panel.getByRole( 'button', { name: '取消' } ) ).toBeVisible();
	await expect( textarea ).toBeFocused();
	await expect( textarea ).toHaveCSS( 'pointer-events', 'auto' );
	await expect( panel ).toHaveCSS( 'z-index', '2147483647' );
	const original = await textarea.inputValue();
	await textarea.click();
	await page.keyboard.press( 'Control+A' );
	await page.keyboard.type( '不应提交的修改' );
	await page.keyboard.press( 'Escape' );
	await expect( panel ).toHaveCount( 0 );
	await expect.poll( () => textContent( page ) ).toBe( original );

	await page.mouse.dblclick( target.x, target.y );
	await textarea.fill( '取消按钮不应提交' );
	await panel.getByRole( 'button', { name: '取消' } ).click();
	await expect( panel ).toHaveCount( 0 );
	await expect.poll( () => textContent( page ) ).toBe( original );

	await page.mouse.dblclick( target.x, target.y );
	await textarea.click();
	await page.keyboard.press( 'Control+A' );
	await page.keyboard.type( '按钮保存成功' );
	await panel.getByRole( 'button', { name: '保存' } ).click();
	await expect( panel ).toHaveCount( 0 );
	await expect.poll( () => textContent( page ) ).toBe( '按钮保存成功' );

	await page.mouse.dblclick( target.x, target.y );
	await textarea.click();
	await page.keyboard.press( 'Control+A' );
	await page.keyboard.type( '点击外部确认' );
	await page.mouse.click( 900, 40 );
	await expect( panel ).toHaveCount( 0 );
	await expect.poll( () => textContent( page ) ).toBe( '点击外部确认' );
} );

test( '单击文本正文只选中，拖动正文移动同一文本且不会打开输入面板', async ( { page } ) => {
	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	const target = await textScreenPosition( page );
	const before = await textFeatureState( page );
	await page.getByRole( 'button', { name: '切换到文本工具' } ).click();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.mode ) )
		.toBe( 'draw:text' );

	// 文本创建工具仍处于激活状态；刻意点击 anchor 左侧的已有正文，必须优先
	// 退出创建模式并选中原文本，不能新增第二份文本。
	await page.mouse.click( target.x - 35, target.y );
	await expect.poll( () => page.evaluate( () => ( {
		mode: window.__plotDemo!.editor.mode,
		selection: [ ...( window.__plotDemo!.editor as unknown as { selection: ReadonlySet<string> } ).selection ],
	} ) ) ).toEqual( { mode: 'select', selection: [ 'demo-text' ] } );
	await expect.poll( () => textFeatureState( page ) ).toEqual( before );
	await expect( page.locator( '[data-plot-editor-text-panel]' ) ).toHaveCount( 0 );

	await page.mouse.move( target.x - 35, target.y );
	await page.mouse.down();
	await page.mouse.move( target.x + 35, target.y + 25, { steps: 5 } );
	await page.mouse.up();
	await expect.poll( () => textFeatureState( page ) ).not.toEqual( before );
	const after = await textFeatureState( page );
	expect( after.count ).toBe( before.count );
	expect( after.content ).toBe( before.content );
	await expect( page.locator( '[data-plot-editor-text-panel]' ) ).toHaveCount( 0 );
} );

async function textScreenPosition( page: import( '@playwright/test' ).Page ) {
	return page.evaluate( () => {
		const editor = window.__plotDemo!.editor as unknown as {
			readonly document: { get( id: string ): {
				readonly type: string;
				readonly geometry: { readonly position: readonly [ number, number, number ] };
			} | undefined };
			_createProjectionSnapshot(): { project( position: readonly [ number, number, number ] ): {
				x: number; y: number; visible: boolean;
			} | null };
		};
		const feature = editor.document.get( 'demo-text' );
		if ( feature?.type !== 'text' ) throw new Error( 'demo-text 不存在。' );
		const projected = editor._createProjectionSnapshot().project( feature.geometry.position );
		if ( projected === null || ! projected.visible ) throw new Error( 'demo-text 不可见。' );
		return { x: projected.x, y: projected.y };
	} );
}

async function textContent( page: import( '@playwright/test' ).Page ) {
	return page.evaluate( () => {
		const feature = ( window.__plotDemo!.editor as unknown as {
			readonly document: { get( id: string ): { readonly style?: { readonly content?: string } } | undefined };
		} ).document.get( 'demo-text' );
		return feature?.style?.content;
	} );
}

async function textFeatureState( page: import( '@playwright/test' ).Page ) {
	return page.evaluate( () => {
		const editor = window.__plotDemo!.editor as unknown as {
			readonly document: {
				getAll(): readonly unknown[];
				get( id: string ): {
					readonly geometry?: { readonly position?: readonly number[] };
					readonly style?: { readonly content?: string };
				} | undefined;
			};
		};
		const feature = editor.document.get( 'demo-text' );
		return {
			count: editor.document.getAll().length,
			position: feature?.geometry?.position,
			content: feature?.style?.content,
		};
	} );
}

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
