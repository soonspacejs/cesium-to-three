import { expect, test } from '@playwright/test';

import type {
	LegacyGroundAnimationReport,
	LegacyGroundFixtureApi,
} from '../fixtures/legacy-ground';

test( 'renders deterministic Flow, PulsePoint, and ScalePulse keyframes', async ( { page } ) => {
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );
	const report = await page.evaluate(
		() => ( window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi )
			.measureAnimationKeyframes(),
	) as LegacyGroundAnimationReport;

	for ( const series of [
		report.flow,
		report.pulse,
		report.scalePlain,
		report.scaleTextured,
	] ) {
		expect( series.keyframeEnergy ).toHaveLength( 5 );
		expect( series.keyframeEnergy.every( energy => energy > 0 ) ).toBe( true );
		expect( series.cyclePixelsEqual ).toBe( true );
		expect( series.absoluteTimePixelsEqual ).toBe( true );
	}

	// Flow translates along the line between quarter-cycle frames instead of
	// accumulating host delta/frame state.
	expect( report.flow.midpointPixelsEqual ).toBe( false );

	for ( const pulse of [ report.pulse, report.scalePlain, report.scaleTextured ] ) {
		expect( pulse.midpointPixelsEqual ).toBe( true );
		expect( pulse.keyframeEnergy[ 0 ] ).toBe( pulse.keyframeEnergy[ 4 ] );
		expect( pulse.keyframeEnergy[ 1 ] ).toBe( pulse.keyframeEnergy[ 3 ] );
		expect( pulse.keyframeEnergy[ 2 ] ).toBeGreaterThan( pulse.keyframeEnergy[ 0 ] );
	}
} );
