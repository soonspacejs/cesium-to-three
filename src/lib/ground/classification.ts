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
	Vector3,
	Vector4,
	type Material,
} from 'three';

import { CESIUM_GLOBE_MINIMUM_ALTITUDE, SCENE_MODE_3D } from './constants';
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

/**
 * Builds a matrix with camera rotation only, matching Cesium RTE uniforms.
 *
 * @param frameState Current Three-side frame state.
 * @param uniforms Shared material uniforms updated in place.
 */
function updateFrameStateUniforms( frameState: CesiumGroundFrameState, uniforms: SharedUniforms ): void {
	const modelViewRelativeToEye = uniforms.czm_modelViewRelativeToEye.value;
	modelViewRelativeToEye.copy( frameState.camera.matrixWorldInverse );
	modelViewRelativeToEye.elements[ 12 ] = 0.0;
	modelViewRelativeToEye.elements[ 13 ] = 0.0;
	modelViewRelativeToEye.elements[ 14 ] = 0.0;
	uniforms.czm_modelViewProjectionRelativeToEye.value.multiplyMatrices(
		frameState.camera.projectionMatrix,
		modelViewRelativeToEye,
	);
	uniforms.czm_normal.value.setFromMatrix4( modelViewRelativeToEye );
	uniforms.czm_globeDepthTexture.value = frameState.depthTexture;
	uniforms.czm_viewport.value.set( 0.0, 0.0, frameState.width, frameState.height );
	uniforms.czm_inverseProjection.value.copy( frameState.camera.projectionMatrixInverse );
	uniforms.czm_viewportTransformation.value.copy(
		createViewportTransformation( frameState.width, frameState.height ),
	);

	const near = frameState.camera.near;
	const far = frameState.camera.far;
	const top = near * Math.tan( frameState.camera.fov * Math.PI / 360.0 );
	const right = top * frameState.camera.aspect;
	uniforms.czm_frustumPlanes.value.set( top, - top, - right, right );
	uniforms.czm_currentFrustum.value.set( near, far, 0.0 );
	uniforms.czm_log2FarDepthFromNearPlusOne.value = Math.log2( far - near + 1.0 );
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
		this.stencilMesh.frustumCulled = false;

		this.backStencilMesh = new Mesh( geometry, backStencilMaterial );
		this.backStencilMesh.name = 'CesiumClassificationBackStencilDepthCommand';
		this.backStencilMesh.frustumCulled = false;

		this.colorMesh = new Mesh( geometry, colorMaterial );
		this.colorMesh.name = 'CesiumClassificationColorCommand';
		this.colorMesh.frustumCulled = false;

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
