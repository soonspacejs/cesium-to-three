# 新会话继续工作说明（animation-material）

> 将本文件路径和下方“新会话提示词”交给新的 Codex 会话。完整实现细节见 [11-current-implementation-handoff.md](./11-current-implementation-handoff.md)。

## 新会话提示词

```text
请先完整阅读：
D:\my\code\cesium-to-three\docs\animation-material\12-new-session-continuation.md
D:\my\code\cesium-to-three\docs\animation-material\11-current-implementation-handoff.md

在 D:\my\code\cesium-to-three 继续工作。
不要重新实现已经完成的 animation-material Stage 1～14；先检查 git status 和最近提交，再基于当前状态继续我的新要求。
保留并不要暂存/覆盖用户已有改动：
- src/demo/ground-demo.ts
- public/lightline.png

继续遵守“小步修改、小步验证、小步提交”，只暂存当前任务明确涉及的文件。
Playwright 必须使用 Node 20+；当前可用 workspace Node 路径见本文件。
```

## 仓库状态

| 项目 | 当前值 |
| --- | --- |
| 工作区 | `D:\my\code\cesium-to-three` |
| 分支 | `edit-shape` |
| 实现基线提交 | `d69300e docs: finalize ground implementation handoff` |
| 相对远端 | 基线时领先 `origin/edit-shape` 95 个提交；本说明若已提交则再增加 1 |
| animation-material | Stage 1～14 与补充验收审计均已完成 |

新会话必须先执行：

```powershell
git status --short
git branch --show-current
git log -5 --oneline
git rev-list --count origin/edit-shape..HEAD
```

## 不得碰的用户改动

当前工作树有两项不属于 animation-material 实现提交：

```text
 M src/demo/ground-demo.ts
?? public/lightline.png
```

- 不要恢复、覆盖、删除或暂存它们；
- `public/lightline.png` 会被 Vite 复制到 `dist/lightline.png`，因此 `npm pack --dry-run` 的临时包清单会包含它；
- 只有用户明确要求处理这些文件时，才建立独立提交。

## 已完成内容摘要

- safe / Raw Appearance 已覆盖 surface、decal、polyline、arrow 与 point delegate；
- surface Raw front/back/color 三 pass 原子切换，safe 只替换 color；
- Material / Raw Appearance dispose 通知、多消费者隔离、primitive 幂等永久 dispose 已完成；
- source、defines、safe schema、Raw schema 的未版本化直接修改会被检测；
- image cache 释放竞争和 text canvas/Texture identity 已修复；
- Raw renderer 编译错误保留 driver log、kind/pass/version/primitive 诊断；
- 33 组 classification appearance/depth/alpha WebGL2 矩阵已覆盖；
- 透明纹理、alpha 0、Pulse/Scale coverage 外部的 stencil 清理已由全屏探针证明；
- Flow/Pulse/Scale 公式、逐像素关键帧、帧率独立性和 600 帧稳定性均已覆盖；
- culling、text、arrow、default→safe→Raw→default 切换均有真实 framebuffer 无空帧证明；
- Ground 源码没有 RAF、timer、Timeline、Tween 或 request-render 调度；
- 04、08、09、10、11 文档均已更新为 Implemented 状态。

不要仅凭旧上下文重新修改这些模块；发现问题时先用现有测试复现，再做独立修复提交。

## 最近完整验证

使用 Node `v24.14.0`：

```powershell
$env:PATH='C:\Users\WIN11\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
```

验证结果：

| 命令 | 结果 |
| --- | --- |
| `npm run type-check` | 通过 |
| `npm run build` | 通过 |
| `npm run build:lib` | 通过 |
| `npm run test:unit` | 22 files / 187 tests 通过 |
| `npm run test:integration` | 13 tests 通过 |
| `npm run test:visual` | 3 tests 通过 |
| `npm run test:perf` | 1 test；120 warm + 600 measured frames 通过 |
| `npm run test:package` | 类型消费与 11 个 runtime exports 通过 |
| `npm pack --dry-run --json` | 通过，基线时 235 entries |
| `git diff --check` | 通过 |

完整复验可执行：

```powershell
$env:PATH='C:\Users\WIN11\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
npm run type-check
npm run build
npm run build:lib
npm test
npm run test:perf
npm run test:package
npm pack --dry-run --json
git diff --check
```

## 后续工作边界

当前没有已知未完成的 animation-material 代码项。新会话应根据用户的新目标执行以下之一：

1. 代码评审或针对新问题补测试/修复；
2. 处理并独立提交 demo / `lightline.png` 用户改动；
3. 推送 `edit-shape` 或准备 PR（必须先由用户明确要求）；
4. 在固定硬件发布 runner 上执行文档 10.5.4 的历史阶段相对性能比较；
5. 做真实 terrain / 3D Tiles / 不同 GPU 的发布补充抽检。

固定硬件历史性能基线和真实数据源抽检是发布环境工作，不应在普通开发机上伪造结果，也不表示当前库实现残缺。

