import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	assembleGroundFragmentShader,
	assembleGroundVertexShader,
} from '../../../src/lib/ground/material/shader-assembler';

const material = new CesiumGroundMaterial( {
	type: 'AssemblerFixture',
	uniforms: { u_opacity: { value: 1 } },
	defines: { Z_LAST: 2, A_FIRST: true },
	fragmentShader: /* glsl */ `
uniform float u_opacity;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_opacity;
	return result;
}
`,
} );

describe( 'explicit Ground shader assembler', () => {
	it( 'assembles deterministic named vertex sections without rewriting source', () => {
		const source = assembleGroundVertexShader( {
			kind: 'surface',
			pass: 'color',
			systemDefines: [ 'C23_TEST_SYSTEM 7' ],
			sections: {
				declarations: 'uniform mat4 c23_testProjection;',
				attributes: 'in vec3 position3DHigh;',
				varyings: 'out vec2 v_testUv;',
				helpers: 'vec3 c23_testHelper(vec3 p) { return p; }',
				main: 'void main() { gl_Position = vec4(c23_testHelper(position3DHigh), 1.0); }',
			},
		} );

		expect( source ).toMatchSnapshot();
		expect( source.match( /void main/g ) ).toHaveLength( 1 );
		expect( source ).toContain( '#define C23_SURFACE 1' );
		expect( source ).toContain( '#define C23_PASS_COLOR 1' );
	} );

	it( 'assembles safe Material after system sections with one owned finalizer', () => {
		const source = assembleGroundFragmentShader( {
			mode: 'material',
			kind: 'polyline',
			pass: 'polyline',
			material,
			sections: {
				declarations: 'uniform vec4 c23_lineColor;',
				varyings: 'in float v_distanceAlong;',
				helpers: 'float c23_membership() { return 1.0; }',
				mainPrologue: 'c23_systemCoverage = c23_membership();',
				inputAssignments: [
					'c23_input.baseColor = c23_lineColor;',
					'c23_input.distanceAlongMeters = v_distanceAlong;',
				].join( '\n' ),
			},
		} );

		expect( source ).toMatchSnapshot();
		expect( source.match( /c23_getMaterial\(c23_input\)/g ) ).toHaveLength( 1 );
		expect( source.match( /out_FragColor\s*=/g ) ).toHaveLength( 1 );
		expect( source ).toContain( '#define A_FIRST 1\n#define Z_LAST 2' );
		expect( source.indexOf( '// [c23:fragment-system-helpers]' ) )
			.toBeLessThan( source.indexOf( '// [c23:ground-material-abi]' ) );
		expect( source.indexOf( '// [c23:ground-material-abi]' ) )
			.toBeLessThan( source.indexOf( '// [c23:ground-user-material]' ) );
	} );

	it( 'assembles a fixed stencil shader without injecting the Material ABI', () => {
		const source = assembleGroundFragmentShader( {
			mode: 'stencil',
			kind: 'decal',
			pass: 'frontStencil',
			sections: {
				declarations: 'uniform float c23_testDepth;',
				helpers: 'float c23_depth() { return c23_testDepth; }',
				main: 'void main() { gl_FragDepth = c23_depth(); out_FragColor = vec4(0.0); }',
			},
		} );

		expect( source ).toMatchSnapshot();
		expect( source ).not.toContain( 'c23_getMaterial' );
		expect( source ).not.toContain( 'struct c23_materialInput' );
	} );

	it( 'rejects unsafe system define payloads before assembly', () => {
		expect( () => assembleGroundVertexShader( {
			kind: 'arrow',
			pass: 'arrow',
			systemDefines: [ 'VALID 1\n#define INJECTED 1' ],
			sections: {
				declarations: '',
				attributes: '',
				main: 'void main() { gl_Position = vec4(0.0); }',
			},
		} ) ).toThrow( /one safe GLSL define/ );
	} );
} );
