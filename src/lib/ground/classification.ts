// ============================================================
// classification.ts
// Layer: Cesium-to-Three ground classification command group.
// Role: execute Cesium's front-stencil, back-stencil, and color commands as a
//       contiguous Three render-order block.
// Dependencies: Three.js meshes/uniforms, material bridge, and geometry RTE.
// Consumed by: primitives.ts.
// ============================================================

import {
	BackSide,
	BufferGeometry,
	Color,
	DecrementWrapStencilOp,
	FrontSide,
	Group,
	IncrementWrapStencilOp,
	Matrix3,
	Matrix4,
	Mesh,
	Vector2,
	Vector3,
	Vector4,
	type Material,
	type RawShaderMaterial,
} from 'three';

import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	CESIUM_MAXIMUM_SCREEN_SPACE_ERROR,
	MAX_POLYGON_STYLE_VERTICES,
	SCENE_MODE_3D,
} from './constants';
import { encodeCesiumVector3 } from './geometry';
import { createColorMaterial, createStencilMaterial } from './materials';
import type {
	CesiumClassificationCommandVisibility,
	CesiumGroundFrameState,
	PlanarExtents,
	SharedUniforms,
} from './types';

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

// Float64 scratch buffers keep the full RTE matrix chain at double precision
// on the CPU. Three.js Matrix4.elements is a Float32Array, so any roundtrip
// through `multiplyMatrices` / `copy` silently loses ~7 significant digits.
// We do the math against these Float64Array scratches and only write the
// final mat4 uniform back into the Float32 Three.js Matrix4 once.
const viewRotationFloat64 = new Float64Array( 16 );
const projectionFloat64 = new Float64Array( 16 );
const mvpFloat64 = new Float64Array( 16 );
const cpuPlaneScratch = {
	swEye: new Float64Array( 3 ),
	eastEye: new Float64Array( 3 ),
	northEye: new Float64Array( 3 ),
};

/**
 * Builds the column-major rotation-only view matrix from `camera.quaternion`
 * at Float64 precision. Equivalent to camera.matrixWorldInverse with the
 * translation column zeroed, but avoids the Float32 round-trip through
 * Three.js Matrix4.elements when the quaternion is converted to a matrix.
 *
 * @param qx Quaternion x component.
 * @param qy Quaternion y component.
 * @param qz Quaternion z component.
 * @param qw Quaternion w component.
 * @param out Float64Array(16) destination in column-major layout.
 */
function writeViewRotationFloat64(
	qx: number, qy: number, qz: number, qw: number,
	out: Float64Array,
): void {
	const x2 = qx + qx;
	const y2 = qy + qy;
	const z2 = qz + qz;
	const xx = qx * x2;
	const xy = qx * y2;
	const xz = qx * z2;
	const yy = qy * y2;
	const yz = qy * z2;
	const zz = qz * z2;
	const wx = qw * x2;
	const wy = qw * y2;
	const wz = qw * z2;

	// Camera-to-world rotation columns derived directly from the quaternion.
	const camToWorld00 = 1.0 - ( yy + zz );
	const camToWorld10 = xy + wz;
	const camToWorld20 = xz - wy;
	const camToWorld01 = xy - wz;
	const camToWorld11 = 1.0 - ( xx + zz );
	const camToWorld21 = yz + wx;
	const camToWorld02 = xz + wy;
	const camToWorld12 = yz - wx;
	const camToWorld22 = 1.0 - ( xx + yy );

	// View rotation = transpose of the camera-to-world rotation. With the
	// camera translation zeroed it's the relativeToEye view matrix.
	out[ 0 ] = camToWorld00; out[ 1 ] = camToWorld01; out[ 2 ] = camToWorld02; out[ 3 ] = 0.0;
	out[ 4 ] = camToWorld10; out[ 5 ] = camToWorld11; out[ 6 ] = camToWorld12; out[ 7 ] = 0.0;
	out[ 8 ] = camToWorld20; out[ 9 ] = camToWorld21; out[ 10 ] = camToWorld22; out[ 11 ] = 0.0;
	out[ 12 ] = 0.0; out[ 13 ] = 0.0; out[ 14 ] = 0.0; out[ 15 ] = 1.0;
}

/**
 * Mirrors Three.js PerspectiveCamera.updateProjectionMatrix using Float64
 * intermediates. The output matches the camera.projectionMatrix for
 * symmetric centred-frusta (no film offset, no view offset) but does not
 * carry the rounded values stored in Three.js Float32 elements.
 *
 * @param fovDegrees Vertical field of view in degrees.
 * @param aspect Aspect ratio (width / height).
 * @param near Near plane distance.
 * @param far Far plane distance.
 * @param out Float64Array(16) destination in column-major layout.
 */
function writePerspectiveProjectionFloat64(
	fovDegrees: number, aspect: number, near: number, far: number,
	out: Float64Array,
): void {
	const fovRad = fovDegrees * Math.PI / 180.0;
	const top = near * Math.tan( 0.5 * fovRad );
	const bottom = - top;
	const right = top * aspect;
	const left = - right;

	const x = ( 2.0 * near ) / ( right - left );
	const y = ( 2.0 * near ) / ( top - bottom );
	const a = ( right + left ) / ( right - left );
	const b = ( top + bottom ) / ( top - bottom );
	const c = - ( far + near ) / ( far - near );
	const d = - ( 2.0 * far * near ) / ( far - near );

	out[ 0 ] = x; out[ 1 ] = 0.0; out[ 2 ] = 0.0; out[ 3 ] = 0.0;
	out[ 4 ] = 0.0; out[ 5 ] = y; out[ 6 ] = 0.0; out[ 7 ] = 0.0;
	out[ 8 ] = a; out[ 9 ] = b; out[ 10 ] = c; out[ 11 ] = - 1.0;
	out[ 12 ] = 0.0; out[ 13 ] = 0.0; out[ 14 ] = d; out[ 15 ] = 0.0;
}

/**
 * Float64 matrix multiplication: out = a * b. Layout is column-major, matching
 * Three.js Matrix4.elements. Variable naming `aRowCol` reflects mathematical
 * convention, while index access goes through column-major offsets.
 *
 * @param a Left operand stored column-major in 16 Float64 entries.
 * @param b Right operand stored column-major in 16 Float64 entries.
 * @param out Destination stored column-major in 16 Float64 entries.
 */
function multiplyMatricesFloat64(
	a: Float64Array, b: Float64Array, out: Float64Array,
): void {
	const a11 = a[ 0 ];
	const a21 = a[ 1 ];
	const a31 = a[ 2 ];
	const a41 = a[ 3 ];
	const a12 = a[ 4 ];
	const a22 = a[ 5 ];
	const a32 = a[ 6 ];
	const a42 = a[ 7 ];
	const a13 = a[ 8 ];
	const a23 = a[ 9 ];
	const a33 = a[ 10 ];
	const a43 = a[ 11 ];
	const a14 = a[ 12 ];
	const a24 = a[ 13 ];
	const a34 = a[ 14 ];
	const a44 = a[ 15 ];

	const b11 = b[ 0 ];
	const b21 = b[ 1 ];
	const b31 = b[ 2 ];
	const b41 = b[ 3 ];
	const b12 = b[ 4 ];
	const b22 = b[ 5 ];
	const b32 = b[ 6 ];
	const b42 = b[ 7 ];
	const b13 = b[ 8 ];
	const b23 = b[ 9 ];
	const b33 = b[ 10 ];
	const b43 = b[ 11 ];
	const b14 = b[ 12 ];
	const b24 = b[ 13 ];
	const b34 = b[ 14 ];
	const b44 = b[ 15 ];

	out[ 0 ] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
	out[ 1 ] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
	out[ 2 ] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
	out[ 3 ] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;

	out[ 4 ] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
	out[ 5 ] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
	out[ 6 ] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
	out[ 7 ] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;

	out[ 8 ] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
	out[ 9 ] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
	out[ 10 ] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
	out[ 11 ] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;

	out[ 12 ] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
	out[ 13 ] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
	out[ 14 ] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
	out[ 15 ] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

/**
 * Writes the Cesium normal matrix (modelView rotation as a 3x3) from a 16
 * entry Float64 column-major matrix into Three.js Matrix3 elements.
 *
 * @param source Float64 column-major matrix.
 * @param destination Three Matrix3 receiver.
 */
function writeMatrix3FromFloat64Mat4( source: Float64Array, destination: Matrix3 ): void {
	const elements = destination.elements;
	elements[ 0 ] = source[ 0 ];
	elements[ 1 ] = source[ 1 ];
	elements[ 2 ] = source[ 2 ];
	elements[ 3 ] = source[ 4 ];
	elements[ 4 ] = source[ 5 ];
	elements[ 5 ] = source[ 6 ];
	elements[ 6 ] = source[ 8 ];
	elements[ 7 ] = source[ 9 ];
	elements[ 8 ] = source[ 10 ];
}

/**
 * Multiplies a world-space direction by the Float64 view rotation matrix.
 *
 * @param source Direction vector in ECEF/world coordinates.
 * @param out Float64Array(3) receiver in eye coordinates.
 */
function writeEyeDirectionFloat64( source: Vector3, out: Float64Array ): void {
	const x = source.x;
	const y = source.y;
	const z = source.z;

	out[ 0 ] = viewRotationFloat64[ 0 ] * x + viewRotationFloat64[ 4 ] * y + viewRotationFloat64[ 8 ] * z;
	out[ 1 ] = viewRotationFloat64[ 1 ] * x + viewRotationFloat64[ 5 ] * y + viewRotationFloat64[ 9 ] * z;
	out[ 2 ] = viewRotationFloat64[ 2 ] * x + viewRotationFloat64[ 6 ] * y + viewRotationFloat64[ 10 ] * z;
}

/**
 * Writes eye-space planar classification planes from CPU Float64 math.
 *
 * The Cesium shader normally derives these planes in the vertex shader from
 * RTE uniforms. That is fine for broad classification, but small 1:1 meter
 * circles expose float-axis drift in the procedural ring/circle styling. We
 * therefore compute the exact eye-space west/south planes on the CPU and let
 * the fragment shader consume them directly for local meter coordinates.
 *
 * @param frameState Current Three-side frame state.
 * @param uniforms Shared material uniforms updated in place.
 */
function updateCpuPlanarUniforms(
	frameState: CesiumGroundFrameState,
	uniforms: SharedUniforms,
): void {
	const swHigh = uniforms.u_southWest_HIGH.value;
	const swLow = uniforms.u_southWest_LOW.value;
	const eastward = uniforms.u_eastward.value;
	const northward = uniforms.u_northward.value;
	const cameraPosition = frameState.camera.position;
	const scratch = cpuPlaneScratch;

	const swRelativeX = swHigh.x + swLow.x - cameraPosition.x;
	const swRelativeY = swHigh.y + swLow.y - cameraPosition.y;
	const swRelativeZ = swHigh.z + swLow.z - cameraPosition.z;

	scratch.swEye[ 0 ] =
		viewRotationFloat64[ 0 ] * swRelativeX +
		viewRotationFloat64[ 4 ] * swRelativeY +
		viewRotationFloat64[ 8 ] * swRelativeZ;
	scratch.swEye[ 1 ] =
		viewRotationFloat64[ 1 ] * swRelativeX +
		viewRotationFloat64[ 5 ] * swRelativeY +
		viewRotationFloat64[ 9 ] * swRelativeZ;
	scratch.swEye[ 2 ] =
		viewRotationFloat64[ 2 ] * swRelativeX +
		viewRotationFloat64[ 6 ] * swRelativeY +
		viewRotationFloat64[ 10 ] * swRelativeZ;

	writeEyeDirectionFloat64( eastward, scratch.eastEye );
	writeEyeDirectionFloat64( northward, scratch.northEye );

	const eastLength = Math.max(
		Math.hypot( scratch.eastEye[ 0 ], scratch.eastEye[ 1 ], scratch.eastEye[ 2 ] ),
		1.0e-12,
	);
	const northLength = Math.max(
		Math.hypot( scratch.northEye[ 0 ], scratch.northEye[ 1 ], scratch.northEye[ 2 ] ),
		1.0e-12,
	);

	const eastX = scratch.eastEye[ 0 ] / eastLength;
	const eastY = scratch.eastEye[ 1 ] / eastLength;
	const eastZ = scratch.eastEye[ 2 ] / eastLength;
	const northX = scratch.northEye[ 0 ] / northLength;
	const northY = scratch.northEye[ 1 ] / northLength;
	const northZ = scratch.northEye[ 2 ] / northLength;

	uniforms.u_cpuWestPlane.value.set(
		eastX,
		eastY,
		eastZ,
		- (
			eastX * scratch.swEye[ 0 ] +
			eastY * scratch.swEye[ 1 ] +
			eastZ * scratch.swEye[ 2 ]
		),
	);
	uniforms.u_cpuSouthPlane.value.set(
		northX,
		northY,
		northZ,
		- (
			northX * scratch.swEye[ 0 ] +
			northY * scratch.swEye[ 1 ] +
			northZ * scratch.swEye[ 2 ]
		),
	);
}

/**
 * Updates Cesium automatic uniforms for this frame, including the LOG_DEPTH
 * uniforms required by the shadow-volume vertex and fragment shaders.
 *
 * Exported so the ground-polyline primitive (which lives outside the
 * stencil command group) can share the same per-frame uniform pipeline.
 * Polylines opt in to extra fields (`czm_projection`, `czm_pixelRatio`) by
 * declaring them in their uniform map; guarded writes below leave the
 * stencil/color/text materials untouched.
 *
 * @param frameState Current Three-side frame state.
 * @param uniforms Shared material uniforms updated in place.
 */
export function updateFrameStateUniforms( frameState: CesiumGroundFrameState, uniforms: SharedUniforms ): void {
	const camera = frameState.camera;
	const quaternion = camera.quaternion;

	// Float64 view rotation directly from the camera quaternion so the
	// model-view-relative-to-eye matrix is not bottle-necked by Three.js
	// Float32 storage. Translation stays at zero - the actual offset is
	// applied in the shader via czm_translateRelativeToEye(positionHigh,
	// positionLow) using the encoded camera position.
	writeViewRotationFloat64(
		quaternion.x, quaternion.y, quaternion.z, quaternion.w,
		viewRotationFloat64,
	);

	writePerspectiveProjectionFloat64(
		camera.fov, camera.aspect, camera.near, camera.far,
		projectionFloat64,
	);

	multiplyMatricesFloat64( projectionFloat64, viewRotationFloat64, mvpFloat64 );

	// Three.js Matrix4.elements is a plain `number[]`, not a Float32Array, so
	// the typed-array `set()` method is not available. `fromArray()` copies 16
	// entries by index and works identically with our Float64Array scratch.
	uniforms.czm_modelViewRelativeToEye.value.fromArray( viewRotationFloat64 );
	uniforms.czm_modelViewProjectionRelativeToEye.value.fromArray( mvpFloat64 );
	writeMatrix3FromFloat64Mat4( viewRotationFloat64, uniforms.czm_normal.value );
	updateCpuPlanarUniforms( frameState, uniforms );

	uniforms.czm_globeDepthTexture.value = frameState.depthTexture;
	uniforms.czm_viewport.value.set( 0.0, 0.0, frameState.width, frameState.height );
	uniforms.czm_inverseProjection.value.copy( camera.projectionMatrixInverse );
	uniforms.czm_viewportTransformation.value.copy(
		createViewportTransformation( frameState.width, frameState.height ),
	);

	const near = camera.near;
	const far = camera.far;
	const fovRad = camera.fov * Math.PI / 180.0;
	const top = near * Math.tan( 0.5 * fovRad );
	const right = top * camera.aspect;
	uniforms.czm_frustumPlanes.value.set( top, - top, - right, right );
	uniforms.czm_currentFrustum.value.set( near, far, 0.0 );

	const farDepthFromNearPlusOne = ( far - near ) + 1.0;
	const log2FarDepthFromNearPlusOne = Math.log2( farDepthFromNearPlusOne );
	const oneOverLog2FarDepthFromNearPlusOne = log2FarDepthFromNearPlusOne > 0.0
		? 1.0 / log2FarDepthFromNearPlusOne
		: 1.0;
	uniforms.czm_farDepthFromNearPlusOne.value = farDepthFromNearPlusOne;
	uniforms.czm_log2FarDepthFromNearPlusOne.value = log2FarDepthFromNearPlusOne;
	uniforms.czm_oneOverLog2FarDepthFromNearPlusOne.value = oneOverLog2FarDepthFromNearPlusOne;

	// Cesium UniformState.update derives czm_geometricToleranceOverMeter as
	// `pixelSizePerMeter * frameState.maximumScreenSpaceError`. The previous
	// adapter shipped a hardcoded 1.0, which caused the EXTRUDED_GEOMETRY
	// branch in ShadowVolumeAppearanceVS to always clamp to
	// u_globeMinimumAltitude (55 km) regardless of eye distance. With the
	// real formula, near-camera plots get a tiny extrude while distant
	// plots still cover the configured pixel tolerance.
	const viewportSize = Math.max( frameState.width, frameState.height, 1.0 );
	const pixelSizePerMeter = ( Math.tan( 0.5 * fovRad ) * 2.0 ) / viewportSize;
	uniforms.czm_geometricToleranceOverMeter.value =
		pixelSizePerMeter * CESIUM_MAXIMUM_SCREEN_SPACE_ERROR;

	// ── 贴地线扩展（guard 式写入：面图元的 uniform map 不含这两键
	//    → 守卫跳过；线图元的 uniform map 含这两键 → 每帧刷新）──
	// `czm_projection`：纯投影矩阵（Float64 算后落 Three Matrix4）。线 VS
	// 需要「EC 内挤出 → 再投影」，所以除了 mvp 还要单独提供 projection。
	if ( uniforms.czm_projection !== undefined ) {
		( uniforms.czm_projection.value as Matrix4 ).fromArray( projectionFloat64 );
	}
	// `czm_pixelRatio`：metersPerPixel 内部要乘它，HiDPI 必须正确填。
	if ( uniforms.czm_pixelRatio !== undefined ) {
		( uniforms.czm_pixelRatio as { value: number } ).value =
			frameState.pixelRatio !== undefined ? frameState.pixelRatio : 1.0;
	}
}

/**
 * Optional injection used by callers that need a non-default color material
 * (e.g. ground text needs a texture sampler in place of the per-instance fill
 * color). Other callers omit this argument and the primitive falls back to
 * `createColorMaterial` so circle / rectangle / polygon behaviour is unchanged.
 */
export interface ClassificationColorInjection {
	/** Custom color material factory. Unset → default `createColorMaterial`. */
	colorMaterialFactory?: ( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;
	/** Extra uniforms merged into the shared uniforms map before material build. */
	extraUniforms?: Record<string, { value: unknown }>;
}

/**
 * Three execution of Cesium ClassificationPrimitive's two stencil commands and
 * one color command.
 */
export class CesiumClassificationPrimitive {
	public readonly group: Group;

	private readonly stencilMesh: Mesh;
	private readonly backStencilMesh: Mesh;
	private readonly colorMesh: Mesh;
	private readonly uniforms: SharedUniforms;
	private readonly cameraHigh = new Vector3();
	private readonly cameraLow = new Vector3();
	private readonly colorMaterialFactory:
		( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;
	private colorFragmentCull: boolean;

	public constructor(
		geometry: BufferGeometry,
		extents: PlanarExtents,
		color: Color,
		alpha: number,
		renderOrder: number,
		fragmentCull: boolean,
		injection?: ClassificationColorInjection,
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
			// Initial value will be overwritten on the first frame by
			// updateFrameStateUniforms using the active camera fov / drawing
			// buffer size. The placeholder is intentionally tiny so the
			// vertex shader never produces a non-trivial extrude before the
			// uniforms are filled out.
			czm_geometricToleranceOverMeter: { value: 0.0 },
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
			u_cpuWestPlane: { value: new Vector4( 1.0, 0.0, 0.0, 0.0 ) },
			u_cpuSouthPlane: { value: new Vector4( 0.0, 1.0, 0.0, 0.0 ) },
			// Polygon-stroke uniforms (additive feature, point-in-polygon test
			// inside the existing color command — no impact on the LOG_DEPTH
			// / Float64 / LessEqualDepth precision paths).
			u_polygonBorderMode: { value: 0.0 },
			u_polygonMiterStrokeMode: { value: 0.0 },
			u_polygonPointCount: { value: 0.0 },
			u_polygonPoints: {
				value: Array.from(
					{ length: MAX_POLYGON_STYLE_VERTICES },
					() => new Vector2(),
				),
			},
			// Circle border / ring / sector uniforms (additive feature, ring
			// and sector decoration inside the color command — no impact on
			// the precision paths either).
			u_circleBorderMode: { value: 0.0 },
			u_circleCenterMeters: { value: new Vector2() },
			u_circleFillRadiusMeters: { value: 0.0 },
			u_circleRenderRadiusMeters: { value: 0.0 },
			u_circleRingCount: { value: 1.0 },
			u_circleRingGapMeters: { value: 0.0 },
			u_circleSectorStartRadians: { value: 0.0 },
			u_circleSectorAngleRadians: { value: Math.PI * 2.0 },
			czm_globeDepthTexture: { value: null },
			czm_viewport: { value: new Vector4( 0.0, 0.0, 1.0, 1.0 ) },
			czm_inverseProjection: { value: new Matrix4() },
			czm_viewportTransformation: { value: createViewportTransformation( 1, 1 ) },
			czm_frustumPlanes: { value: new Vector4() },
			czm_currentFrustum: { value: new Vector3() },
			czm_farDepthFromNearPlusOne: { value: 1.0 },
			czm_log2FarDepthFromNearPlusOne: { value: 1.0 },
			czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
			// Ground text texture slot. Default null; overwritten when caller
			// passes `extraUniforms.u_textTexture`. GLSL declaration is guarded
			// by `#ifdef CESIUM_THREE_TEXT`, so non-text materials never read it.
			u_textTexture: { value: null },
		};

		// Merge caller-supplied uniforms (e.g. `u_textTexture`) before any
		// material is built so all three commands share the same map.
		if ( injection !== undefined && injection.extraUniforms !== undefined ) {
			for ( const key in injection.extraUniforms ) {
				if ( Object.prototype.hasOwnProperty.call( injection.extraUniforms, key ) ) {
					this.uniforms[ key ] = injection.extraUniforms[ key ];
				}
			}
		}

		// Persist the color material factory so `setFragmentCulling` can rebuild
		// the color mesh later without losing the text-color injection.
		this.colorMaterialFactory =
			injection !== undefined && injection.colorMaterialFactory !== undefined
				? injection.colorMaterialFactory
				: createColorMaterial;

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
		const colorMaterial = this.colorMaterialFactory( this.uniforms, fragmentCull );

		this.stencilMesh = new Mesh( geometry, frontStencilMaterial );
		this.stencilMesh.name = 'CesiumClassificationFrontStencilDepthCommand';
		this.stencilMesh.frustumCulled = false;

		this.backStencilMesh = new Mesh( geometry, backStencilMaterial );
		this.backStencilMesh.name = 'CesiumClassificationBackStencilDepthCommand';
		this.backStencilMesh.frustumCulled = false;

		this.colorMesh = new Mesh( geometry, colorMaterial );
		this.colorMesh.name = 'CesiumClassificationColorCommand';
		this.colorMesh.frustumCulled = false;

		// Move the three shadow-volume meshes to the non-pickable layer so
		// scene raycasts (e.g. GlobeControls' adjustHeight + zoomPoint
		// resolution via `EnvironmentControls._raycast` →
		// `raycaster.intersectObject(scene)`) silently skip them.
		//
		// Why this matters: these meshes are extruded multi-km boxes
		// (terrainMinHeight → terrainMaxHeight) used purely to drive the
		// stencil + colour passes; they're not "real geometry" a user
		// should be able to click or have the camera collide with. Their
		// auto-computed boundingSphere is empty (the geometry uses
		// RTE-encoded `position3DHigh` / `position3DLow` instead of a
		// standard `position` attribute), so in practice today they don't
		// produce raycast hits anyway. Marking the layer explicitly is a
		// defensive belt-and-suspenders so any future change adding a
		// standard `position` attribute doesn't suddenly start pinning the
		// camera.
		//
		// Three.js Raycaster.intersect is gated by `object.layers.test(
		// raycaster.layers )` and does NOT check `object.visible`, so this
		// gives us the right semantics even when the host briefly hides
		// the group via `group.visible = false`. The host camera must
		// `camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER )` to
		// keep these meshes in the render path — see ground-demo.ts.
		this.stencilMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.backStencilMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.colorMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );

		this.setRenderOrder( renderOrder );
		this.group.add( this.stencilMesh, this.backStencilMesh, this.colorMesh );
	}

	/**
	 * Updates the base render order for this primitive's contiguous command block.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		const safeRenderOrder = Number.isFinite( renderOrder ) ? renderOrder : 0;
		this.stencilMesh.renderOrder = safeRenderOrder;
		this.backStencilMesh.renderOrder = safeRenderOrder + 1;
		this.colorMesh.renderOrder = safeRenderOrder + 2;
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
	 * Supplies the original polygon fill ring as planar meter coordinates so
	 * the color fragment can run a point-in-polygon test for stroke styling.
	 *
	 * The shader uses these values only when `u_polygonBorderMode` is on; the
	 * caller toggles that mode by passing 3+ points. Calling with fewer than 3
	 * points disables polygon-border mode and falls back to the rectangle
	 * `u_innerMetersRect` axis-aligned border that already shipped.
	 *
	 * @param points Fill polygon vertices relative to the same SW meter origin
	 *               the vertex shader derives from `u_southWest_HIGH/LOW`.
	 */
	public setPolygonBorderPoints( points: readonly Vector2[] ): void {
		const polygonPoints = this.uniforms.u_polygonPoints.value;
		const pointCount = Math.min( points.length, MAX_POLYGON_STYLE_VERTICES );

		for ( let i = 0; i < pointCount; i ++ ) {
			polygonPoints[ i ].copy( points[ i ] );
		}

		this.uniforms.u_polygonPointCount.value = pointCount;
		this.uniforms.u_polygonBorderMode.value = pointCount >= 3 ? 1.0 : 0.0;
		// Activating the polygon branch disables the circle branch so the
		// fragment shader never tries to read circle uniforms left over from
		// a previous primitive setup.
		this.uniforms.u_circleBorderMode.value = 0.0;
	}

	/**
	 * Selects the polygon stroke classifier used by the fragment shader.
	 *
	 * Round mode clips the stroke by distance to the fill ring and is robust
	 * for generic polygons. Miter mode trusts the already-expanded render
	 * geometry and only tests fill-vs-border, which preserves sharp arrow
	 * tips and concave notches at meter scale.
	 *
	 * @param enabled True when the render ring is a real miter offset shell.
	 */
	public setPolygonMiterStrokeMode( enabled: boolean ): void {
		this.uniforms.u_polygonMiterStrokeMode.value = enabled ? 1.0 : 0.0;
	}

	/**
	 * Supplies circle styling values in planar meter coordinates so the color
	 * fragment can decorate the disc with concentric rings, a sector cut-out,
	 * and an outer stroke band. Calling with both radii at zero disables the
	 * circle branch and the rectangle / polygon paths take over.
	 *
	 * @param centerMeters Circle center relative to the shader's SW meter origin.
	 * @param fillRadiusMeters Public fill radius in meters.
	 * @param renderRadiusMeters Shadow-volume render radius in meters.
	 * @param ringCount Number of filled concentric bands. Defaults to 1.
	 * @param ringGapMeters Transparent gap width between filled bands in meters.
	 * @param sectorStartRadians Start angle in the circle's local ENU plane.
	 * @param sectorAngleRadians Positive angular sweep; ±2π means full circle.
	 */
	public setCircleBorderStyle(
		centerMeters: Vector2,
		fillRadiusMeters: number,
		renderRadiusMeters: number,
		ringCount = 1.0,
		ringGapMeters = 0.0,
		sectorStartRadians = 0.0,
		sectorAngleRadians = Math.PI * 2.0,
	): void {
		const safeRingCount = Number.isFinite( ringCount )
			? Math.max( Math.floor( ringCount ), 1.0 )
			: 1.0;
		const safeRingGapMeters = Number.isFinite( ringGapMeters )
			? Math.max( ringGapMeters, 0.0 )
			: 0.0;
		const safeSectorStartRadians = Number.isFinite( sectorStartRadians )
			? sectorStartRadians
			: 0.0;
		const safeSectorAngleRadians = Number.isFinite( sectorAngleRadians )
			? Math.min( Math.max( sectorAngleRadians, - Math.PI * 2.0 ), Math.PI * 2.0 )
			: Math.PI * 2.0;

		this.uniforms.u_circleCenterMeters.value.copy( centerMeters );
		this.uniforms.u_circleFillRadiusMeters.value = Math.max( fillRadiusMeters, 0.0 );
		this.uniforms.u_circleRenderRadiusMeters.value = Math.max( renderRadiusMeters, 0.0 );
		this.uniforms.u_circleRingCount.value = safeRingCount;
		this.uniforms.u_circleRingGapMeters.value = safeRingGapMeters;
		this.uniforms.u_circleSectorStartRadians.value = safeSectorStartRadians;
		this.uniforms.u_circleSectorAngleRadians.value = safeSectorAngleRadians;
		this.uniforms.u_circleBorderMode.value =
			fillRadiusMeters > 0.0 && renderRadiusMeters > 0.0 ? 1.0 : 0.0;
		// Activating the circle branch disables the polygon branch (mutually
		// exclusive in the fragment shader).
		this.uniforms.u_polygonBorderMode.value = 0.0;
		this.uniforms.u_polygonPointCount.value = 0.0;
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
		this.colorMesh.material = this.colorMaterialFactory( this.uniforms, enabled );
		oldMaterial.dispose();
	}

	/**
	 * Updates Cesium automatic uniforms for this frame.
	 *
	 * @param frameState Three-side equivalent of Cesium frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		encodeCesiumVector3( frameState.camera.position, this.cameraHigh, this.cameraLow );
		updateFrameStateUniforms( frameState, this.uniforms );
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
