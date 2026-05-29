# 贴地文本标绘（Ground-Clamped PlotText）完整方案

> 路径：`src/lib/ground/text/`
> 渲染：**shadow-volume stencil classification + 纹理 color 命令**（贴合地形，与 Sprite 无关）。
> 规范：每个函数完整实现，无省略 / TODO / 伪代码；文件头注释 + JSDoc + why 行内注释；数值常量精确；`throw new Error()` 与现有 primitive 一致。

---

## 0. 定性

文本标绘是**独立竖线**。它与 circle / rectangle / polygon **唯一的交集**是最底层那条「CPU 算高精度 → 喂 GPU」的防抖动管线（RTE split-double + stencil 贴地 + 每帧相机 high/low 编码）。从几何构造往上——extents、材质、以及整套文字排版——全是文字自己的一套。

文本**不是** Sprite billboard：它平铺在地面、随地形起伏、可在地平面内旋转（沿道路 / 河流标注）。

---

## 1. 三层模型

```
┌─ A 层 · 文字身份（画进一张 RGBA 纹理；circle 没有这层）────────────┐
│  输入框：背景填充 + 描边(border) + 圆角                              │
│  文字：字色 + 字描边(font stroke)                                    │
│  文字相对【输入框】对齐：textAlign(左/中/右) + verticalAlign(上/中/下)│
│  排版方向：horizontal / vertical-rl / vertical-lr                    │
│  padding / lineHeight / letterSpacing                                │
│  → text-layout.ts 算字符位置 + text-canvas.ts 画成 canvas → 纹理     │
└────────────────────────────────────────────────────────────────────┘
                          │ 产出一张纹理（纹理内部单位 = 纹素 px）
                          ▼
┌─ B 层 · 输入框相对【世界锚点】的摆放（文字独有）──────────────────┐
│  框相对原点 anchorX/anchorY（居中 / 左 / 右 / 上 / 下）              │
│  米偏移 offsetEastMeters / offsetNorthMeters                        │
│  地平面内旋转 rotation（度，北向顺时针）                            │
│  地面足迹尺寸 footprint（米）：由 fontSize 的纹素 + metersPerPixel 推 │
│  → text-placement.ts 把上述 → 锚点 ENU 平面里 4 个【旋转后】角点 ECEF│
└────────────────────────────────────────────────────────────────────┘
                          │ 得到地面上一块带旋转的矩形足迹（4 个 ECEF 角点）
                          ▼
┌─ C 层 · 贴地（机制与 circle 同源，材质独立）──────────────────────┐
│  4 角点 → box 棱柱 shadow volume（top cap + bot cap + 4 墙）        │
│  RTE 编码 → position3DHigh/Low + extrudeDirection + batchId         │
│  旋转对齐的 PlanarExtents（eastward/northward 沿字面轴，uv 不歪）   │
│  独立 color 材质：在 uv 处采样 u_textTexture，stencil 投影到地形    │
│  → text-shadow-volume / text-extents / text-material /              │
│    text-classification / text-primitive                            │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. 共享底层（唯一与 circle 同源的部分）

| 共享底层 | 代码入口 | 作用 |
|---|---|---|
| RTE split-double 编码 | `math/rte-encoding.ts` → `encodeVec3RTE` / `encodePositionsToHighLowArrays` | Float64 ECEF（千万米）→ high/low 两个 Float32，绕过 Float32 7 位精度 |
| 几何 attribute 契约 | `position3DHigh` / `position3DLow` / `extrudeDirection` / `batchId` | `ShadowVolumeAppearanceVS.glsl` 消费的固定 attribute 名（不可改名） |
| 每帧 Float64 精度更新 | `classification.ts` → `updateFrameStateUniforms`（私有）+ `encodeCesiumVector3` | 相机 high/low、`czm_modelViewProjectionRelativeToEye` 用 Float64 算（绕过 Three Float32 中转）、cpu planes、log-depth uniform 全在此 |
| **LOG_DEPTH 路径** | `materials.ts` → `wrapShaderMain` + `LOG_DEPTH_*_HELPERS` | VS 注入 `czm_vertexLogDepth()`、FS 注入 `czm_writeLogDepth()`：对数深度消远视角 Z-fighting / 抖动；stencil pass discard 越界 fragment 保计数正确 |
| **CPU-plane uv** | `classification.ts` → `updateCpuPlanarUniforms` → `u_cpuWestPlane/u_cpuSouthPlane` | CPU 用 Float64 在 eye 空间算 uv 基平面，片元 `czm_planeDistance` 得**抖动免疫** planarMeters（替代 VS 插值的 `v_westPlane`） |
| 两个 stencil 材质 | `materials.ts` → `createStencilMaterial`（内容无关，`LessEqualDepth`） | front/back stencil 命令；文字直接复用 |
| 共享 classification | `classification.ts` → `CesiumClassificationPrimitive` | 三命令编排 + 每帧精度更新 + renderOrder + 非拾取层 + dispose。**circle/rectangle/polygon 全复用它，文字也复用**（注入文字 color 材质即可，见 C5） |

> **重要（来自最新代码 `docs/ground-jitter-fix.md`）**：最新贴地管线是 **LOG_DEPTH + CPU-plane + Float64-RTE** 的完整 jitter 修复版。文字贴的是同一套 shadow volume，**必须 100% 复用这条管线**，否则远视角 / 倾斜会抖动、深度与地形错位。因此文字 color 材质做成 `materials.ts` 的变体（复用 `wrapShaderMain` / prefix / log-depth helper，仅注入换成纹理采样），文字 classification 直接复用 `CesiumClassificationPrimitive`（注入扩展）。

文字用到上面这些共享底层，但**自己写 geometry / extents / 纹理 color 注入 / 整套 A 层排版 / B 层摆放**。

---

## 3. 模块文件清单

| 层 | 文件 | 文档 | 状态 |
|---|---|---|---|
| A | `text-types.ts` | [A1](./A1-types.md) | 类型 |
| A | `text-defaults.ts` | [A2](./A2-defaults.md) | 解析 + 校验 |
| A | `text-color.ts` | [A3](./A3-color.md) | CSS 颜色 → rgba |
| A | `text-layout.ts` | [A4](./A4-layout.md) | 横排 / 竖排布局 |
| A | `text-canvas.ts` | [A5](./A5-canvas.md) | 4 层绘制 → 纹理 |
| B | `text-placement.ts` | [B1](./B1-placement.md) | 锚点 + 偏移 + 旋转 + 米足迹 → 4 ECEF 角点 |
| C | `text-construct-extruded.ts` | [C1](./C1-construct.md) | 4 角点 → box 棱柱(positions/extrudeDir/index) |
| C | `text-shadow-volume.ts` | [C2](./C2-shadow-volume.md) | facade → BufferGeometry |
| C | `text-extents.ts` | [C3](./C3-extents.md) | 旋转对齐 PlanarExtents |
| C | `materials.ts` 增 `createTextColorMaterial` | [C4](./C4-material.md) | 纹理 color 材质(复用 LOG_DEPTH/CPU-plane 管线 + CESIUM_THREE_TEXT 注入) |
| C | `classification.ts` 注入扩展 | [C5](./C5-classification.md) | 加 color 材质工厂 + extraUniforms 注入点；文字复用共享 classification |
| C | `text-primitive.ts` + `index.ts` | [C6](./C6-primitive.md) | 公开类 + 桶导出 |
| — | 集成 / demo / checklist | [integration](./integration.md) | 接线 |

---

## 4. 关键几何推导（旋转足迹 → uv 对齐）

`ShadowVolumeAppearanceVS.glsl`（3D 非球面分支）用三个 batch-table 量重建 uv 基：

```glsl
southWestCorner = MV_RTE * translateRelativeToEye(southWest_HIGH, southWest_LOW)
southEastCorner = czm_normal * eastward  + southWestCorner   // eastward 是任意 ECEF 向量
northWestCorner = czm_normal * northward + southWestCorner   // northward 是任意 ECEF 向量
v_inversePlaneExtents = (1/|eastward|, 1/|northward|)
```

FS 里 `uv.x = planeDistance(westPlane, frag) / |eastward|`、`uv.y = 同理`。
**关键**：`eastward / northward` 不必沿 ENU 东 / 北 —— 它们是任意 ECEF 向量。所以把它们设成「旋转后字面盒子的两条边向量」，uv 就沿字面方向，纹理不被拉斜。这正是贴地旋转文本成立的根基（详见 [C3](./C3-extents.md)）。

足迹角点推导（B 层 + C 层共用，详见 [B1](./B1-placement.md)）：

```
锚点 (lon, lat) → ECEF → 椭球面 → eastNorthUpToFixedFrame = enuToEcef (4×4)
盒子在 ENU 平面 z=0 的局部坐标（含 anchor 对齐偏移 + offset 偏移）：
  半宽 hw、半高 hh（米）
  4 角（未旋转）：SW(−hw,−hh) SE(+hw,−hh) NW(−hw,+hh) NE(+hw,+hh)，再叠加 anchor/offset 平移
绕 ENU +Z（地表法向，朝天）转 θ = −rotation（北向顺时针 → ENU 数学逆时针取负）：
  x' = x·cosθ − y·sinθ
  y' = x·sinθ + y·cosθ
  enuToEcef · (x', y', 0) → ECEF 角点
```

---

## 5. 单位语义（贴地与 Sprite 的根本差别）

| 字段 | 贴地语义 |
|---|---|
| `fontSize` | **纹素**像素（决定纹理清晰度，不决定地面大小） |
| `metersPerPixel` | 每个纹素对应的地面米数（把纹理像素映射到地面足迹） |
| 地面足迹宽/高 | = canvas 像素尺寸 × `metersPerPixel`（米） |
| `rotation` | 在**地平面内**绕地表法向旋转（度，北向顺时针） |
| `offsetEastMeters/offsetNorthMeters` | ENU 平面内米偏移 |
| `anchorX/anchorY` | 足迹相对锚点的对齐（在 ENU 平面平移足迹） |

→ 从 [A1-types.md](./A1-types.md) 开始读。
