import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import { computeLogicalMaterialKey } from '../../../src/lib/ground/material/logical-key';

const SOURCE = 'c23_material c23_getMaterial(c23_materialInput materialInput) { return materialInput; }';

describe( 'logical Ground Material key', () => {
	it( 'is independent of type, UUID, version, insertion order, and uniform values', () => {
		const first = new CesiumGroundMaterial( {
			type: 'FirstDebugName',
			uniforms: { u_speed: { value: 1 }, u_color: { value: 'red' } },
			defines: { Z_OPTION: false, A_OPTION: 3 },
			fragmentShader: SOURCE,
		} );
		const second = new CesiumGroundMaterial( {
			type: 'SecondDebugName',
			uniforms: { u_color: { value: 'blue' }, u_speed: { value: 999 } },
			defines: { A_OPTION: 3, Z_OPTION: false },
			fragmentShader: SOURCE,
		} );
		first.needsUpdate = true;
		second.setUniform( 'u_speed', - 20 );

		expect( first.uuid ).not.toBe( second.uuid );
		expect( first.version ).not.toBe( second.version );
		expect( computeLogicalMaterialKey( first ) ).toBe( computeLogicalMaterialKey( second ) );
	} );

	it( 'changes for exact source, define state, define value, or schema changes', () => {
		const base = new CesiumGroundMaterial( {
			uniforms: { u_speed: { value: 1 } },
			defines: { OPTION: false },
			fragmentShader: SOURCE,
		} );
		const variants = [
			new CesiumGroundMaterial( {
				uniforms: { u_speed: { value: 1 } },
				defines: { OPTION: false },
				fragmentShader: `${ SOURCE }\n`,
			} ),
			new CesiumGroundMaterial( {
				uniforms: { u_speed: { value: 1 } },
				defines: { OPTION: true },
				fragmentShader: SOURCE,
			} ),
			new CesiumGroundMaterial( {
				uniforms: { u_speed: { value: 1 } },
				defines: {},
				fragmentShader: SOURCE,
			} ),
			new CesiumGroundMaterial( {
				uniforms: { u_speed: { value: 1 }, u_phase: { value: 0 } },
				defines: { OPTION: false },
				fragmentShader: SOURCE,
			} ),
		];
		const key = computeLogicalMaterialKey( base );

		for ( const variant of variants ) {
			expect( computeLogicalMaterialKey( variant ) ).not.toBe( key );
		}
	} );

	it( 'uses the same key after a value-only texture or scalar replacement', () => {
		const material = new CesiumGroundMaterial( {
			uniforms: { u_value: { value: 1 } },
			fragmentShader: SOURCE,
		} );
		const before = computeLogicalMaterialKey( material );

		material.setUniform( 'u_value', { arbitraryRuntimeObject: true } );

		expect( computeLogicalMaterialKey( material ) ).toBe( before );
	} );
} );
