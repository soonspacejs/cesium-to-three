# 生命周期、Program Cache 与资源所有权

> 状态：**Design / Proposed**。本文定义实现必须遵守的缓存与所有权契约；除明确标为 **[Current]** 的内容外，均未表示当前代码已经具备。
>
> 源码基线：当前项目 `32a6b244b7c0cb731ca35165c46e8fe31248c718`；Three `2a005fdbad6b8503a8a70edfdd279b79c5e04b49`；Cesium `effe290c08dc340a7a6bd4435367a7d092c6b2b9`。
>
> 导航：上一篇：[07 内置效果](./07-built-in-effects.md) · 下一篇：[09 实施路线](./09-implementation-roadmap.md)

## 1. 目标

材质扩展最容易出现的错误并非 Shader 公式，而是“每帧重编译”“共享后互相污染”“appearance 切换丢 uniform”“纹理被重复释放”和“旧 program 永不释放”。本文把这些问题收敛为可测试的规则：

1. 明确逻辑 `CesiumGroundMaterial`、Appearance、每图元 Compiled Material、Three `WebGLProgram` 与 Texture 的所有者；
2. 定义 `version`、`needsUpdate`、uniform schema 与 program key；
3. 定义共享、`clone()`、`setAppearance()`、`setFragmentCulling()`、Raw factory 和 `dispose()` 的精确行为；
4. 保证动态 uniform 每帧变化不增加 `renderer.info.programs`；
5. 规定 request-render、错误模式、性能观测与验收方法。

## 2. 前置阅读

- [01 Three/Cesium 源码参考](./01-three-cesium-reference.md)
- [03 目标架构](./03-target-architecture.md)
- [04 公共 API](./04-public-api-design.md)
- [05 Shader ABI 与 pass 契约](./05-shader-abi.md)
- [06 渲染管线接入](./06-render-pipeline-integration.md)
- [07 内置效果](./07-built-in-effects.md)

本文只定义生命周期和缓存，不重复 04 的完整 TypeScript 声明，也不重复 05 的 GLSL struct。

## 3. 非目标

- 不建立全局材质注册表、Fabric type registry 或可序列化材质图；
- 不建立 timeline、tween、关键帧或内部 RAF；
- 不由库猜测 Shader 是否读取 `c23_time`；
- 不让逻辑 Material 直接持有 `WebGLProgram`；
- 不缓存或跨图元共享带系统 uniform 的 `RawShaderMaterial` 实例；
- 不替用户管理 user uniform 中的 Texture、RenderTarget 或其他 GPU 资源；
- 不承诺 Raw Appearance 能被库自动纠正为合法的 classification 管线。

## 4. 当前基线与改造原因

### 4.1 当前代码已经做对的部分

**[Current]** surface classification 为每个图元创建 front-stencil、back-stencil 与 color 三个 `RawShaderMaterial`，并让三者引用同一张 `SharedUniforms` 表，见 `src/lib/ground/classification.ts:476-505`、`:510-602`。`setColor()` 原地修改现有 Vector4，见 `classification.ts:670-678`；`setFragmentCulling()` 仅替换 color material 并 dispose 旧 material，见 `classification.ts:785-798`。图元销毁时 geometry 只释放一次，三个 material 分别释放，见 `classification.ts:829-836`。

**[Current]** polyline 的 line 与 arrow 拥有独立 geometry/material，但共享 uniform 表，见 `src/lib/ground/primitives.ts:901-917`、`:953-1018`；arrow 重建会释放旧 geometry/material，见 `primitives.ts:1021-1035`；最终 dispose 释放 arrow、line geometry 与 line material，见 `primitives.ts:1300-1310`。

**[Current]** 图片点有显式 URL Texture 引用计数：同 URL 共享 Texture，最后一个 handle 释放后在微任务末尾 dispose，见 `src/lib/ground/image/image-texture-cache.ts:9-24`、`:30-76`。`CesiumGroundImagePrimitive` dispose classification 后归还 handle，见 `src/lib/ground/image/image-primitive.ts:126-132`。文字的 CanvasTexture 由文字图元创建并由文字图元释放，见 `src/lib/ground/text/text-primitive.ts:171-180`。

这些机制证明当前代码已有良好的“创建者负责释放”基础，目标设计应在此之上增加逻辑 Material，而不是把已有资源责任全部倒置。

### 4.2 当前扩展方式的限制

**[Current]** `ClassificationColorInjection` 以内部 `colorMaterialFactory` 和 `extraUniforms` 直接操作 `SharedUniforms`，见 `src/lib/ground/classification.ts:463-473`。它没有公开 Material identity、schema version、pass 级 cache key 或可共享的逻辑材质。文字/图片、普通颜色、虚线仍由不同工厂或 Shader 分支实现。

**[Current]** 当前 `CesiumGroundFrameState` 没有时间字段，见 `src/lib/ground/types.ts:404-428`；动画若直接读取 wall clock，只会制造不可测试的隐式状态。

**[Proposed]** 新层必须做到：逻辑材质可共享；系统 uniform 仍按图元隔离；Compiled Material 按 pass 生成；底层 program 由 Three 按相同源码共享；资源释放仍由明确所有者执行。

## 5. 设计过程与所有权模型

本章按资源流而不是按类逐个罗列：先从当前“每图元拥有 geometry/material、uniform wrapper 被多个 pass 引用”的事实出发；再把新增逻辑 Material 放在 GPU 对象之外；随后用 version/signature 决定何时替换 compiled material；最后把 Texture、Raw factory 返回值和 Three program 引用逐一指定所有者。这样每条 rebuild 路径都能回答三个问题：旧对象谁释放、新对象何时接管、共享对象是否仍然有效。

### 5.1 对象关系

```text
用户
 ├─ owns CesiumGroundMaterial
 │   ├─ owns user uniform map/wrappers
 │   └─ references user Texture values
 ├─ owns CesiumGroundMaterialAppearance / CesiumGroundRawShaderAppearance
 └─ owns user Texture / RenderTarget / Clock or Timer

Ground Primitive
 ├─ owns geometry and meshes
 ├─ owns per-primitive system uniform wrappers
 ├─ owns one Compiled Material per active render pass
 │   └─ owns returned THREE.RawShaderMaterial
 └─ references Appearance and logical Material; does not own either

THREE.WebGLRenderer
 └─ owns/ref-counts WebGLProgram selected from RawShaderMaterial source/state
```

这里的“Compiled Material”是内部记录，不是新的公开 Shader API。它至少保存：appearance/material version 快照、compile signature、pass、合并后的 uniform map 和该 pass 的 `RawShaderMaterial`。

### 5.2 所有权表

| 对象/资源 | 创建者 | 释放者 | 可否共享 | 关键规则 |
| --- | --- | --- | --- | --- |
| `CesiumGroundMaterial` | 用户或内置 preset | 用户 | 是 | 图元只引用，不调用其 `dispose()` |
| 安全/Raw Appearance | 用户、preset 或图元默认值 | 用户；若是图元内部默认值则图元 | 是 | Appearance 本身不等于 compiled GPU material |
| per-primitive system uniforms | 图元 | 图元 | 否 | 相机、深度、局部 extents 不得跨图元共享 |
| user uniform wrapper | Material/Raw Appearance | Material 所有者 | 同一逻辑对象内共享 | compiled map 必须复用 wrapper 引用 |
| compiled `RawShaderMaterial` | 组装器或 Raw factory | 图元 | 否 | 每个图元/pass 独立；底层 program 可共享 |
| `WebGLProgram` | Three renderer cache | Three renderer ref-count | 是 | 通过 `RawShaderMaterial.dispose()` 释放引用 |
| user uniform Texture | 用户 | 用户 | 是 | 图元、Appearance、Material 均不 dispose |
| `clone()` 生成的普通 Texture 副本 | `clone()` 调用方触发 | 调用方 | 可手动共享 | 严格 Three clone；Material 也不自动 dispose |
| frameState depth Texture | 宿主 depth manager | 宿主 | 是 | 属于 system uniform，不进入 user clone |
| 文字 CanvasTexture | 文字图元 | 文字图元 | 通常否 | 维持当前行为 |
| URL 图片缓存 Texture | 图片缓存 | 最后一个 handle release | 是 | 维持当前引用计数 |
| geometry | Ground 图元 | Ground 图元 | 默认否 | appearance/material 切换不重建 geometry |

## 6. 逻辑 Material 的状态机

### 6.1 `version` 与 `needsUpdate`

**[Source]** Three `Material.needsUpdate = true` 只递增 `version`，见 `D:\my\explore\three.js\src\materials\Material.js:1219-1231`；renderer 发现版本变化后重新选择 program，见 `D:\my\explore\three.js\src\renderers\WebGLRenderer.js:2398-2519`。

**[Proposed]** `CesiumGroundMaterial` 采用同一外部语义：

- `version` 初始为 `0`，只读；
- 写 `needsUpdate = true` 时 `version += 1`；
- 写 `needsUpdate = true` 同时发出 change 通知，让绑定消费者在下一次 reconcile 处理失效；
- 写 `false` 无操作；读取 `needsUpdate` 不作为状态来源，是否失效只由版本快照判断；
- 连续写两次 `true` 会增加两次，这是显式的两次结构变更；
- `setUniform()` 永不增加 version；
- `dispose()` 只发出可重复的 dispose 通知，不增加 version，也不把逻辑 Material 永久标记为不可用。

**[伪代码]**

```ts
class CesiumGroundMaterial {
  readonly version = 0;

  set needsUpdate(value: boolean) {
    if (value === true) {
      this.version += 1;
      this.dispatchEvent({ type: 'change' });
    }
  }
}
```

实际实现可使用私有字段，伪代码只表达可观察语义。

### 6.2 哪些变化增加 version

| 操作 | 是否增加 Material version | 是否重新生成 compiled material | 是否应产生新 Three program |
| --- | ---: | ---: | ---: |
| `setUniform(existingName, value)` | 否 | 否 | 否 |
| 原地修改 `Vector/Color/Matrix/Texture` value | 否 | 否 | 否 |
| 更新 `c23_time/delta/frameNumber` | 否 | 否 | 否 |
| 更新相机、viewport、depth texture | 否 | 否 | 否 |
| 修改 `fragmentShader` 后 `needsUpdate=true` | 是 | 是 | 源不同则是 |
| 修改 `defines` 后 `needsUpdate=true` | 是 | 是 | define 不同则是 |
| 新增/删除 uniform schema 键后 `needsUpdate=true` | 是 | 是 | 仅最终 GLSL/defines/program 参数变化时；schema-only 可复用 program |
| 只替换既有 uniform 的 `.value` 类型兼容值 | 否 | 否 | 否 |
| `setFragmentCulling()` | 不改 user Material version | 只重建相关 color compiled material | system define 改变则是 |
| `setRenderOrder` / visible / classificationType | 否 | 否 | 否 |
| Raw factory 捕获的外部结构状态变化 | Raw appearance `needsUpdate=true` | 重跑相关 factory | 取决于返回源码/state |

“源不同则是”表示 Three 最终可能命中已有同 key program，而不是无条件新建 GPU program。例如从 define A 切到 B、再切回 A，只要 A 的旧 program 仍有引用，就可以复用。

### 6.3 `setUniform()` 的稳定引用规则

**[Proposed]** `setUniform(name, value)` 必须：

1. 只接受构造时或上一次 schema version 中已经存在的 user uniform 名；
2. 对未知键抛出明确错误，不偷偷扩充 schema；
3. 执行 `uniforms[name].value = value`，保留 `{ value }` wrapper 对象本身；
4. 不替换整个 `uniforms` map，不修改 version；
5. 不 clone、不 dispose 旧 value；如果旧 value 是 Texture，释放责任仍归用户。

保留 wrapper 很重要：同一逻辑材质编译到多个图元时，每个 compiled map 都引用该 wrapper。替换 `.value` 后所有图元下一帧看到新值；如果替换 wrapper，已有 compiled map 会继续读取旧对象。

**[伪代码]**

```ts
material.setUniform('u_phase', 0.25);     // wrapper 不变，无编译
material.uniforms.u_color.value.setRGB(1, 0, 0); // 无编译

// schema 变化必须是两步显式操作
material.uniforms.u_mask = { value: maskTexture };
material.fragmentShader = nextSource;
material.needsUpdate = true;
```

### 6.4 schema 快照与漏标 `needsUpdate`

构造/成功编译时保存 user uniform schema 快照。首期 schema identity 定义为排序后的键名序列；GLSL 类型由 Shader 源中的 uniform 声明决定，value 的 JavaScript 构造器不进入 program key。

开发模式在每次准备 compiled material 时比较当前键序列与该 version 的快照：

- 键变化且 version 未变化：抛出 `uniform schema changed without needsUpdate=true`；
- version 已变化：重新校验保留字/冲突并接受新快照；
- 仅 `.value` 变化：不扫描对象深层内容，不报错。

生产构建可省略逐帧 schema 比较，但必须在 version 变化时重新校验。实现不得为了“自动发现变化”每帧 stringify uniforms；那会使动画成本与 uniform 数量成比例并产生分配。

## 7. Appearance 的版本传播

### 7.1 安全 Appearance

**[Proposed]** `CesiumGroundMaterialAppearance.version` 直接取其 `material.version`，不维护第二套需要手动同步的计数。它的 compile identity 还包括 Appearance 自身固定选项；如果将来增加会影响程序结构的 Appearance 选项，该选项必须不可变，或进入额外 appearance version。

结果：

- 多个图元共享同一 Material/Appearance 时，一次 `material.needsUpdate=true` 使每个图元在下一次 `update`/render prepare 时各自重建相关 compiled material；
- uniform 值更新不会让 Appearance version 改变；
- surface 安全 Appearance 只失效 `color`；固定 front/back stencil 不受影响；
- polyline、decal color、arrow 分别只失效自己的着色 pass。

### 7.2 Raw Appearance

**[Proposed]** `CesiumGroundRawShaderAppearance` 自己提供 `version/needsUpdate`，因为 factory 可能从闭包、外部模块或 `createDefaultMaterial()` 修改逻辑中生成 Shader，库无法从一个 `CesiumGroundMaterial.version` 推导。

Raw options 的结构为 `{ uniforms?, factory }`：

- `uniforms` 是 user uniform map，遵守相同保留字、wrapper 与 schema 规则；
- `factory(context)` 是唯一程序构造入口；
- factory 的外部结构依赖变化后，调用方必须 `appearance.needsUpdate = true`；
- `appearance.needsUpdate=true` 与 Material 一样先递增 version、再发出 change 通知；
- 仅 `appearance.uniforms[name].value` 变化不增加 version；实现可提供与 Material 同语义的 `setUniform()`，若 04 未公开该便利方法则直接改 `.value`。

Raw Appearance version 变化后，图元必须重跑对该图元有效的所有 factory pass。原因是闭包变化可能同时影响 vertex transform、render state 与 fragment Shader，库不能只猜 color pass。

## 8. Compile Signature 与 program key

### 8.1 两级缓存，不共享错误的状态

必须区分两级：

1. **内部 compile signature**：决定某图元的某 pass 是否要替换 `RawShaderMaterial`；
2. **Three program cache key**：决定不同 `RawShaderMaterial` 是否共享底层 `WebGLProgram`。

本项目不全局缓存 compiled `RawShaderMaterial`。原因是它包含图元自己的系统 uniform wrapper、pass render state 与 dispose 生命周期。底层 program 共享交给 Three；Three 对自定义源码使用 shader stage ID、defines 与 program 参数组成 key，见 `D:\my\explore\three.js\src\renderers\webgl\WebGLPrograms.js:96-119`、`:400-436`，并以 `usedTimes` 引用计数销毁，见 `WebGLPrograms.js:624-660`。

### 8.2 安全 Material 的 canonical signature

**[Proposed]** 安全入口的 canonical signature 至少包含：

```text
c23-ground-assembler-version
GLSL version
appearance mode = material
GroundPrimitiveKind
GroundRenderPass
pipeline feature flags
sorted system defines (name + canonical value)
sorted user defines (name + canonical value)
exact user fragmentShader
sorted user uniform schema names
shape/fragment-culling compile flags
output/color-space relevant fixed flags
```

规则：

- `GroundPrimitiveKind` 为 `surface | polyline | decal | arrow`；
- `GroundRenderPass` 为 `frontStencil | backStencil | color | polyline | arrow`；
- 安全 surface Material 不参与 front/back signature，因为它根本不进入这两个 pass；
- defines 必须按名称排序，值只允许可稳定序列化的 boolean/number/string；`false` 不生成 GLSL define，但 canonical signature 仍记录该项为 off；`undefined`、非有限 number 等无效值在构造时拒绝；
- Shader 源按精确字符串比较，不能 trim 或折叠空白后假定等价；`#line` 与宏位置可能让空白/换行具有诊断意义；
- schema key 只含 user uniform 名称，不含每帧 value；
- `c23_time` 等系统 uniform 的值绝不进入 signature；
- 若实现用 hash 作为日志/Map key，正确性仍须以 canonical payload 相等为准，不能只依赖可能碰撞的短 hash。

组装后的完整 vertex/fragment source 和 Raw render state 最终仍由 Three 自己纳入 program 选择。内部 signature 的任务是及时重建 wrapper，不替代 Three 的正确性判断。

### 8.3 Raw Appearance 的 signature

Raw factory 可完全替换 Shader/state，因此库不能在调用 factory 前推导最终 key。内部 signature 使用：

```text
raw appearance identity + raw appearance version
+ primitiveKind + pass
+ system compile flags/schema version
```

命中失败时重跑 factory，随后让返回的 `RawShaderMaterial` 进入 Three program cache。不要把 user uniform value 放进 Raw appearance version；不要每帧重跑 factory。

如果用户修改已经返回的 Raw material，它已属于图元而非 factory 调用方；公开契约不保证外部仍持有该对象。运行期改变 Raw 结构的唯一受支持方式是更新 factory 依赖并设置 `appearance.needsUpdate=true`。

### 8.4 program 数量预期

设 `N` 个 surface 图元共享一个安全 Material，且 pipeline flags 相同：

- compiled `RawShaderMaterial`：每图元至少一个 color，数量约为 `N`；
- 固定 stencil `RawShaderMaterial`：仍按当前实现每图元两份，但其 Shader program 可共享；
- user Material 对应的 color `WebGLProgram`：理想为 1；
- 每帧更新 `u_phase/c23_time` 后 program 数量不变；
- 修改一次 Shader 或 define 后最多出现预期的新变体；旧 compiled material dispose 后，旧 program 在没有其他引用时从 `renderer.info.programs` 消失。

## 9. Uniform 合并与引用保持

### 9.1 三个命名域

编译时存在三个来源：

1. system uniforms：canonical key 只使用 `c23_*` 与兼容 Cesium 的 `czm_*`，由图元/FrameState 更新；
2. user uniforms：用户 Material/Raw Appearance 提供；
3. legacy `SharedUniforms`：当前内部桥接层，保留兼容但标记为不推荐扩展 ABI。

Current `SharedUniforms` 的 `u_color/u_border*/u_line*/u_arrow*` 等非保留系统键不直接进入新编译视图；迁移 adapter 用新的 `c23_*` key 引用同一个 wrapper。user uniform 名禁止以 `c23_`、`czm_` 开头。除此之外，若与 Three 自动 uniform 等当前 pass 保留项重名也必须报错；不能用“后合并者覆盖前者”的对象展开语义。这个 canonical alias 层也保证内置 Material 可使用普通 `u_color` 而不与旧 system `u_color` 相撞。

safe Material 的 user defines 禁止 `C23_*`，GLSL 顶层标识符禁止占用 `c23_`/`czm_`。Raw Appearance 只对 user schema 与 merge 冲突执行这些检查；完整 Raw source/defines 不做 safe 顶层扫描，因为 Raw Shader 需要自行声明/读取 system `c23_*`/`czm_*`。Three 自动 uniform（例如 `modelViewMatrix`）仍不能被 Raw user schema 覆盖。保留表由 assembler 集中维护并纳入测试，不能分散在各 preset。

### 9.2 合并必须复用 wrapper

**[Proposed]** 每个 compiled material 创建新的顶层 map，但 values 是原 wrapper：

```ts
// [伪代码]
const merged = Object.create(null);
for (const [name, uniform] of Object.entries(systemUniforms)) merged[name] = uniform;
for (const [name, uniform] of Object.entries(userUniforms)) merged[name] = uniform;
```

禁止对 user uniforms 使用 `UniformsUtils.clone()` 来编译每个图元，否则“同 Material 共享 uniforms”会失效。`UniformsUtils.clone()` 只用于用户显式调用逻辑 Material 的 `clone()`。

### 9.3 系统值永远按图元隔离

即使两个图元共享逻辑 Material，下列 wrapper 也不能共享：

- RTE camera high/low；
- local origin/extents；
- depth texture 与 viewport；
- shape、stroke、line length 等图元数据；
- `c23_time/delta/frameNumber` 的 wrapper（值可来自同一 FrameState，但容器仍由图元持有）。

否则一个图元最后一次 `update()` 会覆盖另一个图元的系统输入，产生顺序相关渲染。

## 10. 共享与 `clone()`

### 10.1 共享同一个 Material

**[Proposed]** 同一 `CesiumGroundMaterial` 可绑定多个图元：

- user uniform map、wrapper 和 value 均共享；
- Shader/defines/schema/version 均共享；
- 每个图元仍有独立 compiled `RawShaderMaterial` 与 system uniforms；
- 相同 compile signature 依赖 Three 共享底层 program；
- 任一调用方 `setUniform()` 会影响所有绑定图元，这是预期而非泄漏。

**[伪代码]**

```ts
const flow = createFlowLineMaterial({ speed: 0.5 });
const appearance = new CesiumGroundMaterialAppearance({ material: flow });

const lineA = new CesiumGroundPolylinePrimitive({ ...a, appearance });
const lineB = new CesiumGroundPolylinePrimitive({ ...b, appearance });

flow.setUniform('u_speed', 0.8); // A、B 同时改变；program 不变
```

### 10.2 独立相位使用 `clone()`

**[Proposed]** `CesiumGroundMaterial.clone()` 严格复刻固定 Three 参考提交中 `UniformsUtils.clone()` 的行为（`D:\my\explore\three.js\src\renderers\shaders\UniformsUtils.js:18-65`）：

| value 类型 | clone 结果 |
| --- | --- |
| Color、Matrix、Vector、Quaternion、普通 Texture 等 Three 对象 | 调用 `.clone()`，得到新对象 |
| RenderTargetTexture | 告警并写 `null` |
| 首元素是 Three 对象的数组 | 每个元素调用 `.clone()` |
| 普通数组 | `slice()`，即只复制数组容器 |
| number/string/boolean/null/undefined | 原值 |
| 普通对象、TypedArray、函数或其他值 | 保持同一引用 |

此外：

- 每个 uniform wrapper 都是新对象；
- `defines` 浅复制为新字典；
- `fragmentShader` 字符串复用不可变值；
- clone 是新逻辑材质，`version` 从 0 开始，建立自己的 schema 快照；
- 系统 depth texture 不在 user uniform map 中，不参与 clone。

普通 Texture 被 `.clone()` 后产生新的 Three Texture 对象。**调用 `clone()` 的用户拥有这些副本，并负责在不用时逐个 `dispose()`；Ground 图元和逻辑 Material 均不自动 dispose。** RenderTargetTexture 不能通过该 API 复制，用户需要 clone 后显式 `setUniform()` 绑定所需 render-target texture。

**[伪代码]**

```ts
const pulseA = createPulsePointMaterial({
  periodSeconds: 1.5,
  phase: 0.0,
});
const pulseB = pulseA.clone();
pulseB.setUniform('u_phase', 0.5);
pulseB.dispose();
```

Pulse preset 本身没有 Texture，因此这个相位示例无需额外 GPU 资源处理。若克隆的是 `createTexturedDecalMaterial()` 或其他带普通 Texture 的材质，调用方应在 clone 后立即记录 clone uniform 中的新 Texture，并在所有图元解绑后自行 `dispose()`；不要假设任意 preset 都存在 `u_mask`。

### 10.3 clone 不保证深拷贝任意业务对象

严格 Three 语义意味着普通对象保持引用、普通数组只是浅拷贝。需要独立业务对象时，调用方应在 clone 后显式 `setUniform()`；库不通过 JSON 序列化猜测 class、原型、循环引用或 GPU handle。

## 11. Appearance 切换与 pass 级失效

### 11.1 `setAppearance()` 原子切换

**[Proposed]** 所有 Ground 图元提供 `setAppearance(next)`：

1. 先校验 next 的类型、uniform 命名与当前 primitive kind/pass 支持；
2. 构建所有需要替换的新 compiled material；
3. 所有 pass 构建成功后再一次性挂到 mesh；
4. dispose 被替换的旧 `RawShaderMaterial`；
5. geometry、mesh、system uniform wrapper、renderOrder 与 visibility 保持；
6. 任一构建失败时保持旧 Appearance 全部可用，不留下“front 是新、color 是旧”的半切换状态。

图元不 dispose 旧或新逻辑 Appearance/Material，它们都由调用方拥有。

### 11.2 相关 pass 的最小重建集

| 触发 | surface | decal | polyline | arrow |
| --- | --- | --- | --- | --- |
| 安全 Material version 变化 | color | color | polyline | arrow |
| `setFragmentCulling` | color | color | 对现有线裁切 flag 无关则无 | 无 |
| 安全 Appearance 切换 | color；stencil 固定 | color；stencil 固定 | polyline | `arrowAppearance` 只改 arrow |
| Raw Appearance version 变化 | frontStencil + backStencil + color | frontStencil + backStencil + color | polyline | arrow |
| Raw Appearance 切换 | frontStencil + backStencil + color | frontStencil + backStencil + color | polyline | arrow |
| uniform value 变化 | 无重建 | 无重建 | 无重建 | 无重建 |

Raw surface 重建全部三 pass 是有意的：factory 可能改变 vertex transform 或 state，库无法证明变化只属于 color。

### 11.3 文字原位更新与图片资源变化

文字 rectangle/shadow-volume 使用固定 topology；`setText()` 即使改变排版尺寸、旋转或锚点，也不得替换 geometry/classification：

- 先在离屏 canvas 完成候选排版，成功后复制到同一在线 canvas，只设同一 `CanvasTexture.needsUpdate`；
- 把新的 RTE 顶点、extrude/extents 数据复制进既有 `BufferAttribute.array`，原位更新 system uniform `.value`，设置 upload flag 并刷新已有 bounds；
- `BufferGeometry`、attributes、meshes、group、Appearance、user/system wrappers 和 CanvasTexture identity 全部保持；
- 内容变化不改变 Shader/schema，因此不重建 material/program；Appearance/Material version 或 fragment-culling 的独立变化才按表中规则替换 color compiled material；
- 候选若需要不同 topology 或超过预声明容量，在提交前抛错并要求显式新建图元，不能静默几何重建。

图片 Texture value/opacity 热更新只改现有 uniform `.value`。未来显式 URL/footprint 变更若需要 Geometry 事务，则仍须保留 Appearance/user wrappers，并遵守先候选后提交与 cache lease 规则。

## 12. Raw factory 生命周期与约束

### 12.1 factory 调用上下文

**[Proposed]** Raw factory 每次收到：

- `primitiveKind`；
- 当前 `pass`；
- 当前图元的 system uniforms；
- Raw Appearance 的 user uniforms；
- `createDefaultMaterial()`。

每次 factory 调用有且只有两种合法模式：

- **修改默认：**调用一次 `createDefaultMaterial()`，原地修改，并返回该同一实例；
- **完全替换：**不调用 `createDefaultMaterial()`，直接返回完全自建实例。

第二次调用 default factory，或创建 default 后返回另一实例，都以 `GROUND_RAW_FACTORY_RESULT_INVALID` 失败；context 追踪并释放尚未转移所有权的候选 default，不能泄漏。合法的 default 实例带正确 GLSL3 声明、系统 uniforms、默认 Shader 与固定状态。

### 12.2 返回值所有权转移

factory 返回成功后：

- 返回的 `RawShaderMaterial` 所有权转移给当前 Ground 图元；
- 图元在 appearance/version/pass 替换或自身 dispose 时调用 `.dispose()`；
- factory/Appearance/用户不得再主动 dispose 该返回值；
- 每次调用必须返回独立实例，不得把同一个 material 返回给两个 pass、两个图元或两次 rebuild；
- 用户可以在 factory 内持有 Shader 源模板，但不能把已返回 material 当作共享缓存。

模块级持久 `WeakMap<RawShaderMaterial, ClaimMetadata>`（或 WeakSet + 单独诊断信息）检测重复返回，而不是每个候选 set 临时创建一份；发现跨 pass、跨图元、跨 Appearance 或跨 rebuild 的同实例复用立即抛错。弱引用不会阻止 GC，却能避免一个图元 dispose 后让另一个图元失去 material/program 引用。

### 12.3 uniform 合同

- 默认 material 的 merged uniform map 引用 system/user wrapper，不 clone；
- 完全替换 material 时，用户只把 Shader 实际需要的 system/user uniforms接入返回值；未使用项可以省略；
- 返回 map 中凡与 context 同名的 entry 都必须是原 wrapper，不能复制 `.value` 后创建新 wrapper；
- factory 不得改写 system uniform map 的键或 wrapper；可读取、绑定，但系统值仍由库逐帧更新；
- user uniform 与 system uniform 冲突在调用 factory 前就报错；
- 若完整替换遗漏自己 Shader 或 pass 数学实际需要的系统 uniform，编译/运行错误归 Raw 用户；库不以“context 中所有 key 必须挂载”削弱完整替换能力。

### 12.4 Raw pass 完整性

surface/decal 的 `frontStencil`、`backStencil` 与 `color` 必须描述同一 classification footprint。Raw vertex transform 若改变 `gl_Position` 或参与裁切的数据，factory 必须在三个 pass 一致实现。color pass 还必须维持 stencil 清零；任意提前 `discard` 都可能留下非零 stencil。

库只保证 `createDefaultMaterial()` 正确，不会在完全替换的 Raw Shader 外层再秘密包裹 main。Raw 的价值就是完整控制，代价是完整责任。

## 13. Dispose 契约

### 13.1 Ground 图元 dispose

**[Proposed]** 图元 `dispose()` 幂等并执行：

1. 从内部 group 移除/失活 mesh；
2. dispose 自己拥有的 geometry；共享 geometry 若未来引入引用计数，必须通过 handle 释放；
3. 对每个 compiled pass 的 `RawShaderMaterial.dispose()`；
4. 清空 compiled records 与 Appearance 引用，阻止后续 update/setter；
5. 释放图元内部拥有的 CanvasTexture 或 URL cache handle；
6. 不 dispose user Material、user Appearance、user uniform Texture、frameState depth texture。

Three `Material.dispose()` 通过事件让 WebGLRenderer 释放 program 引用，源码证据见 `D:\my\explore\three.js\src\materials\Material.js:1201-1217` 与 `D:\my\explore\three.js\src\renderers\WebGLRenderer.js:1147-1183`。因此 compiled material 不能只从 mesh 上移除而不 dispose。

### 13.2 逻辑 Material dispose

**[Proposed]** `CesiumGroundMaterial.dispose()` 严格采用 Three 风格的“释放通知、对象可复用”语义：

- 每次调用都发出 `dispose` 通知；不增加 `version`，不清空 Shader/defines/uniforms，也不标记永久 disposed；
- 每个绑定图元监听通知，只释放**自己拥有的**相关 compiled `RawShaderMaterial` 并清空自己的 compiled record；
- Material 自己不直接 dispose compiled material，因为同一 Material 可以有多个独立消费者；
- 不 dispose user uniform values，包括 clone 产生的 Texture；
- Material 仍被图元引用时，下一次 `update`/render prepare 发现 compiled record 缺失，会按同一 version 重新编译；
- dispose 后仍允许 `setUniform()`、`clone()`、`needsUpdate=true` 和再次绑定。

`dispose()` 可以重复调用。消费者的释放处理必须幂等：若当前没有 compiled material，重复通知没有额外 GPU 效果；若中间已经因为仍被引用而重新编译，再次 `dispose()` 会释放新一轮 compiled material。这一点与“永久销毁对象”不同，不能实现成 `disposed = true` 防卫标志。

事件订阅也属于消费者生命周期：图元绑定安全 Appearance 时订阅其 Material 的 `change`/`dispose`，`setAppearance()` 成功后解除旧订阅并建立新订阅，图元自身 dispose 时解除全部订阅。`change` 只把相关 compiled record 标为 stale，保留旧 pass 到原子重建成功；`dispose` 把 record 标为 release-requested，在下一安全同步点由该消费者释放当前 compiled material。若 Material 仍绑定，同一次 update 可随即按原 version 重编译。这样既满足释放通知，也避免在 render/reconcile 的重入栈中修改 mesh。多个图元共享 Material 时各自响应，互不释放对方对象。

### 13.3 Raw Appearance dispose

`CesiumGroundRawShaderAppearance.dispose()` 使用同一通知模型：每次调用发出 `dispose`，不改变 version、不销毁 user uniforms/Texture，也不永久失效。每个绑定图元在下一安全同步点释放由该 Raw factory 为自己创建的全部相关 pass；仍绑定时随后重新调用 factory。重复通知、事件订阅解除和多消费者隔离规则与逻辑 Material 相同。

### 13.4 替换资源时先成功、后释放

所有 rebuild 都遵守事务顺序：

```text
校验 → 创建新 compiled material → 绑定成功 → dispose 旧 compiled material
```

禁止先 dispose 旧 material 再执行可同步完成的 source contract、assembler、factory、返回值或 pass-set 校验；这些失败必须保留旧状态，否则会中断 surface 三 pass 的连续性。

Three 的 Shader 编译通常惰性发生在 render，而现有同步图元 API 没有 renderer/context。首期“失败保持旧状态”只覆盖上述同步候选阶段；材质一旦绑定后才出现的 GPU compile/link 错误沿用 Three/WebGL 日志并附 kind/pass 上下文，**不承诺自动回滚**。宿主、demo 或测试可以在外部调用 `renderer.compileAsync()`/受支持的预编译流程后再接受业务切换，但不为此新增 renderer-aware 异步 `setAppearance()`。

## 14. Texture 与外部 GPU 资源

### 14.1 user uniform Texture

统一规则：谁创建，谁释放。

- Material 构造不 clone Texture；只保存传入 wrapper/value；
- 编译到多个图元不 clone Texture；所有 compiled maps 指向同一 user wrapper；
- `setUniform()` 替换 Texture 时，库不 dispose 旧 Texture；
- `setAppearance()`、图元 dispose、Material dispose 都不 dispose user Texture；
- 用户必须确保 Texture 生命周期覆盖所有引用它的图元；
- 共享 Texture 可在最后一个使用者解绑后释放，库首期不为 user Texture 提供引用计数。

### 14.2 `clone()` 的 Texture 特例

逻辑 Material clone 严格调用普通 Texture 的 `.clone()`。这与“构造/编译不 clone”不冲突：clone 是用户显式请求的新逻辑材质。克隆 Texture 的所有权归 clone 调用方；库不会因为它出现在 cloned uniforms 中就自动管理。

RenderTargetTexture 按 Three `UniformsUtils.clone` 规则告警并置 `null`。正确做法：

```ts
// [伪代码]
const cloned = source.clone(); // u_sceneDepth 若是 RT texture，此时为 null
cloned.setUniform('u_sceneDepth', renderTarget.texture); // 显式绑定外部资源
```

Ground 的系统 depth texture不在 user map 中，不会被上述逻辑误置空。

### 14.3 内部 Texture 不混入 user 所有权

- 文字 CanvasTexture 继续由文字图元拥有；
- URL 图片继续通过 `ImageTextureHandle` 引用计数；
- 内置材质若未来创建噪声 LUT，必须明确返回 owned handle，不能假装它是普通 user uniform；
- `createDefaultMaterial()` 不能创建无人记录的 Texture；Raw 用户自行创建的 Texture 仍由 Raw 用户管理，而不是随返回 material 自动 dispose。

### 14.4 Texture 内容更新与 program

Texture `needsUpdate` 是纹理上传语义，不是 Material program 失效。替换 image data、canvas 重绘、sampler 内容更新不应设置 `CesiumGroundMaterial.needsUpdate`；只有 Shader 声明/define/schema 结构变化才重编译。

## 15. 时间、持续渲染与 request-render

### 15.1 时间 uniform 更新

**[Proposed]** `CesiumGroundFrameState` 的可选值按下列规则写入系统 wrappers：

| FrameState | GLSL | 缺省 |
| --- | --- | ---: |
| `timeSeconds` | `c23_time` | `0.0` |
| `deltaSeconds` | `c23_deltaTime` | `0.0` |
| `frameNumber` | `c23_frameNumber` | `0.0` |

更新只改 `.value`，不触发 Material/Appearance version。`frameNumber` 在 GLSL 中按 float 暴露时应记录大数精度边界；周期效果优先基于 `c23_time`。

### 15.2 库不启动循环

内置 flow/pulse/scale preset 只读取 `c23_time`。库不：

- 创建 `Clock`/`Timer`；
- 调用 `requestAnimationFrame`；
- 注册全局 ticker；
- 在材质构造时强制场景持续 render；
- 根据 Shader 文本搜索 `c23_time` 来推断活跃状态。

连续渲染应用每帧传 FrameState 即可。request-render 应用必须由宿主在效果活动期间持续 invalidate/request render；效果暂停后可停止请求。

**[伪代码：request-render 宿主]**

```ts
let effectActive = true;
let pending = false;

function requestGroundFrame(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame((timestamp) => {
    pending = false;
    timer.update(timestamp);
    updateGround({
      ...baseFrameState,
      timeSeconds: timer.getElapsed(),
      deltaSeconds: timer.getDelta(),
      frameNumber: nextFrameNumber++,
    });
    renderer.render(scene, camera);
    if (effectActive) requestGroundFrame();
  });
}
```

这是宿主伪代码，不应复制到库内部。Three r183 起 `Clock` 已 deprecated；兼容 Clock 与推荐 Timer 示例见 [01](./01-three-cesium-reference.md#67-timer-与已弃用的-clock)。

### 15.3 可见性与暂停

库不自动冻结 `c23_time`。宿主可选择：

- 隐藏/后台期间不累加 elapsed，恢复后相位连续暂停；
- 使用真实 elapsed，恢复后效果跳到当前相位；
- 限制 delta 以避免 CPU 模拟突跳。

Material 只消费输入；这三种产品语义不应固化进 Ground ABI。`Timer.connect(document)` 可避免页面隐藏时的大 delta，参考 `D:\my\explore\three.js\src\core\Timer.js:36-73`、`:146-174`。

## 16. 性能策略

### 16.1 每帧热路径

热路径只允许：

- 原地更新 number；
- `Vector/Matrix/Color.copy/set/fromArray`；
- 替换 Texture wrapper 的 `.value`；
- 把同一 FrameState 时间写入每图元 system wrapper。

禁止每帧：

- 拼接 Shader 字符串；
- 创建新的 `RawShaderMaterial`；
- stringify uniform map；
- clone uniforms/Texture；
- 设置 `needsUpdate=true`；
- 重跑 Raw factory。

### 16.2 结构变化合并

如果 UI 同一事件同时改 Shader、defines 与 schema，调用方应完成所有修改后只写一次 `needsUpdate=true`。实现按 version 快照在下一 update/reconcile 合并重建；不要每个属性 setter 立即编译一次。

### 16.3 program 预热与计数

示例/测试记录：

```ts
const before = renderer.info.programs?.length ?? 0;
for (let i = 0; i < 120; i++) {
  material.setUniform('u_phase', i / 120);
  renderOneFrame();
}
const after = renderer.info.programs?.length ?? 0;
expect(after).toBe(before);
```

源码或 defines 变化的测试要等 renderer 真正编译后再断言；只构造 `RawShaderMaterial` 不会立即产生 program。旧 material dispose 后 program 也可能因其他图元仍引用而保留，因此断言应基于“变体集合与引用关系”，不能武断要求数组立刻减 1。

### 16.4 共享的性能边界

共享逻辑 Material 节省 user 状态、使 program key 一致，但不会把 N 个 draw call 合为一个。真正减少 draw call 需要几何 batching/instancing，超出本期范围。Raw factory 返回独立 material 也不会阻碍 program 共享，只要最终 source/defines/state key 一致。

## 17. 边界条件、错误模式与开发期诊断

| 错误 | 发现时机 | 行为 | 诊断要点 |
| --- | --- | --- | --- |
| user uniform 以 `c23_`/`czm_` 开头 | 构造/schema rebuild | 抛错 | 输出冲突名与保留前缀 |
| user/system uniform 同名 | compile merge | 抛错 | 不允许静默覆盖 |
| `setUniform()` 使用未知键 | 调用时 | 抛错 | 提示“改 schema 后 needsUpdate=true” |
| schema 改了未增 version | 开发期 reconcile | 抛错 | 输出旧/新排序键 |
| Shader/defines 改了未增 version | 开发期结构快照检查 | 抛错或强警告 | 不静默使用旧 program |
| Material/Raw Appearance `dispose()` 后仍被引用 | 下一 update | 各消费者释放自身 compiled 后正常重新编译 | dispose 是释放通知，不是永久失效 |
| Raw factory 未返回 `RawShaderMaterial` | factory 返回时 | 抛错，保留旧 pass | 包含 kind/pass |
| Raw factory 重复返回同一实例 | factory 返回时 | 抛错 | 指出所有权转移冲突 |
| Raw factory 缺少某 pass | reconcile | 抛错，原子回滚 | surface 列出三个必需 pass |
| Raw user uniform 冲突 | factory 前 | 抛错 | 不调用 factory |
| Raw surface 三 pass 顶点变换不一致 | 无法完全静态证明 | 开发提示 + 文档责任 | 建议从 default material 同构修改 |
| Raw color 使用 `discard` 留 stencil | 视觉/集成测试 | Raw 用户责任 | 提示零 alpha 清理规则 |
| user Texture 提前 dispose | render | 调用方错误 | 库不复活、不接管 |
| clone RenderTargetTexture | clone 时 | 与 Three 一致：warn + null | 要求显式重新绑定 |
| request-render 未请求下一帧 | 运行时 | 动画停止 | 不由库启动 RAF |

开发错误信息必须包含：appearance 类型、primitive kind、pass、material/appearance version 和相关 uniform 名；不要只抛“shader compile failed”。Shader 编译日志还应保留带行号的最终组装源码，详见 05/10。

## 18. 典型生命周期示例

### 18.1 共享、克隆与释放

**[伪代码]**

```ts
const shared = createPulsePointMaterial({ periodSeconds: 1.5, phase: 0.0 });
const shifted = shared.clone();
shifted.setUniform('u_phase', 0.5);

const a = new CesiumGroundPointPrimitive({ ...aOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: shared }),
});
const b = new CesiumGroundPointPrimitive({ ...bOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: shared }),
});
const c = new CesiumGroundPointPrimitive({ ...cOptions,
  appearance: new CesiumGroundMaterialAppearance({ material: shifted }),
});

// ...render；shared 的值更新影响 a/b，不影响 c

a.dispose();
b.dispose();
c.dispose();

// 若 shifted.clone() 生成过 Texture 副本，先由用户 dispose 这些副本。
disposeTexturesOwnedByCaller(shifted);
shifted.dispose();
shared.dispose();
```

### 18.2 修改 Shader/schema

**[伪代码]**

```ts
material.uniforms.u_noiseScale = { value: 2.0 };
material.fragmentShader = sourceWithNoiseScale;
material.needsUpdate = true;

// 下一次 reconcile 只替换使用该 Material 的着色 pass。
// surface 的 front/back stencil 不动，geometry 不动。
```

### 18.3 Raw Appearance 原子重建

**[伪代码]**

```ts
let variant = 'a';
const raw = new CesiumGroundRawShaderAppearance({
  uniforms: { u_gain: { value: 1.0 } },
  factory(ctx) {
    const result = ctx.createDefaultMaterial();
    result.fragmentShader = buildVariant(ctx.pass, variant, result.fragmentShader);
    return result;
  },
});

variant = 'b';
raw.needsUpdate = true; // 下一次对 surface 三 pass 原子重跑 factory
```

## 19. 测试与验收矩阵

| 场景 | 观测 | 通过条件 |
| --- | --- | --- |
| 每帧更新时间/phase 300 帧 | `renderer.info.programs` | 数量不增长 |
| 两图元共享同一 Material | uniform wrapper identity | user wrapper 相同，system wrapper 不同 |
| clone 标量相位 | A/B 视觉与 wrapper | phase 独立 |
| clone Vector/Color | 对象 identity | 新对象，修改互不影响 |
| clone 普通 Texture | Texture identity/释放 | 新 Texture；调用方释放；图元不释放 |
| clone RenderTargetTexture | warning/value | 警告且 cloned value 为 null |
| clone 普通对象 | identity | 按严格 Three 语义保持引用 |
| 未知 `setUniform` | 错误 | 同步抛错，version 不变 |
| schema 改变且未 needsUpdate | 开发错误 | 下一 reconcile 报旧/新 schema |
| Shader/define + needsUpdate | version/program | version +1，只出现预期变体 |
| surface 安全 Material version 变化 | mesh/material identity | 只替换 color，stencil 与 geometry 不变 |
| Raw surface version 变化 | factory call count | front/back/color 各一次，原子切换 |
| polyline `arrowAppearance` 切换 | pass identity | 只替换 arrow，line geometry/material 不变 |
| text canvas 内容更新 | program/geometry | 两者不变，仅 Texture 上传 |
| appearance 构建失败 | 旧渲染 | 全部旧 pass 保留，无半切换 |
| primitive dispose | material dispose spy | 所有 compiled Raw 一次；逻辑 Material/Texture 零次 |
| shared Material 先后 dispose 两图元 | program refs | 第一个不破坏第二个；最后引用释放后 program 可回收 |
| logical Material `dispose()`，仍绑定两个图元 | consumer dispose spy/version | 两个消费者各释放自己的 compiled；version 不变；下一 update 各自重编译 |
| logical Material 连续 `dispose()` 两次 | consumer dispose spy | 没有 compiled 时第二次无额外 GPU dispose，仍发通知且不报错 |
| URL 图片两个 handle | cache/refCount | 第一个 release 不 dispose，最后一个才 dispose |
| 缺省时间 | uniform/截图 | 三时间值为 0，结果静态且可重复 |
| request-render 停止请求 | frame count | 动画停住，无隐藏 RAF |

## 20. 关键决策汇总

1. logical Material 可共享；compiled `RawShaderMaterial` 不跨图元/pass共享；底层 `WebGLProgram` 交给 Three 共享。
2. user uniform value 变化不编译；Shader、defines、schema 变化必须 `needsUpdate=true`。
3. 安全 Appearance version 取 `material.version`；Raw Appearance 自己维护 version。
4. `setUniform()` 只改既有 wrapper 的 `.value`，未知键报错。
5. Material clone 严格遵循 Three `UniformsUtils.clone`，包括普通 Texture clone 与 RenderTargetTexture 置 null；克隆资源由调用方释放。
6. 图元拥有 factory/组装器产出的每个 `RawShaderMaterial`，不拥有 user Material 或 user Texture。
7. appearance/fragment-culling/材质重建按 pass 最小化并保持 geometry；Raw surface 因无法推导影响范围而三 pass 全重建。
8. rebuild 先成功创建并绑定新资源，再 dispose 旧资源；失败原子回滚。
9. 逻辑 Material `dispose()` 发通知让各消费者释放自己的 compiled material；对象可复用、version 不变、用户 Texture 不受影响。
10. 时间由宿主 FrameState 提供；无内部 Clock/Timer/RAF，request-render 由宿主持续请求。

## 21. 验收清单

- [ ] 所有权表落实到代码注释与单元测试，用户资源没有隐式 dispose。
- [ ] 同一 Material 多图元共享 user wrappers，但 system wrappers 按图元隔离。
- [ ] `setUniform()` 保持 wrapper identity、拒绝未知键且不改变 version。
- [ ] source/defines/schema 改变只有显式 `needsUpdate=true` 才进入重编译。
- [ ] compile signature 不含任何 uniform value 或时间值。
- [ ] 安全 surface Material 变化只重建 color；Raw surface version 变化重跑三 pass。
- [ ] Raw factory 每次返回独立 `RawShaderMaterial`，重复实例在开发模式被拒绝。
- [ ] `setAppearance()` 构建失败保留全部旧 pass；成功后才 dispose 旧 compiled materials。
- [ ] Material clone 与 `UniformsUtils.clone` 的 Texture、RenderTargetTexture、数组和普通对象行为逐项测试。
- [ ] clone 生成的 Texture 由调用方 dispose；图元/Material 不越权释放。
- [ ] primitive dispose 幂等并释放所有 compiled Raw/自有 geometry，不释放 logical Material/user Texture/depth texture。
- [ ] 每帧 uniform 更新不增加 `renderer.info.programs`；结构变化只产生预期 program 变体。
- [ ] 文字 canvas/图片 value 更新不重编译；appearance 切换不重建 geometry。
- [ ] 缺省时间为 0；request-render 场景没有隐藏 RAF。
- [ ] Material dispose 通知可重复；每个消费者只释放自己的 compiled material，仍绑定时下一 update 可重编译且 version 不变。
- [ ] schema 漏标、保留字冲突和 Raw pass 缺失均有包含 kind/pass/version 的错误。

---

上一篇：[07 内置效果](./07-built-in-effects.md) · 下一篇：[09 实施路线](./09-implementation-roadmap.md)
