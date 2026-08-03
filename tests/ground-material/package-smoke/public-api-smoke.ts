// Declaration smoke imports the package by its published names after build:lib.
// The assignments prove that both export maps resolve compatible class, factory,
// Appearance, and option declarations rather than only emitting JavaScript.

import {
	CesiumGroundMaterial,
	CesiumGroundMaterialAppearance,
	createPulsePointMaterial,
	type GroundRawShaderBuildContext,
	type PulsePointMaterialOptions,
} from 'cesium-to-three';
import {
	CesiumGroundMaterial as GroundCesiumGroundMaterial,
	CesiumGroundMaterialAppearance as GroundCesiumGroundMaterialAppearance,
	createPulsePointMaterial as createGroundPulsePointMaterial,
	type GroundRawShaderBuildContext as GroundEntryRawShaderBuildContext,
	type PulsePointMaterialOptions as GroundEntryPulsePointMaterialOptions,
} from 'cesium-to-three/ground';

const rootOptions: PulsePointMaterialOptions = { periodSeconds: 1.5, phase: 0.25 };
const groundOptions: GroundEntryPulsePointMaterialOptions = rootOptions;

export const rootMaterial: CesiumGroundMaterial = createPulsePointMaterial( rootOptions );
export const groundMaterial: GroundCesiumGroundMaterial =
	createGroundPulsePointMaterial( groundOptions );
export const rootAppearance = new CesiumGroundMaterialAppearance( { material: rootMaterial } );
export const groundAppearance = new GroundCesiumGroundMaterialAppearance( {
	material: groundMaterial,
} );

type Equal<A, B> =
	( <T>() => T extends A ? 1 : 2 ) extends ( <T>() => T extends B ? 1 : 2 )
		? true
		: false;
type Assert<T extends true> = T;

export type BuiltDeclarationParity = [
	Assert<Equal<GroundRawShaderBuildContext, GroundEntryRawShaderBuildContext>>,
	Assert<Equal<PulsePointMaterialOptions, GroundEntryPulsePointMaterialOptions>>,
];
