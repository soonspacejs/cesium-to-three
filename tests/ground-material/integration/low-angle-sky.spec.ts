import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'keeps low-angle no-depth sky pixels at the exact clear color', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );
	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi ).measureLowAngleSky(),
	);

	expect( report.sampledPixels ).toBe( 960 * 48 );
	expect( report.wrongColorPixels ).toBe( 0 );
	expect( report.firstWrongPixel ).toBeNull();
	expect( browserErrors ).toEqual( [] );
} );
