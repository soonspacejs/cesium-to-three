import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'renders every default-safe-Raw-default switch frame without a blank', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );
	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi )
			.measureAppearanceSwitchFrames(),
	);

	const clearPixel = [ 8, 16, 24, 255 ];
	expect( report.defaultPixel ).not.toEqual( clearPixel );
	expect( report.safePixel ).not.toEqual( clearPixel );
	expect( report.rawPixel ).not.toEqual( clearPixel );
	expect( report.restoredPixel ).not.toEqual( clearPixel );
	expect( report.safePixel ).not.toEqual( report.defaultPixel );
	expect( report.rawPixel ).toEqual( report.defaultPixel );
	expect( report.restoredPixel ).toEqual( report.defaultPixel );
	expect( browserErrors ).toEqual( [] );
} );
