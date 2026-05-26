# C5 · `classification.ts` 注入扩展 —— 让文字复用共享 classification

> [← C4-material](./C4-material.md) | [C6-primitive →](./C6-primitive.md)

## 定位（与 circle 完全平行）

circle 的"独立"= 自己的 geometry / extents / options，但**复用共享 `CesiumClassificationPrimitive`**（`CesiumGroundCirclePrimitive` 内部就是 `new CesiumClassificationPrimitive(...)`）。文字同理：独立的是几何 / extents / 材质内容 / 纹理 / 排版 / 摆放，**复用同一个 classification**——因为那条 LOG_DEPTH + CPU-plane + Float64-RTE 的每帧精度更新,正是你定义的"唯一共享底层",绝不该为文字再抄一份(抄了必漂移、必抖动)。

文字与 circle/rectangle/polygon 唯一的渲染差别:color 命令贴的是**纹理**而非纯色。所以只需给 `CesiumClassificationPrimitive` 加一个**最小注入点**:允许调用方传入自定义 color 材质工厂 + 额外 uniform(`u_textTexture`)。stencil 两个命令、每帧精度更新、renderOrder、非拾取层、dispose 全部原样复用。

## 对 `classification.ts` 的最小改动（surgical）

构造器加两个可选参数；其余一字不动。

### 改动 1 · 构造器签名 + 额外 uniform 合并 + color 材质选择

```typescript
// import 区追加：
import type { RawShaderMaterial } from 'three';
import { createColorMaterial, createStencilMaterial, createTextColorMaterial } from './materials';

/**
 * 可选注入：自定义 color 材质工厂 + 要合并进共享 uniforms 的额外条目。
 * 贴地文本用它注入纹理 color 材质与 u_textTexture，其余图元不传 → 行为不变。
 */
export interface ClassificationColorInjection {
	/** 自定义 color 材质工厂；不传则用默认纯色 createColorMaterial。 */
	colorMaterialFactory?: ( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;
	/** 合并进共享 uniforms 的额外条目（如 { u_textTexture: { value: tex } }）。 */
	extraUniforms?: Record<string, { value: unknown }>;
}
```

构造器签名追加第 7 个可选参数（保持向后兼容，circle/rectangle/polygon 调用方完全不变）：

```typescript
	public constructor(
		geometry: BufferGeometry,
		extents: PlanarExtents,
		color: Color,
		alpha: number,
		renderOrder: number,
		fragmentCull: boolean,
		injection?: ClassificationColorInjection,   // ← 新增
	) {
		this.group = new Group();
		this.group.name = 'CesiumClassificationPrimitive';
		this.colorFragmentCull = fragmentCull;

		this.uniforms = {
			// …… 既有 uniforms 初始化全部不变（czm_* / u_southWest / cpu planes /
			//     log depth / circle / polygon 等），原样保留 …………
		};

		// ── 新增:合并注入的额外 uniform(在建材质之前,使三个命令都能引用) ──
		// 例如文字注入 u_textTexture,使 color 材质能采样、dispose 时能找到。
		if ( injection !== undefined && injection.extraUniforms !== undefined ) {
			for ( const key in injection.extraUniforms ) {
				if ( Object.prototype.hasOwnProperty.call( injection.extraUniforms, key ) ) {
					this.uniforms[ key ] = injection.extraUniforms[ key ];
				}
			}
		}

		const frontStencilMaterial = createStencilMaterial(
			this.uniforms, FrontSide, DecrementWrapStencilOp,
			'CesiumClassificationFrontStencilDepthMaterial',
		);
		const backStencilMaterial = createStencilMaterial(
			this.uniforms, BackSide, IncrementWrapStencilOp,
			'CesiumClassificationBackStencilDepthMaterial',
		);

		// ── 改:color 材质用注入工厂,缺省回落到纯色 createColorMaterial ──
		const colorMaterial = injection !== undefined && injection.colorMaterialFactory !== undefined
			? injection.colorMaterialFactory( this.uniforms, fragmentCull )
			: createColorMaterial( this.uniforms, fragmentCull );

		// …… 三个 Mesh 创建、非拾取层、setRenderOrder、group.add 全部不变 ……
	}
```

`setFragmentCulling` 里重建 color 材质处也要尊重注入工厂（否则 toggle culling 会丢失文字材质）。最简做法：把工厂存为字段。

```typescript
	private readonly colorMaterialFactory:
		( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;

	// 构造器内：
	this.colorMaterialFactory =
		injection !== undefined && injection.colorMaterialFactory !== undefined
			? injection.colorMaterialFactory
			: createColorMaterial;

	// setFragmentCulling 内把 createColorMaterial(...) 换成 this.colorMaterialFactory(...)：
	public setFragmentCulling( enabled: boolean ): void {
		if ( this.colorFragmentCull === enabled ) {
			return;
		}
		this.colorFragmentCull = enabled;
		const oldMaterial = this.colorMesh.material as Material;
		this.colorMesh.material = this.colorMaterialFactory( this.uniforms, enabled );
		oldMaterial.dispose();
	}
```

`createColorMaterial` 与 `createTextColorMaterial` 签名一致 `(SharedUniforms, boolean) => RawShaderMaterial`，所以工厂类型统一、可直接互换。

### 改动 2 · `dispose` 不动

`dispose` 已 dispose 三个材质 + 几何。`u_textTexture` 指向的纹理由 `CesiumGroundTextPrimitive`（[C6](./C6-primitive.md)）持有并 dispose——classification 不创建它就不销毁它，职责清晰。

## 文字侧如何调用（预览，详见 C6）

```typescript
import { CesiumClassificationPrimitive } from '../classification';
import { createTextColorMaterial } from '../materials';

const classification = new CesiumClassificationPrimitive(
	textGeometry,        // C2 buildTextShadowVolumeGeometry
	textExtents,         // C3 computeTextPlanarExtents
	new Color( 1, 1, 1 ),// 文字不用纯色，传白占位（u_color 仅 VS 的 v_color 来源）
	1.0,                 // alpha 占位
	renderOrder,
	true,                // fragmentCull：裁到足迹 + 丢弃无地形
	{
		colorMaterialFactory: createTextColorMaterial,
		extraUniforms: { u_textTexture: { value: canvasTexture } },
	},
);
```

每帧 `classification.update(frameState)` 走的就是共享的 jitter-fixed 精度更新（Float64 MVP、cpu planes、log depth uniform、相机 high/low），文字与 rectangle/circle 完全同源。

## 为什么不另写 `CesiumTextClassificationPrimitive` 类

`updateFrameStateUniforms` 是私有的，依赖模块级 Float64 scratch（`viewRotationFloat64` / `projectionFloat64` / `mvpFloat64` / `cpuPlaneScratch`）与多个 Float64 helper。若文字另起一个 classification 类，要么复制这一整套（jitter fix 每次改都两处同步、必漂移），要么把这些全 export 出去（暴露大量内部）。注入点方案只加两个可选参数，**零重复、零行为变更**，且语义上「classification 是共享底层」与你的定性完全吻合——这正是 circle 的做法。

## 自检

- circle/rectangle/polygon 调用方未传 injection → 行为逐字不变 ✓
- 文字注入 color 工厂 + u_textTexture → 复用全部精度更新与 stencil ✓
- `setFragmentCulling` 经工厂字段重建 → 不丢文字材质 ✓
- 纹理生命周期归 C6，classification 不越权 dispose ✓

---

[← C4-material](./C4-material.md) | [C6-primitive →](./C6-primitive.md)
