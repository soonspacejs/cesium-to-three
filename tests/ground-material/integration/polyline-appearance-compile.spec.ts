import { expect, test } from '@playwright/test';

import type { PolylineAppearanceCompileReport } from '../fixtures/polyline-appearance-compile';

test( 'links default, safe, and Raw polyline Appearance routes in WebGL2', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/polyline-appearance-compile.html' );
	await page.waitForFunction( () => window.__C23_POLYLINE_APPEARANCE_COMPILE__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_POLYLINE_APPEARANCE_COMPILE__ as PolylineAppearanceCompileReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( report.materialNames ).toEqual( [
		'CesiumGroundPolylineMaterial',
		'CesiumGroundPolylineMaterial',
		'Stage7RawPolyline',
		'CesiumGroundPolylineMaterial',
		'CesiumGroundPolylineMaterial',
	] );
	expect( report.customUniformBound ).toBe( true );
	expect( report.rawPasses ).toEqual( [ 'polyline:polyline' ] );
	expect( report.arrowMaterialNames ).toEqual( [
		'CesiumGroundArrowMaterial',
		'Stage9RawArrow',
	] );
	expect( report.arrowCustomUniformBound ).toBe( true );
	expect( report.arrowRawPasses ).toEqual( [ 'arrow:arrow' ] );
	expect( report.flowFrames ).toBe( 600 );
	expect( report.programCountAfterFlowFrames ).toBe( report.programCountBeforeFlowFrames );
	// Color, safe gradient, Dash, and Flow sources are four distinct logical
	// shader schemas; Raw default reuses the Color program through Three's cache.
	expect( report.programCount ).toBeGreaterThanOrEqual( 4 );
	expect( browserErrors ).toEqual( [] );
} );
