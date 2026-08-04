import { expect, test } from '@playwright/test';

import type {
	LegacyGroundFixtureApi,
	LegacyGroundMutationFrameReport,
} from '../fixtures/legacy-ground';

test( 'renders every culling, text, and arrow mutation frame without blanks', async ( { page } ) => {
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );
	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi ).measureMutationFrames(),
	) as LegacyGroundMutationFrameReport;

	expect( report.fragmentCull.disabledEnergy ).toBeGreaterThan( 0 );
	expect( report.fragmentCull.enabledEnergy ).toBeGreaterThan( 0 );
	expect( report.text.beforeEnergy ).toBeGreaterThan( 0 );
	expect( report.text.afterEnergy ).toBeGreaterThan( 0 );
	expect( report.text.changedPixels ).toBeGreaterThan( 0 );
	expect( report.arrow.noneEnergy ).toBeGreaterThan( 0 );
	expect( report.arrow.bothEnergy ).toBeGreaterThan( 0 );
	expect( report.arrow.noneToBothChangedPixels ).toBeGreaterThan( 0 );
	expect( report.arrow.solidToOpenChangedPixels ).toBeGreaterThan( 0 );
} );
