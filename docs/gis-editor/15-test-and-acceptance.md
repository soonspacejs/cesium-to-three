# 测试与验收

> 状态：**Proposed**。当前仓库已有 `tests/ground-material`，尚无本文定义的 `tests/plot-editor`。
> 前置阅读：[实施路线图](./14-implementation-roadmap.md)。

## 1. 目标

测试体系必须证明编辑器的正确性来自统一数据、输入和事务契约，而不是某个 demo 恰好可操作。验收覆盖纯数据单元测试、DOM 输入集成、真实 WebGL/相机集成、视觉回归、性能/资源稳定、公共包和人工探索。

最关键的回归面是：三元高度丢失、相机与编辑器同时响应、异步 surface 结果乱序、拖拽产生海量 history、日期变更线跳跃、取消后文档被污染、overlay 资源泄漏以及把 terrain/3D Tiles 误当成可编辑模型。

## 2. Current 测试基线

当前项目：

- `vitest.config.ts` 只扫描 `tests/ground-material/unit/**/*.test.ts`；
- `playwright.config.ts` 使用 Chromium、固定 `960x640`、DPR 1、Asia/Shanghai、SwiftShader 和单 worker；
- 已有 Ground material 的 unit、integration、visual、perf、package smoke 测试；
- `package.json` 中 `test:unit`、`test:integration`、`test:visual` 均只覆盖 Ground Material 范围。

编辑器测试应新增独立目录与脚本，并保持现有基线原样可运行。不得通过扩大当前 visual tolerance 或更换渲染 fixture 来掩盖编辑器集成回归。

## 3. 建议测试结构

```text
tests/plot-editor/
├── unit/
│   ├── document/
│   ├── commands/
│   ├── input/
│   ├── state/
│   ├── picking/
│   ├── shapes/
│   └── transform/
├── integration/
│   ├── pointer-keyboard.spec.ts
│   ├── camera-arbitration.spec.ts
│   ├── surface-height.spec.ts
│   ├── history-persistence.spec.ts
│   └── overlay-lifecycle.spec.ts
├── visual/
│   ├── eight-shapes.visual.spec.ts
│   ├── handles-gizmo.visual.spec.ts
│   └── height-reference.visual.spec.ts
├── perf/
│   ├── drag-frame-budget.spec.ts
│   └── resource-stability.spec.ts
├── fixtures/
│   ├── editor.html
│   ├── editor.ts
│   ├── deterministic-surface-provider.ts
│   └── documents/
└── package-smoke/
```

Node 单元测试使用 fake clock 和结构化输入事件，不依赖 WebGL。DOM/Playwright 测试使用真实 PointerEvent、KeyboardEvent、pointer capture、焦点与 renderer；不可只直接调用 reducer 来冒充端到端输入。

## 4. 坐标与高度矩阵

### 4.1 基本 schema

| 编号 | 输入 | 期望 |
| --- | --- | --- |
| COORD-001 | `[120, 30]` legacy | 导入边界立即变为 `[120, 30, 0]` |
| COORD-002 | `[120, 30, 15]` + `NONE` | 原值往返 |
| COORD-003 | `[120, 30, 15]` + 任一 CLAMP | 拒绝或规范为 author height 0，并产生明确 diagnostic；策略固定 |
| COORD-004 | relative height `15` | 文档保留 15，渲染 world height = surface + 15 |
| COORD-005 | NaN/Infinity/纬度越界 | 原子拒绝，文档 revision 不变 |
| COORD-006 | `-0` height | canonical 输出为 `0` |
| COORD-007 | 异步 surface height 327.5 | 只进入 render projection，export 不出现 327.5 |

### 4.2 七值高度参考

每个 `HeightReference` 至少覆盖 create、draw preview、vertex edit、group transform、serialize、deserialize、undo/redo 和 render projection。CLAMP/RELATIVE 的 ground、terrain、3D Tile 目标分别用可区分的 deterministic provider 高度，防止测试错误地全部走同一 fallback。

### 4.3 地理边界

- 日期变更线：`179.9 -> -179.9` 的线、面、框选、整体平移和旋转；
- 极区：纬度 `89.9` 和 `-89.9` 的 ENU frame、X/Y constraint 与 selection bounds；
- 经度环绕：输入 `181`/`-181` 的规范化策略和导出一致性；
- 大跨度：跨半球 line/polygon 不得强行使用单一不适用的局部平面；
- 退化：重复点、近零边、共线 polygon、自交、多边形闭合重复点；
- 精度：厘米级 ENU 微调叠加后没有可见的大坐标抖动或经纬度灾难性消减。

## 5. 八类图形契约矩阵

| 图形 | 最小提交 | 必测控制/参数 | 退化与失败 |
| --- | --- | --- | --- |
| point | 1 锚点 | move、style、image/普通点 | 无命中、图片失败 |
| line | 2 顶点 | vertex、midpoint insert、端箭头 | 重复点、删至 1 点 |
| polygon | 3 顶点 | vertex、每边 midpoint、整体移动 | 共线、自交策略、删至 2 点 |
| rectangle | 2 个构造点或目标契约定义的控制集 | 角点、边中点、rotation | 零宽/零高、日期线 |
| sector | center + radius/start/end | radius、startAngle、endAngle、rotation | 零半径、0/360 角跨越 |
| arrow | 各 arrow subtype 的最小控制点 | 控制点、sizeScale、生成 footprint | 生成失败、控制点不足 |
| text | 1 锚点 + content 契约 | anchor、rotation、F2 文本编辑 | 空文本策略、纹理重建失败 |
| circle | center + radius | center、radius、整体 move | 零/负/非有限半径 |

每类至少有一条纯键盘完成路径和一条鼠标完成路径。箭头测试只验证 GIS 控制点及生成 footprint，不出现 glTF/mesh/node/bone 编辑断言。

## 6. Pointer 与相机仲裁

### 6.1 必测事件序列

```text
pointerdown -> move(低于阈值) -> pointerup       click/select/add point
pointerdown -> setPointerCapture -> moves -> up  one drag transaction
pointerdown -> moves -> pointercancel            rollback + release lease
pointerdown -> lostpointercapture                 rollback/recover by policy
pointerdown -> window blur                        clear held/capture + controls restored
pointerdown -> dispose                            no late listener, controls restored
Space down -> pointer drag -> Space up            camera only
```

验收应同时观测 editor document、state machine、pointer capture owner 和 camera pose。只断言“图形移动了”不足以发现相机也偷偷移动。

### 6.2 按键/按键组合与指针

- 左键在 handle/gizmo/shape/empty surface 四类命中上的路由；
- 右键/中键保持宿主 camera 契约，除非 keymap 明确绑定；
- Shift/Ctrl/Meta/Alt 的选择语义和 AltGraph 放行；
- wheel 在编辑模式下的归属，不能同时改变参数和相机 zoom；
- capture phase 已消费事件后 GlobeControls 不收到同一手势；
- navigation lease 可嵌套、重复 release 无害、异常/cancel 后计数归零。

## 7. 键盘、焦点与 IME

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| KEY-001 | editor root 聚焦，Enter | 提交可提交草稿；不可提交时无文档变化并给 validation |
| KEY-002 | Escape | 当前 working transaction 回滚；无事务时按状态机规则清选择/退出工具 |
| KEY-003 | Backspace drawing | 删除最后草稿点，不触发浏览器后退 |
| KEY-004 | Delete selection/active vertex | 按上下文删除，保持最小拓扑 |
| KEY-005 | Primary+Z / Shift+Primary+Z / Primary+Y | undo/redo，平台映射正确 |
| KEY-006 | Primary+A / Primary+S | 全选 / save request，均只在焦点域生效 |
| KEY-007 | G/R/S 后 X/Y/Z | 模态与轴约束正确；CLAMP 拒绝 Up/pitch/roll |
| KEY-008 | Arrow / PageUp / PageDown | ENU 微调；Shift x10，Alt x0.1 |
| KEY-009 | held arrow key | 首次 down 到最后 keyup 只有一个 history entry |
| KEY-010 | `event.repeat` 的一次性命令 | 只执行一次 |
| KEY-011 | textarea/contenteditable | 普通输入完全放行；F2 进入文本编辑后 Enter 换行 |
| KEY-012 | text edit Primary+Enter | 提交文本 transaction |
| KEY-013 | `isComposing` 或 compositionstart/end | 编辑器快捷键不执行，不破坏 IME |
| KEY-014 | AltGraph | 不误识别为 Ctrl+Alt 快捷键 |
| KEY-015 | blur/visibility hidden/dispose | held keys 清空、transaction 按策略回滚、controls 恢复 |

在 Windows/Linux 验证 `Primary=Ctrl`，macOS 项目验证 `Primary=Meta`。Playwright 无法可靠覆盖的平台组合应有纯函数 key normalization 单测和目标平台 CI/人工验收。

## 8. 状态机与事务

使用 model-based tests 生成合法/非法 intent 序列，并在每一步检查不变量：

- 稳定态最多一个 active transaction；
- drawing 与 transforming 不同时存在；
- pointer owner/capture、keyboard held transaction 与 camera lease 有一致 owner；
- commit 后 working copy 清空且 document revision 恰好 +1；
- cancel 后 snapshot 与开始前深相等；
- 文档删除/替换选中目标时 selection 与 handles 在同一个 flush 中 reconciliation；
- dispose 是终止态，之后迟到 intent 不改变任何状态。

随机测试应记录 seed，失败可重放。状态覆盖报告至少包含每条 transition、guard 的 true/false 分支和 blur/cancel/dispose 异常出口。

## 9. History 与持久化

### 9.1 History

- add/remove/patch/vertex insert/remove/single transform/group transform 的 apply/revert 对称；
- 新命令清空 redo；空命令不清 redo；
- 200 条/32 MiB（或最终配置）的边界和淘汰顺序；
- 大图形拖拽只增加一个条目，估算内存不随 pointermove 数线性增长；
- undo 恢复 feature order、稳定 id、geometry、style、properties、heightReference；
- selection 恢复策略固定，但 selection 本身不持久化。

### 9.2 Codec/import

- v1 snapshot 确定性 round trip；
- legacy 二元迁移及 diagnostics；
- unknown future version 拒绝，不按 v1 猜测；
- merge 的 reject/replace/regenerate 三种 id 冲突策略；
- JSON pointer 精确定位非法字段；
- 原型污染键、过深嵌套、超长文本、过多 feature/vertex 被限制；
- NaN/Infinity 即便从 JS object 直接 import 也被拒绝；
- save 请求乱序完成的 revision 标记正确。

## 10. Surface 与异步竞态

deterministic provider 可手动控制 Promise 完成顺序：

1. 发起 A（旧 camera/revision）；
2. 编辑顶点并发起 B；
3. B 先完成并投影；
4. A 后完成；
5. 断言 A 被 generation/revision 拒绝，文档和 render projection 不回退。

还应覆盖 AbortSignal、provider throw/reject、tiles unload/reload、terrain-only/tiles-only/BOTH、ellipsoid fallback、无命中天空、sample pending 时 commit 策略和 editor dispose 后完成的 callback。

## 11. 渲染与视觉回归

### 11.1 固定场景

视觉 fixture 固定相机矩阵、viewport、DPR、字体、surface depth、时间和图形 id。分别截图：

- 八类 committed 默认样式；
- 每类 drawing draft 的合法/非法状态；
- 单选 vertex handles、midpoints、circle/sector controls；
- 多选 ENU Gizmo 的 X/Y/Z 启用态与贴地禁用态；
- hover、active drag、box selection；
- NONE/CLAMP/RELATIVE 的遮挡与 surface pending；
- 日期变更线与高纬视图。

不要用一张过密合成图替代所有断言。颜色容差、抗锯齿差异和字体差异必须按 fixture 记录理由，不修改全局 Ground baseline。

### 11.2 Canvas 像素与对象断言

截图以外同时检查 canvas 非空像素、目标区域 alpha/颜色范围、scene 中 overlay root 数量和 GPU resource counters，避免“截图恰好有底图但编辑 Overlay 根本没画”的假阳性。

## 12. 性能与资源稳定

建议门槛在固定 SwiftShader fixture 和一台记录硬件基线分别测量，CI 首先检查趋势与硬上限：

| 指标 | 场景 | 建议验收 |
| --- | --- | --- |
| intent 合并 | 1000 次 pointermove/一次 drag | history +1；每 animation frame 每 feature 最多一次 sync |
| 文档 patch | 10k 顶点 line 移动单点 | 不复制无关 feature；无 O(document) JSON stringify |
| picking | 1000 feature + handles | 使用空间索引/分层；交互帧无持续长任务 |
| GPU 资源 | 100 次创建/编辑/删除/undo/redo | dispose/GC 后回到稳定基线，不随轮次单调增长 |
| listener | mount/dispose 100 次 | canvas/window/document listener 数回基线 |
| surface request | 快速拖拽 1000 move | 有界并发，旧 generation 可取消/丢弃 |
| idle | editor 无操作 | 不启动独立永久 RAF，不持续 redraw |

性能测试输出环境、浏览器、DPR、feature/vertex 数和分位数。单次平均值不能作为唯一判断；至少报告 p50/p95/max 或 frame budget 超限数量。

## 13. 公共包与类型测试

- 从 `cesium-to-three/plot-editor` 导入 `createPlotEditor`、公共类型和 error code；
- ESM 运行时 import 与 TypeScript declaration import 均成功；
- package `files` 包含实现和声明，不依赖 `src/`；
- 公共 `.d.ts` 不引用 demo 私有类型、DOM 实现类或未导出的路径；
- tree-shake/import 模块时不访问 `window`/`document`，只有 create 时安装监听；
- Node 环境仅 import codec/document 类型不报错；
- 原有根、`./ground`、`./arrow` package smoke tests 保持通过。

## 14. 可访问性与输入可用性

本项目是画布编辑器，仍需验证：

- editor root 可聚焦且焦点轮廓可识别；
- 工具栏命令有可访问名称，图标按钮有 tooltip/aria-label；
- 键盘可完成选择、创建、取消、删除、微调、undo/redo 和保存请求；
- 状态变化通过非侵入式 live region 或宿主事件可获知，不把说明性教程文字堆在画布上；
- 高对比模式下 selection/handle 不能只依靠单一颜色区分；
- 浏览器缩放与 DPR 变化后手柄命中区域和视觉尺寸一致；
- 文本输入支持 IME、换行和 composition，不劫持系统编辑快捷键。

## 15. 自动化命令建议

实现阶段新增脚本，名称可调整但职责分开：

```json
{
  "scripts": {
    "test:editor-unit": "vitest run --config vitest.editor.config.ts",
    "test:editor-integration": "playwright test tests/plot-editor/integration",
    "test:editor-visual": "playwright test tests/plot-editor/visual",
    "test:editor-perf": "playwright test tests/plot-editor/perf",
    "test:editor-package": "npm run build:lib && tsc -p tests/plot-editor/package-smoke/tsconfig.json"
  }
}
```

PR 必跑 type-check、editor unit、关键 integration、原 Ground unit/package；合并队列或 nightly 跑完整 visual/perf 和跨浏览器/平台矩阵。基线更新必须单独审查截图差异，不能在功能提交中无说明地重录。

## 16. 人工探索清单

自动化通过后，在真实 terrain + 3D Tiles 数据源上完成：

1. 连续创建八类图形，混用鼠标和键盘提交/取消；
2. 拖动顶点越过 tiles LOD 边界，检查图形不跳回旧 sample；
3. 用 Space 临时导航，再继续同一绘制会话；
4. 多选执行 G/R/S 和 X/Y/Z 约束，验证贴地禁用轴；
5. 输入中文文本，Enter 换行，Primary+Enter 提交；
6. 切后台、窗口失焦、拔出指针/触控取消，确认相机恢复；
7. 保存、刷新、加载、undo/redo，核对三元坐标与高度参考；
8. 断网/tiles 卸载后继续选择和取消，恢复网络后重新贴附；
9. 在日期变更线和高纬 fixture 编辑；
10. 完成后 dispose/remount，确认没有重复监听或相机失控。

## 17. 发布阻断条件

以下任一出现均不得发布：

- 文档或导出数据出现二元 position；
- CLAMP 的 surface sample 写回 author height；
- 指针编辑与相机在同一手势中同时生效；
- Escape/pointercancel/blur/dispose 任一路径未恢复 camera lease；
- 一次拖拽或 held key 产生多条 history；
- undo/redo 改变 feature id、order 或 heightReference；
- 日期变更线变换产生跨全球跳跃；
- terrain/3D Tiles 或 glTF mesh 出现编辑控制点；
- 异步旧 sample 覆盖新 revision；
- GPU 资源或 DOM listener 随 mount/edit/dispose 轮次单调增长；
- 新子路径包导入失败或原 Ground 测试回归。

## 18. 最终验收追踪

| 设计主题 | 主验收证据 |
| --- | --- |
| Cesium 边界与非模型范围 | source reference review + 无模型编辑 API/package symbols |
| 三元坐标/高度 | COORD 矩阵 + codec round trip + surface projection test |
| 鼠标/相机 | Pointer 真实事件序列 + camera pose/lease 断言 |
| 键盘 | KEY-001..015 + 平台 key normalization |
| 状态机 | model-based transition/guard coverage |
| 八类绘制/控制点 | shape matrix unit + Playwright + visual |
| 选择/Gizmo | 单选/多选/ENU/贴地禁用轴集成测试 |
| 渲染 Overlay | canvas pixel + screenshot + scene/resource counters |
| 历史/持久化 | apply/revert symmetry + atomic import +乱序 save |
| 生命周期 | cancel/blur/visibility/dispose + 100 轮稳定性 |

## 19. 关联文档

- 事实基线：[当前项目审计](./02-current-project-audit.md)
- 坐标专项：[坐标与高度 Schema](./04-coordinate-height-schema.md)
- 输入专项：[鼠标输入与相机仲裁](./05-pointer-input-and-camera.md)、[键盘命令与键位](./06-keyboard-command-keymap.md)
- 状态专项：[编辑状态机](./07-editor-state-machine.md)
- 图形专项：[八类图形绘制契约](./09-shape-drawing-contracts.md)、[控制点与拓扑编辑](./10-shape-editing-handles.md)
- 生命周期和持久化：[渲染集成](./12-rendering-overlay-integration.md)、[公共 API、历史与持久化](./13-public-api-history-persistence.md)
