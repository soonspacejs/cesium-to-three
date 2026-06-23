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
	NoColorSpace,
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

export interface CesiumGlobeDepthRenderOptions {
	/**
	 * 是否把本通道私有场景中的椭球兜底深度写入 packed depth。
	 * 有真实地形参与渲染时应关闭，避免不可见的椭球兜底在低角度视角下把天空
	 * 伪装成有效地面深度；无地形模式则打开，让标绘贴到 WGS84 椭球面。
	 */
	includeFallbackDepth?: boolean;
}

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
		this.target.texture.colorSpace = NoColorSpace;
		this.target.texture.generateMipmaps = false;
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
	 * @param sourceScene 可选外部场景，用于 um-3d-tiles-renderer 内容。
	 * @param depthRoot 渲染 sourceScene 时需要单独保留的可选根对象，或一组根对象。
	 *        传入数组时，只有"包含其中任意一个根"的 sourceScene 顶层子对象会被保留，
	 *        其余临时隐藏——用于"只把地形 / 只把模型 / 同时把地形与模型"渲入深度纹理，
	 *        是分类目标（terrain / tileset / both）多纹理深度管线的核心控制点。
	 *        见 {@link ClassificationDepthManager}。
	 */
	public render(
		renderer: WebGLRenderer,
		camera: PerspectiveCamera,
		sourceScene: Scene = this.scene,
		depthRoot?: Object3D | readonly Object3D[],
		options: CesiumGlobeDepthRenderOptions = {},
	): void {
		this.updateLogDepthUniforms( camera );

		const includeFallbackDepth = options.includeFallbackDepth ?? true;
		const previousTarget = renderer.getRenderTarget();
		const previousClearColor = new Color();
		renderer.getClearColor( previousClearColor );
		const previousClearAlpha = renderer.getClearAlpha();
		const previousOverrideMaterial = sourceScene.overrideMaterial;
		// 关键：sourceScene 若设了 Color 背景（常见——demo 给主场景 scene.background =
		// new Color(...)），Three.js 的 WebGLBackground 在每次 renderer.render(sourceScene)
		// 时会对这张 Color 背景做 forceClear，用「背景色（经 sRGB→linear 转换）」清掉
		// 整个颜色缓冲——把我们上面手动设的 (0,0,0,0) packed-depth 哨兵整片覆盖成一个
		// 非零小值。带兜底的 terrain/both 纹理因兜底椭球随后铺满全屏被掩盖；但 tileset
		// 纹理（includeFallbackDepth:false，无兜底）会因此「无模型处不再是哨兵 0」，
		// 于是 CULL_FRAGMENTS 的 `logDepthOrDepth == 0.0` 判定永不成立 → CESIUM_3D_TILE
		// 下无覆盖区域整片漏渲染（且经深度重建后随相机倾角漂移）。这里在离屏深度渲染
		// 期间临时置空背景，禁掉那次 forceClear，让手动哨兵清屏生效；末尾恢复。
		const previousBackground = sourceScene.background;
		const visibilityRestore: Array<{ object: Object3D; visible: boolean }> = [];

		// 归一化为根对象数组，统一处理"单根 / 多根"两种调用形态。空数组（显式传
		// `[]`）表示"不保留任何外部对象"——只渲染兜底层（用于无模型时的纯椭球深度）。
		const depthRoots: readonly Object3D[] | undefined =
			depthRoot === undefined
				? undefined
				: Array.isArray( depthRoot )
					? depthRoot
					: [ depthRoot as Object3D ];

		if ( depthRoots ) {
			for ( const child of sourceScene.children ) {
				// 判断该顶层子对象是否"包含"任一指定根（即某个根是它本身或其后代）。
				// 逐根从根向上回溯 parent 链，命中 child 即视为包含。
				let childContainsAnyRoot = false;
				for ( const root of depthRoots ) {
					let current: Object3D | null = root;
					while ( current ) {
						if ( current === child ) {
							childContainsAnyRoot = true;
							break;
						}
						current = current.parent;
					}
					if ( childContainsAnyRoot ) {
						break;
					}
				}

				if ( ! childContainsAnyRoot ) {
					visibilityRestore.push( { object: child, visible: child.visible } );
					child.visible = false;
				}
			}
		}

		renderer.setRenderTarget( this.target );
		renderer.setClearColor( 0x000000, 0.0 );
		// 离屏深度渲染期间禁用 sourceScene 的背景 forceClear（见上方 previousBackground
		// 注释）：置空后 WebGLBackground 不再清屏，下面手动的 (0,0,0,0) 哨兵清屏成为唯一清屏。
		sourceScene.background = null;
		// 兜底层与外部地形(瓦片)共享同一个深度缓冲：关掉 autoClear，避免第二次
		// render 把第一次的结果清掉；这里只手动清一次。
		const previousAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.clear( true, true, false );

		// 兜底基底层：本通道自有场景(通过 addDepthMesh 注入的椭球面网格)。它保证在
		// 外部地形(瓦片)没有覆盖的屏幕区域，packed 深度纹理依然有一个有效深度，
		// 从而让贴地 classification 与瓦片是否加载解耦——无瓦片时标绘贴到椭球面，
		// 而不是因 CULL_FRAGMENTS 读到空深度被整段丢弃。先画兜底、再画瓦片，瓦片
		// 凭 LESS_EQUAL 在有覆盖处覆盖兜底。当调用方本身就传入 this.scene 时跳过。
		if ( includeFallbackDepth && sourceScene !== this.scene && this.scene.children.length > 0 ) {
			const previousFallbackOverride = this.scene.overrideMaterial;
			this.scene.overrideMaterial = this.packDepthMaterial;
			renderer.render( this.scene, camera );
			this.scene.overrideMaterial = previousFallbackOverride;
		}

		sourceScene.overrideMaterial = this.packDepthMaterial;
		renderer.render( sourceScene, camera );
		sourceScene.overrideMaterial = previousOverrideMaterial;
		for ( const entry of visibilityRestore ) {
			entry.object.visible = entry.visible;
		}
		renderer.autoClear = previousAutoClear;
		sourceScene.background = previousBackground;
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
