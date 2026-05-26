# 贴地线设计 · 09 公开 API 与适配器集成

> 把贴地线接入项目对外契约：`types.ts`（选项 + SharedUniforms 扩展 + frameState）、`index.ts`（导出）、`cesium-ground-adapter.ts`（再导出）、`constants.ts`（常量）、`src/demo/ground-demo.ts`（注册 + 每帧 update + pixelRatio）。命名与现有 `CesiumGroundCircleOptions` / `CesiumGroundPolygonPrimitive` 风格一致。

---

## 1. `types.ts` 新增/改动

### 1.1 公开选项 `CesiumGroundPolylineOptions`

对齐现有 `CesiumGroundCircleOptions`（`strokeColor: string` / `strokeOpacity: number`(0..100) / `visible: boolean`）：

```typescript
/** 折线的连线方式（对外字符串）。 */
export type CesiumGroundArcType = 'none' | 'geodesic' | 'rhumb';
/** 线宽语义。screen=屏幕像素恒定（默认）；world=世界米恒定。 */
export type CesiumGroundLineWidthMode = 'screen' | 'world';

export interface CesiumGroundPolylineOptions {
  /** lon/lat 折点（度），≥ 2 个。 */
  points: LonLatPoint[];
  /** 线色，'#rrggbb' 或 css 颜色。 */
  strokeColor: string;
  /** 不透明度 0..100（与其它图元一致的百分比口径）。 */
  strokeOpacity: number;
  /** 屏宽模式下的像素宽（默认 3）。 */
  widthPixels?: number;
  /** 可见性。 */
  visible: boolean;
  /** 是否闭合成环（默认 false；2 点时强制 false）。 */
  loop?: boolean;
  /** 连线方式（默认 'geodesic'）。 */
  arcType?: CesiumGroundArcType;
  /** 加密角分辨率（弧度，默认 LINE_DEFAULT_GRANULARITY = π/180/32）。 */
  granularityRadians?: number;
  /** 高度窗口下限（米，默认 -55000）。高级。 */
  minimumHeight?: number;
  /** 高度窗口上限（米，默认 +55000）。高级。 */
  maximumHeight?: number;
  /** 线宽模式（默认 'screen'）。 */
  widthMode?: CesiumGroundLineWidthMode;
  /** 世界宽模式下的米宽（widthMode==='world' 时使用，默认 5）。 */
  widthMeters?: number;
  /** 渲染顺序（默认 40，> polygon 的 30）。 */
  renderOrder?: number;
  /** 虚线：实线段长（米）。设置即启用虚线。 */
  dashLengthMeters?: number;
  /** 虚线：间隙长（米）。 */
  gapLengthMeters?: number;
}
```

`resolvePublicLineOptions(options)`（内部）映射：`arcType` 字符串→`ArcType` 枚举；填默认值；校验（`points.length≥2`、`granularityRadians>0`、`maximumHeight>minimumHeight`、`widthMode==='world'→widthMeters>0` / `==='screen'→widthPixels>0`、`loop&&points.length===2→loop=false`）；非法抛 `GeoForgeError('LINE_OPTIONS_INVALID', detail)`。虚线：`dashLengthMeters!=null → u_lineDashEnabled=1`（doc 06/08）。

### 1.2 `SharedUniforms` 扩展（追加可选键）

`SharedUniforms` 已有索引签名 `[uniform: string]: { value: unknown }`，故新增键类型安全可加。显式声明便于类型检查：

```typescript
export interface SharedUniforms {
  [uniform: string]: { value: unknown };
  // …（现有全部字段不变）…
  // —— 贴地线扩展（仅线材质使用；面材质的 uniform map 不含这些键）——
  czm_projection?: { value: Matrix4 };
  czm_pixelRatio?: { value: number };
  u_lineWidthPixels?: { value: number };
  u_lineWidthMode?: { value: number };
  u_lineWidthMeters?: { value: number };
  u_lineDashEnabled?: { value: number };
  u_lineDashLengthMeters?: { value: number };
  u_lineGapLengthMeters?: { value: number };
  u_lineTotalMeters?: { value: number };
}
```

> 全部可选（`?`），不破坏既有 polygon/circle/text 对 SharedUniforms 的构造（它们不设这些键，`updateFrameStateUniforms` 的守卫跳过写入，doc 08 §1）。

### 1.3 `CesiumGroundFrameState` 加 `pixelRatio?`（doc 08 §4）

```typescript
export interface CesiumGroundFrameState {
  depthTexture: Texture; width: number; height: number; camera: PerspectiveCamera;
  pixelRatio?: number;   // 【新增】renderer.getPixelRatio()，缺省 1.0
}
```

---

## 2. `constants.ts` 新增

```typescript
export const WALL_INITIAL_MIN_HEIGHT = 0.0;
export const WALL_INITIAL_MAX_HEIGHT = 1000.0;
export const MITER_BREAK_SMALL = Math.cos(Math.PI / 6);   //  cos30° ≈ 0.8660254037844387
export const MITER_BREAK_LARGE = Math.cos(5 * Math.PI / 6);// cos150°≈ -0.8660254037844387
export const LINE_NORMAL_NUDGE = 1e-5;   // EPSILON5
export const LINE_NUDGE_XZ = 1e-2;       // EPSILON2
export const LINE_SPLIT_EPSILON = 1e-7;  // EPSILON7
export const LINE_DEDUP_EPSILON = 1e-12; // EPSILON12
export const LINE_DEFAULT_GRANULARITY = Math.PI / 180 / 32;
export const LINE_DEFAULT_WIDTH_PIXELS = 3.0;
export const LINE_DEFAULT_RENDER_ORDER = 40;
// CESIUM_GLOBE_MINIMUM_ALTITUDE = 55000.0 已存在
// CESIUM_GROUND_NON_PICKABLE_LAYER = 1 已存在
```

---

## 3. `index.ts` / `cesium-ground-adapter.ts` 导出

```typescript
// index.ts：与现有 CesiumGroundCirclePrimitive 等并列
export { CesiumGroundPolylinePrimitive } from './primitives';
export type {
  CesiumGroundPolylineOptions, CesiumGroundArcType, CesiumGroundLineWidthMode,
} from './types';
// cesium-ground-adapter.ts：若适配器集中再导出图元类，则同样补一行 re-export。
```

---

## 4. demo 接线（`src/demo/ground-demo.ts`）

### 4.1 import + 创建

```typescript
import { CesiumGroundPolylinePrimitive } from '@/lib/ground';

function createGroundPolyline(): CesiumGroundPolylinePrimitive {
  return new CesiumGroundPolylinePrimitive({
    points: [[121.500, 31.240], [121.510, 31.252], [121.524, 31.246], [121.533, 31.258]],
    strokeColor: '#ff3030', strokeOpacity: 95,
    widthPixels: 3, visible: true, arcType: 'geodesic',
    renderOrder: 40,
  });
}
const groundPolyline = createGroundPolyline();
scene.add(groundPolyline.group);
```

### 4.2 每帧 update（与现有图元同位置，补 pixelRatio）

在 demo 的渲染循环里，与 polygon/circle 的 `update(frameState)` 并列：

```typescript
const frameState: CesiumGroundFrameState = {
  depthTexture: globeDepth.depthTexture,          // 已有 CesiumGlobeDepth 实例
  width: renderer.domElement.width,               // drawingBuffer 物理像素
  height: renderer.domElement.height,
  camera,
  pixelRatio: renderer.getPixelRatio(),           // 【新增】HiDPI 线宽正确
};
// 全局深度 pass 先跑（已有），再 update 各图元
groundPolyline.update(frameState);
// 渲染主场景（线 mesh 在 scene 里，renderOrder=40 自然排在面之后）
```

### 4.3 相机 layer（拾取/可见）

贴地线 mesh 在 `CESIUM_GROUND_NON_PICKABLE_LAYER`(=1)。要让相机**渲染**它，需 `camera.layers.enable(1)`（demo 初始化一次）；raycaster 保持只查 layer 0，从而线可见但不被拾取。

```typescript
camera.layers.enable(CESIUM_GROUND_NON_PICKABLE_LAYER); // 渲染线层
// raycaster.layers 默认 0，不动 → 线不被拾取
```

### 4.4 调试面板（可选，沿用 plotOrderRegistry 模式）

可加 `linePlotOrder = plotOrderRegistry.update(...)` 滑杆调 `groundPolyline.setRenderOrder(n)`，与现有 rectangle/circle/polygon 调试项一致，便于验证线压面之上。

---

## 5. 公开方法一览（doc 08 类，复述对外契约）

```
primitive.group                       // Three.Group，scene.add 用
primitive.update(frameState)          // 每帧
primitive.setColor(color, opacity?)   // 改色
primitive.setWidth(width)             // screen→px / world→m
primitive.setRenderOrder(order)
primitive.setVisible(visible)
primitive.dispose()
```

---

## 6. 边界与精度

1. **strokeOpacity 0..100**：与现有图元一致的百分比，内部 `parseColor` 转 0..1 alpha；勿传 0..1。
2. **SharedUniforms 全可选键**：面图元不受影响（不设键 + 守卫跳过）。
3. **pixelRatio 缺省 1.0**：宿主漏填不崩，HiDPI 线偏窄——demo 必须填，文档显著提示。
4. **camera.layers.enable(1)**：漏掉则线不渲染（在 layer 1 而相机默认只渲染 layer 0）。常见接线遗漏点。
5. **width 物理像素**：`frameState.width/height` 必须是 drawingBuffer 尺寸（`renderer.domElement.width`），非 CSS 像素，否则 `czm_viewport`/UV/metersPerPixel 全错位。

---

## 7. 实现检查清单（doc 09）

- [ ] `CesiumGroundPolylineOptions` + `CesiumGroundArcType` + `CesiumGroundLineWidthMode` 定义。
- [ ] `resolvePublicLineOptions`：字符串→枚举、默认、校验、虚线启用。
- [ ] `SharedUniforms` 追加 9 个可选线键；`CesiumGroundFrameState` 加 `pixelRatio?`。
- [ ] `constants.ts` 补 WALL/MITER/EPSILON/LINE_DEFAULT_* 常量。
- [ ] `index.ts`（+ adapter）导出图元类与类型。
- [ ] demo：创建、`scene.add(group)`、每帧 `update(frameState{pixelRatio})`、`camera.layers.enable(1)`。
- [ ] demo width/height 用 drawingBuffer 物理像素。
