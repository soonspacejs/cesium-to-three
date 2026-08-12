# 拾取 Object3D 契约

## 公共元数据

每个登记的根拾取对象必须携带只读元数据。子 mesh 不必重复写入，命中后沿 `parent` 向上查找。

```ts
export interface PlotPickMetadata {
	readonly kind: 'plot-entity';
	readonly featureId: PlotFeatureId;
	readonly featureType: PlotFeature[ 'type' ];
	readonly source: 'visual' | 'proxy';
	readonly part: 'body' | 'fill' | 'stroke' | 'label' | 'icon';
	readonly pickPriority: number;
}
```

建议挂载键名：

```ts
object.userData.plotPick = metadata;
```

不得通过对象 `name` 解析 feature id；`name` 只用于调试。

## 图层契约

新增：

```ts
EditorOverlayLayer.PLOT_PICK = 28;
```

约束：

- `PlotEntityRaycaster.layers.set(PLOT_PICK)`；
- 可直接拾取的显示对象保留显示层，并额外 `layers.enable(PLOT_PICK)`；
- 代理对象只设置 `PLOT_PICK`；
- `EditorCameraLayerLease` 不启用 `PLOT_PICK`；
- classification shadow-volume mesh 永远不启用 `PLOT_PICK`；
- dispose 时恢复复用显示对象原来的 layer 位，防止编辑器污染宿主对象。

仅靠 `visible = false` 隐藏代理不是本设计的隔离手段。代理是否渲染由 camera layer 决定，射线是否参与由 raycaster layer 决定。

## 直接复用显示对象的判定

只有同时满足以下条件才能 `source: 'visual'`：

1. 对象或其子对象实现 Three 内建、未破坏语义的 `raycast()`；
2. geometry 具备该内建实现需要的标准属性和 index；
3. `matrixWorld` 与实际可见位置一致；
4. bounding box/sphere 可由标准 geometry 正确计算；
5. 交点所代表的表面与用户看见并期望选择的表面一致；
6. 材质侧面设置不会意外拒绝可见正面命中。

任一项不满足就使用代理。不能因为它继承 `Object3D` 就假定默认射线一定正确。

## 代理通用约束

- 只使用 Three 标准 `BufferGeometry` 属性，至少包含 `position`；
- 代理变换必须落在正常 `matrixWorld` 上，不能只存在于 shader uniform；
- 面代理使用标准 `Mesh`，线代理使用标准 `Line/LineSegments`，点状图元优先使用小型 `Mesh`；
- 代理材质采用共享、无纹理的基础材质；它不参与渲染，但 `side` 仍影响 `Mesh.raycast()`；
- 面状代理默认 `DoubleSide`，避免绕序、相机位于表面背侧等因素造成不可选；
- 代理不得写入文档、导出 JSON 或撤销历史；
- 代理几何来自与显示对象相同的 canonical/resolved geometry revision；
- 大地坐标先转入稳定局部坐标系，再通过根对象矩阵定位，避免用超大 ECEF `Float32 position` 降低精度。

## 各图形的拾取对象

| 图形 | 首选标准对象 | 几何语义 |
| --- | --- | --- |
| point（纯色） | `Mesh` 圆盘/球面代理 | 覆盖实际可见半径，不使用 CSS 像素半径 |
| point（图片） | `Mesh<PlaneGeometry>` | 使用实际宽高、锚点和旋转 |
| line | `Line/LineSegments` 或窄带 `Mesh` | 若视觉宽度是世界单位用原线；若视觉线宽由特殊 shader 生成，则用标准窄带 mesh |
| polygon | 三角化 `Mesh` | canonical 外环/洞的实际表面 |
| rectangle | 两三角形 `Mesh` | 四角实际表面 |
| circle | 分段三角扇 `Mesh` | 使用与显示同一圆心、半径和分段策略 |
| sector | 分段三角扇 `Mesh` | 使用同一起始角、张角和半径 |
| arrow | 三角化 `Mesh` | 使用由控制点派生的最终箭头轮廓 |
| text | `Mesh<PlaneGeometry>` | 使用文本排版后的实际矩形、对齐、偏移和旋转 |

对于贴地对象，代理不能使用 classification 的挤压体。它表达最终贴附表面：每个代理顶点使用 height resolver 已解析的表面高度，并沿法线增加极小拾取偏移以避免数值共面问题。该偏移只存在于 pick geometry，不回写作者高度。

## 文本契约

文本是本次问题的高风险对象，必须满足：

- 代理平面尺寸来自当前布局测量结果，而不是固定默认宽度；
- `horizontalOrigin`、`verticalOrigin`、pixel/world offset 和 rotation 与显示一致；
- 文本内容变化、字体变化、字号变化、对齐变化均提升 `geometryRevision`；
- 单击平面只返回实体命中，不创建编辑框；
- 双击同一文本实体或选择后按 `F2` 才请求 `TextEditController.begin()`；
- 编辑框出现后，`Escape` 恢复原文并退出，提交键按产品既有契约执行。

## 线和点的阈值

Three 对 `Line` 与 `Points` 的阈值是世界空间参数，不是 CSS 像素。统一在每帧/每次拾取前根据当前相机和对象尺度配置合理世界阈值，但不能再绕回“按屏幕点到线距离决定实体命中”的旧实现。

若某种视觉效果在所有距离下都要求固定屏幕宽度，应构建与其显示规则一致的标准带状 `Mesh` 代理，而不是依赖一个全局像素容差。

## 重叠对象排序

Raycaster 首先按 `Intersection.distance` 升序。距离近似相同时使用稳定规则：

1. 更高 `pickPriority`；
2. 更高 canonical plot order（视觉上层）；
3. 更具体的 part（label/icon 优先于同实体 body 仅用于调试，不改变 featureId）；
4. feature id 词法序，保证测试确定性。

任何优先级都不能让更远且被明显遮挡的实体越过更近实体。

## 资源所有权

- 直接复用的显示对象：pick registry 只持弱语义引用，不 dispose geometry/material；
- 代理对象：pick registry 拥有 geometry，允许共享 material；
- 共享 material：由 registry 统一释放一次；
- entry 替换：先构建候选，成功后原子替换，再释放旧代理；
- feature 删除/editor dispose：必须移除对象、清理元数据并释放自有 GPU 资源。

