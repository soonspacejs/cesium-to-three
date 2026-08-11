import { expect, test } from '@playwright/test';

test( '演示页提供可聚焦画布、命名工具栏和可播报状态', async ( { page } ) => {
	await page.goto( '/?demo=plot&noterrain' );
	const root = page.locator( '#app' );
	const panel = page.locator( '#plot-editor-panel' );
	await expect( panel ).toBeVisible();

	await expect( root ).toHaveAttribute( 'tabindex', '0' );
	await expect( root ).toHaveAttribute( 'aria-label', 'GIS 图形编辑器画布' );
	await expect( root ).toHaveAttribute( 'aria-describedby', 'plot-editor-shortcuts' );
	await root.focus();
	await expect( root ).toBeFocused();

	const toolbar = page.getByRole( 'toolbar', { name: '绘图工具' } );
	await expect( toolbar ).toBeVisible();
	const buttons = toolbar.getByRole( 'button' );
	await expect( buttons ).toHaveCount( 9 );
	for ( const button of await buttons.all() ) {
		await expect( button ).toHaveAttribute( 'title', /工具$/ );
		await expect( button ).toHaveAttribute( 'aria-pressed', /^(true|false)$/ );
	}

	const select = toolbar.getByRole( 'button', { name: '切换到选择工具' } );
	const point = toolbar.getByRole( 'button', { name: '切换到点工具' } );
	await expect( select ).toHaveAttribute( 'aria-pressed', 'true' );
	await point.click();
	await expect( point ).toHaveAttribute( 'aria-pressed', 'true' );
	await expect( select ).toHaveAttribute( 'aria-pressed', 'false' );

	const status = page.getByRole( 'status' );
	await expect( status ).toHaveAttribute( 'aria-live', 'polite' );
	await expect( status ).toHaveAttribute( 'aria-atomic', 'true' );
	await expect( status ).toContainText( '模式：draw:point' );
} );
