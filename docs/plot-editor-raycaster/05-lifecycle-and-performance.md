# 生命周期与性能设计

## 同步时机

拾取对象与显示对象消费同一份投影结果，但各自维护生命周期：

| 变化 | 显示对象 | 拾取对象 |
| --- | --- | --- |
| feature 新增 | 创建显示 entry | 直接登记或创建代理 |
| 几何/高度变化 | 更新或重建 | 更新标准 geometry 或原子替换代理 |
| 纯颜色/透明度变化 | 更新 material | 通常不变 |
| 文本内容/字号/对齐变化 | 更新布局/纹理 | 重建或调整文本平面 |
| 顺序变化 | 更新 renderOrder | 更新稳定排序字段 |
| visible=false | 隐藏显示 | 从 registry targets 移除 |
| feature 删除 | 释放显示资源 | 注销并释放自有代理资源 |

## Revision

每个 `PlotPickEntry` 至少记录：

```ts
interface PlotPickRevision {
	featureRevision: number;
	resolvedGeometryRevision: number;
	layoutRevision?: number;
}
```

只有影响可选择表面的变化才重建 geometry。颜色、透明度、hover 和 selection 状态不应触发代理重建。

## 构建顺序与失败策略

采用候选替换：

1. 根据新 revision 构建候选 targets；
2. 计算 bounding box/sphere 并执行开发期断言；
3. 候选全部成功后写入 registry；
4. 再移除并释放旧代理。

构建失败时保留上一版有效拾取对象，并通过诊断回调报告 `featureId`、类型和 revision。不能因一次字体测量或 triangulation 失败让整个 registry 清空。

## 每帧工作

正常静止帧不重建代理。指针移动时允许：

- 一次 CSS → NDC 转换；
- 一次 `setFromCamera`；
- 一次 `intersectObjects`；
- 必要的 metadata 解析与 feature 去重。

不允许在每次 pointermove：

- JSON stringify 全文档；
- 重建全部几何；
- 将所有 feature 重新投影到 CSS 像素；
- 分配大量临时 Vector/Array；
- 为每个 feature 创建一个新 Raycaster。

## Registry target 粒度

`intersectObjects(targets, true)` 的 `targets` 只包含 feature 级根对象或直接复用的最小公共根，不能直接传整个 scene。这样可以排除地球、Tiles、辅助物和其他业务模型。

同一 feature 的多个子 mesh 尽量挂在一个根下；若直接复用对象分散在显示树中，registry 可保存多个 target，但结果必须按 feature 去重。

## 空间加速

首版使用 Three 原生 Raycaster 与 geometry 自带 bounding sphere/box，不把 BVH 作为正确性依赖。只有性能测试证明大量复杂面成为瓶颈后，才可在不改变接口的前提下为标准 `Mesh.raycast` 接入兼容加速实现。

无论是否接入 BVH，调用者仍只使用 Raycaster；不得回退到 CSS 像素实体命中。

## 代理精度与复杂度

- 圆/扇形的分段可与显示 tessellation 共享，或使用有上限的拾取分段；
- 箭头/多边形复用已有派生轮廓与 triangulation 结果，避免重复算法；
- 文本只需实际布局矩形，不需要逐字三角化；
- 图片点只需带正确变换的平面；
- 线的代理带宽应表达视觉宽度，避免无限细线造成难以命中。

拾取代理可以比显示 mesh 更简单，但不能扩张到明显超出可见对象，尤其不能再次退化成大号屏幕包围盒。

## 内存与清理

需要自动测试以下资源规则：

- feature 重建后 registry 中只有一个当前 entry；
- 删除 feature 后 targets 不再包含任何后代引用；
- proxy geometry 的 `dispose()` 恰好调用一次；
- 共享 material 在 editor dispose 时调用一次；
- 直接复用的显示 geometry 不由 pick registry dispose；
- layer 位在注销时恢复；
- editor dispose 后 `hitTest()` 始终返回 null 或抛出约定的 closed error，不能访问悬空对象。

## 建议性能预算

在项目基准 demo、常规桌面浏览器中建立可重复基线：

- 1,000 个简单标绘实体的 pointermove 拾取 P95 小于 4 ms；
- 无 geometry revision 时，连续 300 次 pointermove 的代理重建次数为 0；
- 单 feature 几何编辑只更新该 feature，不扫描重建全量 entry；
- editor dispose 后 GPU proxy geometry 数量回到 0。

具体毫秒阈值可随 CI 机器校准，但“增量更新”和“无无关重建”是硬性要求。

