import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SCHEDULER_CALL = /\b(?:requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|requestRender)\s*\(/g;
const FORBIDDEN_ANIMATION_RUNTIME = /\b(?:Timeline|Tween)\b/g;

function collectSourceUrls( directory: URL ): URL[] {
	const result: URL[] = [];
	for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
		const child = new URL( entry.name + ( entry.isDirectory() ? '/' : '' ), directory );
		if ( entry.isDirectory() ) {
			result.push( ...collectSourceUrls( child ) );
		} else if ( /\.(?:ts|glsl)$/.test( entry.name ) ) {
			result.push( child );
		}
	}
	return result;
}

describe( 'Ground scheduling boundary', () => {
	it( 'contains no private RAF, timer, request-render, timeline, or tween runtime', () => {
		const sourceRoot = new URL( '../../../src/lib/ground/', import.meta.url );
		const violations: string[] = [];

		for ( const sourceUrl of collectSourceUrls( sourceRoot ) ) {
			const source = readFileSync( sourceUrl, 'utf8' );
			for ( const pattern of [ FORBIDDEN_SCHEDULER_CALL, FORBIDDEN_ANIMATION_RUNTIME ] ) {
				pattern.lastIndex = 0;
				for ( const match of source.matchAll( pattern ) ) {
					const line = source.slice( 0, match.index ).split( '\n' ).length;
					violations.push( `${ decodeURIComponent( sourceUrl.pathname ) }:${ line }:${ match[ 0 ] }` );
				}
			}
		}

		// FrameState is the only clock: a host may schedule renders, Ground may not.
		expect( violations ).toEqual( [] );
	} );
} );
