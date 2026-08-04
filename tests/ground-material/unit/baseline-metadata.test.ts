// The metadata test intentionally runs before any WebGL fixture. It catches a
// dependency or renderer-setting change that would make visual comparisons
// incomparable while still producing plausible screenshots.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
	version: string;
	dependencies: Record<string, string>;
}

interface BaselineMetadata {
	packageVersion: string;
	threeRange: string;
	renderer: {
		webglVersion: number;
		width: number;
		height: number;
		devicePixelRatio: number;
	};
}

function readJson<T>( relativeUrl: string ): T {
	return JSON.parse(
		readFileSync( new URL( relativeUrl, import.meta.url ), 'utf8' ),
	) as T;
}

describe( 'ground-material baseline metadata', () => {
	it( 'pins the package and Three versions used to record the legacy baseline', () => {
		const manifest = readJson<PackageManifest>( '../../../package.json' );
		const metadata = readJson<BaselineMetadata>( '../fixtures/baseline-metadata.json' );

		expect( metadata.packageVersion ).toBe( manifest.version );
		expect( metadata.threeRange ).toBe( manifest.dependencies.three );
	} );

	it( 'pins the deterministic WebGL2 viewport instead of inheriting host defaults', () => {
		const metadata = readJson<BaselineMetadata>( '../fixtures/baseline-metadata.json' );

		expect( metadata.renderer ).toMatchObject( {
			webglVersion: 2,
			width: 960,
			height: 640,
			devicePixelRatio: 1,
		} );
	} );
} );
