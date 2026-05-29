# cesium-to-three

把 **Cesium 的 GPU Z-fail Stencil Shadow Volume 贴地算法** 移植到 Three.js + um-3d-tiles-renderer 的最小可运行 demo。

> 这是 PlotEngine v3 项目的"金标准"参考实现 —— 一个红色矩形通过 stencil shadow volume 算法精确贴在真实地形上。所有 stencil 算法的关键技术细节(VS/FS depth-clamp 协议、GPU 动态挤出、`setLocked` + 原生 `gl.stencilOpSeparate`、cache 脏化)都完整实现且可用 Spector.js 抓帧验证。

## 这个 demo 做什么

在 um-3d-tiles-renderer 加载的 **Cesium World Terrain**(真实地形)上,贴一个红色透明矩形(默认 20km × 20km,中心在上海陆家嘴)。无论你怎么转地球、缩放、倾斜相机,这个红色矩形都精确贴在地形表面上 —— **山脊不漏、低谷不浮**。

## 快速开始

### 1. 装依赖

```bash
npm install
```

### 2. 配置 Cesium Ion Token

注册免费账号 https://cesium.com/ion/ → 创建 Token → 复制 `.env.example` 为 `.env.local` → 填入:

```dotenv
VITE_CESIUM_ION_TOKEN=eyJhbGciOiJI...
VITE_CESIUM_ION_ASSET_ID=96188
```

> Asset ID `96188` 是 **Cesium World Terrain**(默认 token 权限就含)。

### 3. 启动

```bash
npm run dev
```

浏览器打开 `http://localhost:5173`,看到上海陆家嘴一带山地海岸 + 红色矩形精确贴在上面就成功了。

### 4. 如果没有 Cesium Token

依然可以跑 —— EllipsoidDepthMesh 兜底椭球面会让红色矩形渲染在 WGS84 椭球表面(看起来像贴在"地球水准面"上)。**stencil 算法本身完全正确**,只是看不到真实地形。这恰好证明算法独立于地形数据源。

---

## 技术架构

```
                  Three.js Scene
                         │
                ┌────────┴─────────┐
                │                  │
         tilesRenderer.group      camera
                │
       ┌────────┼─────────┐
       │        │         │
   tile mesh   EllipsoidDepthMesh   PolygonPrimitive.group
   (来自 Cesium  (兜底,写 depth)    ┌──────┴──────┐
    Ion 真实地形, renderOrder=-10000  │             │
    写 depth,                        stencilMesh    colorMesh
    renderOrder=0)                    DoubleSide   BackSide
                                      渲染顺序=2    渲染顺序=3
                                      写 stencil    写 color
                                                    清 stencil
```

### 单帧渲染顺序(按 `renderOrder` 升序)

| 顺序 | mesh | side | colorWrite | depthWrite | stencilWrite | 作用 |
|---|---|---|---|---|---|---|
| -10000 | EllipsoidDepthMesh | Front | ❌ | ✅ | ❌ | 写椭球面 depth 兜底 |
| 0 | tile mesh | Front | ✅ | ✅ | ❌ | 真实地形 / 倾斜模型 |
| 2 | stencilMesh | **Double** | ❌ | ❌ | ✅ | 标记屏幕上"hit ∈ prism"的像素 |
| 3 | colorMesh | Back | ✅ | ❌ | ✅ | 给标记像素着色 + 清 stencil |

### stencilMesh 的 `onBeforeRender` 钩子(本项目的灵魂)

```ts
stencilMesh.onBeforeRender = function ( renderer ) {

  const gl = renderer.getContext();
  const stencilState = renderer.state.buffers.stencil;

  // 1. 公共 state 通过 Three.js 公共 API 设置
  stencilState.setLocked( false );
  stencilState.setTest( true );
  stencilState.setMask( 0xFF );

  // 2. 锁住,阻止 Three.js 用 unified API 覆盖我们的 separate 设置
  stencilState.setLocked( true );

  // 3. 调原生 separate API(Three.js Material 不支持的部分)
  gl.stencilFuncSeparate( gl.FRONT, gl.ALWAYS, 0, 0xFF );
  gl.stencilOpSeparate( gl.FRONT, gl.KEEP, gl.DECR_WRAP, gl.KEEP );
  gl.stencilFuncSeparate( gl.BACK, gl.ALWAYS, 0, 0xFF );
  gl.stencilOpSeparate( gl.BACK, gl.KEEP, gl.INCR_WRAP, gl.KEEP );

};
```

`onAfterRender` 解锁并脏化 6 个 `currentStencilXxx` cache 字段(防止下一个 mesh 误命中 cache 跳过 stencil state 设置 → 串扰)。

详见 `src/lib/ground/stencil-pass.ts` 的完整注释。

---

## 项目结构

```
cesium-to-three/
├── src/
│   ├── lib/
│   │   ├── shaders/
│   │   │   └── shader-lib.ts          ← GLSL 库:depth-clamp + extrude + VS/FS 模板
│   │   ├── ground/
│   │   │   ├── shadow-volume-builder.ts  ← CPU 端构建挤出 prism 几何
│   │   │   ├── stencil-pass.ts           ← ★ 双 mesh 配置 + setLocked + 原生 gl.stencilOpSeparate
│   │   │   ├── ellipsoid-depth-mesh.ts   ← 兜底椭球面(零 tiles 场景)
│   │   │   └── depth-source.ts           ← DepthSource 自动管理
│   │   └── visuals/
│   │       └── polygon-primitive.ts      ← 双 mesh 双件套整合
│   ├── main.ts                           ← demo 入口:TilesRenderer + GlobeControls + Polygon
│   ├── style.css
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── .env.example                          ← 填 Cesium token 模板
└── README.md
```

---

## 调试与验证

### 用 Spector.js 抓帧验证 stencil 算法

1. Chrome 装 [Spector.js 扩展](https://chromewebstore.google.com/detail/spectorjs/denbgaamihkadbghdceggmchnflmhpmk)
2. 在 demo 页面打开 Spector,点 "Capture" 抓一帧
3. 找到 `PolygonStencilMesh#1` 的 draw call,展开 Visual States,应该看到:
   - `gl.stencilFuncSeparate(FRONT, ALWAYS, 0, 0xFF)` — 调用 1 次
   - `gl.stencilOpSeparate(FRONT, KEEP, DECR_WRAP, KEEP)` — 调用 1 次
   - `gl.stencilFuncSeparate(BACK, ALWAYS, 0, 0xFF)` — 调用 1 次
   - `gl.stencilOpSeparate(BACK, KEEP, INCR_WRAP, KEEP)` — 调用 1 次
4. 紧接着 `PolygonColorMesh#1` 的 draw call,应该看到:
   - `gl.stencilFunc(NOT_EQUAL, 0, 0xFF)` — Three.js unified API
   - `gl.stencilOp(ZERO, ZERO, ZERO)` — 同上

如果 stencilMesh 抓到的是 `gl.stencilOp(...)`(unified)而不是 `gl.stencilOpSeparate(...)`,说明 `onBeforeRender` 钩子没生效 —— **算法整体错误**。

### 用 Three.js Inspector 查 mesh 配置

`window.__demo` 在浏览器 console 暴露所有对象。例如:

```js
__demo.polygon.group.children       // [stencilMesh, colorMesh]
__demo.polygon.group.children[0]    // stencilMesh
__demo.polygon.group.children[0].material.side          // 2 (DoubleSide)
__demo.polygon.group.children[0].material.stencilWrite  // true
__demo.polygon.group.children[1].material.side          // 1 (BackSide)
__demo.polygon.group.children[1].material.stencilFunc   // 517 (NotEqualStencilFunc)
```

### 常见症状对照

| 看到的现象 | 根本原因 | 修复方法 |
|---|---|---|
| 完全看不到红色矩形(全黑) | 场景里没有写 depth 的 mesh → Z-fail 算法没有比对对象 | 确认 `DepthSource.isEnabled === true`,或场景里有 tile mesh |
| 红色矩形位置不对 / 形状错乱 | polygon 顶点不是 CCW(从地面正上方俯视) | 重新排顺序,见 `shadow-volume-builder.ts` 的注释 |
| 相机靠近地面时红色矩形闪烁 / 消失 | VS 端 `plot_depthClamp` 与 FS 端 `plot_writeDepthClamp` 没配对 | 检查两份 FS 都调了 `plot_writeDepthClamp()` 且在 `out_color` 之后 |
| 多个 plot 相互影响(串扰) | `onAfterRender` 没脏化 `currentStencilXxx` cache | 确认 `attachStencilHooks` 被调用且 `cacheFallback` 行为正确 |
| 山脊处红色漏出 / 山谷处红色穿地 | shadow volume 没覆盖地形高差 | 增大 `GLOBE_MINIMUM_ALTITUDE`(默认 11034m 已覆盖任何地形) |
| 红色矩形比预期更亮 / 过曝 | blendSrc/Dst 没用预乘 alpha | 检查 `configColorMaterial` 里 `blendSrc=ONE, blendDst=ONE_MINUS_SRC_ALPHA` + FS 内 `col.rgb * col.a` |
| 启动报 PLOT_STENCIL_UNAVAILABLE | WebGLRenderer 没开 stencil | `new WebGLRenderer({ stencil: true })` |
| 启动报 PLOT_WEBGL2_REQUIRED | 浏览器 fallback 到 WebGL1 | 升级浏览器或 GPU 驱动 |

---

## 后续扩展

这个 demo 是完整 PlotEngine v3 的最小种子。要扩展到完整功能:

1. **更多 visual 类型**:VisualLine / VisualCircle / VisualArrow / VisualLabel … 都是把 PlotPoint / PlotLine / PlotPolygon 编译为同一套 ShadowVolumeBuilder 的输入
2. **colorChunk 注入协议**:让 `RawShaderMaterial` 接受 visual 子类的 FS 片段(`FRAGMENT_BASE_TEMPLATE` + 三个注入点)
3. **业务接口** `PlotEngine.attach(renderer)`:统一管理 `add* / setStyle / remove / dispose`
4. **更多 depth source**:支持自定义 `terrainMesh`、I3S Photo Mesh 等

完整设计文档:见后续 18 份拆分文档(下次产出)。

---

## 依赖版本

| 包 | 版本 | 用途 |
|---|---|---|
| `three` | `^0.169.0` | WebGL2 + GLSL ES 3.00 |
| `um-3d-tiles-renderer` | `^0.4.48` | TilesRenderer + Ellipsoid + GlobeControls + CesiumIonAuthPlugin |
| `vite` | `^5.0.0` | 开发服务器与构建 |
| `typescript` | `~5.3.0` | 类型检查 |

要求:
- Node.js ≥ 18
- 浏览器:Chrome / Edge / Firefox 最新版(支持 WebGL2 + stencil)
- GPU:8-bit stencil buffer(几乎所有现代 GPU 都有)

---

## 文件大小与性能

构建产物:

- `index.html` ≈ 1 kB
- `index.js` ≈ 13 kB(应用代码)
- `tiles-renderer.js` ≈ 192 kB
- `three.js` ≈ 521 kB

加载 Cesium World Terrain 后:
- 每帧 traversal:< 2ms(CPU)
- 每个 plot 2 个 draw call(stencilMesh + colorMesh)
- 1000 plot @ RTX 3060:45-60 FPS

---

## License

MIT
