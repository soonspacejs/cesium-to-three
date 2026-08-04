# 09. 实施路线图：14 个可独立验证阶段

> 状态：**Implemented Roadmap**。14 个阶段均已落地；本篇保留实施顺序、回退边界和最终验收证据，供后续维护与回归定位。

## 目标

把 Ground Material/Shader 扩展拆成 14 个有明确依赖、验收点和回退边界的阶段。实现者应按顺序提交，每个阶段都保持默认视觉和现有 setter 可用；任何阶段失败都能回退到上一个已验收状态，而不用撤销更早的基础设施。

前置阅读：

- [03. 目标架构](./03-target-architecture.md)
- [04. 公共 API](./04-public-api-design.md)
- [05. Shader ABI](./05-shader-abi.md)
- [06. 管线接入](./06-render-pipeline-integration.md)
- [07. 内置效果](./07-built-in-effects.md)
- [08. 生命周期与缓存](./08-lifecycle-cache-resources.md)

非目标：

- 本路线不引入 timeline、tween、动画状态机、内部 RAF 或序列化格式。
- 不把 `plot` 层变成首期公共 API；只保证 Ground primitive 层完整。
- 不在迁移期间顺带重写几何算法、RTE、packed depth、classification depth 或 picking。
- 不以一次大改替换全部管线；每个阶段必须能单独比较和回退。

## 1. 当前基线与全局约束

### 1.1 源码基线

行号基于当前项目提交 `32a6b244b7c0cb731ca35165c46e8fe31248c718`：

- surface 三命令由 `CesiumClassificationPrimitive` 构造，front/back/color 材质创建点在 `src/lib/ground/classification.ts:479-614`；`setFragmentCulling` 目前只重建 color material，见 `790-798`。
- Shader 仍通过字符串 `replace` 和 main 重命名拼装，见 `src/lib/ground/materials.ts:149, 651-753, 793-820, 941-994`。
- polyline 主材质和 arrow 附加材质分别创建于 `src/lib/ground/primitives.ts:926-1018`，销毁路径在 `1025-1034, 1301-1309`。
- polyline 虚线逻辑仍硬编码于 `src/lib/ground/materials.ts:1383-1399`。
- text 的 `setText()` 会重建 classification，见 `src/lib/ground/text/text-primitive.ts:99-126`；image 的 texture handle 引用计数与延迟释放位于 `src/lib/ground/image/image-texture-cache.ts:22-74`。
- point 当前只是 circle/rectangle/image delegate，转发点位于 `src/lib/ground/primitives.ts:722-873`。
- 根入口和 `./ground` 当前最终都经 `src/lib/ground/index.ts:9-63` 与 `src/cesium-three-ground.ts:9` 导出。
- `package.json:31-37` 目前只有 build/type-check 脚本，没有自动测试脚本；Three 依赖是 `^0.183.0`，见 `package.json:39-45`。

本地参考源码提交固定为 Three `2a005fdbad6b8503a8a70edfdd279b79c5e04b49` 与 Cesium `effe290c08dc340a7a6bd4435367a7d092c6b2b9`；实现期间若升级依赖，先重新跑阶段 1 基线，不直接套用旧截图。

### 1.2 已落地模块布局

```text
src/lib/ground/material/
├── types.ts                 # public/protected types、primitive kind、pass
├── CesiumGroundMaterial.ts  # 逻辑 Material、version、clone、dispose
├── appearances.ts           # safe 与 Raw 两套同级 Appearance
├── shader-abi.ts            # struct/system uniform/define 常量
├── shader-assembler.ts      # 显式分段组装，不做字符串锚点替换
├── compiler.ts              # logical -> per-pass RawShaderMaterial
├── validation.ts            # 保留前缀、schema、Raw pass 校验
├── builtins.ts              # 六个内置工厂
└── index.ts                 # material 子系统内部出口
```

当前 `src/lib/ground/materials.ts` 在迁移期保留为旧编译后端和固定 render-state 来源；每接通一条管线就把对应 Shader body 转移给 assembler。到阶段 14 才删除不再引用的字符串锚点函数，避免中途失去可回退实现。

### 1.3 所有阶段必须保持的规则

1. 先补测试，再切运行路径；一个阶段只迁一类行为。
2. 用户 uniform `.value` 更新不换 map、不设置 `needsUpdate`、不重建几何。
3. safe Appearance 只进入 color/polyline/decal/arrow 着色阶段；surface front/back stencil 固定。
4. surface/decal 的透明 Material 结果输出零 alpha，不能 `discard`，以保留 stencil 清理。
5. Raw Appearance 每个 pass 返回独立 `RawShaderMaterial`；若改 vertex classification，用户负责各相关 pass 一致。
6. 内部编译材质由 primitive 销毁；逻辑 Material 与其 uniform Texture 均不由 primitive 销毁。
7. 每阶段结束都运行 `npm run type-check`、相关测试；涉及导出或打包时再运行两个 build。

### 1.4 设计过程与依赖顺序

```text
1 baseline
  -> 2 logical types/classes
  -> 3 ABI + assembler/compiler
  -> 4 default surface
  -> 5 safe surface
  -> 6 raw surface
  -> 7 polyline inputs/default
  -> 8 dash + flow
  -> 9 arrow
  -> 10 text/image decal
  -> 11 point delegate
  -> 12 time + pulse/scale
  -> 13 demo + exports + docs
  -> 14 deprecations + legacy cleanup
```

## 2. 十四阶段实施清单

## 阶段 1：建立默认渲染与行为基线

**前置依赖：** 无；必须在生产代码改动前完成。

**模块与符号：**

- 新建 `tests/ground-material/fixtures/`：固定相机、packed-depth fixture、surface/polyline/arrow/text/image/point 场景。
- 新建 Vitest 单元测试配置与 Playwright Chromium WebGL2 渲染配置。
- 在 `package.json` 增加 `test:unit`、`test:integration`、`test:visual`、`test:perf`，不改变现有 build 脚本。

**操作顺序：**

1. 记录当前提交、Three 版本、浏览器/显卡信息和 deterministic renderer 参数：固定 DPR=1、尺寸、相机、颜色空间、随机种子。
2. 为 rectangle、polygon（含 hole/stroke）、circle（含 ring/sector）、solid/dash polyline、两类 arrow、text、image、三种 point delegate 截取 goldens。
3. 记录 `setFragmentCulling`、`setText`、line setters、arrow rebuild、visible/renderOrder、dispose 的对象身份和资源计数。
4. 记录 warm-up 后 `renderer.info.programs`、`renderer.info.memory.geometries/textures` 与 600 帧空更新基线。
5. 在 CI 不能访问真实 terrain/3D Tiles 时使用合成 packed depth；真实数据作为本地/发布前手工矩阵。

**兼容处理：** 只新增测试资产和 devDependencies，不修改运行时。golden 允许的平台容差在 [10](./10-test-and-acceptance.md) 固定，不能由实现者临时放宽。

**阶段验收：** 所有现有 build 通过；测试能在故意改一处颜色、虚线相位或 stencil 状态后失败；基线清单和截图有明确版本元数据。

**回退边界：** 可完整删除测试配置/资产而不影响生产包；后续阶段不得重录基线掩盖回归，除非独立评审确认预期视觉变化。

## 阶段 2：新增 Material/Appearance 类型，但不接图元

**前置依赖：** 阶段 1。

**模块与符号：**

- `CesiumGroundMaterial`、`CesiumGroundMaterialOptions`。
- `CesiumGroundMaterialAppearance`、`CesiumGroundRawShaderAppearance`。
- `GroundPrimitiveKind`、`GroundRenderPass`、`GroundRawShaderBuildContext`、`CesiumGroundAppearance`。
- `assertUserUniformName`、`cloneGroundUniforms`、`computeLogicalMaterialKey`。

**操作顺序：**

1. 先实现 uniform 名校验：拒绝 `czm_`、`c23_`，允许普通 `u_*`；拒绝空名和无效 GLSL identifier。
2. 实现 Material 构造、只读 `uuid/version`、`setUniform`、`needsUpdate`、`clone`、`dispose` 事件。
3. `setUniform` 只允许已有 schema 名并改 `.value`；新增/删除字段必须由调用方显式修改 schema 后设置 `needsUpdate=true`。
4. `needsUpdate=true` 每次递增 version；设置 false 无动作。源码/defines/schema 的 compile key 不包含 uniform value。
5. 实现两个 Appearance 的纯数据层；Raw 只保存 factory，此阶段不调用。
6. `dispose()` 采用 Three 风格的可重复释放通知：不永久标记逻辑对象失效，不改 version；仍绑定的消费者释放自己的 compiled records 后可在下一 reconcile 重建。
7. 增加单元测试，但暂不从包根公开，也不修改 primitive options。

**兼容处理：** `SharedUniforms` 和现有 `ClassificationColorInjection` 原样保留；新类完全隔离，确保默认截图与 program 数不变。

**阶段验收：** clone 严格符合 `UniformsUtils.clone()`（普通 Texture 生成副本、RenderTargetTexture 告警并置 `null`）；共享 Material 时 `.value` 同步可见；reserved prefix、version、可重复 dispose 通知与 cache key 测试全部通过。

**回退边界：** 只删除 `material/` 中本阶段文件与测试；没有运行时调用点。

## 阶段 3：建立显式 Shader ABI、assembler 与 compiler

**前置依赖：** 阶段 2。

**模块与符号：**

- `C23_GROUND_SHADER_ABI_VERSION`、`C23_SYSTEM_UNIFORM_NAMES`。
- `assembleGroundVertexShader`、`assembleGroundFragmentShader`。
- `createMaterialInputSource`、`createFinalOutputSource`、`mergeGroundUniforms`。
- `compileGroundPass`、`GroundCompiledMaterial`。

**操作顺序：**

1. 把 `c23_materialInput`、`c23_material`、三个时间 uniform 和四个 `C23_*` define 固定为常量片段。
2. assembler 按顺序连接：GLSL version/defines → system prefix → attributes/varyings → depth/shape stage → material source → final output；不搜索或替换任意 Cesium 源码锚点。
3. 对每个 primitive kind 初始化 ABI 全字段；不适用字段写零。
4. final output 固定 `straightRgb = diffuse + emission`、`premultipliedRgb = straightRgb * alpha`。classification 路径对零 alpha 也必须写输出。
5. 建立完整 legacy→canonical adapter：`SharedUniforms` 中 `u_color/u_border*/u_line*/u_arrow*` 等只通过同 wrapper 引用映射为 `c23_*`；目标 `GroundSystemUniforms`/Raw context 只暴露 `c23_*`/`czm_*`，legacy `u_*` 不进入 user merge。
6. uniform merge 先 canonical system、后经过校验的 user；发现同名即报错，不静默覆盖。专测内置 user `u_color` 与旧 system `u_color` 不冲突。
7. compiler 为每个 pass 创建独立 `RawShaderMaterial`，compile key 包含 ABI 版本、kind、pass、source、defines、schema/layout，不含 value。
8. 用 snapshot/结构断言覆盖 surface 三 pass、polyline、decal、arrow；运行时仍走旧 `materials.ts`。

**兼容处理：** assembler 生成的固定 render state 先复用当前 `createStencilMaterial/createColorMaterial/createPolylineMaterial` 参数，避免在同一阶段改变 Shader 与状态。

**阶段验收：** 所有组装结果可由 WebGL2 编译；无字符串锚点 `replace`；相同输入生成稳定 key；uniform value 改变不改变源码/key；classification finalizer 中没有 Material 级 `discard`。

**回退边界：** compiler 尚未接入场景，可整体移除而不影响旧管线。

## 阶段 4：rectangle/polygon/circle 接入默认 Color Material

**前置依赖：** 阶段 3。

**模块与符号：**

- `createColorGroundMaterial`。
- `CesiumClassificationPrimitive` 的内部 appearance/compiler 路径。
- surface shape stage：fill/border、polygon border、circle ring/sector。

**操作顺序：**

1. 先把当前 color body 的 shape 计算拆成确定的 system stage，产出 `input.baseColor` 和 `input.isStroke`。
2. front/back stencil 继续调用固定实现；只把 color pass 切到 assembler + 默认白色乘数 Color Material。
3. rectangle 先切换并跑视觉基线，再切 polygon，最后 circle；每个子步骤单独提交。
4. 把现有颜色/透明度 setter 指向同一 system uniform 对象，不能改为创建新 Material。
5. `setFragmentCulling` 仍只重建 color compiled material，复用逻辑 Material 和 user uniform map。
6. 三种 primitive 全通过后才删除对应旧 color body 的运行时引用；函数本身暂留至阶段 14。

**兼容处理：** 未传 appearance 时才创建内部默认 Color Material；旧 `fillColor/strokeColor/*Opacity` 的解析、百分比口径、render order 和 classificationType 不变。

**阶段验收：** 三种 surface 的 golden 在容差内；front/back material 身份和 stencil 状态不变；颜色 setter 与 fragment-culling 不重建 geometry；透明区域无 stencil 残留。

**回退边界：** 把 color factory 路由切回旧 `createColorMaterial`；保留阶段 2/3 基础设施与测试。

## 阶段 5：接入 surface 安全 Material Appearance

**前置依赖：** 阶段 4。

**模块与符号：**

- surface options 的 `appearance?: CesiumGroundAppearance`（本阶段只接受 safe 实例）。
- primitive `appearance` getter、`setAppearance()`。
- `CesiumClassificationPrimitive.setAppearance()` 与 color compiled-material replacement。

**操作顺序：**

1. 给 rectangle/polygon/circle option 与实例加字段，但 point 暂不转发。
2. 构造时把 safe Material 注入 color pass；front/back 仍固定且完全不调用 `c23_getMaterial`。
3. `setAppearance` 先校验 kind/schema，再创建新 color material；同步 assembler/factory 全部成功后原子替换并 dispose 旧 compiled material。
4. 保持 geometry、stencil mesh、system uniform、user uniform 对象身份；同步候选失败时旧 appearance 继续工作。GPU 惰性编译失败沿用 Three 日志，v1 不自动回滚。
5. 监听逻辑 Material version；只在 version 变化时延迟重编译相关 color pass。
6. 验证自定义 `c23_getMaterial` 可读完整 surface ABI，零 alpha 仍完成 stencil 清理。

**兼容处理：** 未传 appearance 完全沿用阶段 4 默认。传统 style setter 继续更新 `input.baseColor`；自定义 Material 是否使用该值由用户决定。

**阶段验收：** safe custom Shader 在三种 surface 上工作；每帧 uniform 更新不增加 program；source/define/schema 变化只重建 color；切换 appearance 不闪烁、不丢 uniform 引用、不动几何。

**回退边界：** 可停止读取 `appearance` 并回到默认 Color 路径；类型在尚未公开前可一同撤销，不影响旧调用。

## 阶段 6：接入 surface Raw Appearance 三 pass

**前置依赖：** 阶段 5。

**模块与符号：**

- `GroundRawShaderBuildContext` 的 `frontStencil`、`backStencil`、`color`。
- `createDefaultMaterial()` 与 Raw factory 调度。
- 开发模式 `validateRawPassMaterial`。

**操作顺序：**

1. 按 front → back → color 分别构造 context，并提供相同 canonical system wrappers、用户 uniforms 和惰性的默认材质创建函数。
2. 每次 factory 调用必须返回一个独立 `RawShaderMaterial`；模块级持久 WeakMap 检测跨 pass、跨图元、跨 Appearance、跨 rebuild 的实例复用，同时检测 null、错误 pass 和 reserved uniform 冲突。
3. 锁定两种合法模式：调用一次 `createDefaultMaterial()`、原地修改并返回同一实例；或零次调用并完全替换 vertex/fragment/state。二次调用或调用后返回另一实例必须清理未转移候选并报错。
4. `setAppearance` 原子创建并替换三份材质；任一 pass 失败则 dispose 本次已创建产物并保留旧三件套。
5. 明确用户改 vertex classification 时必须同步 front/back/color；开发模式只告警/报错明显缺失，不尝试改写用户 Shader。
6. dispose 时销毁 factory 返回的三份 compiled material，不销毁 Raw Appearance 或其 Texture。

**兼容处理：** safe Appearance 与默认路径不变；Raw 是显式选择的高风险入口，不为自定义 state 提供视觉兼容保证。

**阶段验收：** 修改默认 color 的 Raw 示例可用；完整替换三 pass 示例可用；错误工厂不会让场景留半套 mesh/material；classification 透明清理与低视角天空裁切通过。

**回退边界：** 禁用 Raw 分支即可回到阶段 5；safe/default 不依赖 Raw factory。

## 阶段 7：改造 polyline ABI 与默认纯色 Material

**前置依赖：** 阶段 6；依赖已稳定的 assembler/compiler，但不依赖 surface Raw 的业务逻辑。

**模块与符号：**

- polyline ABI varying：`st`、`distanceAlongMeters`、`distanceAcrossMeters`、`lineTotalMeters`、`metersPerPixel`。
- `C23_POLYLINE` assembler 分支。
- `CesiumGroundPolylinePrimitive.appearance/setAppearance()`。

**操作顺序：**

1. 从当前 FS 的 `s/t`、widthwise distance 和 `u_lineTotalMeters` 提取稳定 varying/局部值，先用测试对比旧变量与新 ABI 数值。
2. 保留 terrain depth 重建、三平面裁切、arrow 端点收口与 log depth system stage。
3. 将 `vec4 col=u_color` 移到默认 `createColorGroundMaterial`，外层统一预乘与混合。
4. 接入 safe appearance；再接入 Raw 的单 `polyline` pass。
5. `setColor/setWidth/setWidthMode` 等现有 setter 继续原地更新 system uniform；appearance 切换不重建 line geometry。
6. 暂时保留旧 dash 分支，阶段 8 再移除。

**兼容处理：** 无 appearance 且无 dash 时视觉完全相同；debugVolume 是 system/debug path，不进入用户 Material。

**阶段验收：** 多段线的 `distanceAlongMeters` 全线单调连续；screen/world width、相机入盒、分类深度、箭头收口与默认颜色回归通过；custom Material 可显示沿/横向渐变。

**回退边界：** 把 polyline material 创建点切回 `createPolylineMaterial`；surface 阶段不受影响。

## 阶段 8：迁移虚线并接入 FlowLine

**前置依赖：** 阶段 7。

**模块与符号：**

- `createPolylineDashMaterial`、`createFlowLineMaterial`。
- `resolvePublicLineOptions` 的默认 appearance 选择。
- 从旧 `POLYLINE_FS` 删除 dash uniform 分支。

**操作顺序：**

1. 先用新 Dash Material 重现当前 `mod(along, period)` 行为，并加入跨 segment、负 offset、零 gap 测试。
2. 仅当用户未传 appearance 且旧 options 启用 dash 时，内部创建 Dash Material；旧 options 继续是事实入口。
3. 切换默认 dash 路由后，从 system main FS 移除 `u_lineDashEnabled/*Length*` 的着色逻辑；兼容 uniform 可暂留 inactive。
4. 实现 FlowLine 的固定六 uniform 与时间公式；`speed` 为 cycles/second、direction 规范化为 ±1。
5. 以 30/60/120 FPS 输入同一组绝对 `timeSeconds`，比较输出相位。
6. 运行 600 帧 program 稳定性与共享 Material 测试。

**兼容处理：** 旧 dash 参数优先级仅在无显式 appearance 时生效；显式 appearance 完全接管颜色/虚线。polyline 无 stencil，但 Material gap 仍返回零 alpha，不在材质函数中 `discard`。

**阶段验收：** 旧虚线视觉等价；全线相位连续；FlowLine 方向、repeat、拖尾和透明背景正确；只改时间/speed 不产生新 program。

**回退边界：** 恢复旧 dash FS 分支和默认路由；保留阶段 7 ABI，Flow 工厂可暂时保持未导出。

## 阶段 9：接入独立 arrow appearance

**前置依赖：** 阶段 8。

**模块与符号：**

- `CesiumGroundPolylineOptions.arrowAppearance?`。
- `C23_ARROW`、Raw `arrow` pass。
- arrow compiled-material 创建/替换路径；如 04 所定的专用 setter 则同时实现。

**操作顺序：**

1. 将当前 arrow color 输出迁为默认 Color Material；几何里的 `arrowStyleId` 与 solid/open 裁切保持 system stage。
2. 让 line `appearance` 与 `arrowAppearance` 独立；没有后者时继续由现有 `arrowColor/arrowOpacity` 生成默认材质。
3. safe arrow material 构造完整 ABI；不适用的全线字段按 05 约定为零或可用的端点局部值。
4. Raw factory 使用 `primitiveKind:'arrow'`、`pass:'arrow'`，每次返回独立 material。
5. `setArrowMode/setArrowStyles` 重建 geometry/mesh 时重新绑定原 `arrowAppearance`，不 clone、不丢 user uniform。
6. `setArrowColor/size` 仍更新 system uniform；自定义材质是否读取 baseColor 由用户决定。

**兼容处理：** 未传 `arrowAppearance` 时 solid/open、两端异样式、line 收口和 renderOrder+1 全部不变。

**阶段验收：** line 和 arrow 可使用不同 safe/Raw appearance；半透明重叠不翻倍；NONE↔BOTH 与 style rebuild 后逻辑 appearance、uniform、Texture 引用保持；dispose 只销毁 compiled arrow material。

**回退边界：** arrow 创建点切回旧 `createArrowHeadMaterial`；line material 与此前阶段不回退。

## 阶段 10：迁移 text/image 的 TexturedDecal Material

**前置依赖：** 阶段 9。

**模块与符号：**

- `createTexturedDecalMaterial`、`C23_DECAL`。
- `CesiumGroundTextPrimitive.buildClassification()`、`setText()`。
- `CesiumGroundImagePrimitive` 与 `ImageTextureHandle`。

**操作顺序：**

1. 先把当前 `u_decalTexture/u_decalOpacity` 采样变为内置 TexturedDecal Material，保持 `flipY=false` Texture + Shader V 翻转。
2. text 迁移后验证 glyph、背景、透明边与 mipmap；再迁 image，避免两类纹理问题混在一次提交。
3. surface front/back 继续固定；decal Material 只替换 color pass，透明 texel 返回 alpha 0 而非 `discard`。
4. 给 text/image 接入 safe 与 Raw appearance；内部默认材质持有 borrowed texture uniform。
5. 为 text rectangle/shadow-volume 固定 topology；`setText` 先在离屏 canvas 计算候选，再把 RTE position、extrude/extents 复制进既有 attribute 数组，原地更新 system uniform value 与同一 CanvasTexture。不得替换 geometry/classification/group/appearance/user wrapper，也不得因文字内容重建 compiled material。
6. image opacity setter 更新已有 material uniform；URL cache 的 acquire/release 次数不因 appearance 切换改变。

**兼容处理：** 默认文字/图片的方向、颜色、opacity、纹理缓存和失败透明兜底完全一致；历史 `u_textTexture` 仅兼容保留，不再作为新扩展 ABI。

**阶段验收：** `setText` 后 geometry/attribute/mesh/group/CanvasTexture/appearance/user uniform identity 全部不变，仅 buffer/texture 上传内容变化；`setFragmentCulling` 只换 color material；透明 texel 无 stencil 残留；同 URL 引用计数正确；primitive dispose 不销毁用户纹理。

**回退边界：** text/image 各自可单独切回现有 `ClassificationColorInjection`；texture cache 不需要回退。

## 阶段 11：完成 point delegate 透传

**前置依赖：** 阶段 10，确保三种 delegate 都已经支持 appearance。

**模块与符号：**

- `CesiumGroundPointPrimitiveOptions.appearance?`。
- `CesiumGroundPointPrimitive.appearance`、`setAppearance()` 的 delegate 转发。

**操作顺序：**

1. 构造 circle/square/image delegate 时逐字段透传同一 appearance 实例。
2. getter 始终返回 delegate 当前值，而不是 point wrapper 的过期副本。
3. `setAppearance` 转发给 delegate；切换 shape 需要重建 delegate 的现有业务路径时，也必须重新绑定原实例。
4. 分别验证 circle→surface、square→surface、image→decal 的 kind 校验和错误消息。
5. point dispose 只调用 delegate dispose 一次，不 dispose 逻辑 Material。

**兼容处理：** 无 appearance 时继续按现有 shape 委托，`setImageOpacity` 只对 image 生效的行为不变。

**阶段验收：** 三种 point 均可使用 default/safe/Raw；getter/setter 与 delegate 同步；无双重 dispose、无 texture 引用计数泄漏。

**回退边界：** 移除 wrapper 透传即可；底层 primitive 的 appearance 能力保留。

## 阶段 12：接入时间 uniform、PulsePoint 与 ScalePulse

**前置依赖：** 阶段 11。

**模块与符号：**

- `CesiumGroundFrameState.timeSeconds?`、`deltaSeconds?`、`frameNumber?`。
- system uniforms：`c23_time`、`c23_deltaTime`、`c23_frameNumber`。
- `createPulsePointMaterial`、`createScalePulseMaterial`、内建 `u_footprintScale`。

**操作顺序：**

1. 先扩展 FrameState 类型和 system uniform 初始化；缺省全部写 `0`，旧宿主无需修改。
2. 在 `updateFrameStateUniforms` 原地更新三个 float value；不替换 uniform map，也不触发 Material version。
3. 实现 PulsePoint 的周期/scale/opacity/phase 和径向 coverage；按 `u_footprintScale` 把名义半径映射到预分配 footprint。
4. 实现 ScalePulse 的可选 texture、tint、opacity、UV 反变换和相同 footprint 规则；有无纹理使用 uniform 分支而非 define。
5. factory 构造时令 `footprintScale=max(1,maxScale)`（或采用显式更大高级值），并拒绝运行目标超出预分配上限。
6. demo harness 用宿主 `THREE.Clock` 提供绝对秒；库中全局搜索确认没有 RAF/timer/request-render 调用。
7. 覆盖共享 Material 同步、clone 独立 `u_phase`、request-render 静止/持续两种宿主模式。

**兼容处理：** 不传时间时所有动画停在 `t=0` 的确定画面；旧 host object 结构继续通过类型检查。材质缩放不改变 geometry/bounds/pick。

**阶段验收：** 相同绝对时间跨 FPS 像素一致；Pulse/Scale 不越预分配 footprint；ECEF 原点无漂移；600 帧不增加 program/geometry/texture。

**回退边界：** 保留可选 FrameState 字段但停止注入预设即可；所有静态/default 材质不依赖非零时间。

## 阶段 13：补 demo、正式导出与文档示例

**前置依赖：** 阶段 12，所有运行路径已通过测试。

**模块与符号：**

- `src/lib/ground/material/index.ts` 与 `src/lib/ground/index.ts` 公共导出。
- 根入口 `cesium-to-three`、子入口 `cesium-to-three/ground`。
- ground demo：FlowLine、PulsePoint、ScalePulse、自定义 `c23_getMaterial`、完整 Raw 三 pass。

**操作顺序：**

1. 从 `./ground` 导出 classes、appearance、types、六个 factories；根入口通过现有 re-export 得到同一符号。
2. 增加 compile-time import smoke 和构建后 package import smoke，检查 `.d.ts` 与 JS 对齐。
3. demo 复用既有宿主渲染回调和单个 `THREE.Clock`；活动效果只由 demo 宿主持续请求帧。
4. 示例分别展示共享同步、clone 相位、`setUniform`、`setAppearance`、Texture 主动 dispose。
5. 更新中英文 README 的 Docs 链接；详细设计正文保持中文。
6. 执行 type-check、app build、library build、测试全矩阵和 `npm pack --dry-run`。

**兼容处理：** 新导出只增不删；旧 import path、默认 style options、现有 bundle entry 不变。

**阶段验收：** 两个入口均能导入新符号；demo 五类效果可交互且无内部 RAF；产物类型声明完整；README 链接与本目录 11 篇文档全部可达。

**回退边界：** 若发布验收失败，撤销导出和 demo 即可保持内部实现未公开；不要发布只有部分 primitive 可用的 API。

## 阶段 14：弃用 SharedUniforms 扩展 ABI并清理旧拼接路径

**前置依赖：** 阶段 13 全矩阵通过并至少完成一次资源/性能审查。

**模块与符号：**

- `SharedUniforms` 添加 `@deprecated`，说明仅为旧内部扩展兼容。
- 内部改用严格的 `GroundSystemUniforms` 与受校验的 user uniform map。
- 删除无引用的 `ClassificationColorInjection` 扩展点、字符串锚点 patch 和旧 dash body。

**操作顺序：**

1. 先通过 `rg`/coverage 确认旧 factory、anchor replace、dash uniforms 已无运行时调用。
2. 给 `SharedUniforms` 加弃用注释但继续从原入口导出，避免当前用户类型导入立刻破坏。
3. 把内部宽 index signature 收紧为 canonical system/user 两张表；完整 legacy→canonical 表集中维护，同一 wrapper 只换公开 key、不复制 value，并在 merge 边界统一校验。
4. 删除旧 color/text/dash 的字符串替换实现；固定 stencil/depth helper 仍可留在原 `materials.ts` 或迁至 compiler，但不能改变状态。
5. 清理 inactive 兼容 uniform 前，先确认不是公开 setter 或 Raw default factory 所需；有外部兼容风险的留到下一个 major。
6. 跑全部测试、golden、包产物 diff 和 TypeScript deprecation smoke。

**兼容处理：** 这是弃用而非删除；外部 `SharedUniforms` import 继续编译。新扩展只承诺 Appearance/Material ABI，不承诺内部 system map。

**阶段验收：** 生产路径无字符串锚点替换；默认、自定义 safe、Raw 全通过；包只新增 deprecation 提示，无运行时 breaking change；构建产物中无遗留旧 dash 分支。

**回退边界：** 清理应是独立提交；若出现回归，只恢复旧 helper 文件，不回退新公共 API、assembler 或已迁移管线。

## 3. 实现时的统一替换模板

以下是 **伪代码**，说明任何 primitive 的 material version 与 appearance 切换都采用同一事务顺序：

```ts
// Implemented transaction pattern pseudocode
function refreshCompiledAppearanceIfNeeded(): void {
  if (compiled.logicalVersion === appearance.version) return;

  const next = compileAllAffectedPasses({
    appearance,
    primitiveKind,
    systemUniforms, // 原对象
  });

  // 只有全部编译产物创建成功后才交换。
  const previous = compiled;
  compiled = next;
  bindCompiledMaterials(next);
  disposeCompiledMaterials(previous);
}
```

该模板避免切换中出现半套 pass、丢失 user uniform 引用或提前销毁仍在使用的 material。Geometry 不参与事务。

## 4. 跨阶段关键决策与边界条件

| 主题 | 锁定决策 |
| --- | --- |
| 首次公开时机 | 阶段 13；在所有 primitive kind 完成前不发布残缺 API |
| 默认行为 | 旧 style options 生成内部默认 Appearance；显式 appearance 优先 |
| safe surface | 只编译/替换 color pass；stencil 固定 |
| Raw surface | front/back/color 全由 factory 分别返回，用户维护一致性 |
| rebuild 粒度 | source/defines/schema/version 只重建受影响 compiled materials；geometry 不动 |
| transparent classification | 输出零 alpha 并清 stencil，不允许材质 `discard` |
| 时间 | 宿主提供 absolute seconds/delta/frame；缺省 0；库不调度帧 |
| 资源 | primitive 销毁 compiled material；逻辑 Material/Texture 均不归 primitive |
| rollback | 迁移期保留旧后端至阶段 14；每条 pipeline 可独立切回 |

## 5. 路线图总体验收清单

- [x] 14 个阶段按顺序各有独立提交、测试结果与回退说明。
- [x] rectangle/polygon/circle 的 front/back/color 不变量保持。
- [x] polyline 全线距离和 arrow 附加 pass 已进入正式 ABI。
- [x] text `setText` 原位更新固定 topology，不替换 geometry/appearance/user uniform；image rebuild 不丢 appearance 与用户 uniform 引用。
- [x] point 对三类 delegate 完整透传。
- [x] 六个 built-in factory 与 safe/Raw 两套入口从根和 `./ground` 可导入。
- [x] uniform 动画期间 Shader、defines、schema 和 program 数稳定。
- [x] `setFragmentCulling`、appearance/version 变化只重建相关 GPU material。
- [x] 分类透明片元不 `discard`，默认视觉与 setter 行为无回归。
- [x] `SharedUniforms` 仅弃用、未删除；旧 import 与宿主 FrameState 仍兼容。
- [x] `npm run type-check`、`npm run build`、`npm run build:lib` 和 [10](./10-test-and-acceptance.md) 自动矩阵通过。

## 结论与导航

路线的核心是先建立逻辑对象与确定性 assembler，再按 surface → polyline → arrow → decal → point → time/effects 逐条迁移。旧后端一直保留到所有路径通过验收，既控制回归面，也给每个阶段提供明确的回退开关。

- 上一篇：[08. 生命周期、缓存与资源所有权](./08-lifecycle-cache-resources.md)
- 下一篇：[10. 测试与验收](./10-test-and-acceptance.md)
- 返回：[文档索引](./README.md)
