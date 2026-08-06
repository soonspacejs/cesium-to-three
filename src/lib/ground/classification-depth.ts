// ============================================================
// classification-depth.ts
// 层级：Cesium-to-Three 贴地分类深度管线（多目标 / 贴模型 / 倾斜摄影）。
// 职责：把"标绘贴到哪类表面"（地形 / 3D Tiles 模型 / 二者）落实为"按分类目标
//      渲染至多三张 packed 深度纹理"，并提供给标绘图元采样。这是把单一地形贴地
//      升级为"贴倾斜摄影模型 / 贴 3D Tiles"的核心模块。
//
// ── 为什么需要这个模块（与 Cesium 源码的对应关系）──────────────────────
//   Cesium（Source/Scene/ClassificationPrimitive.js + Scene.js）用以下机制区分
//   三种 ClassificationType：
//     1. 两个深度源：GlobeDepth（仅地形）+ 帧缓冲深度（地形 + 3D Tiles 合并）。
//     2. 3D Tiles 渲染时写入 stencil 最高位 CESIUM_3D_TILE_MASK(0x80)，标记
//        "此像素属于 3D Tiles"。
//     3. 每个分类图元派生两套命令：
//          - TERRAIN_CLASSIFICATION：比对 GlobeDepth（仅地形），不看 stencil 位
//            → 贴地形（即便其上有模型，标绘仍贴在模型下方的地面）。
//          - CESIUM_3D_TILE_CLASSIFICATION：比对帧缓冲深度，并用 stencil 位掩码
//            限制到"3D Tiles 像素" → 贴模型（无模型处被掩掉不着色）。
//     4. classificationType 决定推送哪套命令（BOTH 推两套）。
//
//   cesium-to-three 的贴地深度不是真实 depth+stencil 缓冲，而是打包进 packed
//   RGBA 纹理（czm_globeDepthTexture）。因此本移植改用等价但更直接的方案：
//   **按分类目标分别渲染至多三张 packed 深度纹理**——
//     - terrain：椭球兜底 + 地形贡献者         （= Cesium GlobeDepth）
//     - tileset：仅 3D Tiles 模型贡献者          （= 被 stencil 位掩码后的合并深度）
//     - both   ：椭球兜底 + 地形 + 模型，取最近   （= 不掩码的合并深度）
//   标绘图元按自身 classificationType 采样对应纹理（见
//   classification.ts: resolveClassificationDepthTexture）。
//
//   关键简化——CESIUM_3D_TILE 的"无模型处掩掉"无需移植 stencil 位：
//     tileset 纹理在"没有模型覆盖"的像素保持清屏哨兵值（depth==0，见 depth.ts
//     的 setClearColor(0,0,0,0)），而 color pass 的既有 CULL_FRAGMENTS 分支
//     （ShadowVolumeAppearanceFS：logDepthOrDepth == 0.0 → discard）天然把这些
//     像素丢弃。于是"只贴模型、无模型处不着色"自动达成。
//
// ── 性能：按需渲染，零浪费 ────────────────────────────────────────────
//   三张纹理懒创建（首次请求某目标才分配 RT），且每帧只渲染"宿主当帧请求的目标
//   集合"。常见场景的代价：
//     - 纯地形（无模型贡献者）：只渲 terrain（1 pass，与历史相同）。
//     - 纯模型 / 全 BOTH：只渲 both（1 pass）。
//     - 同时混用 TERRAIN + CESIUM_3D_TILE + BOTH：最多 3 pass。
//
// 依赖：three（场景 / 几何 / RT）、./depth（CesiumGlobeDepth）、
//      ./ellipsoid-depth-source（椭球兜底主网格 + 共享 log-depth uniform）、
//      ./constants（WGS84 半径）、./materials（packed depth 材质，仅供兜底网格自洽）、
//      ./types（ClassificationType / 纹理集 / frameState）。
// 被消费：宿主渲染循环（demo/model-clamp-demo.ts）、GroundDecalManager（可选接入）。
// ============================================================

import {
	Mesh,
	type Object3D,
	type PerspectiveCamera,
	type Scene,
	SphereGeometry,
	type Texture,
	type WebGLRenderer,
} from 'three';

import {
	WGS84_X_RADIUS,
	WGS84_Y_RADIUS,
	WGS84_Z_RADIUS,
} from './constants';
import { CesiumGlobeDepth } from './depth';
import {
	EllipsoidDepthSource,
	type EllipsoidDepthSourceOptions,
} from './ellipsoid-depth-source';
import {
	configureAnalyticEllipsoidDepthMesh,
	createPackDepthMaterial,
} from './materials';
import {
	ClassificationType,
	type CesiumGroundFrameState,
	type ClassificationDepthTextureSet,
} from './types';

/** 深度贡献者的种类。 */
export type DepthContributorKind =
	/** 地形（如 Cesium World Terrain 瓦片）：参与 terrain 与 both 纹理。 */
	| 'terrain'
	/** 3D Tiles 模型（如倾斜摄影 / OSM Buildings）：参与 tileset 与 both 纹理。 */
	| 'tileset';

/** {@link ClassificationDepthManager} 构造选项。 */
export interface ClassificationDepthManagerOptions {
	/**
	 * 椭球面兜底配置（分段数 / 半径 / 偏移），或传 false 显式关闭兜底。
	 * 关闭兜底时：没有地形 / 模型覆盖的屏幕区域，标绘不渲染（不再贴到 WGS84
	 * 椭球面）。默认启用（与单纹理 EllipsoidDepthSource 行为一致）。
	 */
	ellipsoidFallback?: EllipsoidDepthSourceOptions | false;
}

/** 内部：一张分类目标深度纹理的运行时载体。 */
interface DepthSlot {
	/** 底层 packed 深度通道。 */
	globeDepth: CesiumGlobeDepth;
	/**
	 * 该通道私有场景中的椭球兜底网格（packed 几何，材质会被通道 override）。
	 * tileset 目标不含兜底，故为 null。
	 */
	fallbackMesh: Mesh | null;
}

/**
 * 贴地分类深度管理器：按分类目标渲染至多三张 packed 深度纹理，支撑"标绘贴地形 /
 * 贴 3D Tiles 模型 / 贴倾斜摄影"三种模式同帧并存。
 *
 * 典型用法（宿主渲染循环）：
 * ```ts
 * const depthManager = new ClassificationDepthManager( w, h );
 * depthManager.attach( scene );                       // 椭球兜底主网格接入主场景
 * depthManager.addContributor( terrainTiles.group, 'terrain' );
 * depthManager.addContributor( obliqueModel.group, 'tileset' );
 *
 * // 每帧：
 * depthManager.update( camera );                      // 刷新共享 log-depth uniform
 * depthManager.renderDepth( renderer, camera, scene, [ ClassificationType.BOTH ] );
 * decals.update( depthManager.buildFrameState( {
 *   depthTexture: depthManager.getTexture( ClassificationType.BOTH )!,
 *   width: w, height: h, camera, pixelRatio,
 * } ) );
 * renderer.render( scene, camera );
 * ```
 */
export class ClassificationDepthManager {

	/** 当前绘制缓冲宽度（物理像素）。 */
	private width: number;

	/** 当前绘制缓冲高度（物理像素）。 */
	private height: number;

	/** 椭球兜底源（提供主场景 stencil Z-fail 兜底网格 + 共享 log-depth uniform）。 */
	private readonly fallbackSource: EllipsoidDepthSource | null;

	/** 已挂接的主场景（detach 时用）。 */
	private attachedMainScene: ( Scene | Object3D ) | null = null;

	/** 三个分类目标的深度槽（懒创建）。 */
	private readonly slots: {
		terrain: DepthSlot | null;
		tileset: DepthSlot | null;
		both: DepthSlot | null;
	} = { terrain: null, tileset: null, both: null };

	/** 地形深度贡献者集合（参与 terrain / both）。 */
	private readonly terrainContributors = new Set<Object3D>();

	/** 3D Tiles 模型深度贡献者集合（参与 tileset / both）。 */
	private readonly tilesetContributors = new Set<Object3D>();

	/** 是否已释放。 */
	private disposed = false;

	/**
	 * @param width 绘制缓冲宽度（物理像素）。
	 * @param height 绘制缓冲高度（物理像素）。
	 * @param options 兜底配置等。
	 */
	public constructor(
		width: number,
		height: number,
		options: ClassificationDepthManagerOptions = {},
	) {
		this.width = Math.max( 1, Math.floor( width ) );
		this.height = Math.max( 1, Math.floor( height ) );

		// 椭球兜底：复用 EllipsoidDepthSource 的"主场景 log-depth 兜底网格 + 共享
		// log-depth uniform 刷新"。其自带的 packed 兜底网格在这里不使用——多纹理
		// 场景下每张需要兜底的纹理各自持有一份 packed 兜底球（见 ensureSlot）。
		this.fallbackSource =
			options.ellipsoidFallback === false
				? null
				: new EllipsoidDepthSource(
					typeof options.ellipsoidFallback === 'object'
						? options.ellipsoidFallback
						: {},
				);
	}

	// ── 贡献者登记 ──────────────────────────────────────────────────────

	/**
	 * 登记一个深度贡献者。
	 *
	 * @param object 贡献几何深度的对象树根（通常 tilesRenderer.group）。
	 * @param kind   'terrain' 参与 terrain/both；'tileset' 参与 tileset/both。
	 */
	public addContributor( object: Object3D, kind: DepthContributorKind ): void {
		if ( this.disposed ) {
			return;
		}
		if ( kind === 'terrain' ) {
			this.terrainContributors.add( object );
		} else {
			this.tilesetContributors.add( object );
		}
	}

	/**
	 * 移除一个深度贡献者（不影响其在主场景中的渲染，仅退出深度贡献）。
	 *
	 * @param object 之前登记的对象树根。
	 */
	public removeContributor( object: Object3D ): void {
		this.terrainContributors.delete( object );
		this.tilesetContributors.delete( object );
	}

	// ── 兜底挂接 ────────────────────────────────────────────────────────

	/**
	 * 把椭球兜底主网格挂接到主场景，为 stencil Z-fail 提供"无地形 / 无模型"时的
	 * 海平面兜底深度。重复调用会先 detach 上一次。无兜底（构造时关闭）时为 no-op。
	 *
	 * @param mainScene 主场景或其下任意容器对象。
	 * @returns this，便于链式调用。
	 */
	public attach( mainScene: Scene | Object3D ): this {
		if ( this.disposed || this.fallbackSource === null ) {
			return this;
		}
		this.detach();
		mainScene.add( this.fallbackSource.mainDepthMesh );
		this.attachedMainScene = mainScene;
		return this;
	}

	/** 从主场景移除椭球兜底主网格（不释放 GPU 资源）。 */
	public detach(): void {
		if ( this.attachedMainScene !== null && this.fallbackSource !== null ) {
			this.attachedMainScene.remove( this.fallbackSource.mainDepthMesh );
			this.attachedMainScene = null;
		}
	}

	/**
	 * 设置椭球半径偏移（米），等价 Cesium depthPlaneEllipsoidOffset。无兜底时 no-op。
	 *
	 * @param meters 偏移量（正抬高、负压低）。
	 */
	public setEllipsoidOffset( meters: number ): void {
		this.fallbackSource?.setEllipsoidOffset( meters );
	}

	// ── 每帧 ────────────────────────────────────────────────────────────

	/**
	 * 每帧刷新共享 log-depth uniform（与瓦片材质同口径），应在 renderDepth 之前调用。
	 *
	 * @param camera 当前透视相机。
	 */
	public update( camera: PerspectiveCamera ): void {
		this.fallbackSource?.update( camera );
	}

	/**
	 * 渲染本帧请求的分类目标深度纹理。
	 *
	 * @param renderer 当前渲染器。
	 * @param camera 当前相机。
	 * @param scene 主场景（含地形 / 模型贡献者；本方法用 depthRoot 临时隐藏无关对象）。
	 * @param requestedTypes 本帧需要的分类目标集合（来自所有活跃标绘的 classificationType
	 *        去重）。只渲染这些目标对应的纹理，未请求的目标跳过，零浪费。
	 */
	public renderDepth(
		renderer: WebGLRenderer,
		camera: PerspectiveCamera,
		scene: Scene,
		requestedTypes: Iterable<ClassificationType>,
	): void {
		if ( this.disposed ) {
			return;
		}

		// 去重请求集合。
		const wantTerrain = new Set<ClassificationType>();
		for ( const t of requestedTypes ) {
			wantTerrain.add( t );
		}

		if ( wantTerrain.has( ClassificationType.TERRAIN ) ) {
			this.renderTerrain( renderer, camera, scene );
		}
		if ( wantTerrain.has( ClassificationType.CESIUM_3D_TILE ) ) {
			this.renderTileset( renderer, camera, scene );
		}
		if ( wantTerrain.has( ClassificationType.BOTH ) ) {
			this.renderBoth( renderer, camera, scene );
		}
	}

	/** 渲染 terrain 纹理：椭球兜底 + 地形贡献者。 */
	private renderTerrain( renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene ): void {
		const slot = this.ensureSlot( 'terrain', true );
		// depthRoot = 地形贡献者数组；空时只渲兜底（纯椭球面）。
		slot.globeDepth.render(
			renderer,
			camera,
			scene,
			Array.from( this.terrainContributors ),
			{ includeFallbackDepth: true },
		);
	}

	/** 渲染 tileset 纹理：仅 3D Tiles 模型贡献者（无兜底，无模型处留清屏哨兵）。 */
	private renderTileset( renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene ): void {
		const slot = this.ensureSlot( 'tileset', false );
		slot.globeDepth.render(
			renderer,
			camera,
			scene,
			Array.from( this.tilesetContributors ),
			{ includeFallbackDepth: false },
		);
	}

	/** 渲染 both 纹理：椭球兜底 + 地形 + 模型，取最近表面。 */
	private renderBoth( renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene ): void {
		const slot = this.ensureSlot( 'both', true );
		const roots: Object3D[] = [
			...this.terrainContributors,
			...this.tilesetContributors,
		];
		slot.globeDepth.render(
			renderer,
			camera,
			scene,
			roots,
			{ includeFallbackDepth: true },
		);
	}

	// ── 纹理访问 ────────────────────────────────────────────────────────

	/**
	 * 取某分类目标当前的 packed 深度纹理。未曾渲染该目标时返回 null。
	 *
	 * @param classificationType 分类目标。
	 * @returns 纹理或 null。
	 */
	public getTexture( classificationType: ClassificationType ): Texture | null {
		const slot = this.slotOf( classificationType );
		return slot ? slot.globeDepth.target.texture : null;
	}

	/**
	 * 取三目标的纹理集合（用于填充 {@link CesiumGroundFrameState.classificationDepthTextures}）。
	 *
	 * @returns 纹理集；未渲染的目标字段为 null。
	 */
	public getTextureSet(): ClassificationDepthTextureSet {
		return {
			terrain: this.slots.terrain ? this.slots.terrain.globeDepth.target.texture : null,
			tileset: this.slots.tileset ? this.slots.tileset.globeDepth.target.texture : null,
			both: this.slots.both ? this.slots.both.globeDepth.target.texture : null,
		};
	}

	/**
	 * 基于一份基础帧状态，补齐 `classificationDepthTextures` 字段后返回新对象。
	 * 便于宿主一行把多纹理透传给标绘管理器 / 图元。
	 *
	 * @param base 基础帧状态（至少含 depthTexture / width / height / camera）。
	 * @returns 带多纹理集合的帧状态。
	 */
	public buildFrameState( base: CesiumGroundFrameState ): CesiumGroundFrameState {
		return { ...base, classificationDepthTextures: this.getTextureSet() };
	}

	// ── 尺寸 / 释放 ─────────────────────────────────────────────────────

	/**
	 * 调整全部已创建深度纹理的尺寸。
	 *
	 * @param width 绘制缓冲宽度。
	 * @param height 绘制缓冲高度。
	 */
	public resize( width: number, height: number ): void {
		this.width = Math.max( 1, Math.floor( width ) );
		this.height = Math.max( 1, Math.floor( height ) );
		for ( const key of [ 'terrain', 'tileset', 'both' ] as const ) {
			this.slots[ key ]?.globeDepth.resize( this.width, this.height );
		}
	}

	/** 释放全部 GPU 资源（三张纹理 + 兜底网格），并从主场景移除兜底主网格。 */
	public dispose(): void {
		if ( this.disposed ) {
			return;
		}
		this.detach();
		this.fallbackSource?.dispose();

		for ( const key of [ 'terrain', 'tileset', 'both' ] as const ) {
			const slot = this.slots[ key ];
			if ( slot ) {
				if ( slot.fallbackMesh ) {
					slot.fallbackMesh.geometry.dispose();
				}
				slot.globeDepth.dispose();
				this.slots[ key ] = null;
			}
		}

		this.terrainContributors.clear();
		this.tilesetContributors.clear();
		this.disposed = true;
	}

	// ── 内部 ────────────────────────────────────────────────────────────

	/** 把分类目标映射到内部槽位（CESIUM_3D_TILE→tileset，其余直名）。 */
	private slotOf( classificationType: ClassificationType ): DepthSlot | null {
		switch ( classificationType ) {
			case ClassificationType.TERRAIN:
				return this.slots.terrain;
			case ClassificationType.CESIUM_3D_TILE:
				return this.slots.tileset;
			case ClassificationType.BOTH:
			default:
				return this.slots.both;
		}
	}

	/**
	 * 懒创建并返回某目标的深度槽。
	 *
	 * @param key 槽位键。
	 * @param withFallback 是否在该通道私有场景注入一份 packed 椭球兜底球。
	 *        terrain / both 为 true；tileset 为 false。
	 * @returns 深度槽。
	 */
	private ensureSlot(
		key: 'terrain' | 'tileset' | 'both',
		withFallback: boolean,
	): DepthSlot {
		const existing = this.slots[ key ];
		if ( existing ) {
			return existing;
		}

		const globeDepth = new CesiumGlobeDepth( this.width, this.height );
		globeDepth.target.texture.name = `CesiumClassificationDepth_${ key }`;

		let fallbackMesh: Mesh | null = null;
		// 仅当本目标需要兜底、且全局兜底未被关闭时，注入一份 packed 椭球兜底球。
		// 该网格是 WGS84 椭球的覆盖代理；其材质在 packed 通道里会被 globeDepth 的
		// overrideMaterial 覆盖，真实深度由共享材质的解析椭球分支逐片元计算。
		if ( withFallback && this.fallbackSource !== null ) {
			fallbackMesh = this.createPackedFallbackMesh();
			globeDepth.addDepthMesh( fallbackMesh );
		}

		const slot: DepthSlot = { globeDepth, fallbackMesh };
		this.slots[ key ] = slot;
		return slot;
	}

	/**
	 * 创建一份 packed 椭球兜底覆盖代理。
	 *
	 * 与 EllipsoidDepthSource / createCesiumEllipsoidDepthMeshes 同口径：
	 * 单位球绕 X 轴旋 90°（把极轴从 Three 默认 Y 改为 ECEF 的 Z），mesh scale
	 * 定义 WGS84 三轴半径；实际深度由片元射线解析求交。frustumCulled 关闭。
	 *
	 * @returns packed 兜底网格。
	 */
	private createPackedFallbackMesh(): Mesh {
		const geometry = new SphereGeometry( 1.0, 192, 96 );
		geometry.rotateX( Math.PI * 0.5 );
		geometry.computeBoundingSphere();

		const mesh = new Mesh( geometry, createPackDepthMaterial() );
		mesh.name = 'CesiumClassificationPackedFallbackMesh';
		mesh.frustumCulled = false;
		mesh.scale.set( WGS84_X_RADIUS, WGS84_Y_RADIUS, WGS84_Z_RADIUS );
		mesh.updateMatrix();
		mesh.updateMatrixWorld( true );
		configureAnalyticEllipsoidDepthMesh( mesh );
		return mesh;
	}
}
