// ============================================================
// depth.ts
// 层级:Cesium-to-Three 贴地深度通道。
// 职责:把地形/地球深度渲染为 Cesium 兼容的 packed depth 纹理，
//      并为 classification 提供椭球深度网格。
// 依赖:Three.js 渲染目标/材质与贴地常量。
// 被消费:公开贴地适配器与 demo。
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
 * 渲染 Cesium 风格的 packed globe depth 纹理。
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
	 * 添加一个只写入 packed depth 纹理的网格。
	 *
	 * @param mesh 为 globe depth 提供几何深度的网格。
	 */
	public addDepthMesh( mesh: Mesh ): void {
		mesh.frustumCulled = false;
		this.scene.add( mesh );
	}

	/**
	 * 把任意对象树加入此深度通道的私有场景。
	 *
	 * @param object 为 globe depth 提供网格深度的对象树。
	 */
	public addDepthObject( object: Object3D ): void {
		this.scene.add( object );
	}

	/**
	 * 将 packed depth 渲染到本通道的渲染目标。
	 *
	 * @param renderer 当前 Three 渲染器。
	 * @param camera 当前相机。pack-depth 材质需要它逐帧写入 Cesium 兼容的 LOG_DEPTH。
	 * @param sourceScene 可选外部场景，用于 3d-tiles-renderer 内容。
	 * @param depthRoot 渲染 sourceScene 时需要单独保留的可选根对象。
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
	 * 调整 packed depth 帧缓冲尺寸。
	 *
	 * @param width 绘制缓冲宽度。
	 * @param height 绘制缓冲高度。
	 */
	public resize( width: number, height: number ): void {
		this.target.setSize( width, height );
	}

	/**
	 * 释放本通道持有的 GPU 资源。
	 */
	public dispose(): void {
		this.packDepthMaterial.dispose();
		this.target.dispose();
	}

	/**
	 * 刷新 pack-depth 着色器的 log-depth uniform，使其匹配当前相机 near/far。
	 * 等价于 Cesium UniformState.update 对 `czm_currentFrustum`、
	 * `czm_farDepthFromNearPlusOne` 和 `czm_oneOverLog2FarDepthFromNearPlusOne`
	 * 的更新。
	 *
	 * @param camera 当前透视相机。
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
 * 创建 CesiumGlobeDepth 和主帧缓冲深度预通道使用的椭球深度网格。
 *
 * @param widthSegments 水平方向分段数。
 * @param heightSegments 垂直方向分段数。
 * @returns 主场景深度网格与 packed-depth 通道网格。
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
