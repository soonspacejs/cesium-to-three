# cesium-to-three

语言：中文 | [English](./README.en.md)

`cesium-to-three` 是一个把 Cesium 风格的贴地 / 贴模型 classification 图元迁移到 Three.js 生态中的项目。它基于 `three` 和 `um-3d-tiles-renderer`，把地形、倾斜摄影、3D Tiles、GLB 模型和 GIS 标绘放在同一个 Three 渲染管线中验证。

这个仓库现在不再只是一个红色矩形 demo。当前重点是：

- 贴地 classification 图元库：矩形、多边形、折线、圆、点、文字、箭头。
- 标绘管理层：`GroundDecalManager` + 插件化 plot item，支持增量更新和从 Three scene 中真实移除。
- 贴倾斜 / 贴模型 demo：支持地形、倾斜摄影、Ion 3D Tiles、合成楼群，以及把 `public/Untitle.glb` 放到矩形中心。
- Three 原生渲染修复：GLB 按 Three 官方 `GLTFLoader` 加载，使用独立 layer + `clearDepth()` 避免被 terrain depth 裁切。
- TilesRenderer 生命周期控制：隐藏 3D Tiles 时停止 `update()` 并卸载 cache，避免隐藏后继续请求和高 CPU。
- 自适应渲染循环：交互和加载时连续渲染，空闲时低频保活，避免全帧空转和突然缩放卡顿。

## Demo 入口

启动 Vite 后通过 URL 切换 demo：

| URL | 用途 |
|---|---|
| `http://localhost:5173/` | 默认 `ground` demo |
| `http://localhost:5173/?demo=ground` | 贴地图元基础验证，展示 rectangle / polygon / line / circle / point / text / arrow |
| `http://localhost:5173/?demo=plot` | `GroundDecalManager` 端到端标绘管理测试 |
| `http://localhost:5173/?demo=plot&noterrain` | 无 Cesium Ion token 时，用椭球兜底验证标绘 |
| `http://localhost:5173/?demo=model` | 贴倾斜 / 贴模型 demo，默认加载直连倾斜摄影 |
| `http://localhost:5173/?demo=model&model=buildings` | 不依赖外部 3D Tiles，用合成楼群验证贴模型 |
| `http://localhost:5173/?demo=model&model=ion` | 从 Cesium Ion 加载 3D Tiles 模型 |

也可以通过 `.env.local` 设置 `VITE_DEMO=ground|plot|model`。

## 快速开始

安装依赖：

```bash
npm install
```

复制环境变量文件：

```bash
copy .env.example .env.local
```

配置 Cesium Ion token。`ground` demo 和带底图的 `model` demo 需要 token；`plot&noterrain` 和 `model&model=buildings` 可以在无 token 时运行。

```dotenv
VITE_CESIUM_ION_TOKEN=eyJhbGciOi...
VITE_CESIUM_ION_ASSET_ID=96188
```

启动开发服务器：

```bash
npm run dev
```

常用检查命令：

```bash
npm run type-check
npm run build
npm run build:lib
```

## 关键配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VITE_DEMO` | `ground` | 默认 demo，可选 `ground` / `plot` / `model` |
| `VITE_CESIUM_ION_TOKEN` | 空 | Cesium Ion token |
| `VITE_CESIUM_ION_ASSET_ID` | `96188` | Cesium World Terrain |
| `VITE_DISABLE_TERRAIN` | `false` | `plot` demo 无地形模式 |
| `VITE_PLOT_LON` / `VITE_PLOT_LAT` | demo 内默认值 | 标绘中心 |
| `VITE_MODEL_SOURCE` | `oblique` | `model` demo 模型来源，可选 `oblique` / `ion` / `buildings` |
| `VITE_OBLIQUE_TILESET_URL` | 内置直连 URL | 倾斜摄影 `tileset.json` |
| `VITE_CESIUM_ION_MODEL_ASSET_ID` | 空 | `model&model=ion` 使用的 Ion 3D Tiles asset |
| `VITE_RECTANGLE_GLB_MODEL_URL` | `/Untitle.glb` | 放到矩形中心的 GLB |
| `VITE_RECTANGLE_GLB_MODEL_SCALE` | `1.0` | 矩形中心 GLB 缩放 |
| `VITE_RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS` | `0.0` | 矩形中心 GLB 高度偏移 |
| `VITE_RECTANGLE_GLB_MODEL_HEADING_DEGREES` | `0.0` | 矩形中心 GLB 朝向 |

## 当前架构

| 路径 | 作用 |
|---|---|
| `src/lib/ground` | Cesium 风格贴地 classification 图元、log depth、地形高度、WGS84 数学工具 |
| `src/lib/arrow` | 标绘箭头几何与形状算法 |
| `src/lib/plot` | demo 内部标绘管理层，包含 `GroundDecalManager` 和各类 plot 插件 |
| `src/demo/ground-demo.ts` | 贴地图元基础 demo |
| `src/demo/plot-demo.ts` | 标绘管理端到端 demo |
| `src/demo/model-clamp-demo.ts` | 贴倾斜 / 贴模型 / 矩形中心 GLB demo |
| `src/demo/tiles.ts` | Cesium Ion terrain、世界影像、3D Tiles 材质和 log depth 配置 |
| `public/Untitle.glb` | `model` demo 默认加载到矩形中心的 GLB |
| `public/draco/gltf` | GLB Draco decoder |

库构建只导出 `ground` 和 `arrow` API，`src/lib/plot` 目前仍是 demo / 业务验证层，不进入 npm library bundle。

```ts
import {
	CesiumGroundRectanglePrimitive,
	ClassificationType,
} from 'cesium-to-three/ground';

import {
	createAttackArrowPolygon,
} from 'cesium-to-three/arrow';
```

## 渲染要点

- 地形和 3D Tiles 材质会注入 Cesium 兼容 log depth，使主 depth、packed depth 和 stencil classification 的深度空间一致。
- 贴地 / 贴模型通过 `ClassificationDepthManager` 管理 terrain 和 tileset 两类 depth contributor。
- `ClassificationType.TERRAIN` 只贴地形，`ClassificationType.CESIUM_3D_TILE` 只贴模型，`ClassificationType.BOTH` 同时支持模型和地形兜底。
- 矩形中心 GLB 不修改材质，不做透明 backfill；它使用独立 Three layer，在主场景颜色绘制后 `clearDepth()` 再渲染一次。
- GUI 隐藏标绘时会从 scene 中移除图元；隐藏 3D Tiles 时会停止 tiles update 并卸载 cache。

## 文档

- [Model Clamp GLB 渲染与性能问题修复记录](docs/model-clamp-glb-rendering-fix.md)
- [Model Clamp GLB rendering and performance fix notes](docs/model-clamp-glb-rendering-fix.en.md)
- [贴地抖动修复记录](docs/ground-jitter-fix.md)
- [贴地折线天空色问题修复记录](docs/ground-polyline-sky-color-fix.md)

## 依赖

- Node.js 18+
- Three.js `^0.183.0`
- `um-3d-tiles-renderer ^0.4.48`
- Vite 5
- TypeScript 5.3

## License

MIT
