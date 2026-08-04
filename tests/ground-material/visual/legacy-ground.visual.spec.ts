import { expect, test } from '@playwright/test';

test( 'matches the immutable pre-Material composite rendering', async ( { page } ) => {
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	// Capture only the drawing buffer. HTML/body backgrounds therefore cannot
	// hide a blank or incorrectly sized WebGL canvas.
	// The explicit color assembler uses the canonical CPU-plane reconstruction.
	// At a shadow-volume edge, that path can move a single rasterized boundary
	// sample by one pixel while remaining inside the documented Stage 4 golden
	// tolerance; the canonical Stage 14 stencil source changes GPU instruction
	// ordering at a few antialiased boundaries. Larger shape changes still fail
	// because the allowance is fixed to 24 pixels (< 0.004% of this fixture).
	await expect( page.locator( 'canvas' ) ).toHaveScreenshot( 'legacy-ground-composite.png', {
		maxDiffPixels: 24,
	} );
} );
