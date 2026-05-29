# C4 · 文字 color 材质 —— 复用共享 LOG_DEPTH + CPU-plane 精度管线

> [← C3-extents](./C3-extents.md) | [C5-classification →](./C5-classification.md)

## 职责（修正：对齐最新 jitter-fixed 管线）

最新 `materials.ts` 已重写为 **LOG_DEPTH + CPU-plane uv** 管线（见 `docs/ground-jitter-fix.md`）：VS/FS 经 `wrapShaderMain` 注入 `czm_vertexLogDepth()` / `czm_writeLogDepth()`；片元用 CPU 在 Float64 算出的 `u_cpuWestPlane / u_cpuSouthPlane` 求**抖动免疫**的 planarMeters。

贴地文本贴的是**同一套 shadow volume**，必须 100% 走这条管线，否则远视角 / 倾斜会抖动、深度会和地形错位。所以文字 color 材质**不另起炉灶**，而是作为 `materials.ts` 的一个变体——复用其全部私有 helper（`createVertexPrefix` / `createFragmentPrefix` / `wrapShaderMain` / `combineDefines` / LOG_DEPTH helper / `buildColorVertexShader`），只把纯色 + border 的片元注入换成**纹理采样**。这正是「共享底层」落到代码上的体现。

文字 uv：用 CPU-plane 的 `planarMeters` 归一化（除以足迹米 `u_innerMetersRect.zw`，由 [C3](./C3-extents.md) 写入），得到抖动免疫的 `[0,1]` uv 去采样 `u_textTexture`。

## 对 `materials.ts` 的最小改动（3 处）

### 改动 1 · `createFragmentPrefix` 增加受 define 保护的纹理 sampler

在片元 prefix 的 uniform 声明区追加（只在文字材质生效，不影响 fill/circle/polygon）：

```glsl
#ifdef CESIUM_THREE_TEXT
uniform sampler2D u_textTexture;
#endif
```

具体地，在 `createFragmentPrefix` 里 `uniform float u_circleSectorAngleRadians;` 之后插入上面三行。

### 改动 2 · 新增 `createTextColorFragmentBody()`

与 `createColorFragmentBody()` 并列，注入点同为 `vec4 color = czm_gammaCorrect(v_color);` 行：

```typescript
/**
 * 注入贴地文本的纹理采样分支。与 border 注入同一行 string-replace，
 * 但用 CPU-plane（u_cpuWestPlane / u_cpuSouthPlane）算抖动免疫的 planarMeters，
 * 归一化为 [0,1] uv 后采样 u_textTexture。
 *
 * 复用最新管线的 CPU-plane 路径（与 border 的 planarMeters 同源），
 * 保证文字内容与边缘在小比例尺 / 倾斜视角下不抖动。
 *
 * @returns ShadowVolumeAppearanceFS 注入文字分支后的源码。
 * @throws  注入点未找到（Cesium 源被改动）。
 */
function createTextColorFragmentBody(): string {
	const colorDeclaration = '    vec4 color = czm_gammaCorrect(v_color);';
	const textInjection = /* glsl */ `    vec4 color = czm_gammaCorrect(v_color);
#ifdef CESIUM_THREE_TEXT
#ifdef TEXTURE_COORDINATES
#ifndef SPHERICAL
    // CPU-plane 抖动免疫 planarMeters（与 border 路径同源，Float64 CPU 算出
    // u_cpuWestPlane / u_cpuSouthPlane，避免 v_westPlane 的远视角插值抖动）
    vec3 textEyeCoordinate = eyeCoordinate.xyz / eyeCoordinate.w;
    vec2 textPlanarMeters = vec2(
        czm_planeDistance(u_cpuWestPlane, textEyeCoordinate),
        czm_planeDistance(u_cpuSouthPlane, textEyeCoordinate)
    );
    // 归一化到 [0,1]：足迹米宽/高存于 u_innerMetersRect.zw（见 text-extents）
    vec2 textUv = vec2(
        textPlanarMeters.x / max(u_innerMetersRect.z, 1e-6),
        textPlanarMeters.y / max(u_innerMetersRect.w, 1e-6)
    );
    // 足迹外丢弃（CPU-plane 精度的足迹裁剪）
    if (textUv.x < 0.0 || textUv.x > 1.0 || textUv.y < 0.0 || textUv.y > 1.0) {
        discard;
    }
    // canvas 原点左上、Y 向下；uv 原点 SW、Y 向上 → 翻转 V
    vec4 texel = texture(u_textTexture, vec2(textUv.x, 1.0 - textUv.y));
    // 全透明像素丢弃，避免覆盖底下地形 / 其它贴地图元
    if (texel.a <= 0.0) {
        discard;
    }
    // 颜色空间：CanvasTexture 取样得 sRGB 编码值，与 fill 路径写法一致直接输出。
    // 若该 pass 启用 sRGB 输出编码导致偏亮，改为 czm_gammaCorrect(texel)。
    out_FragColor = texel;
    // 预乘 alpha：classification 在半透明地球上的混合约定（与 fill/border 一致）
    out_FragColor.rgb *= out_FragColor.a;
    return;
#endif
#endif
#endif`;

	const shader = cesiumShadowVolumeAppearanceFS.replace( colorDeclaration, textInjection );
	if ( shader === cesiumShadowVolumeAppearanceFS ) {
		throw new Error( 'Cesium shader patch failed: text color hook was not found.' );
	}
	return shader;
}

/**
 * 包装文字 color 片元 main()，与 fill 一样在末尾注入 czm_writeLogDepth()。
 *
 * @returns LOG_DEPTH 包装后的文字片元源。
 */
function buildTextColorFragmentShader(): string {
	const innerName = 'czm_shadow_volume_text_main_fs';
	const append = ENABLE_LOG_DEPTH ? 'czm_writeLogDepth();' : '';
	const body = createTextColorFragmentBody();

	return ENABLE_LOG_DEPTH
		? wrapShaderMain( body, innerName, append )
		: body;
}
```

### 改动 3 · 新增导出 `createTextColorMaterial()`

```typescript
/**
 * 创建贴地文本 color 命令材质：在 stencil 标记区采样 u_textTexture 贴到地形。
 *
 * 完全复用 fill 材质的共享管线（LOG_DEPTH 顶点包装、CPU-plane 片元、prefix），
 * 仅注入分支换成纹理采样（CESIUM_THREE_TEXT）。render state 与 createColorMaterial
 * 逐字一致，确保文字命令块和 rectangle/circle 命令块在同一不透明渲染列按
 * renderOrder 正确排序、stencil 语义一致。
 *
 * defines：EXTRUDED_GEOMETRY / TEXTURE_COORDINATES / CULL_FRAGMENTS（裁足迹 +
 * 丢弃无地形 fragment）/ PER_INSTANCE_COLOR + FLAT（走简单 color 路径便于注入）/
 * REQUIRES_EC（取 eyeCoordinate 供 CPU-plane）/ CESIUM_THREE_TEXT。
 *
 * @param uniforms     共享 uniforms（须含 u_textTexture，类型见 classification）。
 * @param fragmentCull 是否启用 CULL_FRAGMENTS（建议 true）。
 * @returns            RawShaderMaterial。
 */
export function createTextColorMaterial(
	uniforms: SharedUniforms,
	fragmentCull: boolean,
): RawShaderMaterial {
	const defines = combineDefines( [
		'EXTRUDED_GEOMETRY',
		'TEXTURE_COORDINATES',
		fragmentCull ? 'CULL_FRAGMENTS' : '',
		'PER_INSTANCE_COLOR',
		'FLAT',
		'REQUIRES_EC',
		'CESIUM_THREE_TEXT',
	] );

	const vertexShader = buildColorVertexShader();         // 复用 fill 的顶点包装
	const fragmentShader = buildTextColorFragmentShader(); // 文字专属片元

	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		uniforms,
		vertexShader: `${ createVertexPrefix( defines ) }\n${ vertexShader }`,
		fragmentShader: `${ createFragmentPrefix( defines ) }\n${ fragmentShader }`,
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
		transparent: false,
		blending: CustomBlending,
		blendEquation: AddEquation,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
		toneMapped: false,
	} );

	material.name = 'CesiumGroundTextColorMaterial';
	return material;
}
```

## 类型微调（types.ts）

`SharedUniforms` 增加可选纹理字段，供文字 color 材质消费（fill/circle/polygon 不设它，GL 默认即可；声明被 `#ifdef CESIUM_THREE_TEXT` 保护，不影响它们编译）：

```typescript
export interface SharedUniforms {
	// …… 既有字段不变 ……
	/** 贴地文本内容纹理；仅 CesiumGroundTextPrimitive 设置，其它图元为 null。 */
	u_textTexture?: { value: import('three').Texture | null };
}
```

## 为什么不写成完全独立的 text-material.ts

LOG_DEPTH 的 `wrapShaderMain`、CPU-plane 片元、两段 prefix、`combineDefines`、`ENABLE_LOG_DEPTH` 全是**底层精度管线**（jitter fix 的核心）。这条管线就是你定义的「唯一共享底层」。若 text 自抄一份,任何一次 jitter 调整(深度公式、CPU-plane、clamp 语义)都要两处同步,必然漂移、必然抖动。把文字 color 材质放进 materials.ts 复用同一套 helper,是「文字独立、底层共享」在代码上的正确落点——文字独立的是**几何 / extents / 纹理内容 / 排版 / 摆放**,共享的是**这条 LOG_DEPTH + CPU-plane + RTE 管线**。

stencil 材质（front/back）内容无关，文字直接复用 `createStencilMaterial`（已导出），传文字的 uniforms 子集即可（prefix 声明的 circle/polygon uniform 未设则取 GL 默认，编译运行均正常）。

## 自检

- 文字 uv 用 `u_cpuWestPlane/u_cpuSouthPlane` + `u_innerMetersRect.zw`，与 border 的 planarMeters 同源 → 同等抖动免疫 ✓
- `buildColorVertexShader()` 复用 → LOG_DEPTH 顶点包装一致 ✓
- `buildTextColorFragmentShader()` 末尾 `czm_writeLogDepth()` → 深度写入与 fill / terrain 同公式 ✓
- render state 与 `createColorMaterial` 逐字一致 → 命令块排序 / stencil 语义一致 ✓
- `u_textTexture` 受 `#ifdef CESIUM_THREE_TEXT` 保护 → 不污染其它材质 ✓

---

[← C3-extents](./C3-extents.md) | [C5-classification →](./C5-classification.md)
