# 05 · Shader ABI：Material 输入、输出、系统 uniform 与 Raw pass 契约

> 状态：**Proposed Shader ABI v1**（尚未实现）。  
> Current 基线：`D:\my\code\cesium-to-three`，提交 `32a6b244b7c0cb731ca35165c46e8fe31248c718`。  
> ABI 常量：TypeScript `C23_GROUND_SHADER_ABI_VERSION = 1`；GLSL `#define C23_GROUND_SHADER_ABI_VERSION 1`。  
> 导航：[上一篇：04 · 公共 API 设计](./04-public-api-design.md) · [下一篇：06 · 渲染管线集成](./06-render-pipeline-integration.md)

## 目标

1. 给会写 Shader 的用户一份稳定、完整、可测试的 GLSL3 契约。
2. 精确定义 `c23_materialInput` 每个字段的坐标空间、单位、方向、按 kind 的有效值和零值规则。
3. 定义 safe Material 的唯一入口、straight-alpha 输出、统一预乘和 classification stencil 清理规则。
4. 定义 Raw Appearance 能拿到的 attributes、system uniforms、默认 render state 和多 pass 一致性责任。

## 前置阅读

- [03 · 目标架构](./03-target-architecture.md)
- [04 · 公共 API 设计](./04-public-api-design.md)
- Current surface Shader：`src/lib/ground/shaders/shadow-volume-glsl.ts:31-311`
- Current material 组装与状态：`src/lib/ground/materials.ts:64-1737`

## 非目标

- 不提供 timeline、tween、动画曲线对象、内部 clock 或内部 RAF。
- 不承诺 safe Material 可改 vertex transform、depth/stencil/blend state。
- 不允许 safe Material 增加 geometry attributes；首期布局由 primitive 固定。
- 不定义 WebGPU、WGSL、TSL 或 NodeMaterial ABI。
- 不为 Raw Appearance 自动分析三份任意 GLSL 是否数学等价。

## 设计过程

1. 先从 Current surface、polyline、decal、arrow Shader 中枚举用户效果实际需要的数据，并统一其坐标、单位、颜色和缺省值语义。
2. 将 shape/depth/stencil/log-depth 等系统职责留在库模板，只把稳定的 `c23_materialInput` 交给 safe Material，并把用户输出收敛为 `c23_material`。
3. 再为 Raw Appearance 列出逐 pass 的 attribute、system uniform、默认 render state 和多 pass 顶点变换契约，避免把 safe 限制误加到 Raw 路径。
4. 用透明 classification、无效深度、缺失字段、保留字冲突和时间缺省值反向检验 ABI；所有分支都必须有确定输出，不能依赖未初始化 varying。
5. 最后固定 ABI version、kind defines、组装顺序和 compile key 输入，使实现、缓存与测试引用同一份契约。

## 1. ABI 完整声明

### 1.1 assembler 注入的公共前缀

下面代码块是 **Proposed ABI 事实源**。字段顺序、名称和类型属于 v1；实现不得按某个 Material 的“实际使用情况”删字段或留下未初始化值。

```glsl
#define C23_GROUND_SHADER_ABI_VERSION 1

// 每次编译恰好定义其中一个：
// #define C23_SURFACE  1
// #define C23_POLYLINE 1
// #define C23_DECAL    1
// #define C23_ARROW    1

uniform float c23_time;
uniform float c23_deltaTime;
uniform float c23_frameNumber;

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
```

用户源码必须提供且只提供这一表面入口：

```glsl
c23_material c23_getMaterial(c23_materialInput input);
```

### 1.2 最小合法 Material

> **Proposed GLSL 示例：**这是用户 `fragmentShader` 内容，不含 assembler 注入的 `#version`、precision、struct 或 `main()`。

```glsl
c23_material c23_getMaterial(c23_materialInput input) {
    c23_material result;
    result.diffuse = input.baseColor.rgb;
    result.emission = vec3(0.0);
    result.alpha = input.baseColor.a;
    return result;
}
```

## 2. 用户源码边界

### 2.1 允许内容

安全 Material 的 `fragmentShader` 可以包含：

- 用户 uniform 声明；
- 用户常量和 helper 函数；
- 条件预处理 allowlist：`#if`、`#ifdef`、`#ifndef`、`#elif`、`#else`、`#endif`，用于用户 defines 或 `C23_*` kind 宏分支；
- 唯一且签名精确的 `c23_getMaterial` 实现。

### 2.2 禁止内容

安全 Material 源码不得包含：

- `#version`、precision 声明或 fragment output 声明；
- `#include`、`#extension`、`#line`、`#pragma`、`#define`、`#undef` 以及 allowlist 之外的预处理指令；用户宏只能通过 TypeScript `defines` 提供；
- `in` / `out` varyings、`layout(...)` 或 `main()`；
- 自己重声明 ABI structs、时间 uniforms 或 kind macros；
- 写 `gl_FragDepth`、stencil/render state（GLSL 本来也不能直接设置 Three state）；
- `discard`。透明必须返回 `alpha=0.0`，原因见第 7 节。

assembler 必须以 tokenizer/词法扫描而不是简单子串搜索校验，避免把注释中的 `discard`、`main` 误判；违规统一抛 [04](./04-public-api-design.md) 定义的 `CesiumGroundMaterialError`，detail 中包含 material type、kind、token 与 ABI version。

### 2.3 保留标识符

用户 uniform、define、GLSL 顶层函数、struct 和全局变量不得以以下前缀开头：

| 前缀 | owner | 例子 |
| --- | --- | --- |
| `czm_` | Cesium 移植 builtin / automatic uniform | `czm_globeDepthTexture` |
| `c23_` | 本项目 ABI、system uniform、assembler helper | `c23_time` |
| `C23_` | 本项目 ABI / kind / pipeline 宏 | `C23_POLYLINE` |

唯一例外是用户必须实现的 `c23_getMaterial`。大小写敏感；用户自己的名称推荐 `u_*` 与普通 helper 名。Three RawShaderMaterial 的自动名及 exact system key 冲突也必须拒绝，不能通过 merge 顺序覆盖。

Raw Appearance 可以完整替换 Shader，因此不会扫描其源码是否使用保留 helper；但 Raw `uniforms` schema 仍不得使用保留前缀或覆盖 `systemUniforms`，否则 context 无法无歧义合并。

## 3. 时间 uniforms

| GLSL | frame state | 单位 / 规范化 | 缺省 |
| --- | --- | --- | ---: |
| `c23_time` | `timeSeconds` | 宿主时间轴累计秒；任何有限值原样使用 | `0.0` |
| `c23_deltaTime` | `deltaSeconds` | 当前逻辑帧秒；仅有限且 `>=0` 有效 | `0.0` |
| `c23_frameNumber` | `frameNumber` | CPU 对有限且 `>=0` 的值 `floor`，GLSL 以 float 上传 | `0.0` |

时间字段的 Proposed TypeScript 定义见 [04](./04-public-api-design.md#10-cesiumgroundframestate-时间扩展)。当前 frame state 只有 depth/viewport/camera/pixelRatio/classification textures（`src/lib/ground/types.ts:404-428`），所以这三项是新增系统 ABI。

约束：

- 同一逻辑帧中全部 primitive 必须看到宿主提供的同一值；
- Material 不累计 `deltaTime`，不读取 `performance.now()`，也不创建 Clock；
- 暂停时宿主保持 `timeSeconds` 不变并传 `deltaSeconds=0`；
- 内置周期效果优先只读绝对 `c23_time`，从而与帧率无关；
- 时间 uniform wrapper 在构造时创建，以后只原地改 `.value`，永不触发 recompile。

## 4. 坐标与颜色总约定

### 4.1 Eye coordinates（EC）

- 右手眼坐标；eye/camera 位于原点。
- `positionEC` 是 packed depth 重建出的地形或分类目标表面点，不是 shadow-volume box 顶点。
- `positionToEyeEC = -positionEC`，是从表面点指向 eye 的未归一化向量，单位米。
- `normalEC` 在有效表面处是单位法线，并翻转到 `dot(normalEC, positionToEyeEC) >= 0`；若深度邻域不足或退化，严格置 `vec3(0.0)`。
- Material 若要单位视线方向，应自行 `normalize(input.positionToEyeEC)`，但必须先防御零向量。

Current surface 已从 packed depth 重建 `eyeCoordinate`（`src/lib/ground/shaders/shadow-volume-glsl.ts:178-203`），并在需要时以邻接深度求 `normalEC`（同文件 `:156-176,222-227`）；polyline/arrow 也已重建 EC 点（`src/lib/ground/materials.ts:1217-1262,1585-1628`）。Proposed assembler 将这些结果统一写入 ABI。

### 4.2 局部米坐标

`localMeters` 始终是当前 kind 的二维局部平面坐标，单位米；具体轴见第 6 节。它不是经纬度、ECEF XY 或屏幕像素。

### 4.3 颜色

- `baseColor` 是 **straight RGBA**，在当前 Three/renderer working color space 中；RGB 尚未乘 alpha。
- `c23_material.diffuse` 与 `emission` 也是 straight RGB；框架把二者相加。
- `c23_material.alpha` 是 straight alpha。
- 框架不 clamp `diffuse`、`emission` 或 `alpha`；HDR/特殊混合范围由用户负责。
- `baseColor` 不会在框架内自动乘进用户返回值。默认/内置 Material 显式使用它；自定义 Material 可以忽略它。

这条规则避免“双重 alpha”：Current surface、polyline、arrow 都在输出前乘一次 alpha（`src/lib/ground/shaders/shadow-volume-glsl.ts:246-248`、`src/lib/ground/materials.ts:1397-1399,1682-1685`），而 render state 使用 `blendSrc=ONE`。

## 5. 字段逐项语义

| 字段 | 类型 | 通用语义 | 无法提供时 |
| --- | --- | --- | --- |
| `st` | `vec2` | kind 特定的稳定归一坐标；详见第 6 节 | `vec2(0)` |
| `localMeters` | `vec2` | 与 `st` 同轴的局部米坐标 | `vec2(0)` |
| `baseColor` | `vec4` | legacy shape/style 解析后的 straight RGBA | `vec4(0)` |
| `isStroke` | `float` | 离散语义：stroke=`1.0`，fill=`0.0` | `0.0` |
| `positionEC` | `vec3` | packed depth 重建的实际分类表面点，米 | `vec3(0)` |
| `positionToEyeEC` | `vec3` | `-positionEC`，未归一化，米 | `vec3(0)` |
| `normalEC` | `vec3` | 朝向 eye 半空间的单位表面法线 | `vec3(0)` |
| `distanceAlongMeters` | `float` | 全折线起点至当前点的累计弧长 | `0.0` |
| `distanceAcrossMeters` | `float` | 相对线中心的有符号横向距离，正值向右 | `0.0` |
| `lineTotalMeters` | `float` | 整条加密线首尾累计长度 | `0.0` |
| `metersPerPixel` | `float` | 当前表面点处每 CSS pixel 对应的世界米数 | `0.0` |

**全初始化规则：**assembler 首先把每一项写成上表零值，再覆盖当前 kind 能提供的字段；禁止依赖栈垃圾值或某个 GPU 对未初始化 struct field 的行为。Material 可以跨 kind 共享，并用 kind macro 避免除以零。

## 6. 按 primitive kind 的输入契约

### 6.1 汇总表

| 字段 | `C23_SURFACE` | `C23_POLYLINE` | `C23_DECAL` | `C23_ARROW` |
| --- | --- | --- | --- | --- |
| `st` | footprint 归一坐标 | `(along/total, across normalized)` | decal footprint 归一坐标 | `(tip→base, left→right)` |
| `localMeters` | 从 footprint SW 沿局部 east/north | `(along, across)` | 从 footprint SW 沿 local X/Y | `(a, b)`，tip 为原点 |
| `baseColor` | 当前 fill/stroke straight RGBA | 当前 line straight RGBA | straight tint/overall opacity，默认白 | 当前 arrow straight RGBA |
| `isStroke` | fill `0`；border/ring/sector stroke `1` | `1` | `0` | solid `0`；open chevron `1` |
| EC 三项 | 有效 packed depth处提供 | 有效线成员处提供 | 有效 packed depth处提供 | 有效箭头成员处提供 |
| 沿线三项 | 全为 `0` | 全部提供 | 全为 `0` | 全为 `0` |
| `metersPerPixel` | `0` | 当前重建点 CSS pixel 口径 | `0` | 当前重建点 CSS pixel 口径 |

### 6.2 `C23_SURFACE`

适用于 rectangle、polygon、circle，以及 circle/square point delegate。

- `st=(0,0)` 是 render footprint 的 southwest 局部角，`(1,1)` 是 northeast；旋转 shape 的 X/Y 轴随 footprint 旋转，不退化成世界经纬轴。
- `localMeters=(0,0)` 与 `st=(0,0)` 同源；X 沿 local west→east，Y 沿 south→north。
- polygon 的保守 render shell 中，`st` 可以落在 fill polygon 外；系统先计算 shape coverage，Material 输出最后再乘 coverage。
- `baseColor` 已由 fill/border/ring/sector 规则选择；Material 通过 `isStroke` 区分，不负责重新判断 polygon/circle 几何。
- shape coverage 外仍会构造一个全初始化 input 并执行/完成 color pass；最终 alpha 被系统 coverage 乘为零以清 stencil。

Current local meters 来源是每帧 Float64 CPU plane（`src/lib/ground/classification.ts:309-376`），shape 分支当前在 `src/lib/ground/materials.ts:651-759`；Proposed 只重排职责，不换坐标基准。

### 6.3 `C23_POLYLINE`

在通过 packed-depth、sky guard、三平面和宽度 membership 后提供：

```text
distanceAlongMeters  = clamp(global s, 0..1) * lineTotalMeters
distanceAcrossMeters = signed distance to right plane
st.x                 = distanceAlongMeters / lineTotalMeters  // total>0
st.y                 = (distanceAcrossMeters + halfWidthMeters)
                       / (2 * halfWidthMeters)                 // width>0
localMeters          = vec2(distanceAlongMeters, distanceAcrossMeters)
```

方向规定：

- along 零点是公开 `points[0]`，向 `points[N-1]` 增大；闭合线仍以输入第一个点为相位零点。
- across 正值是沿点序前进时的右侧；`st.y=0` 左边缘，`0.5` 中心，`1` 右边缘。
- `lineTotalMeters` 是 CPU 加密后的 3D surface chord 累计值，与 Current `u_lineTotalMeters` 一致；计算证据在 `src/lib/ground/line/line-segment-attributes.ts:200-208,261-273`。
- `metersPerPixel` 包含 `frameState.pixelRatio`，因此是每 CSS pixel 的米数；Current 公式与逐帧 pixel ratio 写入见 `src/lib/ground/shaders/shadow-volume-glsl.ts:685-745`、`src/lib/ground/classification.ts:449-460`。

在合法线成员片元中，`st` 应在 `[0,1]`；数值误差由系统 clamp。Material 不应重新做 sky/depth/membership discard。

### 6.4 `C23_DECAL`

适用于 text 与 image。

- `st=(0,0)` 是地面 footprint 的 southwest，`(1,1)` 是 northeast；这是地面坐标，不隐含图片存储方向。
- `localMeters` 沿旋转后的 decal local X/Y，从 southwest 为零。
- built-in `createTexturedDecalMaterial({ flipY:true })` 采样 `vec2(st.x, 1.0-st.y)`，保持 canvas/image 原点在左上；自定义 Shader 可选择自己的翻转。
- `baseColor` 默认 `vec4(1)`，alpha 含 primitive 总 opacity/tint 语义；纹理 texel 不预先塞入 `baseColor`，而由 Material 自己采样。
- decal footprint 外与 texel alpha=0 都必须以最终零 alpha完成 color pass，不 discard。

Current decal 已使用 southwest UV 并在采样前翻 V，见 `src/lib/ground/materials.ts:941-976`；CanvasTexture 本身 `flipY=false`，见 `src/lib/ground/text/text-primitive.ts:277-303`。

### 6.5 `C23_ARROW`

系统先完成 packed-depth/sky guard、端点切平面投影与 solid/open membership，然后提供：

```text
a = dot(positionEC - tipEC, backDirectionEC)   // tip -> line interior
b = dot(positionEC - tipEC, rightDirectionEC)  // signed across

st.x = a / arrowLengthMeters      // tip=0, base=1
st.y = b / (2*arrowHalfWidthMeters) + 0.5
localMeters = vec2(a, b)
```

`distanceAlongMeters`、`distanceAcrossMeters`、`lineTotalMeters` 在 v1 arrow ABI 均为零，避免把“箭头内部 a”误写成“全线累计距离”；箭头本地距离只读 `localMeters`。`metersPerPixel` 有效，用于 screen-size arrow 特效。

Current `(a,b)` 与 screen/world 米换算位于 `src/lib/ground/materials.ts:1630-1679`。

## 7. Material 输出与 classification 清理

### 7.1 框架 epilogue

safe assembler 在用户函数返回后执行等价逻辑：

```glsl
// Implementation sketch；实际变量名由 assembler 保留。
c23_material material = c23_getMaterial(input);

float finalAlpha = material.alpha * systemCoverage;
vec3 straightRgb = material.diffuse + material.emission;

out_FragColor = vec4(straightRgb * finalAlpha, finalAlpha);
```

- `systemCoverage` 在 surface/decal 表示 shape/footprint coverage；polyline/arrow 的系统 membership 不通过时在调用 Material 前就由系统裁掉。
- 框架不自动乘 `input.baseColor`，不 clamp，也不提供隐式 lighting。
- RGB 只在最后乘一次 alpha；render state 继续使用 `ONE / ONE_MINUS_SRC_ALPHA`。

### 7.2 为什么 safe Material 禁止 `discard`

surface/decal color pass 的 stencil state 是：`NotEqual 0`，且 stencil fail、depth fail、depth pass 全部 `ZeroStencilOp`。Current 状态在 `src/lib/ground/materials.ts:897-923,1043-1067`。

若 fragment shader 执行 `discard`，该 fragment 不进入 stencil op，front/back 留下的非零值可能污染后续图元。因而：

- `finalAlpha == 0.0`（例如 `material.alpha == 0.0` 或 `systemCoverage == 0.0`）仍输出预乘零色；框架不 clamp 用户返回的负 alpha，越界值正确性由用户负责；
- shape 外、decal 透明 texel、dash gap 都返回 alpha 零；
- safe user source一律禁止 `discard`，使同一 Material 跨 kind 行为一致；
- surface/decal 的系统 shape culling 也必须转成 `systemCoverage=0`，不能在 color pass 提前 discard；
- color pass 的 `transparent` 仍为 `false`，以保持 opaque list 命令连续性；零 alpha不会改变颜色缓冲，但会清 stencil。

Current text/image 已采用零色返回（`src/lib/ground/materials.ts:959-975`），但 polygon/rectangle 与 Cesium `CULL_FRAGMENTS` 仍有 discard（`src/lib/ground/materials.ts:713-745`、`src/lib/ground/shaders/shadow-volume-glsl.ts:206-213`）；[06](./06-render-pipeline-integration.md) 会统一改造。

### 7.3 stencil pass 与 polyline/arrow 的 discard 不同

- front/back stencil 的 log-depth helper 必须继续 discard 视锥外片元，以免生成虚假的 Z-fail ±1；Current 依据见 `src/lib/ground/materials.ts:70-131`。
- polyline/arrow 没有 stencil；系统可继续 discard 无效 depth、天空、box 外和 membership 外片元。
- 禁止的是 safe **Material 用户源码**与 classification **color cleanup path** 提前 discard，不是全项目删除 GLSL `discard`。

### 7.4 color pass 的 log-depth处理

front/back 保留完整 `czm_vertexLogDepth/czm_writeLogDepth`。classification color 的 default state 是 `depthTest=false`、`depthWrite=false`，它只需用 packed log depth重建表面；因此 Proposed color epilogue 不再调用会 discard 的 `czm_writeLogDepth()`。这样所有 stencil-nonzero fragment 都能抵达 `ZeroStencilOp`，同时不会写深度。Raw `createDefaultMaterial()` 必须采用同一 pass-specific规则。

## 8. 编译宏与 schema

### 8.1 kind macros

每个 compiled safe material 恰好定义一个：

```glsl
#define C23_SURFACE 1
// or C23_POLYLINE / C23_DECAL / C23_ARROW
```

不得同时定义两个，也不得把 pass 名当 kind。surface/decal 的 front/back 不编译用户 Material，所以不会定义 safe kind macro；Raw factory 通过 TypeScript context 识别 pass。

### 8.2 ABI version

- TypeScript 导出 `C23_GROUND_SHADER_ABI_VERSION`，值为 literal `1`。
- assembler 在 safe source 中定义同名 GLSL macro。
- ABI version 必须进入 compile key。
- v1 内只能追加不改变现有语义的内部 helper，不能重排/改类型/改坐标方向。
- 任何破坏性 ABI 修改必须递增 version；旧版 Material 可根据宏报错或分支，不允许静默解释成新语义。

### 8.3 编译期与运行期

| 数据 | 类别 | 改变后 |
| --- | --- | --- |
| `fragmentShader` | 编译期 | Material `needsUpdate=true`，重建 compiled material |
| defines key/value | 编译期 | 同上 |
| uniform key/schema | 编译期 | 同上 |
| ABI version / kind / pass / attribute layout | 编译期 | 新 compile key |
| 现有 `IUniform.value` | 运行期 | 原地上传，不重编译 |
| `c23_time` 等 system value | 运行期 | 原地上传，不重编译 |

用户在 GLSL 中新增一条 uniform 声明时，必须同步增加 TypeScript wrapper 并设置 `needsUpdate=true`；只改 `.value` 则 version 不变。完整 API 行为见 [04](./04-public-api-design.md#3-cesiumgroundmaterial)。

## 9. Raw Appearance 的公共 context

```ts
// Proposed API；不得增删字段。
interface GroundRawShaderBuildContext {
  primitiveKind: 'surface' | 'polyline' | 'decal' | 'arrow';
  pass: 'frontStencil' | 'backStencil' | 'color' | 'polyline' | 'arrow';
  systemUniforms: GroundSystemUniforms;
  userUniforms: GroundUserUniforms;
  createDefaultMaterial(): RawShaderMaterial;
}
```

`systemUniforms` 与 `userUniforms` 都提供真实 wrapper 引用。map 的只读性只禁止增加/替换 system wrapper；库仍会逐帧改 system `.value`。Raw user 不应写 system value。

`createDefaultMaterial()`：

- 单次 factory 调用只有两种合法模式：完全替换时一次也不调用；修改默认材质时恰好调用一次，并返回该同一实例；
- 第二次调用、调用后返回另一实例，或返回已被其他 pass/图元使用的实例，统一视为 `GROUND_RAW_FACTORY_RESULT_INVALID` / `GROUND_RAW_MATERIAL_REUSED`；
- 默认实例已绑定当前 system + user wrappers，并包含当前 legacy style、fragmentCull、debug flag 与正确 render state；
- factory 抛错或返回非法结果时，context 负责 dispose 尚未转移所有权的默认候选；成功返回物由当前 primitive 拥有，factory 不得缓存到下一次调用。

Raw factory 返回一个完整的 `RawShaderMaterial`。它不必实现 `c23_getMaterial`；一旦完整替换，safe ABI 的自动保护不再适用。

## 10. Raw attribute ABI

首期 Raw factory不能增删 geometry attributes。以下名称、itemSize 与语义是 pass 输入。

### 10.1 surface / decal 三 pass

| attribute | GLSL 类型 | 语义 |
| --- | --- | --- |
| `position3DHigh` | `vec3` | ECEF/shadow-volume vertex RTE high |
| `position3DLow` | `vec3` | 对应 low |
| `batchId` | `float` | 当前单实例 batch id；保留 Cesium Shader 形状 |
| `extrudeDirection` | `vec3` | bottom/wall 按视距挤出方向；top 为零 |

Current 原始声明见 `src/lib/ground/shaders/shadow-volume-glsl.ts:31-39`。所有 front/back/color Mesh 共用同一 geometry。

### 10.2 polyline pass

| attribute | GLSL 类型 | 语义 |
| --- | --- | --- |
| `position3DHigh` / `position3DLow` | `vec3` | 保守 segment box 顶点 RTE |
| `startHiAndForwardOffsetX` | `vec4` | 起点 high xyz + forward offset x |
| `startLoAndForwardOffsetY` | `vec4` | 起点 low xyz + forward offset y |
| `startNormalAndForwardOffsetZ` | `vec4` | start plane normal + forward offset z |
| `endNormalAndTextureCoordinateNormalizationX` | `vec4` | end plane normal + signed segment length normalization |
| `rightNormalAndTextureCoordinateNormalizationY` | `vec4` | right plane normal + signed accumulated-length normalization |
| `batchId` | `float` | 当前为零，保留布局 |

Current geometry 装配：`src/lib/ground/line/line-shadow-volume.ts:67-99`；Shader 声明：`src/lib/ground/materials.ts:1088-1104`。

### 10.3 arrow pass

| attribute | GLSL 类型 | 语义 |
| --- | --- | --- |
| `arrowTipHigh` / `arrowTipLow` | `vec3` | 端点 ECEF RTE high/low |
| `arrowBackDir` | `vec3` | 从 tip 指向线内侧的单位方向 |
| `arrowRightDir` | `vec3` | 沿点序观察时右向单位方向 |
| `arrowUpDir` | `vec3` | 端点椭球 up |
| `arrowCorner` | `vec3` | `(aCoef,bSign,topBottomSide)` box corner |
| `arrowTerrainHeights` | `vec2` | 端点 terrain min/max meter window |
| `arrowStyleId` | `float` | solid/open 当前 style id |

Current 装配：`src/lib/ground/line/line-arrowhead.ts:331-406`；Shader 声明：`src/lib/ground/materials.ts:1474-1488`。

## 11. Raw system uniform ABI

`GroundSystemUniforms` 的 v1 稳定集合按 pass 取子集；Three 会忽略 Shader 未声明的 entries。公开键只使用 Cesium 移植量的 `czm_*` 与本库管线量的 `c23_*`，因此不会和允许用户使用的 `u_color` 等普通 `u_*` 名冲突。`SharedUniforms` 旧 TypeScript 接口仍导出但 deprecated；Raw 用户应只通过 context 取得 canonical wrappers，不能自行构造整张 map。

### 11.1 所有 kind 的公共帧量

```text
czm_encodedCameraPositionMCHigh
czm_encodedCameraPositionMCLow
czm_modelViewRelativeToEye
czm_modelViewProjectionRelativeToEye
czm_normal
czm_geometricToleranceOverMeter
czm_sceneMode
czm_globeDepthTexture
czm_viewport
czm_inverseProjection
czm_viewportTransformation
czm_frustumPlanes
czm_currentFrustum
czm_farDepthFromNearPlusOne
czm_log2FarDepthFromNearPlusOne
czm_oneOverLog2FarDepthFromNearPlusOne
c23_time
c23_deltaTime
c23_frameNumber
```

Current 字段定义见 `src/lib/ground/types.ts:468-551`，更新链见 `src/lib/ground/classification.ts:389-461`；最后三个 `c23_*` 是 Proposed 新增。

### 11.2 surface / decal 系统量

```text
c23_globeMinimumAltitude
c23_southWestHigh / c23_southWestLow
c23_eastward / c23_northward
c23_uvMinAndExtents / c23_uMaxVmax
c23_fillColor
c23_strokeColor / c23_borderEnabled / c23_borderWidthMeters
c23_innerMetersRect
c23_cpuWestPlane / c23_cpuSouthPlane
c23_polygonBorderMode / c23_polygonMiterStrokeMode
c23_polygonPointCount / c23_polygonPoints
c23_circleBorderMode / c23_circleCenterMeters
c23_circleFillRadiusMeters / c23_circleRenderRadiusMeters
c23_circleRingCount / c23_circleRingGapMeters
c23_circleSectorStartRadians / c23_circleSectorAngleRadians
```

decal 的内置 default Appearance 还从逻辑 Material user uniforms取得 texture、opacity、tint、flipY；不再把 `u_decalTexture` 作为通用 system ownership。Current 兼容槽 `u_textTexture/u_decalTexture/u_decalOpacity` 可在过渡期保留，但不进入 `GroundSystemUniforms`，也不属于新 user 扩展方式。

### 11.3 polyline / arrow 系统量

```text
czm_projection
czm_pixelRatio
c23_lineColor
c23_lineWidthPixels / c23_lineWidthMode / c23_lineWidthMeters
c23_lineTotalMeters
c23_arrowWidthMode
c23_arrowLengthPixels / c23_arrowHalfWidthPixels
c23_arrowLengthMeters / c23_arrowHalfWidthMeters
c23_arrowColor / c23_arrowStrokeHalfPixels
c23_lineArrowClipEndEnabled / c23_lineArrowClipStartEnabled
c23_lineArrowStyleStart / c23_lineArrowStyleEnd
```

Current map 定义与初值：`src/lib/ground/primitives.ts:1320-1416`。虚线的 dash/gap/offset 从系统主 FS 移到内置 Material user uniforms；为旧 setter 兼容，可在迁移期同步旧字段，但安全 ABI 只保证 `distanceAlongMeters` 与 `lineTotalMeters`。

### 11.4 legacy `u_*` 到 canonical key 的迁移

Current 源码中的系统名不是新 ABI。adapter 在创建 canonical map 时复用原 `IUniform` wrapper，例如：

| Current / deprecated key | v1 canonical key |
| --- | --- |
| `u_globeMinimumAltitude` | `c23_globeMinimumAltitude` |
| `u_southWest_HIGH` / `u_southWest_LOW` | `c23_southWestHigh` / `c23_southWestLow` |
| `u_color`（surface） | `c23_fillColor` |
| `u_borderColor` | `c23_strokeColor` |
| `u_color`（polyline） | `c23_lineColor` |
| `u_lineWidthPixels` / `u_lineTotalMeters` | `c23_lineWidthPixels` / `c23_lineTotalMeters` |
| `u_arrowColor` / `u_arrowWidthMode` | `c23_arrowColor` / `c23_arrowWidthMode` |

映射规则是 `canonicalMap.c23_fillColor === legacySharedUniforms.u_color` 这类**同 wrapper 引用别名**，不是复制 `.value`。legacy key 只供旧后端迁移期读取，不得和 user map 一起合并或暴露给 Raw context；新 assembler/default Shader 全部声明 canonical key。其余 `u_border*`、`u_polygon*`、`u_circle*`、`u_line*`、`u_arrow*` 按上面两节的一一同名语义改为 `c23_*`，完整映射表必须作为常量和快照测试维护。

## 12. Raw default render-state 契约

### 12.1 surface / decal

| pass | side | depth | stencil | color/blend |
| --- | --- | --- | --- | --- |
| `frontStencil` | `FrontSide` | test `LessEqual`；write false | Always；mask `0x0f`；zFail `DecrementWrap`；其它 Keep | colorWrite false；opaque list |
| `backStencil` | `BackSide` | 同上 | Always；mask `0x0f`；zFail `IncrementWrap`；其它 Keep | colorWrite false；opaque list |
| `color` | `DoubleSide` | test false；write false | NotEqual ref 0；三个结果全 `Zero` | colorWrite true；`transparent=false`；ONE / ONE_MINUS_SRC_ALPHA |

Current 事实：`src/lib/ground/materials.ts:839-927,1026-1068`。`CLASSIFICATION_MASK=0x0f` 在 `src/lib/ground/constants.ts:18-20`。

Raw user可以修改这些状态，但完全替换后必须自行维持：

- front/back/color 命令连续；
- color 能清除所有非零 classification stencil；
- 颜色是预乘输出，或同时改成与输出匹配的 blending；
- 不将 color 误放入 Three transparent list 导致排序拆散。

### 12.2 polyline / arrow

| pass | side | depth/stencil | blend/list |
| --- | --- | --- | --- |
| `polyline` | `DoubleSide` | depth test/write false；stencil false；FS 自行 depth reconstruction | `transparent=true`；预乘 CustomBlending |
| `arrow` | `DoubleSide` | 同上 | 同上；renderOrder 默认 line+1 |

Current 事实：`src/lib/ground/materials.ts:1421-1458,1704-1737`。完全替换若不保留 packed-depth/sky guard，会把保守 box 绘到天空；这不是库可自动修复的问题。

## 13. Raw pass 变换一致性

### 13.1 surface / decal

三个 pass 使用同一 geometry，但各自是独立 material。若用户在 vertex shader 中变换 footprint：

```text
frontStencil(vertex) == backStencil(vertex) == color(vertex)
```

必须对每个输入顶点产生同一 clip-space覆盖（允许仅不影响位置的 varying 差异）。否则：

- front/back 不一致会破坏 Z-fail加减抵消；
- stencil 与 color 不一致会在旧位置着色、漏清 stencil 或清错区域；
- 只改 color 的“视觉几何缩放”不是安全做法。safe scale effect应只变换 `st`/采样坐标，并受原 footprint裁切。

Raw factory 可在三个 context 中调用 `createDefaultMaterial()`，把相同 vertex source 变换注入三者。开发模式只能检查三个 pass 都返回且不是同一 material 实例；无法证明 GLSL 等价。

### 13.2 polyline / arrow

两者是相互独立的 pass/appearance。修改 line vertex 不会自动移动 arrow；需要协调时由用户分别设置 `appearance` 和 `arrowAppearance`。line 的端点 clip 与 arrow geometry 当前通过共享 system uniforms保持配合；Raw 完全替换后用户承担重叠/断口。

## 14. shape coverage、无效深度与零值

### 14.1 surface/decal color

系统先计算：

```text
hasPackedDepth
insideFootprint
insidePolygon/circle/sector/ring
stroke/fill classification
```

无效项不 discard，而是令 `systemCoverage=0`。EC/normal 无法重建时对应字段置零；Material 仍必须能被安全调用。最终零 alpha使颜色缓冲不变并触发 stencil Zero op。

### 14.2 polyline/arrow

由于没有 stencil，系统在以下情况可以在 Material 前 discard：

- screen coordinate 超出 viewport；
- packed depth为空/远平面哨兵；
- camera ray miss WGS84 ellipsoid；
- 重建点越过带 margin 的可见地平线；
- 不在 line/arrow box 的精确成员区域。

这些 guard 的 Current helper 在 `src/lib/ground/materials.ts:452-539`。Raw `createDefaultMaterial()` 保留；完全替换必须自行处理。

## 15. Shader 组装顺序

safe fragment shader 必须按确定顺序连接，不再使用 Current 的字符串锚点替换：

```text
1. #version 300 es（由 RawShaderMaterial.glslVersion=GLSL3 管理）
2. precision + renderer/system declarations
3. ABI version + exactly one kind define
4. system helpers（depth reconstruction / planes / coverage）
5. c23 time uniforms + structs
6. canonicalized user defines
7. validated user fragmentShader
8. library-owned main()
   a. reconstruct and validate system surface data
   b. initialize every c23_materialInput field to zero
   c. fill kind-specific fields
   d. compute baseColor/isStroke/systemCoverage
   e. call c23_getMaterial
   f. apply coverage, add diffuse+emission, premultiply once
   g. write output and perform pass-required cleanup
```

Current `createColorFragmentBody()` 与 `createTextColorFragmentBody()` 都依赖 `.replace(colorDeclaration, injection)`（`src/lib/ground/materials.ts:651-759,941-985`）；Proposed assembler必须由命名 source sections组成并对每段做快照测试。

## 16. 示例

### 16.1 kind-aware Material

> **Proposed GLSL 示例：**一个逻辑 Material 可跨 surface 与 polyline；未使用字段有零值。

```glsl
uniform vec3 u_fillColor;
uniform vec3 u_lineColor;

c23_material c23_getMaterial(c23_materialInput input) {
    c23_material result;
    result.emission = vec3(0.0);

#ifdef C23_POLYLINE
    float wave = 0.5 + 0.5 * sin(
        input.distanceAlongMeters * 0.05 - c23_time * 3.0
    );
    result.diffuse = u_lineColor * wave;
    result.alpha = input.baseColor.a;
#else
    result.diffuse = mix(u_fillColor, input.baseColor.rgb, input.isStroke);
    result.alpha = input.baseColor.a;
#endif

    return result;
}
```

### 16.2 透明但清 stencil

```glsl
c23_material c23_getMaterial(c23_materialInput input) {
    float visible = step(0.5, fract(c23_time + input.st.x * 4.0));

    c23_material result;
    result.diffuse = input.baseColor.rgb;
    result.emission = vec3(0.0);
    result.alpha = input.baseColor.a * visible; // 0 表示透明；不要 discard
    return result;
}
```

### 16.3 Raw 修改 default material

> **Proposed TypeScript 示例伪代码：**展示 pass 信息与独立实例；不是 safe ABI。

```ts
const raw = new CesiumGroundRawShaderAppearance({
  uniforms: { u_debugGain: { value: 1 } },
  factory(ctx) {
    const material = ctx.createDefaultMaterial(); // 本次 factory 唯一一次调用
    material.name = `Debug/${ctx.primitiveKind}/${ctx.pass}`;

    // default 已自动绑定同一 user wrapper；这里只验证，不再重复赋值。
    console.assert(material.uniforms.u_debugGain === ctx.userUniforms.u_debugGain);
    // surface front/back/color 仍分别得到不同 material。
    return material;
  },
});
```

若把 `u_debugGain` 真正用于 GLSL，factory 必须同步修改对应 source并保证 pass契约；修改 closure/source 后调用 `raw.needsUpdate=true`。

## 17. 关键决策

1. **结构固定、不可用字段为零。** 不采用 Cesium `USES_*` 导致用户 struct 形态随材质变化；稳定 ABI优先。
2. **输出只包含 diffuse/emission/alpha。** 首期 Ground 是 flat overlay，不引入完整 PBR 或灯光模型；normal 仍提供给用户自定义公式。
3. **framework 不 clamp。** 避免破坏 HDR/emission；built-in Material 可按自身参数规则 clamp。
4. **safe source 全局禁止 discard。** 代价是 polyline dash gap也执行零 alpha输出，收益是同一 Material 跨 classification 安全且规则单一。
5. **surface/decal color 不用 discard 型 log-depth epilogue。** 它不写/测 depth，首要职责是消费 stencil；front/back继续保留严格 log-depth。
6. **Raw attribute layout只读。** 首期不让工厂动态改 geometry，避免 cache key、bounding和多个 pass layout失控。

## 18. 边界条件

- `lineTotalMeters==0` 理论上会被 CPU 输入校验阻止，但跨 kind Material 仍必须防御零值。
- `normalEC==vec3(0)` 时不得无条件 normalize；深度边缘/屏幕边缘允许出现零 fallback。
- Material 返回 NaN/Inf、负 alpha 或超 1 alpha 时框架不修正；safe 模式只保证结构和 Ground 管线，不替用户做数值策略。
- `st` 是系统 footprint 坐标，不是纹理对象的 `flipY` 状态；纹理方向必须显式处理。
- `metersPerPixel` 是 CSS pixel 口径；直接与 `gl_FragCoord` 物理像素混算时需考虑 pixelRatio。
- Raw user若把 color 设置 `transparent=true`，Three 可能把它移到透明列表并破坏三命令连续性；这是显式风险。
- Raw user若在 classification color discard，即使颜色正确也会留下 stencil；开发检查只能警告，不能改写用户源码。
- Shader 视觉 scale不能扩大 geometry footprint、bounding、classification region或拾取范围。

## 19. 验收清单

- [ ] GLSL ABI 含完整且唯一的 `c23_materialInput`、`c23_material` 与函数签名。
- [ ] `C23_GROUND_SHADER_ABI_VERSION=1` 在 TS/GLSL/compile key中一致。
- [ ] 每次 safe 编译恰好定义一个 `C23_SURFACE/POLYLINE/DECAL/ARROW`。
- [ ] 每个 input field 的空间、单位、方向、有效 kind 与零值已定义。
- [ ] polyline along/across、CSS meters-per-pixel 与 arrow `(a,b)` 方向明确。
- [ ] `baseColor` 与 Material 输出均为 straight，framework只在结尾预乘一次且不 clamp。
- [ ] safe Material 禁止 discard，classification shape/decal透明区用零 alpha清 stencil。
- [ ] front/back stencil 的 log-depth discard与 color cleanup规则被明确区分。
- [ ] Raw context字段与 [04](./04-public-api-design.md) 完全一致且没有额外可写 geometry/renderer。
- [ ] surface/decal、polyline、arrow 的 attribute ABI完整。
- [ ] Raw default render state覆盖 LessEqual、wrap ops、Zero ops、opaque-list color和预乘混合。
- [ ] Raw 多 pass vertex一致性与用户责任明确。
- [ ] Shader source、defines、schema与 `.value` 的编译/运行期边界明确。
- [ ] 全文不包含 timeline、tween或内部 RAF。

---

上一篇：[04 · 公共 API 设计](./04-public-api-design.md)  
下一篇：[06 · 渲染管线集成](./06-render-pipeline-integration.md)
