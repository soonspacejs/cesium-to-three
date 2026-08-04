import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'compiles and renders every synchronous legacy Ground path', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	const report = await page.evaluate( () => {
		const fixture = window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi;
		return {
			isWebGL2: fixture.isWebGL2,
			frameNumber: fixture.frameNumber,
			resources: fixture.resourceSnapshot,
		};
	} );

	expect( browserErrors ).toEqual( [] );
	expect( report.isWebGL2 ).toBe( true );
	expect( report.frameNumber ).toBe( 2 );
	expect( report.resources.programCount ).toBeGreaterThanOrEqual( 6 );
	expect( report.resources.geometryCount ).toBeGreaterThanOrEqual( 10 );
	expect( report.resources.textureCount ).toBeGreaterThanOrEqual( 2 );
} );
