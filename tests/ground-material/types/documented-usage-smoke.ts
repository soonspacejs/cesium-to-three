// Compile-only contract for the usage examples published in
// docs/animation-material/README.md. Keeping the examples represented as real
// TypeScript prevents public method names and ownership guidance from drifting
// away from the emitted package declarations.

import { Texture } from 'three';

import {
	CesiumGroundMaterialAppearance,
	type CesiumGroundPointPrimitive,
	type CesiumGroundPolylinePrimitive,
	createFlowLineMaterial,
	createPulsePointMaterial,
	createScalePulseMaterial,
} from '../../../src/lib/ground';

export interface DocumentedMaterialExampleTargets {
	/** Two lines that intentionally animate in lockstep through one Material. */
	lineA: CesiumGroundPolylinePrimitive;
	lineB: CesiumGroundPolylinePrimitive;
	/** Two fixed-footprint points whose phase values must remain independent. */
	pointA: CesiumGroundPointPrimitive;
	pointB: CesiumGroundPointPrimitive;
	/** A point used to demonstrate a caller-owned borrowed Texture. */
	texturedPoint: CesiumGroundPointPrimitive;
	/** Texture lifetime remains with the caller, never with Material/primitive. */
	texture: Texture;
}

/**
 * Exercises the documented sharing, cloning, hot-uniform, Appearance swap, and
 * borrowed-Texture lifetime contracts without requiring a WebGL renderer.
 */
export function configureDocumentedMaterialExamples(
	targets: DocumentedMaterialExampleTargets,
): () => void {
	// One Appearance references one logical Material. Binding it to both lines
	// means every compiled line pass retains the same user-uniform wrappers.
	const sharedFlowMaterial = createFlowLineMaterial( {
		color: '#00e5ff',
		speed: 0.35,
		repeat: 6,
		trailFraction: 0.3,
	} );
	const sharedFlowAppearance = new CesiumGroundMaterialAppearance( {
		material: sharedFlowMaterial,
	} );
	targets.lineA.setAppearance( sharedFlowAppearance );
	targets.lineB.setAppearance( sharedFlowAppearance );

	// Runtime values are updated in place. This changes both lines immediately
	// and deliberately leaves Material.version/program identity untouched.
	sharedFlowMaterial.setUniform( 'u_speed', 0.8 );

	// clone() is the explicit boundary for independent values. The second point
	// receives the same source/schema but owns a distinct u_phase wrapper.
	const pulseA = createPulsePointMaterial( { phase: 0.0 } );
	const pulseB = pulseA.clone().setUniform( 'u_phase', 0.5 );
	targets.pointA.setAppearance( new CesiumGroundMaterialAppearance( { material: pulseA } ) );
	targets.pointB.setAppearance( new CesiumGroundMaterialAppearance( { material: pulseB } ) );

	// Texture is borrowed by ScalePulse. setAppearance() compiles and installs
	// the new point pass atomically, but neither operation transfers ownership.
	const texturedPulse = createScalePulseMaterial( {
		texture: targets.texture,
		minScale: 0.75,
		maxScale: 1.0,
	} );
	targets.texturedPoint.setAppearance(
		new CesiumGroundMaterialAppearance( { material: texturedPulse } ),
	);

	return () => {
		// Detach every user Appearance before releasing logical values. Material
		// dispose only emits its notification; the caller still owns the Texture
		// and must dispose it explicitly after no compiled consumer references it.
		targets.lineA.setAppearance( undefined );
		targets.lineB.setAppearance( undefined );
		targets.pointA.setAppearance( undefined );
		targets.pointB.setAppearance( undefined );
		targets.texturedPoint.setAppearance( undefined );
		sharedFlowMaterial.dispose();
		pulseA.dispose();
		pulseB.dispose();
		texturedPulse.dispose();
		targets.texture.dispose();
	};
}
