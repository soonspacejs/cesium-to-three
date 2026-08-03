import { expect, test } from '@playwright/test';

import type { StencilCleanupReport } from '../fixtures/stencil-cleanup';

test( 'clears stencil for zero-alpha and coverage-excluded classification fragments', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/stencil-cleanup.html' );
	await page.waitForFunction( () => window.__C23_STENCIL_CLEANUP__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_STENCIL_CLEANUP__ as StencilCleanupReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( browserErrors ).toEqual( [] );
	expect( report.cleanedRedPixels ).toBe( 0 );
	// The disabled-color control proves the full-screen probe is sensitive to
	// stencil residue in the exact same geometry/depth/camera configuration.
	expect( report.controlRedPixels ).toBeGreaterThan( 100 );
} );
