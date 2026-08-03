// ============================================================
// material/system-uniforms.ts
// Purpose: adapt deprecated SharedUniforms to the canonical c23_ namespace by
//          aliasing wrappers, never values. User merge is a separate checked
//          operation so ordinary user names such as u_color remain available.
// ============================================================

import type { IUniform } from 'three';

import type { SharedUniforms } from '../types';
import { CesiumGroundMaterialError } from './errors';
import type {
	GroundPrimitiveKind,
	GroundSystemUniforms,
	GroundUserUniforms,
} from './types';
import { assertGroundUserUniforms } from './validation';

export interface GroundTimeUniforms {
	c23_time: IUniform<number>;
	c23_deltaTime: IUniform<number>;
	c23_frameNumber: IUniform<number>;
}

/** New per-primitive time wrappers start at the documented static defaults. */
export function createGroundTimeUniforms(): GroundTimeUniforms {
	return {
		c23_time: { value: 0.0 },
		c23_deltaTime: { value: 0.0 },
		c23_frameNumber: { value: 0.0 },
	};
}

const COMMON_ALIASES = {
	czm_encodedCameraPositionMCHigh: 'czm_encodedCameraPositionMCHigh',
	czm_encodedCameraPositionMCLow: 'czm_encodedCameraPositionMCLow',
	czm_modelViewRelativeToEye: 'czm_modelViewRelativeToEye',
	czm_modelViewProjectionRelativeToEye: 'czm_modelViewProjectionRelativeToEye',
	czm_normal: 'czm_normal',
	czm_geometricToleranceOverMeter: 'czm_geometricToleranceOverMeter',
	czm_sceneMode: 'czm_sceneMode',
	czm_globeDepthTexture: 'czm_globeDepthTexture',
	czm_viewport: 'czm_viewport',
	czm_inverseProjection: 'czm_inverseProjection',
	czm_viewportTransformation: 'czm_viewportTransformation',
	czm_frustumPlanes: 'czm_frustumPlanes',
	czm_currentFrustum: 'czm_currentFrustum',
	czm_farDepthFromNearPlusOne: 'czm_farDepthFromNearPlusOne',
	czm_log2FarDepthFromNearPlusOne: 'czm_log2FarDepthFromNearPlusOne',
	czm_oneOverLog2FarDepthFromNearPlusOne: 'czm_oneOverLog2FarDepthFromNearPlusOne',
} as const;

export const LEGACY_SURFACE_UNIFORM_ALIASES = {
	c23_globeMinimumAltitude: 'u_globeMinimumAltitude',
	c23_southWestHigh: 'u_southWest_HIGH',
	c23_southWestLow: 'u_southWest_LOW',
	c23_eastward: 'u_eastward',
	c23_northward: 'u_northward',
	c23_uvMinAndExtents: 'u_uvMinAndExtents',
	c23_uMaxVmax: 'u_uMaxVmax',
	c23_fillColor: 'u_color',
	c23_strokeColor: 'u_borderColor',
	c23_borderEnabled: 'u_borderEnabled',
	c23_borderWidthMeters: 'u_borderWidthMeters',
	c23_innerMetersRect: 'u_innerMetersRect',
	c23_cpuWestPlane: 'u_cpuWestPlane',
	c23_cpuSouthPlane: 'u_cpuSouthPlane',
	c23_polygonBorderMode: 'u_polygonBorderMode',
	c23_polygonMiterStrokeMode: 'u_polygonMiterStrokeMode',
	c23_polygonPointCount: 'u_polygonPointCount',
	c23_polygonPoints: 'u_polygonPoints',
	c23_circleBorderMode: 'u_circleBorderMode',
	c23_circleCenterMeters: 'u_circleCenterMeters',
	c23_circleFillRadiusMeters: 'u_circleFillRadiusMeters',
	c23_circleRenderRadiusMeters: 'u_circleRenderRadiusMeters',
	c23_circleRingCount: 'u_circleRingCount',
	c23_circleRingGapMeters: 'u_circleRingGapMeters',
	c23_circleSectorStartRadians: 'u_circleSectorStartRadians',
	c23_circleSectorAngleRadians: 'u_circleSectorAngleRadians',
} as const;

export const LEGACY_LINE_UNIFORM_ALIASES = {
	czm_projection: 'czm_projection',
	czm_pixelRatio: 'czm_pixelRatio',
	c23_lineColor: 'u_color',
	c23_lineWidthPixels: 'u_lineWidthPixels',
	c23_lineWidthMode: 'u_lineWidthMode',
	c23_lineWidthMeters: 'u_lineWidthMeters',
	c23_lineTotalMeters: 'u_lineTotalMeters',
	c23_arrowWidthMode: 'u_arrowWidthMode',
	c23_arrowLengthPixels: 'u_arrowLengthPixels',
	c23_arrowHalfWidthPixels: 'u_arrowHalfWidthPixels',
	c23_arrowLengthMeters: 'u_arrowLengthMeters',
	c23_arrowHalfWidthMeters: 'u_arrowHalfWidthMeters',
	c23_arrowColor: 'u_arrowColor',
	c23_arrowStrokeHalfPixels: 'u_arrowStrokeHalfPixels',
	c23_lineArrowClipEndEnabled: 'u_lineArrowClipEndEnabled',
	c23_lineArrowClipStartEnabled: 'u_lineArrowClipStartEnabled',
	c23_lineArrowStyleStart: 'u_lineArrowStyleStart',
	c23_lineArrowStyleEnd: 'u_lineArrowStyleEnd',
} as const;

function appendAliases(
	target: Record<string, IUniform>,
	legacy: SharedUniforms,
	aliases: Readonly<Record<string, string>>,
): void {
	for ( const [ canonicalName, legacyName ] of Object.entries( aliases ) ) {
		const wrapper = legacy[ legacyName ];
		if ( wrapper !== undefined ) target[ canonicalName ] = wrapper as IUniform;
	}
}

/**
 * Builds one immutable canonical map. The map cannot be extended or have a
 * wrapper replaced, but each wrapper's `.value` remains mutable by the library.
 */
export function createCanonicalGroundSystemUniforms(
	legacy: SharedUniforms,
	kind: GroundPrimitiveKind,
	timeUniforms: GroundTimeUniforms = createGroundTimeUniforms(),
): GroundSystemUniforms {
	const canonical: Record<string, IUniform> = {};
	appendAliases( canonical, legacy, COMMON_ALIASES );
	canonical.c23_time = timeUniforms.c23_time;
	canonical.c23_deltaTime = timeUniforms.c23_deltaTime;
	canonical.c23_frameNumber = timeUniforms.c23_frameNumber;

	if ( kind === 'surface' || kind === 'decal' ) {
		appendAliases( canonical, legacy, LEGACY_SURFACE_UNIFORM_ALIASES );
	} else {
		appendAliases( canonical, legacy, LEGACY_LINE_UNIFORM_ALIASES );
	}
	return Object.freeze( canonical );
}

/** Creates a top-level compiled map while retaining every original wrapper. */
export function mergeGroundUniforms(
	systemUniforms: GroundSystemUniforms,
	userUniforms: GroundUserUniforms,
): Record<string, IUniform> {
	assertGroundUserUniforms( userUniforms );
	const merged: Record<string, IUniform> = Object.create( null ) as Record<string, IUniform>;

	for ( const [ name, uniform ] of Object.entries( systemUniforms ) ) merged[ name ] = uniform;
	for ( const [ name, uniform ] of Object.entries( userUniforms ) ) {
		if ( Object.prototype.hasOwnProperty.call( merged, name ) ) {
			throw new CesiumGroundMaterialError(
				'GROUND_UNIFORM_CONFLICT',
				`Ground user uniform "${ name }" conflicts with a system uniform.`,
				{ identifier: name, domain: 'system-uniform' },
			);
		}
		merged[ name ] = uniform;
	}
	return merged;
}
