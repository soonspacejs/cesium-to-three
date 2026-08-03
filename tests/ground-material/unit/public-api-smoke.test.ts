import { describe, expect, it } from 'vitest';

import * as rootEntry from '../../../src/cesium-three-ground';
import * as groundEntry from '../../../src/lib/ground';

const REQUIRED_RUNTIME_EXPORTS = [
	'C23_GROUND_SHADER_ABI_VERSION',
	'CesiumGroundMaterial',
	'CesiumGroundMaterialAppearance',
	'CesiumGroundRawShaderAppearance',
	'CesiumGroundMaterialError',
	'createColorGroundMaterial',
	'createTexturedDecalMaterial',
	'createPolylineDashMaterial',
	'createFlowLineMaterial',
	'createPulsePointMaterial',
	'createScalePulseMaterial',
] as const;

describe( 'public Ground Material package entries', () => {
	it( 'exports the same stable runtime symbols from root and ground entries', () => {
		for ( const name of REQUIRED_RUNTIME_EXPORTS ) {
			expect( rootEntry[ name ] ).toBeDefined();
			expect( groundEntry[ name ] ).toBeDefined();
			// Root re-exports the ground module; identity equality protects users
			// from duplicate constructors that would break instanceof checks.
			expect( rootEntry[ name ] ).toBe( groundEntry[ name ] );
		}
		expect( rootEntry.C23_GROUND_SHADER_ABI_VERSION ).toBe( 1 );
	} );
} );
