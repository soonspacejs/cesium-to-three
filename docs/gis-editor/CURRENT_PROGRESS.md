# GIS Plot Editor 当前实现进度与续接说明

> 更新时间：2026-08-06  
> 工作目录：`D:\my\code\cesium-to-three`  
> 当前分支：`edit-shape`  
> 原始目标：严格按照 `docs/gis-editor` 的设计文档完整实现 GIS Plot Editor，不做简化版；小步提交；中文注释；UTF-8，禁止乱码。

## 1. 新会话开始时必须遵守

1. 先完整阅读本文件，再阅读 `docs/gis-editor/README.md`、`14-implementation-roadmap.md` 和 `15-test-and-acceptance.md`。
2. 不要重置、覆盖或丢弃现有工作区改动；当前有尚未提交的演示页迁移和测试改动。
3. 所有手工文件修改继续使用 `apply_patch`，保存为 UTF-8，并写清晰的中文注释。
4. 每完成一个独立、可验证的小改动就提交一次，延续现有提交风格。
5. 在设计文档的 DoD 全部有实现和验证证据之前，不要宣布整体完成。
6. 用户没有要求创建子代理，继续在当前代理内完成工作。

## 2. 当前 Git 状态

```text
branch: edit-shape

 D src/demo/draw-tool.ts
 M src/demo/plot-demo.ts
 M tests/plot-editor/PlotEditor.test.ts
 M vite.lib.config.js
?? vite-plot-editor.err.log
?? vite-plot-editor.log
```

这些改动均有明确用途：

- `src/demo/draw-tool.ts`：旧的 demo 私有绘制工具，已经删除；新 demo 改用公开 Plot Editor API。
- `src/demo/plot-demo.ts`：已迁移为完整编辑器演示，但仍包含临时投影调试代码，修复投影问题后才能提交。
- `tests/plot-editor/PlotEditor.test.ts`：新增了通过 DOM pointer 选择 ECEF 实体的回归测试，尚未提交。
- `vite.lib.config.js`：执行库构建后生成/同步的配置镜像，包含 `plot-editor` 入口，尚未提交。
- `vite-plot-editor.log`、`vite-plot-editor.err.log`：本地 Vite 调试日志，不应提交；确认服务不再需要后删除。

严禁执行 `git reset --hard` 或 `git checkout --` 清理上述内容。

## 3. 已完成的总体阶段

实现路线图中的 Stage 1–8 已完成，Stage 9 的 facade/公开 API 已基本完成，Stage 10 的兼容、demo、包发布和最终验收正在进行。

### 3.1 文档模型、命令与历史

- Plot 文档模型、八类图形 schema、规范化与严格校验已经实现。
- 命令执行、patch、undo/redo、revision 约束、事务合并已实现。
- metadata 在历史操作中的保真问题已修复。
- 原子导入、保存协调和 revision-safe 异步保存已实现。
- 强类型编辑器事件已经接入。

### 3.2 输入系统与状态机

- `KeyboardInput`、`PointerInput`、`CommandRouter` 和统一状态机已接入 `PlotEditor` facade。
- 已实现 pointer claim、导航租约、绘制、点选、hover、框选、shape 编辑、实体/ENU gizmo 变换等主流程。
- G/R/S、方向键 nudge、撤销/重做、保存、删除、选择等命令已编排。
- 状态机支持从已激活的 G/R/S 事务继续进入 gizmo pointer drag，并复用同一事务。

### 3.3 绘制、选择、编辑和 overlay

- 八类图形：point、line、polygon、rectangle、circle、sector、arrow、text 的核心绘制契约已实现。
- raw draft、hover、框选、marker、shape handle、selection/gizmo overlay 已统一渲染。
- overlay 层级和固定 root 已完成，marker 热更新避免无谓重建。
- `CameraProjectionSnapshot` 已实现：一次手势捕获稳定的相机矩阵与 CSS viewport，用于点选/框选。
- surface pick、height resolve 与可变高度 RTE primitive 已接入。

### 3.4 原生文本编辑

- `TextEditController` 使用原生 `textarea`，支持中文 IME composition。
- 普通 Enter 插入换行，Primary+Enter 提交，Escape 取消，blur 提交。
- 编辑期间使用 transient preview，最终只生成一条 history patch。
- F2 文本编辑已经集成到 `PlotEditor` facade。

### 3.5 公开 facade 与包入口

- `src/lib/plot-editor/PlotEditor.ts` 已成为完整 facade，统一持有 document、executor、history、selection、drawing、shape、transform、text、overlay、import、save、height 等控制器。
- facade 默认安装键盘/指针输入；宿主只需在自己的 RAF 中调用 `editor.update()`，编辑器不会创建第二个 RAF。
- 已新增稳定公开入口 `src/lib/plot-editor/index.ts`。
- `package.json` 已导出 `./plot-editor`。
- `vite.lib.config.ts`、`tsconfig.lib.json` 和 package smoke 已覆盖该入口。

## 4. 最近关键提交

```text
a4dd570 feat: publish plot editor package entry
52f250f feat: integrate native text editing into facade
94d55a0 feat: add native IME text edit transactions
f7568e9 feat: orchestrate plot editor input state machine
34993a8 feat: capture stable editor projection snapshots
0575dac feat: add plot editor public facade core
77a5c4d feat: coordinate revision-safe async saves
9d23bd8 feat: hit test overlay markers in CSS space
a828f35 feat: dispatch typed plot editor events
b58fffc feat: import plot documents atomically
dcb2c24 fix: preserve document metadata through history
16a9a35 feat: add strict plot document codec
d70d4f9 feat: integrate box selection feedback overlay
2589c59 feat: render CSS box-selection feedback
342a8fe feat: render transient plot hover feedback
4a2ef08 feat: integrate raw drafts into editor overlays
89add9d feat: render raw drawing draft previews
c9a1126 perf: hot update editor marker state
30b038c feat: coordinate fixed editor overlay roots
679804e feat: isolate editor overlay render layers
```

以上提交之前的 Stage 1–6 也已有大量小步提交；用 `git log --oneline` 查看完整历史。

## 5. 已通过的验证

在最近一轮实现中，下列命令已经通过；完成剩余修复后必须重新运行，不能只依赖旧结果。

```powershell
npm run type-check
npm run build
npm run build:lib
npm run test:package-types
npm run test:package-import
```

当前重点测试覆盖包括：

- `tests/plot-editor/PlotEditor.test.ts`：facade 命令/history/events、工具切换、DOM pointer 绘点、ECEF 实体选择、F2 中文文本、dispose。
- `CameraProjectionSnapshot`：3 个测试。
- `TextEditController`：3 个测试。
- 编辑器状态机：15 个测试。
- `VariableHeightRtePrimitive`：跨日期变更线 polygon、虚线和箭头、uniform 更新、dispose。

此前使用浏览器实际验证过：

- demo 首屏能加载八类示例和编辑器面板。
- point 工具能通过左键点击加点、右键提交，文档从 revision 0 变为 1，feature 从 8 变为 9。
- Ctrl+Z 能恢复为 8 个 feature，undo/redo 计数正确。
- 初始八类示例直接作为 document baseline 注入，不污染历史栈。
- 浏览器无业务异常；仅有既存 Three.js deprecation/shader warning。

## 6. 当前最重要的阻塞：CPU 投影与 RTE GPU 渲染不一致

### 6.1 现象

demo 中 GPU 实际绘制的图形位于屏幕中央附近，但 `CameraProjectionSnapshot.project()` 对同一图形锚点给出的坐标远在屏幕外，导致肉眼可见图形无法被点选。

一次临时调试结果示例：

```text
point   x=-4890, y=-2405
polygon x=2791,  y=52
text    x=7091,  y=-3326
```

同一帧截图中图形大致实际位于：

```text
point   (441, 261)
polygon (780, 290)
text    (870, 228)
```

浏览器点击可见 polygon 后 selection 仍为“无”。这不是可忽略的 demo 问题，而是选择系统和渲染坐标系不一致的核心缺陷。

### 6.2 已确认的代码位置

- CPU 投影：`src/lib/plot-editor/selection/CameraProjectionSnapshot.ts`
- 可变高度 RTE：`src/lib/plot-editor/render/VariableHeightRtePrimitive.ts`
- demo 相机/场景：`src/demo/plot-demo.ts`
- 相似 RTE 实现：
  - `src/lib/plot/PlainPlotPrimitive.ts`
  - `src/lib/ground/classification.ts`
  - `src/lib/ground/primitives.ts`

`VariableHeightRtePrimitive.ts` 当前每帧逻辑为：

```ts
camera.updateMatrixWorld();
camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
encodeCesiumVector3( camera.position, cameraHigh, cameraLow );
viewRotation.copy( camera.matrixWorldInverse );
viewRotation.elements[ 12 ] = 0;
viewRotation.elements[ 13 ] = 0;
viewRotation.elements[ 14 ] = 0;
viewProjection.multiplyMatrices( camera.projectionMatrix, viewRotation );
```

最初怀疑 `camera.position` 是局部坐标而非世界坐标；但 demo 代码中没有显式 reparent camera，因此不能未经验证就直接改。下一步应打印并比较：

- `camera.parent?.type`
- `camera.position`
- `camera.getWorldPosition(...)`
- `camera.matrixWorld` 的平移分量
- 同一 feature 的 document position、RenderProjection vertex、ECEF 和最终 clip/NDC

还需比较 `CameraProjectionSnapshot` 的完整 `projection * matrixWorldInverse` 与 RTE shader 的“先减 camera，再乘纯旋转”的数学结果，定位到底是哪一路使用了错误坐标或高度。

### 6.3 demo 中必须删除的临时代码

`src/demo/plot-demo.ts` 当前临时导入了：

```ts
createCameraProjectionSnapshot
```

并在 `installEditorPanel` 后有一个 `window.setTimeout(... console.info('PLOT_EDITOR_PROJECTION_DEBUG' ...))`。修复完成后必须删除该 import 和整个临时 debug block，不能提交调试输出。

### 6.4 修复后的回归要求

1. 给根因补一个稳定单元测试；若根因与 parented camera 有关，测试必须覆盖 camera 位于父节点下时的世界位置。
2. 浏览器中肉眼可见的 point、polygon、text 至少各点选一次，selection 状态必须正确。
3. 继续验证绘制、undo/redo、G/R/S、shape handle 和文本 F2。
4. CPU 投影、GPU 渲染、overlay marker 三条路径必须落在同一 CSS 像素位置。

## 7. 未提交 demo 的当前设计

`src/demo/plot-demo.ts` 已经基本替换完成，重要内容如下：

- 只从公开的 `../lib/plot-editor` 入口消费编辑器 API。
- 不再使用 demo 私有 pointer listener，也不直接修改 `GroundDecalManager`。
- 使用 `EditorSurfacePicker` + Raycaster 提供 terrain/ellipsoid surface hit。
- 使用 `GlobeControlsNavigationAdapter` 协调编辑与相机导航。
- 首屏提供 point、line、polygon、rectangle、circle、sector、arrow、text 八类 feature。
- 初始文档 revision 0、history 0，不通过八次 `execute` 伪造初始化。
- 面板提供 select + 八种绘制工具、快捷键说明和状态反馈。
- 宿主 RAF 内调用 `editor.update()`。
- 订阅公开事件更新可见状态。
- 暴露 `window.__plotDemo` 仅供 demo 调试/验收。

当前为了观察图形，暂时设置：

```ts
const DEMO_POSITION_SCALE = 4;
camera.position.copy( target ).addScaledVector( up, 45 );
```

这两个值是在投影不一致尚未修复时调整的。修复 RTE/投影根因后，建议先恢复到更合理的：

```ts
const DEMO_POSITION_SCALE = 1;
camera.position.copy( target ).addScaledVector( up, 180 );
```

然后以浏览器真实截图和点击命中结果微调，不能只追求“看起来大”。

## 8. 建议的紧接执行顺序

### 步骤 A：修复投影/RTE 根因并独立提交

1. 重新启动本地 demo：

   ```powershell
   npm run dev -- --host 127.0.0.1 --port 5180
   ```

2. 打开：`http://127.0.0.1:5180/?demo=plot&noterrain`
3. 比较相机 local/world、RenderProjection vertex、CPU clip 与 RTE clip。
4. 修复根因并补测试。
5. 运行相关测试、type-check。
6. 单独提交，例如：

   ```text
   fix: align plot projection with RTE rendering
   ```

### 步骤 B：完成 demo 迁移并独立提交

1. 删除临时 debug import/block。
2. 重新设定合理相机高度和示例范围。
3. 浏览器验证点选、绘制、undo/redo、文本编辑和变换。
4. 删除两个 Vite 日志文件。
5. 提交 demo 删除、demo 重写和构建配置镜像，例如：

   ```text
   feat: migrate plot demo to public editor API
   ```

### 步骤 C：设计文档逐项审计

对照 `15-test-and-acceptance.md` 和每章末尾的 DoD，建立勾选清单。尤其检查：

- text 绘制完成后如何输入正文；目前 F2 编辑现有文本已实现，但 `activateTool('text')` 默认空正文的完整用户流程仍需确认。
- 空白单击是否应清空 selection；当前空 surface 可能优先归导航控制，需对照交互文档。
- box selection 的包含/相交规则及遮挡策略。
- G/R/S 与 gizmo drag 的一事务一历史记录。
- surface invalidation 后 height manager 的内部 ready/pending 是否正确失效。
- 自定义 keymap 是否应接受 partial 配置并正确合并默认值。
- dispose 后 DOM listener、textarea、overlay、render resources 是否全部释放。
- import/export/migration/public event 的错误路径和 revision 语义。

每发现一个独立缺口，修复、测试、提交一次。

### 步骤 D：全量验收

至少重新运行：

```powershell
npm run test:plot-editor
npm run type-check
npm run build
npm run test:package
```

再根据 `package.json` 现有脚本运行 ground/相关 unit tests 和可用的浏览器/视觉测试。若全量测试中有既存失败，必须记录准确命令、错误和是否与本次改动相关，不能笼统跳过。

## 9. 需要重点关注的文件

```text
docs/gis-editor/README.md
docs/gis-editor/14-implementation-roadmap.md
docs/gis-editor/15-test-and-acceptance.md

src/lib/plot-editor/PlotEditor.ts
src/lib/plot-editor/index.ts
src/lib/plot-editor/selection/CameraProjectionSnapshot.ts
src/lib/plot-editor/render/VariableHeightRtePrimitive.ts
src/lib/plot-editor/editing/TextEditController.ts
src/lib/plot-editor/state/EditorStateMachine.ts
src/lib/plot-editor/input/CommandRouter.ts

src/demo/plot-demo.ts
src/demo/draw-tool.ts

tests/plot-editor/PlotEditor.test.ts
tests/plot-editor/render/VariableHeightRtePrimitive.test.ts
```

## 10. 最终交付标准

只有同时满足以下条件才可宣布完成：

- 设计文档中全部强制契约和 `15-test-and-acceptance.md` 的 DoD 都有对应实现。
- 八类图形在 demo 中可创建、选中、编辑、变换、删除，并可 undo/redo。
- 中文 IME 文本编辑无重复提交、丢字或乱码。
- CPU hit-test、overlay 和 GPU 图形投影一致。
- 相机导航与编辑 pointer claim 无冲突。
- import/export/save/history/revision 语义通过测试。
- 公开包入口能构建、生成声明并由 smoke consumer 导入。
- type-check、相关单测、构建和浏览器验收均通过。
- 工作区只剩明确属于用户的无关改动，没有临时 debug、日志或生成垃圾。
- 每个逻辑改动都有小步 Git 提交，中文注释和文档为 UTF-8。

