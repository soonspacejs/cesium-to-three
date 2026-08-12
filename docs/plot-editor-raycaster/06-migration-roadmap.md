# 迁移实施路线

## 总原则

迁移按可测试的垂直切片推进。新旧实体命中不能长期同时决定交互；过渡期可以 shadow-compare 记录差异，但用户可见选择必须只有一个权威结果。

## 阶段 0：冻结行为契约

先把以下失败案例加入集成测试，并确认旧实现至少能稳定复现问题：

- 单击已有文本不得创建新文本；
- 单击实体后立即出现高亮；
- 棕色小圆可以选中并移动；
- 双击文本进入编辑，`Escape` 可取消；
- 旋转文本高亮轮廓与显示一致；
- 重叠对象选择最近的可见交点。

这些测试在新实现完成前可标记为待修复，但不能删除或降低断言。

## 阶段 1：基础设施

新增建议模块：

```text
src/lib/plot-editor/picking/
├─ PlotEntityRaycaster.ts
├─ PlotPickRegistry.ts
├─ PlotPickMetadata.ts
├─ PlotPickAdapterRegistry.ts
├─ adapters/
│  ├─ PointPickAdapter.ts
│  ├─ LinePickAdapter.ts
│  ├─ AreaPickAdapter.ts
│  └─ TextPickAdapter.ts
└─ index.ts
```

同时：

- 在 `EditorOverlayLayer` 增加 `PLOT_PICK: 28`；
- 明确排除 `EditorCameraLayerLease` 对该层的启用；
- 在 `EditorOverlayRenderer` 增加 `plotEntityPickRoot`；
- 为 registry、metadata 解析、layer 隔离和 dispose 建立单元测试。

## 阶段 2：接入可直接拾取的 Object3D

为渲染桥提供只读 entry 访问或生命周期回调，避免 picking 模块通过私有字段或遍历 scene 猜测 feature 对象。

推荐契约：

```ts
interface RenderEntrySnapshot {
	readonly featureId: PlotFeatureId;
	readonly root: Object3D;
	readonly revision: number;
	readonly raycastCandidates: readonly Object3D[];
}
```

只登记通过 [直接复用判定](./03-pick-object-contract.md#直接复用显示对象的判定) 的 candidates。其余对象明确返回空 candidates，进入代理适配器。

## 阶段 3：补齐标准代理

按问题优先级实现：

1. text 平面代理；
2. point/image-point 代理；
3. circle/sector 面代理；
4. rectangle/polygon/arrow 面代理；
5. line 带状代理；
6. variable-height 与贴地 resolved surface 更新。

每实现一种适配器，都同时完成：几何单测、Raycaster 命中测试、变换测试、dispose 测试和 demo 场景回归。

## 阶段 4：切换事件路由

在 `PlotEditor` 的 pointer 仲裁中引入单次命中快照：

```text
overlayHit -> entityRayHit -> creationSurfaceHit -> camera/blank
```

修改 `HitTarget`/内部 intent，使实体命中携带 `PlotEntityHit`，而不是 CSS 距离结果。单击、拖拽候选与双击识别共享同一 `featureId` 语义。

此阶段同时修正文本行为：

- click = select；
- drag = move；
- double-click/F2 = edit；
- Escape = cancel edit 或取消当前 transient operation。

## 阶段 5：删除旧实体像素命中

当八类图形全部通过验收后：

- 从 `FeatureHitTester` 删除单点实体 hit-test 分支；
- 删除 entity CSS tolerance、投影点到线距离、实体 point-in-polygon 等不再使用的代码；
- 若框选仍需要二维投影，将其重命名/拆分为 `MarqueeSelectionProjector` 一类的专职模块；
- 删除过渡 feature flag 与 shadow-compare 日志；
- 更新公共 API、类型导出和设计文档状态。

## 阶段 6：性能与兼容性收尾

- 在高 DPI、canvas CSS 缩放、透视/正交相机下验证 NDC；
- 在地球大坐标、日期变更线、极区验证局部坐标代理；
- 验证 terrain/Tiles surface revision 可增量刷新代理；
- 压测 1,000+ feature；
- 检查 renderer/camera layer 恢复和 editor 重复创建/销毁；
- 确认打包产物不引入第二份 Three.js。

## 预期修改位置

| 位置 | 预期改动 |
| --- | --- |
| `src/lib/plot-editor/render/layers.ts` | 新增 Raycaster 专用层并保持 camera 禁用 |
| `EditorOverlayRenderer.ts` | 持有 pick root/registry，保留 overlay marker 命中 |
| `CanonicalPlotRenderBridge.ts` | 暴露稳定 render-entry 或同步 pick adapter |
| `PlotPrimitiveBridge.ts` | 暴露 feature 到 Object3D 的受控映射，不泄露可变内部 Map |
| `PlotEditor.ts` | 使用实体射线命中快照重排事件优先级 |
| `FeatureHitTester.ts` | 最终移除实体像素命中，只保留明确的区域选择职责 |
| `TextEditController.ts` | 只由 double-click/F2 进入，保证 commit/cancel 清理 |

## 回滚策略

每个阶段保持可编译、可测试。切换事件路由前，新 registry 可只运行诊断；切换后若出现严重回归，可通过一个短期内部 feature flag 回退整套实体命中，但不能按图形混用两个权威 hit tester。该 flag 必须在阶段 5 删除。

## 完成定义

只有同时满足以下条件才可把设计状态改为 Implemented：

- 八类实体单击、拖拽和重叠选择均由 Raycaster 决定；
- 代码中不存在实体 CSS 像素命中回退；
- 文本创建、选择、移动、编辑、取消的集成测试全部通过；
- 代理资源和 layer 生命周期测试通过；
- demo 人工验收通过；
- 旧 GIS 文档中的冲突描述已删除或标注历史方案。

