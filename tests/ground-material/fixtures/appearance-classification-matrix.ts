import {
	DataTexture,
	Group,
	Mesh,
	PerspectiveCamera,
	RawShaderMaterial,
	Scene,
	Vector4,
	WebGLRenderer,
} from 'three';

import {
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
	CesiumGroundRectanglePrimitive,
} from '../../../src/lib/ground/primitives';
import { CesiumGroundImagePrimitive } from '../../../src/lib/ground/image/image-primitive';
import { CesiumGroundTextPrimitive } from '../../../src/lib/ground/text/text-primitive';
import { CesiumGroundMaterial } from '../../../src/lib/ground/material/CesiumGroundMaterial';
import {
	CesiumGroundMaterialAppearance,
	CesiumGroundRawShaderAppearance,
	type CesiumGroundAppearance,
} from '../../../src/lib/ground/material/appearances';
import {
	createFlowLineMaterial,
	createPulsePointMaterial,
	createScalePulseMaterial,
	createTexturedDecalMaterial,
} from '../../../src/lib/ground/material/builtins';
import { ClassificationType, type CesiumGroundFrameState } from '../../../src/lib/ground/types';

type MatrixVariant = 'default' | 'safe' | 'raw';

export interface AppearanceClassificationMatrixEntry {
	row: string;
	variant: MatrixVariant;
	classificationType: 'TERRAIN' | 'CESIUM_3D_TILE' | 'BOTH';
	alpha: 1 | 0.5 | 0;
	appearanceKind: 'material' | 'raw';
	depthTextureMatched: boolean;
	materialPass: string;
}

export interface AppearanceClassificationMatrixReport {
	ready: boolean;
	isWebGL2: boolean;
	errors: string[];
	entries: AppearanceClassificationMatrixEntry[];
	rawPasses: Record<string, string[]>;
	programCount: number;
}

declare global {
	interface Window {
		__C23_APPEARANCE_CLASSIFICATION_MATRIX__?: AppearanceClassificationMatrixReport;
	}
}

interface MatrixPrimitive {
	update( frameState: CesiumGroundFrameState ): void;
	dispose(): void;
}

interface PendingEntry {
	row: string;
	variant: MatrixVariant;
	classificationType: ClassificationType;
	alpha: 1 | 0.5 | 0;
	primitive: MatrixPrimitive;
	group: Group;
	material(): RawShaderMaterial;
	appearance(): CesiumGroundAppearance;
}

const IMAGE_URL = `data:image/svg+xml;charset=utf-8,${ encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#57cc99"/><circle cx="8" cy="8" r="4" fill="#22577a"/></svg>',
) }`;

const SAFE_SOURCE = /* glsl */ `
uniform vec4 u_tint;
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material result;
	float pattern = 0.75 + 0.25 * step(0.0, sin(materialInput.localMeters.x * 0.1));
	result.diffuse = mix(materialInput.baseColor.rgb, u_tint.rgb, materialInput.isStroke) * pattern;
	result.emission = vec3(0.0);
	result.alpha = materialInput.baseColor.a * u_tint.a;
	return result;
}
`;

function safeAppearance(): CesiumGroundMaterialAppearance {
	return new CesiumGroundMaterialAppearance( {
		material: new CesiumGroundMaterial( {
			type: 'AcceptanceMatrixSafe',
			uniforms: { u_tint: { value: new Vector4( 0.7, 0.9, 1, 1 ) } },
			fragmentShader: SAFE_SOURCE,
		} ),
	} );
}

function rawAppearance(
	row: string,
	rawPasses: Record<string, string[]>,
): CesiumGroundRawShaderAppearance {
	rawPasses[ row ] = [];
	return new CesiumGroundRawShaderAppearance( {
		factory: context => {
			rawPasses[ row ].push( `${ context.primitiveKind }:${ context.pass }` );
			const material = context.createDefaultMaterial();
			material.name = `AcceptanceMatrixRaw/${ row }/${ context.pass }`;
			return material;
		},
	} );
}

function colorCommand( group: Group ): RawShaderMaterial {
	const mesh = group.getObjectByName( 'CesiumClassificationColorCommand' );
	if ( ! ( mesh instanceof Mesh ) ) throw new Error( 'Classification color command missing.' );
	return mesh.material as RawShaderMaterial;
}

function lineCommand( group: Group ): RawShaderMaterial {
	const mesh = group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
	if ( ! ( mesh instanceof Mesh ) ) throw new Error( 'Polyline command missing.' );
	return mesh.material as RawShaderMaterial;
}

function arrowCommand( group: Group ): RawShaderMaterial {
	const mesh = group.getObjectByName( 'CesiumGroundPolylineArrowCommand' );
	if ( ! ( mesh instanceof Mesh ) ) throw new Error( 'Arrow command missing.' );
	return mesh.material as RawShaderMaterial;
}

function variantMeta( variant: MatrixVariant ): {
	classificationType: ClassificationType;
	alpha: 1 | 0.5 | 0;
	opacityPercent: number;
} {
	if ( variant === 'default' ) {
		return { classificationType: ClassificationType.TERRAIN, alpha: 1, opacityPercent: 100 };
	}
	if ( variant === 'safe' ) {
		return { classificationType: ClassificationType.CESIUM_3D_TILE, alpha: 0.5, opacityPercent: 50 };
	}
	return { classificationType: ClassificationType.BOTH, alpha: 0, opacityPercent: 0 };
}

function preloadImage( url: string ): Promise<void> {
	return new Promise( ( resolve, reject ) => {
		const image = new Image();
		image.onload = () => resolve();
		image.onerror = () => reject( new Error( 'Matrix image preload failed.' ) );
		image.src = url;
	} );
}

async function runMatrix(): Promise<AppearanceClassificationMatrixReport> {
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

	const fallbackDepth = new DataTexture( new Uint8Array( [ 1, 2, 3, 4 ] ), 1, 1 );
	const terrainDepth = new DataTexture( new Uint8Array( [ 10, 0, 0, 255 ] ), 1, 1 );
	const tilesetDepth = new DataTexture( new Uint8Array( [ 20, 0, 0, 255 ] ), 1, 1 );
	const bothDepth = new DataTexture( new Uint8Array( [ 30, 0, 0, 255 ] ), 1, 1 );
	const effectTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1 );
	for ( const texture of [ fallbackDepth, terrainDepth, tilesetDepth, bothDepth, effectTexture ] ) {
		texture.needsUpdate = true;
	}
	const camera = new PerspectiveCamera( 45, 1, 1, 10000000 );
	camera.position.set( 6378137, 0, 1000 );
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );
	const frameState: CesiumGroundFrameState = {
		depthTexture: fallbackDepth,
		classificationDepthTextures: {
			terrain: terrainDepth,
			tileset: tilesetDepth,
			both: bothDepth,
		},
		width: 64,
		height: 64,
		camera,
		timeSeconds: 1.25,
		deltaSeconds: 1 / 60,
		frameNumber: 75,
	};
	const expectedDepth = new Map( [
		[ ClassificationType.TERRAIN, terrainDepth ],
		[ ClassificationType.CESIUM_3D_TILE, tilesetDepth ],
		[ ClassificationType.BOTH, bothDepth ],
	] );
	const scene = new Scene();
	const pending: PendingEntry[] = [];
	const rawPasses: Record<string, string[]> = {};
	let coordinate = 0;
	const nextPosition = (): [ number, number ] => [ 121.4 + coordinate ++ * 0.0001, 31.2 ];
	const variants: MatrixVariant[] = [ 'default', 'safe', 'raw' ];

	for ( const variant of variants ) {
		const meta = variantMeta( variant );
		const appearance = variant === 'safe' ? safeAppearance() : variant === 'raw'
			? rawAppearance( `rectangle:${ variant }`, rawPasses ) : undefined;
		const p = nextPosition();
		const primitive = new CesiumGroundRectanglePrimitive( {
			points: [ p, [ p[ 0 ] + 0.00005, p[ 1 ] ], [ p[ 0 ] + 0.00005, p[ 1 ] + 0.00005 ], [ p[ 0 ], p[ 1 ] + 0.00005 ] ],
			strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: meta.opacityPercent,
			fillColor: '#4488cc', fillOpacity: meta.opacityPercent, visible: true,
			classificationType: meta.classificationType, appearance,
		} );
		pending.push( { row: 'rectangle', variant, ...meta, primitive, group: primitive.classification.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
	}

	for ( const variant of variants ) {
		const meta = variantMeta( variant );
		const appearance = variant === 'safe' ? safeAppearance() : variant === 'raw'
			? rawAppearance( `polygon-hole:${ variant }`, rawPasses ) : undefined;
		const p = nextPosition();
		const primitive = new CesiumGroundPolygonPrimitive( {
			points: [ p, [ p[ 0 ] + 0.00008, p[ 1 ] ], [ p[ 0 ] + 0.00008, p[ 1 ] + 0.00008 ], [ p[ 0 ], p[ 1 ] + 0.00008 ] ],
			holes: [ [ [ p[ 0 ] + 0.00002, p[ 1 ] + 0.00002 ], [ p[ 0 ] + 0.00004, p[ 1 ] + 0.00002 ], [ p[ 0 ] + 0.00003, p[ 1 ] + 0.00004 ] ] ],
			strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: meta.opacityPercent,
			fillColor: '#44aa77', fillOpacity: meta.opacityPercent, visible: true,
			classificationType: meta.classificationType, appearance,
		} );
		pending.push( { row: 'polygon-hole', variant, ...meta, primitive, group: primitive.classification.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
	}

	for ( const variant of variants ) {
		const meta = variantMeta( variant );
		const appearance = variant === 'safe' ? safeAppearance() : variant === 'raw'
			? rawAppearance( `circle-ring-sector:${ variant }`, rawPasses ) : undefined;
		const primitive = new CesiumGroundCirclePrimitive( {
			center: nextPosition(), radius: 20, ringCount: 2, ringGapMeters: 2,
			sectorStartDegrees: 20, sectorAngleDegrees: 280,
			strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: meta.opacityPercent,
			fillColor: '#aa55cc', fillOpacity: meta.opacityPercent, visible: true,
			classificationType: meta.classificationType, appearance,
		} );
		pending.push( { row: 'circle-ring-sector', variant, ...meta, primitive, group: primitive.classification.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
	}

	const makePolylineRow = ( row: string, dash: boolean, arrow: boolean ): void => {
		for ( const variant of variants ) {
			const meta = variantMeta( variant );
			const raw = variant === 'raw' ? rawAppearance( `${ row }:${ variant }`, rawPasses ) : undefined;
			const bodyAppearance = ! arrow
				? variant === 'safe'
					? new CesiumGroundMaterialAppearance( { material: dash ? createFlowLineMaterial() : safeAppearance().material } )
					: raw
				: undefined;
			const arrowAppearance = arrow
				? variant === 'safe' ? safeAppearance() : raw
				: undefined;
			const start = nextPosition();
			const primitive = new CesiumGroundPolylinePrimitive( {
				points: [ start, [ start[ 0 ] + 0.00008, start[ 1 ] + 0.00004 ] ],
				strokeColor: '#ff8844', strokeOpacity: meta.opacityPercent, visible: true,
				widthPixels: 4, dashLengthMeters: dash ? 5 : undefined, gapLengthMeters: dash ? 3 : undefined,
				arrowMode: arrow ? 'both' : 'none', startArrowStyle: 'solid', endArrowStyle: 'open',
				classificationType: meta.classificationType,
				appearance: bodyAppearance,
				arrowAppearance,
			} );
			pending.push( {
				row, variant, ...meta, primitive, group: primitive.group,
				material: () => arrow ? arrowCommand( primitive.group ) : lineCommand( primitive.group ),
				appearance: () => arrow ? primitive.arrowAppearance : primitive.appearance,
			} );
		}
	};
	makePolylineRow( 'polyline-solid', false, false );
	makePolylineRow( 'polyline-dash-flow', true, false );
	makePolylineRow( 'arrow-solid-open', false, true );

	const makeDecalAppearance = ( row: string, variant: MatrixVariant ): CesiumGroundAppearance | undefined => {
		if ( variant === 'raw' ) return rawAppearance( `${ row }:${ variant }`, rawPasses );
		if ( variant !== 'safe' ) return undefined;
		if ( row === 'text' || row === 'point-image' ) {
			return new CesiumGroundMaterialAppearance( {
				material: createTexturedDecalMaterial( { texture: effectTexture, opacity: 1 } ),
			} );
		}
		return new CesiumGroundMaterialAppearance( {
			material: createScalePulseMaterial( { texture: effectTexture, maxScale: 1 } ),
		} );
	};

	for ( const variant of variants ) {
		const meta = variantMeta( variant );
		const primitive = new CesiumGroundTextPrimitive( {
			points: [ nextPosition() ], content: 'MATRIX', fontColor: '#ffffff', fontSize: 16,
			fillColor: '#223344', fillOpacity: meta.opacityPercent,
			strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: meta.opacityPercent,
			visible: true, classificationType: meta.classificationType,
			appearance: makeDecalAppearance( 'text', variant ),
		} );
		pending.push( { row: 'text', variant, ...meta, primitive, group: primitive.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
	}

	const makeImageOptions = ( variant: MatrixVariant, row: string ) => {
		const meta = variantMeta( variant );
		return {
			position: nextPosition(), imageUrl: IMAGE_URL, imageWidth: 20, imageHeight: 20,
			strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
			fillColor: '#ffffff', fillOpacity: meta.opacityPercent, visible: true,
			classificationType: meta.classificationType,
			appearance: makeDecalAppearance( row, variant ),
		};
	};
	for ( const variant of variants ) {
		const meta = variantMeta( variant );
		const primitive = new CesiumGroundImagePrimitive( makeImageOptions( variant, 'image' ) );
		pending.push( { row: 'image', variant, ...meta, primitive, group: primitive.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
	}

	const makePointRow = ( row: 'point-circle' | 'point-square' | 'point-image' ): void => {
		for ( const variant of variants ) {
			const meta = variantMeta( variant );
			let appearance: CesiumGroundAppearance | undefined;
			if ( variant === 'raw' ) appearance = rawAppearance( `${ row }:${ variant }`, rawPasses );
			if ( variant === 'safe' ) {
				const material = row === 'point-circle'
					? createPulsePointMaterial( { maxScale: 1 } )
					: row === 'point-square'
						? createScalePulseMaterial( { maxScale: 1 } )
						: createTexturedDecalMaterial( { texture: effectTexture } );
				appearance = new CesiumGroundMaterialAppearance( { material } );
			}
			const common = {
				position: nextPosition(), strokeColor: '#ffffff', strokeWidth: 0, strokeOpacity: 0,
				fillColor: '#ffffff', fillOpacity: meta.opacityPercent, visible: true,
				classificationType: meta.classificationType, appearance,
			};
			const primitive = row === 'point-image'
				? new CesiumGroundPointPrimitive( { ...common, shape: 'image', imageUrl: IMAGE_URL, imageWidth: 20, imageHeight: 20 } )
				: new CesiumGroundPointPrimitive( { ...common, shape: row === 'point-circle' ? 'circle' : 'square', size: 20 } );
			pending.push( { row, variant, ...meta, primitive, group: primitive.classification.group, material: () => colorCommand( primitive.classification.group ), appearance: () => primitive.appearance } );
		}
	};
	makePointRow( 'point-circle' );
	makePointRow( 'point-square' );
	makePointRow( 'point-image' );

	for ( const entry of pending ) {
		scene.add( entry.group );
		entry.primitive.update( frameState );
	}
	renderer.compile( scene, camera );

	const entries = pending.map( entry => {
		const material = entry.material();
		return {
			row: entry.row,
			variant: entry.variant,
			classificationType: ClassificationType[ entry.classificationType ] as AppearanceClassificationMatrixEntry['classificationType'],
			alpha: entry.alpha,
			appearanceKind: entry.appearance().kind,
			depthTextureMatched: material.uniforms.czm_globeDepthTexture.value === expectedDepth.get( entry.classificationType ),
			materialPass: material.name,
		};
	} );
	const report = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		errors,
		entries,
		rawPasses,
		programCount: renderer.info.programs?.length ?? 0,
	};
	for ( const entry of pending ) entry.primitive.dispose();
	for ( const texture of [ fallbackDepth, terrainDepth, tilesetDepth, bothDepth, effectTexture ] ) texture.dispose();
	renderer.dispose();
	return report;
}

runMatrix().then( report => {
	window.__C23_APPEARANCE_CLASSIFICATION_MATRIX__ = report;
} ).catch( error => {
	console.error( '[appearance-classification-matrix] failed', error );
	throw error;
} );
