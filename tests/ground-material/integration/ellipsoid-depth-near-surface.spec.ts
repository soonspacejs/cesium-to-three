import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( '近地相机从 packed depth 重建出解析 WGS84 椭球面距离', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	const report = await page.evaluate( () => (
		window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi
	).measureEllipsoidCenterDepth( 180 ) );

	expect( browserErrors ).toEqual( [] );
	expect( report.packedPixel ).not.toEqual( [ 0, 0, 0, 0 ] );
	// RGBA8 packed depth 在 40,000 km far plane 下存在厘米级量化误差；25 cm
	// 容差仍远小于旧粗网格在该视高下约 1.2 km 的平面逼近误差。
	expect( Math.abs( report.reconstructedDistanceMeters - 180 ) ).toBeLessThan( 0.25 );
} );
