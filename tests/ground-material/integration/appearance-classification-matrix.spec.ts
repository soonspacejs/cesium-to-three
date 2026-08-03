import { expect, test } from '@playwright/test';

import type { AppearanceClassificationMatrixReport } from '../fixtures/appearance-classification-matrix';

test( 'covers the complete primitive appearance classification and alpha matrix', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', error => browserErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/appearance-classification-matrix.html' );
	await page.waitForFunction(
		() => window.__C23_APPEARANCE_CLASSIFICATION_MATRIX__?.ready === true,
	);
	const report = await page.evaluate(
		() => window.__C23_APPEARANCE_CLASSIFICATION_MATRIX__ as AppearanceClassificationMatrixReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.errors ).toEqual( [] );
	expect( browserErrors ).toEqual( [] );
	expect( report.programCount ).toBeGreaterThan( 0 );
	const rows = [
		'rectangle', 'polygon-hole', 'circle-ring-sector',
		'polyline-solid', 'polyline-dash-flow', 'arrow-solid-open',
		'text', 'image', 'point-circle', 'point-square', 'point-image',
	];
	expect( report.entries ).toHaveLength( rows.length * 3 );
	for ( const row of rows ) {
		const entries = report.entries.filter( entry => entry.row === row );
		expect( entries.map( entry => entry.variant ) ).toEqual( [ 'default', 'safe', 'raw' ] );
		expect( entries.map( entry => entry.classificationType ) ).toEqual( [
			'TERRAIN', 'CESIUM_3D_TILE', 'BOTH',
		] );
		expect( entries.map( entry => entry.alpha ) ).toEqual( [ 1, 0.5, 0 ] );
		expect( entries.map( entry => entry.appearanceKind ) ).toEqual( [
			'material', 'material', 'raw',
		] );
		expect( entries.every( entry => entry.depthTextureMatched ) ).toBe( true );
	}

	for ( const row of [
		'rectangle', 'polygon-hole', 'circle-ring-sector',
		'text', 'image', 'point-circle', 'point-square', 'point-image',
	] ) {
		expect( report.rawPasses[ `${ row }:raw` ] ).toEqual( [
			`${ row === 'text' || row === 'image' || row === 'point-image' ? 'decal' : 'surface' }:frontStencil`,
			`${ row === 'text' || row === 'image' || row === 'point-image' ? 'decal' : 'surface' }:backStencil`,
			`${ row === 'text' || row === 'image' || row === 'point-image' ? 'decal' : 'surface' }:color`,
		] );
	}
	expect( report.rawPasses[ 'polyline-solid:raw' ] ).toEqual( [ 'polyline:polyline' ] );
	expect( report.rawPasses[ 'polyline-dash-flow:raw' ] ).toEqual( [ 'polyline:polyline' ] );
	expect( report.rawPasses[ 'arrow-solid-open:raw' ] ).toEqual( [ 'arrow:arrow' ] );
} );
