import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'records legacy setter, rebuild, visibility and dispose identities', async ( { page } ) => {
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi )
			.exerciseLegacySetters(),
	);

	expect( report.fragmentCulling ).toEqual( {
		geometryStable: true,
		frontMaterialStable: true,
		backMaterialStable: true,
		colorMaterialReplaced: true,
	} );
	expect( report.lineUniformSetters ).toEqual( {
		geometryStable: true,
		materialStable: true,
	} );
	expect( report.arrowStyleRebuild ).toEqual( {
		lineGeometryStable: true,
		lineMaterialStable: true,
		arrowGeometryReplaced: true,
		arrowMaterialReplaced: true,
	} );
	expect( report.textUpdate ).toEqual( {
		groupReplaced: false,
		geometryReplaced: false,
		textureStable: true,
	} );
	expect( report.visibilityAndOrder ).toEqual( {
		hidden: true,
		frontOrder: 125,
		backOrder: 126,
		colorOrder: 127,
	} );
	// This is the pre-migration behavior captured by stage 1. The final design
	// deliberately changes primitive disposal to be idempotent, at which point
	// this expectation will be updated to one event per owned GPU object.
	expect( report.doubleDispose ).toEqual( {
		geometryDisposeEvents: 2,
		frontMaterialDisposeEvents: 2,
		backMaterialDisposeEvents: 2,
		colorMaterialDisposeEvents: 2,
	} );
} );
