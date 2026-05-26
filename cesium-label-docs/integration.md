# 集成 · 接线 / 共享文件改动 / demo / 实现顺序 / 验收

> [← C6-primitive](./C6-primitive.md) | [README](./README.md)

## 1. 需要改动的共享文件（最小侵入清单）

贴地文本绝大部分是新增独立文件（`src/lib/ground/text/`），仅 3 个共享文件有**向后兼容**的小改动：

| 文件 | 改动 | 详见 |
|---|---|---|
| `materials.ts` | ① `createFragmentPrefix` 加受 `#ifdef CESIUM_THREE_TEXT` 保护的 `u_textTexture` 声明；② 新增 `createTextColorFragmentBody()` / `buildTextColorFragmentShader()`；③ 导出 `createTextColorMaterial()` | [C4](./C4-material.md) |
| `classification.ts` | 构造器加可选第 7 参 `injection?: ClassificationColorInjection`（color 材质工厂 + extraUniforms）；`setFragmentCulling` 经工厂字段重建 | [C5](./C5-classification.md) |
| `types.ts` | `SharedUniforms` 加可选 `u_textTexture?: { value: Texture \| null }` | [C4](./C4-material.md) |

未传 injection 的既有调用方（rectangle/circle/polygon/arrow）**行为逐字不变**。

新增文件（`src/lib/ground/text/`）：`text-types.ts` `text-defaults.ts` `text-color.ts` `text-layout.ts` `text-canvas.ts` `text-placement.ts` `text-options.ts` `text-construct-extruded.ts` `text-shadow-volume.ts` `text-extents.ts` `text-primitive.ts` `index.ts`。

## 2. 模块导出（`src/lib/ground/index.ts` / adapter）

```typescript
// src/lib/ground/index.ts 追加：
export { CesiumGroundTextPrimitive } from './text';
export type {
	PlotTextOptions,
	PlotTextAlign,
	PlotTextVerticalAlign,
	PlotTextAnchorX,
	PlotTextAnchorY,
	PlotTextLayoutDirection,
	PlotTextBoxOverflow,
} from './text';
```

若 `cesium-ground-adapter.ts` 是对外公开入口，同样把 `CesiumGroundTextPrimitive` 与上述类型 re-export 出去，与 rectangle/circle/polygon 的导出方式一致。

## 3. demo 用法

```typescript
import { CesiumGroundTextPrimitive } from '@/lib/ground';

// 字体须先加载，否则首帧用 fallback 字体测量错位
await document.fonts.load( 'bold 64px "Noto Sans SC"' );

const label = new CesiumGroundTextPrimitive( {
	points: [ [ 116.391, 39.907 ] ],   // 天安门附近
	content: '长安街',
	fontFamily: 'Noto Sans SC',
	fontWeight: 'bold',
	fontSize: 64,                       // 纹素像素（清晰度）
	fontColor: '#ffffff',
	fontStrokeColor: '#102a43',
	fontStrokeWidth: 4,
	fillColor: '#1f6feb',
	fillOpacity: 70,                    // 0..100
	strokeColor: '#ffffff',
	strokeWidth: 3,
	strokeOpacity: 100,
	cornerRadius: 16,
	padding: [ 12, 20, 12, 20 ],
	textAlign: 'center',
	verticalAlign: 'middle',
	metersPerPixel: 0.6,                // 地面足迹 = canvas px × 0.6 米
	anchorX: 'center',
	anchorY: 'middle',
	rotation: 30,                       // 地平面内顺时针 30°（沿街向）
	renderOrder: 12,
} );

scene.add( label.group );

// 相机须 enable 非拾取层，否则三个 shadow-volume mesh 不进渲染（见 classification 注释）
camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER );

// 每帧（与 rectangle/circle 同一处）：
function onFrame() {
	const frameState = {
		depthTexture: packedDepthTarget.texture,
		width: drawingBufferWidth,
		height: drawingBufferHeight,
		camera, // PerspectiveCamera
	};
	label.update( frameState );
}

// 动态改文字：
label.setText( { content: '复兴门', rotation: 45 } );

// 释放：
label.dispose();
```

贴地文本与 rectangle/circle 共享同一帧 `frameState` 与同一套 `terrain-log-depth` / packed-depth 配置——无需额外初始化（`initializeApproximateTerrainHeights()`、`updateTerrainLogDepthUniforms(near,far)` 等沿用现有 demo 流程）。

## 4. 实现顺序（自底向上，每步可独立测）

1. **A 层**：`text-types` → `text-defaults` → `text-color` → `text-layout` → `text-canvas`。验收：离屏看 canvas 正确（框/背景/字/对齐/横竖排）。
2. **B 层**：`text-placement`。验收：单测 4 角点 ENU/ECEF（赤道、rotation=0/90、anchor、offset）。
3. **共享改动**：`types.ts` 加 `u_textTexture` → `materials.ts` 加 `createTextColorMaterial` → `classification.ts` 加注入点。验收：rectangle/circle demo 回归无变化。
4. **C 层几何**：`text-options` → `text-construct-extruded` → `text-shadow-volume` → `text-extents`。验收：几何顶点/索引数、extents eastward/northward 模长。
5. **C 层公开类**：`text-primitive` → `index`。验收：demo 里出一个贴地标牌，平移/倾斜相机不抖、随地形起伏、旋转角度正确、纹理不歪。

## 5. 边界与已知限制

- **自动换行**未实现：固定 `boxWidth` 超宽由 canvas `clip` 裁。需要时在 `text-layout` 加贪心折行。
- **字体未加载**：首帧 `measureText` 用 fallback 字体 → 位置错。务必构造前 `await document.fonts.load(...)`。
- **极大足迹跨曲率**：标牌通常几十米，切平面近似足够；若做数公里级超大文字，`text-construct-extruded` 的单 quad 需像 rectangle 那样按 granularity 细分（当前不细分）。
- **高频动态文本**：`setText` 走几何 + classification 重建，开销不小；每帧变文字应在业务层按 content 去重，或后续给 `text-primitive` 加「仅纹理变、足迹不变」的轻量路径（只 `texture.needsUpdate`，不重建几何）。
- **颜色空间**：CanvasTexture 取 sRGB 值，C4 默认直接输出；若该 pass 启用 sRGB 输出编码致偏亮，按 C4 注释改 `czm_gammaCorrect(texel)`。
- **拾取**：三个 mesh 在非拾取层，默认不可点选（与现有贴地图元一致）；若要文字可点选，另建一个普通 raycast 代理（如锚点处一个不可见 plane）。

## 6. 验收清单（对照 skill 输出检查）

- [ ] 每个新文件有文件头注释（职责 / 层级 / 依赖 / 被消费方）
- [ ] 每个公共函数有 JSDoc（做什么 / 参数 / 返回值 / 算法要点）
- [ ] 旋转 quad extents 的 eastward/northward 沿字面轴（uv 不歪），rotation 任意角验证
- [ ] 文字 uv 用 CPU-plane（`u_cpuWestPlane/u_cpuSouthPlane` + `u_innerMetersRect.zw`）→ 远视角 / 倾斜不抖
- [ ] color/stencil 材质走 LOG_DEPTH 包装（`czm_vertexLogDepth` / `czm_writeLogDepth`）+ `LessEqualDepth`
- [ ] `createTextColorMaterial` render state 与 `createColorMaterial` 逐字一致（命令块排序 / stencil 语义）
- [ ] 几何 attribute 名 `position3DHigh/Low` / `extrudeDirection` / `batchId`，棱柱封闭、全外向 CCW
- [ ] 数值常量精确（`6378137.0`、`CESIUM_GLOBE_MINIMUM_ALTITUDE=55000.0`、度↔弧度 `Math.PI/180`）
- [ ] TypedArray 类型正确（CPU positions Float64、GPU high/low Float32）
- [ ] GPU 资源 dispose 路径完整（几何 + 三材质 + 纹理）
- [ ] 错误用 `throw new Error()`（与现有 primitive 一致；项目未用 GeoForgeError）
- [ ] rectangle/circle/polygon/arrow 回归：未传 injection 行为不变

---

[← C6-primitive](./C6-primitive.md) | [README](./README.md)
