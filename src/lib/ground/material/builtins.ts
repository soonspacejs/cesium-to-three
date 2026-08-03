// ============================================================
// material/builtins.ts
// Purpose: documented, shareable logical Material presets. Factories validate
//          and normalize once; render frames mutate existing wrappers only and
//          never rebuild source, allocate textures, or start an animation loop.
// ============================================================

import { Color, Vector4, type ColorRepresentation } from 'three';

import { CesiumGroundMaterial } from './CesiumGroundMaterial';

export interface ColorGroundMaterialOptions {
	/** Straight-RGB multiplier applied after system fill/stroke selection. */
	color?: ColorRepresentation;
	/** Straight-alpha multiplier in the inclusive range [0, 1]. */
	opacity?: number;
}

/** Exact documented GLSL for the cross-kind default Color preset. */
export const C23_COLOR_GROUND_MATERIAL_SOURCE = /* glsl */ `
uniform vec4 u_color;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	vec4 straightColor = clamp(materialInput.baseColor, 0.0, 1.0)
		* clamp(u_color, 0.0, 1.0);

	c23_material material;
	material.diffuse = straightColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = straightColor.a;
	return material;
}
`;

/** Validates a normalized public opacity without silently changing intent. */
function requireNormalizedOpacity( value: number | undefined, field: string ): number {
	const resolved = value ?? 1.0;
	if ( ! Number.isFinite( resolved ) || resolved < 0.0 || resolved > 1.0 ) {
		throw new RangeError( `${ field } must be a finite number in the inclusive range [0, 1].` );
	}
	return resolved;
}

/**
 * Creates the default multiplier Material used by surfaces, solid lines,
 * untextured decals, and arrows. White/one is behaviorally transparent: system
 * `materialInput.baseColor` passes through unchanged.
 */
export function createColorGroundMaterial(
	options: ColorGroundMaterialOptions = {},
): CesiumGroundMaterial {
	if ( options === null || typeof options !== 'object' ) {
		throw new TypeError( 'Color Ground Material options must be an object.' );
	}
	const color = new Color( options.color ?? 0xffffff );
	const opacity = requireNormalizedOpacity( options.opacity, 'Color Ground Material opacity' );

	return new CesiumGroundMaterial( {
		type: 'ColorGroundMaterial',
		uniforms: {
			// One Vector4 keeps RGB and opacity updates atomic for Three's uploader
			// while preserving the documented single-entry user schema.
			u_color: { value: new Vector4( color.r, color.g, color.b, opacity ) },
		},
		fragmentShader: C23_COLOR_GROUND_MATERIAL_SOURCE,
	} );
}
