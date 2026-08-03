// ============================================================
// material/builtins.ts
// Purpose: documented, shareable logical Material presets. Factories validate
//          and normalize once; render frames mutate existing wrappers only and
//          never rebuild source, allocate textures, or start an animation loop.
// ============================================================

import { Color, Texture, Vector4, type ColorRepresentation } from 'three';

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

/** Options for the shared transparent-texture decal preset used by text/image. */
export interface TexturedDecalMaterialOptions {
	/** Borrowed texture sampled in the decal's normalized planar coordinates. */
	texture: Texture;
	/** Additional straight-alpha multiplier in [0, 1]. */
	opacity?: number;
	/** Straight-RGB/A tint multiplier; defaults to white/one. */
	tint?: GroundColorInput;
	/** Whether the shader flips the V coordinate before sampling. */
	flipY?: boolean;
}

export interface PulsePointMaterialOptions {
	/** Straight-RGB multiplier applied after the point's base color. */
	color?: ColorRepresentation;
	/** Animation period in seconds; must be strictly positive. */
	periodSeconds?: number;
	/** Minimum nominal radius multiplier; must be positive. */
	minScale?: number;
	/** Maximum nominal radius multiplier; must be >= minScale. */
	maxScale?: number;
	/** Minimum straight-alpha multiplier in [0, 1]. */
	minOpacity?: number;
	/** Maximum straight-alpha multiplier in [0, 1]. */
	maxOpacity?: number;
	/** Phase offset measured in cycles. */
	phase?: number;
	/** Radial edge softness in normalized footprint units, [0, 0.5]. */
	edgeSoftness?: number;
	/** Preallocated footprint / nominal footprint; must be >= maxScale. */
	footprintScale?: number;
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

/**
 * Textured decals never discard transparent texels. A zero-alpha result still
 * reaches classification's fixed ZeroStencilOp cleanup, which prevents glyph
 * padding or transparent image pixels from leaving stale stencil bits.
 */
export const C23_TEXTURED_DECAL_MATERIAL_SOURCE = /* glsl */ `
uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_tint;
uniform float u_flipY;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	vec2 uv = vec2(
		clamp(materialInput.st.x, 0.0, 1.0),
		u_flipY > 0.5 ? 1.0 - clamp(materialInput.st.y, 0.0, 1.0) : clamp(materialInput.st.y, 0.0, 1.0)
	);
	vec4 texel = texture(u_texture, uv);
	vec4 straightColor = clamp(texel, 0.0, 1.0)
		* clamp(u_tint, 0.0, 1.0)
		* clamp(materialInput.baseColor, 0.0, 1.0);
	straightColor.a *= clamp(u_opacity, 0.0, 1.0);

	c23_material material;
	material.diffuse = straightColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = straightColor.a;
	return material;
}
`;

/**
 * PulsePoint evaluates a deterministic cosine wave from host-provided absolute
 * time. It only attenuates fragment alpha, so primitive geometry and any legacy
 * stroke membership remain owned by the point delegate rather than moving in
 * response to the effect.
 */
export const C23_PULSE_POINT_MATERIAL_SOURCE = /* glsl */ `
uniform vec4 u_color;
uniform float u_periodSeconds;
uniform float u_minScale;
uniform float u_maxScale;
uniform float u_minOpacity;
uniform float u_maxOpacity;
uniform float u_phase;
uniform float u_edgeSoftness;
uniform float u_footprintScale;

c23_material c23_getMaterial(c23_materialInput materialInput) {
	const float twoPi = 6.283185307179586;
	float phase01 = fract(
		c23_time / max(u_periodSeconds, 1e-6) + u_phase
	);
	float wave = 0.5 - 0.5 * cos(twoPi * phase01);
	float requestedScale = max(mix(u_minScale, u_maxScale, wave), 1e-4);
	float footprintScale = max(u_footprintScale, 1e-6);
	float normalizedScale = clamp(requestedScale / footprintScale, 1e-4, 1.0);
	float opacity = clamp(mix(u_minOpacity, u_maxOpacity, wave), 0.0, 1.0);

	float radius01 = length((materialInput.st - vec2(0.5)) * 2.0);
	float edge = max(
		max(clamp(u_edgeSoftness, 0.0, 0.5), fwidth(radius01)),
		1e-5
	);
	float coverage = 1.0 - smoothstep(
		max(normalizedScale - edge, 0.0),
		normalizedScale,
		radius01
	);

	vec4 straightColor = clamp(materialInput.baseColor, 0.0, 1.0)
		* clamp(u_color, 0.0, 1.0);

	c23_material material;
	material.diffuse = straightColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = straightColor.a * opacity * coverage;
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

/** Validates a normalized softness parameter shared by radial and UV effects. */
function requireEdgeSoftness( value: number | undefined, fallback: number, field: string ): number {
	const resolved = value ?? fallback;
	if ( ! Number.isFinite( resolved ) || resolved < 0.0 || resolved > 0.5 ) {
		throw new RangeError( `${ field } must be finite in the inclusive range [0, 0.5].` );
	}
	return resolved;
}

/** Validates the construction-time geometry budget recorded by animated effects. */
function requireFootprintScale(
	value: number | undefined,
	maxScale: number,
	field: string,
): number {
	const resolved = value ?? Math.max( 1.0, maxScale );
	if ( ! Number.isFinite( resolved ) || resolved <= 0.0 || resolved < maxScale ) {
		throw new RangeError( `${ field } must be finite, positive, and >= maxScale.` );
	}
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

/** Creates a borrowed-texture decal Material with a fixed, program-stable ABI. */
export function createTexturedDecalMaterial(
	options: TexturedDecalMaterialOptions,
): CesiumGroundMaterial {
	if ( options === null || typeof options !== 'object' || ! ( options.texture instanceof Texture ) ) {
		throw new TypeError( 'Textured Decal Material requires a Three Texture.' );
	}
	const opacity = requireNormalizedOpacity( options.opacity, 'Textured Decal opacity' );
	const tint = createGroundColorVector(
		options.tint,
		new Vector4( 1, 1, 1, 1 ),
		'Textured Decal tint',
	);
	return new CesiumGroundMaterial( {
		type: 'TexturedDecalGroundMaterial',
		uniforms: {
			u_texture: { value: options.texture },
			u_opacity: { value: opacity },
			u_tint: { value: tint },
			u_flipY: { value: options.flipY === false ? 0.0 : 1.0 },
		},
		fragmentShader: C23_TEXTURED_DECAL_MATERIAL_SOURCE,
	} );
}

/** Creates a shareable radial pulse preset with a fixed nine-uniform schema. */
export function createPulsePointMaterial(
	options: PulsePointMaterialOptions = {},
): CesiumGroundMaterial {
	if ( options === null || typeof options !== 'object' ) {
		throw new TypeError( 'Pulse Point Material options must be an object.' );
	}
	const color = new Color( options.color ?? 0xffffff );
	const periodSeconds = requireFiniteAtLeast(
		options.periodSeconds, 1.5, 0.0, 'Pulse Point periodSeconds', true,
	);
	const minScale = requireFiniteAtLeast(
		options.minScale, 0.65, 0.0, 'Pulse Point minScale', true,
	);
	const maxScale = requireFiniteAtLeast(
		options.maxScale, 1.0, 0.0, 'Pulse Point maxScale', true,
	);
	if ( minScale > maxScale ) {
		throw new RangeError( 'Pulse Point minScale must be <= maxScale.' );
	}
	const minOpacity = requireNormalizedOpacity( options.minOpacity ?? 0.25, 'Pulse Point minOpacity' );
	const maxOpacity = requireNormalizedOpacity( options.maxOpacity ?? 1.0, 'Pulse Point maxOpacity' );
	if ( minOpacity > maxOpacity ) {
		throw new RangeError( 'Pulse Point minOpacity must be <= maxOpacity.' );
	}
	const phase = requireFiniteNumber( options.phase, 0.0, 'Pulse Point phase' );
	const edgeSoftness = requireEdgeSoftness(
		options.edgeSoftness, 0.02, 'Pulse Point edgeSoftness',
	);
	const footprintScale = requireFootprintScale(
		options.footprintScale, maxScale, 'Pulse Point footprintScale',
	);

	return new CesiumGroundMaterial( {
		type: 'PulsePointGroundMaterial',
		uniforms: {
			u_color: { value: new Vector4( color.r, color.g, color.b, 1.0 ) },
			u_periodSeconds: { value: periodSeconds },
			u_minScale: { value: minScale },
			u_maxScale: { value: maxScale },
			u_minOpacity: { value: minOpacity },
			u_maxOpacity: { value: maxOpacity },
			u_phase: { value: phase },
			u_edgeSoftness: { value: edgeSoftness },
			u_footprintScale: { value: footprintScale },
		},
		fragmentShader: C23_PULSE_POINT_MATERIAL_SOURCE,
	} );
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
