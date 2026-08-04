import { describe, expect, it } from 'vitest';

import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	C23_GROUND_FRAGMENT_SHADER_TEMPLATE,
	C23_GROUND_VERTEX_SHADER_TEMPLATE,
	createGroundFragmentShader,
	createGroundVertexShader,
} from '../../../src/lib/ground/material/templates';
import {
	validateGroundMaterialSource,
	validateGroundVertexSource,
} from '../../../src/lib/ground/material/validation';

describe( 'Ground shader templates', () => {
	it( 'exports a copy-ready no-op vertex and pass-through fragment pair', () => {
		const material = new CesiumGroundMaterial( {
			vertexShader: C23_GROUND_VERTEX_SHADER_TEMPLATE,
			fragmentShader: C23_GROUND_FRAGMENT_SHADER_TEMPLATE,
		} );

		expect( () => validateGroundVertexSource( material, 'surface' ) ).not.toThrow();
		expect( () => validateGroundMaterialSource( material, 'surface' ) ).not.toThrow();
	} );

	it( 'wraps animation-only statements in the exact vertex entry', () => {
		const vertexShader = createGroundVertexShader( `
	float wave = sin(vertexInput.positionEC.x + c23_time);
	vertexOutput.positionClip.y += wave * vertexOutput.positionClip.w * 0.01;
` );
		const material = new CesiumGroundMaterial( {
			vertexShader,
			fragmentShader: C23_GROUND_FRAGMENT_SHADER_TEMPLATE,
		} );

		expect( vertexShader.match( /void c23_vertexMain/g ) ).toHaveLength( 1 );
		expect( () => validateGroundVertexSource( material, 'polyline' ) ).not.toThrow();
	} );

	it( 'wraps fragment declarations and effect statements around pass-through defaults', () => {
		const fragmentShader = createGroundFragmentShader(
			'material.alpha *= 0.5 + 0.5 * sin(c23_time * u_speed);',
			'uniform float u_speed;',
		);
		const material = new CesiumGroundMaterial( {
			uniforms: { u_speed: { value: 2 } },
			fragmentShader,
		} );

		expect( fragmentShader ).toContain( 'material.diffuse = materialInput.baseColor.rgb' );
		expect( () => validateGroundMaterialSource( material, 'surface' ) ).not.toThrow();
	} );
} );
