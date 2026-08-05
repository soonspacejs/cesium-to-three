# 公共 API、事务历史与持久化

> 状态：**Proposed**。当前 `src/lib/plot` 尚未作为 npm 子路径发布，本文接口均为目标契约。
> 前置阅读：[目标架构](./03-target-architecture.md)、[状态机](./07-editor-state-machine.md)、[渲染集成](./12-rendering-overlay-integration.md)。

## 1. 目标

本篇定义 GIS 编辑器的宿主接入面、文档结构、命令事务、撤销/重做、事件协议、JSON 持久化和旧二维坐标迁移。目标是让业务可以在不访问 Three 图元、DOM 监听器或内部状态机的情况下完成创建、编辑、保存、加载和协作前的版本检查。

API 必须满足四条边界：

1. `PlotDocument` 是唯一持久真相源；
2. `PlotEditor` 管理短生命周期交互会话；
3. `HistoryManager` 记录已提交的可逆文档命令；
4. renderer/picker/controls adapter 是可替换基础设施，不出现在 JSON 中。

## 2. Current：可复用与必须迁移的能力

`GroundDecalManager` 当前提供 `addPlot`、`remove`、`clear`、`getItemDeep`、`setStyle`、`setCenter`、`setCoords`、`setCoord`、`insertCoord`、`removeCoord`、`translateCoords`、`setText`、`getAllIds` 和每帧 `update(frameState)`。这些 API 可作为渲染适配参考，但不能直接充当编辑器文档层：

- id 是模块级自增字符串，跨保存/恢复不能保证稳定；
- `LonLatPoint` 是二元组，且部分方法就地修改内部数组；
- `clampToGround`、`heightMeters`、`classificationType` 不能完整表达七值 `heightReference`；
- 没有 document revision、原子批处理、命令历史、草稿、选择或错误事件；
- `_markDirty()` 的 RAF 合并是渲染优化，不等于用户语义事务。

目标实现可在内部继续调用其桥接器，但公共编辑 API 不复刻这些可变限制。

## 3. 公共模块边界

首次正式发布建议新增独立子路径 `cesium-to-three/plot-editor`，根入口是否 re-export 由发布阶段决定。建议目录：

```text
src/lib/plot-editor/
├── index.ts                 仅公共导出
├── document/               schema、验证、不可变 patch、迁移
├── commands/               命令、事务、history
├── input/                  pointer、keyboard、command router
├── state/                  editor state machine、selection
├── picking/                surface 与 overlay picking
├── transform/              ENU 操作
├── render/                 committed/draft/handle/gizmo adapter
└── persistence/            codec 与可选 adapter
```

公共类型不得导出内部 reducer state、Three `Object3D` 子类、GPU material 或 mutable Map。

## 4. 文档结构

```ts
type PlotFeatureId = string;
type Position3D = readonly [longitude: number, latitude: number, height: number];

interface PlotFeatureBase<T extends PlotFeatureType, G, S = PlotStyle> {
  readonly id: PlotFeatureId;
  readonly type: T;
  readonly geometry: Readonly<G>;
  readonly style: Readonly<S>;
  readonly heightReference: HeightReference;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly revision: number;
}

interface PlotDocumentSnapshot {
  readonly schema: 'cesium-to-three/plot-document';
  readonly version: 1;
  readonly documentId: string;
  readonly revision: number;
  readonly features: readonly PlotFeature[];
  readonly order: readonly PlotFeatureId[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
```

具体 geometry 由[八类图形绘制契约](./09-shape-drawing-contracts.md)定义。所有 position 在进入文档前完成校验、经度规范化策略记录和三元化；CLAMP 模式的 height 强制为 `0`。`properties` 必须是 JSON 值，不接受函数、DOM、Texture、Map、循环引用或类实例。

### 4.1 文档服务

```ts
interface PlotDocument {
  readonly id: string;
  readonly revision: number;

  get(id: PlotFeatureId): Readonly<PlotFeature> | undefined;
  getAll(): readonly Readonly<PlotFeature>[];
  has(id: PlotFeatureId): boolean;
  snapshot(): PlotDocumentSnapshot;
  subscribe(listener: PlotDocumentListener): () => void;
}
```

文档写操作仅由 `CommandExecutor` 执行。公共只读返回值不得泄漏可变数组；实现可以结构共享，但调用方观察到的旧 snapshot 必须保持不变。

## 5. PlotEditor 宿主 API

```ts
interface PlotEditorOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  document?: PlotDocumentSnapshot;
  renderHost: EditorRenderHost;
  surfaceProvider: SurfaceProvider;
  cameraController: CameraControlAdapter;
  keymap?: Partial<EditorKeymap>;
  idGenerator?: () => string;
  requestSave?: (snapshot: PlotDocumentSnapshot) => void | Promise<void>;
}

interface PlotEditor {
  readonly document: PlotDocument;
  readonly selection: ReadonlySet<PlotFeatureId>;
  readonly mode: EditorMode;
  readonly canUndo: boolean;
  readonly canRedo: boolean;

  activateTool(tool: DrawTool | 'select'): void;
  execute(command: EditorCommand): CommandResult;
  undo(): CommandResult;
  redo(): CommandResult;
  select(ids: Iterable<PlotFeatureId>, mode?: SelectionMode): void;
  clearSelection(): void;
  focus(): void;
  blur(): void;
  export(options?: ExportOptions): PlotDocumentSnapshot;
  import(input: unknown, options?: ImportOptions): ImportResult;
  addEventListener<K extends keyof PlotEditorEventMap>(
    type: K,
    listener: (event: PlotEditorEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof PlotEditorEventMap>(
    type: K,
    listener: (event: PlotEditorEventMap[K]) => void,
  ): void;
  dispose(): void;
}

function createPlotEditor(options: PlotEditorOptions): PlotEditor;
```

构造不得自动抢占页面全局键盘焦点；只有 `root` 聚焦或持有 pointer capture 时命令生效。`dispose()` 幂等，且必须取消输入监听、恢复相机 lease、清空 held keys、取消异步拾取并释放自有渲染资源。

## 6. 命令与结果协议

编辑器 intent 与可持久命令分开。`PointerMove`、`HoverChanged`、`AxisConstraintChanged` 是 intent，不进入 history；只有改变 document 的提交动作形成命令。

```ts
type EditorCommand =
  | { type: 'feature.add'; feature: PlotFeature }
  | { type: 'feature.remove'; ids: readonly PlotFeatureId[] }
  | { type: 'feature.patch'; id: PlotFeatureId; beforeRevision: number; patch: PlotPatch }
  | { type: 'feature.transform'; ids: readonly PlotFeatureId[]; transform: EnuTransform }
  | { type: 'vertex.insert'; id: PlotFeatureId; after: VertexId; position: Position3D }
  | { type: 'vertex.remove'; id: PlotFeatureId; vertex: VertexId }
  | { type: 'document.replace'; snapshot: PlotDocumentSnapshot };

interface CommandResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly revision: number;
  readonly error?: EditorError;
}
```

每个命令在执行前完成全部验证；验证失败不得留下半个 patch。批量删除/变换必须全成或全败。`beforeRevision` 用于检测宿主在交互过程中替换了目标，冲突时取消 working copy 并返回 `REVISION_CONFLICT`，不可覆盖新数据。

## 7. 事务历史

### 7.1 事务边界

```ts
interface HistoryManager {
  begin(label: string, mergeKey?: string): HistoryTransaction;
  commit(transaction: HistoryTransaction): CommandResult;
  rollback(transaction: HistoryTransaction): void;
  undo(): CommandResult;
  redo(): CommandResult;
  clear(): void;
}
```

事务保存“提交前快照/逆命令 + 最终命令”，不保存每帧草稿。锁定合并规则：

| 用户动作 | history 条目 |
| --- | --- |
| 绘制期间连续加点 | 0；只存在 draft |
| `Enter` 完成一幅图 | 1 条 `feature.add` |
| 一次 pointer drag | pointerdown 开事务，所有 move 更新 working copy，pointerup 提交 1 条 |
| 按住方向键微调 | 首个有效 keydown 开事务，tick/repeat 更新 working copy，最后相关 keyup 提交 1 条 |
| 属性面板连续输入 | focus/input 开工作副本，blur/Enter 或 debounce 边界提交 1 条；明确取消则回滚 |
| 删除多个选择 | 1 条批量 remove，保留原顺序用于 undo |

`Escape` 回滚当前 transaction，不增加 history；空事务不入栈。新命令提交后清空 redo 栈。undo/redo 执行期间不再次记录自身，但仍发出 document change 和 selection reconciliation。

### 7.2 合并键与上限

自动合并仅在以下条件同时满足时发生：相同 `mergeKey`、相同 feature/vertex 集合、没有插入其他已提交命令、事务未显式关闭。时间窗口只能作为属性面板输入的辅助，不能把两次独立鼠标拖拽仅因间隔短而合并。

历史默认限制建议同时使用条目数和估算字节数，例如 200 条或 32 MiB，先到者触发淘汰。淘汰最旧 undo 不影响当前文档；大图形应保存结构共享 patch，避免每个拖拽复制完整文档。

## 8. 事件协议

```ts
interface PlotEditorEventMap {
  documentchange: EditorDocumentChangeEvent;
  selectionchange: EditorSelectionChangeEvent;
  modechange: EditorModeChangeEvent;
  historystatechange: EditorHistoryStateEvent;
  saverequest: EditorSaveRequestEvent;
  validationerror: EditorValidationErrorEvent;
  surfacechange: EditorSurfaceChangeEvent;
  rendererror: EditorRenderErrorEvent;
}
```

- `documentchange` 在原子命令完成后同步发出一次，包含 revision、命令摘要和受影响 id，不暴露 mutable internals；
- `selectionchange` 不增加 document revision，也不进入 history；
- `saverequest` 由 `Primary+S` 或 API 触发，编辑器本身不决定网络/磁盘位置；
- 监听器抛错不得回滚已完成命令，也不得阻止其他监听器；实现应异步报告 listener error；
- 禁止在一次 dispatch 中重入写操作。重入命令排到当前 dispatch 结束后，或返回明确错误，策略必须固定并测试。

## 9. JSON 编解码

### 9.1 Canonical JSON 示例

```json
{
  "schema": "cesium-to-three/plot-document",
  "version": 1,
  "documentId": "01J...",
  "revision": 12,
  "features": [
    {
      "id": "01J...A",
      "type": "line",
      "heightReference": "CLAMP_TO_TERRAIN",
      "geometry": {
        "positions": [[116.391, 39.907, 0], [116.392, 39.908, 0]]
      },
      "style": { "strokeColor": "#ffcc00", "strokeWidth": 4 },
      "properties": {},
      "revision": 3
    }
  ],
  "order": ["01J...A"]
}
```

导出必须是确定性的：feature 顺序由 `order` 决定；对象字段采用 codec 固定顺序；`NaN`、`Infinity`、`-Infinity`、`undefined` 和负零进入文档前即拒绝/规范化。默认输出经纬度和高度 number，不在每次保存中做小数截断；展示精度不等于存储精度。

### 9.2 原子导入

```ts
interface ImportOptions {
  mode?: 'replace' | 'merge';
  onIdConflict?: 'reject' | 'replace' | 'regenerate';
  recordHistory?: boolean;
}
```

导入流程固定为 parse -> schema/version 判断 -> 深度限制 -> 全量规范化 -> 全量交叉验证 -> 构建候选 snapshot -> 一次原子替换。任一 feature 失败时默认拒绝整批，并返回包含 JSON pointer、错误码和实际值摘要的 diagnostics。不得边解析边修改现有文档。

`merge + regenerate` 必须返回 old id 到 new id 的映射；引用 feature id 的业务 properties 不做猜测性替换，除非未来定义了有 schema 的关系字段。

## 10. 二维旧数据迁移

兼容输入可以接收旧 `points: [[lon, lat], ...]`，但迁移只发生在 codec 边界：

```text
[lon, lat]
  -> validate finite/range
  -> [lon, lat, 0]
  -> infer explicit heightReference from legacy fields
  -> validate shape contract
  -> canonical feature
```

推荐映射：

| 旧字段 | 新字段 |
| --- | --- |
| `clampToGround !== false` + terrain classification | `CLAMP_TO_TERRAIN`，所有 height = 0 |
| `clampToGround !== false` + 3D Tiles classification | `CLAMP_TO_3D_TILE`，所有 height = 0 |
| `clampToGround !== false` + BOTH/缺省 | `CLAMP_TO_GROUND`，所有 height = 0 |
| `clampToGround === false` + `heightMeters` | `NONE`，每个二维点扩展为该 height；缺省为 0 |

旧分类枚举不能无损表达相对高度，迁移器不得猜成 `RELATIVE_*`。迁移结果应附 diagnostics，说明采用了哪个默认值。迁移完成后内存中不得继续保留二元 position。

## 11. 可选持久化 Adapter

核心包只规定接口，不内置 LocalStorage、IndexedDB 或后端协议：

```ts
interface PlotDocumentStore {
  load(signal?: AbortSignal): Promise<unknown | null>;
  save(snapshot: PlotDocumentSnapshot, signal?: AbortSignal): Promise<void>;
}
```

保存由宿主调用或响应 `saverequest`。建议使用文档 revision 做 optimistic concurrency；后端返回冲突时保留本地未保存文档并交给业务解决，编辑器不得静默覆盖。自动保存必须对 snapshot 做快照后异步执行，完成回调只能标记对应 revision 已保存，不能把较早完成的请求误标为最新版本。

## 12. 安全与资源输入

- 文本 `content` 只进入 Canvas/Text 渲染，不作为 `innerHTML`；
- image URL 的协议、域名、凭据和 CORS 由宿主 policy 验证；默认拒绝 `javascript:` 等非资源协议；
- 导入设置 feature/vertex 数量、字符串长度、嵌套深度和总字节上限；
- properties 使用无原型对象或安全遍历，拒绝原型污染键；
- 事件和 diagnostics 不包含纹理二进制、令牌或完整敏感 URL；
- persistence codec 不序列化 selection、键盘 held state、camera lease、surface sample 或 GPU 句柄。

## 13. 失败路径与错误码

最小错误码集合：`INVALID_SCHEMA`、`UNSUPPORTED_VERSION`、`INVALID_COORDINATE`、`INVALID_HEIGHT_REFERENCE`、`INVALID_GEOMETRY`、`ID_CONFLICT`、`REVISION_CONFLICT`、`TRANSACTION_CLOSED`、`EDITOR_DISPOSED`、`SURFACE_UNAVAILABLE`、`RENDER_PROJECTION_FAILED`。

`EditorError` 至少包含 `code`、稳定英文 `message`、可选 `featureId`、`path` 与 `cause`。用户界面本地化不依赖 message 字符串匹配。可预期验证失败返回 `CommandResult`；构造参数错误可同步抛出；异步 store/surface 错误通过 rejected Promise 与事件报告。

## 14. 不变量

1. 所有文档 position 永远为三元组；二维只存在于导入参数的瞬间。
2. 草稿与 working copy 在提交前不改变 document revision，也不进入保存快照。
3. 一次用户连续操作最多产生一个 history 条目；取消产生零条。
4. undo/redo 恢复坐标、样式、顺序、heightReference 和稳定 id，不恢复临时 hover/capture。
5. surface sample 和渲染高度从不序列化。
6. 导入、批量命令和多选变换均为原子操作。
7. 公共只读快照不泄漏内部可变引用。
8. `dispose()` 后所有变更 API 返回 `EDITOR_DISPOSED` 或按文档规定抛错，行为一致。

## 15. 验收项

- [ ] `createPlotEditor` 可注入宿主 scene/camera/canvas、surface provider 和 camera adapter，无隐式全局单例。
- [ ] `Primary+S` 产生 save request，但不自行发网络请求或选择存储位置。
- [ ] 单次拖拽、一次 held-key 微调和一次多选删除分别只增加一个 undo 条目。
- [ ] `Escape` 回滚后导出 JSON 与操作前逐值相同。
- [ ] undo/redo 可跨八类图形恢复稳定 id、顺序、三元坐标和七值高度参考。
- [ ] 旧二维数据导入后立即变成 `[lon, lat, 0]` 或显式 `heightMeters` 对应三元组，并输出迁移诊断。
- [ ] 非法批量导入不会部分修改当前文档。
- [ ] snapshot 中不存在 selection、surface height、Three 对象、DOM 或函数。
- [ ] 自动保存乱序完成不会把旧 revision 标成最新已保存版本。
- [ ] 包发布 smoke test 能从预定子路径只导入公开符号，内部模块未泄漏。

## 16. 关联文档

- 坐标、七值高度参考与迁移细节：[坐标与高度 Schema](./04-coordinate-height-schema.md)
- 键盘命令及 save/undo 路由：[键盘命令与键位](./06-keyboard-command-keymap.md)
- 状态和事务开始/结束条件：[编辑状态机](./07-editor-state-machine.md)
- 拾取 sample 的临时性：[拾取、表面与高度解析](./08-picking-surface-height.md)
- 分阶段落地：[实施路线图](./14-implementation-roadmap.md)
- 完整测试矩阵：[测试与验收](./15-test-and-acceptance.md)
