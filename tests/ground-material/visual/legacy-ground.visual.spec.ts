import { expect, test } from '@playwright/test';

test( 'matches the immutable pre-Material composite rendering', async ( { page } ) => {
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	// Capture only the drawing buffer. HTML/body backgrounds therefore cannot
	// hide a blank or incorrectly sized WebGL canvas.
	await expect( page.locator( 'canvas' ) ).toHaveScreenshot( 'legacy-ground-composite.png' );
} );
