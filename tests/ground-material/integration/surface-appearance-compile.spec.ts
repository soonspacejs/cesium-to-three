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
	] );
	expect( report.customUniformBound ).toEqual( [ true, true, true ] );
	expect( report.stencilMaterialCallsMaterial ).toEqual( [ false, false, false ] );
	// All three primitives intentionally share one color program; front/back also
	// share the fixed stencil program because neither key includes owner identity.
	expect( report.programCount ).toBe( 2 );
	expect( browserErrors ).toEqual( [] );
} );
