# 贴地线低视角天空染色修复记录

> 记录时间：2026-06-16  
> 问题范围：`CesiumGroundPolylinePrimitive` 在贴地模式、低俯仰视角下，天空区域被线段颜色覆盖。

## 1. 现象

低视角观察贴地线时，地平线上方的天空会被当前线段颜色染色。例如白色线会把天空染成白色，蓝色线会把天空染成蓝色。

这个现象说明：贴地线的片元着色器在天空像素上没有被 `discard`，而是把天空像素误判成了可投影的地表点。

## 2. Cesium 原始实现要点

Cesium 的 `GroundPolylinePrimitive` 不是普通透明 mesh 叠加绘制，而是进入分类渲染流程：

- terrain：`Pass.TERRAIN_CLASSIFICATION`
- 3D Tiles：`Pass.CESIUM_3D_TILE_CLASSIFICATION`
- 片元阶段读取 `czm_globeDepthTexture`
- 如果 globe depth 是空值，直接 `discard`
- 如果有有效 globe depth，再通过 `czm_windowToEyeCoordinates` 重建当前屏幕像素下的地表点
- 最后用线段 shadow volume 的多个平面裁剪，决定该像素是否落在线宽范围内

Cesium shader 的关键假设是：天空区域的 `czm_globeDepthTexture` 必须保持 clear 值。只要天空像素读到非零、非空的 packed depth，线 shader 就会把它当成真实地面点继续计算。

## 3. 本项目差异

本项目的线几何生成基本对齐 Cesium `GroundPolylineGeometry`，问题不在 shadow volume 几何本身。

主要差异在渲染路径：

- 本项目的贴地线是一个 Three.js 透明 mesh。
- 线材质设置为 `depthTest=false`、`depthWrite=false`、`stencilWrite=false`。
- 是否丢弃天空完全依赖 fragment shader 自己检查 `czm_globeDepthTexture`。
- 因此主 framebuffer 的深度测试不会阻止天空被线色覆盖。

所以只要 `czm_globeDepthTexture` 在天空区域出现“看起来有效”的深度值，贴地线就会污染天空。

## 4. 根因

这次问题由几个条件叠加触发：

1. packed globe depth 是 RGBA 编码的数值纹理，不能当普通颜色纹理做线性采样。地平线附近如果发生过滤，地形深度和 clear 值会混合出非零伪深度。
2. 有真实瓦片深度时，如果仍写入完整椭球 fallback depth，天空区域可能被不可见椭球面写成有效地面深度。
3. 低视角下地平线附近的深度值最容易出现远平面、量化和采样边界误差。
4. 原先只检查 `depth == 0.0` 不够稳，无法覆盖“非零伪深度”。

## 5. 修复方案

### A. packed depth 使用像素级读取

修改文件：`src/lib/ground/materials.ts`

新增 `c23_polylineFetchPackedDepth`，用 `texelFetch` 按整数像素读取 packed depth，避免 RGBA depth 被采样器过滤：

```glsl
vec4 c23_polylineFetchPackedDepth(vec2 screenCoordinate) {
    ivec2 depthSize = textureSize(czm_globeDepthTexture, 0);
    vec2 maxTexel = vec2(depthSize) - vec2(1.0);
    vec2 texel = clamp(screenCoordinate * vec2(depthSize), vec2(0.0), maxTexel);
    return texelFetch(czm_globeDepthTexture, ivec2(floor(texel)), 0);
}
```

线体和箭头都改为通过这个函数读取 depth。

### B. 增加屏幕坐标合法性检查

修改文件：`src/lib/ground/materials.ts`

新增 `c23_polylineScreenCoordinateIsInvalid`，防止 `gl_FragCoord.xy / czm_viewport.zw` 在边界或尺寸不一致时越界采样。

贴地线和箭头 FS 都先做：

```glsl
vec2 screenCoordinate = c23_polylineScreenCoordinate(gl_FragCoord.xy);
if (c23_polylineScreenCoordinateIsInvalid(screenCoordinate)) {
    discard;
}
```

### C. 增加无效深度过滤

修改文件：`src/lib/ground/materials.ts`

原先只判断 `depth == 0.0`。现在统一使用：

```glsl
bool c23_polylineDepthIsInvalid(float logDepthOrDepth) {
    return logDepthOrDepth <= C23_POLYLINE_EMPTY_DEPTH_EPSILON ||
        logDepthOrDepth >= C23_POLYLINE_FAR_DEPTH_EPSILON;
}
```

这会同时过滤：

- clear / 空深度
- 接近远平面的伪深度
- log-depth 量化造成的无效边界值

### D. 增加屏幕射线与 WGS84 椭球判交

修改文件：`src/lib/ground/materials.ts`

新增 `c23_polylineRayMissesEllipsoid`：

- 从当前片元 screen coordinate 反推 eye-space 视线方向
- 用 `czm_modelViewRelativeToEye` 转回地心坐标方向
- 用 WGS84 椭球半径做 ray / ellipsoid 相交测试
- 如果当前屏幕射线本身不打到地球，直接认为这是天空片元并 `discard`

这道测试是本次修复最关键的保险：即使天空像素误读到了非零 packed depth，只要该像素的视线没有打到椭球，也不会继续渲染线色。

### E. 增加重建点地平线距离保护

修改文件：`src/lib/ground/materials.ts`

新增 `c23_polylineEyePointBeyondHorizon`，对 `czm_windowToEyeCoordinates` 重建出来的 eye-space 点再做一道物理上限判断。

如果重建点距离超过当前相机可见地平线距离加容差，说明 depth 不可信，直接丢弃。

### F. packed depth render target 显式按数值纹理配置

修改文件：`src/lib/ground/depth.ts`

`CesiumGlobeDepth` 的 render target texture 增加：

```ts
this.target.texture.colorSpace = NoColorSpace;
this.target.texture.generateMipmaps = false;
```

并继续保持：

```ts
minFilter: NearestFilter,
magFilter: NearestFilter,
format: RGBAFormat,
type: UnsignedByteType,
```

packed depth 是数值编码，不是颜色数据；不能参与颜色空间转换，也不应该生成 mipmap。

### G. 有真实地形时关闭 packed 椭球 fallback

修改文件：

- `src/lib/ground/depth.ts`
- `src/demo/ground-demo.ts`
- `src/demo/plot-demo.ts`

`CesiumGlobeDepth.render` 新增：

```ts
includeFallbackDepth?: boolean;
```

demo 中使用真实瓦片深度时传入：

```ts
includeFallbackDepth: !debugSettings.useTilesDepth
```

或：

```ts
includeFallbackDepth: !terrainState.terrainOn
```

这样有真实 terrain / tiles depth 时，packed depth 只写真实瓦片，不再把完整椭球兜底写进天空区域。无地形模式下才启用 fallback，让标绘贴到 WGS84 椭球面。

## 6. 当前涉及文件

| 文件 | 作用 |
| --- | --- |
| `src/lib/ground/materials.ts` | 贴地线 / 箭头 fragment shader 增加 packed depth 稳定读取、无效深度过滤、ray/ellipsoid 天空剔除、地平线保护 |
| `src/lib/ground/depth.ts` | packed depth target 标为数值纹理；增加 `includeFallbackDepth` 控制 |
| `src/demo/ground-demo.ts` | 真实瓦片深度开启时关闭 packed 椭球 fallback |
| `src/demo/plot-demo.ts` | terrain 开启时关闭 packed 椭球 fallback |

## 7. 验证方式

建议用以下场景复测：

1. 开启真实 terrain / tiles depth。
2. 创建白色或高饱和色贴地线。
3. 把相机压到低俯仰角，让线穿过地平线附近。
4. 切换线颜色，观察天空是否继续被对应颜色污染。
5. 同时测试带箭头的线，确认箭头 FS 也不会污染天空。
6. 关闭 terrain / tiles depth，确认无地形模式下 fallback 仍能让标绘贴到 WGS84 椭球面。

## 8. 后续维护原则

- packed depth 必须按数值纹理处理：`NearestFilter`、`NoColorSpace`、无 mipmap、shader 中优先 `texelFetch`。
- 有真实地形时，不要把完整椭球 fallback 混进同一张 packed depth，除非明确知道它不会覆盖天空。
- 贴地线这种透明覆盖层不能依赖主 framebuffer depth test 保护天空，fragment shader 内必须主动判断 depth 是否可信。
- Cesium 的 `GroundPolylinePrimitive` 依赖完整分类渲染管线；Three.js 移植版只要仍走普通透明 mesh，就必须额外补这些 sky guard。
