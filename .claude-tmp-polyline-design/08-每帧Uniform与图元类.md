# 贴地线设计 · 08 每帧 Uniform 与图元类

> 两件事：① 把 `classification.ts::updateFrameStateUniforms` 改为 `export` 并补两项写入（`czm_projection`、`czm_pixelRatio`），抽出 extents-free 的 `createSharedUniforms` 工厂供线复用；② 新增图元类 `CesiumGroundPolylinePrimitive`（构造造几何、`update` 每帧刷 uniform、生命周期方法）。文件：`classification.ts`（改）、`primitives.ts`（新增类）。

---

## 1. `updateFrameStateUniforms` 改动（`classification.ts`）

现状（已读源码）：该函数 module-private，每帧写入 Float64 视图旋转/MVP、`czm_normal`、CPU planar、`czm_globeDepthTexture`、`czm_viewport`、`czm_inverseProjection`、`czm_viewportTransformation`、`czm_frustumPlanes`、`czm_currentFrustum`、log-depth 三件套、`czm_geometricToleranceOverMeter`。它已算好贴地线 FS/VS 需要的几乎所有量。

改动只有三点（**不动任何既有写入逻辑，stencil 路径零影响**）：

```typescript
// 1) 改签名为 export
export function updateFrameStateUniforms(
  frameState: CesiumGroundFrameState, uniforms: SharedUniforms ): void {
  // …（原有全部逻辑保持不变）…

  // 2) 新增：纯投影矩阵（Float64）。贴地线 VS 需「EC 内挤出后再投影」，
  //    故除了已有的 czm_modelViewProjectionRelativeToEye，还要单独提供 czm_projection。
  //    projectionFloat64 已由 writePerspectiveProjectionFloat64 在上方算好，直接复用。
  if ( uniforms.czm_projection !== undefined ) {
    uniforms.czm_projection.value.fromArray( projectionFloat64 );
  }

  // 3) 新增：pixelRatio（metersPerPixel 内部要乘它）。默认 1.0。
  if ( uniforms.czm_pixelRatio !== undefined ) {
    uniforms.czm_pixelRatio.value =
      frameState.pixelRatio !== undefined ? frameState.pixelRatio : 1.0;
  }
}
```

> `czm_projection`/`czm_pixelRatio` 用 `!== undefined` 守卫：polygon/circle/text 的 SharedUniforms 不含这两个键（它们的 `createSharedUniforms` 调用不带 line 扩展），守卫使同一函数对两类图元都安全。`projectionFloat64` 是文件级 scratch，已在 `writePerspectiveProjectionFloat64(...)` 后持有当前帧纯投影，无需重算。

---

## 2. 抽出 `createSharedUniforms` 工厂（extents-free）

现状：SharedUniforms 在 `CesiumClassificationPrimitive` 构造器内**内联构建**，且绑定了 `extents`（planar uv 字段 `u_southWest_*`/`u_eastward`/`u_northward`/`u_uvMinAndExtents`/`u_uMaxVmax`/`u_innerMetersRect`）。贴地线没有 extents。方案：抽一个工厂，extents 可选；线不传 extents 时这些字段填 0/identity（线 FS 不读它们）。

```typescript
// classification.ts 新增导出
export interface SharedUniformsInit {
  color: Color; alpha: number;
  extents?: GroundExtents;              // 面有；线无（→ 占位零值）
  lineExtension?: boolean;              // true 时追加贴地线专用 uniform（§2.1）
  extraUniforms?: Record<string, THREE.IUniform>;
}

export function createSharedUniforms(init: SharedUniformsInit): SharedUniforms {
  const e = init.extents ?? ZERO_EXTENTS;   // 全 0 / identity 占位
  const uniforms: SharedUniforms = {
    // —— 与现有内联块逐字一致的全部字段（czm_* / u_color / u_border* / u_polygon* /
    //     u_circle* / czm_globeDepthTexture / czm_viewport / … / u_textTexture）——
    // …（照搬 classification.ts 当前 this.uniforms = {…} 的所有键）…
    u_color: { value: new Vector4(init.color.r, init.color.g, init.color.b, init.alpha) },
    u_southWest_HIGH: { value: e.southWestHigh }, /* … 其余 extents 字段同理 … */
  };
  if (init.lineExtension) Object.assign(uniforms, createLineUniforms());  // §2.1
  if (init.extraUniforms) Object.assign(uniforms, init.extraUniforms);
  return uniforms;
}
```

> 重构方式：把 `CesiumClassificationPrimitive` 构造器里现有的 `this.uniforms = {…}` 整块移到 `createSharedUniforms`，构造器改为 `this.uniforms = createSharedUniforms({ color, alpha, extents, extraUniforms: injection?.extraUniforms })`。**逐字搬移、不增不减字段**，保证 polygon/circle/text/arrow 行为字节级不变（Spector.js 对一帧验证）。

### 2.1 贴地线专用 uniform（`createLineUniforms`）

```typescript
function createLineUniforms(): Partial<SharedUniforms> {
  return {
    czm_projection:        { value: new Matrix4() },               // doc 05/08
    czm_pixelRatio:        { value: 1.0 },                          // doc 06/07
    u_lineWidthPixels:     { value: LINE_DEFAULT_WIDTH_PIXELS },    // 3.0
    u_lineWidthMode:       { value: 0.0 },                          // 0=screen
    u_lineWidthMeters:     { value: 5.0 },
    u_lineDashEnabled:     { value: 0.0 },
    u_lineDashLengthMeters:{ value: 0.0 },
    u_lineGapLengthMeters: { value: 0.0 },
    u_lineTotalMeters:     { value: 0.0 },                          // 构造期由 length3D 填
  };
}
```

`czm_viewport` / `czm_frustumPlanes` / `czm_currentFrustum` / `czm_sceneMode` / `czm_globeDepthTexture` / `czm_inverseProjection` / `czm_viewportTransformation` / log-depth 三件套 / `czm_geometricToleranceOverMeter` 全部**已在基础 SharedUniforms 里**（polygon 也用），线直接复用。

---

## 3. `CesiumGroundPolylinePrimitive`（`primitives.ts`）

与 `CesiumGroundPolygonPrimitive` 等价的对外图元，但内部只有 **1 个 mesh**（无 stencil 三件套）。

```typescript
export class CesiumGroundPolylinePrimitive {
  private readonly _group = new Group();
  private readonly uniforms: SharedUniforms;
  private mesh: Mesh;
  private geometry: BufferGeometry;
  private material: RawShaderMaterial;
  private _options: ResolvedLineOptions;
  private _disposed = false;

  constructor(options: CesiumGroundPolylineOptions) {
    this._options = resolvePublicLineOptions(options);   // doc 09：公开选项→内部

    // 1) uniform：基础 + 线扩展（无 extents）
    const { color, alpha } = parseColor(options.strokeColor, options.strokeOpacity);
    this.uniforms = createSharedUniforms({ color, alpha, lineExtension: true });
    this.uniforms.u_lineWidthPixels.value = this._options.widthPixels;
    this.uniforms.u_lineWidthMode.value   = this._options.widthMode === 'world' ? 1.0 : 0.0;
    this.uniforms.u_lineWidthMeters.value = this._options.widthMeters;

    // 2) 几何（doc 02-04 facade）
    this.geometry = buildLineShadowVolumeGeometry({
      points: this._options.points, loop: this._options.loop,
      arcType: this._options.arcType, granularity: this._options.granularityRadians,
      minimumHeight: this._options.minimumHeight, maximumHeight: this._options.maximumHeight,
    });
    this.uniforms.u_lineTotalMeters.value = (this.geometry.userData.length3D as number) ?? 0.0;

    // 3) 材质（doc 07）+ mesh
    this.material = createPolylineMaterial(this.uniforms);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;                 // 几何无包围球（doc 04 §11）
    this.mesh.renderOrder = this._options.renderOrder; // 默认 40
    this.mesh.layers.set(CESIUM_GROUND_NON_PICKABLE_LAYER); // =1，不参与拾取（constants.ts 已有）
    this.mesh.visible = this._options.visible;
    this._group.add(this.mesh);
  }

  /** 把图元挂到场景：宿主 scene.add(primitive.group)。 */
  get group(): Group { return this._group; }

  /** 每帧调用：刷新相机相关 uniform + 深度纹理。 */
  update(frameState: CesiumGroundFrameState): void {
    if (this._disposed || !this.mesh.visible) return;
    updateFrameStateUniforms(frameState, this.uniforms);  // §1（含 czm_projection / czm_pixelRatio）
  }

  setColor(strokeColor: string, strokeOpacity?: number): void {
    const { color, alpha } = parseColor(strokeColor, strokeOpacity);
    this.uniforms.u_color.value.set(color.r, color.g, color.b, alpha);
  }
  /** screen 模式传像素，world 模式传米。 */
  setWidth(width: number): void {
    if (this._options.widthMode === 'world') this.uniforms.u_lineWidthMeters.value = width;
    else this.uniforms.u_lineWidthPixels.value = width;
  }
  setRenderOrder(order: number): void { this.mesh.renderOrder = order; }
  setVisible(visible: boolean): void { this.mesh.visible = visible; }

  dispose(): void {
    if (this._disposed) return;
    this._group.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    // 不 dispose czm_globeDepthTexture（共享，归 CesiumGlobeDepth 管理）
    this._disposed = true;
  }
}
```

> `geometry.userData.length3D`：doc 04 facade 在算 texNorm 时已得全线长度，顺手挂到 `userData.length3D`，供虚线 `u_lineTotalMeters`。

---

## 4. `CesiumGroundFrameState` 扩展（`types.ts`，doc 09 落地）

```typescript
export interface CesiumGroundFrameState {
  depthTexture: Texture;
  width: number;       // drawingBuffer 物理像素宽
  height: number;
  camera: PerspectiveCamera;
  pixelRatio?: number; // 【新增】renderer.getPixelRatio()；缺省 1.0
}
```

宿主每帧填 `pixelRatio = renderer.getPixelRatio()`（doc 09 demo）。polygon/circle 等不读它，向后兼容。

---

## 5. 拾取层与剔除

- `CESIUM_GROUND_NON_PICKABLE_LAYER`（constants.ts 已有 = 1）：`mesh.layers.set(1)` 使贴地线不被默认 raycaster（layer 0）命中——线是装饰层，拾取应命中底层瓦片/要素。
- `mesh.frustumCulled = false`：几何无 `position` 属性、包围球为空，Three 会误判在视锥外而剔除；关闭后由 GPU 裁剪（depth-clamp）处理。

---

## 6. 边界与精度

1. **守卫式写入**：`czm_projection`/`czm_pixelRatio` 用 `!== undefined`，使 `updateFrameStateUniforms` 同时服务面（无这两键）与线（有）。
2. **createSharedUniforms 逐字搬移**：重构后必须对 polygon/circle/text 跑一遍 Spector.js，确认 uniform 集合与值字节一致。
3. **共享深度纹理不 dispose**：`dispose()` 只清自己的 geometry/material，深度纹理归 `CesiumGlobeDepth`。
4. **visible=false 跳过 update**：省每帧矩阵运算；恢复可见时下一帧 update 自然补回。
5. **pixelRatio 缺省 1.0**：宿主忘了填也不崩，只是 HiDPI 线宽偏窄，文档需提示填。

---

## 7. 实现检查清单（doc 08）

- [ ] `updateFrameStateUniforms` 改 export + 守卫式写 `czm_projection`（fromArray(projectionFloat64)）+ `czm_pixelRatio`。
- [ ] 抽出 `createSharedUniforms`（extents 可选，字段逐字搬移），polygon 构造器改为调用它，Spector.js 验证零差异。
- [ ] `createLineUniforms` 提供 9 个线 uniform。
- [ ] `CesiumGroundPolylinePrimitive`：构造（uniform+几何+材质+mesh，frustumCulled=false / layer=1 / renderOrder=40）、`group` getter、`update`、`setColor/setWidth/setRenderOrder/setVisible`、`dispose`。
- [ ] `CesiumGroundFrameState` 加 `pixelRatio?`。
- [ ] `length3D` 经 `userData` 传到 `u_lineTotalMeters`。
