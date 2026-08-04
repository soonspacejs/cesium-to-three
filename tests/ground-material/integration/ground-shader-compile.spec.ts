import { expect, test } from '@playwright/test';

import type { GroundShaderCompileReport } from '../fixtures/ground-shader-compile';

test( 'compiles every Ground shader ABI pass with the real WebGL2 driver', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/ground-shader-compile.html' );
	await page.waitForFunction( () => window.__C23_GROUND_SHADER_COMPILE__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_GROUND_SHADER_COMPILE__ as GroundShaderCompileReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.compiledPasses ).toEqual( [
		'surface/frontStencil',
		'surface/backStencil',
		'surface/color',
		'decal/color',
		'polyline/polyline',
		'arrow/arrow',
	] );
	expect( report.errors ).toEqual( [] );
	expect( browserErrors ).toEqual( [] );
	expect( report.programCount ).toBeGreaterThanOrEqual( 6 );
} );
