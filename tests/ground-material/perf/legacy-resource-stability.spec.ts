import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'keeps programs, geometries and textures stable for 600 warm frames', async ( { page } ) => {
	// Software WebGL intentionally trades speed for deterministic pixels. Keep the
	// mandated 600 frames and allow enough wall time instead of weakening coverage.
	test.setTimeout( 120_000 );
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi )
			.measureFrameStability( 600 ),
	);

	expect( report.framesRendered ).toBe( 600 );
	expect( report.programObjectSetStable ).toBe( true );
	expect( report.after.programCount ).toBe( report.before.programCount );
	expect( report.after.geometryCount ).toBe( report.before.geometryCount );
	expect( report.after.textureCount ).toBe( report.before.textureCount );
} );
