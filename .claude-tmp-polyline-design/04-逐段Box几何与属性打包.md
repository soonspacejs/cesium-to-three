# 贴地线设计 · 04 逐段 Box 几何与属性打包

> 把 doc 03 的 `DensifiedLine`（bottom/top/cartographic/normals）拆成「每段 8 顶点 + 36 索引」的 box，并打包 5 个 vec4 描述符 + 位置（RTE）。这是贴地线几何的终点，产出 doc 05 VS 直接消费的 `BufferGeometry`。文件：`line/line-segment-attributes.ts`（打包）、`line/line-shadow-volume.ts`（facade）、`line/line-options.ts`（选项/默认/校验）。逐字对齐 Cesium `generateGeometryAttributes`。

---

## 1. 每段 = 8 顶点 box，但 box 本身不含线宽

每段（相邻两个密集点之间）生成一个 8 顶点、36 索引（12 三角形）的盒子。这个盒子是**贴线、横向宽度≈0、竖向 [minHeight,maxHeight] 的薄墙**：8 个角只是「沿 rightNormal 微推 ±EPSILON5 的退化盒」。**真正的线宽由 doc 05 VS 在屏幕空间运行时挤出**，doc 06 FS 用平面距离裁切。所以 box 的几何职责只有两个：① 占住「线可能投影到的屏幕像素」让 FS 跑起来；② 通过 8 个顶点携带「这条线段的完整解析描述」（起点 + 段向量 + 三平面 + 长度归一）。

段数与计数：

```
segmentCount = pointCount - 1
vertexCount  = segmentCount * 8
indexCount   = segmentCount * 36
indices 类型 = vertexCount > 65535 ? Uint32Array : Uint16Array
```

---

## 2. 8 顶点的角色与 sign 编码

8 个顶点（j = 0..7）通过两个 sign 编码自己是盒子的哪个角，VS/FS 据此决定挤出方向与上下：

```
rightPlaneSide = (j < 4) ? +1.0 : -1.0     // 前 4 个右侧，后 4 个左侧
topBottomSide  = (j ∈ {2,3,6,7}) ? +1.0 : -1.0   // 上沿 vs 下沿
```

位置写入顺序（每段 24 个 float = 8 点 × 3）：先右侧 4 角（沿 +rightNormal·EPSILON5 微推），再左侧 4 角（净 −rightNormal·EPSILON5）：

```
右侧（vec3sWriteIndex + 0..9）： startBottom, endBottom, endTop, startTop   (+nudge)
左侧（vec3sWriteIndex +12..21）：startBottom, endBottom, endTop, startTop   (−nudge)
```

> 顺序必须与 `REFERENCE_INDICES`（§5）严格对应，否则三角形朝向/盒子拓扑错乱。

---

## 3. 每段的几何描述符（逐字对齐 Cesium）

对第 i 段，记 `startBottom/startTop/endBottom/endTop`（doc 03 的 bottom/top 数组取相邻两点），`startGeometryNormal/endGeometryNormal`（normals 数组相邻两点）：

```
segmentLength3D = distance(startTop, endTop)
encodedStart    = RTE(startBottom)                       // {high: Vector3, low: Vector3}
forwardOffset   = endBottom - startBottom                // 段向量（Float32 三分量）
forward         = normalize(forwardOffset)
startUp         = normalize(startTop - startBottom)
rightNormal     = normalize(forward × startUp)           // 右平面法线
startPlaneNormal= normalize(startUp × startGeometryNormal)   // 起点斜接平面法线
endUp           = normalize(endTop - endBottom)
endPlaneNormal  = normalize(endGeometryNormal × endUp)       // 终点斜接平面法线
texNorm3D.x     = segmentLength3D / length3D              // 本段占全线长度比
texNorm3D.y     = lengthSoFar3D   / length3D              // 段起点的累计长度比
```

其中 `length3D` 是全线（所有段 top 距离之和，doc 03 之后预扫一遍）、`lengthSoFar3D` 是到本段起点累计长度（段循环里累加 `segmentLength3D`）。

### 3.1 miterBroken 状态机（段间传递）

逐字对齐 Cesium：段循环维护一个 `miterBroken` 布尔，跨段传递，对 start/end 法线做条件取反，保证斜接平面在被打断处正确翻面。

```
// 循环外初始化（取首段 end 法线；loop 时先按末段规则预判一次取反）
endGeometryNormal = normals[0]
if (loop) {
  preEndBottom = bottom[last-1]
  if (breakMiter(endGeometryNormal, preEndBottom, bottom[0], top[0]))
    endGeometryNormal = negate(endGeometryNormal)
}
miterBroken = false

for (i = 0; i < segmentCount; i++) {
  startBottom = endBottom(上一轮); startTop = endTop(上一轮)
  startGeometryNormal = clone(endGeometryNormal)
  if (miterBroken) startGeometryNormal = negate(startGeometryNormal)

  endBottom = bottom[i+1]; endTop = top[i+1]; endGeometryNormal = normals[i+1]
  miterBroken = breakMiter(endGeometryNormal, startBottom, endBottom, endTop)

  …计算 forward / rightNormal / startPlaneNormal / endPlaneNormal / texNorm3D …
  …打包 8 顶点（§4）…
  …写位置 box（§6）…
  lengthSoFar3D += segmentLength3D
}
```

---

## 4. 顶点属性打包（每段 8 顶点，逐字）

对每段，循环 `j = 0..7`，`vec4Index = vec4Write + j*4`，`wIndex = vec4Index + 3`：

| 属性数组（Float32，componentsPerAttribute=4） | xyz（vec4Index..+2） | w（wIndex） |
|---|---|---|
| `startHiAndForwardOffsetX` | `encodedStart.high` | `forwardOffset.x` |
| `startLoAndForwardOffsetY` | `encodedStart.low` | `forwardOffset.y` |
| `startNormalAndForwardOffsetZ` | `startPlaneNormal` | `forwardOffset.z` |
| `endNormalAndTextureCoordinateNormalizationX` | `endPlaneNormal` | `texNorm3D.x * rightPlaneSide` |
| `rightNormalAndTextureCoordinateNormalizationY` | `rightNormal` | `texcoordNormalization`（见下） |

`texcoordNormalization`（第 5 个属性的 w）含「上下 sign + 越界哨兵」：

```
texcoordNormalization = texNorm3D.y * topBottomSide
if (texcoordNormalization === 0.0 && topBottomSide < 0.0) texcoordNormalization = 9.0  // > 1.0 的哨兵
```

> 哨兵 `9.0` 的意义：当 `texNorm3D.y == 0`（首段起点）且该顶点在下沿（topBottomSide<0）时，乘积是 `-0.0`，无法区分「下沿 + 起点」与「上沿 + 起点」。写 `9.0`（任意 >1 值）让 VS/FS 通过 `y>1.0 || y<0.0` 判定「这是下沿顶点，需要向下延伸」，随后 VS 把它复原为 `0.0`（见 doc 05）。

`batchId` 属性（Float32，componentsPerAttribute=1）：全 0（线的宽度/颜色走 uniform，不走 batch table；保留属性是为与 VS 的 `in float batchId` 对齐，doc 05 的 `v_endPlaneNormalEcAndBatchId.w` 仅作占位）。

---

## 5. 索引（每段 36，逐字 `REFERENCE_INDICES`）

```typescript
const REFERENCE_INDICES = [
  0,2,1, 0,3,2,   // right
  0,7,3, 0,4,7,   // start
  0,5,4, 0,1,5,   // bottom
  5,7,4, 5,6,7,   // left
  5,2,6, 5,1,2,   // end
  3,6,2, 3,7,6,   // top
];                // 36 个，12 三角形 = 一个盒子
// 第 i 段：indices[i*36 + k] = REFERENCE_INDICES[k] + i*8
```

> 这套绕序配合 §2 的 8 顶点位置顺序，使盒子以「反绕」呈现——doc 07 用 `side: BackSide`（cull 正面、画背面）正好对应 Cesium「geometry is inverted, draw backfaces」，保证相机进入盒子内部时仍有面覆盖。

---

## 6. 位置写入（box 8 角 + adjustHeights + nudge，逐字）

每段先把标准墙（minHeight=0/maxHeight=1000）按真实窗口 `adjustHeights` 推到位，再沿 rightNormal 微推两份（右 +EPSILON5、左 −EPSILON5），并 `nudgeXZ` 避开 XZ 平面：

```
// 1) adjustHeights：把 [0,1000] 墙推到 [minHeightSeg, maxHeightSeg]
adjustHeights(startBottom, startTop, minHeightSeg, maxHeightSeg, aStartB, aStartT)
adjustHeights(endBottom,   endTop,   minHeightSeg, maxHeightSeg, aEndB,   aEndT)

// 2) 右侧 4 角：沿 +rightNormal·EPSILON5 微推
normalNudge = rightNormal · EPSILON5
aStartB += normalNudge; aEndB += normalNudge; aStartT += normalNudge; aEndT += normalNudge
nudgeXZ(aStartB, aEndB); nudgeXZ(aStartT, aEndT)
pack: position[+0]=aStartB, [+3]=aEndB, [+6]=aEndT, [+9]=aStartT

// 3) 左侧 4 角：再沿 -2·rightNormal·EPSILON5（净 -EPSILON5）
normalNudge = rightNormal · (-2·EPSILON5)
aStartB += normalNudge; aEndB += normalNudge; aStartT += normalNudge; aEndT += normalNudge
nudgeXZ(aStartB, aEndB); nudgeXZ(aStartT, aEndT)
pack: position[+12]=aStartB, [+15]=aEndB, [+18]=aEndT, [+21]=aStartT
```

`adjustHeights`（逐字）：

```typescript
function adjustHeights(bottom, top, minHeight, maxHeight, outBottom, outTop): void {
  const n = normalize(top - bottom);                  // 标准墙竖直方向
  outBottom = bottom + n * (minHeight - WALL_INITIAL_MIN_HEIGHT);  // - 0
  outTop    = top    + n * (maxHeight - WALL_INITIAL_MAX_HEIGHT);  // - 1000
}
```

`nudgeXZ`（逐字，EPSILON2=1e-2，约 1cm 世界尺度）：

```typescript
function nudgeXZ(start: Vector3, end: Vector3): void {
  const dS = planePointDistance(XZ_PLANE, start);
  const dE = planePointDistance(XZ_PLANE, end);
  if (equalsEpsilon(dS, 0.0, EPSILON2)) {
    const off = direction(end, start, sOff).multiplyScalar(EPSILON2); start.add(off);
  } else if (equalsEpsilon(dE, 0.0, EPSILON2)) {
    const off = direction(start, end, sOff).multiplyScalar(EPSILON2); end.add(off);
  }
}
```

> `planePointDistance(XZ_PLANE, p) = p.y`（XZ 平面法线 (0,1,0)、过原点）。微推防止顶点恰好落在 XZ 平面上导致 GeometryPipeline 数值退化（Cesium 注释：比 GeometryPipeline 用的 epsilon 大，约 1cm）。

---

## 7. 高度窗口取值（`minHeightSeg` / `maxHeightSeg`）

Cesium 对每段查 `ApproximateTerrainHeights.getMinimumMaximumHeights(段外接矩形)` 得紧贴该段的 min/max。本项目**沿用 polygon/circle 的稳健策略：整条线统一窗口 `[-CESIUM_GLOBE_MINIMUM_ALTITUDE, +CESIUM_GLOBE_MINIMUM_ALTITUDE]`（±55km）**，理由见 `primitives.ts` polygon 构造器注释——紧贴窗口会被相机 far plane 切到，触发曲带伪影；±55km 在任何现实相机高度都落在视锥外，且 VS 的底部向下延伸（doc 05）会按视距动态覆盖真实地形起伏。

```typescript
const minHeightSeg = options.minimumHeight ?? -CESIUM_GLOBE_MINIMUM_ALTITUDE; // -55000
const maxHeightSeg = options.maximumHeight ??  CESIUM_GLOBE_MINIMUM_ALTITUDE; // +55000
// 校验：max > min，否则 max = min + 1
```

> 这不是简化：`adjustHeights` 仍逐段执行，只是 min/max 取统一值。`options.minimumHeight/maximumHeight` 暴露给高级用户做紧贴窗口（配合自定义 depth source 时）。**若未来要逐段紧贴，调 `getTerrainMinMaxHeightsForRectangle(段[lat,lon]外接矩形)`（terrain-heights.ts 已有）即可，接口已留。**

---

## 8. RTE 编码与装配（`line-segment-attributes.ts` 输出 → `line-shadow-volume.ts` 装配）

`buildSegmentBoxAttributes` 返回：

```typescript
export interface SegmentBoxAttributes {
  vertexCount: number;
  positions: Float64Array;       // box 8 角 ×段，扁平 [x,y,z,...]（已 adjust+nudge）
  startHiFwdX: Float32Array;     // vec4 ×顶点
  startLoFwdY: Float32Array;
  startNormFwdZ: Float32Array;
  endNormTexX: Float32Array;
  rightNormTexY: Float32Array;
  indices: Uint16Array | Uint32Array;
}
```

`line-shadow-volume.ts` facade：

```typescript
export function buildLineShadowVolumeGeometry(options: LineShadowVolumeOptions): BufferGeometry {
  // 1. 默认值 + 校验（line-options.ts）
  const o = resolveLineOptions(options);
  // 2. 预处理（doc 02）：归一→拆段→cartographic→去重
  const cartographics = preprocessLine(o.points, o.arcType);   // < 2 抛错
  // 3. 墙构建 + 法线（doc 02 加密 + doc 03 法线）
  const wall = buildWallArrays(cartographics, o.loop, o.arcType, o.granularity);
  // 4. 逐段 8 顶点 box 打包（本篇 §3-7）
  const seg = buildSegmentBoxAttributes(wall, o.minimumHeight, o.maximumHeight);
  // 5. 位置 RTE 编码（box 8 角 Float64 → high/low Float32）
  const { high, low } = encodePositionsToHighLowArrays(seg.positions);
  // 6. 装配 BufferGeometry（§9 属性契约）
  const g = new BufferGeometry();
  g.setAttribute('position3DHigh', new BufferAttribute(high, 3));
  g.setAttribute('position3DLow',  new BufferAttribute(low, 3));
  g.setAttribute('startHiAndForwardOffsetX',                   new BufferAttribute(seg.startHiFwdX, 4));
  g.setAttribute('startLoAndForwardOffsetY',                   new BufferAttribute(seg.startLoFwdY, 4));
  g.setAttribute('startNormalAndForwardOffsetZ',               new BufferAttribute(seg.startNormFwdZ, 4));
  g.setAttribute('endNormalAndTextureCoordinateNormalizationX',new BufferAttribute(seg.endNormTexX, 4));
  g.setAttribute('rightNormalAndTextureCoordinateNormalizationY',new BufferAttribute(seg.rightNormTexY, 4));
  g.setAttribute('batchId', new BufferAttribute(new Float32Array(seg.vertexCount), 1));
  g.setIndex(new BufferAttribute(seg.indices, 1));
  g.computeBoundingSphere();   // no-op（无 'position' 属性）；裁剪靠 mesh.frustumCulled=false
  return g;
}
```

---

## 9. 最终 BufferGeometry 属性契约（VS 输入，doc 05 据此声明 `in`）

| attribute | 类型 | comps | 语义 |
|---|---|---|---|
| `position3DHigh` | Float32 | 3 | box 8 角 RTE 高位 |
| `position3DLow` | Float32 | 3 | box 8 角 RTE 低位 |
| `startHiAndForwardOffsetX` | Float32 | 4 | `[RTE.high(startBottom), forwardOffset.x]` |
| `startLoAndForwardOffsetY` | Float32 | 4 | `[RTE.low(startBottom), forwardOffset.y]` |
| `startNormalAndForwardOffsetZ` | Float32 | 4 | `[startPlaneNormal, forwardOffset.z]` |
| `endNormalAndTextureCoordinateNormalizationX` | Float32 | 4 | `[endPlaneNormal, texNorm3D.x·rightSide]` |
| `rightNormalAndTextureCoordinateNormalizationY` | Float32 | 4 | `[rightNormal, texNorm3D.y·topBottomSide / 9.0哨兵]` |
| `batchId` | Float32 | 1 | 全 0 占位 |
| `index` | Uint16/32 | — | `REFERENCE_INDICES + 8·i` |

---

## 10. `line-options.ts`（内部选项/默认/校验）

```typescript
export interface LineShadowVolumeOptions {
  points: LonLatPoint[];       // 度
  loop?: boolean;              // 默认 false（2 点强制 false）
  arcType?: ArcType;           // 默认 GEODESIC
  granularity?: number;        // 默认 LINE_DEFAULT_GRANULARITY
  minimumHeight?: number;      // 默认 -CESIUM_GLOBE_MINIMUM_ALTITUDE
  maximumHeight?: number;      // 默认 +CESIUM_GLOBE_MINIMUM_ALTITUDE
}
export const LINE_DEFAULT_GRANULARITY = Math.PI / 180 / 32;
// resolveLineOptions：填默认 + 校验（points≥2、granularity>0、max>min→否则 max=min+1、
//                     loop&&points==2→loop=false），非法抛 GeoForgeError('LINE_OPTIONS_INVALID', …)
```

---

## 11. 边界与精度（本篇范围）

1. **顶点数 > 65535 自动 Uint32**（与 polygon 同策略），`buildSegmentBoxAttributes` 据 `vertexCount` 选索引类型。
2. **nudge 顺序**：右侧 +EPSILON5、左侧净 −EPSILON5（实现是 +EPSILON5 后再 −2·EPSILON5），与 Cesium 字节级一致；写反会让盒子退化为零厚度面、FS 采样不稳。
3. **miterBroken 跨段传递**：`startGeometryNormal` 取上一段的 end 法线并按 `miterBroken` 取反——这是拐角连续的关键，禁止每段独立重算。
4. **loop 首点预取反**：循环外 `if(loop) breakMiter(...) → negate`，与 doc 03 §4 呼应。
5. **length3D 预扫**：在段循环前先遍历 top 数组求全线长度（用于 texNorm 归一），`lengthSoFar3D` 在循环内累加。两者必须同口径（都用 top 距离）。
6. **computeBoundingSphere no-op**：几何无 `position` 属性，Three 的包围球为空；必须设 `mesh.frustumCulled = false`（doc 08），否则线被错误剔除。

---

## 12. 实现检查清单（doc 04）

- [ ] `REFERENCE_INDICES` 36 个、绕序与 §2 位置顺序一致。
- [ ] 每段几何描述符：forward/startUp/rightNormal/startPlaneNormal/endPlaneNormal/texNorm3D 全式，单位化。
- [ ] 5 个 vec4 打包逐项对齐表，`texcoordNormalization` 含 `9.0` 哨兵。
- [ ] `rightPlaneSide`(j<4) / `topBottomSide`(j∈{2,3,6,7}) 正确。
- [ ] 位置：adjustHeights → +EPSILON5 右 → 写 4 角 → −2·EPSILON5 左 → 写 4 角，每组前 nudgeXZ。
- [ ] miterBroken 状态机（含 loop 首点预取反、`startGeometryNormal` 条件取反）。
- [ ] length3D 预扫 + lengthSoFar3D 累加。
- [ ] facade 装配 9 个属性，索引类型按 vertexCount 选，computeBoundingSphere 后续靠 frustumCulled=false。
- [ ] `line-options.ts` 默认值/校验/2点强制非 loop。
- [ ] 单测：单段（8 顶点/36 索引）、三段折线（forwardOffset、平面法线、texNorm 累计）、loop 闭合（首尾相接）与 Cesium `GroundPolylineGeometry.createGeometry` 属性逐数组对拍。
