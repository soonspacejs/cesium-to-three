import { expect, test } from '@playwright/test';

import type { SurfaceAppearanceCompileReport } from '../fixtures/surface-appearance-compile';

test( 'links one safe surface Appearance on rectangle, polygon, and circle', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/surface-appearance-compile.html' );
	await page.waitForFunction( () => window.__C23_SURFACE_APPEARANCE_COMPILE__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_SURFACE_APPEARANCE_COMPILE__ as SurfaceAppearanceCompileReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( report.colorMaterialNames ).toEqual( [
		'CesiumGroundSurfaceColorMaterial',
		'CesiumGroundSurfaceColorMaterial',
		'CesiumGroundSurfaceColorMaterial',
		'Stage5Raw/color',
	] );
	expect( report.customUniformBound ).toEqual( [ true, true, true, false ] );
	expect( report.stencilMaterialCallsMaterial ).toEqual( [ false, false, false, false ] );
	expect( report.rawPasses ).toEqual( [ 'frontStencil', 'backStencil', 'color' ] );
	// Stage 14 routes safe and Raw stencil defaults through the same canonical
	// compiler sources. Three therefore shares front/back programs across both
	// Appearance kinds; only custom-safe and Raw-default color remain distinct.
	expect( report.programCount ).toBe( 4 );
	expect( browserErrors ).toEqual( [] );
} );
