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

/** Color input that can carry an explicit straight alpha component. */
export type GroundColorInput = ColorRepresentation | Vector4;

export interface PolylineDashMaterialOptions {
	/** Straight-RGB multiplier applied after the primitive line color. */
	color?: ColorRepresentation;
	/** Foreground straight-alpha multiplier in the inclusive range [0, 1]. */
	opacity?: number;
	/** Visible dash length in world meters. */
	dashLengthMeters?: number;
	/** Transparent gap length in world meters; zero degenerates to a solid line. */
	gapLengthMeters?: number;
	/** Signed phase translation in world meters. */
	offsetMeters?: number;
}

export interface FlowLineMaterialOptions {
	/** Bright trail-head RGB; alpha is supplied separately by opacity. */
	color?: ColorRepresentation;
	/** Bright trail-head straight alpha in the inclusive range [0, 1]. */
	opacity?: number;
	/** Straight RGBA shown outside the moving trail; default is transparent. */
	backgroundColor?: GroundColorInput;
	/** Absolute-time velocity in cycles per second. */
	speed?: number;
	/** Number of repeated cells across the complete line. */
	repeat?: number;
	/** Fraction of one cell occupied by the fading trail. */
	trailFraction?: number;
	/** Any negative value selects reverse; zero and positives select forward. */
	direction?: number;
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

/**
 * Dash coverage uses the ABI's complete-line meter coordinate. A gap returns
 * alpha zero rather than discarding so the Material remains a portable pure
 * function when compiled for a classification kind.
 */
export const C23_POLYLINE_DASH_MATERIAL_SOURCE = /* glsl */ `
uniform vec4 u_color;
uniform float u_dashLengthMeters;
uniform float u_gapLengthMeters;
uniform float u_offsetMeters;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	float dashLength = max(u_dashLengthMeters, 1e-6);
	float gapLength = max(u_gapLengthMeters, 0.0);
	float period = dashLength + gapLength;
	float rawPhase = mod(materialInput.distanceAlongMeters + u_offsetMeters, period);
	float phase = mod(rawPhase + period, period);

	float coverage = 1.0;
	if (gapLength > 0.0) {
		float aa = max(fwidth(materialInput.distanceAlongMeters), 1e-4);
		coverage = 1.0 - smoothstep(dashLength - aa, dashLength + aa, phase);
	}

	vec4 straightColor = clamp(materialInput.baseColor, 0.0, 1.0)
		* clamp(u_color, 0.0, 1.0);
	c23_material material;
	material.diffuse = straightColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = straightColor.a * coverage;
	return material;
}
`;

/**
 * Flow phase depends only on absolute system time. It deliberately does not
 * read delta/frame uniforms, so equal timestamps produce equal output at every
 * host frame rate and no internal clock or render loop is required.
 */
export const C23_FLOW_LINE_MATERIAL_SOURCE = /* glsl */ `
uniform vec4 u_color;
uniform vec4 u_backgroundColor;
uniform float u_speed;
uniform float u_repeat;
uniform float u_trailFraction;
uniform float u_direction;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	float along01 = materialInput.lineTotalMeters > 1e-6
		? clamp(materialInput.distanceAlongMeters / materialInput.lineTotalMeters, 0.0, 1.0)
		: clamp(materialInput.st.x, 0.0, 1.0);
	float direction = u_direction < 0.0 ? -1.0 : 1.0;
	float orientedAlong = direction > 0.0 ? along01 : 1.0 - along01;
	float cellPhase = fract(
		orientedAlong * max(u_repeat, 1e-6)
		- c23_time * max(u_speed, 0.0)
	);
	float distanceBehindHead = fract(-cellPhase);
	float trail = clamp(u_trailFraction, 1e-4, 1.0);
	float aa = max(fwidth(cellPhase), 1e-4);
	float intensity = 1.0 - smoothstep(
		max(trail - aa, 0.0),
		min(trail + aa, 1.0),
		distanceBehindHead
	);

	vec4 straightColor = mix(
		clamp(u_backgroundColor, 0.0, 1.0),
		clamp(u_color, 0.0, 1.0),
		intensity
	);
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

/** Resolves an optional number and enforces a finite lower-bound contract. */
function requireFiniteAtLeast(
	value: number | undefined,
	fallback: number,
	minimum: number,
	field: string,
	strict: boolean,
): number {
	const resolved = value ?? fallback;
	const validBound = strict ? resolved > minimum : resolved >= minimum;
	if ( ! Number.isFinite( resolved ) || ! validBound ) {
		const operator = strict ? 'greater than' : 'greater than or equal to';
		throw new RangeError( `${ field } must be finite and ${ operator } ${ minimum }.` );
	}
	return resolved;
}

/** Accepts any finite signed scalar, used for phase offsets and direction. */
function requireFiniteNumber( value: number | undefined, fallback: number, field: string ): number {
	const resolved = value ?? fallback;
	if ( ! Number.isFinite( resolved ) ) throw new RangeError( `${ field } must be finite.` );
	return resolved;
}

/** Converts the public explicit-alpha color form without dropping its `w`. */
function createGroundColorVector(
	input: GroundColorInput | undefined,
	fallback: Vector4,
	field: string,
): Vector4 {
	if ( input === undefined ) return fallback.clone();
	if ( input instanceof Vector4 ) {
		if (
			! Number.isFinite( input.x ) || ! Number.isFinite( input.y ) ||
			! Number.isFinite( input.z ) || ! Number.isFinite( input.w ) ||
			input.w < 0.0 || input.w > 1.0
		) {
			throw new RangeError( `${ field } Vector4 must be finite with alpha in [0, 1].` );
		}
		return input.clone();
	}
	const color = new Color( input );
	return new Vector4( color.r, color.g, color.b, 1.0 );
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

/**
 * Creates an antialiased meter-based dash Material. Uniform values remain
 * mutable, but the four-entry schema and shader source stay fixed for program
 * reuse across lines and runtime phase updates.
 */
export function createPolylineDashMaterial(
	options: PolylineDashMaterialOptions = {},
): CesiumGroundMaterial {
	if ( options === null || typeof options !== 'object' ) {
		throw new TypeError( 'Polyline Dash Material options must be an object.' );
	}
	const color = new Color( options.color ?? 0xffffff );
	const opacity = requireNormalizedOpacity( options.opacity, 'Polyline Dash opacity' );
	const dashLengthMeters = requireFiniteAtLeast(
		options.dashLengthMeters, 16.0, 0.0, 'Polyline Dash dashLengthMeters', true,
	);
	const gapLengthMeters = requireFiniteAtLeast(
		options.gapLengthMeters, 8.0, 0.0, 'Polyline Dash gapLengthMeters', false,
	);
	const offsetMeters = requireFiniteNumber(
		options.offsetMeters, 0.0, 'Polyline Dash offsetMeters',
	);

	return new CesiumGroundMaterial( {
		type: 'PolylineDashGroundMaterial',
		uniforms: {
			u_color: { value: new Vector4( color.r, color.g, color.b, opacity ) },
			u_dashLengthMeters: { value: dashLengthMeters },
			u_gapLengthMeters: { value: gapLengthMeters },
			u_offsetMeters: { value: offsetMeters },
		},
		fragmentShader: C23_POLYLINE_DASH_MATERIAL_SOURCE,
	} );
}

/**
 * Creates an absolute-time FlowLine Material with a fixed six-uniform schema.
 * Direction is normalized once so runtime shader evaluation never treats
 * arbitrary magnitudes as speed, and no timer/RAF is allocated by the factory.
 */
export function createFlowLineMaterial(
	options: FlowLineMaterialOptions = {},
): CesiumGroundMaterial {
	if ( options === null || typeof options !== 'object' ) {
		throw new TypeError( 'Flow Line Material options must be an object.' );
	}
	const color = new Color( options.color ?? 0x00ffff );
	const opacity = requireNormalizedOpacity( options.opacity, 'Flow Line opacity' );
	const backgroundColor = createGroundColorVector(
		options.backgroundColor,
		new Vector4( 0, 0, 0, 0 ),
		'Flow Line backgroundColor',
	);
	const speed = requireFiniteAtLeast(
		options.speed, 1.0, 0.0, 'Flow Line speed', false,
	);
	const repeat = requireFiniteAtLeast(
		options.repeat, 1.0, 0.0, 'Flow Line repeat', true,
	);
	const trailFraction = requireFiniteAtLeast(
		options.trailFraction, 0.35, 0.0, 'Flow Line trailFraction', true,
	);
	if ( trailFraction > 1.0 ) {
		throw new RangeError( 'Flow Line trailFraction must be in the interval (0, 1].' );
	}
	const directionInput = requireFiniteNumber( options.direction, 1.0, 'Flow Line direction' );
	const direction = directionInput < 0.0 ? -1.0 : 1.0;

	return new CesiumGroundMaterial( {
		type: 'FlowLineGroundMaterial',
		uniforms: {
			u_color: { value: new Vector4( color.r, color.g, color.b, opacity ) },
			u_backgroundColor: { value: backgroundColor },
			u_speed: { value: speed },
			u_repeat: { value: repeat },
			u_trailFraction: { value: trailFraction },
			u_direction: { value: direction },
		},
		fragmentShader: C23_FLOW_LINE_MATERIAL_SOURCE,
	} );
}
