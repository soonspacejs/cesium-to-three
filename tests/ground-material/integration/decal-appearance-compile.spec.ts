import { expect, test } from '@playwright/test';

import type { DecalAppearanceCompileReport } from '../fixtures/decal-appearance-compile';

test( 'links default, safe, and Raw text/image decals in WebGL2', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/decal-appearance-compile.html' );
	await page.waitForFunction( () => window.__C23_DECAL_APPEARANCE_COMPILE__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_DECAL_APPEARANCE_COMPILE__ as DecalAppearanceCompileReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( report.materialNames ).toEqual( [
		'CesiumGroundDecalColorMaterial',
		'CesiumGroundDecalColorMaterial',
		'Stage10RawDecal',
		'CesiumGroundDecalColorMaterial',
		'CesiumGroundDecalColorMaterial',
		'Stage10RawDecal',
	] );
	expect( report.decalDefines ).toEqual( [ true, true, true, true, true, true ] );
	expect( report.customUniformBound ).toBe( true );
	expect( report.rawPasses ).toEqual( [
		'decal:frontStencil', 'decal:backStencil', 'decal:color',
		'decal:frontStencil', 'decal:backStencil', 'decal:color',
	] );
	expect( report.textGroupStable ).toBe( true );
	expect( report.textGeometryStable ).toBe( true );
	expect( report.textTextureStable ).toBe( true );
	expect( browserErrors ).toEqual( [] );
} );
