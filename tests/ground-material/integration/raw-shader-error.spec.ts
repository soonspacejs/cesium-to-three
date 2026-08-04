import { expect, test } from '@playwright/test';

import type { RawShaderErrorReport } from '../fixtures/raw-shader-error';

test( 'retains Raw GPU compiler logs and pass diagnostics without fallback', async ( { page } ) => {
	const pageErrors: string[] = [];
	page.on( 'pageerror', error => pageErrors.push( error.message ) );
	await page.goto( '/tests/ground-material/fixtures/raw-shader-error.html' );
	await page.waitForFunction( () => window.__C23_RAW_SHADER_ERROR__?.ready === true );
	const report = await page.evaluate(
		() => window.__C23_RAW_SHADER_ERROR__ as RawShaderErrorReport,
	);

	expect( report.isWebGL2 ).toBe( true );
	expect( report.shaderErrors ).toHaveLength( 1 );
	expect( report.shaderErrors[ 0 ] ).toMatch( /ERROR|error|syntax/i );
	expect( report.diagnostic ).toEqual( {
		kind: 'polyline',
		pass: 'polyline',
		abiVersion: 1,
		appearanceKind: 'raw',
		appearanceVersion: 0,
		primitiveId: 'raw-gpu-error-fixture',
	} );
	expect( report.materialPreserved ).toBe( true );
	expect( report.materialName ).toBe( 'IntentionallyBrokenRaw' );
	expect( pageErrors ).toEqual( [] );
} );
