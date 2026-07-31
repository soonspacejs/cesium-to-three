# 10. 测试与验收规范

> 状态：**Proposed Test Plan**。当前仓库尚无自动测试脚本；本篇定义实现 Ground Material/Shader 扩展时必须新增的测试设施和发布门槛。

## 目标

建立可重复的单元、WebGL 集成、视觉、性能与兼容性矩阵，证明以下结论：默认视觉无回归；safe/Raw 两套入口遵守 pass 契约；动态 uniform 不触发 program 增长；透明 classification 正确清 stencil；重建、共享、clone 和 dispose 不泄漏资源。

前置阅读：

- [05. Shader ABI](./05-shader-abi.md)
- [06. 渲染管线接入](./06-render-pipeline-integration.md)
- [07. 内置效果](./07-built-in-effects.md)
- [08. 生命周期、缓存与资源所有权](./08-lifecycle-cache-resources.md)
- [09. 14 阶段实施路线](./09-implementation-roadmap.md)

非目标：

- 不用肉眼 demo 代替自动断言。
- 不把不同 GPU 的浮点细微差异都视为回归；固定 CI 平台采用严格阈值，真实硬件另做发布前抽检。
- 不验证 timeline/tween/内部 RAF，因为这些能力明确不属于本设计。
- 不以性能测试掩盖 Shader 编译错误、stencil 错误或资源所有权错误；功能门槛必须先通过。

## 1. 当前事实与测试设施

### 1.1 源码基线

本文行号基于项目提交 `32a6b244b7c0cb731ca35165c46e8fe31248c718`，Three 参考提交为 `2a005fdbad6b8503a8a70edfdd279b79c5e04b49`：

- 当前 `package.json:31-37` 只有 `dev/build/build:lib/prepack/preview/type-check`，没有 test runner。
- Three 依赖是 `^0.183.0`，见 `package.json:39-45`；首期验收只针对 WebGLRenderer + GLSL3。
- 当前 surface stencil state 位于 `src/lib/ground/materials.ts:839-870`，color state 位于 `883-924`；三条命令 renderOrder 必须连续，见 `src/lib/ground/classification.ts:646-650`。
- 当前 polyline/arrow 都是无 stencil、预乘混合的独立 pass，见 `src/lib/ground/materials.ts:1421-1458, 1704-1737`。
- current text/image 已以零 alpha 输出透明 texel 并清 stencil，见 `src/lib/ground/materials.ts:959-975`；这是迁移后的回归基准。
- Three 将 `renderer.info.programs` 绑定到 program cache，见 `src/renderers/WebGLRenderer.js:478`；material program 按 cache key 获取/复用，见 `2177-2229`；dispose 会 release program，见 `1168-1177`。
- Three 在 material version 变化时更新程序状态，见 `src/renderers/WebGLRenderer.js:2400-2509`，而普通 ShaderMaterial uniform 上传不要求换 program，见 `2763-2766`。

### 1.2 Proposed 测试栈

| 层 | 工具 | 用途 |
| --- | --- | --- |
| 纯逻辑单元 | Vitest | Material/version/clone、校验、assembler、cache key、预设公式 |
| WebGL2 集成 | Playwright + Chromium | Shader 真编译、render state、pass 顺序、stencil、资源计数 |
| 视觉回归 | Playwright screenshot + pixel diff | 默认视觉、边界、动画关键相位 |
| 性能/稳定性 | Playwright performance harness | programs、geometry/texture、heap、相对 GPU/帧耗时 |
| 类型/包出口 | TypeScript fixture + Node ESM smoke | 根入口、`./ground`、`.d.ts` 与旧代码兼容 |

建议目录是 **Proposed**，不是当前目录：

```text
tests/ground-material/
├── unit/
│   ├── material.test.ts
│   ├── assembler.test.ts
│   ├── uniforms.test.ts
│   └── builtins.test.ts
├── webgl/
│   ├── surface.spec.ts
│   ├── polyline-arrow.spec.ts
│   ├── decal-point.spec.ts
│   └── lifecycle.spec.ts
├── visual/
│   ├── default-parity.spec.ts
│   └── effects.spec.ts
├── perf/program-stability.spec.ts
├── package/import-smoke.mjs
└── fixtures/
```

CI 固定 Chromium、WebGL2、viewport `1280×720`、deviceScaleFactor `1`、相机/near/far、颜色空间、tone mapping、随机种子和 packed-depth fixture。截图元数据必须记录 OS、Chromium、Three 与项目提交。

### 1.3 设计过程

测试按“纯函数契约 → Shader 真编译 → pass/state 与生命周期 → 视觉关键帧 → program/资源稳定 → 包出口”递进。前一层失败时不进入后一层：先证明 Material/ABI 是确定的，再证明 GPU 管线正确，最后才测性能和发布兼容。这样可以把公式错误、stencil 错误与缓存抖动分别定位，而不是把所有失败都归因于截图变化。

## 2. 单元测试矩阵

### 2.1 `CesiumGroundMaterial`

| ID | 场景 | 操作 | 必须断言 |
| --- | --- | --- | --- |
| M-01 | 构造 | source/defines/uniforms 合法 | uuid 存在；version 初始确定；不编译 WebGL |
| M-02 | 值更新 | `setUniform('u_speed', 2)` | 同一个 `IUniform` 容器；只变 `.value`；version/key 不变 |
| M-03 | 未声明字段 | `setUniform('u_new', 1)` | 抛明确错误；不得静默改变 schema |
| M-04 | source/define/schema 更新 | 修改并置 `needsUpdate=true` | version 每次递增；compile key 改变 |
| M-05 | `needsUpdate=false` | 连续设置 false | version 不变 |
| M-06 | clone 标量/向量 | clone 后修改 clone | uniform map/container/Vector 独立；源不变 |
| M-07 | clone Texture | clone 含普通 Texture / RenderTargetTexture | 普通 Texture 调 `.clone()` 得新对象且归调用方；RT texture 告警并为 `null` |
| M-08 | 共享 | 两 appearance 引用同一 Material | `.value` 更新双方可见；version 一致 |
| M-09 | dispose | 连续调用两次 | 每次都发通知；version/数据不变；没有 compiled 时消费者不重复释放 GPU；不 dispose Texture |
| M-10 | dispose 后复用 | `setUniform/clone/needsUpdate`、再次绑定 | 全部仍允许；下一 reconcile 可重新编译；逻辑 Material 不永久失效 |

### 2.2 uniform 合并与保留字

| ID | 输入 | 预期 |
| --- | --- | --- |
| U-01 | `u_color`、`timeScale` | 接受；普通 `u_*` 合法 |
| U-02 | `czm_test`、`c23_time`、`c23_custom` | 构造/merge 立即拒绝 |
| U-03 | 用户 define `C23_SURFACE` 或任意 `C23_*` | 拒绝；primitive define 仅由 assembler 设置 |
| U-04 | 空字符串、数字开头、带 `-` | 拒绝为非法 GLSL identifier |
| U-05 | user 与 system 同名 | 抛冲突错误；system 不可被覆盖 |
| U-06 | safe source 声明 uniform，但 user wrapper 缺失；或 wrapper key 无对应声明 | compile-time 诊断指出名称；不把两个不存在的 user map 当作合并来源 |
| U-07 | `.value` 从 number 换 Texture，但 key/schema/source 不变 | wrapper、version、key 不变；低层 API 不推断 JS value 类型，Three 上传结果与类型正确性由调用方负责 |
| U-08 | merge 顺序变化 | 同一规范化 schema 产生同一稳定 key |
| U-09 | Current `u_color/u_line*/u_arrow*` adapter | target system key 全部以 `c23_`/`czm_` 开头且与 legacy 指向同 wrapper；user `u_color` 可同时存在且不冲突 |

### 2.3 assembler 与 pass

| primitiveKind | pass | define | Material 调用 | 重点断言 |
| --- | --- | --- | --- | --- |
| `surface` | `frontStencil` | `C23_SURFACE` | safe：否；Raw：用户 factory | RTE/log-depth/z-fail 输入齐全 |
| `surface` | `backStencil` | `C23_SURFACE` | safe：否；Raw：用户 factory | 与 front 顶点变换契约一致 |
| `surface` | `color` | `C23_SURFACE` | 是 | shape → `baseColor/isStroke` → final output |
| `polyline` | `polyline` | `C23_POLYLINE` | 是 | 沿/横米距离、总长、mpp 均赋值 |
| `decal` | `color` | `C23_DECAL` | 是 | `st/localMeters`、透明 stencil 清理 |
| `arrow` | `arrow` | `C23_ARROW` | 是 | 端点 shape 裁切先于 Material |

每个组合至少覆盖：

- GLSL3 真编译成功，源码中只有一个最终 `main()`。
- `c23_materialInput` 所有字段都有确定赋值；不适用字段明确为零。
- user source/defines/schema 进入 key，uniform value 不进入 key。
- 最终输出严格为 `(diffuse + emission) * alpha` 与 `alpha`；用户返回 straight alpha。
- safe surface/decal 的 Material 与 finalizer 均不含 `discard`；alpha 0 仍写 `vec4(0)`。
- source map 中不再通过 Cesium 锚点字符串 `replace` 注入。
- 缺少入口报 `GROUND_MATERIAL_FUNCTION_MISSING`；重复/错签名入口报 `GROUND_MATERIAL_FUNCTION_INVALID`；`main` 与其他 `#version`、precision/output/varying/layout、ABI 重声明、`gl_FragDepth`、`discard` 分别报稳定 source error code，并携带 `detail.token/reason`。
- safe 预处理只接受条件分支 allowlist；`#include/#extension/#line/#pragma/#define/#undef` 均报 `GROUND_MATERIAL_SOURCE_FORBIDDEN`，不能借 Three chunk 绕过词法校验。

### 2.4 内置材质公式

| ID | 材质 | 采样输入 | 预期 |
| --- | --- | --- | --- |
| B-01 | Color | base `(0.2,0.4,0.8,.5)` × white | 原值不变 |
| B-02 | TexturedDecal | 2×2 定色纹理、flipY 0/1 | 四角方向与 opacity/tint 精确 |
| B-03 | Dash | along `0, 15.9, 16.1, 23.9, 24.1` | dash/gap 边界和 AA 正确 |
| B-04 | Dash | 两 segment 交界 | 使用全线 along；相位不重启 |
| B-05 | Flow | `t=0,.25,.5,1`、speed=1 | 每秒一 cycle；方向 ±1 镜像 |
| B-06 | Flow | background alpha 0 | gap 返回 alpha 0，不 discard |
| B-07 | Pulse | phase `0,.25,.5,.75` cycles | scale/opacity 按余弦波到达 min/mid/max/mid |
| B-08 | Pulse | `maxScale=1.4, footprintScale=1.4` | 归一化半径最大为 1，不越 footprint |
| B-09 | Scale | nominal 24、max 1.3、footprint 31.2 | scale=1 时 24，scale=1.3 时 31.2 |
| B-10 | 所有动画 | 同一 absolute time，不同 delta/frame | 输出一致；只依赖 `c23_time` |
| B-11 | Pulse/Scale | `edgeSoftness=0` 且导数退化 | epsilon 下限仍使 `smoothstep` 两边不同，输出有限且确定 |

工厂参数还要覆盖 NaN/Infinity、负 period、min>max、opacity 越界、trail=0/大于 1、repeat<=0、footprintScale 小于 maxScale；构造时统一抛 `RangeError`，不能生成带 NaN 的 Shader 输入。

## 3. WebGL 集成矩阵

### 3.1 primitive × appearance × classificationType

以下不是抽样建议，而是最小必测组合。`TERRAIN/CESIUM_3D_TILE/BOTH` 使用三张内容不同的合成 packed-depth texture，断言 primitive 实际绑定正确目标；另做真实 terrain/3D Tiles 发布前抽检。

| primitive | default | safe Material | Raw Appearance | classificationType | alpha |
| --- | --- | --- | --- | --- | --- |
| rectangle | Color | 自定义 fill/stroke | 三 pass 修改默认 | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| polygon + hole | Color | localMeters pattern | 三 pass | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| circle + ring/sector | Color | `isStroke` 分色 | 三 pass | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| polyline solid | Color | 横向渐变 | Raw polyline | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| polyline dash/flow | Dash | Flow | Raw polyline | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| arrow solid/open | Color | 独立 arrow Material | Raw arrow | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| text | TexturedDecal | 自定义纹理/tint | Raw color 三 pass | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| image | TexturedDecal | ScalePulse | Raw color 三 pass | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| point circle | delegate default | PulsePoint | delegate Raw | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| point square | delegate default | ScalePulse | delegate Raw | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |
| point image | delegate default | Textured/Scale | delegate Raw | TERRAIN / CESIUM_3D_TILE / BOTH | 1 / .5 / 0 |

执行方式采用 pairwise 组合减少截图数量，但每行必须至少让三种 appearance、三种 classificationType 和三种 alpha 各出现一次；alpha=0 的 stencil 清理用专门重叠场景，不只看截图透明。

### 3.2 固定 render-state 契约

safe Appearance 必须保持下表；Raw 测试则验证 `createDefaultMaterial()` 初始值相同，并允许用户显式改写：

| pass | side/state | depth | stencil | blending/queue |
| --- | --- | --- | --- | --- |
| front stencil | FrontSide | test=true, write=false, LessEqual | Always；zFail=DecrementWrap；colorWrite=false | 不混合 |
| back stencil | BackSide | test=true, write=false, LessEqual | Always；zFail=IncrementWrap；colorWrite=false | 不混合 |
| surface/decal color | DoubleSide | test=false, write=false | NotEqual 0；fail/zFail/zPass 全 Zero | Custom `ONE, ONE_MINUS_SRC_ALPHA`；`transparent=false` |
| polyline | DoubleSide | test=false, write=false；FS depth reconstruction | stencil=false | 预乘混合；维持当前 queue 语义 |
| arrow | DoubleSide | 同 polyline | stencil=false | 预乘混合；renderOrder=line+1 |

另断言 surface 命令 renderOrder 为 `base/base+1/base+2`、三 mesh 连续加入 group、Ground non-pickable layer 不变。依据是当前 `src/lib/ground/classification.ts:633-650`。

### 3.3 classification 透明清理场景

这个测试必须读回 stencil 或通过可见结果间接证明，不接受“截图看起来透明”作为唯一证据：

1. 在同一区域依次渲染 A、B 两个 surface classification primitive。
2. A 的 Material 在一半像素返回 alpha 0，但不得 discard；B 在相同 footprint 输出不透明对比色。
3. 若 A 的 color pass 正确执行 ZeroStencilOp，B 在整片区域都可见；若 stencil 残留，B 会出现洞。
4. 对 TexturedDecal 的透明 texel、Pulse coverage 外部和 Scale coverage 外部重复该场景。
5. 再加入低视角天空与 packed depth clear sentinel，验证没有把无地形处染色。

```ts
// Proposed integration-test pseudocode
renderClassification(transparentHalfMaterial);
renderClassification(solidProbeMaterial);
const pixels = readProbeRegion();
expectEveryExpectedProbePixel(pixels, probeColor);
```

### 3.4 rebuild 与故障原子性

| 操作 | geometry | logical appearance/material | user uniform/Texture | compiled material | 断言 |
| --- | --- | --- | --- | --- | --- |
| `setUniform` | 同一 | 同一 | 同一容器 | 同一 | 只变 value |
| Material `needsUpdate` | 同一 | 同一/version+1 | 同一 | 仅相关 pass 替换 | 旧产物已 dispose |
| `setFragmentCulling` | 同一 | 同一 | 同一 | surface/decal color 替换 | stencil material 同一 |
| `setAppearance` | 同一 | 新逻辑对象 | 新对象原引用 | 受影响 pass 原子替换 | 无中间空帧 |
| `setText` | 同一 geometry/attributes/classification；仅数组值上传 | 同一 appearance | 同一 user/system wrapper 与 CanvasTexture | 同一 | 离屏候选成功后原位提交，不回默认 appearance |
| arrow mode/style | line geometry 同一；arrow geometry 可换 | 同一 arrow appearance | 同一 | arrow 替换 | line material 不丢 |

Raw factory 在第二或第三 pass 故意抛错时，测试必须证明新建的临时 material 已 dispose、旧完整命令组仍绑定且下一帧正常渲染。

## 4. 视觉验收矩阵

### 4.1 默认视觉 parity

在阶段 1 的固定 CI 平台比较迁移前后：

| 场景 | 必看特征 | 阈值 |
| --- | --- | --- |
| rectangle/polygon/circle | fill/stroke、hole、ring、sector、边缘 | SSIM ≥ 0.999；超过 2/255 的像素 ≤ 0.1% |
| semi-transparent overlap | 预乘 alpha，无暗边/翻倍 | 同上；中心探针色另做数值断言 |
| dash polyline | 米制长度、segment 接缝 | 相位边界偏差 ≤ 1 像素 |
| line screen/world width | 近远宽度语义 | 中线两侧测宽误差 ≤ 1 像素 |
| solid/open arrow | 端点收口、半透明不叠加 | 重叠区探针误差 ≤ 2/255 |
| text/image | 朝向、透明边、mipmap、opacity | 不上下颠倒；SSIM ≥ 0.999 |
| low-angle sky/no-depth | 天空无染色，球兜底正确 | 错色像素必须为 0 |

固定 CI 使用软件/固定 GPU 时按上述阈值。其他真实 GPU 只允许抗锯齿边缘采用“超过 3/255 的像素 ≤ 0.5%”；任何大块结构差异、stencil 洞或方向翻转都不可用容差豁免。

### 4.2 动画关键帧

动画截图不依赖真实帧率，直接注入确定 `timeSeconds`：

- FlowLine：`t=0, 0.25, 0.5, 1.0`，direction ±1，透明/半透明背景，repeat 1/4。
- PulsePoint：一个周期的 `0, 1/4, 1/2, 3/4, 1`，验证 min→mid→max→mid→min；phase=.25 后整体平移四分之一周期。
- ScalePulse：无纹理与 2×2 定色纹理各测一次；`maxScale>1` 时最大关键帧刚好填满预分配 footprint，不被截边。
- 在 30、60、120 FPS 的模拟更新中，只要最终 absolute time 相同，关键探针的 RGBA 误差必须 ≤ `1/255`。
- 改相机位置后图元保持 ECEF 锚点，无朝原点漂移；视觉 UV 缩放不能移动 footprint 中心。

### 4.3 切换与闪烁

连续捕获切换前、切换帧、切换后：

- default → safe → Raw → default。
- `fragmentCull` false ↔ true。
- text content/尺寸变化。
- arrow NONE ↔ BOTH、solid ↔ open。

切换帧允许视觉样式从旧值直接变新值，不允许全透明空帧、半套 stencil/color、旧新材质混合或一帧 ECEF 原点闪现。

## 5. program 与性能稳定性

### 5.1 示例：`renderer.info.programs` 检查方法

必须在首次渲染和异步编译完成后建立 warm baseline，不能把首次 lazy compile 算成泄漏。比较 program 对象集合而不只比较数组长度，因为“释放旧 program + 创建新 program”可能长度不变。

```ts
// Proposed performance-test pseudocode
await warmAndCompile(renderer, scene, camera);
const baseline = new Set(renderer.info.programs ?? []);

for (let frame = 1; frame <= 600; frame += 1) {
  const timeSeconds = frame / 60;
  material.setUniform('u_speed', 0.5 + frame * 0.0001);
  primitive.update({ ...baseFrameState, timeSeconds, deltaSeconds: 1 / 60, frameNumber: frame });
  renderer.render(scene, camera);
}

const after = new Set(renderer.info.programs ?? []);
expect(after).toEqual(baseline);
```

### 5.2 program 变化的精确预期

| 操作 | 新 program/key 预期 | 备注 |
| --- | --- | --- |
| 只改任意 user/system uniform value | `0` | 包括 time、speed、phase、color、Texture 对象替换为同 GLSL 类型 |
| 多个 primitive 使用同 kind/pass/source/defines/schema | `0`（相对首个 warm 实例） | RawShaderMaterial 实例不同但 program cache 复用 |
| safe Material 改 fragment source | color/polyline/decal/arrow 受影响 pass 各 `1` | surface front/back program 集合不变 |
| safe Material 改 defines | 受影响 pass 的 logical key `+1`；assembled source/program 参数新颖时 program 各 `+1` | 切回仍被缓存的旧组合可复用 |
| safe Material 改 uniform schema | 受影响 pass 的 logical key `+1`；若 GLSL 声明/assembled source 未变，Three program 可为 `+0` | 必须重建 uniform binding；只有最终 Shader/program 参数变化才要求 program `+1` |
| surface `setFragmentCulling` | 新 color key `1` | front/back 不变；切回旧 key可复用缓存（若仍有引用） |
| text 只改内容、Shader/schema 不变 | logical key/program/material 均不变 | 同一 geometry/attributes/CanvasTexture，只上传新 buffer/texture 内容 |
| Raw Appearance factory/source 变化 | 只允许其实际重建的 pass 各 `1` | factory 若重建三 pass，预期三份独立 key/产物 |
| uniform 每帧增删或 `needsUpdate` 每帧设置 | 测试必须失败 | 明确禁止的实现 |

为区分 cache list 与真实 compile，harness 同时记录：每帧 program 对象 Set、Material `version`、compiler 生成的 logical cache key、`renderer.debug.onShaderError`。任何 Shader error 都是硬失败，不得退回静默默认材质。

### 5.3 资源与堆稳定性

每类 effect 做 600 帧稳定性测试，再做 20 分钟手工 soak：

| 指标 | 自动验收阈值 |
| --- | --- |
| `renderer.info.memory.geometries` | warm 后 delta = 0；重建场景结束并 dispose 后回到 baseline |
| `renderer.info.memory.textures` | uniform 动画 delta = 0；用户 Texture 不因 primitive dispose 减少；内部 text/cache 按引用数回收 |
| `renderer.info.programs.length` | uniform 动画 delta = 0；预期重编译后不单调增长 |
| compiled RawShaderMaterial 实例 | uniform 动画创建数 = 0；version/appearance 切换只创建受影响 pass 数 |
| JS heap（显式 GC 前后） | 600 帧增量 ≤ `max(2 MiB, baseline×5%)`，且三段采样不单调增长 |
| RAF/timer | 库调用计数 = 0；仅测试宿主有帧调度 |

测试通过 spy 统计 `RawShaderMaterial` compiler factory、uniform map/`IUniform` 创建次数，而不是猴补 Three 构造函数。Texture dispose spy 区分内部拥有、cache handle 与 borrowed user Texture。

### 5.4 相对渲染成本

在同一机器、相同覆盖像素和关闭截图读回的条件下，丢弃前 120 帧，统计后 600 帧中位数：

| 路径 | 相对阶段 1 基线的中位帧耗时上限 |
| --- | --- |
| 迁移后的默认 Color/Textured/Dash | `+5%` |
| FlowLine | 相对纯色同覆盖场景 `+15%` |
| PulsePoint | 相对纯色同覆盖场景 `+15%` |
| ScalePulse 无纹理 | 相对纯色同覆盖场景 `+15%` |
| ScalePulse 有纹理 | 相对默认 TexturedDecal `+20%` |

任何 program compile、texture upload、geometry rebuild 都必须在采样窗口前完成。阈值失败时先用 GPU timer（可用时）和 CPU profile 分辨 Shader 成本与宿主噪声；不能通过减少测试覆盖像素来“修复”。

## 6. 生命周期与资源所有权矩阵

| 情况 | primitive dispose | logical Material dispose | Texture dispose | 预期 |
| --- | --- | --- | --- | --- |
| 内部默认 Material | 销毁 compiled materials | 内部逻辑对象可随 primitive 释放 | 无用户 Texture | 全部 GPU 产物释放 |
| 用户 safe Material | 销毁本 primitive compiled materials | 不调用 | 不调用 | 用户可复用于其他 primitive |
| 用户 Raw Appearance | 销毁 factory 返回的 materials | 不调用 appearance | 不调用其 uniform Texture | 每个返回材质恰好 dispose 一次 |
| shared Material 两 primitive | 各销毁自己的 compiled | 仍由用户持有 | 不调用 | 先销毁一个不影响另一个 |
| cloned Material | 各自 compiled | 容器独立 | 普通 Texture 是新副本且由 clone 调用方释放；RT texture 为 null | phase 可独立；需纹理时显式重绑 |
| text internal CanvasTexture | classification/compiled 仅在 primitive 最终 dispose 时销毁 | appearance 保持 | text primitive 最终销毁同一 texture | `setText` 不创建旧/新 texture 对，也不替换 geometry |
| image URL cache | compiled 销毁 | appearance 保持 | 最后一个 handle release 后微任务销毁 | 同 URL 不重复下载/上传 |

primitive dispose 测试至少调用两次，证明几何/compiled 资源只释放一次；然后对已销毁 primitive 调 `update/setAppearance`，按 04 锁定语义验证一致错误。逻辑 Material/Raw Appearance 的 dispose 是另一种语义：每次都发释放通知、对象可复用；消费者在没有 compiled record 时不得重复释放 GPU，在仍绑定时下一次 reconcile 可重新编译。

## 7. 兼容性验收

### 7.1 旧 API 与默认行为

- 原有 rectangle/polygon/circle/point/polyline/text/image 构造代码不传 appearance 时无需改动。
- 旧颜色、透明度、宽度、虚线、arrow、visible、renderOrder、classificationType setter 行为和单位不变。
- 旧 `CesiumGroundFrameState` 不含时间字段仍通过类型检查并得到 `c23_time=0` 静态画面。
- `SharedUniforms` 仍可导入但显示 `@deprecated`；不作为推荐扩展入口。
- `plot` 内部桥接现有重建/热更新测试继续通过，但不新增公共 animation snapshot。

### 7.2 包入口与类型

以下 **Proposed compile fixtures** 必须同时通过：

```ts
import {
  CesiumGroundMaterial,
  CesiumGroundMaterialAppearance,
  CesiumGroundRawShaderAppearance,
  createFlowLineMaterial,
} from 'cesium-to-three';

import {
  createPulsePointMaterial,
  createScalePulseMaterial,
  type GroundRawShaderBuildContext,
} from 'cesium-to-three/ground';
```

构建后用 Node ESM 从打包目录实际 import，不能只检查源码 TypeScript。`npm pack --dry-run` 必须显示对应 JS 与 `.d.ts` 已包含。

### 7.3 平台边界

| 平台 | 结论 |
| --- | --- |
| Three `0.183.x` + WebGLRenderer/WebGL2 | 首期必须通过 |
| 本地 Three 参考提交 `2a005fdb…` | 只做设计对照；若与项目依赖不同，最终以 `0.183.x` 实测为准 |
| WebGL1 | 不支持；GLSL3/RawShaderMaterial 路径应给明确前置校验 |
| WebGPURenderer/TSL/NodeMaterial | 首期不支持，不静默转换 |
| request-render host | 静态材质不持续帧；活动效果由宿主持续请求 |
| continuous-render host | 宿主每帧传 Clock 时间；库不再启动第二套循环 |

## 8. Raw Appearance 负面测试

开发模式必须覆盖以下错误，生产模式不得发生未定义的半套替换：

1. factory 返回 `null`、普通 `Material`，或跨 pass/图元/Appearance/rebuild 返回同一个 `RawShaderMaterial`；模块级持久 WeakMap 必须拒绝复用。
2. factory 读取错误 pass/primitiveKind，或漏掉必需 attribute/system uniform。
3. user uniforms 使用 `c23_`/`czm_`，或覆盖 system map。
4. surface 只改变 color vertex transform，front/back 仍旧，制造 classification 不一致；开发诊断应指出用户责任。
5. stencil pass 开启 colorWrite、color pass 关闭 stencil zero、错误 blending；`createDefaultMaterial` 修改例与完全替换例分别验证。
6. 单次 factory 二次调用 `createDefaultMaterial()`，或调用后返回另一实例；必须报稳定错误并释放未转移候选。零次调用 + 完全替换与一次调用 + 返回同一默认实例均合法。
7. Shader 在 renderer 阶段编译失败；错误必须保留原 pass 上下文与原始 compiler log。v1 不断言自动回滚，只断言不静默 fallback；宿主预检流程可另测失败时不接受业务切换。
8. factory 在构造第三个 pass 时同步抛错；前两个临时产物释放，旧命令组继续可见。

库不尝试自动修补 Raw Shader 或 render state。测试目标是错误可定位、切换原子、资源不泄漏，而不是让错误 Shader “看起来能用”。

## 9. 命令与 CI 门禁

### 9.1 当前已有命令

```powershell
npm ci
npm run type-check
npm run build
npm run build:lib
```

### 9.2 实施后新增命令

```powershell
# 首次准备 Chromium（CI 镜像可预装）
npx playwright install chromium

npm run test:unit
npm run test:integration
npm run test:visual
npm run test:perf
npm run test
npm pack --dry-run
node tests/ground-material/package/import-smoke.mjs
```

Proposed scripts 的固定含义：

| script | 执行内容 | 是否发布阻断 |
| --- | --- | --- |
| `test:unit` | `vitest run tests/ground-material/unit` | 是 |
| `test:integration` | Playwright WebGL2 functional specs | 是 |
| `test:visual` | 固定平台 golden/pixel diff | 是 |
| `test:perf` | program/resource 600 帧；相对耗时 | program/resource 是；耗时由专用 runner 阻断 |
| `test` | unit + integration + visual | 是 |

PR 快速门禁运行 type-check、unit、integration、默认视觉和 build:lib；主分支/发布门禁再运行全部视觉、性能、app build、pack smoke。任何 golden 更新都必须单独提交，附原因和前后 diff。

## 10. 失败分诊与验收顺序

1. **类型/Shader 编译先行**：任何 TS/GLSL error 先修，不进入截图分析。
2. **render-state/stencil**：检查 pass 顺序、state 与透明清理；不能用调色掩盖模板残留。
3. **ABI 数值**：用 debug Material 输出 `st/localMeters/distance/mpp` 定位坐标错误。
4. **视觉公式**：核对预设关键相位、方向、footprint normalization。
5. **生命周期**：检查对象身份、dispose spy、Texture refcount。
6. **program/性能**：功能正确后再分析 cache key、版本抖动和 fragment 成本。

## 11. 关键决策与边界条件

| 主题 | 锁定验收决策/边界 |
| --- | --- |
| 自动与手工 | deterministic fixture、Shader 编译、stencil、program 和资源所有权必须自动化；真实 terrain/3D Tiles/GPU 只作补充抽检 |
| 默认视觉 | 以阶段 1、同提交依赖和固定平台为基线；不得为未解释差异重录 golden |
| classification alpha 0 | 必须用重叠探针证明 stencil 已清，不只看“透明”截图 |
| Raw Appearance | 库验证类型、pass 完整性和切换原子性；用户 Shader/render state 的语义正确性由用户负责 |
| program 指标 | 同时比较对象 Set、数量、logical key 与 version；首次 lazy compile 不计入稳定窗口 |
| 性能 | 默认路径相对基线阻断；effect 路径按同覆盖像素的相对预算，不跨机器比较绝对 FPS |
| 时间 | 关键帧直接注入 absolute `timeSeconds`；不依赖测试运行速度或 RAF |
| footprint | Pulse/Scale 的实际几何必须按 `u_footprintScale` 预分配；测试不把 UV 缩放误当几何缩放 |
| 生命周期 | primitive 永久释放且 use-after-dispose 报错；逻辑 Material/Raw Appearance dispose 是可重复通知且对象可复用 |
| 首期平台 | Three 0.183.x、WebGLRenderer、WebGL2、GLSL3；WebGL1/WebGPU/TSL 不纳入通过声明 |

## 12. 最终发布验收清单

- [ ] Material、uniform、保留字、clone/version/cache-key 单元测试全通过。
- [ ] assembler 的 surface 三 pass、polyline、decal、arrow 全部真实 WebGL2 编译。
- [ ] default/safe/Raw × primitive × classificationType 的最小矩阵全部覆盖。
- [ ] alpha 0、透明纹理、Pulse/Scale coverage 外部均无 stencil 残留。
- [ ] 默认视觉、旧 setter、低视角天空、无深度与椭球兜底无回归。
- [ ] `setFragmentCulling`、`setText`、appearance 切换和 arrow rebuild 的对象/资源语义正确；`setText` 不替换 geometry/attribute/material/Texture identity。
- [ ] uniform 动画 600 帧 program 对象集合、geometry、texture 均稳定。
- [ ] source/defines/schema 变化只产生预期的新 logical pass 产物；Three program 仅在 assembled source/program 参数变化时增加，没有每帧重编译。
- [ ] shared/clone/dispose 通知、普通/RT Texture clone 所有权与 image cache 引用计数全部通过。
- [ ] Flow/Pulse/Scale 在相同 absolute time 下不受 30/60/120 FPS 影响。
- [ ] 库代码无 timeline/tween/RAF/timer/request-render 调度。
- [ ] 根入口与 `cesium-to-three/ground` 的 JS、类型与 pack smoke 通过。
- [ ] `npm run type-check`、`npm run build`、`npm run build:lib` 和全部 test scripts 通过。

## 结论与导航

验收不是只证明“效果能动”，而是同时证明 pass 不变量、classification 清理、program 稳定性和资源所有权。只有自动矩阵、固定关键帧、600 帧稳定性和两套包入口都通过，Material/Shader 扩展才具备发布条件。

- 上一篇：[09. 实施路线图](./09-implementation-roadmap.md)
- 返回：[文档索引](./README.md)
