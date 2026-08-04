import { expect, test } from '@playwright/test';

test( 'loads the vertex hook, arrow-flow shader, and image-backed demo materials', async ({ page }) => {
	const shaderErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() !== 'error' ) return;
		const text = message.text();
		if ( /shader|VALIDATE_STATUS|compile/i.test( text ) ) shaderErrors.push( text );
	} );

	for ( const path of [ '/lightline.png', '/nc159642.jpg', '/xiaohuoshuan.png' ] ) {
		const response = await page.request.get( path );
		expect( response.status(), path ).toBe( 200 );
	}

	await page.goto( '/?demo=ground' );
	await page.waitForFunction( () => {
		const demo = ( window as unknown as {
			__demo?: { materialShowcase?: Record<string, unknown> };
		} ).__demo;
		return demo?.materialShowcase !== undefined;
	} );
	await page.waitForFunction( () => {
		const showcase = ( window as unknown as {
			__demo: { materialShowcase: Record<string, { image?: { width?: number } }> };
		} ).__demo.materialShowcase;
		return [ 'lightLineTexture', 'arrowFlowTexture', 'hydrantTexture' ]
			.every( name => ( showcase[ name ].image?.width ?? 0 ) > 0 );
	} );

	const report = await page.evaluate( () => {
		const demo = ( window as unknown as {
			__demo: {
				materialShowcase: Record<string, {
				vertexShader?: string;
				fragmentShader?: string;
				uniforms?: Record<string, { value: unknown }>;
				}>;
				renderPerformance: { targetFps: number };
				renderer: { getPixelRatio: () => number };
				tilesRenderer: { lruCache: { maxSize: number; maxBytesSize: number } };
			};
		} ).__demo;
		const showcase = demo.materialShowcase;
		return {
			customVertex: showcase.customMaterial.vertexShader ?? '',
			flowFragment: showcase.flowLineMaterial.fragmentShader ?? '',
			flowTextureMatchesArrow:
				showcase.flowLineMaterial.uniforms?.u_texture.value === showcase.arrowFlowTexture,
			flowRepeat: showcase.flowLineMaterial.uniforms?.u_repeat.value,
			pulseHasTexture: showcase.pulsePointMaterial.uniforms?.u_hasTexture.value,
			scaleHasTexture: showcase.scalePulseMaterial.uniforms?.u_hasTexture.value,
			targetFps: demo.renderPerformance.targetFps,
			pixelRatio: demo.renderer.getPixelRatio(),
			cacheMaxSize: demo.tilesRenderer.lruCache.maxSize,
			cacheMaxBytesSize: demo.tilesRenderer.lruCache.maxBytesSize,
		};
	} );

	expect( report.customVertex ).toContain( 'void c23_vertexMain' );
	expect( report.customVertex ).toContain( 'vertexOutput.positionClip.y' );
	expect( report.flowFragment ).toContain( 'texture(u_texture, arrowUv)' );
	expect( report.flowFragment ).toContain( 'c23_time * max(u_speed, 0.0)' );
	expect( report.flowTextureMatchesArrow ).toBe( true );
	expect( report.flowRepeat ).toBe( 24 );
	expect( report.pulseHasTexture ).toBe( 1 );
	expect( report.scaleHasTexture ).toBe( 1 );
	expect( report.targetFps ).toBe( 30 );
	expect( report.pixelRatio ).toBeLessThanOrEqual( 1.5 );
	expect( report.cacheMaxSize ).toBe( 512 );
	expect( report.cacheMaxBytesSize ).toBe( 128 * 1024 * 1024 );
	expect( shaderErrors ).toEqual( [] );

	const before = await page.evaluate( () => {
		return { ...( window as unknown as {
			__demo: { renderPerformance: { renderedFrames: number; debugUiUpdates: number } };
		} ).__demo.renderPerformance };
	} );
	await page.waitForTimeout( 1_200 );
	const after = await page.evaluate( () => {
		return { ...( window as unknown as {
			__demo: { renderPerformance: { renderedFrames: number; debugUiUpdates: number } };
		} ).__demo.renderPerformance };
	} );
	expect( after.renderedFrames - before.renderedFrames ).toBeLessThanOrEqual( 38 );
	expect( after.debugUiUpdates - before.debugUiUpdates ).toBeLessThanOrEqual( 6 );
	// Stop the demo RAF and external terrain requests before Playwright tears
	// down the context; the shader assertions above do not depend on the network.
	await page.goto( 'about:blank' );
} );
