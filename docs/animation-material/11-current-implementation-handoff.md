# 当前实现交接（animation-material）

> 用途：记录 `animation-material` 的最终落地、补充审计、自动验收和维护边界，供后续会话直接接力。

## 当前状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 分支 | `edit-shape` | 本交接提交完成后本地领先 `origin/edit-shape` 95 个提交 |
| 实现阶段 | Stage 1～14 全部完成 | Material / Appearance / compiler / primitive / demo / 文档 / cleanup 已接通 |
| 补充审计 | 已完成 | 按 04、08、09、10 的契约和验收矩阵逐项复核，不只沿用旧 handoff 的通过结论 |
| 提交策略 | 小步提交 | 功能修复、单项 WebGL 证据、性能门禁和文档分别提交 |
| 用户工作区改动 | 保留、未暂存 | `src/demo/ground-demo.ts` 与 `public/lightline.png` 不属于本轮实现提交 |

## 已落地的公共能力

- `CesiumGroundMaterial`
- `CesiumGroundMaterialAppearance`
- `CesiumGroundRawShaderAppearance`
- `createColorGroundMaterial`
- `createTexturedDecalMaterial`
- `createPolylineDashMaterial`
- `createFlowLineMaterial`
- `createPulsePointMaterial`
- `createScalePulseMaterial`

核心契约：

- `setUniform(name, value)` 原位更新 wrapper，不改变 version，不重建 program；
- source、defines 或 schema 直接改变会被检测并拒绝，显式 `needsUpdate=true` 后才重编译；
- safe surface 只替换 color，Raw surface 以 front/back/color 三 pass 原子切换；
- `clone()` 创建独立 logical Material 与 user uniform wrappers，并遵守普通 Texture / RenderTargetTexture 的 Three clone 语义；
- 用户 Material、Appearance、uniform Texture 和 depth Texture 均为 borrowed，primitive 只释放自己的 geometry 与 compiled material；
- logical Material / Raw Appearance 的 `dispose()` 是可重复释放通知，对象仍可复用；primitive 的 `dispose()` 永久且幂等，之后公开方法统一报错；
- 宿主通过 `timeSeconds`、`deltaSeconds`、`frameNumber` 驱动系统时间；time 允许有限负值，delta 非负，frame 非负取整，非法值归零；
- Ground 库没有 timeline、tween、RAF、timer 或 request-render 调度。

## 补充审计发现并修复的实现缺口

### 1. Appearance 与生命周期

- surface 的 `setAppearance()` 现已真正接受 safe 与 Raw，同步构建失败保持旧三 pass，成功后再释放旧产物；
- classification、surface wrapper、polyline、point、text、image、rectangle 的 dispose 幂等和 use-after-dispose 行为统一；
- bound Material / Raw Appearance dispose 通知会在下一安全 update 释放本消费者产物并重新编译；解绑或 primitive dispose 后监听器解除；
- 多 primitive 共享同一 Material 时，各自 system wrappers、compiled material 和释放行为互不干扰。

### 2. 结构失效与诊断

- safe Material 对 source、defines、schema 建立已提交结构快照，未递增 version 的直接修改以稳定错误拒绝；失败候选不会污染快照；
- Raw Appearance 同样对 uniform schema 版本化；
- 每个 compiled material 保存冻结的 `userData.c23Ground` 诊断：kind、pass、ABI、Appearance/version、Material type、primitive id；
- renderer 阶段 Raw GLSL 编译失败保留 Three 原始 driver log 和 pass 上下文，不静默 fallback；
- Raw factory 上下文精确锁定五项，候选默认材质至多创建一次，历史实例复用由持久 WeakMap 拒绝；
- Raw 显式 render-state 修改保持用户权威，库不秘密修补 stencil/colorWrite/depth/blending。

### 3. 资源与原位更新

- image URL cache 的 release→reacquire→release 微任务竞争不会重复 dispose；
- text `setText()` 先在候选 canvas 排版，成功后复制到原 live canvas，保持 Group、Geometry、Attribute、Material、Texture 及 `texture.image` canvas identity；失败时旧画面不变；
- ordinary Texture、RenderTargetTexture、image cache、internal CanvasTexture 与 borrowed Texture 的所有权均有独立测试；
- appearance 和结构变化只替换预期 logical pass；真实 `WebGLProgram` 集合的增减由 assembled source/program 参数决定。

### 4. 渲染正确性

- 11 类 primitive row × default/safe/Raw × 3 classificationType × alpha `1/.5/0` 的 33 组合全部真实 WebGL2 执行，并验证目标 depth texture identity；
- alpha 0、透明纹理、Pulse/Scale coverage 外部的 stencil 清理用全屏探针和正控制证明；
- default→safe→Raw→default 每个切换帧均实际 render/readPixels，无空帧；
- `fragmentCull` 双向、text 内容更新、arrow `NONE↔BOTH` 与 `solid↔open` 均有 framebuffer 变化和非空帧证明；
- 低视角顶部 46,080 个 sky/no-depth 像素保持精确 clear color；
- B-01～B-11 内置公式矩阵锁定 Color、TexturedDecal、Dash、Flow、Pulse、Scale 的边界、方向、周期、footprint 与 epsilon；
- Flow、Pulse、Scale 的真实 framebuffer 关键帧覆盖周期闭合、mid 对称、纹理/无纹理，以及相同 absolute time 下不同 delta/frame 的逐像素一致。

### 5. 稳定性与调度

- uniform 动画连续 600 帧期间 compiled Material identity、program 对象集合、geometry 和 texture 数量稳定；
- 性能门禁先预热 120 帧，再对 600 帧分三段显式 GC 采样：堆增量不超过 `max(2 MiB, baseline×5%)`，且不持续单调增长；
- 静态测试递归扫描 `src/lib/ground`，禁止 RAF、timer、requestRender、Timeline 和 Tween 运行时进入库代码；
- [10](./10-test-and-acceptance.md#54-相对渲染成本) 的墙钟/GPU 相对耗时仍按固定硬件发布 runner 执行，需要同提交构建的阶段 1 基线产物；仓库跨平台门禁不伪造该历史基线。

## Stage 14 cleanup

- `SharedUniforms` 保留公共导出并带 `@deprecated`，内部运行时不再消费宽 index signature；
- primitive/classification 使用严格 `GroundRuntimeUniforms`，canonical system map 与 user map 在统一边界校验；
- safe surface/decal 固定 stencil 走 assembler/compiler，不再搜索或替换 Cesium `main()` 字符串锚点；
- 删除 `ClassificationColorInjection`、`colorMaterialFactory`、`extraUniforms`、迁移开关、旧 color/text/polyline/arrow shader factory 和旧 dash runtime 分支；
- `terrain-log-depth.ts` 的 `.replace()` 只用于 Three 地形 log-depth 注入，不属于 Ground Material shader anchor。

## 最终验证结果

Playwright 需要 Node 20+；本次使用 Codex workspace Node `v24.14.0`。

- `npm run type-check`：通过
- `npm run build`：通过
- `npm run build:lib`：通过
- `npm run test:unit`：22 files / 187 tests 通过
- `npm run test:integration`：13 tests 通过
- `npm run test:visual`：3 tests 通过
- `npm run test:perf`：1 test；120 warm + 600 measured frames 通过
- `npm run test:package`：声明消费与 11 个构建后 runtime exports 通过
- `npm pack --dry-run --json`：通过，235 entries
- `git diff --check`：通过

`npm pack --dry-run` 会因为当前用户未提交的 `public/lightline.png` 而在临时构建产物中列出 `dist/lightline.png`；本轮没有暂存或提交该文件。

## 本轮提交

原 Stage 14 收口：

1. `4006c82` `test(ground): lock documented material usage`
2. `1e9426a` `refactor(ground): remove legacy shader assembly`
3. `eecaaa3` `docs: mark ground material implementation complete`

补充实现审计按逻辑单元提交：

1. `485981d` Raw surface appearance 原子切换
2. `d57c7b4`、`3e3593c` classification 与 wrapper 生命周期
3. `439eaa6`、`f71cf34` disposed appearance reconcile
4. `02a05e4`、`b9b51e2` safe/Raw 结构版本检测
5. `b7b3f0e`、`4f0c14e` image cache race 与 text canvas identity
6. `51a8497`、`8f08012` shared ownership / consumer isolation
7. `d68738a`、`bd787a6` 完整 WebGL classification 矩阵与 stencil 探针
8. `9c1c573`、`d2da5d2`、`ade946d` program/resource/heap 稳定性
9. `c1ae772`、`965c63c` 帧率独立相位与时间规范化
10. `8eeaca5`、`2b89464`、`ba14f00`、`9b45028` sky、appearance、动画与 mutation framebuffer
11. `a285610`、`27b13d3`、`b5da18e` compiler 诊断、renderer/context、Raw state
12. `a7324be`、`b9bc806` 零调度器和 B-01～B-11 公式矩阵
13. `f72073c`、`6b1ce25`、`8e2efcd`、`d479967`、`70eb3a8` 实现文档状态与验收清单

`f08cf26` 同步修正了旧集成测试对 primitive dispose 事件次数的历史预期。

## 维护边界与下一步

1. 推送前只需评审/推送当前提交；不要把 `src/demo/ground-demo.ts` 或 `public/lightline.png` 混入，除非用户明确决定它们的归属。
2. 普通 CI/开发机运行仓库全门禁；固定硬件发布 runner 另执行 10.5.4 的历史基线相对耗时。
3. 真实 terrain / 3D Tiles / 不同 GPU 是发布补充抽检，不替代合成 packed-depth 自动矩阵。
4. 系统 Node 18 会在 Playwright 启动前失败；使用 Node 20+。
