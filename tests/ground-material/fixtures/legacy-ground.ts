// ============================================================
// legacy-ground.ts
// Purpose: immutable pre-Material visual and resource baseline for every
//          synchronous public Ground rendering path. It uses only a generated
//          WGS84 ellipsoid depth source, so the fixture has no network, terrain,
//          tile-streaming, random, or wall-clock dependency.
// ============================================================

import {
	Color,
	type Group,
	PerspectiveCamera,
	Scene,
	SRGBColorSpace,
	Vector3,
	WebGLRenderer,
} from 'three';

import {
	CesiumGlobeDepth,
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
	CesiumGroundRectanglePrimitive,
	CesiumGroundTextPrimitive,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	createCesiumEllipsoidDepthMeshes,
	initializeApproximateTerrainHeights,
	longitudeLatitudeFromCenterOffsetsMeters,
	updateTerrainLogDepthUniforms,
	validateCesiumGroundRenderer,
	wgs84NormalFromDegrees,
	wgs84PositionFromDegrees,
	type CesiumGroundFrameState,
	type LonLatPoint,
} from '../../../src/lib/ground';

const WIDTH = 960;
const HEIGHT = 640;
const CENTER_LONGITUDE = 116.391;
const CENTER_LATITUDE = 39.907;

interface GroundFixturePrimitive {
	readonly group: Group;
	update( frameState: CesiumGroundFrameState ): void;
	dispose(): void;
}

interface ClassificationBackedPrimitive {
	readonly classification: { readonly group: Group };
	update( frameState: CesiumGroundFrameState ): void;
	dispose(): void;
}

/**
 * Surface and delegated point primitives expose their scene node through the
 * public `classification.group`, whereas text/polyline expose `group` directly.
 * Normalize that intentional legacy API difference inside the fixture only.
 */
function fromClassification(
	primitive: ClassificationBackedPrimitive,
): GroundFixturePrimitive {
	return {
		group: primitive.classification.group,
		update: frameState => primitive.update( frameState ),
		dispose: () => primitive.dispose(),
	};
}

function fromDirectGroup( primitive: GroundFixturePrimitive ): GroundFixturePrimitive {
	return primitive;
}

export interface LegacyGroundResourceSnapshot {
	programCount: number;
	geometryCount: number;
	textureCount: number;
}

export interface LegacyGroundFixtureApi {
	ready: boolean;
	isWebGL2: boolean;
	frameNumber: number;
	resourceSnapshot: LegacyGroundResourceSnapshot;
	renderFrames( count: number ): LegacyGroundResourceSnapshot;
	dispose(): LegacyGroundResourceSnapshot;
}

declare global {
	interface Window {
		/** Installed only after shaders have compiled and the warm frame completed. */
		__C23_LEGACY_GROUND__?: LegacyGroundFixtureApi;
	}
}

/** Converts deterministic local east/north offsets to the public WGS84 tuple. */
function point( eastMeters: number, northMeters: number ): LonLatPoint {
	const converted = longitudeLatitudeFromCenterOffsetsMeters(
		CENTER_LONGITUDE,
		CENTER_LATITUDE,
		[ { eastMeters, northMeters } ],
	)[ 0 ];
	return [ converted.longitude, converted.latitude ];
}

/** Builds an axis-aligned local rectangle in the four-corner public format. */
function rectanglePoints(
	centerEastMeters: number,
	centerNorthMeters: number,
	widthMeters: number,
	heightMeters: number,
): LonLatPoint[] {
	const halfWidth = widthMeters * 0.5;
	const halfHeight = heightMeters * 0.5;
	return [
		point( centerEastMeters - halfWidth, centerNorthMeters - halfHeight ),
		point( centerEastMeters + halfWidth, centerNorthMeters - halfHeight ),
		point( centerEastMeters + halfWidth, centerNorthMeters + halfHeight ),
		point( centerEastMeters - halfWidth, centerNorthMeters + halfHeight ),
	];
}

/**
 * Creates the complete legacy scene. Explicit colors and dimensions make every
 * branch independently recognizable in a screenshot instead of relying on the
 * library defaults that the implementation is about to migrate.
 */
function createLegacyPrimitives(): GroundFixturePrimitive[] {
	const rectangle = new CesiumGroundRectanglePrimitive( {
		points: rectanglePoints( - 230, 145, 165, 115 ),
		strokeColor: '#ffe08a',
		strokeWidth: 9,
		strokeOpacity: 100,
		fillColor: '#db3757',
		fillOpacity: 76,
		visible: true,
		renderOrder: 10,
		fragmentCull: true,
	} );

	const polygon = new CesiumGroundPolygonPrimitive( {
		points: [
			point( - 95, 90 ),
			point( 5, 70 ),
			point( 95, 140 ),
			point( 35, 225 ),
			point( - 75, 210 ),
		],
		holes: [ rectanglePoints( 0, 145, 42, 42 ) ],
		strokeColor: '#d9fff5',
		strokeWidth: 8,
		strokeOpacity: 100,
		fillColor: '#18a999',
		fillOpacity: 82,
		visible: true,
		renderOrder: 20,
		fragmentCull: true,
	} );

	const circle = new CesiumGroundCirclePrimitive( {
		center: point( 225, 145 ),
		radius: 78,
		strokeColor: '#f7f1ff',
		strokeWidth: 9,
		strokeOpacity: 100,
		fillColor: '#7657d5',
		fillOpacity: 82,
		visible: true,
		ringCount: 2,
		ringGapMeters: 10,
		sectorStartDegrees: 28,
		sectorAngleDegrees: 298,
		renderOrder: 30,
		fragmentCull: true,
	} );

	const solidPolyline = new CesiumGroundPolylinePrimitive( {
		points: [ point( - 315, - 70 ), point( - 135, - 155 ), point( 45, - 70 ) ],
		strokeColor: '#ffb627',
		strokeOpacity: 100,
		widthPixels: 8,
		widthMode: 'screen',
		visible: true,
		renderOrder: 40,
		arrowMode: 'both',
		startArrowStyle: 'open',
		endArrowStyle: 'solid',
		arrowWidthMode: 'screen',
		arrowLengthPixels: 24,
		arrowWidthPixels: 22,
		arrowStrokeWidthPixels: 4,
	} );

	const dashPolyline = new CesiumGroundPolylinePrimitive( {
		points: [ point( - 25, - 105 ), point( 120, - 175 ), point( 310, - 70 ) ],
		strokeColor: '#35c7ff',
		strokeOpacity: 92,
		widthPixels: 7,
		widthMode: 'screen',
		visible: true,
		renderOrder: 50,
		dashLengthMeters: 24,
		gapLengthMeters: 14,
	} );

	const circlePoint = new CesiumGroundPointPrimitive( {
		position: point( - 185, - 255 ),
		shape: 'circle',
		size: 54,
		strokeColor: '#ffffff',
		strokeWidth: 6,
		strokeOpacity: 100,
		fillColor: '#ff5c8a',
		fillOpacity: 100,
		visible: true,
		renderOrder: 60,
	} );

	const squarePoint = new CesiumGroundPointPrimitive( {
		position: point( - 90, - 255 ),
		shape: 'square',
		size: 54,
		strokeColor: '#ffffff',
		strokeWidth: 6,
		strokeOpacity: 100,
		fillColor: '#30d68f',
		fillOpacity: 100,
		visible: true,
		renderOrder: 70,
	} );

	const text = new CesiumGroundTextPrimitive( {
		points: [ point( 145, - 265 ) ],
		content: 'C23 BASELINE',
		fontColor: '#ffffff',
		fontSize: 30,
		fontFamily: 'sans-serif',
		fontWeight: 'bold',
		fontStrokeColor: '#132238',
		fontStrokeWidth: 2,
		fillColor: '#244568',
		fillOpacity: 96,
		strokeColor: '#75d6ff',
		strokeWidth: 3,
		strokeOpacity: 100,
		cornerRadius: 6,
		padding: [ 8, 14, 8, 14 ],
		textAlign: 'center',
		verticalAlign: 'middle',
		metersPerPixel: 0.48,
		anchorX: 'center',
		anchorY: 'middle',
		rotation: - 6,
		visible: true,
		renderOrder: 80,
	} );

	return [
		fromClassification( rectangle ),
		fromClassification( polygon ),
		fromClassification( circle ),
		fromDirectGroup( solidPolyline ),
		fromDirectGroup( dashPolyline ),
		fromClassification( circlePoint ),
		fromClassification( squarePoint ),
		fromDirectGroup( text ),
	];
}

function createFixture(): LegacyGroundFixtureApi {
	initializeApproximateTerrainHeights();

	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false,
		stencil: true,
		preserveDrawingBuffer: true,
		powerPreference: 'high-performance',
	} );
	renderer.setPixelRatio( 1 );
	renderer.setSize( WIDTH, HEIGHT, false );
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.setClearColor( new Color( '#081018' ), 1.0 );
	renderer.autoClear = true;
	renderer.autoClearStencil = true;
	validateCesiumGroundRenderer( renderer );
	document.body.appendChild( renderer.domElement );

	const scene = new Scene();
	scene.background = new Color( '#081018' );

	const camera = new PerspectiveCamera( 45, WIDTH / HEIGHT, 1, 40_000_000 );
	const anchor = wgs84PositionFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE );
	const up = wgs84NormalFromDegrees( CENTER_LONGITUDE, CENTER_LATITUDE );
	const east = new Vector3( - anchor.y, anchor.x, 0 ).normalize();
	// A shallow oblique view exercises RTE and depth reconstruction more strongly
	// than a perfectly vertical camera while keeping every fixture shape visible.
	camera.position.copy( anchor )
		.addScaledVector( up, 800 )
		.addScaledVector( east, 250 );
	// Match the production demo's ECEF camera convention. Using the local
	// ellipsoid normal as camera.up becomes nearly collinear in top-down views
	// and produces an unstable roll basis around this latitude.
	camera.up.set( 0, 0, 1 );
	camera.lookAt( anchor );
	camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld( true );

	const globeDepth = new CesiumGlobeDepth( WIDTH, HEIGHT );
	const { mainDepthMesh, packedDepthMesh } = createCesiumEllipsoidDepthMeshes( 128, 64 );
	scene.add( mainDepthMesh );
	globeDepth.addDepthMesh( packedDepthMesh );

	const primitives = createLegacyPrimitives();
	for ( const primitive of primitives ) scene.add( primitive.group );

	let frameNumber = 0;
	let disposed = false;

	const snapshotResources = (): LegacyGroundResourceSnapshot => ( {
		programCount: renderer.info.programs?.length ?? 0,
		geometryCount: renderer.info.memory.geometries,
		textureCount: renderer.info.memory.textures,
	} );

	const renderOneFrame = (): void => {
		if ( disposed ) throw new Error( 'Legacy Ground fixture is already disposed.' );
		camera.updateMatrixWorld( true );
		updateTerrainLogDepthUniforms( camera.near, camera.far );
		globeDepth.render( renderer, camera );

		const frameState: CesiumGroundFrameState = {
			depthTexture: globeDepth.target.texture,
			width: WIDTH,
			height: HEIGHT,
			camera,
			pixelRatio: 1,
		};
		for ( const primitive of primitives ) primitive.update( frameState );
		renderer.render( scene, camera );
		frameNumber += 1;
	};

	// Render twice: the first frame forces lazy program compilation; the second
	// is the warm baseline against which program/resource stability is measured.
	renderOneFrame();
	renderOneFrame();

	const api: LegacyGroundFixtureApi = {
		ready: true,
		isWebGL2: renderer.getContext() instanceof WebGL2RenderingContext,
		get frameNumber() {
			return frameNumber;
		},
		get resourceSnapshot() {
			return snapshotResources();
		},
		renderFrames( count: number ) {
			const safeCount = Math.max( 0, Math.floor( count ) );
			for ( let index = 0; index < safeCount; index += 1 ) renderOneFrame();
			return snapshotResources();
		},
		dispose() {
			if ( disposed ) return snapshotResources();
			disposed = true;
			for ( const primitive of primitives ) {
				scene.remove( primitive.group );
				primitive.dispose();
			}
			scene.remove( mainDepthMesh );
			mainDepthMesh.geometry.dispose();
			mainDepthMesh.material.dispose();
			packedDepthMesh.geometry.dispose();
			packedDepthMesh.material.dispose();
			globeDepth.dispose();
			renderer.dispose();
			return snapshotResources();
		},
	};

	return api;
}

window.__C23_LEGACY_GROUND__ = createFixture();
