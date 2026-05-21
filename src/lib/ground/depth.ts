// ============================================================
// depth.ts
// Layer: Cesium-to-Three ground depth pass.
// Role: render terrain/globe depth into Cesium-compatible packed depth and
//       provide ellipsoid depth meshes for classification.
// Dependencies: Three.js render targets/materials and ground constants.
// Consumed by: public ground adapter and demos.
// ============================================================

import {
	Color,
	Mesh,
	NearestFilter,
	Object3D,
	RGBAFormat,
	RawShaderMaterial,
	Scene,
	SphereGeometry,
	UnsignedByteType,
	Vector3,
	WebGLRenderTarget,
	WebGLRenderer,
	GLSL3,
	type PerspectiveCamera,
} from 'three';

import {
	WGS84_X_RADIUS,
	WGS84_Y_RADIUS,
	WGS84_Z_RADIUS,
} from './constants';
import { createPackDepthMaterial, ENABLE_LOG_DEPTH } from './materials';

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
	 * @param camera Current camera. Required so the pack-depth material can
	 *               write Cesium-compatible LOG_DEPTH values per frame.
	 * @param sourceScene Optional external scene, used for 3d-tiles-renderer content.
	 * @param depthRoot Optional root object to isolate while rendering sourceScene.
	 */
	public render(
		renderer: WebGLRenderer,
		camera: PerspectiveCamera,
		sourceScene: Scene = this.scene,
		depthRoot?: Object3D,
	): void {
		this.updateLogDepthUniforms( camera );

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

	/**
	 * Refreshes the pack-depth shader's log-depth uniforms so they match the
	 * camera's current near/far. Equivalent to Cesium UniformState.update for
	 * `czm_currentFrustum`, `czm_farDepthFromNearPlusOne`, and
	 * `czm_oneOverLog2FarDepthFromNearPlusOne`.
	 *
	 * @param camera Active perspective camera.
	 */
	private updateLogDepthUniforms( camera: PerspectiveCamera ): void {
		if ( ! ENABLE_LOG_DEPTH ) {
			return;
		}

		const uniforms = this.packDepthMaterial.uniforms;
		if ( ! ( uniforms.czm_currentFrustum.value instanceof Vector3 ) ) {
			uniforms.czm_currentFrustum.value = new Vector3();
		}
		const currentFrustum = uniforms.czm_currentFrustum.value as Vector3;
		currentFrustum.set( camera.near, camera.far, 0.0 );

		const farDepthFromNearPlusOne = ( camera.far - camera.near ) + 1.0;
		const log2FarDepthFromNearPlusOne = Math.log2( farDepthFromNearPlusOne );
		uniforms.czm_farDepthFromNearPlusOne.value = farDepthFromNearPlusOne;
		uniforms.czm_oneOverLog2FarDepthFromNearPlusOne.value =
			log2FarDepthFromNearPlusOne > 0.0 ? 1.0 / log2FarDepthFromNearPlusOne : 1.0;
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
