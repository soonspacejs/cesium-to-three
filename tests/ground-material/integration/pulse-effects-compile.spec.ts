import { expect, test } from '@playwright/test';

import type { PulseEffectsCompileReport } from '../fixtures/pulse-effects-compile';

test( 'compiles PulsePoint and ScalePulse through point delegates in WebGL2', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/pulse-effects-compile.html' );
	await page.waitForFunction( () => window.__C23_PULSE_EFFECTS_COMPILE__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_PULSE_EFFECTS_COMPILE__ as PulseEffectsCompileReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( report.materialNames ).toEqual( [
		'CesiumGroundSurfaceColorMaterial',
		'CesiumGroundSurfaceColorMaterial',
		'CesiumGroundSurfaceColorMaterial',
	] );
	expect( report.pulseSourceValid ).toBe( true );
	expect( report.scaleSourceValid ).toBe( true );
	expect( report.textureBranchSchemaStable ).toBe( true );
	expect( report.timeValues ).toEqual( [ 5.25, 5.25, 5.25 ] );
	expect( report.frameCount ).toBe( 120 );
	expect( report.programCountAfterFrames ).toBe( report.programCountBeforeFrames );
	expect( browserErrors ).toEqual( [] );
} );
