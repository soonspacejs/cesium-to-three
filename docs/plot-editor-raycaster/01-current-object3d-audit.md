# 当前 Object3D 与命中能力审计

> 本文主体记录迁移前审计事实；2026-08-12 已完成目标实现，末尾章节记录迁移结果。

## 结论

标绘对象并不是“非 Three 对象”。当前渲染链已经以 `Group/Object3D` 为容器：

- `PlotPrimitiveBridge` 的 `PlotEntry.group` 是 `THREE.Group`；
- `PlainPlotPrimitive.group` 是 `THREE.Group`；
- ground polygon/circle/point 等通过 `classification.group` 挂载；
- ground polyline 和 text 直接暴露 `group`；
- `CanonicalPlotRenderBridge` 将 legacy ground/plain 与 variable-height RTE 图元挂到固定 root。

问题在于部分显示几何不满足 Three 内建 `raycast()` 的标准数据约定，而不是缺少 `Object3D`。

## 当前对象树

```text
EditorOverlayRenderer
├─ plotCommittedRoot : Object3D
│  └─ CanonicalPlotRenderBridge
│     ├─ PlotPrimitiveBridge
│     │  ├─ CesiumGround*.group / classification.group
│     │  └─ PlainPlotPrimitive.group
│     └─ VariableHeightRtePrimitive.group
├─ plotDraftRoot : Object3D
├─ handleRoot : Object3D
├─ gizmoRoot : Object3D
├─ feedbackRoot : Object3D
└─ plotEntityPickRoot : Group（迁移后新增，仅 layer 28）
```

## 命中能力矩阵

| 对象路径 | 是 Object3D | 可直接使用标准 Raycaster | 原因/处理 |
| --- | --- | --- | --- |
| 标准 `Mesh` 且 geometry 有 `position` | 是 | 是 | 直接登记显示对象 |
| 标准 `Line/LineSegments` | 是 | 是，但需配置阈值 | 使用 `raycaster.params.Line.threshold` |
| 标准 `Points` | 是 | 是，但需配置阈值 | 使用 `raycaster.params.Points.threshold` |
| classification shadow-volume mesh | 是 | 否 | 使用 `position3DHigh/Low`、特殊 shader 和体积几何；建立表面代理 |
| `PlainPlotPrimitive` RTE mesh | 是 | 通常否 | 顶点属性与着色器采用 RTE，不满足默认 `Mesh.raycast()` 假设；建立标准代理 |
| `VariableHeightRtePrimitive` | 是 | 通常否 | 同上；建立标准代理 |
| 文本/图片的标准平面 mesh | 是 | 视具体 geometry 而定 | 标准 `position` 与变换正确时直接登记，否则建立平面代理 |
| 控制点/Gizmo | 是 | 不纳入实体射线 | 保持既有 overlay 屏幕空间规则 |

## classification 不能直接拾取的技术原因

`src/lib/ground/classification.ts` 创建 front stencil、back stencil 和 color shadow-volume mesh，并将其放在 `CESIUM_GROUND_NON_PICKABLE_LAYER`。这些 mesh 的职责是以 stencil/classification 管线生成贴地可见结果，不是表达用户看到的二维标绘表面。

直接射击 shadow volume 会产生两个错误：

1. 即便补齐标准顶点属性，射线可能击中挤压体的侧面或背面，而不是屏幕上看到的贴地面；
2. 自定义 RTE 顶点属性、bounding volume 和 shader 变换与 Three 默认 `Mesh.raycast()` 的 CPU 几何假设不同。

因此 classification 显示 mesh 继续保持不可拾取，另由标准表面代理表达“用户可选择的区域”。

## 迁移前 `FeatureHitTester` 的限制

迁移前的 `src/lib/plot-editor/selection/FeatureHitTester.ts` 以屏幕投影后的几何进行 CPU 命中。此路径存在结构性限制：

- 命中与 Three 场景真实深度解耦；
- 图形旋转、透视缩放和遮挡需要重复模拟；
- 点、文本、图片、圆等必须分别维护 CSS 像素足迹；
- 鼠标第一次点击究竟命中实体还是落入创建逻辑，取决于不完整的二维规则；
- 选择框可出现，但并不证明射线命中了对象。

该类现已删除。框选所需的二维投影被拆分为
`ProjectionSnapshot` 与 `MarqueeSelectionProjector`，它们没有单点实体选择 API。

## 当前图层事实

`EditorOverlayLayer` 当前使用 24–28：

| 图层 | 当前用途 |
| --- | --- |
| 24 | `PLOT_CONTENT` |
| 25 | `PLOT_HANDLE` |
| 26 | `PLOT_GIZMO` |
| 27 | `PLOT_FEEDBACK` |
| 28 | `PLOT_PICK`（仅 Raycaster） |

`PLOT_PICK` 只由 `Raycaster.layers` 启用；`EditorCameraLayerLease` 明确排除该层，
因此拾取代理不会进入渲染截图。

## 迁移结果

所有现有标绘显示路径均属于 classification、RTE 或 Sprite 特殊语义，当前统一使用
标准代理，未冒险复用不满足原生 `raycast()` 契约的显示对象。Registry 仍完整支持
`source: 'visual'` 的受控登记、原 layer 恢复与显示资源非所有权，供未来出现安全的
标准显示 Mesh 时直接复用。

## 必须保留的现有能力

- canonical 文档与渲染桥的单向同步；
- classification 与 RTE 的显示精度方案；
- overlay 控制点/Gizmo 的优先交互；
- 地形、Tiles 和椭球面的表面拾取；
- pointer capture、相机锁、事务及撤销/重做。

Raycaster 改造只替换“标绘实体怎样被命中”，不重写上述能力。
