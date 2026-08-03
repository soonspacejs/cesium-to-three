// ============================================================
// Purpose: link the migrated text/image decal routes with a real WebGL2
//          renderer. The fixture also checks that setText updates the existing
//          fixed topology instead of replacing the public command group.
// ============================================================

import {
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	Vector4,
	WebGLRenderer,
} from 'three';

import { CesiumGroundImagePrimitive } from '../../../src/lib/ground/image/image-primitive';
import { CesiumGroundPointPrimitive } from '../../../src/lib/ground/primitives';
import { CesiumGroundTextPrimitive } from '../../../src/lib/ground/text/text-primitive';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
} from '../../../src/lib/ground/material/appearances';

export interface DecalAppearanceCompileReport {
	ready: boolean;
	isWebGL2: boolean;
	errors: string[];
	materialNames: string[];
	decalDefines: boolean[];
	customUniformBound: boolean;
	rawPasses: string[];
	textGroupStable: boolean;
	textGeometryStable: boolean;
	textTextureStable: boolean;
	imagePointAppearanceForwarded: boolean;
}

declare global {
	interface Window {
		__C23_DECAL_APPEARANCE_COMPILE__?: DecalAppearanceCompileReport;
	}
}

const SAFE_SOURCE = /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	result.diffuse = materialInput.baseColor.rgb * u_tint.rgb;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`;

const IMAGE_URL = `data:image/svg+xml;charset=utf-8,${ encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#ef476f"/></svg>',
) }`;

function textOptions( appearance?: CesiumGroundMaterialAppearance | CesiumGroundRawShaderAppearance ) {
	return {
		points: [ [ 121.4, 31.2 ] ] as [ number, number ][],
		content: 'C23 DECAL',
		fontColor: '#ffffff',
		fontSize: 24,
		fontFamily: 'sans-serif',
		fontWeight: 'bold' as const,
		fontStrokeColor: '#132238',
		fontStrokeWidth: 1,
		fillColor: '#244568',
		fillOpacity: 100,
		strokeColor: '#75d6ff',
		strokeWidth: 1,
		strokeOpacity: 100,
		padding: [ 4, 8, 4, 8 ] as [ number, number, number, number ],
		textAlign: 'center' as const,
		verticalAlign: 'middle' as const,
		metersPerPixel: 0.5,
		anchorX: 'center' as const,
		anchorY: 'middle' as const,
		visible: true,
		appearance,
	};
}

async function preloadImage( url: string ): Promise<void> {
	await new Promise<void>( ( resolve, reject ) => {
		const image = new Image();
		image.onload = () => resolve();
		image.onerror = () => reject( new Error( 'Decal fixture image preload failed.' ) );
		image.src = url;
	} );
}

async function compileDecalAppearances(): Promise<DecalAppearanceCompileReport> {
	await preloadImage( IMAGE_URL );
	const renderer = new WebGLRenderer( { antialias: false, alpha: false, stencil: true } );
	renderer.setSize( 64, 64, false );
	renderer.debug.checkShaderErrors = true;
	document.body.appendChild( renderer.domElement );
	const errors: string[] = [];
	renderer.debug.onShaderError = ( context, program, vertexShader, fragmentShader ) => {
		errors.push( [
			context.getProgramInfoLog( program ) ?? '',
			context.getShaderInfoLog( vertexShader ) ?? '',
			context.getShaderInfoLog( fragmentShader ) ?? '',
		].join( '\n' ) );
	};

	const safeMaterial = new CesiumGroundMaterial( {
		type: 'Stage10SafeDecal',
		uniforms: { u_tint: { value: new Vector4( 1, 0.8, 0.7, 0.9 ) } },
		fragmentShader: SAFE_SOURCE,
	} );
	const safeAppearance = new CesiumGroundMaterialAppearance( { material: safeMaterial } );
	const rawPasses: string[] = [];
	const rawAppearance = new CesiumGroundRawShaderAppearance( {
		factory: context => {
			rawPasses.push( `${ context.primitiveKind}:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = 'Stage10RawDecal';
			return material;
		},
	} );

	const defaultText = new CesiumGroundTextPrimitive( textOptions() );
	const safeText = new CesiumGroundTextPrimitive( textOptions( safeAppearance ) );
	const rawText = new CesiumGroundTextPrimitive( textOptions( rawAppearance ) );
	const defaultImage = new CesiumGroundImagePrimitive( {
		position: [ 121.4, 31.201 ], imageUrl: IMAGE_URL, imageWidth: 20, imageHeight: 20,
		strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
		fillColor: '#ffffff', fillOpacity: 100, visible: true,
	} );
	const safeImage = new CesiumGroundImagePrimitive( {
		position: [ 121.401, 31.201 ], imageUrl: IMAGE_URL, imageWidth: 20, imageHeight: 20,
		strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
		fillColor: '#ffffff', fillOpacity: 100, visible: true, appearance: safeAppearance,
	} );
	const rawImage = new CesiumGroundImagePrimitive( {
		position: [ 121.402, 31.201 ], imageUrl: IMAGE_URL, imageWidth: 20, imageHeight: 20,
		strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
		fillColor: '#ffffff', fillOpacity: 100, visible: true, appearance: rawAppearance,
	} );
	const imagePoint = new CesiumGroundPointPrimitive( {
		position: [ 121.403, 31.201 ], shape: 'image', imageUrl: IMAGE_URL,
		imageWidth: 20, imageHeight: 20,
		strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
		fillColor: '#ffffff', fillOpacity: 100, visible: true, appearance: safeAppearance,
	} );
	const primitives = [
		defaultText, safeText, rawText, defaultImage, safeImage, rawImage, imagePoint,
	];
	const scene = new Scene();
	for ( const primitive of primitives ) {
		scene.add( primitive instanceof CesiumGroundPointPrimitive
			? primitive.classification.group
			: primitive.group );
	}
	const camera = new PerspectiveCamera( 45, 1, 1, 1_000_000 );
	camera.position.z = 2;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );
	renderer.compile( scene, camera );

	const colors = primitives.map( primitive =>
		( primitive.classification.group.getObjectByName( 'CesiumClassificationColorCommand' )
			?.material as RawShaderMaterial ),
	);
	const beforeGroup = defaultText.group;
	const beforeGeometry = defaultText.classification.group
		.getObjectByName( 'CesiumClassificationColorCommand' )!.geometry;
	const beforeTexture = colors[ 0 ].uniforms.u_texture.value;
	defaultText.setText( { content: 'C23 UPDATED' } );
	const afterGeometry = defaultText.classification.group
		.getObjectByName( 'CesiumClassificationColorCommand' )!.geometry;
	const report: DecalAppearanceCompileReport = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		errors,
		materialNames: colors.map( material => material.name ),
		decalDefines: colors.map( material => material.fragmentShader.includes( '#define C23_DECAL 1' ) ),
		customUniformBound: colors[ 1 ].uniforms.u_tint === safeMaterial.uniforms.u_tint,
		rawPasses,
		textGroupStable: defaultText.group === beforeGroup,
		textGeometryStable: afterGeometry === beforeGeometry,
		textTextureStable: colors[ 0 ].uniforms.u_texture.value === beforeTexture,
		imagePointAppearanceForwarded: imagePoint.appearance === safeAppearance,
	};
	for ( const primitive of primitives ) primitive.dispose();
	renderer.dispose();
	return report;
}

compileDecalAppearances().then( report => {
	window.__C23_DECAL_APPEARANCE_COMPILE__ = report;
} ).catch( error => {
	console.error( '[decal-appearance fixture] failed', error );
	throw error;
} );
