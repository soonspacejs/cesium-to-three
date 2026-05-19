// ============================================================
// cesium-three-ground.ts
// Layer: Three.js adapter for Cesium's GroundPrimitive pipeline.
// Role: run Cesium shadow-volume ground classification in a Three/WebGL2 scene
//       while keeping Cesium source shaders and geometry generators as the
//       canonical implementation.
// Dependencies: Three.js plus unmodified Cesium source files under
//       ../cesium-ground-source.
// Consumed by: main.ts.
// ============================================================

import {
	AddEquation,
	AlwaysStencilFunc,
	BackSide,
	BufferAttribute,
	BufferGeometry,
	Color,
	CustomBlending,
	DecrementWrapStencilOp,
	DoubleSide,
	FrontSide,
	Group,
	IncrementWrapStencilOp,
	KeepStencilOp,
	Matrix3,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	NearestFilter,
	NotEqualStencilFunc,
	OneFactor,
	OneMinusSrcAlphaFactor,
	Object3D,
	RGBAFormat,
	RawShaderMaterial,
	Scene,
	SphereGeometry,
	UnsignedByteType,
	Vector3,
	Vector4,
	WebGLRenderTarget,
	WebGLRenderer,
	ZeroStencilOp,
	GLSL3,
	type Camera,
	type Material,
	type PerspectiveCamera,
	type Side,
	type StencilOp,
} from 'three';

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Rectangle from '../cesium-ground-source/engine/Source/Core/Rectangle.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import RectangleGeometry from '../cesium-ground-source/engine/Source/Core/RectangleGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import VertexFormat from '../cesium-ground-source/engine/Source/Core/VertexFormat.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import GeometryPipeline from '../cesium-ground-source/engine/Source/Core/GeometryPipeline.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartographic from '../cesium-ground-source/engine/Source/Core/Cartographic.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartesian3 from '../cesium-ground-source/engine/Source/Core/Cartesian3.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Matrix4Cesium from '../cesium-ground-source/engine/Source/Core/Matrix4.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Transforms from '../cesium-ground-source/engine/Source/Core/Transforms.js';

import cesiumShadowVolumeAppearanceVS from '../cesium-ground-source/engine/Source/Shaders/ShadowVolumeAppearanceVS.glsl?raw';
import cesiumShadowVolumeAppearanceFS from '../cesium-ground-source/engine/Source/Shaders/ShadowVolumeAppearanceFS.glsl?raw';
import cesiumShadowVolumeFS from '../cesium-ground-source/engine/Source/Shaders/ShadowVolumeFS.glsl?raw';
import cesiumDepthClamp from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/depthClamp.glsl?raw';
import cesiumWriteDepthClamp from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/writeDepthClamp.glsl?raw';
import cesiumTranslateRelativeToEye from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/translateRelativeToEye.glsl?raw';
import cesiumWindowToEyeCoordinates from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/windowToEyeCoordinates.glsl?raw';
import cesiumUnpackDepth from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/unpackDepth.glsl?raw';
import cesiumPackDepth from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/packDepth.glsl?raw';
import cesiumPlaneDistance from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/planeDistance.glsl?raw';
import cesiumGammaCorrect from '../cesium-ground-source/engine/Source/Shaders/Builtin/Functions/gammaCorrect.glsl?raw';

const WGS84_X_RADIUS = 6378137.0;
const WGS84_Y_RADIUS = 6378137.0;
const WGS84_Z_RADIUS = 6356752.3142451793;
const CLASSIFICATION_MASK = 0x0f;
const SCENE_MODE_3D = 3.0;
const CESIUM_GLOBE_MINIMUM_ALTITUDE = 55000.0;
// Keep geometry expansion equal to the requested meter border width.
const BORDER_GEOMETRY_EXPANSION_SCALE = 1.0;

interface EncodedScalar {
	high: number;
	low: number;
}

interface CesiumGeometryAttribute {
	values: ArrayLike<number>;
	componentsPerAttribute: number;
}

interface CesiumGeometryResult {
	attributes: Record<string, CesiumGeometryAttribute>;
	indices?: Uint8Array | Uint16Array | Uint32Array | number[];
}

export interface RectangleDegrees {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface RectangleMeterSize {
	widthMeters: number;
	heightMeters: number;
}

interface RectangleRadians {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface CesiumGroundRectangleOptions {
	rectangleDegrees: RectangleDegrees;
	color?: Color | string | number;
	alpha?: number;
	granularityRadians?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	renderOrder?: number;
	debugSurface?: boolean;
	debugSurfaceHeight?: number;
	debugSurfaceOpacity?: number;
	border?: boolean;
	borderColor?: Color | string | number;
	borderOpacity?: number;
	borderWidthMeters?: number;
	fragmentCull?: boolean;
}

export interface CesiumClassificationCommandVisibility {
	frontStencil?: boolean;
	backStencil?: boolean;
	color?: boolean;
}

export interface CesiumGroundFrameState {
	depthTexture: WebGLRenderTarget['texture'];
	width: number;
	height: number;
	camera: PerspectiveCamera;
}

interface PlanarExtents {
	southWestHigh: Vector3;
	southWestLow: Vector3;
	eastward: Vector3;
	northward: Vector3;
	uvMinAndExtents: Vector4;
	uMaxVmax: Vector4;
	innerMetersRect: Vector4;
}

interface PlanarBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

interface SharedUniforms {
	[ uniform: string ]: { value: unknown };
	czm_encodedCameraPositionMCHigh: { value: Vector3 };
	czm_encodedCameraPositionMCLow: { value: Vector3 };
	czm_modelViewRelativeToEye: { value: Matrix4 };
	czm_modelViewProjectionRelativeToEye: { value: Matrix4 };
	czm_normal: { value: Matrix3 };
	czm_geometricToleranceOverMeter: { value: number };
	czm_sceneMode: { value: number };
	u_globeMinimumAltitude: { value: number };
	u_southWest_HIGH: { value: Vector3 };
	u_southWest_LOW: { value: Vector3 };
	u_eastward: { value: Vector3 };
	u_northward: { value: Vector3 };
	u_uvMinAndExtents: { value: Vector4 };
	u_uMaxVmax: { value: Vector4 };
	u_color: { value: Vector4 };
	u_borderColor: { value: Vector4 };
	u_borderEnabled: { value: number };
	u_borderWidthMeters: { value: number };
	u_innerMetersRect: { value: Vector4 };
	czm_globeDepthTexture: { value: WebGLRenderTarget['texture'] | null };
	czm_viewport: { value: Vector4 };
	czm_inverseProjection: { value: Matrix4 };
	czm_viewportTransformation: { value: Matrix4 };
	czm_frustumPlanes: { value: Vector4 };
	czm_currentFrustum: { value: Vector3 };
	czm_log2FarDepthFromNearPlusOne: { value: number };
}

/**
 * Encodes one float using Cesium's EncodedCartesian3.encode algorithm.
 *
 * @param value 64-bit JavaScript number in model coordinates.
 * @returns The high and low parts consumed by czm_translateRelativeToEye.
 */
function encodeCesiumFloat( value: number ): EncodedScalar {
	let doubleHigh: number;

	if ( value >= 0.0 ) {
		doubleHigh = Math.floor( value / 65536.0 ) * 65536.0;
		return { high: doubleHigh, low: value - doubleHigh };
	}

	doubleHigh = Math.floor( - value / 65536.0 ) * 65536.0;
	return { high: - doubleHigh, low: value + doubleHigh };
}

/**
 * Encodes a Three vector with the same fixed-point split used by Cesium.
 *
 * @param source ECEF/model-coordinate vector.
 * @param high Output high vector.
 * @param low Output low vector.
 */
function encodeCesiumVector3( source: Vector3, high: Vector3, low: Vector3 ): void {
	const x = encodeCesiumFloat( source.x );
	const y = encodeCesiumFloat( source.y );
	const z = encodeCesiumFloat( source.z );

	high.set( x.high, y.high, z.high );
	low.set( x.low, y.low, z.low );
}

/**
 * Copies a Cesium Cartesian3-like object into a Three Vector3.
 *
 * @param cartesian Object with x/y/z fields.
 * @returns A new Three Vector3.
 */
function cesiumCartesianToVector3( cartesian: { x: number; y: number; z: number } ): Vector3 {
	return new Vector3( cartesian.x, cartesian.y, cartesian.z );
}

/**
 * Converts Cesium Geometry attributes to a Three BufferGeometry.
 *
 * @param cesiumGeometry Geometry returned by Cesium createGeometry.
 * @returns Three BufferGeometry with matching attribute names.
 */
function cesiumGeometryToThree( cesiumGeometry: CesiumGeometryResult ): BufferGeometry {
	if (
		! cesiumGeometry ||
		! cesiumGeometry.attributes ||
		Object.keys( cesiumGeometry.attributes ).length === 0
	) {
		throw new Error( 'Cesium geometry conversion failed: geometry has no vertex attributes.' );
	}

	const geometry = new BufferGeometry();

	for ( const [ name, attribute ] of Object.entries( cesiumGeometry.attributes ) ) {
		const sourceValues = attribute.values;
		const values = sourceValues instanceof Float32Array
			? sourceValues
			: new Float32Array( Array.from( sourceValues ) );

		geometry.setAttribute(
			name,
			new BufferAttribute( values, attribute.componentsPerAttribute ),
		);
	}

	const firstAttribute = Object.values( cesiumGeometry.attributes )[ 0 ];
	const vertexCount = firstAttribute.values.length / firstAttribute.componentsPerAttribute;
	const batchIds = new Float32Array( vertexCount );
	geometry.setAttribute( 'batchId', new BufferAttribute( batchIds, 1 ) );

	if ( cesiumGeometry.indices ) {
		const indices = cesiumGeometry.indices;
		const indexArray = indices instanceof Uint16Array || indices instanceof Uint32Array
			? indices
			: new Uint32Array( Array.from( indices ) );
		geometry.setIndex( new BufferAttribute( indexArray, 1 ) );
	}

	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Builds a visible debug surface from the same geographic rectangle.
 *
 * The classification pipeline uses Cesium shadow-volume geometry with encoded
 * high/low positions, which is correct for Cesium shaders but not renderable by
 * Three's MeshBasicMaterial. This helper creates a plain position-only grid in
 * the same WGS84 ECEF frame so a red rectangle is guaranteed to be visible when
 * the primitive's geographic placement is correct.
 *
 * @param rectangle Cesium rectangle in radians.
 * @param height Height above WGS84 in meters.
 * @param longitudeSegments Number of longitudinal subdivisions.
 * @param latitudeSegments Number of latitudinal subdivisions.
 * @returns Three geometry with position attributes and triangle indices.
 */
function createDebugRectangleSurfaceGeometry(
	rectangle: RectangleRadians,
	height: number,
	longitudeSegments = 96,
	latitudeSegments = 64,
): BufferGeometry {
	const columns = Math.max( 1, Math.floor( longitudeSegments ) );
	const rows = Math.max( 1, Math.floor( latitudeSegments ) );
	const vertexColumns = columns + 1;
	const vertexRows = rows + 1;
	const positions = new Float32Array( vertexColumns * vertexRows * 3 );
	const indices = new Uint32Array( columns * rows * 6 );
	const cartographic = new Cartographic();
	const cartesian = new Cartesian3();

	let positionOffset = 0;
	for ( let row = 0; row < vertexRows; row ++ ) {
		const v = row / rows;
		const latitude = rectangle.south + ( rectangle.north - rectangle.south ) * v;

		for ( let column = 0; column < vertexColumns; column ++ ) {
			const u = column / columns;
			const longitude = rectangle.west + ( rectangle.east - rectangle.west ) * u;
			cartographic.longitude = longitude;
			cartographic.latitude = latitude;
			cartographic.height = height;
			Ellipsoid.WGS84.cartographicToCartesian( cartographic, cartesian );

			positions[ positionOffset ++ ] = cartesian.x;
			positions[ positionOffset ++ ] = cartesian.y;
			positions[ positionOffset ++ ] = cartesian.z;
		}
	}

	let indexOffset = 0;
	for ( let row = 0; row < rows; row ++ ) {
		for ( let column = 0; column < columns; column ++ ) {
			const southWest = row * vertexColumns + column;
			const southEast = southWest + 1;
			const northWest = southWest + vertexColumns;
			const northEast = northWest + 1;

			indices[ indexOffset ++ ] = southWest;
			indices[ indexOffset ++ ] = southEast;
			indices[ indexOffset ++ ] = northEast;
			indices[ indexOffset ++ ] = southWest;
			indices[ indexOffset ++ ] = northEast;
			indices[ indexOffset ++ ] = northWest;
		}
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	geometry.setIndex( new BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Creates the viewport transform Cesium uses for window-to-eye reconstruction.
 *
 * @param width Drawing buffer width in physical pixels.
 * @param height Drawing buffer height in physical pixels.
 * @returns Matrix equivalent to Cesium's viewportTransformation.
 */
function createViewportTransformation( width: number, height: number ): Matrix4 {
	const matrix = new Matrix4();

	matrix.set(
		width * 0.5, 0.0, 0.0, width * 0.5,
		0.0, height * 0.5, 0.0, height * 0.5,
		0.0, 0.0, 0.5, 0.5,
		0.0, 0.0, 0.0, 1.0,
	);

	return matrix;
}

/**
 * Builds a matrix with camera rotation only, matching Cesium RTE uniforms.
 *
 * @param camera Current Three perspective camera.
 * @param modelViewRelativeToEye Output model-view matrix without translation.
 * @param modelViewProjectionRelativeToEye Output projection * rotation matrix.
 * @param normal Output normal matrix.
 */
function updateRelativeToEyeMatrices(
	camera: PerspectiveCamera,
	modelViewRelativeToEye: Matrix4,
	modelViewProjectionRelativeToEye: Matrix4,
	normal: Matrix3,
): void {
	modelViewRelativeToEye.copy( camera.matrixWorldInverse );
	modelViewRelativeToEye.elements[ 12 ] = 0.0;
	modelViewRelativeToEye.elements[ 13 ] = 0.0;
	modelViewRelativeToEye.elements[ 14 ] = 0.0;
	modelViewProjectionRelativeToEye.multiplyMatrices( camera.projectionMatrix, modelViewRelativeToEye );
	normal.setFromMatrix4( modelViewRelativeToEye );
}

/**
 * Creates a shader prefix with Cesium automatic uniforms and batch-table hooks.
 *
 * @param defines GLSL defines to prepend exactly as Cesium ShaderSource would.
 * @returns GLSL source prefix.
 */
function createVertexPrefix( defines: readonly string[] ): string {
	const defineSource = defines.map( define => `#define ${ define }` ).join( '\n' );

	return /* glsl */ `
${ defineSource }
precision highp float;
precision highp int;

uniform mat4 czm_modelViewRelativeToEye;
uniform mat4 czm_modelViewProjectionRelativeToEye;
uniform mat3 czm_normal;
uniform vec3 czm_encodedCameraPositionMCHigh;
uniform vec3 czm_encodedCameraPositionMCLow;
uniform float czm_geometricToleranceOverMeter;
uniform float czm_sceneMode;

#define czm_sceneMode3D ${ SCENE_MODE_3D.toFixed( 1 ) }
#define czm_computePosition() czm_translateRelativeToEye(position3DHigh, position3DLow)

uniform vec3 u_southWest_HIGH;
uniform vec3 u_southWest_LOW;
uniform vec3 u_eastward;
uniform vec3 u_northward;
uniform vec4 u_uvMinAndExtents;
uniform vec4 u_uMaxVmax;
uniform vec4 u_color;

${ cesiumDepthClamp }

vec3 czm_batchTable_southWest_HIGH(float batchId) { return u_southWest_HIGH; }
vec3 czm_batchTable_southWest_LOW(float batchId) { return u_southWest_LOW; }
vec3 czm_batchTable_eastward(float batchId) { return u_eastward; }
vec3 czm_batchTable_northward(float batchId) { return u_northward; }
vec4 czm_batchTable_uvMinAndExtents(float batchId) { return u_uvMinAndExtents; }
vec4 czm_batchTable_uMaxVmax(float batchId) { return u_uMaxVmax; }
vec4 czm_batchTable_color(float batchId) { return u_color; }
float czm_batchTable_longitudeRotation(float batchId) { return 0.0; }
vec4 czm_batchTable_sphericalExtents(float batchId) { return vec4(0.0, 0.0, 1.0, 1.0); }
vec4 czm_batchTable_planes2D_HIGH(float batchId) { return vec4(0.0); }
vec4 czm_batchTable_planes2D_LOW(float batchId) { return vec4(0.0); }

float czm_branchFreeTernary(bool comparison, float trueValue, float falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_branchFreeTernary(bool comparison, vec2 trueValue, vec2 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec3 czm_branchFreeTernary(bool comparison, vec3 trueValue, vec3 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec4 czm_branchFreeTernary(bool comparison, vec4 trueValue, vec4 falseValue) {
	return comparison ? trueValue : falseValue;
}

${ cesiumTranslateRelativeToEye }
`;
}

/**
 * Creates the fragment prefix for Cesium shadow-volume color or stencil shaders.
 *
 * @param defines GLSL defines to prepend exactly as Cesium ShaderSource would.
 * @returns GLSL source prefix.
 */
function createFragmentPrefix( defines: readonly string[] ): string {
	const defineSource = defines.map( define => `#define ${ define }` ).join( '\n' );

	return /* glsl */ `
${ defineSource }
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 out_FragColor;

uniform sampler2D czm_globeDepthTexture;
uniform vec4 czm_viewport;
uniform mat4 czm_inverseProjection;
uniform mat4 czm_viewportTransformation;
uniform vec4 czm_frustumPlanes;
uniform vec3 czm_currentFrustum;
uniform float czm_log2FarDepthFromNearPlusOne;
uniform vec4 u_borderColor;
uniform float u_borderEnabled;
uniform float u_borderWidthMeters;
uniform vec4 u_innerMetersRect;

const float czm_pi = 3.141592653589793;
const float czm_twoPi = 6.283185307179586;

${ cesiumWriteDepthClamp }

float czm_branchFreeTernary(bool comparison, float trueValue, float falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_branchFreeTernary(bool comparison, vec2 trueValue, vec2 falseValue) {
	return comparison ? trueValue : falseValue;
}

vec2 czm_approximateSphericalCoordinates(vec3 normal) {
	float latitudeApproximation = atan(length(normal.xy), normal.z);
	float longitudeApproximation = atan(normal.x, normal.y);
	return vec2(latitudeApproximation, longitudeApproximation);
}

float czm_lineDistance(vec2 point1, vec2 point2, vec2 point) {
	return abs((point2.y - point1.y) * point.x - (point2.x - point1.x) * point.y + point2.x * point1.y - point2.y * point1.x) / distance(point2, point1);
}

${ cesiumUnpackDepth }
${ cesiumWindowToEyeCoordinates }
${ cesiumPlaneDistance }
${ cesiumGammaCorrect }
`;
}

/**
 * Creates a shader that packs gl_FragCoord.z with Cesium czm_packDepth.
 *
 * @returns RawShaderMaterial used by the globe depth pass.
 */
function createPackDepthMaterial(): RawShaderMaterial {
	return new RawShaderMaterial( {
		glslVersion: GLSL3,
		vertexShader: /* glsl */ `
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;

void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
		fragmentShader: /* glsl */ `
precision highp float;
precision highp int;

out vec4 out_FragColor;

${ cesiumPackDepth }

void main() {
	out_FragColor = czm_packDepth(gl_FragCoord.z);
}
`,
		depthTest: true,
		depthWrite: true,
		colorWrite: true,
		toneMapped: false,
	} );
}

/**
 * Injects adapter-side border styling into Cesium's per-instance color branch.
 *
 * Geometry generation, stencil updates, and globe-depth classification still
 * use Cesium's shadow volume. The border is a material style computed from the
 * local meter coordinates reconstructed from Cesium's planar uv.
 *
 * @returns ShadowVolumeAppearanceFS with one Three-side border style hook.
 */
function createColorFragmentBody(): string {
	const colorDeclaration = '    vec4 color = czm_gammaCorrect(v_color);';
	const borderInjection = /* glsl */ `    vec4 color = czm_gammaCorrect(v_color);
#ifdef CESIUM_THREE_BORDER
#ifdef TEXTURE_COORDINATES
#ifndef SPHERICAL
    vec2 planarMeters = uv / v_inversePlaneExtents;
    vec2 outsideLower = u_innerMetersRect.xy - planarMeters;
    vec2 outsideUpper = planarMeters - u_innerMetersRect.zw;
    vec2 outsideMeters = max(outsideLower, outsideUpper);
    float outsideDistanceMeters = max(outsideMeters.x, outsideMeters.y);
    if (outsideDistanceMeters > 0.0) {
        if (u_borderEnabled < 0.5 || u_borderColor.a <= 0.0 || outsideDistanceMeters > u_borderWidthMeters) {
            discard;
        }
        color = czm_gammaCorrect(u_borderColor);
    }
#endif
#endif
#endif`;
	const shader = cesiumShadowVolumeAppearanceFS.replace( colorDeclaration, borderInjection );

	if ( shader === cesiumShadowVolumeAppearanceFS ) {
		throw new Error( 'Cesium shader patch failed: per-instance color hook was not found.' );
	}

	return shader;
}

/**
 * Creates one face-specific material for Cesium's stencil-depth command.
 *
 * @param uniforms Shared uniforms for all classification commands.
 * @param side Three side selection matching the Cesium front/back command.
 * @param stencilZFail Stencil operation executed when depth test fails.
 * @param name Material debug name.
 * @returns RawShaderMaterial matching one half of Cesium's z-fail command.
 */
function createStencilMaterial(
	uniforms: SharedUniforms,
	side: Side,
	stencilZFail: StencilOp,
	name: string,
): RawShaderMaterial {
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( [ 'EXTRUDED_GEOMETRY' ] ) }\n${ cesiumShadowVolumeAppearanceVS }`,
		fragmentShader: `${ createFragmentPrefix( [] ) }\n${ cesiumShadowVolumeFS }`,
		side,
		colorWrite: false,
		depthWrite: false,
		depthTest: true,
		stencilWrite: true,
		stencilFunc: AlwaysStencilFunc,
		stencilRef: 0,
		stencilFuncMask: CLASSIFICATION_MASK,
		stencilWriteMask: CLASSIFICATION_MASK,
		stencilFail: KeepStencilOp,
		stencilZFail,
		stencilZPass: KeepStencilOp,
		toneMapped: false,
	} );

	material.name = name;
	return material;
}

/**
 * Creates the material for Cesium's final color classification command.
 *
 * @param uniforms Shared uniforms for all classification commands.
 * @returns RawShaderMaterial matching Cesium's color pass render state.
 */
function createColorMaterial( uniforms: SharedUniforms, fragmentCull: boolean ): RawShaderMaterial {
	const defines = [
		'EXTRUDED_GEOMETRY',
		'TEXTURE_COORDINATES',
		fragmentCull ? 'CULL_FRAGMENTS' : '',
		'PER_INSTANCE_COLOR',
		'FLAT',
		'REQUIRES_EC',
		'CESIUM_THREE_BORDER',
	].filter( define => define.length > 0 );

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( defines ) }\n${ cesiumShadowVolumeAppearanceVS }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ createColorFragmentBody() }`,
		side: DoubleSide,
		colorWrite: true,
		depthWrite: false,
		depthTest: false,
		stencilWrite: true,
		stencilFunc: NotEqualStencilFunc,
		stencilRef: 0,
		stencilFuncMask: CLASSIFICATION_MASK,
		stencilWriteMask: CLASSIFICATION_MASK,
		stencilFail: ZeroStencilOp,
		stencilZFail: ZeroStencilOp,
		stencilZPass: ZeroStencilOp,
		transparent: true,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumClassificationColorMaterial';
	return material;
}

/**
 * Checks the WebGL features Cesium classification needs.
 *
 * @param renderer Active Three WebGL renderer.
 */
export function validateCesiumGroundRenderer( renderer: WebGLRenderer ): void {
	const gl = renderer.getContext();

	if ( ! renderer.capabilities.isWebGL2 ) {
		throw new Error( 'Cesium ground classification requires WebGL2 in this Three adapter.' );
	}

	if ( gl.getParameter( gl.STENCIL_BITS ) < 8 ) {
		throw new Error( 'Cesium ground classification requires an 8-bit stencil buffer.' );
	}
}

/**
 * Clamps a scalar to a closed interval.
 *
 * @param value Input value.
 * @param min Minimum returned value.
 * @param max Maximum returned value.
 * @returns Clamped value.
 */
function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * Converts local ENU meter bounds back to a geographic rectangle.
 *
 * @param centerLongitudeDegrees Center longitude in degrees.
 * @param centerLatitudeDegrees Center latitude in degrees.
 * @param minX Minimum east offset in meters.
 * @param maxX Maximum east offset in meters.
 * @param minY Minimum north offset in meters.
 * @param maxY Maximum north offset in meters.
 * @returns Geographic rectangle containing the sampled ENU bounds.
 */
function rectangleDegreesFromEnuBounds(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): RectangleDegrees {
	const centerCartographic = new Cartographic(
		centerLongitudeDegrees * Math.PI / 180.0,
		centerLatitudeDegrees * Math.PI / 180.0,
		0.0,
	);
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const samples = [
		new Cartesian3( minX, minY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, minY, 0.0 ),
		new Cartesian3( maxX, minY, 0.0 ),
		new Cartesian3( maxX, ( minY + maxY ) * 0.5, 0.0 ),
		new Cartesian3( maxX, maxY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, maxY, 0.0 ),
		new Cartesian3( minX, maxY, 0.0 ),
		new Cartesian3( minX, ( minY + maxY ) * 0.5, 0.0 ),
	];

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const cartographic = new Cartographic();

	for ( const sample of samples ) {
		Matrix4Cesium.multiplyByPoint( enuMatrix, sample, sample );
		Ellipsoid.WGS84.cartesianToCartographic( sample, cartographic );
		west = Math.min( west, cartographic.longitude );
		east = Math.max( east, cartographic.longitude );
		south = Math.min( south, cartographic.latitude );
		north = Math.max( north, cartographic.latitude );
	}

	return {
		west: clampNumber( west * 180.0 / Math.PI, - 180.0, 180.0 ),
		south: clampNumber( south * 180.0 / Math.PI, - 89.999999, 89.999999 ),
		east: clampNumber( east * 180.0 / Math.PI, - 180.0, 180.0 ),
		north: clampNumber( north * 180.0 / Math.PI, - 89.999999, 89.999999 ),
	};
}

/**
 * Creates a geographic rectangle from a center point and meter dimensions.
 *
 * The requested width and height are first represented in the local ENU meter
 * plane, then converted back to WGS84 degrees so Cesium remains the geometry
 * source of truth.
 *
 * @param centerLongitudeDegrees Center longitude in degrees.
 * @param centerLatitudeDegrees Center latitude in degrees.
 * @param widthMeters Rectangle width in local east-west meters.
 * @param heightMeters Rectangle height in local north-south meters.
 * @returns WGS84 degree rectangle.
 */
export function rectangleDegreesFromCenterSizeMeters(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	widthMeters: number,
	heightMeters: number,
): RectangleDegrees {
	const safeWidthMeters = Math.max( widthMeters, 1.0 );
	const safeHeightMeters = Math.max( heightMeters, 1.0 );
	const halfWidthMeters = safeWidthMeters * 0.5;
	const halfHeightMeters = safeHeightMeters * 0.5;

	return rectangleDegreesFromEnuBounds(
		centerLongitudeDegrees,
		centerLatitudeDegrees,
		- halfWidthMeters,
		halfWidthMeters,
		- halfHeightMeters,
		halfHeightMeters,
	);
}

/**
 * Measures one geographic rectangle in the local ENU meter plane.
 *
 * @param rectangleDegrees Rectangle in WGS84 degrees.
 * @returns Width and height in meters.
 */
export function rectangleMeterSizeFromDegrees( rectangleDegrees: RectangleDegrees ): RectangleMeterSize {
	const rectangle = Rectangle.fromDegrees(
		rectangleDegrees.west,
		rectangleDegrees.south,
		rectangleDegrees.east,
		rectangleDegrees.north,
	);
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = 0.0;
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const bounds = computeRectanglePlanarBounds( rectangle, Ellipsoid.WGS84, 0.0, inverseEnu );

	return {
		widthMeters: Math.max( bounds.maxX - bounds.minX, 1.0 ),
		heightMeters: Math.max( bounds.maxY - bounds.minY, 1.0 ),
	};
}

/**
 * Expands a geographic rectangle by converting it to a local meter plane first.
 *
 * The rectangle is projected into an ENU frame centered on the original
 * rectangle, the border is added in meters on that plane, and the expanded
 * meter bounds are converted back to cartographic degrees for Cesium geometry.
 *
 * @param rectangle Source rectangle in degrees.
 * @param borderWidthMeters Outward border width in meters.
 * @returns Expanded rectangle in degrees.
 */
function expandRectangleDegreesThroughMeters( rectangle: RectangleDegrees, borderWidthMeters: number ): RectangleDegrees {
	const safeWidthMeters = Math.max( borderWidthMeters, 0.0 );
	if ( safeWidthMeters === 0.0 ) {
		return { ...rectangle };
	}

	const sourceRectangle = Rectangle.fromDegrees(
		rectangle.west,
		rectangle.south,
		rectangle.east,
		rectangle.north,
	);
	const centerCartographic = Rectangle.center( sourceRectangle, new Cartographic() );
	centerCartographic.height = 0.0;
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const innerBounds = computeRectanglePlanarBounds( sourceRectangle, Ellipsoid.WGS84, 0.0, inverseEnu );
	const expansionMeters = safeWidthMeters * BORDER_GEOMETRY_EXPANSION_SCALE;
	const minX = innerBounds.minX - expansionMeters;
	const maxX = innerBounds.maxX + expansionMeters;
	const minY = innerBounds.minY - expansionMeters;
	const maxY = innerBounds.maxY + expansionMeters;
	const samples = [
		new Cartesian3( minX, minY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, minY, 0.0 ),
		new Cartesian3( maxX, minY, 0.0 ),
		new Cartesian3( maxX, ( minY + maxY ) * 0.5, 0.0 ),
		new Cartesian3( maxX, maxY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, maxY, 0.0 ),
		new Cartesian3( minX, maxY, 0.0 ),
		new Cartesian3( minX, ( minY + maxY ) * 0.5, 0.0 ),
	];

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const cartographic = new Cartographic();

	for ( const sample of samples ) {
		Matrix4Cesium.multiplyByPoint( enuMatrix, sample, sample );
		Ellipsoid.WGS84.cartesianToCartographic( sample, cartographic );
		west = Math.min( west, cartographic.longitude );
		east = Math.max( east, cartographic.longitude );
		south = Math.min( south, cartographic.latitude );
		north = Math.max( north, cartographic.latitude );
	}

	return {
		west: clampNumber( west * 180.0 / Math.PI, - 180.0, 180.0 ),
		south: clampNumber( south * 180.0 / Math.PI, - 89.999999, 89.999999 ),
		east: clampNumber( east * 180.0 / Math.PI, - 180.0, 180.0 ),
		north: clampNumber( north * 180.0 / Math.PI, - 89.999999, 89.999999 ),
	};
}

/**
 * Projects a Cesium rectangle onto an ENU plane and returns its planar bounds.
 *
 * @param rectangle Rectangle in radians.
 * @param ellipsoid Cesium ellipsoid used by the geometry.
 * @param height Projection height in meters.
 * @param inverseEnu Matrix from ECEF to the shared ENU plane.
 * @returns Planar min/max coordinates in ENU meters.
 */
function computeRectanglePlanarBounds(
	rectangle: unknown,
	ellipsoid: unknown,
	height: number,
	inverseEnu: unknown,
): PlanarBounds {
	const west = ( rectangle as { west: number } ).west;
	const east = ( rectangle as { east: number } ).east;
	const north = ( rectangle as { north: number } ).north;
	const south = ( rectangle as { south: number } ).south;
	const longitudeCenter = ( west + east ) * 0.5;
	const latitudeCenter = ( north + south ) * 0.5;
	const cartographics = [
		new Cartographic( west, south, height ),
		new Cartographic( west, north, height ),
		new Cartographic( east, north, height ),
		new Cartographic( east, south, height ),
		new Cartographic( longitudeCenter, south, height ),
		new Cartographic( longitudeCenter, north, height ),
		new Cartographic( west, latitudeCenter, height ),
		new Cartographic( east, latitudeCenter, height ),
	];

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for ( const cartographic of cartographics ) {
		const pointCartesian = ( ellipsoid as typeof Ellipsoid.WGS84 ).cartographicToCartesian(
			cartographic,
			new Cartesian3(),
		);
		Matrix4Cesium.multiplyByPoint( inverseEnu, pointCartesian, pointCartesian );
		pointCartesian.z = 0.0;
		minX = Math.min( minX, pointCartesian.x );
		maxX = Math.max( maxX, pointCartesian.x );
		minY = Math.min( minY, pointCartesian.y );
		maxY = Math.max( maxY, pointCartesian.y );
	}

	return { minX, maxX, minY, maxY };
}

/**
 * Computes the planar texture-coordinate extent attributes used by Cesium.
 *
 * This is a direct TypeScript port of ShadowVolumeAppearance.computeRectangleBounds
 * plus the specific attributes needed by ShadowVolumeAppearanceVS for planar
 * ground-primitive culling.
 *
 * @param rectangle Cesium render rectangle in radians.
 * @param ellipsoid Cesium WGS84 ellipsoid.
 * @param height Maximum shadow-volume height.
 * @param innerRectangle Original fill rectangle in radians.
 * @returns Encoded planar extent uniforms.
 */
function computePlanarExtents(
	rectangle: unknown,
	ellipsoid: unknown,
	height: number,
	innerRectangle: unknown = rectangle,
): PlanarExtents {
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = height;

	const centerCartesian = ( ellipsoid as typeof Ellipsoid.WGS84 ).cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);

	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		ellipsoid,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );

	const outerBounds = computeRectanglePlanarBounds( rectangle, ellipsoid, height, inverseEnu );
	const innerBounds = computeRectanglePlanarBounds( innerRectangle, ellipsoid, height, inverseEnu );
	const eastExtentMeters = Math.max( outerBounds.maxX - outerBounds.minX, 1.0 );
	const northExtentMeters = Math.max( outerBounds.maxY - outerBounds.minY, 1.0 );

	const southWestCorner = new Cartesian3( outerBounds.minX, outerBounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southWestCorner, southWestCorner );

	const southEastCorner = new Cartesian3( outerBounds.maxX, outerBounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southEastCorner, southEastCorner );

	const northWestCorner = new Cartesian3( outerBounds.minX, outerBounds.maxY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, northWestCorner, northWestCorner );

	const southWest = cesiumCartesianToVector3( southWestCorner );
	const southEast = cesiumCartesianToVector3( southEastCorner );
	const northWest = cesiumCartesianToVector3( northWestCorner );
	const eastward = southEast.sub( southWest );
	const northward = northWest.sub( southWest );
	const high = new Vector3();
	const low = new Vector3();
	encodeCesiumVector3( southWest, high, low );

	const innerMinX = clampNumber( innerBounds.minX - outerBounds.minX, 0.0, eastExtentMeters );
	const innerMinY = clampNumber( innerBounds.minY - outerBounds.minY, 0.0, northExtentMeters );
	const innerMaxX = clampNumber( innerBounds.maxX - outerBounds.minX, 0.0, eastExtentMeters );
	const innerMaxY = clampNumber( innerBounds.maxY - outerBounds.minY, 0.0, northExtentMeters );

	return {
		southWestHigh: high,
		southWestLow: low,
		eastward,
		northward,
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		innerMetersRect: new Vector4( innerMinX, innerMinY, innerMaxX, innerMaxY ),
	};
}

/**
 * Renders a Cesium-style packed globe depth texture.
 */
export class CesiumGlobeDepth {
	public readonly scene: Scene;
	public readonly target: WebGLRenderTarget;

	private readonly packDepthMaterial: RawShaderMaterial;

	public constructor( width: number, height: number ) {
		this.scene = new Scene();
		this.packDepthMaterial = createPackDepthMaterial();
		this.target = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: UnsignedByteType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: true,
			stencilBuffer: false,
		} );
		this.target.texture.name = 'CesiumGlobeDepthPackedTexture';
	}

	/**
	 * Adds a mesh rendered only into the packed depth texture.
	 *
	 * @param mesh Mesh whose geometry contributes globe depth.
	 */
	public addDepthMesh( mesh: Mesh ): void {
		mesh.frustumCulled = false;
		this.scene.add( mesh );
	}

	/**
	 * Adds an arbitrary object tree to this pass' private depth scene.
	 *
	 * @param object Object tree whose meshes contribute globe depth.
	 */
	public addDepthObject( object: Object3D ): void {
		this.scene.add( object );
	}

	/**
	 * Renders packed depth into this target.
	 *
	 * @param renderer Active Three renderer.
	 * @param camera Current camera.
	 * @param sourceScene Optional external scene, used for 3d-tiles-renderer content.
	 * @param depthRoot Optional root object to isolate while rendering sourceScene.
	 */
	public render(
		renderer: WebGLRenderer,
		camera: Camera,
		sourceScene: Scene = this.scene,
		depthRoot?: Object3D,
	): void {
		const previousTarget = renderer.getRenderTarget();
		const previousClearColor = new Color();
		renderer.getClearColor( previousClearColor );
		const previousClearAlpha = renderer.getClearAlpha();
		const previousOverrideMaterial = sourceScene.overrideMaterial;
		const visibilityRestore: Array<{ object: Object3D; visible: boolean }> = [];

		if ( depthRoot ) {
			for ( const child of sourceScene.children ) {
				let current: Object3D | null = depthRoot;
				let childContainsDepthRoot = false;
				while ( current ) {
					if ( current === child ) {
						childContainsDepthRoot = true;
						break;
					}
					current = current.parent;
				}

				if ( ! childContainsDepthRoot ) {
					visibilityRestore.push( { object: child, visible: child.visible } );
					child.visible = false;
				}
			}
		}

		renderer.setRenderTarget( this.target );
		renderer.setClearColor( 0x000000, 0.0 );
		renderer.clear( true, true, false );
		sourceScene.overrideMaterial = this.packDepthMaterial;
		renderer.render( sourceScene, camera );
		sourceScene.overrideMaterial = previousOverrideMaterial;
		for ( const entry of visibilityRestore ) {
			entry.object.visible = entry.visible;
		}
		renderer.setRenderTarget( previousTarget );
		renderer.setClearColor( previousClearColor, previousClearAlpha );
	}

	/**
	 * Resizes the packed depth framebuffer.
	 *
	 * @param width Drawing buffer width.
	 * @param height Drawing buffer height.
	 */
	public resize( width: number, height: number ): void {
		this.target.setSize( width, height );
	}

	/**
	 * Releases GPU resources owned by this pass.
	 */
	public dispose(): void {
		this.packDepthMaterial.dispose();
		this.target.dispose();
	}
}

/**
 * Creates the ellipsoid depth meshes used by CesiumGlobeDepth and the main
 * framebuffer depth prepass.
 *
 * @param widthSegments Horizontal segment count.
 * @param heightSegments Vertical segment count.
 * @returns Main-scene depth mesh and packed-depth pass mesh.
 */
export function createCesiumEllipsoidDepthMeshes(
	widthSegments = 192,
	heightSegments = 96,
): { mainDepthMesh: Mesh; packedDepthMesh: Mesh } {
	const geometry = new SphereGeometry( 1.0, widthSegments, heightSegments );
	geometry.rotateX( Math.PI * 0.5 );
	geometry.scale( WGS84_X_RADIUS, WGS84_Y_RADIUS, WGS84_Z_RADIUS );
	geometry.computeBoundingSphere();

	const mainMaterial = new RawShaderMaterial( {
		glslVersion: GLSL3,
		vertexShader: /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
		fragmentShader: /* glsl */ `
precision highp float;
out vec4 out_FragColor;
void main() {
	out_FragColor = vec4(0.0);
}
`,
		colorWrite: false,
		depthWrite: true,
		depthTest: true,
		toneMapped: false,
	} );
	mainMaterial.name = 'CesiumEllipsoidMainDepthMaterial';

	const mainDepthMesh = new Mesh( geometry, mainMaterial );
	mainDepthMesh.name = 'CesiumEllipsoidMainDepthMesh';
	mainDepthMesh.renderOrder = -10000;
	mainDepthMesh.frustumCulled = false;

	const packedDepthMesh = new Mesh( geometry.clone(), createPackDepthMaterial() );
	packedDepthMesh.name = 'CesiumEllipsoidPackedDepthMesh';
	packedDepthMesh.frustumCulled = false;

	return { mainDepthMesh, packedDepthMesh };
}

/**
 * Converts lon/lat/height degrees to a Three vector using Cesium Ellipsoid.WGS84.
 *
 * @param longitudeDegrees Longitude in degrees.
 * @param latitudeDegrees Latitude in degrees.
 * @param height Height in meters.
 * @returns ECEF position in the shared Three/Cesium world frame.
 */
export function wgs84PositionFromDegrees(
	longitudeDegrees: number,
	latitudeDegrees: number,
	height = 0.0,
): Vector3 {
	const cartographic = new Cartographic(
		longitudeDegrees * Math.PI / 180.0,
		latitudeDegrees * Math.PI / 180.0,
		height,
	);
	const cartesian = Ellipsoid.WGS84.cartographicToCartesian( cartographic, new Cartesian3() );
	return cesiumCartesianToVector3( cartesian );
}

/**
 * Computes the geodetic up vector using Cesium Ellipsoid.WGS84.
 *
 * @param longitudeDegrees Longitude in degrees.
 * @param latitudeDegrees Latitude in degrees.
 * @returns Unit normal in ECEF coordinates.
 */
export function wgs84NormalFromDegrees( longitudeDegrees: number, latitudeDegrees: number ): Vector3 {
	const cartographic = new Cartographic(
		longitudeDegrees * Math.PI / 180.0,
		latitudeDegrees * Math.PI / 180.0,
		0.0,
	);
	const normal = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic( cartographic, new Cartesian3() );
	return cesiumCartesianToVector3( normal );
}

/**
 * Three execution of Cesium ClassificationPrimitive's two color commands.
 */
export class CesiumClassificationPrimitive {
	public readonly group: Group;

	private readonly stencilMesh: Mesh;
	private readonly backStencilMesh: Mesh;
	private readonly colorMesh: Mesh;
	private readonly uniforms: SharedUniforms;
	private readonly cameraHigh = new Vector3();
	private readonly cameraLow = new Vector3();
	private colorFragmentCull: boolean;

	public constructor(
		geometry: BufferGeometry,
		extents: PlanarExtents,
		color: Color,
		alpha: number,
		renderOrder: number,
		fragmentCull: boolean,
	) {
		this.group = new Group();
		this.group.name = 'CesiumClassificationPrimitive';
		this.colorFragmentCull = fragmentCull;

		this.uniforms = {
			czm_encodedCameraPositionMCHigh: { value: this.cameraHigh },
			czm_encodedCameraPositionMCLow: { value: this.cameraLow },
			czm_modelViewRelativeToEye: { value: new Matrix4() },
			czm_modelViewProjectionRelativeToEye: { value: new Matrix4() },
			czm_normal: { value: new Matrix3() },
			czm_geometricToleranceOverMeter: { value: 1.0 },
			czm_sceneMode: { value: SCENE_MODE_3D },
			u_globeMinimumAltitude: { value: CESIUM_GLOBE_MINIMUM_ALTITUDE },
			u_southWest_HIGH: { value: extents.southWestHigh },
			u_southWest_LOW: { value: extents.southWestLow },
			u_eastward: { value: extents.eastward },
			u_northward: { value: extents.northward },
			u_uvMinAndExtents: { value: extents.uvMinAndExtents },
			u_uMaxVmax: { value: extents.uMaxVmax },
			u_color: { value: new Vector4( color.r, color.g, color.b, alpha ) },
			u_borderColor: { value: new Vector4( 1.0, 1.0, 1.0, 1.0 ) },
			u_borderEnabled: { value: 0.0 },
			u_borderWidthMeters: { value: 0.0 },
			u_innerMetersRect: { value: extents.innerMetersRect },
			czm_globeDepthTexture: { value: null },
			czm_viewport: { value: new Vector4( 0.0, 0.0, 1.0, 1.0 ) },
			czm_inverseProjection: { value: new Matrix4() },
			czm_viewportTransformation: { value: createViewportTransformation( 1, 1 ) },
			czm_frustumPlanes: { value: new Vector4() },
			czm_currentFrustum: { value: new Vector3() },
			czm_log2FarDepthFromNearPlusOne: { value: 1.0 },
		};

		const frontStencilMaterial = createStencilMaterial(
			this.uniforms,
			FrontSide,
			DecrementWrapStencilOp,
			'CesiumClassificationFrontStencilDepthMaterial',
		);
		const backStencilMaterial = createStencilMaterial(
			this.uniforms,
			BackSide,
			IncrementWrapStencilOp,
			'CesiumClassificationBackStencilDepthMaterial',
		);
		const colorMaterial = createColorMaterial( this.uniforms, fragmentCull );

		this.stencilMesh = new Mesh( geometry, frontStencilMaterial );
		this.stencilMesh.name = 'CesiumClassificationFrontStencilDepthCommand';
		this.stencilMesh.renderOrder = renderOrder;
		this.stencilMesh.frustumCulled = false;

		this.backStencilMesh = new Mesh( geometry, backStencilMaterial );
		this.backStencilMesh.name = 'CesiumClassificationBackStencilDepthCommand';
		this.backStencilMesh.renderOrder = renderOrder + 1;
		this.backStencilMesh.frustumCulled = false;

		this.colorMesh = new Mesh( geometry, colorMaterial );
		this.colorMesh.name = 'CesiumClassificationColorCommand';
		this.colorMesh.renderOrder = renderOrder + 2;
		this.colorMesh.frustumCulled = false;

		this.group.add( this.stencilMesh, this.backStencilMesh, this.colorMesh );
	}

	/**
	 * Toggles individual draw commands without detaching them from the scene graph.
	 *
	 * @param visibility Optional per-command visibility flags.
	 */
	public setCommandVisibility( visibility: CesiumClassificationCommandVisibility ): void {
		if ( visibility.frontStencil !== undefined ) {
			this.stencilMesh.visible = visibility.frontStencil;
		}
		if ( visibility.backStencil !== undefined ) {
			this.backStencilMesh.visible = visibility.backStencil;
		}
		if ( visibility.color !== undefined ) {
			this.colorMesh.visible = visibility.color;
		}
	}

	/**
	 * Updates the per-instance color uniform consumed by Cesium's shader.
	 *
	 * @param color Linear Three color.
	 * @param alpha Premultiplied output alpha factor.
	 */
	public setColor( color: Color, alpha: number ): void {
		this.uniforms.u_color.value.set( color.r, color.g, color.b, alpha );
	}

	/**
	 * Updates the border style inside the existing Cesium color command.
	 *
	 * @param enabled Whether the shader should mix in the border color.
	 * @param color Border color in Three's linear color representation.
	 * @param opacity Straight alpha used before the classification blend pass.
	 * @param widthMeters Border width in local meter coordinates.
	 */
	public setBorderStyle( enabled: boolean, color: Color, opacity: number, widthMeters: number ): void {
		const safeOpacity = Math.min( Math.max( opacity, 0.0 ), 1.0 );
		const safeWidthMeters = Math.max( widthMeters, 0.0 );

		this.uniforms.u_borderEnabled.value = enabled && safeOpacity > 0.0 && safeWidthMeters > 0.0 ? 1.0 : 0.0;
		this.uniforms.u_borderColor.value.set( color.r, color.g, color.b, safeOpacity );
		this.uniforms.u_borderWidthMeters.value = safeWidthMeters;
	}

	/**
	 * Rebuilds the color material when fragment culling is toggled.
	 *
	 * @param enabled Whether Cesium's CULL_FRAGMENTS define is active.
	 */
	public setFragmentCulling( enabled: boolean ): void {
		if ( this.colorFragmentCull === enabled ) {
			return;
		}

		this.colorFragmentCull = enabled;
		const oldMaterial = this.colorMesh.material as Material;
		this.colorMesh.material = createColorMaterial( this.uniforms, enabled );
		oldMaterial.dispose();
	}

	/**
	 * Updates Cesium automatic uniforms for this frame.
	 *
	 * @param frameState Three-side equivalent of Cesium frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		encodeCesiumVector3( frameState.camera.position, this.cameraHigh, this.cameraLow );
		updateRelativeToEyeMatrices(
			frameState.camera,
			this.uniforms.czm_modelViewRelativeToEye.value,
			this.uniforms.czm_modelViewProjectionRelativeToEye.value,
			this.uniforms.czm_normal.value,
		);
		this.uniforms.czm_globeDepthTexture.value = frameState.depthTexture;
		this.uniforms.czm_viewport.value.set( 0.0, 0.0, frameState.width, frameState.height );
		this.uniforms.czm_inverseProjection.value.copy( frameState.camera.projectionMatrixInverse );
		this.uniforms.czm_viewportTransformation.value.copy(
			createViewportTransformation( frameState.width, frameState.height ),
		);

		const near = frameState.camera.near;
		const far = frameState.camera.far;
		const top = near * Math.tan( frameState.camera.fov * Math.PI / 360.0 );
		const right = top * frameState.camera.aspect;
		this.uniforms.czm_frustumPlanes.value.set( top, - top, - right, right );
		this.uniforms.czm_currentFrustum.value.set( near, far, 0.0 );
		this.uniforms.czm_log2FarDepthFromNearPlusOne.value = Math.log2( far - near + 1.0 );
	}

	/**
	 * Releases geometry and material GPU resources.
	 */
	public dispose(): void {
		this.stencilMesh.geometry.dispose();
		( this.stencilMesh.material as Material ).dispose();
		( this.backStencilMesh.material as Material ).dispose();
		( this.colorMesh.material as Material ).dispose();
	}
}

/**
 * Ground rectangle implemented with Cesium RectangleGeometry.createShadowVolume.
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: unknown;

	public constructor( options: CesiumGroundRectangleOptions ) {
		const fillRectangle = Rectangle.fromDegrees(
			options.rectangleDegrees.west,
			options.rectangleDegrees.south,
			options.rectangleDegrees.east,
			options.rectangleDegrees.north,
		);
		const borderWidthMeters = options.borderWidthMeters ?? 0.0;
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			options.rectangleDegrees,
			borderWidthMeters,
		);
		const renderRectangle = Rectangle.fromDegrees(
			renderRectangleDegrees.west,
			renderRectangleDegrees.south,
			renderRectangleDegrees.east,
			renderRectangleDegrees.north,
		);
		this.rectangle = fillRectangle;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const rectangleGeometry = new RectangleGeometry( {
			rectangle: renderRectangle,
			ellipsoid: Ellipsoid.WGS84,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
		} );
		const shadowVolumeGeometry = RectangleGeometry.createShadowVolume(
			rectangleGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = RectangleGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult;

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );

		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const extents = computePlanarExtents( renderRectangle, Ellipsoid.WGS84, maximumHeight, fillRectangle );
		const color = new Color( options.color ?? 0xff2f2f );
		const alpha = options.alpha ?? 0.65;
		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 10,
			options.fragmentCull ?? true,
		);
		this.classification.setBorderStyle(
			options.border ?? false,
			new Color( options.borderColor ?? 0xffffff ),
			options.borderOpacity ?? 0.95,
			borderWidthMeters,
		);

		this.debugSurface = null;
		if ( options.debugSurface === true ) {
			const debugThreeGeometry = createDebugRectangleSurfaceGeometry(
				fillRectangle as RectangleRadians,
				options.debugSurfaceHeight ?? 5000.0,
			);
			const debugMaterial = new MeshBasicMaterial( {
				color,
				transparent: true,
				opacity: options.debugSurfaceOpacity ?? alpha,
				depthTest: false,
				depthWrite: false,
				side: DoubleSide,
				toneMapped: false,
			} );
			debugMaterial.name = 'CesiumGroundRectangleDebugSurfaceMaterial';

			this.debugSurface = new Mesh( debugThreeGeometry, debugMaterial );
			this.debugSurface.name = 'CesiumGroundRectangleDebugSurface';
			this.debugSurface.frustumCulled = false;
			this.debugSurface.renderOrder = ( options.renderOrder ?? 10 ) + 2;
			this.classification.group.add( this.debugSurface );
		}
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Releases resources.
	 */
	public dispose(): void {
		this.classification.dispose();
		if ( this.debugSurface ) {
			this.debugSurface.geometry.dispose();
			( this.debugSurface.material as Material ).dispose();
		}
	}
}
