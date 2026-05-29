// ============================================================
// constants.ts
// 层级:Cesium-to-Three 贴地适配器共享常量。
// 职责:定义几何、着色器、图元模块共用的 WGS84 椭球值与 Cesium classification 常量。
// 依赖:无。
// 被消费:贴地几何辅助函数、材质与深度通道。
// ============================================================

// WGS84 x 轴半长轴，单位米。
export const WGS84_X_RADIUS = 6378137.0;

// WGS84 y 轴半长轴，单位米。
export const WGS84_Y_RADIUS = 6378137.0;

// WGS84 z 轴半短轴，单位米。
export const WGS84_Z_RADIUS = 6356752.3142451793;

// GroundPrimitive stencil 命令使用的 Cesium classification 位掩码。
export const CLASSIFICATION_MASK = 0x0f;

// Cesium 3D 场景模式的数值。
export const SCENE_MODE_3D = 3.0;

// Cesium globe minimum altitude，被 shadow-volume 顶点着色器用作逐帧挤出 delta 的上限。
// 这里有意保持较大值，因为它只是上界；实际挤出量由
// czm_geometricToleranceOverMeter * length(positionEC) 驱动。
export const CESIUM_GLOBE_MINIMUM_ALTITUDE = 55000.0;

// 几何扩张量等于请求的米制描边宽度。
export const BORDER_GEOMETRY_EXPANSION_SCALE = 1.0;

// 几何管线允许的多边形外轮廓最大顶点数，对齐参考项目 shader 侧 uniform 槽位数量。
// 当前适配器不会把这些点直接喂给 classification 材质，但 polygon hierarchy
// 校验仍使用此上限约束输入规模。
export const MAX_POLYGON_STYLE_VERTICES = 128;

// 交互 demo 中圆形细分精度的下限。Cesium 生产路径约使用 0.001 rad；
// 这里暴露略大的下限，避免 GUI 滑块意外生成百万级顶点网格。
export const MIN_CIRCLE_GRANULARITY_RADIANS = 0.0025;

// 交互 demo 中圆形细分精度的上限。
export const MAX_CIRCLE_GRANULARITY_RADIANS = 0.2;

// Cesium Scene._maximumScreenSpaceError 默认值，UniformState.update 用它推导
// czm_geometricToleranceOverMeter。Cesium 主场景默认使用 2.0；保持一致可让
// shadow-volume 顶点挤出行为与原始 GroundPrimitive 同步。
export const CESIUM_MAXIMUM_SCREEN_SPACE_ERROR = 2.0;

// 默认地形 min/max 高度回退值，对齐 ApproximateTerrainHeights._defaultMinTerrainHeight /
// _defaultMaxTerrainHeight。地形高度表尚未初始化时使用，保证适配器仍能生成有效 shadow volume。
export const APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT = - 100000.0;
export const APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT = 9000.0;

// 贴地折线(line-shadow-volume)共享常量。
// 几何构造器在 `adjustHeights` 把顶点推到用户配置的 min/max 之前使用的标准墙高窗口。
// 与 Cesium GroundPolylineGeometry 的常量一致。
export const WALL_INITIAL_MIN_HEIGHT = 0.0;
export const WALL_INITIAL_MAX_HEIGHT = 1000.0;

// miter 断开阈值。Cesium 使用 cos(30°) / cos(150°)，`breakMiter` 用它判断转角
// 是否足够尖锐：若是则把几何法线旋转 ±90°，避免 miter 长度爆炸。
export const MITER_BREAK_SMALL = Math.cos( Math.PI / 6.0 );  // 约 0.8660254037844387
export const MITER_BREAK_LARGE = Math.cos( 5.0 * Math.PI / 6.0 ); // 约 -0.8660254037844387

// 每段 box 生成器内部使用的微偏移 epsilon。
// LINE_NORMAL_NUDGE(EPSILON5):沿右法线把 8 个 box 角点推开 ±1e-5 m，避免零厚度 box
//   导致 FS 重建在退化面上数值不稳定。
// LINE_NUDGE_XZ(EPSILON2):当顶点距离 XZ 平面 1 cm 内(y == 0 in WGS84)时，
//   沿线段方向推开约 1 cm，避免 GeometryPipeline 风格的数值路径坍缩。
export const LINE_NORMAL_NUDGE = 1.0e-5;
export const LINE_NUDGE_XZ = 1.0e-2;

// `splitAcrossXZPlane` 用于丢弃近重合切分交点的 epsilon，量级为 ECEF 坐标。
export const LINE_SPLIT_EPSILON = 1.0e-7;

// cartographic 去重使用的 epsilon，比较弧度制 lon/lat。
export const LINE_DEDUP_EPSILON = 1.0e-12;

// 默认单段加密步长，单位是“米”(虽然历史命名叫 granularity radians)。
// 与 Cesium `GroundPolylineGeometry` 默认值一致：
// `cesium-ground-source/.../GroundPolylineGeometry.js`:107
// `this.granularity = options.granularity ?? 9999.0`。
// `interpolateSegment` 计算 `segments = ceil(surfaceDistance(meters) / granularity)`，
// Cesium JSDoc 也明确写的是“米制距离间隔”。50 km 线段在此默认值下约产生 6 个插值点，
// 远低于把它误当弧度尺度时会生成的百万级点数，避免页面卡死。
export const LINE_DEFAULT_GRANULARITY = 9999.0;

// 默认屏幕空间线宽，单位 CSS 像素，与 Cesium 默认值一致。
export const LINE_DEFAULT_WIDTH_PIXELS = 3.0;

// 折线默认 renderOrder。高于 polygon 默认值 30，使线绘制在填充贴地图元之上。
export const LINE_DEFAULT_RENDER_ORDER = 40;

// 所有 Cesium-ground“不可拾取”网格使用的 Three.js layer:
// classification shadow-volume 的 stencil/back-stencil/color 网格，以及 rectangle debug-surface 网格。
// 这些网格必须参与贴地管线渲染，但绝不能被相机控制器的 raycast 命中：
//   - shadow-volume 网格是数公里级挤出 box；拾取它会把相机固定到 maximumHeight 高度。
//   - debug-surface 是位于 debugSurfaceHeight(默认 5km)的调试可视化平面；
//     拾取它会把相机固定在该高度。
// Three.js Raycaster.intersect 只认 `layers`，不认 `visible`，所以隐藏网格若 layer 仍匹配
// 仍会参与 raycast。把这些网格放到非默认 layer 后，demo 默认 raycaster(layer 0)会跳过它们；
// 宿主相机需调用 `camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER )` 保持渲染可见。
// 相机侧接入见 ground-demo.ts。
export const CESIUM_GROUND_NON_PICKABLE_LAYER = 1;
