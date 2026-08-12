# 测试与验收标准

## 测试原则

测试必须证明交点来自 Three `Raycaster` 与登记的 `Object3D`，不能只断言最终 selection id 恰好正确。建议通过真实 Three camera、geometry 和 object matrix 进行单元测试，不 mock 掉 `intersectObjects()` 的几何行为。

## 单元测试

### NDC 与射线

- canvas 不在窗口原点时坐标正确；
- CSS 缩放、devicePixelRatio 变化不改变同一视觉点的 NDC；
- 透视与正交相机均使用 `setFromCamera()`；
- viewport 为零或事件在范围外返回空命中；
- raycaster 只启用 `PLOT_PICK`。

### Registry 与元数据

- child mesh 命中可沿 parent 解析到 feature；
- 一个 feature 多交点只返回最近标准化命中；
- hidden/deleted feature 不可返回；
- 复用显示对象时保留原显示 layer；
- 注销后恢复 layer 且不释放显示资源；
- 代理注销后 geometry 恰好 dispose 一次；
- 同距离按 priority、plot order、feature id 稳定排序。

### 图形适配器

每种图形至少覆盖中心命中、边界命中、明显外部不命中、旋转/缩放/平移后命中：

| 图形 | 必测项 |
| --- | --- |
| point | 小圆中心命中；圆外不命中；尺寸变化同步 |
| image point | 宽高、anchor、rotation 与可见平面一致 |
| line | 线带内命中、带外不命中、折线转角 |
| polygon | 凹多边形、绕序、洞（若业务支持） |
| rectangle | 旋转/非轴对齐四角 |
| circle | 半径内/外、不同相机距离 |
| sector | 张角边界、跨 0°、负/大角度归一化 |
| arrow | 派生轮廓内/外、控制点更新 |
| text | 内容宽度、字号、对齐、旋转、空文本策略 |

### 特殊渲染路径

- classification shadow-volume 本体不启用 `PLOT_PICK`；
- 射线命中的是标准表面代理，不是挤压体侧面；
- RTE 显示对象若不满足契约会选择 proxy adapter；
- 大 ECEF 坐标下，局部代理仍能稳定命中；
- resolved surface height 更新后旧代理被替换。

## 交互集成测试

### 文本主流程

1. 激活文本创建工具并创建一个文本；
2. 退出或保持工具状态，单击已有文本；
3. 断言文档 feature 数量不变、已有文本被选中、出现旋转一致的高亮；
4. 拖动文本，断言同一 feature 坐标变化且只产生一条历史命令；
5. 双击同一文本，断言只出现一个编辑框；
6. 输入新内容后按 `Escape`，断言内容恢复且编辑框消失；
7. 再次编辑并提交，断言内容变化且 undo/redo 正确。

### 小圆回归

使用问题截图所对应的“小棕色圆”尺寸场景：

- 单击圆内部必须选中圆；
- 红色选择框/高亮仅作为反馈，不参与命中；
- 拖拽圆后只有该 feature 移动；
- 单击圆外明显空白处不得选中；
- 与大圆重叠时按射线距离与视觉顺序稳定选择。

### 创建与选择仲裁

- 创建工具激活时单击已有实体，优先选中而不是创建；
- 单击空白才进入 surface picker 创建；
- 控制点覆盖实体时控制点优先；
- 未激活工具且点击空白不创建；
- pointercancel/blur 不留下半成品或相机锁。

### 遮挡和重叠

- 两个标绘沿视线重叠时选中最近交点；
- 同深度共面时按 plot order 稳定；
- 隐藏对象不阻挡可选对象；
- 拾取代理绝不出现在渲染截图中。

## 端到端环境矩阵

| 维度 | 覆盖 |
| --- | --- |
| DPR | 1、1.25/1.5、2 |
| canvas | 页面原点、带偏移、CSS 缩放 |
| camera | Perspective、Orthographic（若公共编辑器支持） |
| surface | ellipsoid、terrain、3D Tiles 可用/不可用 |
| coordinate | 常规区域、日期变更线附近、高纬度 |
| feature state | committed、draft、selected、hidden、locked |
| input | click、double-click、drag、Escape、F2、IME composition |

## 静态验收

代码审查使用以下硬门槛：

- 实体 hit-test 路径存在 `Raycaster.setFromCamera()` 与 `intersectObject(s)`；
- 不存在以 CSS 像素距离作为实体选择最终裁决的 fallback；
- 不存在自研 ray-circle、ray-polygon、ray-text 求交；
- 所有 pick target 都是 `Object3D`，且 metadata 可回溯 feature；
- `PLOT_PICK` 未被渲染相机启用；
- classification/RTE 特殊对象有清晰的 direct/proxy 判定；
- 资源所有权和 dispose 有自动测试。

## 人工验收清单

- [x] 第一次单击已有文本只选中，不创建；
- [x] 单击后马上看到位置、尺寸、旋转都正确的高亮；
- [x] 选中后可直接拖动；
- [x] 双击或 `F2` 可编辑文本；
- [x] `Escape` 可取消编辑且不会卡住；
- [x] 小棕色圆能稳定选中、拖动；
- [x] 图片点、圆、扇形、箭头、线、面均只有可见形状内可选；
- [x] 重叠对象按最近交点/视觉顺序选择；
- [x] 创建工具不会吞掉已有实体的第一次点击；
- [x] 反复创建、删除、撤销、重做后无幽灵命中；
- [x] 关闭编辑器后无残留代理、DOM 输入框或相机锁。

上述项目由真实 Three camera/geometry 单元用例、DOM pointer Playwright 回归和
registry/dispose 生命周期用例共同验证；高 DPI 与 CSS 缩放的坐标职责由 NDC 单测
覆盖，不以截图像素或自定义二维命中替代射线结果。

## 通过标准

所有静态硬门槛、单元测试、交互集成测试和人工清单已经通过；旧
`FeatureHitTester` 的实体像素命中代码已经删除。当前任何图形均不依赖像素 fallback。
