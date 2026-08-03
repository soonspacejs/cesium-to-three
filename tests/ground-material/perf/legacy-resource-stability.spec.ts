import { expect, test } from '@playwright/test';

import type { LegacyGroundFixtureApi } from '../fixtures/legacy-ground';

test( 'keeps programs, geometries and textures stable for 600 warm frames', async ( { page } ) => {
	// Software WebGL intentionally trades speed for deterministic pixels. Keep the
	// mandated 600 frames and allow enough wall time instead of weakening coverage.
	test.setTimeout( 180_000 );
	await page.goto( '/tests/ground-material/fixtures/legacy-ground.html' );
	await page.waitForFunction( () => window.__C23_LEGACY_GROUND__?.ready === true );

	const { baselineHeap, heapSamples, reports } = await page.evaluate( () => {
		const api = window.__C23_LEGACY_GROUND__ as LegacyGroundFixtureApi;
		const forceGc = ( globalThis as typeof globalThis & { gc?: () => void } ).gc;
		const memory = ( performance as Performance & {
			memory?: { usedJSHeapSize: number };
		} ).memory;
		if ( forceGc === undefined || memory === undefined ) {
			throw new Error( 'Precise heap measurement requires exposed GC and performance.memory.' );
		}

		// Keep lazy JIT/renderer caches outside the measured window. The acceptance
		// matrix likewise discards 120 warm frames before collecting performance data.
		api.renderFrames( 120 );
		forceGc();
		const baselineHeap = memory.usedJSHeapSize;
		const reports = [];
		const heapSamples: number[] = [];
		for ( let segment = 0; segment < 3; segment += 1 ) {
			reports.push( api.measureFrameStability( 200 ) );
			forceGc();
			heapSamples.push( memory.usedJSHeapSize );
		}
		return { baselineHeap, heapSamples, reports };
	} );

	const before = reports[ 0 ].before;
	const after = reports[ 2 ].after;
	expect( reports.reduce( ( total, report ) => total + report.framesRendered, 0 ) ).toBe( 600 );
	expect( reports.every( report => report.programObjectSetStable ) ).toBe( true );
	expect( after.programCount ).toBe( before.programCount );
	expect( after.geometryCount ).toBe( before.geometryCount );
	expect( after.textureCount ).toBe( before.textureCount );

	const allowedHeapGrowth = Math.max( 2 * 1024 * 1024, baselineHeap * 0.05 );
	expect( heapSamples[ 2 ] - baselineHeap ).toBeLessThanOrEqual( allowedHeapGrowth );
	expect(
		heapSamples[ 0 ] < heapSamples[ 1 ] && heapSamples[ 1 ] < heapSamples[ 2 ],
		`baseline=${ baselineHeap }; samples=${ heapSamples.join( ',' ) }`,
	).toBe( false );
} );
