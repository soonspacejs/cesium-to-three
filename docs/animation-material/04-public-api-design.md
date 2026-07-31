# 04 · 公共 API 设计

> 状态：**Proposed API**。本篇中的类型尚未存在于当前 `0.1.9` 包。  
> 源码基线：当前项目 `32a6b244b7c0cb731ca35165c46e8fe31248c718`；Three `2a005fdbad6b8503a8a70edfdd279b79c5e04b49`；Cesium `effe290c08dc340a7a6bd4435367a7d092c6b2b9`。  
> 前置阅读：[03 · 目标架构](./03-target-architecture.md)  
> API 事实源：本篇；Shader 字段语义以 [05 · Shader ABI](./05-shader-abi.md) 为准；资源语义以 [08 · 生命周期、缓存与资源](./08-lifecycle-cache-resources.md) 为准。

## 目标

给出可以直接转换为 TypeScript 实现和 `.d.ts` 的完整公开契约，锁定：

- `CesiumGroundMaterial` 的构造、动态 uniform、编译版本、clone 和 dispose；
- `CesiumGroundMaterialAppearance` 与 `CesiumGroundRawShaderAppearance` 两套同级入口；
- Raw 工厂按 primitive kind / pass 构建独立 `RawShaderMaterial` 的上下文；
- 所有 Ground 图元的 `appearance?`、折线的 `arrowAppearance?` 和运行时切换；
- 时间字段、保留标识符、错误规则和向后兼容行为；
- 默认材质及三个效果预设的公开工厂签名；
- 根入口与 `cesium-to-three/ground` 的导出要求。

## 非目标

- 本篇不定义 GLSL 坐标和公式；见 [05](./05-shader-abi.md)。
- 本篇不规定内部文件必须如何拆分；见 [09](./09-implementation-roadmap.md)。
- 不提供 timeline、tween、clip、track、mixer、RAF 或序列化 API。
- 不把 `PlotPrimitiveBridge`、`GroundDecalManager` 或 plot options 变为首期公开 API。
- 不提供通用 Three `Object3D` 动画绑定。

## 设计过程

本篇先从当前六类 Ground 构造选项、FrameState 和导出路径确定兼容面，再把 [03](./03-target-architecture.md) 的四层职责压缩为可声明的 TypeScript 类型；随后用 [05](./05-shader-abi.md) 的 kind/pass 矩阵约束安全入口与 Raw 工厂，并以 [08](./08-lifecycle-cache-resources.md) 的 ownership、clone、version 和 dispose 语义校正方法签名。最后把旧 setter、默认材质和根/子路径导出逐项映射到 Proposed API，保证接口可以直接进入分阶段实现和类型验收。

## 1. Current API 与新增边界

当前构造选项只有几何、样式和分类字段，没有公开 appearance：

- rectangle：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:115-130`
- polygon：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:138-163`
- circle：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:181-200`
- point/image：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:213-269`
- polyline：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:313-402`
- frame state：`D:\my\code\cesium-to-three\src\lib\ground\types.ts:404-428`

当前内部已有 `ClassificationColorInjection.colorMaterialFactory` 与 `extraUniforms`，但它只供文字/图片内部使用，不是稳定公共 ABI（`classification.ts:463-474`）。Proposed API 不直接公开这个接口，而是在其上建立 Material / Appearance 层。

公开构建已经同时生成根入口和 `ground` 子路径（`vite.lib.config.ts:22-26`），根入口又 `export * from './lib/ground'`（`src/cesium-three-ground.ts:9`）。因此新增符号只需从 `src/lib/ground/index.ts` 导出，就必须同时出现在：

```ts
import { CesiumGroundMaterial } from 'cesium-to-three';
import { CesiumGroundMaterial } from 'cesium-to-three/ground';
```

首期不新增 `package.json` subpath，也不新增单独 `animation` 包。

## 2. 公共类型总览

以下代码块是完整 Proposed 声明骨架。实现可以拆文件，但导出的名称、字段、只读性和方法语义不得改变。

```ts
import { EventDispatcher } from 'three';
import type {
  ColorRepresentation,
  IUniform,
  RawShaderMaterial,
  Texture,
  Vector4,
} from 'three';

export const C23_GROUND_SHADER_ABI_VERSION = 1 as const;

export type GroundDefineValue = string | number | boolean;
export type GroundDefines = Record<string, GroundDefineValue>;
export type GroundUserUniforms = Record<string, IUniform>;
export type GroundSystemUniforms = Readonly<Record<string, IUniform>>;

export type GroundPrimitiveKind =
  | 'surface'
  | 'polyline'
  | 'decal'
  | 'arrow';

export type GroundRenderPass =
  | 'frontStencil'
  | 'backStencil'
  | 'color'
  | 'polyline'
  | 'arrow';

export type CesiumGroundAppearance =
  | CesiumGroundMaterialAppearance
  | CesiumGroundRawShaderAppearance;
```

### 2.1 kind / pass 合法组合

| `primitiveKind` | 必需 pass | 说明 |
| --- | --- | --- |
| `surface` | `frontStencil`、`backStencil`、`color` | rectangle、polygon、circle、circle/square point delegate |
| `decal` | `frontStencil`、`backStencil`、`color` | text、image；区别在 color pass 的稳定输入和默认 Material |
| `polyline` | `polyline` | 折线线体的单 pass 深度重建管线 |
| `arrow` | `arrow` | 折线起/终端箭头的附加 pass |

工厂绝不能收到其它组合。开发构建遇到非法组合必须抛错；生产构建也不得静默调用一个近似 pass。

## 3. `CesiumGroundMaterial`

### 3.1 构造与类声明

```ts
export interface CesiumGroundMaterialOptions {
  /** 调试与日志类型名；不单独作为 program cache key。默认 'CesiumGroundMaterial'。 */
  type?: string;

  /** 用户 uniform schema。key 不得使用保留前缀。默认空对象。 */
  uniforms?: GroundUserUniforms;

  /** 编译期 defines。false 表示不生成该 define。默认空对象。 */
  defines?: GroundDefines;

  /**
   * GLSL3 源码，可以包含用户 uniform 与 helper，但必须提供且只能以此作为材质入口：
   * c23_material c23_getMaterial(c23_materialInput input)
   * 不得声明 main()。
   */
  fragmentShader: string;
}

export interface CesiumGroundMaterialEventMap {
  change: { type: 'change' };
  dispose: { type: 'dispose' };
}

export class CesiumGroundMaterial extends EventDispatcher<CesiumGroundMaterialEventMap> {
  readonly uuid: string;
  type: string;
  uniforms: GroundUserUniforms;
  defines: GroundDefines;
  fragmentShader: string;
  readonly version: number;

  constructor(options: CesiumGroundMaterialOptions);

  /**
   * 只更新已经存在的 uniform wrapper.value。
   * 不替换 wrapper，不改变 schema，不增加 version。
   */
  setUniform<T>(name: string, value: T): this;

  /** 产生新 uuid、新 uniform wrappers、version=0 的逻辑 Material。 */
  clone(): CesiumGroundMaterial;

  /**
   * true：version += 1 并触发 change；false：无操作。
   * 与 Three Material.needsUpdate 语义一致。
   */
  set needsUpdate(value: boolean);

  /**
   * 发出 dispose 通知，使所有消费者释放自己的 compiled materials。
   * 不销毁 uniform 中的 Texture，Material 之后仍可再次触发编译。
   */
  dispose(): void;
}
```

### 3.2 编译期与运行期变化

| 操作 | 允许 | `version` | 重编译 |
| --- | --- | ---: | --- |
| `setUniform('u_speed', 2)` | 仅既有 key | 不变 | 否 |
| `material.uniforms.u_speed.value = 2` | 仅既有 key | 不变 | 否 |
| 替换既有 wrapper | 只允许配置阶段 | 手动 `needsUpdate=true` | 是 |
| 新增/删除 uniform key | 只允许配置阶段 | 手动 `needsUpdate=true` | 是 |
| 修改 `fragmentShader` | 允许 | 手动 `needsUpdate=true` | 是 |
| 修改 `defines` 的 key/value | 允许 | 手动 `needsUpdate=true` | 是 |
| 修改 `type` | 允许用于调试 | 不变 | 否 |
| 每帧设置 `needsUpdate=true` | 禁止用法 | 每帧增加 | 每帧，错误 |

`setUniform()` 对未知 key 必须抛 `GROUND_UNIFORM_NOT_DECLARED`。它不能偷偷新增 schema，因为这种行为会让用户误以为没有重编译。

首期 schema 只描述 uniform key 集合，GLSL 类型来自 safe source 声明；API 不新增 JavaScript value-type metadata。因而 `setUniform<T>()` 与直接写 `.value` 都不推断 number/Vector/Texture 是否匹配 GLSL，wrapper identity、version 与 compile key 保持不变，类型正确性由调用方与 Three uniform uploader 负责。开发编译可以诊断“GLSL 声明缺 wrapper/多余 wrapper”，但不能承诺拦截每次直接 `.value` 赋值。

新增 schema 的唯一明确流程：

```ts
material.uniforms.u_mask = { value: maskTexture };
material.needsUpdate = true;
```

删除、替换 wrapper 或修改 defines/source 后也必须显式设置 `needsUpdate = true`。一次批量编辑结束后只设置一次。

### 3.3 define 规则

- define 名称必须是合法 GLSL identifier；
- `true` 生成 `#define NAME 1`；
- `false` 不生成该 define，但 canonical cache serializer 仍把其状态记录为 off；
- number 必须为有限值；
- string 只允许单行 GLSL 预处理 token/表达式；含 CR/LF、`#`、`//`、`/*` 或 `*/` 必须拒绝，不能借 value 注入第二条预处理指令；
- 排序后的 key/value 参与 program key，插入顺序不参与；
- 用户不得声明 `C23_*`；这些宏由 assembler 独占。

### 3.4 `clone()` 精确语义

`clone()` 使用 Three `UniformsUtils.clone()` 的值规则，而不是只复制最外层 map：

- 每个 `{ value }` wrapper 都是新对象；
- Color、Vector、Matrix、Quaternion、Texture 等 Three 对象调用 `.clone()`；
- Three 对象数组逐项 `.clone()`；普通数组使用 `.slice()`；
- 其它值按引用/原始值复制；
- RenderTarget texture 按 Three 行为不能直接 clone，结果为 `null` 并给出警告；
- `uuid` 重新生成，`version` 回到 `0`；
- `type`、`fragmentShader` 与 define 值复制到新对象；
- clone 不复制 change/dispose 监听器。

图元和逻辑 Material 都不会 dispose clone 产生的 Texture wrapper；调用方拥有它。若希望 clone 后仍共享同一 Texture，必须显式覆盖：

```ts
const independentPhase = sharedMaterial.clone();

// UniformsUtils.clone() 已创建普通 Texture 副本；改回共享前先由调用方释放副本。
const clonedTexture = independentPhase.uniforms.u_texture.value as Texture | null;
clonedTexture?.dispose();
independentPhase.setUniform(
  'u_texture',
  sharedMaterial.uniforms.u_texture.value,
);
independentPhase.setUniform('u_phase', 0.5);
```

## 4. 安全入口：`CesiumGroundMaterialAppearance`

```ts
export interface CesiumGroundMaterialAppearanceOptions {
  material: CesiumGroundMaterial;
}

export class CesiumGroundMaterialAppearance {
  readonly kind: 'material';
  readonly material: CesiumGroundMaterial;

  /** 始终返回 material.version。 */
  get version(): number;

  constructor(options: CesiumGroundMaterialAppearanceOptions);
}
```

安全 Appearance 不暴露 vertex shader 和 Ground render state。它的能力是：

1. 验证 user uniforms/defines/function 名称；
2. 用 [05](./05-shader-abi.md) 的系统前缀编译 `fragmentShader`；
3. 只在适用的 color/polyline/arrow pass 调用 `c23_getMaterial`；
4. 把用户返回的 straight alpha 统一预乘；
5. 保持 shape/depth/stencil/log-depth 清理逻辑；
6. 由 `material.version` 决定是否重建 compiled material。

同一个安全 Appearance 可以用于不同 primitive kind；assembler 会分别以 `C23_SURFACE`、`C23_POLYLINE`、`C23_DECAL` 或 `C23_ARROW` 编译。用户 Shader 应用 `#ifdef` 分支处理能力差异。不适用输入为稳定零值，不允许读取未初始化值。

首期不增加 `supportedKinds` 元数据：自定义和内置 safe Material 都不会仅因 primitive kind 被拒绝。内置 preset 文档所写“适用”是推荐/验收范围；跨 kind 使用按零值 ABI 得到确定结果，但视觉意义由用户判断。`GROUND_APPEARANCE_INCOMPATIBLE` 仅用于运行时传入无效 Appearance 实现、slot 或 pass 结构，不用于 preset kind 限制。

## 5. Raw 入口：`CesiumGroundRawShaderAppearance`

### 5.1 工厂上下文

```ts
export interface GroundRawShaderBuildContext {
  primitiveKind: GroundPrimitiveKind;
  pass: GroundRenderPass;

  /**
   * 只读 map，wrapper.value 由库逐帧原地刷新。
   * 用户不得替换 wrapper 或写 value。
   */
  systemUniforms: GroundSystemUniforms;

  /** Raw Appearance 构造时传入的原始 wrapper 引用。 */
  userUniforms: GroundUserUniforms;

  /**
   * 每次 factory 调用最多调用一次；调用时新建当前 pass 的默认 RawShaderMaterial。
   * 已包含正确 shader、uniform 引用和 render state。
   */
  createDefaultMaterial(): RawShaderMaterial;
}

export type GroundMaterialFactory = (
  context: GroundRawShaderBuildContext,
) => RawShaderMaterial;
```

上下文刻意不暴露 primitive 私有对象、geometry 可写引用或 renderer。需要额外 attribute 的完整替换必须基于当前 pass 已有 attribute ABI；首期不支持让工厂动态修改 geometry layout。

### 5.2 Appearance 声明

```ts
export interface CesiumGroundRawShaderAppearanceOptions {
  /** 用户 uniform schema；不得与 systemUniforms 冲突。默认空对象。 */
  uniforms?: GroundUserUniforms;

  /** 每个必需 pass 调用一次，必须返回独立 RawShaderMaterial。 */
  factory: GroundMaterialFactory;
}

export interface CesiumGroundRawShaderAppearanceEventMap {
  change: { type: 'change' };
  dispose: { type: 'dispose' };
}

export class CesiumGroundRawShaderAppearance extends EventDispatcher<CesiumGroundRawShaderAppearanceEventMap> {
  readonly kind: 'raw';
  readonly uniforms: GroundUserUniforms;
  readonly factory: GroundMaterialFactory;
  readonly version: number;

  constructor(options: CesiumGroundRawShaderAppearanceOptions);

  /** true 使 version += 1 并重新调用所有相关 pass 的 factory；false 无操作。 */
  set needsUpdate(value: boolean);

  /** 发出 dispose；不销毁 user uniforms 中的 Texture。 */
  dispose(): void;
}
```

Raw Appearance 的 uniform `.value` 更新与安全 Material 一样不增加 version。需要更换 factory 时创建新 Appearance，再调用 primitive `setAppearance()`；`factory` 保持 readonly，避免闭包替换无法进入 cache key。

### 5.3 Factory 返回值规则

每次工厂调用必须满足：

- 返回 `RawShaderMaterial`，不能返回普通 `Material`、数组、`null` 或 Promise；
- 不得把同一个实例返回给两个 pass 或两个 factory 调用；
- 返回材质由图元拥有，切换、重建或 dispose 图元时由图元调用 `.dispose()`；
- 若调用 `createDefaultMaterial()`，本次 factory 必须返回该实例（允许原地修改）；每次 factory 最多调用一次。零次调用表示完全替换。第二次调用或创建后返回另一实例都抛 `GROUND_RAW_FACTORY_RESULT_INVALID`，库同时释放未接管的候选默认材质；
- 完整替换可省略未使用的 context uniform；但返回材质中凡与 `userUniforms` / `systemUniforms` 同名的 entry，必须保持原 wrapper 引用，不能只复制 `.value`；
- factory 可以改变默认 Shader/render state，也可以从空白 `RawShaderMaterial` 完整替换；
- 完整替换时，用户承担 [05](./05-shader-abi.md) 的 pass attribute、RTE、depth、stencil、预乘和清理协议；
- vertex 位置变化影响 classification footprint 时，front/back/color 三个 pass 必须一致；
- 开发构建检查 pass 缺失、实例复用、默认材质调用/返回规则、uniform 冲突与同名 wrapper 身份；不要求完整替换挂载未使用 uniform，也不分析 GLSL 等价性。

## 6. 保留标识符与 uniform 合并

### 6.1 保留范围

安全 `CesiumGroundMaterial` 的 user uniforms、defines、GLSL 顶层函数、struct 和全局变量禁止使用：

- `czm_`：Cesium 移植自动量和 builtin；
- `c23_`：本项目 Shader ABI、系统 uniforms、assembler helper；
- `C23_`：本项目编译宏。

唯一例外是用户必须提供且只能提供一次、签名精确为 `c23_material c23_getMaterial(c23_materialInput input)` 的入口函数；其他 `c23_*` 顶层声明仍全部禁止。

检查大小写敏感：`c23_time`、`c23_custom`、`C23_SURFACE` 都保留；`c23Foo` 与 `u_c23_color` 不以锁定前缀开头，但仍不建议。内置用户材质统一使用 `u_*`。

Raw Appearance 的 **user uniform schema** 同样禁止 `czm_` / `c23_`，也不得覆盖 Three 自动 uniform（例如 `modelViewMatrix`）。但 Raw factory 返回的完整 Shader source / material defines 不做 safe 顶层标识符扫描：Raw 源码本来就需要声明并读取 context 提供的 `czm_*` / `c23_*` 系统量。库只校验 pass 返回值、map 冲突和同名 wrapper 身份，不改写 Raw Shader。

目标 `systemUniforms` 的公开键全部使用 `czm_*` 或 `c23_*`；Current `SharedUniforms` 中的非保留 `u_*` 系统键只存在于 deprecated 兼容表，compiler 通过引用别名映射为 `c23_*` 后再与 user map 合并。因此内置材质可安全使用 `u_color` 等普通 user 名。完整保留表与 legacy→canonical 映射由 assembler 集中维护并纳入测试。

### 6.2 合并顺序

逻辑上使用：

```ts
compiledUniforms = merge(systemUniforms, userUniforms);
```

实际实现必须：

1. 先验证所有 user key；
2. 发现冲突立即抛错，不使用“后者覆盖前者”；
3. 合并时复用 wrapper 引用，不 clone `.value`；
4. map 本身可新建，但每次编译之外不得重建；
5. `createDefaultMaterial()` 和安全 assembler 得到相同引用语义。

## 7. 错误契约

```ts
export type CesiumGroundMaterialErrorCode =
  | 'GROUND_RESERVED_IDENTIFIER'
  | 'GROUND_UNIFORM_NOT_DECLARED'
  | 'GROUND_UNIFORM_CONFLICT'
  | 'GROUND_INVALID_DEFINE'
  | 'GROUND_MATERIAL_FUNCTION_MISSING'
  | 'GROUND_MATERIAL_FUNCTION_INVALID'
  | 'GROUND_MATERIAL_MAIN_FORBIDDEN'
  | 'GROUND_MATERIAL_SOURCE_FORBIDDEN'
  | 'GROUND_APPEARANCE_INCOMPATIBLE'
  | 'GROUND_RAW_FACTORY_RESULT_INVALID'
  | 'GROUND_RAW_MATERIAL_REUSED'
  | 'GROUND_RAW_REQUIRED_PASS_MISSING';

export class CesiumGroundMaterialError extends Error {
  readonly code: CesiumGroundMaterialErrorCode;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(
    code: CesiumGroundMaterialErrorCode,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  );
}
```

规则：

- 构造 Material/Appearance 时执行结构和保留名校验；
- 编译到某 primitive kind 时执行函数、define 和 pass 兼容校验；
- `GROUND_MATERIAL_FUNCTION_MISSING` 表示没有入口；重复入口或签名错误使用 `GROUND_MATERIAL_FUNCTION_INVALID`；除 `main` 外的 `#version`、precision/output/varying/layout、ABI 重声明、`gl_FragDepth`、`discard` 与条件分支 allowlist 之外的预处理指令（含 `#include/#extension/#line/#pragma/#define/#undef`）使用 `GROUND_MATERIAL_SOURCE_FORBIDDEN`，并在 `detail.token/reason` 中定位；
- Shader 编译/链接错误保留 Three/WebGL 原始日志，并附 material type、kind、pass、ABI version；
- 生产构建不能吞掉错误并回退默认材质，因为这会隐藏安全/Raw 行为差异；
- `setAppearance()` 对同步结构校验、assembler 和 factory 失败采用事务语义并保留旧 compiled materials；WebGL 的真正编译/链接通常延迟到 renderer draw/compile，首期不承诺自动回滚这类晚发 GPU 错误。宿主或测试可在接受切换前用 renderer 的预编译流程验证候选场景，但这不是公共 setter 的异步契约。

## 8. 图元 options 扩展

### 8.1 公共辅助接口

```ts
export interface CesiumGroundAppearanceOptions {
  /** 缺省时由现有 style 字段构建内部默认 Appearance。 */
  appearance?: CesiumGroundAppearance;
}
```

### 8.2 各构造选项

实际声明按现有 interface/type 形状修改：

```ts
export interface CesiumGroundRectanglePrimitiveOptions
  extends CesiumGroundRectangleOptions, CesiumGroundAppearanceOptions {
  // Current fields unchanged
}

export interface CesiumGroundPolygonOptions
  extends CesiumGroundAppearanceOptions {
  // Current fields unchanged
}

export interface CesiumGroundCirclePrimitiveOptions
  extends CesiumGroundCircleOptions, CesiumGroundAppearanceOptions {
  // Current fields unchanged
}

export type CesiumGroundImagePrimitiveOptions =
  CesiumGroundPointCommonOptions &
  CesiumGroundAppearanceOptions & {
    // Current image fields unchanged
  };

export type CesiumGroundPointPrimitiveOptions =
  CesiumGroundPointOptions &
  CesiumGroundAppearanceOptions & {
    // Current primitive fields unchanged
  };

export interface CesiumGroundPolylineOptions
  extends CesiumGroundAppearanceOptions {
  // Current fields unchanged

  /** 仅控制箭头 pass；缺省时由现有 arrowColor/style 字段生成默认 Appearance。 */
  arrowAppearance?: CesiumGroundAppearance;
}
```

`CesiumGroundTextPrimitive` 当前构造参数是 `PlotTextOptions`（`src/lib/ground/text/text-primitive.ts:41,61`）。首期在公开 text 类型中增加同名 `appearance?`，但不因此发布整个 `src/lib/plot`：

```ts
export type CesiumGroundTextPrimitiveOptions =
  PlotTextOptions & CesiumGroundAppearanceOptions;
```

构造器和公开导出改用 `CesiumGroundTextPrimitiveOptions`；历史 `PlotTextOptions` 继续作为兼容别名导出一个大版本周期。

### 8.3 point delegate 必须透传

`CesiumGroundPointPrimitive` 当前根据 `shape` 委托 circle、rectangle 或 image（`types.ts:202-236`，`primitives.ts:722-873`）。Proposed 行为：

| point shape | delegate | `appearance` 对应 kind |
| --- | --- | --- |
| `circle` | `CesiumGroundCirclePrimitive` | `surface` |
| `square` | `CesiumGroundRectanglePrimitive` | `surface` |
| `image` | `CesiumGroundImagePrimitive` | `decal` |

point 不 clone、不包装用户 Appearance；构造、`setAppearance()`、重建和 getter 都保持同一对象引用。getter 返回 delegate 当前 active appearance。

## 9. 图元实例 API

所有 Ground 图元实现：

```ts
export interface CesiumGroundAppearanceOwner {
  /** 当前逻辑 Appearance；包括内部生成的默认 Appearance。 */
  readonly appearance: CesiumGroundAppearance;

  /**
   * 传实例：事务式重编译相关 pass 后切换。
   * 传 undefined：恢复由当前 legacy style 字段生成的默认 Appearance。
   */
  setAppearance(appearance?: CesiumGroundAppearance): void;
}
```

`CesiumGroundPolylinePrimitive` 另外实现：

```ts
readonly arrowAppearance: CesiumGroundAppearance;
setArrowAppearance(appearance?: CesiumGroundAppearance): void;
```

### 9.1 运行时切换顺序

`setAppearance(next)` 必须按下列顺序执行：

1. disposed 图元直接抛已有生命周期错误；
2. `next === current` 时 no-op；
3. 解析本图元需要的 kind/pass；
4. 校验 user uniforms 和 ABI；
5. 使用当前 system uniform wrappers 编译一套候选材质；
6. 全部成功后一次性替换 mesh.material；
7. dispose 被替换的 compiled materials；
8. 若旧逻辑 Appearance 是图元内部默认对象，释放该内部默认逻辑对象；
9. 用户传入的逻辑 Appearance、Material 和 Texture一律不 dispose；
10. 不重建 geometry，不改变 renderOrder、layers、visible 或 classificationType。

`setArrowAppearance()` 只重建箭头材质。`setAppearance()` 只重建线体材质，不隐式覆盖箭头 Appearance。

### 9.2 旧 setter 的兼容行为

现有 `setColor()`、`setWidth()`、`setImageOpacity()`、`setFragmentCulling()`、文字 `setText()` 等继续有效：

- style setter 更新 shape、`baseColor` 或内置 pipeline uniforms；
- 自定义 Material 可以读取新的 `input.baseColor`，也可以选择忽略；
- setter 不覆盖 user uniforms，不把自定义 Appearance 换回默认；
- 默认 Appearance 下，视觉输出与当前版本一致；
- `setFragmentCulling()` 只重建 surface/decal color compiled material；
- `setText()` 在固定 rectangle/shadow-volume 拓扑内原位更新既有 attribute 数组、extents/system uniform value 与同一 `CanvasTexture`，不得替换 `BufferGeometry`、group、Appearance 或 user uniform wrapper；文字内容本身不触发 Shader 重编译，只有同时发生的 Material/Appearance/fragment-culling 编译状态变化才替换相关 color compiled material；
- 首期若某种新文字布局无法容纳在固定拓扑/已声明容量内，`setText()` 必须在提交前抛错，并要求调用方显式创建新图元，不能静默重建 geometry；
- image 的纹理/opacity 热更新同样保持 geometry 与 Appearance；未来显式改变 image footprint 的 API 属于单独的 Geometry 变更，不借 `setAppearance()` 实现；
- geometry 未变化时绝不能因 uniform 更新触发 rebuild。

### 9.3 ownership

| 对象 | 所有者 | 图元 dispose/切换时 |
| --- | --- | --- |
| 用户传入 `CesiumGroundMaterial` | 用户 | 不 dispose |
| 用户传入 Appearance | 用户 | 不 dispose |
| 图元生成的默认逻辑 Material/Appearance | 图元 | 可以 dispose |
| compiled `RawShaderMaterial` | 图元 | 必须 dispose |
| 用户 uniform 中 Texture | 用户 | 不 dispose |
| 系统 packed depth Texture | depth manager | 不 dispose |

## 10. `CesiumGroundFrameState` 时间扩展

```ts
export interface CesiumGroundFrameState {
  // Current fields unchanged:
  depthTexture: WebGLRenderTarget['texture'];
  width: number;
  height: number;
  camera: PerspectiveCamera;
  pixelRatio?: number;
  classificationDepthTextures?: ClassificationDepthTextureSet;

  /** 宿主时间轴累计秒；有限数，否则按 0。 */
  timeSeconds?: number;

  /** 当前逻辑帧步长秒；有限且 >=0，否则按 0。 */
  deltaSeconds?: number;

  /** 宿主逻辑帧编号；有限且 >=0 时 floor，否则按 0。 */
  frameNumber?: number;
}
```

映射：

| frame state | GLSL | 缺省 | 备注 |
| --- | --- | ---: | --- |
| `timeSeconds` | `c23_time` | `0.0` | 可暂停时保持不变；Material 不自行累计 |
| `deltaSeconds` | `c23_deltaTime` | `0.0` | 只供需要帧步信息的自定义 Shader；内置周期效果不用它 |
| `frameNumber` | `c23_frameNumber` | `0.0` | WebGL uniform 为 float；CPU 先规范化整数 |

三者进入 system uniform map，不能由用户 schema提供。

### 10.1 `THREE.Clock` 宿主示例

Three r183 已把 `Clock` 标记为 deprecated，但本项目当前依赖仍包含它，并且需求指定使用它。正确接线必须保证每逻辑帧只调用一次 `getDelta()`：

```ts
const clock = new THREE.Clock();
let frameNumber = 0;

function renderFrame() {
  const deltaSeconds = clock.getDelta();
  const timeSeconds = clock.elapsedTime; // getDelta() 已经推进

  const frameState: CesiumGroundFrameState = {
    depthTexture: globeDepth.depthTexture,
    width: renderer.domElement.width,
    height: renderer.domElement.height,
    pixelRatio: renderer.getPixelRatio(),
    camera,
    timeSeconds,
    deltaSeconds,
    frameNumber: frameNumber++,
  };

  primitive.update(frameState);
  renderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
}
```

不要在同一帧先 `getElapsedTime()` 再 `getDelta()`；两者都可能推进 Clock。r183+ 宿主可以改用 `THREE.Timer`，只要最终传入同一单位和语义，Ground API 不感知时间源。

## 11. 内置 Material 工厂

全部工厂返回 `CesiumGroundMaterial`，不返回 compiled `RawShaderMaterial`，不创建 RAF。

### 11.1 通用输入类型

```ts
export type GroundColorInput = ColorRepresentation | Vector4;
```

`ColorRepresentation` 产生 RGB 和不透明 alpha；`Vector4` 的 `w` 作为输入 alpha。单独的 `opacity` 与颜色 alpha 相乘。所有 public opacity 均为 `0..1`，不同于旧图元 style 的 `0..100`。

### 11.2 默认等价材质

```ts
export interface ColorGroundMaterialOptions {
  color?: ColorRepresentation; // default white
  opacity?: number;             // default 1
}

export function createColorGroundMaterial(
  options?: ColorGroundMaterialOptions,
): CesiumGroundMaterial;

export interface TexturedDecalMaterialOptions {
  texture: Texture;
  opacity?: number;             // default 1
  tint?: ColorRepresentation;   // default white
  flipY?: boolean;              // default true
}

export function createTexturedDecalMaterial(
  options: TexturedDecalMaterialOptions,
): CesiumGroundMaterial;

export interface PolylineDashMaterialOptions {
  color?: ColorRepresentation;  // default white
  opacity?: number;             // default 1
  dashLengthMeters?: number;    // default 16
  gapLengthMeters?: number;     // default 8
  offsetMeters?: number;        // default 0
}

export function createPolylineDashMaterial(
  options?: PolylineDashMaterialOptions,
): CesiumGroundMaterial;
```

### 11.3 `createFlowLineMaterial`

```ts
export interface FlowLineMaterialOptions {
  color?: ColorRepresentation;       // default #00ffff
  opacity?: number;                  // default 1
  backgroundColor?: GroundColorInput;// default transparent Vector4(0,0,0,0)
  speed?: number;                    // cycles/second, default 1
  repeat?: number;                   // default 1, >0
  trailFraction?: number;            // default 0.35, (0,1]
  direction?: number;                // >=0 -> +1, <0 -> -1; default +1
}

export function createFlowLineMaterial(
  options?: FlowLineMaterialOptions,
): CesiumGroundMaterial;
```

### 11.4 `createPulsePointMaterial`

```ts
export interface PulsePointMaterialOptions {
  color?: ColorRepresentation; // default white
  periodSeconds?: number;       // default 1.5, >0
  minScale?: number;            // default 0.65, >0
  maxScale?: number;            // default 1.0, >=minScale
  minOpacity?: number;          // default 0.25
  maxOpacity?: number;          // default 1.0, >=minOpacity
  phase?: number;               // cycles, default 0
  edgeSoftness?: number;        // normalized footprint, default 0.02
  footprintScale?: number;      // default max(1,maxScale)
}

export function createPulsePointMaterial(
  options?: PulsePointMaterialOptions,
): CesiumGroundMaterial;
```

### 11.5 `createScalePulseMaterial`

```ts
export interface ScalePulseMaterialOptions {
  texture?: Texture;
  tint?: ColorRepresentation;   // default white
  opacity?: number;             // default 1
  periodSeconds?: number;       // default 1.5, >0
  minScale?: number;            // default 0.75, >0
  maxScale?: number;            // default 1.0, >=minScale
  phase?: number;               // cycles, default 0
  edgeSoftness?: number;        // default 0.01
  flipY?: boolean;              // default true
  footprintScale?: number;      // default max(1,maxScale)
}

export function createScalePulseMaterial(
  options?: ScalePulseMaterialOptions,
): CesiumGroundMaterial;
```

`footprintScale` 只是 Shader 的名义尺寸到实际 footprint 的映射。它不会修改 geometry。`maxScale > 1` 时，调用方必须用 `nominalSize * footprintScale` 创建 circle/image/rectangle 的实际 footprint；否则放大阶段会被现有地表覆盖范围裁掉。

工厂的 uniforms、公式和完整 GLSL 见 [07 · 内置效果](./07-built-in-effects.md)。

## 12. 使用示例

### 12.1 安全自定义 Material

```ts
import * as THREE from 'three';
import {
  CesiumGroundCirclePrimitive,
  CesiumGroundMaterial,
  CesiumGroundMaterialAppearance,
} from 'cesium-to-three/ground';

const heat = new CesiumGroundMaterial({
  type: 'HeatPulse',
  uniforms: {
    u_hot: { value: new THREE.Color('#ff3d00') },
    u_cold: { value: new THREE.Color('#330033') },
    u_frequency: { value: 1.5 },
  },
  defines: {
    USE_RADIAL_FALLOFF: true,
  },
  fragmentShader: /* glsl */ `
    uniform vec3 u_hot;
    uniform vec3 u_cold;
    uniform float u_frequency;

    c23_material c23_getMaterial(c23_materialInput input) {
      float wave = 0.5 + 0.5 * sin(
        6.28318530718 * (c23_time * u_frequency - length(input.st - 0.5))
      );

      c23_material material;
      material.diffuse = mix(u_cold, u_hot, wave);
      material.emission = vec3(0.0);
      material.alpha = input.baseColor.a;
      return material;
    }
  `,
});

const pulse = new CesiumGroundCirclePrimitive({
  center: [121.50, 31.24],
  radius: 80,
  strokeColor: '#ffffff',
  strokeWidth: 2,
  strokeOpacity: 100,
  fillColor: '#ffffff',
  fillOpacity: 90,
  visible: true,
  appearance: new CesiumGroundMaterialAppearance({ material: heat }),
});
```

### 12.2 运行时只更新 uniform

```ts
heat.setUniform('u_frequency', 2.25);

// 等价且不触发重编译：
heat.uniforms.u_frequency.value = 2.25;

// Shader/define/schema 改动才显式重编译：
heat.defines.USE_RADIAL_FALLOFF = false;
heat.needsUpdate = true;
```

### 12.3 共享与独立相位

```ts
const shared = createPulsePointMaterial({
  periodSeconds: 1.5,
  minScale: 0.65,
  maxScale: 1.0,
  phase: 0,
});
const sharedAppearance = new CesiumGroundMaterialAppearance({ material: shared });

const pointA = new CesiumGroundPointPrimitive({ ...pointAOptions, appearance: sharedAppearance });
const pointB = new CesiumGroundPointPrimitive({ ...pointBOptions, appearance: sharedAppearance });

// 两个点共享 period、scale、opacity、phase 等全部 wrapper。
shared.setUniform('u_periodSeconds', 2.0);

// 独立相位必须 clone logical Material。
const shifted = shared.clone().setUniform('u_phase', 0.5);
pointB.setAppearance(new CesiumGroundMaterialAppearance({ material: shifted }));
```

### 12.4 修改默认 Raw material

```ts
const raw = new CesiumGroundRawShaderAppearance({
  factory(context) {
    const material = context.createDefaultMaterial();
    material.name = `GroundRaw/${context.primitiveKind}/${context.pass}`;
    material.userData.pipelineOwner = 'application';
    return material;
  },
});

primitive.setAppearance(raw);
```

上例展示 default material 是可原地修改且最终由图元接管的独立实例。若要新增 uniform 或改变着色，Raw 用户必须同时提供声明该 uniform 的完整、pass-compatible Shader；向 `material.uniforms` 只加 JS entry 不会自动生成 GLSL 声明。下一节的 helper 表示应用自有的完整 Shader 构建函数，不依赖默认源码中的字符串锚点。

### 12.5 完整 Raw pass 分支

```ts
const fullRaw = new CesiumGroundRawShaderAppearance({
  factory(context) {
    switch (context.pass) {
      case 'frontStencil':
      case 'backStencil':
        // 若不改变 classification 顶点位置，直接复用安全默认最稳妥。
        return context.createDefaultMaterial();

      case 'color': {
        const material = context.createDefaultMaterial();
        material.fragmentShader = createCompleteSurfaceColorFragmentShader(context);
        return material;
      }

      case 'polyline':
        return createCompletePolylineRawMaterial(context);

      case 'arrow':
        return createCompleteArrowRawMaterial(context);
    }
  },
});
```

一个具体图元只触发合法 pass 子集，因此 switch 的其它分支不会执行。TypeScript 仍要求 exhaustiveness，以便同一 Raw Appearance 可被不同图元共享。

### 12.6 恢复默认 Appearance

```ts
primitive.setAppearance(customAppearance);

// 事务式重建当前 legacy style 对应的内部默认 Material：
primitive.setAppearance(undefined);

line.setArrowAppearance(customArrowAppearance);
line.setArrowAppearance(undefined);
```

## 13. 关键决策与默认行为兼容承诺

没有传 `appearance` 时，构造结果必须与当前视觉一致：

| 当前路径 | Proposed 内部默认 Material |
| --- | --- |
| surface 纯色填充/描边 | `createColorGroundMaterial`，`baseColor/isStroke` 保留现有分支 |
| circle ring/sector | shape 阶段先裁切并选 baseColor，再调用 Color Material |
| text/image | `createTexturedDecalMaterial` |
| polyline solid | `createColorGroundMaterial` 的 polyline 编译形态 |
| polyline dash | `createPolylineDashMaterial` |
| arrow | 内部 Color/shape Material，保留 solid/open 裁切 |

兼容规则：

- 所有旧 options 和 setter 保留；
- 默认 renderOrder、非拾取 layer、transparent flag、混合因子不变；
- `SharedUniforms` 继续导出一个兼容周期，但扩展注释标记 `@deprecated`：用户不得把新增 key 当稳定扩展点；
- 现有 `ClassificationColorInjection` 降为内部 adapter，迁移完成后不作为公开 Proposed API；
- 根入口与 `./ground` 导出一致；`./arrow` 不导出 Ground Material API；
- `plot` 不进 library bundle 的事实不变。

## 14. 边界条件

1. 同一 logical Material 编译到不同 kind/pass 时会产生多个 compiled materials，这是正确行为。
2. 用户 Shader 读取不适用 input 字段得到零，不得到旧 draw 的残留值。
3. safe Material 可跨 kind 编译；运行时 Appearance 对象、slot 或 Raw pass 结构无效时在构造/切换阶段报 `GROUND_APPEARANCE_INCOMPATIBLE` / Raw 专用错误，不能等到第一帧静默失败。
4. Raw factory 不允许异步；纹理应在外部加载后写入既有 uniform wrapper。
5. 动态增删 uniform schema 不是动画手段；必须显式重编译。
6. Material alpha 为零仍不代表 surface color pass 可以提前 `discard`；框架必须完成 stencil 清理。
7. Raw 用户若 `discard`，其后果由用户承担；开发警告但无法自动修复。
8. Appearance 的同步校验/assembler/factory 切换失败保留旧材质，避免一帧无材质或 stencil 半更新；renderer 阶段的晚发 GPU 错误不在 v1 自动回滚范围。
9. 用户调用 logical Material `dispose()` 时，所有使用者应释放 compiled material；下一帧仍使用该 Material 时允许重新编译。
10. `THREE.Clock`、`Timer` 或业务仿真时钟都只是宿主时间源，API 不持有它们。

## 15. 导出清单

以下符号必须从 `cesium-to-three` 和 `cesium-to-three/ground` 同时导出：

```text
C23_GROUND_SHADER_ABI_VERSION
GroundDefineValue
GroundDefines
GroundUserUniforms
GroundSystemUniforms
GroundPrimitiveKind
GroundRenderPass
CesiumGroundAppearance
CesiumGroundMaterialOptions
CesiumGroundMaterialEventMap
CesiumGroundMaterial
CesiumGroundMaterialAppearanceOptions
CesiumGroundMaterialAppearance
GroundRawShaderBuildContext
GroundMaterialFactory
CesiumGroundRawShaderAppearanceOptions
CesiumGroundRawShaderAppearanceEventMap
CesiumGroundRawShaderAppearance
CesiumGroundAppearanceOptions
CesiumGroundAppearanceOwner
CesiumGroundTextPrimitiveOptions
CesiumGroundMaterialErrorCode
CesiumGroundMaterialError
GroundColorInput
ColorGroundMaterialOptions
TexturedDecalMaterialOptions
PolylineDashMaterialOptions
FlowLineMaterialOptions
PulsePointMaterialOptions
ScalePulseMaterialOptions
createColorGroundMaterial
createTexturedDecalMaterial
createPolylineDashMaterial
createFlowLineMaterial
createPulsePointMaterial
createScalePulseMaterial
```

图元 options / class 仍从原位置导出，只扩展其声明。

## 验收清单

- [ ] TypeScript 声明包含 Material、安全 Appearance、Raw Appearance、上下文和工厂的全部字段。
- [ ] `setUniform()` 只写既有 `.value`，未知 key 抛错且不改变 version。
- [ ] `needsUpdate=true` 的递增语义与 uniform runtime 变化严格分开。
- [ ] Raw factory context 只有锁定的五项，并为每个 pass 返回独立材质。
- [ ] `createDefaultMaterial()` 每次 factory 至多调用一次；调用后必须返回该实例，完整替换则零调用。
- [ ] 所有 Ground options 都有 `appearance?`；polyline 另有 `arrowAppearance?`。
- [ ] 所有实例都有 getter/`setAppearance()`；polyline 有 `setArrowAppearance()`。
- [ ] point 三种 delegate 完整透传同一 Appearance 引用。
- [ ] frame state 三个时间字段及缺省/规范化规则明确。
- [ ] preset 签名、默认值与 [07](./07-built-in-effects.md) 一致。
- [ ] 保留前缀、uniform 合并和稳定错误 code 已定义。
- [ ] 默认路径继续接受全部旧 options/setter 并保持视觉结果。
- [ ] 新符号可从根入口和 `cesium-to-three/ground` 导入。

---

上一篇：[03 · 目标架构](./03-target-architecture.md)  
下一篇：[05 · Shader ABI](./05-shader-abi.md)
