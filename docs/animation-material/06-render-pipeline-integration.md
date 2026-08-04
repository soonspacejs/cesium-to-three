# 06 · 渲染管线集成：surface / polyline / decal / arrow / runtime

> 状态：**Proposed Implementation Design**（尚未实现）。  
> Current 基线：`D:\my\code\cesium-to-three`，提交 `32a6b244b7c0cb731ca35165c46e8fe31248c718`。  
> 导航：[上一篇：05 · Shader ABI](./05-shader-abi.md) · [下一篇：07 · 内置效果](./07-built-in-effects.md)

## 目标

1. 给出从 Current 固定 Shader 到 Material / Appearance 体系的具体改造顺序，而不是只列概念或文件名。
2. 让 surface、polyline、decal、arrow 的默认视觉和自定义 Material 走同一编译入口。
3. 在改造中保护 RTE、packed/log depth、Z-fail stencil、`ZeroStencilOp`、预乘、sky guard、renderOrder 与 non-pickable layer。
4. 锁定 appearance 切换、`setFragmentCulling()`、text/image rebuild、Material/Raw version 变化时的引用保持、资源释放和失败回退。

## 前置阅读

- [02 · 当前 Ground 渲染管线](./02-current-rendering-pipeline.md)
- [03 · 目标架构](./03-target-architecture.md)
- [04 · 公共 API 设计](./04-public-api-design.md)
- [05 · Shader ABI](./05-shader-abi.md)
- 分阶段落地次序与测试门禁见 [09](./09-implementation-roadmap.md) 和 [10](./10-test-and-acceptance.md)。

## 非目标

- 不新建 timeline、tween、animation mixer、内部 clock、内部 RAF 或序列化层。
- 不改 Ground geometry 的数学算法；视觉 scale 不自动扩大 footprint、包围盒或拾取范围。
- 不改变 `classificationType` 深度选择语义。
- 不发布 plot API；只保持仓库内 `PlotPrimitiveBridge` 兼容。
- 不替 Raw Appearance 推断或修复用户 Shader。

## 设计过程

1. 以 [02](./02-current-rendering-pipeline.md) 的 Current 接缝为起点，逐一标出哪些代码属于 geometry/pass 系统模板，哪些固定颜色、纹理或虚线逻辑应迁入 Material。
2. 先落地共享 validation、uniform merge、Shader assembler 与 pass compiler，再让 surface、polyline、arrow、decal 依次接入；这样每条管线不会各自发明一套 ABI。
3. 每接入一种 primitive kind，都先让未传 `appearance` 的默认行为改走内置 Material，再开放 safe/Raw 入口，避免默认与自定义双轨。
4. 接着把 frame-state 时间、version 侦测、appearance 切换、fragment-culling、文字/图片重建接入现有 update 点，并采用“构建候选—验证—原子交换—释放旧资源”的事务顺序。
5. 最后补齐 dispose、错误回退、公共导出和构建验证；任何阶段失败都应保留旧可渲染对象与用户 uniform/Texture 引用。

## 1. Current 接缝与目标落点

| Current 接缝 | 证据 | Proposed 落点 |
| --- | --- | --- |
| surface color 以固定字符串锚点插 border/circle/polygon | `src/lib/ground/materials.ts:651-759` | 显式 surface fragment sections + Material call |
| decal 再对同一锚点做第二套 replace | `src/lib/ground/materials.ts:941-985` | `C23_DECAL` + 内置 `createTexturedDecalMaterial` |
| classification 只支持内部 color factory | `src/lib/ground/classification.ts:463-598` | 两套公开 Appearance + per-pass compiler |
| polyline 主 FS 硬编码纯色、虚线、预乘 | `src/lib/ground/materials.ts:1210-1405` | 系统 reconstruction/membership + `c23_getMaterial` |
| arrow 主 FS 硬编码颜色 | `src/lib/ground/materials.ts:1579-1691` | 系统 arrow membership + 独立 arrow Appearance |
| frame update 使用宽泛 `SharedUniforms` | `src/lib/ground/classification.ts:389-461` | 内部 typed system maps + 时间 uniforms；旧类型 deprecated |
| text 先销毁旧 classification 再重建 | `src/lib/ground/text/text-primitive.ts:92-132` | 两阶段候选构建与原子 child/material 交换 |

## 2. 内部模块与职责

> **Implementation sketch：**以下是 Proposed 内部拆分，不增加这些路径为 npm subpath。

```text
src/lib/ground/material/
├─ types.ts
├─ CesiumGroundMaterial.ts
├─ appearances.ts
├─ shader-abi.ts
├─ shader-assembler.ts
├─ compiler.ts
├─ validation.ts
├─ builtins.ts
└─ index.ts
```

| 模块 / 符号 | 唯一职责 |
| --- | --- |
| `types.ts` | `GroundPrimitiveKind`、`GroundRenderPass`、uniform/compile 内部类型 |
| `CesiumGroundMaterial.ts` | 逻辑 Material、version、`setUniform`、clone、通知式 dispose |
| `appearances.ts` | safe/Raw Appearance 类与 Raw factory context |
| `shader-abi.ts` | ABI version、struct、time uniform、kind define source；`createMaterialInputSource()` / `createFinalOutputSource()` |
| `shader-assembler.ts` | `assembleGroundVertexShader()` / `assembleGroundFragmentShader()`；只拼显式命名 sections |
| `compiler.ts` | `compileGroundPass()`、pass 矩阵、default render state、compiled record |
| `validation.ts` | 保留标识符、user schema、Material 函数、禁止构造、Raw 返回值/复用检查；`mergeGroundUniforms()` |
| `builtins.ts` | Color、TexturedDecal、Dash 与动画预设；全部返回逻辑 Material |
| `index.ts` | 只导出 [04](./04-public-api-design.md) 锁定的公共符号 |

Current `src/lib/ground/materials.ts` 在迁移期保留 Cesium helper、固定 render state 与旧后端作为逐阶段对照；所有默认行为迁完并通过回归后，才删除 `createColorFragmentBody()` / `createTextColorFragmentBody()` 的 anchor replace。不能在新 assembler 尚未覆盖全部 pass 前一次性重写。

## 3. 共用编译器

### 3.1 输入与 pass 矩阵

```ts
// Implementation sketch：内部函数。
interface CompileGroundPassOptions {
  primitiveKind: GroundPrimitiveKind;
  pass: GroundRenderPass;
  appearance: CesiumGroundAppearance;
  systemUniforms: Record<string, IUniform>;
  pipelineState: {
    fragmentCull: boolean;
    debugVolume: boolean;
    attributeLayoutKey: string;
  };
}

function compileGroundPass(
  options: CompileGroundPassOptions,
): GroundCompiledMaterialRecord;
```

`compileGroundPass()` 固定步骤：

1. 用 kind/pass 合法矩阵拒绝非法组合。
2. safe Material 验证 user uniform/define/GLSL 顶层名称；Raw 只验证 user schema、pass 与返回物，不扫描或改写完整 Raw source/defines。
3. 先把 deprecated `SharedUniforms` 的非保留系统键引用别名为 canonical `c23_*`，再执行 `mergeGroundUniforms(system,user)`；发现 exact key 冲突立即抛错，wrapper 不 clone。
4. safe Appearance：`frontStencil/backStencil` 走固定 library 分支，只有 `color/polyline/arrow` 按 kind 注入逻辑 Material。
5. Raw Appearance：构造严格 context 并调用 factory；每次 factory 可零次调用 `createDefaultMaterial()`（完整替换），或调用一次并返回该默认实例（原地修改）。
6. 校验返回值是独立 `RawShaderMaterial`、GLSL3、默认材质调用/返回规则，以及返回 map 中同名 system/user wrapper 的身份；完整替换可省略未使用 uniform。
7. 返回带 appearance/material version snapshot 与 compile key 的 record。

### 3.2 编译一个完整候选 set

```ts
// Implementation sketch。
function compileRequiredSet(kind, nextAppearance, state, request) {
  const passes = resolvePasses({
    kind,
    scope: request.scope,
    previousAppearance: request.previousAppearance,
    nextAppearance,
  });
  const candidate = new Map<GroundRenderPass, GroundCompiledMaterialRecord>();
  const materialIdentities = new Set<RawShaderMaterial>();

  try {
    for (const pass of passes) {
      const record = compileGroundPass({
        primitiveKind: kind,
        pass,
        appearance: nextAppearance,
        ...state,
      });
      if (nextAppearance.kind === 'raw') {
        claimRawMaterialIdentity(record.material, {
          appearance: nextAppearance,
          primitiveId: state.primitiveId,
          kind,
          pass,
        });
      }
      if (materialIdentities.has(record.material)) {
        throw groundError('GROUND_RAW_MATERIAL_REUSED', { kind, pass });
      }
      materialIdentities.add(record.material);
      candidate.set(pass, record);
    }
    return candidate;
  } catch (error) {
    disposeCandidateOnce(candidate);
    throw error;
  }
}
```

`claimRawMaterialIdentity()` 使用模块级持久 `WeakMap<RawShaderMaterial, ClaimMetadata>`，而不是仅限当前候选 set 的集合；它拒绝跨 pass、跨图元、跨 Appearance 及跨 rebuild 的历史实例复用，并能在错误 detail 中指出首次 owner。局部 `materialIdentities` 仍用于候选内快速检查和去重清理。WeakMap 不阻止已 dispose 对象被 GC。

`request.scope` 明确区分两种用途：`fullPipeline` 用于构造和显式 Geometry rebuild，始终生成 kind 的完整 pass set；safe surface/decal 的 front/back 由固定 library 分支生成，不调用 `c23_getMaterial`。`appearanceOnly` 必须同时传 `previousAppearance` 与 `nextAppearance`：safe→safe 只返回 color；safe→Raw、Raw→safe、Raw→Raw 都返回完整三 pass，避免 Raw→safe 时仅看新对象而遗留旧 Raw stencil。polyline/arrow 本来就是单 pass。`setText()` 的固定 topology 原位更新不调用该函数。这样“完整图元必须有三 pass”与“safe Material 只影响 color”不会混在同一个隐式矩阵里。

这里的“compile”是组装并创建 Three material；没有 renderer/context 时 WebGL program 真正编译仍会延迟。同步失败事务可完全回退；GPU GLSL 错误则保留 Three 原始日志并附 kind/pass/ABI/material type，首期不承诺自动回滚。

### 3.3 显式 Shader sections

`assembleGroundFragmentShader()` 不搜索、替换 Cesium 字符串。按顺序拼：

```text
system precision/declarations
-> Cesium depth/RTE helpers
-> kind/pass system uniforms
-> ABI version/kind/time/struct
-> user defines (canonical order)
-> validated user Material source
-> library-owned main
   -> reconstruct
   -> coverage/membership
   -> create fully initialized input
   -> c23_getMaterial
   -> final output / cleanup
```

每一段由独立生成函数返回，单元测试快照 section 顺序与关键 render state；不再允许 `.replace('vec4 color = ...')` 这类“找不到锚点才报错”的接入。

## 4. Surface classification 改造

适用 rectangle、polygon、circle 与 circle/square point delegate。

### 4.1 保留的 Current 部分

以下完全不移入 Material：

- rectangle/polygon/circle shadow-volume geometry、RTE high/low、extents 与 CPU planar planes；
- front=`FrontSide + DecrementWrap`、back=`BackSide + IncrementWrap`、`LessEqualDepth`；
- `CLASSIFICATION_MASK=0x0f`；
- color=`NotEqual 0`、三处 `ZeroStencilOp`、`transparent=false`、预乘 blending；
- `renderOrder=base/base+1/base+2`、layer 1、`frustumCulled=false`；
- `classificationType` packed depth选择；
- stencil pass 的 discard 型 log-depth。

Current 证据集中在 `src/lib/ground/classification.ts:585-650,817-836` 与 `src/lib/ground/materials.ts:839-927`。

### 4.2 将 shape 求值从“直接写颜色”改为中间结果

新增内部 fragment 数据：

```glsl
// Implementation sketch，不是用户 ABI。
struct c23_surfaceEvaluation {
    vec2 st;
    vec2 localMeters;
    vec4 baseColor;
    float isStroke;
    float coverage;
    vec3 positionEC;
    vec3 positionToEyeEC;
    vec3 normalEC;
};
```

将 Current rectangle/polygon/circle 分支改写为纯求值函数：

```text
evaluateRectangle(...) -> baseColor/isStroke/coverage
evaluatePolygon(...)   -> baseColor/isStroke/coverage
evaluateCircle(...)    -> baseColor/isStroke/coverage
```

关键变化：shape 外不再 `discard`。polygon outside、rectangle border shell 外、circle sector/ring gap、`CULL_FRAGMENTS` 的 footprint/depth无效都令 `coverage=0`。`baseColor` 保持 straight alpha；stroke 时 `isStroke=1`。

### 4.3 color pass 顺序

```glsl
// Implementation sketch；系统 helper 名实际保留 c23_ 前缀。
void main() {
    c23_surfaceEvaluation surface = c23_evaluateSurface();

    c23_materialInput input = c23_zeroMaterialInput();
    input.st = surface.st;
    input.localMeters = surface.localMeters;
    input.baseColor = surface.baseColor;
    input.isStroke = surface.isStroke;
    input.positionEC = surface.positionEC;
    input.positionToEyeEC = surface.positionToEyeEC;
    input.normalEC = surface.normalEC;

    c23_material result = c23_getMaterial(input);
    c23_writeFinalColor(result, surface.coverage);
    // 不 discard；color pass 的 stencil op在 draw pipeline 中清零。
}
```

classification color 是 `depthTest=false/depthWrite=false`，Proposed 不在结尾调用会 discard 的 `czm_writeLogDepth()`；packed log depth只用于重建 surface。front/back 仍执行 Current `czm_vertexLogDepth/czm_writeLogDepth`，两种 pass 责任不能混为一谈。

### 4.4 safe 与 Raw 接入

- safe surface：只调用 `compileGroundPass(kind='surface',pass='color')`；front/back继续固定 assembler材质。
- Raw surface：调用 factory 三次，context pass依次为 `frontStencil/backStencil/color`；三份候选全部成功才交换。
- `createDefaultMaterial()` 返回与上述固定路径一致的独立材质；Raw 用户可在此基础上改 source/state。
- Raw vertex transform若改变 classification footprint，三 pass必须同步；库只检查 pass完整与实例唯一。

### 4.5 默认样式迁移

1. shape evaluator继续从 primitive system uniforms 读取 fill/stroke/ring/sector，生成 `baseColor/isStroke`。
2. 未传 `appearance` 时创建内部 `CesiumGroundMaterialAppearance({ material:createColorGroundMaterial() })`。
3. 默认 Color Material 只把 `input.baseColor` 乘公开 color/opacity乘数后返回；默认乘数为白/1，视觉等价 Current。
4. 旧 fill/stroke setters只改 system values，不替换默认或用户 appearance。
5. 自定义 Material可读取/忽略 `baseColor/isStroke`，但不能移动 shape边界。

### 4.6 surface 验收

- opaque、半透明、alpha=0 的 rectangle/polygon/circle 与 Current截图一致；
- alpha=0、ring gap、sector外与 polygon外不留 stencil；
- 低/高视角、相机 far clipping、地形/tiles/both均无弧带或漂移；
- safe Material source/version只重建 color，front/back material identity保持；
- Raw 三 pass缺一或复用实例时事务失败，旧 set仍在线。

## 5. Polyline 改造

### 5.1 保留 CPU geometry 与 VS 数学

继续使用：

- `preprocessLine()`、`buildWallArrays()`、`buildSegmentBoxAttributes()`；
- 每段 8 顶点 box与九项 geometry layout；
- `length3D` 与每段 `texNormX/texNormY`；
- RTE 起点、forward offset、start/end/right planes；
- screen/world width、miter compensation、保守 2× box；
- `czm_projection`、depth clamp、log-depth vertex；
- ApproximateTerrainHeights高度窗口。

Current 位置：`src/lib/ground/line/line-shadow-volume.ts:40-113`、`src/lib/ground/line/line-segment-attributes.ts:186-407`、`src/lib/ground/materials.ts:1088-1204`。

### 5.2 把当前 FS 拆成五个显式阶段

```text
A. packed-depth fetch and sky guards
B. terrain/model positionEC reconstruction
C. segment/width/arrow-body membership
D. ABI input construction and c23_getMaterial
E. premultiplied output
```

#### A/B：系统 depth 与天空保护

原样保留：

- viewport边界；
- `texelFetch` packed depth；
- empty/far-depth sentinel；
- WGS84 ray intersection；
- horizon distance + 512 km margin；
- `czm_windowToEyeCoordinates`。

这些 helper当前在 `src/lib/ground/materials.ts:452-539,1217-1262`。它们属于系统 membership，可在无 stencil的 polyline pass中 discard；不能让用户 safe Material覆盖。

#### C：距离与 arrow body clip

保留 start/end/right plane裁切与箭头收口，计算：

```text
distanceAlongMeters
distanceAcrossMeters
lineTotalMeters
halfWidthMeters
metersPerPixel
st=(along/total, across normalized)
```

Current aligned-plane `s/t` 在 `src/lib/ground/materials.ts:1300-1322`，arrow clip在 `:1324-1381`。改造时必须让跨 segment 的 along连续；不得把每段 `distanceFromStart` 直接暴露成全线距离。

#### D/E：Material与输出

删除主 FS 的：

- `vec4 col = u_color`；
- `mod(along,period)` 虚线分支；
- 固定 `col.rgb *= col.a`。

改成完整初始化 `c23_materialInput`，调用 Material，然后统一最终输出。system membership失败仍可 discard；Material返回透明只写零 alpha，不 discard。

### 5.3 默认纯色与虚线进入同一接口

| legacy options | 内部默认 Material |
| --- | --- |
| 无有效 `dashLengthMeters` | `createColorGroundMaterial()` |
| dash/gap 有效 | `createPolylineDashMaterial({ color:white, opacity:1, dashLengthMeters, gapLengthMeters })` |

line system `baseColor`继续由 `strokeColor/strokeOpacity` 提供。Dash Material使用
`input.distanceAlongMeters` 计算 coverage，gap返回 alpha=0；不得把虚线逻辑残留在系统 FS作为自定义旁路。

旧样式 setter兼容规则：

- `setColor()`只改 system baseColor，custom appearance不被覆盖；
- width setters只改 line geometry/membership uniforms，不重编译 Material；
- dash length/gap改变时，若 active appearance是内部默认，则原地更新内置 Material已有 uniform；若 active appearance是用户对象，只更新 legacy状态供恢复默认时使用，不改用户 Material；
- `setAppearance(undefined)`按当前最新 legacy style重建/恢复内部默认。

### 5.4 polyline safe / Raw

- safe：assembler拥有整个 VS和 FS A/B/C/E，只插入 D 的用户函数。
- Raw：factory只收到 `kind='polyline',pass='polyline'`；`createDefaultMaterial()`含全部 Current RTE/depth/sky/membership/state。
- Raw完整替换不能新增 attributes；若去掉 sky guard，保守 box染天空由用户负责。
- appearance切换只换 line mesh material；geometry、arrow mesh、arrowAppearance、shared system values、renderOrder/layer都不变。

### 5.5 polyline 验收

- solid/dash视觉、全线相位、loop seam、miter、screen/world width与Current等价；
- `distanceAlongMeters`跨 segment单调连续；`distanceAcrossMeters`符号和 `st.y`方向有测试；
- 地平线/天空不染色；terrain/tiles/both选择不漂移；
- 每帧 flow只更新 `c23_time`，`renderer.info.programs`不增长；
- line appearance切换不重建 geometry或 arrow pass。

## 6. Arrow 改造

### 6.1 保留系统部分

保留端点标架、terrain height box、RTE tip、screen/world size、packed-depth与sky guard、`(a,b)`投影、solid/open membership。Current 源码：

- geometry/attributes：`src/lib/ground/line/line-arrowhead.ts:198-406`；
- VS/FS：`src/lib/ground/materials.ts:1474-1691`；
- line/arrow mesh关系：`src/lib/ground/primitives.ts:965-1035`。

只把最后的 `u_arrowColor` 固定着色替换为 `C23_ARROW` Material input/call/output。ABI中 `st=(tip→base,left→right)`、`localMeters=(a,b)`、`metersPerPixel`有效；全线距离字段按 v1置零。

### 6.2 独立 `arrowAppearance`

- polyline `appearance`绝不隐式用于 arrow。
- 未传 `arrowAppearance`时，根据最新 `arrowColor/arrowOpacity/style`生成内部默认 Color appearance。
- `setArrowAppearance()`只候选编译/替换 arrow material；line material不变。
- `setAppearance()`只影响线体；arrowAppearance引用不变。
- user arrow Appearance可在多个 line共享，user uniform也随之共享；每 line仍有自己的 compiled arrow material与system uniforms。

### 6.3 arrow geometry变化与 compiled material

优化 Current “每次 mode/style都重建 material”的耦合：

- `left ↔ right ↔ both`：重建 arrow geometry/attributes，复用同一 compiled arrow material；更新 line收口uniform。
- solid/open style变化：style id在 geometry中，重建 geometry；Material ABI和compiled material不变。
- mode→`none`：移除并dispose arrow geometry与compiled arrow material，但保留逻辑 `arrowAppearance`引用。
- `none`→启用：构建geometry并由现有 arrowAppearance编译新 material；失败时不添加半成品arrow，line保持可见。
- color/opacity/size只改既有system values，不重建 geometry或material。

### 6.4 arrow验收

- solid/open、单端/双端、screen/world size、line收口无断口或半透明叠加；
- geometry mode/style变化不丢 arrowAppearance/user uniform引用；
- arrow Appearance切换不影响line program数；
- Raw arrow default保留 sky guard；完全替换风险有明确诊断上下文。

## 7. Decal：text / image

### 7.1 删除 color-injection 特例

迁移完成后，text/image不再传：

```ts
{
  colorMaterialFactory: createTexturedDecalColorMaterial,
  extraUniforms: { u_decalTexture, u_decalOpacity },
}
```

Current 调用点为 `src/lib/ground/text/text-primitive.ts:189-218` 与 `src/lib/ground/image/image-primitive.ts:70-84`。

改为：

1. Primitive kind设为 `decal`；仍创建固定 front/back stencil。
2. 未传 appearance时创建内部 `createTexturedDecalMaterial({ texture, opacity, tint:white, flipY:true })`。
3. safe assembler计算 `st/localMeters/baseColor/EC/normal/coverage`，Material采样 texture。
4. 自定义 Material可用 `st`与自己的 user Texture；系统不假设它必须采样 primitive texture。
5. decal透明 texel返回alpha 0，由 color pass清 stencil。

这样纯色、纹理、自定义shader都走 `compileGroundPass(kind='decal',pass='color')`，可删除 `ClassificationColorInjection`作为扩展入口；若内部过渡期保留，只能标 deprecated且不能与新 Appearance并行生效。

### 7.2 保留纹理方向与所有权

- `st`保持SW原点；内置 material的 `flipY=true`执行 `1-st.y`。
- text CanvasTexture继续 `flipY=false`、straight alpha、primitive ownership；Current设置在 `src/lib/ground/text/text-primitive.ts:277-303`。
- image URL cache继续引用计数与microtask延迟dispose；Current在 `src/lib/ground/image/image-texture-cache.ts:22-79`。
- compiled material dispose不dispose user Texture、text Texture或cached image Texture。
- 即使 custom appearance忽略 legacy image Texture，image primitive仍维持其cache lease，以便 `setAppearance(undefined)`可立即恢复默认且不改变构造契约。

### 7.3 text `setText()` 两阶段原位提交

Current 先dispose旧classification再build（`src/lib/ground/text/text-primitive.ts:121-131`）。Proposed 为文字 rectangle/shadow volume 预先保留固定 vertex/index topology；字体、内容、宽高改变时只更新数据，不替换 `BufferGeometry`、Mesh 或 compiled material。顺序固定为：

```ts
// Implementation sketch。
setText(patch) {
  ensureActive();

  // 阶段一：只构造 CPU 候选，在线 canvas/geometry 仍不变。
  const nextResolved = resolve(merge(this.resolved, patch));
  const nextPainted = paintIntoOffscreenCanvas(nextResolved);
  const nextFootprint = computeFootprint(nextResolved, nextPainted.layout);
  const candidateAttributes = buildFixedTopologyAttributeValues(nextFootprint);
  assertSameAttributeLayoutAndCapacity(this.geometry, candidateAttributes);
  const candidateSystemValues = computeDecalSystemValues(nextFootprint);

  // 阶段二：无失败操作的一次提交；所有对象 identity 保持。
  copyCanvas(nextPainted.canvas, this.canvas);
  this.texture.needsUpdate = true;
  copyAttributeValuesInPlace(this.geometry, candidateAttributes);
  markAttributesNeedsUpdateAndRefreshBounds(this.geometry);
  writeSystemUniformValuesInPlace(this.systemUniforms, candidateSystemValues);
  this.resolved = nextResolved;
}
```

实现锁定离屏候选 canvas：在排版、footprint、固定布局和数值有限性全部验证完成前，不能改变在线 canvas/texture/attributes。不能采用“先改原 canvas 再备份恢复”的路径，因为异常边界更复杂。`setText()` 不改变 source、defines 或 uniform schema，因此它本身既不调用 Raw factory，也不创建/销毁 pass material。

必须保持：

- `this.appearance`与所有user `IUniform` wrapper同一引用；
- public `group`、classification meshes、`BufferGeometry`、各 `BufferAttribute`、system/user wrapper 与 `CanvasTexture` 对象都保持稳定；
- 自定义 Appearance不会因 `setText`恢复默认；
- footprint/extents/RTE 顶点值可变化，但通过既有数组与 wrapper 原位提交；必须刷新 attribute upload flag 与既有 bounds；
- 文字更新不 dispose/rebuild compiled materials；若同一帧另有 Appearance/Material version 或 fragment-culling 失效，由常规 reconcile 独立替换相关 color pass；
- 候选需要不同 topology 或超过预声明容量时，在提交前抛明确错误，调用方必须显式新建文字图元。

### 7.4 image rebuild

若未来/桥接器因URL、footprint、rotation变化重建image delegate，顺序是：

1. 先acquire新URL lease；
2. 构建候选footprint/geometry/system map；
3. 用原appearance引用编译完整decal candidate；
4. 成功后交换children/resources，再release旧lease；
5. 失败则release新lease、dispose候选，旧image保持；
6. 同URL同步重建继续利用cache的microtask延迟。

仅opacity变化继续只改既有uniform value，Current setter证据是 `src/lib/ground/image/image-primitive.ts:120-124`。

### 7.5 decal验收

- text/image方向、mipmap、alpha与Current一致；
- 完全透明纹素与footprint外无stencil残留；
- `setText`后 geometry/attributes/meshes/group/appearance/user wrappers/CanvasTexture identity 全部稳定；
- text 候选排版或容量校验抛错时旧文字仍在 scene；image rebuild 的 factory/lease 失败仍不泄漏；
- 自定义decal Material使用自己的Texture时，primitive dispose不越权释放。

## 8. Point delegate接入

`CesiumGroundPointPrimitive`继续不创建第四种pipeline。改造点：

1. 构造器保存传入的`appearance`引用。
2. circle point传给circle delegate，square point传给rectangle delegate，image point传给image delegate。
3. `appearance` getter返回delegate当前active appearance。
4. `setAppearance(next)`直接转发，不clone/包装用户对象。
5. shape/delegate重建时把同一appearance传给新delegate；候选成功后才dispose旧delegate。
6. `setImageOpacity`继续只对image delegate生效，不覆盖custom appearance。

Current delegate分支与转发位于 `src/lib/ground/primitives.ts:709-874`。验收应覆盖三个shape，尤其避免只给point外壳加字段却未传到实际renderer。

## 9. Runtime uniform更新

### 9.1 frame state扩展

在 `CesiumGroundFrameState` 加入 [04](./04-public-api-design.md#10-cesiumgroundframestate-时间扩展) 的三个可选字段。`updateFrameStateUniforms()` 继续原地更新Current camera/depth/viewport/log值，并增加：

```ts
// Implementation sketch。
uniforms.c23_time.value = Number.isFinite(frameState.timeSeconds)
  ? frameState.timeSeconds!
  : 0;
uniforms.c23_deltaTime.value = Number.isFinite(frameState.deltaSeconds) &&
  frameState.deltaSeconds! >= 0
  ? frameState.deltaSeconds!
  : 0;
uniforms.c23_frameNumber.value = Number.isFinite(frameState.frameNumber) &&
  frameState.frameNumber! >= 0
  ? Math.floor(frameState.frameNumber!)
  : 0;
```

system map在primitive构造时就有这三个wrappers；每帧不增删key、不替换wrapper、不拼Shader字符串。

### 9.2 `SharedUniforms` 迁移

- 新内部编译函数接收按kind构建的system map类型，不要求polyline用一堆surface占位字段。
- 新 system map 的 canonical key 只允许 `czm_*` / `c23_*`。迁移期把旧 `u_color/u_border*/u_line*/u_arrow*` 等 wrapper 以新 `c23_*` key 建立引用别名；不能复制 value，也不能把 legacy `u_*` key带入与 user uniforms 的合并视图。
- 旧 `SharedUniforms` 继续从 `ground/index.ts` type-export一个兼容周期，但加 `@deprecated Use Appearance and GroundRawShaderBuildContext.systemUniforms`。
- `updateFrameStateUniforms()`可在迁移期接收结构最小接口或overload；最终不把`SharedUniforms`作为用户扩展ABI。
- system map只允许compiler/primitive创建；Raw user通过readonly context借用。

### 9.3 version侦测

每个compiled record保存：

```text
appearance identity
appearance.version
safe material identity（如适用）
material.version（如适用）
primitive pipeline revision（fragmentCull/debug/layout）
```

`update(frameState)`在完成system values写入后比较snapshot：

- 无变化：直接返回，不分配、不编译；
- shared Material version变化：每个消费primitive只重建自己的safe相关pass；
- Raw Appearance version变化：重调本primitive所需全部Raw pass factory；
- Material/Raw `dispose`事件：标记compiled stale，下一同步点释放并按当前逻辑对象重新编译；dispose不是逻辑对象终态，Material/Appearance仍可复用；
- uniform `.value`变化：不进snapshot，无重编译。

## 10. `setAppearance()` / `setArrowAppearance()`

### 10.1 共用事务函数

```ts
// Implementation sketch。
function replaceAppearance(owner, slot, requested) {
  owner.ensureActive();
  const next = requested ?? owner.createDefaultAppearanceFromCurrentLegacyStyle(slot);
  if (next === owner[slot]) return;

  const affectedPasses = owner.resolveAffectedPasses(slot, owner[slot], next);
  let candidate;
  try {
    candidate = owner.compileCandidateForPasses(next, affectedPasses);
    validateRawIdentityAgainstLiveAndCandidate(candidate, owner.compiled);
  } catch (error) {
    disposeCandidateOnce(candidate);
    throw error;
  }

  const previous = owner.captureCompiled(affectedPasses);
  owner.attachCandidate(candidate); // geometry/mesh/order/layer/visibility不变
  const previousLogical = owner[slot];
  owner[slot] = next;
  owner.disposeCompiled(previous);
  owner.disposeOnlyIfInternalDefault(previousLogical);
}
```

### 10.2 surface/decal差分

- safe→safe：只color；front/back material identity保持。
- safe→Raw、Raw→safe、Raw→Raw：构造完整front/back/color候选后一起交换，因为旧Raw可能已接管vertex/stencil。
- 任何失败不更新active appearance、不dispose旧compiled set、不改变fragmentCull。

### 10.3 line/arrow差分

- line slot只影响`polyline`pass。
- arrow slot只影响`arrow`pass；当前mode为none时只更新逻辑arrowAppearance，延迟到重新启用时编译。
- 两个slot互不隐式覆盖。

### 10.4 GPU编译限制

factory/结构/source contract错误可同步回退；WebGL真正编译通常在下一draw发生。实现应提供可选开发辅助，用宿主renderer的`compileAsync`/实际render测试候选场景，但不把renderer加入公共Raw context，也不在生产API承诺同步捕获所有GLSL错误。

## 11. `setFragmentCulling()`

Current 只替换color material并复用同一uniform map（`src/lib/ground/classification.ts:785-798`）。Proposed 保留并强化：

1. same value no-op。
2. 先以candidate boolean构建受影响材质，不立即修改active field。
3. safe surface/decal只编译color；fixed front/back不变。
4. Raw surface/decal也只重新调用`color` pass factory；`createDefaultMaterial()`捕获candidate culling define。front/back未依赖该开关，因此不重建；context不新增`fragmentCull`字段。
5. factory/validation失败：dispose候选，field与旧material保持。
6. 成功：交换material(s)，提交boolean，dispose旧compiled。
7. appearance、user uniform map、每个user wrapper、geometry与Texture引用全不变。

Raw完全替换若不调用/不派生default material，可以选择忽略fragment culling；库仍按version/rebuild契约只重调`color` factory，不改写用户源码。

## 12. 默认行为迁移矩阵

必须在删除旧FS分支前逐项迁完：

| Current 默认 | system负责 | 内置 Material负责 | Setter / rebuild |
| --- | --- | --- | --- |
| rectangle fill/border | footprint、fill/stroke判定、baseColor/isStroke | Color multiplier + output | style只改system value |
| polygon fill/border | point-in-polygon、edge distance、coverage | 同上 | 点/宽度导致geometry或system style按Current边界 |
| circle/ring/sector | radial/sector/ring判定 | 同上 | ring参数只改system可热更新时不重编译 |
| solid line | depth/sky/planes/width/along/across | Color | color/opacity value更新 |
| dashed line | 同solid | Dash phase/coverage，gap alpha=0 | dash/gap更新built-in user uniform |
| text/image | footprint、depth、stencil | texture/tint/opacity/flipY | text footprint固定拓扑原位更新；image opacity value更新 |
| arrow | depth/sky/(a,b)/solid-open membership | Color | mode/style geometry；color/size uniform |

验收原则：同一种内置 Material也能作为显式user Material传入，结果与未传appearance路径一致；不存在“默认仍走旧FS、自定义才走新ABI”的双轨终态。

## 13. renderOrder、layer 与 scene graph保护

- surface/decal仍在一个稳定`Group`内保持front/back/color连续order。
- color继续`transparent=false`进入opaque list，即使Material常返回半透明/零alpha；显式CustomBlending不变。
- polyline arrow仍为line+1；appearance切换不改order。
- 所有Ground pass Mesh继续layer=`CESIUM_GROUND_NON_PICKABLE_LAYER`，不能因创建新Mesh漏设。
- RTE geometry继续`frustumCulled=false`。
- text `setText` 保持 public group、children Mesh、geometry、attributes 与 material identity；只上传新的 attribute/canvas 数据，避免外部 parent 与缓存引用失效。
- setAppearance不创建新Group或Mesh；只换material引用。Raw pass topology固定，不能少一个Mesh。

Current layer/order证据：`src/lib/ground/classification.ts:633-650`、`src/lib/ground/primitives.ts:953-968,1012-1018`。

## 14. 生命周期与失败清理

### 14.1 compiled ownership

- safe assembler创建的每个`RawShaderMaterial`由primitive dispose。
- Raw factory返回物同样由primitive dispose。
- user Appearance/Material/Texture不因primitive切换/dispose而dispose。
- system packed depth为borrowed。
- geometry只在真正geometry rebuild或primitive dispose时释放。

### 14.2 去重dispose

模块级持久 WeakMap 在 factory 返回后立即 claim Raw material identity，拒绝跨 pass、图元、Appearance 和历史 rebuild 复用；候选内 identity Set 仍保证失败清理只 dispose 一次。如果该 identity 等于任一 live material，则不能 dispose 它，只抛`GROUND_RAW_MATERIAL_REUSED`并保留在线对象。

### 14.3 通知式 logical dispose

`CesiumGroundMaterial.dispose()` / Raw Appearance.dispose发通知：

1. 每个consumer把自己的compiled records标stale；
2. 在安全同步点dispose自己持有的Three materials；
3. 若逻辑对象仍绑定，按其当前source/defines/uniforms/factory重新编译；
4. logical object、监听关系与user Texture保持可复用，不进入永久disposed状态。

primitive自身`dispose()`仍是终态，后续update/setter抛use-after-free。

### 14.4 错误上下文

所有结构/工厂错误至少附：

```text
error code
primitiveKind
pass
appearance kind
material type/uuid（safe）
ABI version
conflicting identifier或factory result detail
```

不能吞错并静默回退默认appearance；否则用户以为custom Shader生效，实际画的是旧样式。

## 15. `PlotPrimitiveBridge` 兼容

plot仍非公开npm入口。只做以下仓库内适配：

- `_buildPrimitive()`不传appearance时自然获得内部默认，所有Current category映射不变；Current映射在 `src/lib/plot/PlotPrimitiveBridge.ts:468-672`。
- `_refreshLightweight()`的line color/width/arrow size、text setText、image opacity继续工作且不覆盖custom appearance；Current位置 `:371-457`。
- bridge的geometry/style signature不加入Material动画时间；时间由每帧`update(frameState)`统一转发（`:342-354`）。
- 首期不在plot snapshot/options正式增加Material序列化字段；业务若直接使用公开Ground primitive，可自行绑定Appearance。
- 不新增plot animation snapshot或内部request-render调度。

## 16. 公共导出与构建收尾

实现完成后：

1. `src/lib/ground/index.ts`导出[04](./04-public-api-design.md)全部Material/Appearance/types/builtins。
2. 根`src/cesium-three-ground.ts`现有`export * from './lib/ground'`自动带出。
3. 不新增package subpath；现有`.`与`./ground`均可导入。
4. `SharedUniforms`保留type export但加deprecated说明。
5. `ClassificationColorInjection`、old anchor builders从公共/内部调用链移除后再删；迁移期间不得让同一primitive同时应用old injection与new appearance。
6. 通过`npm run type-check`、`npm run build`、`npm run build:lib`，并检查两处生成的`.d.ts`。

Current导出/构建依据：`src/lib/ground/index.ts:1-63`、`src/cesium-three-ground.ts:1-9`、`vite.lib.config.ts:21-29`。

## 17. 推荐实际编码顺序

本篇按pipeline解释；真正落地仍按以下依赖顺序，确保每步可回退：

1. 记录Current默认截图、pass state与program count基准。
2. 实现公共Material/Appearance/types/validation，不接图元。
3. 实现ABI source与assembler快照测试。
4. 实现compiler、pass矩阵、uniform merge、Raw factory校验。
5. 先用新assembler生成与Current相同的fixed stencil/default surface color；双后端测试。
6. surface默认迁入Color Material，再开放safe/Raw appearance。
7. polyline拆FS，迁纯色与dash，开放safe/Raw。
8. arrow拆最终着色并接独立arrowAppearance。
9. decal迁TexturedDecal Material，重写text/image两阶段rebuild。
10. point完整透传。
11. 加时间uniform与version侦测；接入内置动态预设。
12. 完成setAppearance/fragmentCull/dispose事务和失败测试。
13. 更新demo、exports、类型与build。
14. 默认/自定义路径全绿后删除anchor replace和旧injection旁路。

详细阶段、回退点与commit粒度以 [09](./09-implementation-roadmap.md) 为准。

## 18. 示例伪代码：运行时同步

> **Implementation sketch：**展示Primitive内部顺序，不是公共调用代码。

```ts
update(frameState: CesiumGroundFrameState): void {
  this.ensureActive();

  updateCameraRteInPlace(frameState, this.systemUniforms);
  updateFrameStateUniforms(frameState, this.systemUniforms);
  this.systemUniforms.czm_globeDepthTexture.value =
    resolveClassificationDepthTexture(frameState, this.classificationType);

  if (this.compiledSnapshot.matches(
    this.appearance,
    this.pipelineRevision,
  )) {
    return; // uniform values已更新；不分配、不拼Shader、不needsUpdate
  }

  const candidate = this.compileCandidateForCurrentAppearance();
  this.swapCompiledAtomically(candidate);
}
```

宿主仍负责渲染循环：

```ts
const deltaSeconds = clock.getDelta();
frameState.timeSeconds = clock.elapsedTime;
frameState.deltaSeconds = deltaSeconds;
frameState.frameNumber = frameNumber++;

for (const primitive of primitives) primitive.update(frameState);
renderer.render(scene, camera);
```

库不创建上面循环，也不调用`requestAnimationFrame`。

## 19. 关键决策

1. **先把默认行为迁入Material，再开放自定义。** 避免两个长期分叉的FS后端。
2. **系统membership与用户着色分段。** surface shape、polyline depth/sky/planes、arrow membership留在库；Material只消费稳定input。
3. **classification color零alpha清stencil。** shape/material透明都不discard；front/back log-depth discard单独保留。
4. **Raw切换按完整pass set事务提交。** safe↔Raw时不能只换color，因为旧/新Raw可能接管vertex/stencil。
5. **几何数据更新不等于对象重建或 Material 重编译。** arrow mode/style按现有 topology 边界处理；text footprint 在固定 topology 的既有 attribute/system wrapper 中原位更新，geometry、compiled material、logical appearance 与 user wrappers 都保持。
6. **通知式dispose可复用。** logical dispose触发consumer释放compiled，不终结Material。
7. **时间只是system uniform。** 没有动画调度层，持续帧由宿主决定。

## 20. 边界条件与失败模式

- safe Material的GPU语法错误可能延迟到draw；同步事务只能覆盖assembler/factory/结构错误。
- Raw factory如果修改default material的`transparent`/stencil/depth状态，库不恢复；开发模式给风险提示。
- surface/decal custom Raw color若discard，会残留stencil；这是Raw责任。
- visual scale大于footprint会被coverage裁掉；不能通过Material修改geometry。
- shared Material version变化会让多个primitive分别重建compiled material；这是预期，Three program cache应复用相同program。
- hidden primitive恢复可见前必须刷新当帧camera/depth/time；不能用隐藏前的stale system值绘制一帧。
- text候选离屏canvas会有一次额外CPU内存；这是换取失败可回退与在线Texture引用稳定的明确选择。
- image新URL加载是异步；geometry/material可先交换，但TextureLoader失败继续使用Current透明fallback策略，不抛破坏scene的异步异常。
- point shape切换若创建新delegate失败，旧delegate和appearance继续在线。
- same Appearance传给line与arrow合法，但分别以不同kind编译；`arrowAppearance`仍是显式slot，不自动继承line。

## 21. 验收清单

### 21.1 结构

- [ ] assembler只拼显式sections，不再用字符串锚点replace。
- [ ] `compileGroundPass`与kind/pass矩阵、uniform merge、Raw独立实例校验有单测。
- [ ] 默认Color/Texture/Dash与自定义Material走同一compiler。

### 21.2 surface/decal

- [ ] front/back固定state、RTE与log-depth行为未变。
- [ ] color保持`NotEqual`、三处`ZeroStencilOp`、`transparent=false`和预乘混合。
- [ ] shape外、alpha=0、透明texel不discard且能清stencil。
- [ ] safe只重建color；safe↔Raw按完整三pass set切换。
- [ ] text/image rebuild保持appearance、user wrapper和group identity；失败保留旧画面。

### 21.3 polyline/arrow

- [ ] packed-depth、sky guard、horizon、planes、miter与width模式保持。
- [ ] `s/t`正式映射到ABI且全线距离连续。
- [ ] dash已从系统FS移到内置Material。
- [ ] arrow使用独立appearance；mode/style几何变化不丢逻辑引用。
- [ ] line与arrow appearance切换互不重建对方geometry/material。

### 21.4 runtime/lifecycle

- [ ] time/delta/frame只原地更新system wrappers，缺省静态零。
- [ ] uniform `.value`变化不增加program数或version。
- [ ] source/defines/schema/Raw needsUpdate只重建预期pass。
- [ ] `setAppearance`、`setFragmentCulling`和version rebuild均先候选后交换。
- [ ] candidate失败不dispose live material；所有候选资源恰好dispose一次。
- [ ] primitive dispose只释放geometry/compiled materials，不释放用户Material/Appearance/Texture或depth Texture。
- [ ] logical Material/Raw dispose为通知式，可继续复用。
- [ ] renderOrder、layer、visibility、classificationType与geometry在appearance切换中保持。

### 21.5 构建与发布

- [ ] 新符号从根入口和`cesium-to-three/ground`均可导入。
- [ ] plot未成为新npm subpath，桥接器Current行为不回归。
- [ ] `npm run type-check`、`npm run build`、`npm run build:lib`通过。
- [ ] 全实现没有timeline、tween、内部Clock或内部RAF。

---

上一篇：[05 · Shader ABI](./05-shader-abi.md)  
下一篇：[07 · 内置效果](./07-built-in-effects.md)
