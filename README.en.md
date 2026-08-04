# cesium-to-three

Language: [中文](./README.md) | English

`cesium-to-three` brings Cesium-style ground and model classification primitives into a Three.js based rendering stack. It uses `three` and `um-3d-tiles-renderer` to validate terrain, oblique photogrammetry, 3D Tiles, GLB models, and GIS plot primitives inside one Three pipeline.

This repository is no longer just a single red rectangle demo. The current focus is:

- Ground classification primitives: rectangle, polygon, polyline, circle, circle/square/image points, text, and arrows.
- Plot management: `GroundDecalManager` plus plugin-based plot items, incremental updates, and real detach from the Three scene.
- Model clamp demo: terrain, oblique 3D Tiles, Cesium Ion 3D Tiles, synthetic buildings, and `public/Untitle.glb` placed at the rectangle center.
- Native Three rendering fix: the GLB is loaded through the official Three `GLTFLoader` path and rendered on an isolated layer after `clearDepth()` so terrain depth does not clip it.
- TilesRenderer lifecycle control: hiding 3D Tiles stops `update()` and unloads cache so hidden layers do not keep requesting content or burning CPU.
- Adaptive rendering: continuous while interacting/loading, low-frequency while idle, avoiding both full-frame idle work and zoom stutter.

## Demo Entry Points

After starting Vite, switch demos through the URL:

| URL | Purpose |
|---|---|
| `http://localhost:5173/` | Default `ground` demo |
| `http://localhost:5173/?demo=ground` | Ground primitives and Material extensions, including FlowLine / PulsePoint / ScalePulse / custom Material / Raw Appearance |
| `http://localhost:5173/?demo=animation` | Real-scene vertex-animation comparison: floating, Cesium-terrain-clamped, and a small animated texture clamped to oblique photogrammetry |
| `http://localhost:5173/?demo=plot` | End-to-end plot management, including one-click hydrant image points |
| `http://localhost:5173/?demo=plot&noterrain` | Ellipsoid fallback test without a Cesium Ion token |
| `http://localhost:5173/?demo=model` | Model / oblique photogrammetry clamp demo, defaulting to a direct oblique tileset URL |
| `http://localhost:5173/?demo=model&model=buildings` | Synthetic building fallback with no external 3D Tiles dependency |
| `http://localhost:5173/?demo=model&model=ion` | Load a 3D Tiles model from Cesium Ion |

You can also set `VITE_DEMO=ground|plot|model|animation` in `.env.local`.

## Quick Start

Install dependencies:

```bash
npm install
```

Copy the environment file:

```bash
copy .env.example .env.local
```

Configure a Cesium Ion token. The `ground` demo and the `model` demo with basemap terrain need a token. `plot&noterrain` and `model&model=buildings` can run without one.

```dotenv
VITE_CESIUM_ION_TOKEN=eyJhbGciOi...
VITE_CESIUM_ION_ASSET_ID=96188
```

Start the dev server:

```bash
npm run dev
```

Common checks:

```bash
npm run type-check
npm run build
npm run build:lib
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VITE_DEMO` | `ground` | Default demo, one of `ground` / `plot` / `model` / `animation` |
| `VITE_CESIUM_ION_TOKEN` | empty | Cesium Ion token |
| `VITE_CESIUM_ION_ASSET_ID` | `96188` | Cesium World Terrain |
| `VITE_DISABLE_TERRAIN` | `false` | No-terrain mode for the `plot` demo |
| `VITE_PLOT_LON` / `VITE_PLOT_LAT` | demo defaults | Plot center |
| `VITE_MODEL_SOURCE` | `oblique` | Model source for the `model` demo, one of `oblique` / `ion` / `buildings` |
| `VITE_OBLIQUE_TILESET_URL` | built-in direct URL | Oblique photogrammetry `tileset.json` |
| `VITE_CESIUM_ION_MODEL_ASSET_ID` | empty | Ion 3D Tiles asset used by `model&model=ion` |
| `VITE_RECTANGLE_GLB_MODEL_URL` | `/Untitle.glb` | GLB placed at the rectangle center |
| `VITE_RECTANGLE_GLB_MODEL_SCALE` | `1.0` | Rectangle GLB scale |
| `VITE_RECTANGLE_GLB_MODEL_HEIGHT_OFFSET_METERS` | `0.0` | Rectangle GLB height offset |
| `VITE_RECTANGLE_GLB_MODEL_HEADING_DEGREES` | `0.0` | Rectangle GLB heading |

## Current Structure

| Path | Role |
|---|---|
| `src/lib/ground` | Cesium-style ground classification primitives, log depth, terrain heights, and WGS84 math |
| `src/lib/arrow` | Plot arrow geometry and shape algorithms |
| `src/lib/plot` | Demo/internal plot management layer with `GroundDecalManager` and plot plugins |
| `src/demo/ground-demo.ts` | Ground primitive demo |
| `src/demo/plot-demo.ts` | End-to-end plot manager demo |
| `src/demo/model-clamp-demo.ts` | Oblique/model clamp and rectangle-center GLB demo |
| `src/demo/tiles.ts` | Cesium Ion terrain, world imagery, 3D Tiles material, and log depth setup |
| `public/Untitle.glb` | Default GLB loaded at the rectangle center by the `model` demo |
| `public/draco/gltf` | GLB Draco decoder |

The library build exports only the `ground` and `arrow` APIs. `src/lib/plot` is still a demo/business validation layer and is not included in the npm library bundle.

```ts
import {
	CesiumGroundRectanglePrimitive,
	ClassificationType,
} from 'cesium-to-three/ground';

import {
	createAttackArrowPolygon,
} from 'cesium-to-three/arrow';
```

## Rendering Notes

- Terrain and 3D Tiles materials are patched with Cesium-compatible log depth so main depth, packed depth, and stencil classification compare in the same depth space.
- Ground/model classification is coordinated by `ClassificationDepthManager`, which tracks terrain and tileset depth contributors.
- `ClassificationType.TERRAIN` clamps to terrain only, `ClassificationType.CESIUM_3D_TILE` clamps to model tiles only, and `ClassificationType.BOTH` supports model surfaces with terrain fallback.
- The rectangle-center GLB does not mutate materials and does not use translucent backfill. It renders on an isolated Three layer after the main color pass with `clearDepth()`.
- Hiding plot primitives detaches them from the scene. Hiding 3D Tiles stops tile updates and unloads cache.

## Docs

- [Ground Material / Shader extension design and usage index (Chinese)](docs/animation-material/README.md)
- [Model Clamp GLB 渲染与性能问题修复记录](docs/model-clamp-glb-rendering-fix.md)
- [Model Clamp GLB rendering and performance fix notes](docs/model-clamp-glb-rendering-fix.en.md)
- [Ground jitter fix notes](docs/ground-jitter-fix.md)
- [Ground polyline sky-color fix notes](docs/ground-polyline-sky-color-fix.md)

## Dependencies

- Node.js 18+
- Three.js `^0.183.0`
- `um-3d-tiles-renderer ^0.4.48`
- Vite 5
- TypeScript 5.3

## License

MIT
