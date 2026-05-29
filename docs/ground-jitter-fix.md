# 贴地标绘抖动问题修复记录

> 修复 Cesium → Three.js 贴地分类（GroundPrimitive / ClassificationPrimitive）
> 移植版本在「小比例尺 + 上下倾斜」时图形抖动的问题。

## 1. 项目背景

本项目把 Cesium 的贴地标绘（GroundPrimitive 用的 shadow-volume + stencil 分类
渲染）移植到 Three.js + um-3d-tiles-renderer 环境：

- **um-3d-tiles-renderer**：提供地形数据 / 贴地深度来源（Cesium World Terrain）。
- **three**：底层渲染引擎，所有真正提交给 GPU 的画面都走 Three 的 WebGL2 上下文。
- **cesium（这里只用 Core / Scene / Shaders 部分源码，未启动 Cesium Viewer）**：
  作为「标绘几何 + 标绘 shader」的供给方，
  负责把 lon/lat 输入变成 shadow-volume geometry，
  并提供 `ShadowVolumeAppearanceVS / ShadowVolumeAppearanceFS / ShadowVolumeFS` 三段 GLSL。

整条链路：Cesium 出几何+shader → Three 上 GPU 渲染 → 3dtiles 出深度供分类比较。

## 2. 问题现象

- 在「小比例尺」（远视角、相机离地表很远）下移动相机，
  **特别是改变上下倾斜（pitch）时，地面标绘图形抖动**。
- 抖动表现为整体几何位置 / 边缘 / 填充每帧轻微跳动。
- 近视角小幅度抖动也存在，但远视角更明显。

## 3. 根因分析

总共定位到 5 处「硬编码 / 简约实现」的偏离 Cesium 原版的位置，叠加放大形成抖动：

### A. 单一线性 24-bit depth buffer，远处精度极差

- 原 demo `near = 1.0, far = 4e7`，比例 4×10⁷。
- 线性深度在远端每个 LSB ≈ 10⁴ m 以上的世界距离误差。
- 颜色 pass 用 `czm_globeDepthTexture` 重建 fragment 的 eye coordinate，
  每帧重建误差直接体现在 `czm_planeDistance(v_westPlane, eye)` 得到的 `uv` 上，
  `CULL_FRAGMENTS` 边界因此抖动。

Cesium 用 **multifrustum + LOG_DEPTH** 缓解，原移植版完全没有 log depth 路径。

### B. `czm_geometricToleranceOverMeter` 硬编码为 1.0

- Cesium 的真实公式：
  `pixelSizePerMeter * maximumScreenSpaceError`
  = `(2 * tan(fov/2) / max(width, height)) * 2.0`
  ≈ **1e-3 量级**。
- 硬编码 1.0 比真实值大 ~1000 倍，导致 vertex shader 中
  ```
  delta = min(u_globeMinimumAltitude, czm_geometricToleranceOverMeter * length(positionEC))
  ```
  几乎永远被钳到 `u_globeMinimumAltitude = 55 km`。
- shadow volume bottom layer 永远向下额外 push 55 km，
  vertex 在 view space 与 near plane 关系不稳定，
  oblique 视角下 stencil DECR/INCR 计数失稳。

### C. shadow volume 几何高度硬编码为 `±CESIUM_GLOBE_MINIMUM_ALTITUDE` = ±55 km

- Cesium 的 `GroundPrimitive` 用
  `ApproximateTerrainHeights.getMinimumMaximumHeights(rectangle)` 取
  实际地形 min/max（量级 -400 m ~ +9 km）。
- 我们的实现把 vertex-shader 的 extrude 兜底常量 `55000` 当作
  几何 `minimumHeight / maximumHeight` 的默认值，
  shadow volume 几何本身就 **110 km 厚**，
  再叠加 B 项的 +55 km extrude，总厚度 **165 km**。
- 小比例尺下整张 shadow volume 投影到屏幕上跨度极大，
  边缘 fragment 多，远端 depth 精度差，stencil 状态不稳。

### D. Stencil pass `depthFunc` 错用 `LessDepth`

- Cesium `getStencilDepthRenderState` 用 `DepthFunction.LESS_OR_EQUAL`。
- Three.js Material 默认 `depthFunc = LessDepth`。
- 在 shadow volume 面与 terrain 同高度时，
  `LESS` 会把这些 fragment 判为 fail，
  DECR/INCR stencil op 丢失，
  填充边缘出现条纹或孔洞。

### E. Matrix4 elements 经 Three.js Float32Array 中转

- Three.js `Matrix4.elements` 是 `number[]`（JS Number = Float64），
  但中间存储链 / 上传途径里仍有 Float32 关口（如 camera 自动 invert 路径）。
- 我们的 RTE 计算（projection × viewRotation × (vertexHigh+vertexLow - cameraHigh-cameraLow)）
  在 vertex/projection 矩阵元素精度受损时直接体现为 clip space 抖动。

## 4. 修复方案

按 「**根治深度精度 + 修正所有硬编码 + 与 Cesium 真正对齐**」 全套实现。
所有改动都尽量复用 Cesium 原版 GLSL / JS 源码，不做简化。

### A. 完整移植 Cesium LOG_DEPTH 路径

**新增 / 修改：** `src/lib/ground/materials.ts`、`src/lib/ground/depth.ts`、
`src/lib/ground/terrain-log-depth.ts`、`src/demo/tiles.ts`、`src/demo/ground-demo.ts`

- **vertex shader 末尾**：通过 `wrapShaderMain()` 注入 `czm_vertexLogDepth();`，
  写 `v_depthFromNearPlusOne = (gl_Position.w - czm_currentFrustum.x) + 1.0;`
  并 clamp `gl_Position.z` 到 `[-w, w]`，避免 vertex 被 near plane 提前 clip。
- **fragment shader 末尾**：注入 `czm_writeLogDepth();`，
  `gl_FragDepth = log2(v_depthFromNearPlusOne) * czm_oneOverLog2FarDepthFromNearPlusOne`。
  对 shadow volume 做了一个 **关键改动**：在 near / far 之外
  **不 discard，而是 clamp 到 `0.0` / `1.0`**，
  以保证 GL_DEPTH_CLAMP 语义下 stencil counts 不被破坏
  （Cesium 原版依赖 multifrustum 让这种情况几乎不发生，我们单 frustum 必须 clamp）。
- **packed depth pass** (`createPackDepthMaterial`)：
  同样用 Cesium log depth 公式 pack 到 RGBA8，
  保证颜色 pass 用 `czm_unpackDepth` + `czm_screenToEyeCoordinates(LOG_DEPTH 路径)`
  能正确重建 eye coordinate。
- **terrain（主 framebuffer）**：
  新增 `terrain-log-depth.ts`，
  通过 `material.onBeforeCompile` 给 um-3d-tiles-renderer 加载的所有 terrain material
  注入与我们 shadow volume **完全相同公式** 的 `gl_FragDepth` 写入逻辑，
  保证主 framebuffer 的 depth value 与 shadow volume 在同一坐标系，
  否则 `LESS_OR_EQUAL` 的 stencil/depth 比较会全错。
- **新增 uniform**：
  - `czm_currentFrustum`（vec3，存 near / far）
  - `czm_farDepthFromNearPlusOne`
  - `czm_log2FarDepthFromNearPlusOne`
  - `czm_oneOverLog2FarDepthFromNearPlusOne`
  并提供共享 uniform 引用（`terrainLogDepthUniforms`），
  每帧由 `updateTerrainLogDepthUniforms(near, far)` 同步给所有 terrain material。

### B. 动态计算 `czm_geometricToleranceOverMeter`

**修改：** `src/lib/ground/classification.ts` 中 `updateFrameStateUniforms()`

```ts
const viewportSize = Math.max( frameState.width, frameState.height, 1.0 );
const pixelSizePerMeter = ( Math.tan( 0.5 * fovRad ) * 2.0 ) / viewportSize;
uniforms.czm_geometricToleranceOverMeter.value =
    pixelSizePerMeter * CESIUM_MAXIMUM_SCREEN_SPACE_ERROR;
```

`CESIUM_MAXIMUM_SCREEN_SPACE_ERROR = 2.0`（Cesium scene 默认值，新增到
`constants.ts`）。

### C. 用 `ApproximateTerrainHeights` 收紧 shadow volume 厚度

**新增：** `src/lib/ground/terrain-heights.ts`

- 直接 `import` 同步的 `approximateTerrainHeights.json`
  （从 `cesium-packages-source` 拷贝到 `cesium-ground-source/engine/Source/Assets/`），
  通过 `ApproximateTerrainHeights._terrainHeights = json` 注入，
  跳过 `buildModuleUrl` / `Resource.fetchJson` 异步路径。
- 暴露 `initializeApproximateTerrainHeights()` 给宿主在启动时同步调用。

**修改：** `src/lib/ground/primitives.ts`

- `resolveShadowVolumeHeights(rectangleDegrees, minOverride, maxOverride)`：
  优先用 caller 显式 override，
  否则 `getTerrainMinMaxHeightsForRectangle(rectangleDegrees)`
  返回 tile 实际 min/max（量级 -400 m ~ +9 km）。
- 多边形版本通过 `rectangleDegreesFromPolygonHierarchy(hierarchy)` 求外接矩形再查询。

注意：`u_globeMinimumAltitude` 仍然保留 55 km，
这是 Cesium 设计里 vertex shader extrude 的**上限兜底**，
不是 shadow volume 几何范围，与 C 修复语义不冲突。

### D. Stencil pass `depthFunc = LessEqualDepth`

**修改：** `src/lib/ground/materials.ts`，`createStencilMaterial(...)` 内：

```ts
depthFunc: LessEqualDepth,
```

匹配 Cesium `getStencilDepthRenderState` 的 `DepthFunction.LESS_OR_EQUAL`。

### E. Float64 中间矩阵运算

**修改：** `src/lib/ground/classification.ts`

- 三个 `Float64Array(16)` scratch：`viewRotationFloat64`, `projectionFloat64`, `mvpFloat64`。
- `writeViewRotationFloat64(qx, qy, qz, qw, out)`：
  直接从 `camera.quaternion` 用 Float64 算出 view rotation（translation 置零），
  绕过 `camera.matrixWorldInverse` 的 Float32Array 中转。
- `writePerspectiveProjectionFloat64(fov, aspect, near, far, out)`：
  从 fov / aspect / near / far 在 Float64 重算 projection，
  与 Three.js `updateProjectionMatrix` 对齐但全程 Float64。
- `multiplyMatricesFloat64(a, b, out)`：
  Float64 → Float64 的 mat4 乘法，
  最后通过 `Matrix4.fromArray(float64Scratch)` 写入 uniform。
- **运行时 bug 修复**：最初写成 `matrix.elements.set(float64Array)`，
  但 Three.js `Matrix4.elements` 是普通 `number[]`，没有 `set()`；
  改用 `Matrix4.fromArray()`，按 index 拷贝。

## 5. Demo 比例尺拆分

为了一眼能看出修复在「小尺寸物体」和「大尺寸物体」两种比例下都成立，
demo 把矩形和多边形拆成两个不同尺度：

**修改：** `src/demo/ground-demo.ts`

| 几何 | 默认尺寸 | GUI 范围 | step | 含义 |
|------|----------|----------|------|------|
| 矩形 | 10 m | 1–50 m | 0.1 m | 小比例尺：小物体，远视角 |
| 多边形 | 5000 m (5 km) | 100–20000 m | 10 m | 大比例尺：大物体，近视角 |

相机初始位置按两者中较大尺寸 × `CAMERA_HEIGHT_MULTIPLIER` 取景，
保证两个图形同时进入视野。

## 6. 文件改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/lib/ground/constants.ts` | 修改 | 新增 `CESIUM_MAXIMUM_SCREEN_SPACE_ERROR` / `APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT` / `APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT` |
| `src/lib/ground/types.ts` | 修改 | 新增 LOG_DEPTH 相关 uniform 字段 |
| `src/lib/ground/terrain-heights.ts` | 新增 | ApproximateTerrainHeights 同步注入 + 查询封装 |
| `src/lib/ground/terrain-log-depth.ts` | 新增 | Three.js terrain material onBeforeCompile log depth 注入 |
| `src/lib/ground/materials.ts` | 重写 | LOG_DEPTH 路径、`LessEqualDepth`、shader main 包装、pack-depth log depth |
| `src/lib/ground/classification.ts` | 重写 | 动态 geometricTolerance、log depth uniform、Float64 RTE 矩阵 |
| `src/lib/ground/depth.ts` | 修改 | per-frame log depth uniform 更新、`PerspectiveCamera` 类型 |
| `src/lib/ground/primitives.ts` | 修改 | terrain-aware min/max、polygon 外接矩形求取 |
| `src/lib/ground/cesium-ground-adapter.ts` | 修改 | 导出新增 API |
| `src/demo/tiles.ts` | 修改 | 对每个加载的 terrain material 调用 `applyCesiumLogDepthToMaterial` |
| `src/demo/ground-demo.ts` | 修改 | 启动时 `initializeApproximateTerrainHeights()`、每帧 `updateTerrainLogDepthUniforms(near, far)`、矩形 vs 多边形比例尺拆分 |
| `cesium-ground-source/engine/Source/Assets/approximateTerrainHeights.json` | 新增 | 从 `cesium-packages-source` 拷贝过来 |

## 7. 验证

打开 dev server 后：

- 远视角看 5 km 多边形 + 10 m 矩形：上下倾斜 / 平移相机，
  两个标绘都不再抖动。
- 近视角看 10 m 矩形：边缘稳定，stencil fill 不再出条纹。
- 近视角穿过 5 km 多边形：shadow volume 穿过 camera near plane 时
  fill 仍然连续（LOG_DEPTH clamp 而非 discard 起作用）。

## 8. 设计要点 / 反思

1. **「Cesium 提供数据，Three 负责渲染」**。深度公式必须**两边一致**：
   - 主 framebuffer terrain 的 depth 写入公式
   - shadow volume 写入 gl_FragDepth 的公式
   - packed depth pass 写入 RGBA8 的公式

   三者用同一套 `log2((w - near) + 1) / log2((far - near) + 1)` 才能让
   `LESS_OR_EQUAL` / `czm_screenToEyeCoordinates(LOG_DEPTH)` 闭环。

2. **GL_DEPTH_CLAMP 在 LOG_DEPTH 下的语义补丁**：
   Cesium 原版 `czm_writeLogDepth` 对 near 后方 fragment `discard`，
   依赖 multifrustum 让这种情况罕见。
   我们单 frustum 必须 clamp 到 `0.0 / 1.0`，否则 stencil counts 会丢，
   shadow volume 边缘出现孔洞。这是 Cesium → Three 移植时的关键设计差异。

3. **Float64 中间运算不是单纯的「写法洁癖」**：
   ECEF 大坐标（~6.4×10⁶ m）+ Float32 矩阵元素 ≈ 0.5 m 精度，
   显式走 Float64 scratch 后，
   `czm_translateRelativeToEye` 在 vertex shader 内的减法
   完整保留 7 位以上有效数字。

4. **「硬编码 vs 动态」是抖动的常见根因**：
   - `czm_geometricToleranceOverMeter`
   - `minimumHeight / maximumHeight`
   - `czm_farDepthFromNearPlusOne` 等 LOG_DEPTH 相关 uniform

   都必须**按帧**从相机当前状态算出来，硬编码就是潜伏 bug。

5. **`depthFunc`**：
   Cesium 的所有 shadow-volume render state 都用 `LESS_OR_EQUAL`，
   Three.js 默认 `LessDepth`，
   不显式覆写就是另一个潜伏 bug。
