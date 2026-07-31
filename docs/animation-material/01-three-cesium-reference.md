# Three.js / Cesium 材质扩展源码调研与采用结论

> 状态：**Design / Proposed**。本文记录源码事实与采用理由，不表示这些 API 已经在当前项目实现。
>
> 导航：[文档索引](./README.md) · 下一篇：[02 当前渲染管线](./02-current-rendering-pipeline.md)

## 1. 目标

本文回答四个问题：

1. Three.js 如何区分普通 Shader 扩展与完全自管的 Raw Shader，如何判断 program 是否需要重新编译；
2. Cesium 如何把 `Primitive`、`Appearance`、`Material`、逐帧状态和贴地分类管线分层；
3. 哪些机制适合移植到 `cesium-to-three`，哪些机制会引入不必要的框架、隐式生命周期或脆弱的字符串改写；
4. 为什么目标方案必须同时公开 `CesiumGroundMaterialAppearance` 与 `CesiumGroundRawShaderAppearance`，而不是只提供一个万能 Shader 回调。

最终结论是：动画不需要独立编排层。稳定 Shader 读取宿主更新的 uniform，即可表达流动、呼吸、缩放和绝大多数程序化特效；贴地几何、RTE、深度重建、stencil 清理和资源生命周期仍归 Ground 管线负责。

## 2. 版本、证据范围与标记

### 2.1 本次核验版本

| 代码库 | 本地路径 | 核验提交 | 版本事实 |
| --- | --- | --- | --- |
| 当前项目 | `D:\my\code\cesium-to-three` | `32a6b244b7c0cb731ca35165c46e8fe31248c718` | 包版本 `0.1.9`；声明依赖 `three ^0.183.0`，锁文件实际解析到 `0.183.2` |
| Three.js 参考源码 | `D:\my\explore\three.js` | `2a005fdbad6b8503a8a70edfdd279b79c5e04b49` | `package.json` 为 `0.185.0`，即 r185 开发线快照 |
| Cesium 参考源码 | `D:\my\explore\cesium` | `effe290c08dc340a7a6bd4435367a7d092c6b2b9` | `@cesium/engine 26.1.0` |

行号均以以上提交为准。当前项目的 Three 运行基线可由 `package.json:39-50` 与 `package-lock.json:1542-1546` 复核；Three 参考树版本见 `D:\my\explore\three.js\package.json:2-4`；Cesium 参考树版本见 `D:\my\explore\cesium\packages\engine\package.json:2-4`。参考树比当前项目的 Three 运行版本新，因此本文只采用在 r183 基线已经成立的核心语义；r185 新增或变化的行为会单独注明。

### 2.2 标记约定

- **[Current]**：提交 `32a6b244…` 中已经存在的行为。
- **[Source]**：Three.js 或 Cesium 在上述固定提交中的源码事实。
- **[Proposed]**：本设计集要求新增或调整的行为。
- **[伪代码]**：用于说明契约，不保证可直接复制编译；完整 TypeScript 与 GLSL 接口分别见 [04 公共 API](./04-public-api-design.md) 和 [05 Shader ABI](./05-shader-abi.md)。

## 3. 前置阅读

- [README：核心结论与阅读顺序](./README.md)
- [02：当前面、线、文字、图片与箭头管线](./02-current-rendering-pipeline.md)
- [03：目标分层](./03-target-architecture.md)
- [05：完整 Shader ABI](./05-shader-abi.md)

## 4. 非目标

本文不设计 timeline、tween、关键帧、动画序列化、内部 `requestAnimationFrame`、Entity/Property 系统或 WebGPU/TSL 管线；也不要求复刻 Cesium Fabric JSON、Scene 2D/Columbus View 或 Cesium 的全部 automatic uniforms。本文只研究对 Ground 材质扩展直接有用的分层、缓存和生命周期语义。

## 5. 设计过程

调研按“谁负责什么”而不是按类名机械映射：

1. 先确认当前项目的不可破坏约束：surface 是 front stencil、back stencil、color 三个连续命令；polyline 与 arrow 是独立 pass；RTE、log depth 和贴地深度重建属于管线而不是效果 Shader。
2. 再查看 Three 的自定义 Shader、program cache、uniform 上传、clone 与 dispose 行为，确定哪些状态影响编译，哪些状态只影响每帧上传。
3. 查看 Cesium 的 `Appearance` / `Material`、Fabric、`MaterialProperty`、`CustomShader` 和 Ground 分类命令，确定安全扩展面与全管线扩展面的边界。
4. 最后把两套参考的共同点收敛为本项目规则：**稳定接口函数 + 动态 uniform；逻辑材质与编译材质分离；安全入口保护 Ground pass；Raw 入口显式接管每个 pass。**

## 6. Three.js 源码调研

### 6.1 `ShaderMaterial`：自定义 Shader，但仍接受 renderer 注入

**[Source]** `D:\my\explore\three.js\src\materials\ShaderMaterial.js:13-22` 明确说明：`ShaderMaterial` 仅用于 `WebGLRenderer`，renderer 会在用户代码之外提供内建 attributes 和 uniforms；不希望这些声明被自动前置时应使用 `RawShaderMaterial`。

`ShaderMaterial` 把“影响程序结构”和“只影响运行值”的状态分开：

- `defines` 是编译期 `#define` 字典，定义与示例位于 `ShaderMaterial.js:71-89`；
- `uniforms` 是 `{ name: { value } }` 映射，名称必须与 GLSL 对应；源码注释明确 uniform 每帧刷新，改变 value 会立即进入 Shader，见 `ShaderMaterial.js:91-113`；
- `vertexShader` / `fragmentShader` 是程序源，见 `ShaderMaterial.js:123-134`；
- `uniformsNeedUpdate` 是在 `Object3D.onBeforeRender` 修改 uniform 时强制上传的低层开关，见 `ShaderMaterial.js:253-260`，它不是“重新编译 Shader”的开关。

**采用结论**：

- **[Proposed] 采用** `{ value }` uniform 容器和“改 value 不重编译”的心智模型；`CesiumGroundMaterial.setUniform()` 只更新已声明键的 `.value`。
- **[Proposed] 采用** `defines` 与 Shader 源属于 program identity 的规则。
- **[Proposed] 不直接采用** `ShaderMaterial` 的隐式内建前缀。Ground Shader 需要可审计的 GLSL3 ABI，系统声明由本项目组装器显式生成，避免 Three 版本变化悄悄改变用户入口。

### 6.2 `RawShaderMaterial`：完全控制 GLSL 声明，不等于完全绕开 Three

**[Source]** `D:\my\explore\three.js\src\materials\RawShaderMaterial.js:3-8` 的定义很窄：它与 `ShaderMaterial` 工作方式相同，只是不自动前置内建 uniform 与 attribute 声明。实现本身继承 `ShaderMaterial`，仅设置 `isRawShaderMaterial` 和 `type`，见 `RawShaderMaterial.js:12-38`。

这意味着 Raw 仍然使用 Three 的：

- material render state；
- uniform 上传；
- program cache；
- `needsUpdate/version`；
- `dispose` 事件与 GPU program 引用释放。

**采用结论**：

- **[Proposed] 采用** `RawShaderMaterial` 作为“编译后的 pass 材质”，而不是把它当作逻辑材质 API。
- **[Proposed] 新增同级 Raw 入口** `CesiumGroundRawShaderAppearance`。它让用户为 `frontStencil`、`backStencil`、`color`、`polyline`、`arrow` 返回独立 `RawShaderMaterial`，既可修改 `createDefaultMaterial()` 的结果，也可完全替换。
- Raw 权限意味着 Raw 责任：surface 顶点变换若会改变 classification，必须同步处理 front/back/color；库只校验明显冲突，不可能替用户证明三 pass 几何等价。

### 6.3 `needsUpdate`、`version` 与 `onBeforeCompile`

**[Source]** Three `Material.version` 从 0 开始，统计 `needsUpdate = true` 的次数，见 `D:\my\explore\three.js\src\materials\Material.js:468-475`；setter 只在写入 `true` 时递增版本，见 `Material.js:1219-1231`。renderer 比较 `material.version` 与已记录版本，发生变化才进入 program 重新选择路径，见 `D:\my\explore\three.js\src\renderers\WebGLRenderer.js:2398-2519`。

`onBeforeCompile` 可以在编译前改 Shader 源和 uniforms，见 `Material.js:521-533`；`customProgramCacheKey()` 用来描述回调所依赖的外部状态，默认返回回调源码字符串，见 `Material.js:535-548`。renderer 先计算 program key，再在没有该 key 的 program 时调用 `onBeforeCompile`，见 `WebGLRenderer.js:2165-2229`。因此仅让回调闭包捕获一个变化值而不改变 `customProgramCacheKey()`，会把不同程序错误地视为同一个缓存项。

**采用结论**：

- **[Proposed] 采用** `needsUpdate/version` 的显式失效模型：uniform 值变化不递增；`fragmentShader`、`defines` 或 uniform schema 变化后必须 `needsUpdate = true`。
- **[Proposed] 不公开** `onBeforeCompile` 式字符串注入作为核心 ABI。它适合局部改 Three 内建材质，但 Ground 有多个相关 pass，回调作用域与缓存键很容易不一致。
- **[Proposed] appearance 也有版本**：安全 `CesiumGroundMaterialAppearance.version` 读取其 `material.version`；Raw appearance 由自己的 `needsUpdate/version` 驱动工厂重跑。

### 6.4 Three program cache 的实际组成

**[Source]** 对自定义 Shader，Three 先按完整 Shader 文本取得 vertex/fragment stage ID，见 `D:\my\explore\three.js\src\renderers\webgl\WebGLPrograms.js:96-119` 与 `WebGLShaderCache.js:87-112`。program key 包含：

- 内建 shader ID，或自定义 vertex/fragment stage ID；
- 按枚举顺序加入的 `defines` 名称和值；
- Raw 之外的 renderer/geometry/material feature 参数；
- `customProgramCacheKey()`；

对应实现见 `WebGLPrograms.js:400-436`。同 key 的 program 增加 `usedTimes`，最后一个引用释放时才销毁 WebGL program，见 `WebGLPrograms.js:624-660`。`material.dispose()` 触发 renderer 清理该 material 持有的 program 引用，见 `WebGLRenderer.js:1147-1183`。

**采用结论**：

- **[Proposed] 逻辑缓存键不能包含 uniform 值**，否则 `c23_time` 每帧都会制造新 program。
- program identity 必须包含组装器版本、`primitiveKind`、`pass`、GLSL 源、排序后的 defines、排序后的 uniform schema 名称与影响源码的系统 feature flags。
- 每个图元/pass 可以拥有独立的 `RawShaderMaterial` 和系统 uniform，但只要 Shader/defines 相同，Three 仍会共享底层 `WebGLProgram`；不需要冒险共享带有图元状态的 compiled material 实例。
- 测试必须观察 `renderer.info.programs`。该数组直接指向 program cache 的 `programs`，见 `WebGLRenderer.js:478` 和 `WebGLInfo.js:64`。

### 6.5 uniform、clone 与 Texture 陷阱

**[Source]** `ShaderMaterial.copy()` 使用 `cloneUniforms()`，同时复制 Shader 文本和 defines，见 `ShaderMaterial.js:278-305`。Three 的 `cloneUniforms()` 会克隆 Color/Matrix/Vector/Quaternion，也会克隆普通 Texture；render-target texture 无法克隆时写入 `null` 并告警，见 `D:\my\explore\three.js\src\renderers\shaders\UniformsUtils.js:10-75`。`Uniform.clone()` 对带 `clone()` 方法的值也会调用 `clone()`，见 `D:\my\explore\three.js\src\core\Uniform.js:32-42`。

**采用结论**：

- **[Proposed] `CesiumGroundMaterial.clone()` 严格采用 `UniformsUtils.clone` 语义**：创建新的 uniform map 与 wrapper；Three 对象（包括普通 Texture）调用 `.clone()`；render-target texture 告警并置为 `null`；Three 对象数组逐项 clone；普通数组 `slice()`；其余值保持引用。
- clone 因此可能创建新的 Texture 对象。图元和逻辑 Material 都不会自动 dispose 这些克隆 Texture；调用 `clone()` 的用户拥有并负责释放它们。系统 depth texture 不在 user uniforms 中，因此不参与 clone。
- 同一个逻辑材质直接绑定多个图元时，user uniform wrapper 与 value 都共享；需要独立 `phase` 时调用 `clone()`。
- 图元永远不销毁逻辑材质或 user uniform 中的 Texture；只销毁自身编译出的 `RawShaderMaterial`。

完整所有权表见 [08 生命周期、缓存与资源](./08-lifecycle-cache-resources.md)。

### 6.6 `dispose()` 是显式释放通知

**[Source]** `Material.dispose()` 自身只派发 `dispose` 事件，见 `D:\my\explore\three.js\src\materials\Material.js:1201-1217`；WebGLRenderer 监听该事件并释放 material 的 program 引用，见 `WebGLRenderer.js:1147-1183`。它不会自动销毁 uniform 里引用的 Texture。

**采用结论**：

- 编译出的 `RawShaderMaterial.dispose()` 必须由创建/持有它的 Ground 图元调用。
- 逻辑 `CesiumGroundMaterial.dispose()` 采用 Three 风格的可复用通知：它发出 dispose 事件，由每个绑定图元释放自己拥有的 compiled material；不销毁外部 Texture，也不把逻辑 Material 永久标记为不可用。若仍被图元引用，下一次 update 可按原 version 重新编译。
- 用户从 Raw factory 返回的 `RawShaderMaterial` 视为把所有权转交给图元；工厂不能把同一个实例返回给两个 pass 或两个图元。

### 6.7 `Timer` 与已弃用的 `Clock`

**[Source]** Three 在 r183 已把 `Clock` 标记为 deprecated，并在构造时提示使用 `THREE.Timer`，见 `D:\my\explore\three.js\src\core\Clock.js:3-17`、`:61-62`。`Clock.getDelta()` 每次查询都会采样 `performance.now()` 并推进累计时间，见 `Clock.js:95-129`。

`Timer` 的目标正是消除这个查询副作用：每个 simulation step 显式 `update()` 一次，随后可重复读取稳定的 delta/elapsed；还可连接 Page Visibility API 避免后台恢复时产生超大 delta，见 `D:\my\explore\three.js\src\core\Timer.js:1-13`、`:36-73`、`:146-174`。

**采用结论**：

- **[Proposed] Ground 库不持有 `Clock`/`Timer`，也不启动 RAF。** 公共输入只是 `timeSeconds`、`deltaSeconds`、`frameNumber`。
- 为满足现有项目与用户明确要求，示例会给出 `THREE.Clock` 版本，但必须注明 r183 起已弃用；推荐新代码使用 `THREE.Timer`。
- `Clock` 示例必须用 `elapsed += clock.getDelta()`，不要同一帧再调用 `getElapsedTime()`，否则会二次采样。

**[伪代码：兼容当前项目的 Clock 驱动]**

```ts
const clock = new THREE.Clock(); // r183 起 deprecated；仅兼容示例
let timeSeconds = 0;
let frameNumber = 0;

function render(): void {
  const deltaSeconds = clock.getDelta();
  timeSeconds += deltaSeconds;
  ground.update({
    ...baseFrameState,
    timeSeconds,
    deltaSeconds,
    frameNumber: frameNumber++,
  });
  renderer.render(scene, camera);
  requestAnimationFrame(render); // 宿主拥有循环，不是 Ground 内部行为
}
```

**[伪代码：推荐的 Timer 驱动]**

```ts
const timer = new THREE.Timer();
timer.connect(document);
let frameNumber = 0;

function render(timestamp: number): void {
  timer.update(timestamp);
  ground.update({
    ...baseFrameState,
    timeSeconds: timer.getElapsed(),
    deltaSeconds: timer.getDelta(),
    frameNumber: frameNumber++,
  });
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
```

## 7. Cesium 源码调研

### 7.1 `Appearance`：完整 Shader 与 render state；`Material`：表面函数

**[Source]** Cesium `Appearance` 被定义为 Primitive 的完整 vertex/fragment Shader 与 render state，见 `D:\my\explore\cesium\packages\engine\Source\Scene\Appearance.js:8-22`。`material` 可运行时替换，见 `Appearance.js:36-44`。完整 fragment source 由可选 defines、`material.shaderSource` 和 appearance fragment source拼接，见 `Appearance.js:123-143`；透明性又会影响 depth mask 和 blending，见 `Appearance.js:145-173`。

`MaterialAppearance` 进一步把几何所需 vertex format、材质支持级别、Shader 与 render state 固定在一个可组合层，默认创建 Color Material，见 `D:\my\explore\cesium\packages\engine\Source\Scene\MaterialAppearance.js:49-97`；`MaterialSupport` 会影响所需顶点属性和 Shader 复杂度，见 `MaterialAppearance.js:168-200`。

**采用结论**：

- **[Proposed] 采用 Cesium 的职责分离**：Geometry/Primitive 负责 placement、RTE、depth 与生命周期；Appearance 负责 pass 和 render state；Material 只负责表面求值。
- **[Proposed] `CesiumGroundMaterialAppearance` 只允许实现 `c23_getMaterial`**。库组装并保护 shape 裁切、log depth、premultiplied alpha、stencil 清理和固定 render state。
- **[Proposed] `CesiumGroundRawShaderAppearance` 与安全入口同级**，不是安全入口里的隐藏 escape hatch；这让类型和责任边界可见。

### 7.2 Cesium Material 与 Fabric

**[Source]** Cesium `Material` 持有 `type`、`shaderSource`、sub-materials、uniforms 与 translucency，见 `D:\my\explore\cesium\packages\engine\Source\Scene\Material.js:273-324`。`Material.fromType()` 从注册模板创建实例并覆盖 uniforms，见 `Material.js:395-430`。

Fabric 接受 `type`、`materials`、`uniforms`、`components`、`source`，并在 strict 模式检查无效属性、未使用 uniform 与 material，见 `Material.js:230-250`、`:790-839`。如果使用 `components`，Cesium 生成 `czm_getMaterial(czm_materialInput)`；如果提供 `source`，则直接拼入，见 `Material.js:854-887`。Uniform 声明、唯一重命名和 getter map 在 `Material.js:1150-1251` 生成；sub-material 会递归组合并重命名 `czm_getMaterial`，见 `Material.js:1305-1349`。

Cesium Material 也承担由 URL/Resource 创建的内部纹理生命周期：`update(context)` 把异步图像变成 Texture、平滑替换并销毁旧内部 Texture，再递归更新 sub-material，见 `Material.js:531-642`；`destroy()` 销毁 `_textures` 与 sub-material，见 `Material.js:658-691`。`ClassificationPrimitive.update()` 会逐帧调用 appearance material 的 `update(context)`，见 `D:\my\explore\cesium\packages\engine\Source\Scene\ClassificationPrimitive.js:1040-1048`。

这套系统证明“稳定材质函数 ABI + uniforms + 受控组装”可长期扩展，但完整 Fabric 也带来 JSON DSL、类型推断、token 替换、全局类型注册和 sub-material 命名管理。

**采用结论**：

- **[Proposed] 采用** Material 函数思路，但不用 Fabric JSON。用户直接写 GLSL，入口固定为：

```glsl
c23_material c23_getMaterial(c23_materialInput input);
```

- **[Proposed] 采用** 保留字、uniform 重名和 ABI 校验；用户 uniform 禁止 `czm_`、`c23_` 前缀。
- **[Proposed] 不采用** Fabric registry、sub-material、components DSL、字符串 token 重命名和全局 material type。它们超出首期需求，也会让类型、缓存键和错误定位复杂化。
- **[Proposed] 不采用** Cesium Material 的隐式 URL/Resource texture manager。user uniform Texture 借用外部引用；只有现有 text/image 内部资源继续由其明确 owner 管理。

### 7.3 `czm_materialInput` / `czm_material` 给出的 ABI 启示

**[Source]** Cesium 的 `czm_materialInput` 包含 `s/st/str`、`normalEC`、tangent-to-eye、`positionToEyeEC` 及地形属性，见 `D:\my\explore\cesium\packages\engine\Source\Shaders\Builtin\Structs\materialInput.glsl:1-30`。`czm_material` 包含 diffuse、specular、shininess、normal、emission、alpha，见 `D:\my\explore\cesium\packages\engine\Source\Shaders\Builtin\Structs\material.glsl:1-22`；默认材质从输入 normal 初始化，见 `D:\my\explore\cesium\packages\engine\Source\Shaders\Builtin\Functions\getDefaultMaterial.glsl:17-26`。

Ground polyline 在算出 `s/t` 后调用 `czm_getMaterial`，再以 `diffuse + emission` 与 alpha 输出并预乘，见 `D:\my\explore\cesium\packages\engine\Source\Shaders\PolylineShadowVolumeFS.glsl:72-83`。Ground surface material 分支也使用相同最终颜色公式，见 `D:\my\explore\cesium\packages\engine\Source\Shaders\ShadowVolumeAppearanceFS.glsl:117-148`。

**采用结论**：

- **[Proposed] `c23_materialInput`** 在 Cesium 思路上补充当前 Ground 实际可稳定提供的 `localMeters`、`baseColor`、`isStroke`、`positionEC`，以及折线的沿线/横向米距离、总长和 `metersPerPixel`。
- **[Proposed] `c23_material`** 保留 `diffuse`、`emission`、`alpha` 等字段；最终 straight RGB 为 `diffuse + emission`，框架在执行 shape/coverage 后统一预乘 alpha。
- 输入值是否有效由 `C23_SURFACE`、`C23_POLYLINE`、`C23_DECAL`、`C23_ARROW` 编译期 define 明确，而不是以魔法零值猜测。

完整字段、坐标空间与初始化值只在 [05 Shader ABI](./05-shader-abi.md) 定义，本文不建立第二份真相源。

### 7.4 `MaterialProperty`：时间求值层为何不采用

**[Source]** Cesium `MaterialProperty` 抽象 `isConstant`、`definitionChanged`、`getType(time)`、`getValue(time, result)` 与 `equals`，见 `D:\my\explore\cesium\packages\engine\Source\DataSources\MaterialProperty.js:23-80`。静态 helper 会按时刻选择 Material 类型、必要时创建新 Material，再把属性值写入 `material.uniforms`，见 `MaterialProperty.js:82-109`。

**不采用原因**：

- 这是 Cesium Entity/DataSource 层的时间属性系统，不是 Ground Shader 的必要条件；
- 它引入定义变更事件、类型切换、对象复用和 JulianDate 求值，实质上会演变为本需求明确排除的动画编排层；
- Shader 动画只需宿主提供统一秒数，CPU 动态属性可直接调用 `setUniform()`。

因此首期不发布 `MaterialProperty` 等价物，也不把函数值或回调塞进 uniform ABI。

### 7.5 `CustomShader`：显式函数契约与资源责任

**[Source]** Cesium `CustomShader` 要求用户通过固定签名的 `vertexMain` / `fragmentMain` 修改受控输入输出，支持显式 uniforms 与 varyings，见 `D:\my\explore\cesium\packages\engine\Source\Scene\Model\CustomShader.js:77-120`、`:122-169`。`setUniform()` 只允许构造时已声明的键，普通值更新不改变 Shader，Texture 则委托 texture manager 异步加载，见 `CustomShader.js:408-433`。若使用 Texture，必须逐帧 `update` 并在不用时 `destroy`，见 `CustomShader.js:55-72`、`:435-470`。

**采用结论**：

- **[Proposed] 采用** 固定函数签名、已声明 uniform 才能 `setUniform()`、开发期校验与明确 dispose 契约。
- **[Proposed] 不采用** CustomShader 自带 Texture manager；本项目 user uniform Texture 始终外部所有，避免一个逻辑材质共享到多图元时发生重复加载或误销毁。
- **[Proposed] 不采用** Model PBR 的 mode/lighting/translucency 全套语义。首期 Ground 是 unlit/表面颜色式 ABI，完整管线控制走 Raw Appearance。

### 7.6 Ground surface：分类管线不能被安全 Material 破坏

**[Source]** Cesium `GroundPrimitive` 明确把 geometry instance 与 Appearance 分离，并说明它把几何贴到 terrain/3D Tiles，见 `D:\my\explore\cesium\packages\engine\Source\Scene\GroundPrimitive.js:25-48`。构造时接收 Appearance，见 `GroundPrimitive.js:53-66`、`:114-144`，内部创建 shadow volume 并委托 `ClassificationPrimitive`，见 `GroundPrimitive.js:825-890`。

`ClassificationPrimitive` 的 stencil-depth 状态关闭颜色写入，以 depth fail 对 front/back 执行 decrement/increment；color pass 在 stencil 非零处绘制，并无论 stencil/depth 测试结果如何清零，使用 premultiplied alpha blending，见 `D:\my\explore\cesium\packages\engine\Source\Scene\ClassificationPrimitive.js:332-395`。Shader 程序中 stencil 与最终 color 分开构建，Appearance Material 进入 color Shader，见 `ClassificationPrimitive.js:473-523`、`:583-612`。命令创建时 stencil-depth 与 fill 成对，Material uniforms 只合并到 color command，见 `ClassificationPrimitive.js:645-714`。

**采用结论**：

- **[Proposed] 安全 Material 只能进入 surface `color` pass**；`frontStencil` / `backStencil` 必须保持库控制。
- 透明或 footprint 外片元在安全 color pass 不能提前 `discard`，必须输出零 alpha，让 color pass 仍执行 stencil zero 操作；颜色由框架预乘。
- 只有 Raw Appearance 才能接管三 pass；若 Raw color `discard` 导致 stencil 残留，属于 Raw 使用者责任，开发模式只能提示。

注意：Cesium 在该提交中用一个 two-sided stencil-depth command 表达 front/back operation；当前 Three 项目为了显式面选择使用两个 mesh。两者语义相同，不要求命令数量逐字复制。

### 7.7 Ground polyline：独立 Shader、独立 command

**[Source]** `GroundPolylinePrimitive` 默认使用 `PolylineMaterialAppearance`，见 `D:\my\explore\cesium\packages\engine\Source\Scene\GroundPolylinePrimitive.js:30-49`、`:96-129`。它把 `appearance.material.shaderSource` 前置到 polyline FS，并按 Material 是否读取 width/angle 决定 varying define，见 `GroundPolylinePrimitive.js:317-396`；随后为 2D/morph 派生程序，见 `:398-456`。每个底层 vertex array（`primitive._va[i]`）对应一个 color command，而不是每条 polyline segment 一个 command；Material uniform map 合入每条 command，见 `:486-557`。

**采用结论**：

- **[Proposed] polyline 不是 surface stencil 的一个变体**，保持独立 `polyline` pass；arrow 也保持独立 `arrow` pass。
- 当前 `s/t`、沿线米距离和横向距离从内部临时变量提升为正式 `c23_materialInput` 字段。
- 当前硬编码 dash 改为内置 `CesiumGroundMaterial`，自定义流动线与默认虚线走同一入口。

### 7.8 `FrameState`：时间属于宿主帧，不属于材质调度器

**[Source]** Cesium `FrameState` 是传给各 update 函数的逐帧状态，持有 context、command list、frame number 与当前 JulianDate，见 `D:\my\explore\cesium\packages\engine\Source\Scene\FrameState.js:3-29`、`:90-112`；还显式标识 render/pick/depth 等 pass，见 `FrameState.js:190-226`。`afterRender` 回调若返回 true，在 request-render 模式会请求下一帧，见 `FrameState.js:235-256`。

**采用结论**：

- **[Proposed] 扩展现有 `CesiumGroundFrameState`**：可选 `timeSeconds`、`deltaSeconds`、`frameNumber` 映射为 `c23_time`、`c23_deltaTime`、`c23_frameNumber`。
- 缺省统一为 `0`，得到可重复的静态画面，不读取全局 `performance.now()`。
- 活动材质在 request-render 宿主中由宿主持续请求帧；库不隐藏调度，也不根据 Shader 源猜测“是否动画”。

## 8. 当前项目事实与差距

### 8.1 已经具备的正确基础

**[Current]** 当前项目已经使用 GLSL3 `RawShaderMaterial` 适配 Cesium Shader，并显式配置 depth/stencil/blend，见 `src/lib/ground/materials.ts:1-25`、`:839-927`。surface 在 `CesiumClassificationPrimitive` 中创建 front stencil、back stencil、color 三个 mesh，共享同一 uniform map，见 `src/lib/ground/classification.ts:476-505`、`:510-598`、`:600-650`。`setColor()` 直接原地修改 uniform，见 `classification.ts:670-678`；`setFragmentCulling()` 只替换 color material 并 dispose 旧材质，见 `classification.ts:785-798`。

**[Current]** textured decal 已经在透明片元输出 `vec4(0.0)` 后返回，以便 stencil 清理继续由 color pass 状态完成，见 `src/lib/ground/materials.ts:959-976`。这正是安全 Material 入口必须保留的语义。

**[Current]** polyline 已算出全线 `s` 与横向 `t`，并用 `s * u_lineTotalMeters` 实现硬编码虚线，见 `src/lib/ground/materials.ts:1317-1322`、`:1383-1403`；polyline 与 arrow 当前共享 uniform 表但拥有独立 geometry/material，见 `src/lib/ground/primitives.ts:901-917`、`:953-1018`。

### 8.2 必须改造的扩展点

**[Current]** `createColorFragmentBody()`、textured decal 等仍依赖 `.replace()` 找字符串锚点，并在锚点缺失时抛错，见 `src/lib/ground/materials.ts:651-759`、`:941-985`。这对上游 Shader 文本变化敏感，且无法自然容纳同一 Material ABI 的 surface/polyline/decal/arrow。

**[Current]** `ClassificationColorInjection` 是内部工厂注入，直接暴露 `SharedUniforms`，见 `src/lib/ground/classification.ts:463-473`；所有 `czm_*`、shape、text/decal 与 line/arrow 键集中在一个大接口，见 `src/lib/ground/types.ts:468-551`。它适合内部迁移，但不是可长期承诺的用户 ABI。

**[Current]** `CesiumGroundFrameState` 只有深度、视口、相机、pixelRatio 和分类深度纹理，没有时间字段，见 `src/lib/ground/types.ts:404-428`。

**[Proposed]** 因此改造不是“再加几个 uniform”，而是：

1. 用显式 Shader 组装器替换字符串锚点替换；
2. 把系统 uniform 与 user uniform 分域合并；
3. 把纯色、纹理、虚线也改写为内置 `CesiumGroundMaterial`；
4. 在逻辑 Material 与每图元/pass 的 `RawShaderMaterial` 之间增加 Compiled Material 层；
5. 公开安全 Appearance 与 Raw Appearance 两条同级入口。

## 9. 总体采用 / 不采用矩阵

| 参考机制 | 决策 | 本项目落点 | 原因 |
| --- | --- | --- | --- |
| Three `{ value }` uniforms | 采用 | `CesiumGroundMaterial.uniforms` | 值更新稳定、低开销、无需重编译 |
| Three `needsUpdate/version` | 采用并收紧 | Material 与 Raw Appearance | 源/defines/schema 显式失效；值不失效 |
| Three `ShaderMaterial` 隐式前缀 | 不采用 | 显式 Ground Shader 组装器 | ABI 可审计，不受隐式注入变化影响 |
| Three `RawShaderMaterial` | 采用 | Compiled Material / Raw Appearance 返回值 | 保留 WebGLRenderer program/uniform/state 管理 |
| Three `onBeforeCompile` | 不作为公共核心 | 无 | 字符串修改与 cache key 容易失配，多 pass 更危险 |
| Three `UniformsUtils.clone` | 严格采用 | `CesiumGroundMaterial.clone()` | clone 包括普通 Texture；调用方负责克隆资源的释放 |
| Three Clock | 兼容示例 | 宿主 | r183 已弃用；库不持有时钟 |
| Three Timer | 推荐示例 | 宿主 | 一帧一次 update，重复读取稳定，可处理页面隐藏 |
| Cesium Primitive/Appearance/Material 分层 | 采用 | Ground Primitive / 两种 Appearance / Material | 与当前分类管线职责天然一致 |
| Cesium `czm_getMaterial` 稳定函数 | 采用并命名空间化 | `c23_getMaterial` | Shader 作者只实现表面着色 |
| Cesium Fabric JSON 与 type registry | 不采用 | 直接 TypeScript + GLSL | 首期不需要 DSL、sub-material、token 重命名 |
| Cesium MaterialProperty | 不采用 | 宿主更新 uniform | 避免引入 timeline/Property 调度框架 |
| Cesium CustomShader 固定 hook 与校验 | 部分采用 | Material ABI、Raw factory 校验 | 保留显式契约，不引入 Model PBR 与 texture manager |
| Cesium Ground surface 受控分类 pass | 采用 | 安全 Appearance 仅注入 color | 防止破坏 stencil、深度与清理 |
| Cesium FrameState 外部时间 | 采用并简化 | seconds/delta/frameNumber | 不依赖 JulianDate 或 Scene 调度 |

## 10. 关键决策

1. `CesiumGroundMaterialAppearance` 与 `CesiumGroundRawShaderAppearance` 是同级公开类型，通过 `CesiumGroundAppearance` union 进入所有 Ground 图元。
2. `GroundPrimitiveKind` 固定为 `surface | polyline | decal | arrow`；`GroundRenderPass` 固定为 `frontStencil | backStencil | color | polyline | arrow`。
3. 安全 Material 只实现 `c23_getMaterial`，库负责组装、裁切、straight RGB 合成、预乘、log depth、stencil 清理和固定状态。
4. Raw factory 接收 primitive kind、pass、系统 uniforms、用户 uniforms 与 `createDefaultMaterial()`；每次调用必须返回独立 `RawShaderMaterial`。
5. animation 的定义只有“稳定 Shader + 动态 uniform”。无 timeline、tween、内部 RAF 或动画序列化。
6. 当前项目继续以 Three 0.183.x、`WebGLRenderer`、GLSL3 为首期基线；不接入 TSL/NodeMaterial。

## 11. 边界条件与失败模式

- **Shader 源改了但未 `needsUpdate`**：旧 program 继续使用；开发模式应检测 version 对应的结构快照不一致并提示。
- **Raw 只改 color 顶点位置**：stencil 与 color footprint 不一致，出现漏色或残留 stencil；库不能自动修复。
- **安全 surface Material 使用 `discard`**：用户函数本身不拥有最终 main，因此 ABI 不提供 discard hook；由框架把 alpha 0 变成透明输出并完成清理。
- **user uniform 使用 `c23_` / `czm_`**：构造或 schema 重编译时抛错，不能以“用户覆盖系统值”方式放行。
- **共享 Material 后修改 phase**：所有绑定图元同步变化是预期语义；独立相位必须 `clone()`。
- **缺少时间**：三个时间 uniform 都为 0；画面静止，不回退到 wall clock。
- **Texture 被用户提前 dispose**：库不接管 Texture 所有权，因此视为调用方 use-after-free；`clone()` 产生的普通 Texture 副本同样由调用方负责，Compiled Material 不复制或复活 Texture。
- **request-render 模式不持续请求帧**：`c23_time` 不推进，动画停住；这是宿主调度问题，不由材质内部 RAF 修复。

## 12. 示例：同一效果的安全入口与 Raw 入口

### 12.1 安全 Material

**[伪代码]**

```ts
const material = new CesiumGroundMaterial({
  uniforms: {
    u_speed: { value: 0.4 },
    u_color: { value: new THREE.Color('#00d8ff') },
  },
  fragmentShader: /* glsl */ `
    uniform float u_speed;
    uniform vec3 u_color;

    c23_material c23_getMaterial(c23_materialInput input) {
      float phase = fract(input.distanceAlongMeters * 0.02 - c23_time * u_speed);

      c23_material material;
      material.diffuse = u_color;
      material.emission = vec3(0.0);
      material.alpha = input.baseColor.a * (1.0 - smoothstep(0.0, 1.0, phase));
      return material;
    }
  `,
});

const appearance = new CesiumGroundMaterialAppearance({ material });
const line = new CesiumGroundPolylinePrimitive({ ...options, appearance });
```

Material 不知道 line 的 geometry、深度纹理或 render loop；框架为 polyline 组装正确输入和最终输出。

### 12.2 完整 Raw Appearance

**[伪代码]**

```ts
const appearance = new CesiumGroundRawShaderAppearance({
  uniforms: {
    u_bend: { value: 0.0 },
  },
  factory({ primitiveKind, pass, systemUniforms, userUniforms, createDefaultMaterial }) {
    const raw = createDefaultMaterial();

    // 在默认 pass 契约上修改；若影响 surface classification，三个 pass 都会进入这里。
    if (primitiveKind === 'surface') {
      raw.vertexShader = injectSameVertexTransform(raw.vertexShader, pass, userUniforms);
    }
    return raw;
  },
});
```

Raw factory 返回值由图元拥有并 dispose；factory 不得缓存并重复返回同一个 `RawShaderMaterial`。

## 13. 验收清单

- [ ] 文档中的 Three/Cesium 路径、提交、版本与关键行号可在本地固定源码树复核。
- [ ] 明确区分 `ShaderMaterial` 与 `RawShaderMaterial`，没有把 Raw 描述成绕开 Three program cache。
- [ ] 明确 uniform value 更新不编译，Shader/defines/schema 更新必须递增 version。
- [ ] 说明 `onBeforeCompile` 与 `customProgramCacheKey()` 的关系，并明确不把字符串注入作为公共核心 ABI。
- [ ] 说明严格采用 `UniformsUtils.clone`：普通 Texture 被 clone、RenderTargetTexture 告警并置 `null`，且调用方负责克隆 Texture 的生命周期。
- [ ] 说明 r183 起 `Clock` 已弃用，同时保留用户要求的 Clock 示例并给出 Timer 推荐写法。
- [ ] 覆盖 Cesium Appearance、Material/Fabric、MaterialProperty、CustomShader、GroundPrimitive、ClassificationPrimitive、GroundPolylinePrimitive、FrameState。
- [ ] 清楚说明安全 Material 只进入 surface color pass，Raw Appearance 才可接管所有 pass。
- [ ] 明确不设计 timeline、tween、内部 RAF、Fabric DSL、TSL/NodeMaterial。
- [ ] 示例标记为伪代码，完整接口以 04/05 为准。

---

上一篇：[README：文档索引](./README.md) · 下一篇：[02 当前渲染管线](./02-current-rendering-pipeline.md)
