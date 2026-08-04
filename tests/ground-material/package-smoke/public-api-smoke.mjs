// Runtime package smoke runs only after build:lib. Importing through dist files
// exercises the same Rollup output selected by package.json exports without
// depending on the TypeScript source graph used by unit tests.

const rootEntry = await import( new URL( '../../../dist/index.js', import.meta.url ) );
const groundEntry = await import( new URL( '../../../dist/ground.js', import.meta.url ) );

const requiredRuntimeExports = [
	'C23_GROUND_SHADER_ABI_VERSION',
	'C23_GROUND_VERTEX_SHADER_TEMPLATE',
	'C23_GROUND_FRAGMENT_SHADER_TEMPLATE',
	'createGroundVertexShader',
	'createGroundFragmentShader',
	'CesiumGroundMaterial',
	'CesiumGroundMaterialAppearance',
	'CesiumGroundRawShaderAppearance',
	'CesiumGroundMaterialError',
	'createColorGroundMaterial',
	'createTexturedDecalMaterial',
	'createPolylineDashMaterial',
	'createFlowLineMaterial',
	'createPulsePointMaterial',
	'createScalePulseMaterial',
];

for ( const name of requiredRuntimeExports ) {
	if ( rootEntry[ name ] === undefined || groundEntry[ name ] === undefined ) {
		throw new Error( `Built package is missing public Ground Material export "${ name }".` );
	}
	if ( rootEntry[ name ] !== groundEntry[ name ] ) {
		throw new Error( `Built root and ground entries disagree for "${ name }".` );
	}
}

if ( rootEntry.C23_GROUND_SHADER_ABI_VERSION !== 1 ) {
	throw new Error( 'Built package exposes an unexpected Ground Shader ABI version.' );
}

console.log( `Verified ${ requiredRuntimeExports.length } built Ground Material runtime exports.` );
