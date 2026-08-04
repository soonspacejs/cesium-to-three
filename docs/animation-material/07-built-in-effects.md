# 07. 内置 Ground Material 与动画预设

> 状态：**Proposed Design**。本篇中的 `CesiumGroundMaterial`、六个工厂函数及代码均为拟新增接口；标为 **Current** 的内容才是当前仓库事实。

## 目标

本篇把现有纯色、纹理贴花、折线虚线统一迁移为 `CesiumGroundMaterial`，并在同一接口上定义流动线、呼吸点和局部缩放三个动画预设。实现者应能直接据此确定每个工厂的参数、uniform schema、公式、GLSL3 源码、适用管线和错误边界。

前置阅读：

- [05. Shader ABI](./05-shader-abi.md)：`c23_materialInput`、`c23_material`、坐标空间与最终输出规则。
- [06. 渲染管线接入](./06-render-pipeline-integration.md)：Material 在各 pass 中的注入位置。

非目标：

- 不提供 timeline、tween、关键帧、动画序列化、暂停队列或内部 `requestAnimationFrame`。
- 不改变 Ground 几何、包围盒、拾取范围或 shadow volume 高度窗口。
- 不用 Material 绕过深度重建、shape 裁切、stencil 清理、RTE 或 log depth。
- 首期不接入 TSL/NodeMaterial；源码为 WebGLRenderer + GLSL3。

## 1. 基线与设计过程

### 1.1 源码基线

本文行号以以下只读快照为准：

| 仓库 | 本地路径 | 提交 |
| --- | --- | --- |
| 当前项目 | `D:\my\code\cesium-to-three` | `32a6b244b7c0cb731ca35165c46e8fe31248c718` |
| Three | `D:\my\explore\three.js` | `2a005fdbad6b8503a8a70edfdd279b79c5e04b49` |
| Cesium | `D:\my\explore\cesium` | `effe290c08dc340a7a6bd4435367a7d092c6b2b9` |

**Current 证据：**

- 折线的颜色与虚线仍在主片元 Shader 内处理：`src/lib/ground/materials.ts:1383-1399`；虚线间隔通过 `discard` 实现。折线 pass 本身无 stencil，见同文件 `1421-1454`。
- 文字/图片贴花已经在透明纹素处输出 `vec4(0.0)` 而非 `discard`，从而让 color pass 的 `ZeroStencilOp` 执行，见 `src/lib/ground/materials.ts:959-975`；其固定 render state 见 `1026-1068`。
- 图片纹理统一使用 straight alpha、`flipY=false`、sRGB 标记与 mipmap，见 `src/lib/ground/image/image-texture-cache.ts:79-90`；文字 CanvasTexture 采用相同方向约定，见 `src/lib/ground/text/text-primitive.ts:277-303`。
- 当前 `CesiumGroundFrameState` 只有深度、视口、相机和可选分类深度，没有时间字段，见 `src/lib/ground/types.ts:404-428`。
- Cesium 也把虚线实现成材质函数而不是改变折线几何：`packages/engine/Source/Shaders/Materials/PolylineDashMaterial.glsl:18-37`；内置类型注册位于 `packages/engine/Source/Scene/Material.js:1768-1780`。
- Three 的 `ShaderMaterial.uniforms` 是稳定容器，复制时由 uniform clone 逻辑处理，见 `src/materials/ShaderMaterial.js:113-120, 285-286`；program key 单独纳入 `customProgramCacheKey`，见 `src/renderers/webgl/WebGLPrograms.js:384, 434`。因此动画值不能进入 program key。

### 1.2 从现状到预设的推导

1. 先把当前三种默认视觉行为写成 `createColorGroundMaterial`、`createTexturedDecalMaterial`、`createPolylineDashMaterial`，完成等价迁移。
2. 动画只增加 `c23_time` 的读取和用户 uniform；Shader 源码、defines 与 uniform 名集合在播放期间保持不变。
3. 所有 `c23_getMaterial` 返回 **straight alpha**。框架统一计算 `rgb = (diffuse + emission) * alpha` 并输出预乘色。
4. 安全 Material 不调用 `discard`。尤其在 surface/decal classification color pass 中，零 alpha 仍必须走到最终输出，才能清除 stencil。
5. 视觉缩放只能发生在预分配 footprint 内；若业务要求边界、包围盒或拾取一起扩大，应重建图元而不是修改 Material。

## 2. 所有工厂共享的契约

### 2.1 Proposed API 约定

以下是说明签名的 **Proposed API 摘要**；完整导出定义以 [04. 公共 API](./04-public-api-design.md) 为事实源。

```ts
// Proposed API 摘要
type GroundColorInput = ColorRepresentation | Vector4;

function createColorGroundMaterial(options?: ColorGroundMaterialOptions): CesiumGroundMaterial;
function createTexturedDecalMaterial(options: TexturedDecalMaterialOptions): CesiumGroundMaterial;
function createPolylineDashMaterial(options?: PolylineDashMaterialOptions): CesiumGroundMaterial;
function createFlowLineMaterial(options?: FlowLineMaterialOptions): CesiumGroundMaterial;
function createPulsePointMaterial(options?: PulsePointMaterialOptions): CesiumGroundMaterial;
function createScalePulseMaterial(options?: ScalePulseMaterialOptions): CesiumGroundMaterial;
```

颜色在工厂入口解析成线性 `Vector4` uniform；本组 API 的 opacity 都是 `[0, 1]`，不要与现有图元 `strokeOpacity/fillOpacity` 的 `[0, 100]` 百分比口径混用。需要显式 alpha（例如透明背景）时使用 `new Vector4(r, g, b, a)`。

### 2.2 稳定性规则

| 操作 | 是否换 program | 说明 |
| --- | --- | --- |
| `material.setUniform(name, value)`，名称已存在 | 否 | 原地改对应 `IUniform.value`；不能设置 `needsUpdate` |
| 改 `c23_time`、`c23_deltaTime`、`c23_frameNumber` | 否 | system uniform 每帧原地写入 |
| 替换 `fragmentShader` 或 `defines` | 是 | 设置 `material.needsUpdate = true`，只重建受影响 pass |
| 增删 uniform 名或改变 GLSL 类型 | 是 | 属于 schema 变化；设置 `needsUpdate = true` |
| 多个图元共享同一逻辑 Material | 通常否 | uniform 也共享；独立相位使用 `clone()` |

所有工厂在构造时完成范围校验和规范化；播放期间不拼 Shader 字符串、不增删 uniform、不创建 Texture、不启动渲染循环。

### 2.3 ABI 最小假设

下列 struct 与 system uniform 由 assembler 提供，预设源码不得重复声明：

```glsl
struct c23_materialInput {
    vec2 st;
    vec2 localMeters;
    vec4 baseColor;
    float isStroke;
    vec3 positionEC;
    vec3 positionToEyeEC;
    vec3 normalEC;
    float distanceAlongMeters;
    float distanceAcrossMeters;
    float lineTotalMeters;
    float metersPerPixel;
};

struct c23_material {
    vec3 diffuse;
    vec3 emission;
    float alpha;
};

uniform float c23_time;
uniform float c23_deltaTime;
uniform float c23_frameNumber;
```

不适用于当前 primitive kind 的字段由 assembler 初始化为零，不能依赖未定义值。下面所有源码都是交给 `CesiumGroundMaterial.fragmentShader` 的完整材质片段。

所有 safe `CesiumGroundMaterial` 在类型层面都可编译到四种 kind，API 不增加 `supportedKinds` 元数据，也不因 preset 名称做隐式拒绝。下文“适用范围”表示有明确视觉语义、纳入验收的**推荐管线**；把预设用于其他 kind 时，缺失输入按零值计算，结果虽确定但不承诺有业务意义。`GROUND_APPEARANCE_INCOMPATIBLE` 只处理无效 Appearance 实现/slot/pass 结构，不用于拒绝内置或自定义 safe Material 的 kind。

## 3. 默认材质一：`createColorGroundMaterial`

### 3.1 目的与适用范围

这是 surface、无虚线 polyline、无纹理 arrow 和无纹理 decal 的基础材质。默认白色乘数使结果严格沿用 `input.baseColor`，因此 fill/stroke 的选择仍由库完成。适用 `C23_SURFACE`、`C23_POLYLINE`、`C23_DECAL`、`C23_ARROW`。

```ts
// Proposed API
interface ColorGroundMaterialOptions {
  /** 对 input.baseColor 的 RGB 乘数。默认 0xffffff。 */
  color?: ColorRepresentation;
  /** 对 input.baseColor.a 的乘数。默认 1。 */
  opacity?: number;
}
```

### 3.2 uniform 表

| uniform | GLSL 类型 | 默认值 | 合法范围 | 运行期含义 |
| --- | --- | --- | --- | --- |
| `u_color` | `vec4` | `(1, 1, 1, 1)` | RGB 非负；A `[0,1]` | `rgb=color`，`a=opacity`；整体乘 `input.baseColor` |

公式：

```text
straightColor = clamp(input.baseColor, 0, 1) * clamp(u_color, 0, 1)
diffuse       = straightColor.rgb
emission      = 0
alpha         = straightColor.a
```

### 3.3 GLSL3

```glsl
uniform vec4 u_color;

c23_material c23_getMaterial(c23_materialInput input) {
    vec4 straightColor = clamp(input.baseColor, 0.0, 1.0)
        * clamp(u_color, 0.0, 1.0);

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = straightColor.a;
    return material;
}
```

### 3.4 TypeScript 用例

```ts
// Proposed API 示例
const highlight = createColorGroundMaterial({
  color: 0xffcc66,
  opacity: 0.75,
});

const appearance = new CesiumGroundMaterialAppearance({ material: highlight });
const polygon = new CesiumGroundPolygonPrimitive({
  ...polygonOptions,
  appearance,
});

// 只改值：不重建几何、不换 Shader、不增加 program。
highlight.setUniform('u_color', new Vector4(1.0, 0.4, 0.1, 0.5));
```

边界：该颜色是乘数而非替换 shape 颜色。若要完全接管 fill/stroke，可在自定义 `c23_getMaterial` 中根据 `input.isStroke` 返回独立颜色。

## 4. 默认材质二：`createTexturedDecalMaterial`

### 4.1 目的与适用范围

该材质替代当前文字/图片专用字符串注入，只用于 `C23_DECAL`。它保留当前 `st.y` 翻转、straight-alpha 纹理和总 opacity 行为；透明纹素返回零 alpha，**禁止 `discard`**。

```ts
// Proposed API
interface TexturedDecalMaterialOptions {
  texture: Texture;
  opacity?: number;              // 默认 1
  tint?: ColorRepresentation;    // 默认 0xffffff
  flipY?: boolean;               // 默认 true；映射为 1/0 uniform
}
```

### 4.2 uniform 表

| uniform | 类型 | 默认值 | 合法范围/所有权 |
| --- | --- | --- | --- |
| `u_texture` | `sampler2D` | 必填 `Texture` | borrowed；Material/Primitive 不销毁用户 Texture |
| `u_opacity` | `float` | `1.0` | `[0,1]` |
| `u_tint` | `vec4` | `(1,1,1,1)` | RGB/A 乘数；A 默认 1 |
| `u_flipY` | `float` | `1.0` | 工厂把 `true/false` 规范化为 `1/0` |

当前文字和图片纹理本身设置 `texture.flipY=false`，材质默认 `u_flipY=1` 完成唯一一次 V 翻转。若用户纹理已经在上传阶段翻转，则传 `flipY:false`。

### 4.3 GLSL3

```glsl
uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_tint;
uniform float u_flipY;

c23_material c23_getMaterial(c23_materialInput input) {
    vec2 sampleSt = input.st;
    if (u_flipY > 0.5) {
        sampleSt.y = 1.0 - sampleSt.y;
    }

    vec4 texel = texture(u_texture, sampleSt);
    vec4 straightColor = texel * clamp(u_tint, 0.0, 1.0);
    straightColor.a *= clamp(u_opacity, 0.0, 1.0);

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = clamp(straightColor.a, 0.0, 1.0);
    return material;
}
```

最终 assembler 对 `alpha == 0` 仍写 `vec4(0)`；classification color pass 因而会执行 stencil zero 操作。纹理 RGB 的色彩空间转换首期保持当前 RawShaderMaterial 行为，不额外插入 tone mapping 或 sRGB decode。

### 4.4 TypeScript 用例

```ts
// Proposed API 示例；texture 的创建与销毁都由业务负责。
const texture = new TextureLoader().load('/markers/command.png');
texture.flipY = false;

const decal = createTexturedDecalMaterial({
  texture,
  opacity: 0.8,
  tint: 0xffffff,
  flipY: true,
});

const point = new CesiumGroundPointPrimitive({
  ...imagePointOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: decal }),
});

// point.dispose() 不会 dispose(texture)。
point.dispose();
texture.dispose();
```

限制：`st` 超出 `[0,1]` 的片元是否到达 Material 由外层 decal shape 裁切决定；预设不改变 Texture wrap/filter/mipmap。

## 5. 默认材质三：`createPolylineDashMaterial`

### 5.1 目的与适用范围

该材质把当前 `POLYLINE_FS` 中的硬编码虚线移出主 Shader。推荐且验收的管线是 `C23_POLYLINE`；长度单位全部为米，因而缩放和帧率都不会改变虚线节奏。跨 kind 编译不会抛错，但沿线距离为零时没有有用的虚线语义。

```ts
// Proposed API
interface PolylineDashMaterialOptions {
  color?: ColorRepresentation; // 默认 0xffffff，乘 input.baseColor
  opacity?: number;             // 默认 1
  dashLengthMeters?: number;    // 默认 16
  gapLengthMeters?: number;     // 默认 8
  offsetMeters?: number;        // 默认 0，可正可负
}
```

### 5.2 uniform 与公式

| uniform | 类型 | 默认值 | 校验 |
| --- | --- | --- | --- |
| `u_color` | `vec4` | `(1,1,1,1)` | A `[0,1]` |
| `u_dashLengthMeters` | `float` | `16.0` | 有限且 `> 0` |
| `u_gapLengthMeters` | `float` | `8.0` | 有限且 `>= 0`；为 0 时退化为实线 |
| `u_offsetMeters` | `float` | `0.0` | 任意有限米值 |

```text
period   = dashLengthMeters + gapLengthMeters
phase    = positiveModulo(distanceAlongMeters + offsetMeters, period)
coverage = phase <= dashLengthMeters ? 1 : 0
alpha    = input.baseColor.a * u_color.a * antialiased(coverage)
```

增加 `u_offsetMeters` 只移动相位；若业务每帧更新它也仍是 uniform 动画，但官方流动效果应优先使用下一节的无界时间公式。

### 5.3 GLSL3

```glsl
uniform vec4 u_color;
uniform float u_dashLengthMeters;
uniform float u_gapLengthMeters;
uniform float u_offsetMeters;

c23_material c23_getMaterial(c23_materialInput input) {
    float dashLength = max(u_dashLengthMeters, 1e-6);
    float gapLength = max(u_gapLengthMeters, 0.0);
    float period = dashLength + gapLength;
    float rawPhase = mod(input.distanceAlongMeters + u_offsetMeters, period);
    float phase = mod(rawPhase + period, period);

    float coverage = 1.0;
    if (gapLength > 0.0) {
        float aa = max(fwidth(input.distanceAlongMeters), 1e-4);
        coverage = 1.0 - smoothstep(dashLength - aa, dashLength + aa, phase);
    }

    vec4 straightColor = clamp(input.baseColor, 0.0, 1.0)
        * clamp(u_color, 0.0, 1.0);

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = straightColor.a * coverage;
    return material;
}
```

### 5.4 TypeScript 用例

```ts
// Proposed API 示例
const dashed = createPolylineDashMaterial({
  dashLengthMeters: 24,
  gapLengthMeters: 12,
  offsetMeters: 0,
});

const line = new CesiumGroundPolylinePrimitive({
  ...lineOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: dashed }),
});

// 可交互调相位；不会切换 program。
dashed.setUniform('u_offsetMeters', 6);
```

限制：折线接缝必须提供全线连续的 `distanceAlongMeters`；不能回退到“每段从零开始”，否则每个 segment 都会重启 dash。

## 6. 动画预设一：`createFlowLineMaterial`

### 6.1 参数、默认值与方向

推荐且验收的管线是 `C23_POLYLINE`。一个 repeat cell 内有一个亮头和长度为 `trailFraction` 的拖尾；其余部分显示 `backgroundColor`，默认完全透明。跨 kind 编译仍合法，但距离输入为零时不承诺流线视觉。

```ts
// Proposed API
interface FlowLineMaterialOptions {
  texture?: Texture;                  // 可选 borrowed strip texture
  color?: ColorRepresentation;       // 默认 0x00ffff
  opacity?: number;                   // 默认 1
  backgroundColor?: GroundColorInput; // 默认 new Vector4(0, 0, 0, 0)
  speed?: number;                     // 默认 1，cycles/second
  repeat?: number;                    // 默认 1，全线重复次数
  trailFraction?: number;             // 默认 0.35，每个 cell 的比例
  direction?: number;                 // 默认 +1；工厂规范化为 +1/-1
  flipY?: boolean;                    // 默认 true
}
```

| uniform | 类型 | 默认值 | 校验和单位 |
| --- | --- | --- | --- |
| `u_texture` / `u_hasTexture` | `sampler2D` / `float` | `null` / `0` | borrowed；有纹理时按 cell phase 滚动采样 |
| `u_color` | `vec4` | `(0,1,1,1)` | 拖尾头部 straight RGBA |
| `u_backgroundColor` | `vec4` | `(0,0,0,0)` | 允许透明；不会触发 discard |
| `u_speed` | `float` | `1.0` | 有限且 `>=0`，单位 **cycles/second** |
| `u_repeat` | `float` | `1.0` | 有限且 `>0`，全线 cell 数，可为非整数 |
| `u_trailFraction` | `float` | `0.35` | `(0,1]` |
| `u_direction` | `float` | `1.0` | 输入 `<0` 规范化为 `-1`，输入 `>=0` 规范化为 `+1` |
| `u_flipY` | `float` | `1.0` | 图片 V 方向 |

`u_phase` 不在此预设中；官方 FlowLine 预设在同一宿主时钟下同步。业务需要逐线起始相位时，应复制本节公式并创建显式含 phase uniform 的自定义 Material，不能靠逐图元篡改 system `c23_time`，也不能仅靠 `clone()` 凭空得到未声明的 uniform。

### 6.2 公式

```text
along01 = distanceAlongMeters / lineTotalMeters
orientedAlong = direction > 0 ? along01 : 1 - along01
cellPhase = fract(orientedAlong * repeat - c23_time * speed)
distanceBehindHead = fract(-cellPhase)
intensity = 1 - smoothstep(trailFraction - aa,
                           trailFraction + aa,
                           distanceBehindHead)
straightColor = mix(backgroundColor, color, intensity)
```

`c23_time` 是秒，公式不读取 `deltaTime` 或 `frameNumber`，因此 30/60/120 FPS 在相同绝对时间得到相同结果。

### 6.3 GLSL3

```glsl
uniform sampler2D u_texture;
uniform float u_hasTexture;
uniform vec4 u_color;
uniform vec4 u_backgroundColor;
uniform float u_speed;
uniform float u_repeat;
uniform float u_trailFraction;
uniform float u_direction;
uniform float u_flipY;

c23_material c23_getMaterial(c23_materialInput input) {
    float along01 = input.lineTotalMeters > 1e-6
        ? clamp(input.distanceAlongMeters / input.lineTotalMeters, 0.0, 1.0)
        : clamp(input.st.x, 0.0, 1.0);
    float direction = u_direction < 0.0 ? -1.0 : 1.0;
    float orientedAlong = direction > 0.0 ? along01 : 1.0 - along01;
    float cellPhase = fract(
        orientedAlong * max(u_repeat, 1e-6)
        - c23_time * max(u_speed, 0.0)
    );
    float distanceBehindHead = fract(-cellPhase);
    float trail = clamp(u_trailFraction, 1e-4, 1.0);
    float aa = max(fwidth(cellPhase), 1e-4);
    float intensity = 1.0 - smoothstep(
        max(trail - aa, 0.0),
        min(trail + aa, 1.0),
        distanceBehindHead
    );

    vec4 foregroundColor = clamp(u_color, 0.0, 1.0);
    float textureCoverage = 1.0;
    if (u_hasTexture > 0.5) {
        vec2 textureUv = vec2(cellPhase, clamp(input.st.y, 0.0, 1.0));
        if (u_flipY > 0.5) textureUv.y = 1.0 - textureUv.y;
        vec4 texel = clamp(texture(u_texture, textureUv), 0.0, 1.0);
        foregroundColor.rgb *= texel.rgb;
        textureCoverage = texel.a;
    }

    vec4 straightColor = mix(
        clamp(u_backgroundColor, 0.0, 1.0),
        foregroundColor,
        intensity * textureCoverage
    );

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = straightColor.a;
    return material;
}
```

### 6.4 TypeScript 与宿主时钟

```ts
// Proposed API 示例
const flow = createFlowLineMaterial({
  color: 0x33ddff,
  opacity: 0.9,
  backgroundColor: new Vector4(0.02, 0.08, 0.12, 0.15),
  speed: 0.6,          // 每秒 0.6 cycle
  repeat: 4,
  trailFraction: 0.3,
  direction: -1,
});

const line = new CesiumGroundPolylinePrimitive({
  ...lineOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: flow }),
});

// 这是宿主已有帧回调，不是库内部 RAF。
const clock = new Clock();
let timeSeconds = 0;
let frameNumber = 0;

function onHostFrame(baseState: Omit<CesiumGroundFrameState,
  'timeSeconds' | 'deltaSeconds' | 'frameNumber'>): void {
  const deltaSeconds = clock.getDelta();
  timeSeconds += deltaSeconds;
  line.update({ ...baseState, timeSeconds, deltaSeconds, frameNumber: frameNumber++ });
}
```

性能与限制：无纹理路径每片元主要增加 `fract`、一次 `fwidth` 和一次 `smoothstep`；图片路径再增加一次采样，并以纹理 RGB/alpha 调制移动拖尾。极长运行时间下 WebGL float 的秒值会逐渐损失亚毫秒精度，宿主可把时钟定义为“本次效果启动后的秒数”。方向和速度不能通过每帧改 Shader define 实现。

## 7. 动画预设二：`createPulsePointMaterial`

### 7.1 参数与 footprint 约束

适用于 `C23_SURFACE` 或无纹理 `C23_DECAL` 的填充点，推荐 `CesiumGroundPointPrimitive({ shape:'circle' })` 且 `strokeWidth:0`。`maxScale` 可以大于 1，但图元实际 footprint 必须按 `u_footprintScale` 预分配；Shader 只把名义视觉半径归一化进该 footprint，绝不会自行扩大几何。

```ts
// Proposed API
interface PulsePointMaterialOptions {
  texture?: Texture;            // 可选 borrowed image
  color?: ColorRepresentation; // 默认 0xffffff，乘 input.baseColor
  periodSeconds?: number;       // 默认 1.5
  minScale?: number;            // 默认 0.65
  maxScale?: number;            // 默认 1.0，可 >1；不得超过预分配 footprintScale
  minOpacity?: number;          // 默认 0.25
  maxOpacity?: number;          // 默认 1.0
  phase?: number;               // 默认 0，单位 cycles
  edgeSoftness?: number;        // 默认 0.02，footprint 半径归一化单位
  footprintScale?: number;      // 高级；默认 max(1, maxScale)
  flipY?: boolean;              // 默认 true
}
```

| uniform | 类型 | 默认值 | 校验/语义 |
| --- | --- | --- | --- |
| `u_texture` / `u_hasTexture` | `sampler2D` / `float` | `null` / `0` | borrowed；有图时随 pulse 尺度反向采样 |
| `u_color` | `vec4` | `(1,1,1,1)` | 乘 `input.baseColor` |
| `u_periodSeconds` | `float` | `1.5` | 有限且 `>0` |
| `u_minScale` | `float` | `0.65` | `0 < minScale <= maxScale` |
| `u_maxScale` | `float` | `1.0` | `>0`；相对名义视觉半径 |
| `u_minOpacity` | `float` | `0.25` | `[0,1]` 且 `<= maxOpacity` |
| `u_maxOpacity` | `float` | `1.0` | `[0,1]` |
| `u_phase` | `float` | `0.0` | 有限，单位 **cycles**；`0.25` 为四分之一周期 |
| `u_edgeSoftness` | `float` | `0.02` | `[0,0.5]`；与导数 AA 取较大者 |
| `u_footprintScale` | `float` | `max(1, maxScale)` | 有限且 `>=maxScale`；实际 footprint / 名义 footprint |
| `u_flipY` | `float` | `1.0` | 图片 V 方向 |

视觉半径为 `nominalRadius * currentScale`，其中 `actualFootprintRadius = nominalRadius * u_footprintScale`，Shader 使用 `normalizedRadius = currentScale / u_footprintScale`。例如名义直径 64 m、`maxScale=1.25` 时，point `size` 必须预分配为 80 m；视觉直径最大 80 m，刚好到 footprint 边界，不会扩大包围盒或拾取范围。

### 7.2 公式与 GLSL3

```text
phase01       = fract(c23_time / periodSeconds + phase)
wave          = 0.5 - 0.5 * cos(2π * phase01)
currentScale  = mix(minScale, maxScale, wave)
normalizedScale = currentScale / footprintScale
currentAlpha  = mix(minOpacity, maxOpacity, wave)
radius01      = length((st - 0.5) * 2)
coverage      = radialSmoothMask(radius01, normalizedScale)
```

```glsl
uniform sampler2D u_texture;
uniform float u_hasTexture;
uniform vec4 u_color;
uniform float u_periodSeconds;
uniform float u_minScale;
uniform float u_maxScale;
uniform float u_minOpacity;
uniform float u_maxOpacity;
uniform float u_phase;
uniform float u_edgeSoftness;
uniform float u_footprintScale;
uniform float u_flipY;

c23_material c23_getMaterial(c23_materialInput input) {
    const float twoPi = 6.283185307179586;
    float phase01 = fract(
        c23_time / max(u_periodSeconds, 1e-6) + u_phase
    );
    float wave = 0.5 - 0.5 * cos(twoPi * phase01);
    float requestedScale = max(mix(u_minScale, u_maxScale, wave), 1e-4);
    float footprintScale = max(u_footprintScale, 1e-6);
    float normalizedScale = clamp(requestedScale / footprintScale, 1e-4, 1.0);
    float opacity = clamp(mix(u_minOpacity, u_maxOpacity, wave), 0.0, 1.0);
    vec2 sourceSt = (input.st - vec2(0.5)) / normalizedScale + vec2(0.5);

    float radius01 = length((input.st - vec2(0.5)) * 2.0);
    float edge = max(
        max(clamp(u_edgeSoftness, 0.0, 0.5), fwidth(radius01)),
        1e-5
    );
    float coverage = 1.0 - smoothstep(
        max(normalizedScale - edge, 0.0),
        normalizedScale,
        radius01
    );

    vec4 sourceColor = clamp(input.baseColor, 0.0, 1.0);
    if (u_hasTexture > 0.5) {
        vec2 sampleSt = sourceSt;
        if (u_flipY > 0.5) sampleSt.y = 1.0 - sampleSt.y;
        sourceColor = clamp(texture(u_texture, sampleSt), 0.0, 1.0);
    }
    vec4 straightColor = sourceColor
        * clamp(u_color, 0.0, 1.0);

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = straightColor.a * opacity * coverage;
    return material;
}
```

### 7.3 TypeScript 用例

```ts
// Proposed API 示例
const pulse = createPulsePointMaterial({
  color: 0xff5533,
  periodSeconds: 1.2,
  minScale: 0.55,
  maxScale: 1.25,
  minOpacity: 0.2,
  maxOpacity: 0.95,
  phase: 0.25, // cycles
});

const nominalSize = 64;
const footprintScale = 1.25; // 默认由 maxScale 推导，也可显式预留更大上限

const point = new CesiumGroundPointPrimitive({
  position: [116.391, 39.907],
  shape: 'circle',
  size: nominalSize * footprintScale, // 80 m：最大视觉直径/实际 footprint
  fillColor: '#ffffff',
  fillOpacity: 100,
  strokeColor: '#ffffff',
  strokeWidth: 0,
  strokeOpacity: 0,
  visible: true,
  appearance: new CesiumGroundMaterialAppearance({ material: pulse }),
});
```

性能与限制：无纹理路径每片元一次 `cos`；图片路径再增加一次采样。运行期 `u_minScale/u_maxScale` 不得超过构造时预留的 `u_footprintScale`，否则应重建图元。Material 只裁掉外部 alpha，不能把当前 shape 阶段算出的描边重新定位到缩放后的半径，所以不承诺“会随呼吸移动的 stroke”。需要描边呼吸时应在自定义 Material 中自行画径向 ring，或使用 Raw Appearance。

## 8. 动画预设三：`createScalePulseMaterial`

### 8.1 语义与参数

该预设围绕 `st=(0.5,0.5)` 反向变换采样坐标，适用于 `C23_DECAL`，也可用于无纹理的矩形/方形填充。它实现的是局部 UV 视觉缩放，不修改顶点。

```ts
// Proposed API
interface ScalePulseMaterialOptions {
  texture?: Texture;                 // 默认无纹理，使用 input.baseColor
  tint?: ColorRepresentation;        // 默认 0xffffff
  opacity?: number;                  // 默认 1
  periodSeconds?: number;            // 默认 1.5
  minScale?: number;                 // 默认 0.75，名义尺寸倍数
  maxScale?: number;                 // 默认 1.0，名义尺寸倍数
  phase?: number;                    // 默认 0，cycles
  edgeSoftness?: number;             // 默认 0.01，source UV 单位
  flipY?: boolean;                   // 默认 true
  footprintScale?: number;           // 高级；默认 max(1, maxScale)
}
```

### 8.2 uniform 表与预分配算法

| uniform | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `u_texture` | `sampler2D` | `null`/Three fallback texture | borrowed；仅 `u_hasTexture=1` 时读取 |
| `u_hasTexture` | `float` | 有纹理 `1`，否则 `0` | uniform 分支，不能改成 define，以保持同一 Shader schema |
| `u_tint` | `vec4` | `(1,1,1,1)` | 纹理或 `input.baseColor` 的乘数 |
| `u_opacity` | `float` | `1.0` | `[0,1]` |
| `u_periodSeconds` | `float` | `1.5` | `>0` 秒 |
| `u_minScale` | `float` | `0.75` | `0 < minScale <= maxScale`，相对名义尺寸 |
| `u_maxScale` | `float` | `1.0` | `>0`，相对名义尺寸 |
| `u_phase` | `float` | `0.0` | cycles |
| `u_edgeSoftness` | `float` | `0.01` | `[0,0.5]` source-UV 单位 |
| `u_flipY` | `float` | `1.0` | boolean 规范化为 `1/0` |
| `u_footprintScale` | `float` | `max(1, maxScale)` | 构造期记录“实际 footprint / 名义 footprint” |

预分配是接口正确性的组成部分：

```text
footprintScale   = max(1, maxScaleAtConstruction)
geometryWidth    = nominalWidth  * footprintScale
geometryHeight   = nominalHeight * footprintScale
normalizedScale  = currentScale / footprintScale
sourceSt         = (input.st - 0.5) / normalizedScale + 0.5
```

因此名义 24 m 图标、`maxScale=1.3` 应创建 31.2 m 的 footprint；当 `currentScale=1` 时，内容仍是 24 m，当 `currentScale=1.3` 时正好填满 31.2 m。运行期可改 `u_minScale/u_maxScale`，但新值不得超过已经分配的 `u_footprintScale`；超过时必须重建 Ground 图元。

### 8.3 GLSL3

```glsl
uniform sampler2D u_texture;
uniform float u_hasTexture;
uniform vec4 u_tint;
uniform float u_opacity;
uniform float u_periodSeconds;
uniform float u_minScale;
uniform float u_maxScale;
uniform float u_phase;
uniform float u_edgeSoftness;
uniform float u_flipY;
uniform float u_footprintScale;

c23_material c23_getMaterial(c23_materialInput input) {
    const float twoPi = 6.283185307179586;
    float phase01 = fract(
        c23_time / max(u_periodSeconds, 1e-6) + u_phase
    );
    float wave = 0.5 - 0.5 * cos(twoPi * phase01);
    float requestedScale = mix(u_minScale, u_maxScale, wave);
    float footprintScale = max(u_footprintScale, 1e-6);
    float normalizedScale = clamp(requestedScale / footprintScale, 1e-4, 1.0);
    vec2 sourceSt = (input.st - vec2(0.5)) / normalizedScale + vec2(0.5);

    float edgeDistance = min(
        min(sourceSt.x, 1.0 - sourceSt.x),
        min(sourceSt.y, 1.0 - sourceSt.y)
    );
    float derivativeWidth = max(fwidth(sourceSt.x), fwidth(sourceSt.y));
    float edge = max(
        max(clamp(u_edgeSoftness, 0.0, 0.5), derivativeWidth),
        1e-5
    );
    float coverage = smoothstep(0.0, edge, edgeDistance);

    vec4 sourceColor = input.baseColor;
    if (u_hasTexture > 0.5) {
        vec2 sampleSt = sourceSt;
        if (u_flipY > 0.5) {
            sampleSt.y = 1.0 - sampleSt.y;
        }
        sourceColor = texture(u_texture, sampleSt);
    }

    vec4 straightColor = sourceColor * clamp(u_tint, 0.0, 1.0);
    straightColor.a *= clamp(u_opacity, 0.0, 1.0) * coverage;

    c23_material material;
    material.diffuse = straightColor.rgb;
    material.emission = vec3(0.0);
    material.alpha = clamp(straightColor.a, 0.0, 1.0);
    return material;
}
```

### 8.4 TypeScript 用例

```ts
// Proposed API 示例：名义尺寸 24 m，最大放大到 1.3 倍。
const nominalSize = 24;
const maxScale = 1.3;
const scalePulse = createScalePulseMaterial({
  tint: 0x66aaff,
  opacity: 0.9,
  periodSeconds: 1.6,
  minScale: 0.8,
  maxScale,
  phase: 0,
});

const point = new CesiumGroundPointPrimitive({
  position: [116.391, 39.907],
  shape: 'square',
  size: nominalSize * maxScale, // 预分配最大 footprint
  fillColor: '#ffffff',
  fillOpacity: 100,
  strokeColor: '#ffffff',
  strokeWidth: 0,
  strokeOpacity: 0,
  visible: true,
  appearance: new CesiumGroundMaterialAppearance({ material: scalePulse }),
});
```

性能与限制：无纹理路径每片元一次 `cos`；纹理路径再增加一次采样。uniform 分支保证有/无纹理共用稳定 Shader。预设不扩大包围盒，不改变 raycast/pick footprint，不重算 ECEF 顶点；矩形 stroke 也不会随局部 UV 一起移动。对真正的几何缩放，应以新尺寸重建 primitive。

## 9. 共享、相位与 request-render

```ts
// Proposed API 示例：共享实例 => 完全同步，clone => uniform 容器独立。
const sharedPulse = createPulsePointMaterial({ periodSeconds: 2 });
const delayedPulse = sharedPulse.clone();
delayedPulse.setUniform('u_phase', 0.5); // 相差半个周期
```

- 共享 `CesiumGroundMaterial` 时 user uniforms 共享，适合大量同步效果并复用 program。
- `clone()` 严格采用 Three `UniformsUtils.clone()` 的值规则：wrapper、Color/Vector/Matrix 与普通 Texture 都产生新对象，RenderTargetTexture 告警并变为 `null`，普通业务对象仍可能保持引用。独立相位只需改 `u_phase`；若希望继续共享某张 Texture，应先释放 clone 自动产生的 Texture 副本，再显式把 cloned uniform 绑定回原 Texture。
- request-render 模式下，库不会主动请求下一帧。宿主检测到可见且活动的 effect 后，应在自己的调度器中持续请求渲染；隐藏、`speed=0` 或业务暂停后可停止请求。
- 缺省 `timeSeconds/deltaSeconds/frameNumber` 都映射为零，所有预设停在确定的静态首帧。

## 10. 关键决策与边界条件

| 决策/边界 | 结果 |
| --- | --- |
| 动画定义 | 稳定 Shader + 动态 uniform；无 timeline/tween/内部 RAF |
| 最终颜色 | `diffuse + emission` 后由框架乘 `alpha`；预设不自行预乘 |
| classification 透明片元 | 返回 `alpha=0`，不得 `discard`，保证 stencil 被 color pass 清零 |
| polyline gap | 同样返回 `alpha=0`；即使无 stencil，也保持 Material 纯函数语义 |
| 时间单位 | `c23_time` 秒；Flow 的 `u_speed` 为 cycles/second；`u_phase` 仅用于 Pulse/Scale，单位 cycles |
| 方向 | 工厂一律规范化为 `+1/-1`，不生成 Shader define |
| 尺寸 | PulsePoint/ScalePulse 最大视觉尺寸不越 footprint；超过 1 时预分配最大 footprint |
| 纹理所有权 | 所有 user Texture 均 borrowed，Material/Primitive 不销毁 |
| 无效参数 | 构造时抛 `RangeError`；`setUniform` 的低层调用由用户维持相同约束 |
| shape 描边 | 安全 Material 得到的是已判定的 `baseColor/isStroke`，不能移动 shape SDF 或描边边界 |

## 11. 验收清单

- [ ] 六个工厂返回的 `fragmentShader` 与 uniform 名集合在时间推进时完全不变。
- [ ] `createColorGroundMaterial` 在默认参数下与现有 fill/stroke 视觉一致。
- [ ] `createTexturedDecalMaterial` 与现有文字/图片方向、alpha 和 opacity 一致；透明纹素不 `discard`。
- [ ] `createPolylineDashMaterial` 使用全线米距离，跨 segment 相位连续。
- [ ] FlowLine 的 `speed=1` 精确表示每秒一 cycle；相同 `c23_time` 在不同 FPS 下结果一致。
- [ ] FlowLine/PulsePoint/ScalePulse 的有图与无图实例共用各自固定 Shader schema，纹理均为 borrowed。
- [ ] PulsePoint/ScalePulse 允许 `maxScale>1`，但 `u_footprintScale>=u_maxScale` 且实际 footprint 已按该倍率预分配。
- [ ] ScalePulse 的 `u_footprintScale` 与预分配尺寸一致，运行期不越界。
- [ ] 所有 opacity 为零时仍执行 surface/decal color pass 的 stencil 清理。
- [ ] uniform 值连续更新 600 帧时 `renderer.info.programs` 不增长。
- [ ] 无预设启动 RAF、定时器或 request-render；宿主缺省不传时间时画面静止。
- [ ] primitive/逻辑 Material 的 `dispose()` 都不越权销毁 factory 参数中的 Texture；clone 产生的普通 Texture 副本由 clone 调用方释放，完整语义符合 [08](./08-lifecycle-cache-resources.md)。

## 结论与导航

内置效果不是独立动画系统，而是六个遵守同一 `c23_getMaterial` ABI 的稳定材质。三个默认材质先保证旧视觉等价，三个动画预设只消费绝对时间和业务 uniform；Geometry/Primitive 仍拥有 footprint、贴地与生命周期。

- 上一篇：[06. 渲染管线接入](./06-render-pipeline-integration.md)
- 下一篇：[08. 生命周期、缓存与资源所有权](./08-lifecycle-cache-resources.md)
- 返回：[文档索引](./README.md)
