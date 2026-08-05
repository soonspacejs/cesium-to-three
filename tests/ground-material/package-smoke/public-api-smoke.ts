// Declaration smoke imports the package by its published names after build:lib.
// The assignments prove that both export maps resolve compatible class, factory,
// Appearance, and option declarations rather than only emitting JavaScript.

import {
	CesiumGroundMaterial,
	CesiumGroundMaterialAppearance,
	createGroundFragmentShader,
	createGroundVertexShader,
	createPulsePointMaterial,
	type GroundRawShaderBuildContext,
	type PulsePointMaterialOptions,
} from 'cesium-to-three';
import {
	CesiumGroundMaterial as GroundCesiumGroundMaterial,
	CesiumGroundMaterialAppearance as GroundCesiumGroundMaterialAppearance,
	createGroundFragmentShader as createGroundEntryFragmentShader,
	createGroundVertexShader as createGroundEntryVertexShader,
	createPulsePointMaterial as createGroundPulsePointMaterial,
	type GroundRawShaderBuildContext as GroundEntryRawShaderBuildContext,
	type PulsePointMaterialOptions as GroundEntryPulsePointMaterialOptions,
} from 'cesium-to-three/ground';
import {
	HeightReference,
	createPlotEditor,
	type EditorCommand,
	type PlotDocumentSnapshot,
	type PlotEditor,
	type PlotEditorOptions,
} from 'cesium-to-three/plot-editor';

const rootOptions: PulsePointMaterialOptions = { periodSeconds: 1.5, phase: 0.25 };
const groundOptions: GroundEntryPulsePointMaterialOptions = rootOptions;

export const rootVertexShader: string = createGroundVertexShader(
	'',
	'vertexOutput.positionClip.x += c23_time * 0.0;',
);
export const groundVertexShader: string = createGroundEntryVertexShader(
	'',
	'vertexOutput.positionClip.x += c23_time * 0.0;',
);
export const rootFragmentShader: string = createGroundFragmentShader(
	'',
	'material.alpha *= 1.0;',
);
export const groundFragmentShader: string = createGroundEntryFragmentShader(
	'',
	'material.alpha *= 1.0;',
);

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

export const plotEditorHeightReference: number = HeightReference.CLAMP_TO_GROUND;
export const plotEditorFactory: ( options: PlotEditorOptions ) => PlotEditor = createPlotEditor;
export const plotEditorCommand: EditorCommand = Object.freeze( {
	type: 'feature.remove',
	ids: Object.freeze( [] ),
} );
export const emptyPlotDocument: PlotDocumentSnapshot = Object.freeze( {
	schema: 'cesium-to-three/plot-document',
	version: 1,
	documentId: 'package-smoke',
	revision: 0,
	features: Object.freeze( [] ),
	order: Object.freeze( [] ),
} );
