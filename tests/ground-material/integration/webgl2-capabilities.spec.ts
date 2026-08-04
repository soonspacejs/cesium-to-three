import { expect, test } from '@playwright/test';

import type { WebGlCapabilityReport } from '../fixtures/webgl-capabilities';

test( 'creates the pinned WebGL2 renderer and draws a nonblank frame', async ( { page } ) => {
	const browserErrors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) browserErrors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => browserErrors.push( error.message ) );

	await page.goto( '/tests/ground-material/fixtures/webgl-capabilities.html' );
	await page.waitForFunction( () => window.__C23_WEBGL_CAPABILITIES__?.ready === true );

	const report = await page.evaluate(
		() => window.__C23_WEBGL_CAPABILITIES__ as WebGlCapabilityReport,
	);

	expect( browserErrors ).toEqual( [] );
	expect( report.isWebGL2 ).toBe( true );
	expect( report.version ).toContain( 'WebGL 2.0' );
	expect( report.drawingBufferWidth ).toBe( 960 );
	expect( report.drawingBufferHeight ).toBe( 640 );
	expect( report.stencilBits ).toBeGreaterThanOrEqual( 8 );
	expect( report.programCount ).toBeGreaterThan( 0 );

	// The green triangle has much more green than red/blue at its center. This
	// catches a context that exists but failed to compile or draw its first pass.
	const [ red, green, blue, alpha ] = report.centerPixel;
	expect( green ).toBeGreaterThan( red + 40 );
	expect( green ).toBeGreaterThan( blue + 20 );
	expect( alpha ).toBe( 255 );
} );
