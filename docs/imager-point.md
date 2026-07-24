# 贴地图片点标绘方案

## Summary

扩展现有 `point` 标绘，新增 `image` 样式。点击地图一次后，以点击经纬度为图片底边中心，将 `/xiaohuoshuan.png` 贴合地形或 3D Tiles 表面渲染，并自动结束本次拾取。

图片保持透明通道，采用米制宽高；不做始终朝向相机的 billboard。

## Public API

将点选项改为判别联合类型：

```ts
type PlotPointOptions = GisPlotBaseOptions & (
  | {
      pointStyle: 'circle' | 'square';
      size: number;
    }
  | {
      pointStyle: 'image';
      imageUrl?: string;
      ontologyId?: EmergencyResourceOntologyId;
      imageWidth: number;
      imageHeight: number;
      rotation?: number;
    }
);
```

同步扩展底层 `CesiumGroundPointShape` 和 `CesiumGroundPointPrimitiveOptions`：

- `shape: 'image'`
- `rotation` 为俯视顺时针角度，默认 `0`，图片顶部指向北方。
- 点击坐标固定对应图片底边中心。
- 图片源可以使用 `imageUrl`，也可以使用应急资源本体标识 `ontologyId`；同时提供时优先使用 `imageUrl`。
- `fillOpacity` 与管理器全局 opacity 共同乘到图片原始 alpha。
- 图片模式不绘制矩形背景和描边，现有 stroke/fillColor 字段保持兼容但不参与着色。
- 浏览器运行时使用 `/xiaohuoshuan.png`，不能使用 Windows 文件路径。

应急资源本体标识映射到 `src/assets` 下的 SVG，并通过模块导入打包：

| 本体标识 | SVG |
| --- | --- |
| `OutdoorFireHydrant` | `src/assets/outdoor-hydrant.svg` |
| `UndergroundHydrant` | `src/assets/outdoor-hydrant-underground.svg` |
| `AboveGroundHydrant` | `src/assets/outdoor-hydrant-above-ground.svg` |
| `MunicipalFireHydrants` | `src/assets/municipal-hydrant.svg` |
| `FireWaterReservoir` | `src/assets/fire-water-pool.svg` |
| `NaturalWater` | `src/assets/natural-water-source.svg` |
| `HospitalResourcePoint` | `src/assets/hospital-resource.svg` |
| `PublicSecurityResourcePoint` | `src/assets/police-resource.svg` |
| `SupportMaterialPoint` | `src/assets/emergency-supplies.svg` |
| `FireStation` | `src/assets/fire-station.svg` |
| `LinkageUnit` | `src/assets/coordination-unit.svg` |

示例：

```ts
decals.addPlot({
  type: 'point',
  pointStyle: 'image',
  points: [[lon, lat]],
  ontologyId: 'OutdoorFireHydrant',
  imageWidth: 10,
  imageHeight: 10,
  rotation: 0,
  fillOpacity: 100,
  visible: true,
  clampToGround: true,
  // 其余 GisPlotBaseOptions 沿用现有值
});
```

## Implementation Changes

- 新增通用贴地图片图元，复用贴地文字已有的“四角 ENU 足迹 → shadow volume → classification 纹理采样”管线；显式宽高使几何无需等待图片加载。
- 将文字专用的矩形足迹、纹理材质和 UV 采样逻辑提取为共享 textured-decal 能力，保持文字行为不变；透明像素输出透明色但仍正确清理 stencil。
- 图片宽度沿东西方向、高度沿南北方向，底边中心锚定；通过 ENU 坐标绕锚点旋转后生成四角，继续支持 `TERRAIN`、`CESIUM_3D_TILE` 和 `BOTH`。
- 为 URL 建立共享纹理缓存和引用计数：相同图片只加载、上传一次；最后一个图元释放时销毁纹理。加载失败时保持透明、输出一次警告且不打断渲染。
- 桥接器的几何签名加入 URL、宽高和旋转；位置、尺寸、图片或旋转变化时重建足迹，显隐、顺序、classificationType 和透明度走轻量更新。
- `clampToGround: false` 时使用同尺寸、同方向的普通水平纹理平面放在 `heightMeters` 高度，避免破坏 point 的既有契约。
- 在 plot demo 增加“消防栓图片点”工具，复用现有地图拾取逻辑：开启后仅接受一次未拖动的左键点击，成功新增图片点后立即退出；点击天空不创建图元。

## Test Plan

- 运行 `npm run type-check`、`npm run build` 和 `npm run build:lib`。
- 验证图片尺寸为 10 × 11.416 米、底边中心落在点击点、顶部朝北、PNG 透明区域无底色。
- 分别验证地形、3D Tiles、二者同时以及无地形椭球兜底场景。
- 验证单击只创建一个图元并退出，拖动相机和点击天空不会误创建。
- 验证 `setCenter`、URL、宽高、旋转、透明度、显隐和删除更新正确。
- 验证多个消防栓共用纹理，删除及管理器销毁后资源正确释放。
- 回归圆形、方形和贴地文字，确保原有 API 与渲染结果不变。

## Assumptions

- `xiaohuoshuan.png` 原始尺寸为 120 × 137，demo 默认按原比例使用 10 × 11.416 米，并提供 GUI 调整宽高。
- 首期只支持静态 PNG/JPEG/WebP URL，不包含动态图、图集、拾取高亮或图片描边。
- 图片资源需同源或服务器正确配置 CORS。
