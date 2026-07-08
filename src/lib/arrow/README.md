# Arrow Module / 箭头标绘模块

> 路径:`src/lib/arrow/`
> 层级:L1(纯算法,零渲染依赖)
> 输出契约:`LonLatPoint[]`(闭合多边形,CCW,顶点 ≤ 120)
> 直接对接:`new CesiumGroundPolygonPrimitive({ points: arrowRing, ... })`

参考自 [cesium-plot-js](https://github.com/baoshugang/cesium-plot-js),重写并修复了
原版 `ArrowUtils.js` 中 "3 个控制点正常 / 4+ 个控制点绘制异常" 的核心 bug。

---

## 五种箭头

| 函数                              | 控制点数 | 形状                              |
| --------------------------------- | -------- | --------------------------------- |
| `createFineArrow`                 | 2        | 细箭头(起止两点)                |
| `createAssaultDirectionArrow`     | 2        | 窄长突击箭头                      |
| `createAttackArrow`               | 3+       | 宽体渐变攻击箭头                  |
| `createSwallowtailAttackArrow`    | 3+       | 燕尾攻击箭头(尾部 V 形凹口)    |
| `createCurvedArrow`               | 2+       | 沿平滑曲线的带状箭头(末端三角) |

**仅箭头,不包含**作战区(SquadCombat)、双箭头(DoubleArrow)等非箭头形状。

---

## 基本用法

```ts
import {
    createAttackArrow,
    createCurvedArrow,
} from '@/lib/arrow';
import { CesiumGroundPolygonPrimitive } from '@/lib/ground/primitives';

// 攻击箭头(4 个控制点)
const ring = createAttackArrow([
    [ 116.40, 39.90 ],   // tail-left
    [ 116.40, 39.92 ],   // tail-right
    [ 116.45, 39.91 ],   // 脊线中点
    [ 116.50, 39.91 ],   // 尖端
]);

const primitive = new CesiumGroundPolygonPrimitive({
    points: ring,
    fillColor: [ 1.0, 0.3, 0.0, 0.6 ],
    strokeWidth: 1.5,
} );
```

`ArrowPolygon` 即 `LonLatPoint[]`,可以直接作为
`CesiumGroundPolygonPrimitive` 构造选项的 `points` 字段——无需任何转换。

---

## API 速查

### `createFineArrow( p1, p2, options? )` — 2 点细箭头

```ts
interface FineArrowOptions {
    tailWidthFactor?:   number;  // 默认 0.10
    neckWidthFactor?:   number;  // 默认 0.20
    headWidthFactor?:   number;  // 默认 0.25
    headAngleRadians?:  number;  // 默认 π/8.5(~21°)
    neckAngleRadians?:  number;  // 默认 π/13 (~14°)
}
```

### `createAssaultDirectionArrow( p1, p2, options? )` — 2 点窄长突击箭头

```ts
interface AssaultDirectionArrowOptions {
    lengthScale?:       number;  // 默认 1.5  —— 整体放大
    tailWidthFactor?:   number;  // 默认 0.08
    neckWidthFactor?:   number;  // 默认 0.10
    headWidthFactor?:   number;  // 默认 0.13
    headAngleRadians?:  number;  // 默认 π/4 (= 45°)
    neckAngleRadians?:  number;  // 默认 0.558 rad
}
```

### `createAttackArrow( points, options? )` — 3+ 点攻击箭头

```ts
interface AttackArrowOptions {
    headHeightFactor?:           number;  // 默认 0.18
    headWidthFactor?:            number;  // 默认 0.30
    neckHeightFactor?:           number;  // 默认 0.85
    neckWidthFactor?:            number;  // 默认 0.15
    headTailFactor?:             number;  // 默认 0.80
    minBodyHalfAngleRadians?:    number;  // 默认 π/12 (= 15°)   ← 鲁棒性修复
    bodyWidthMargin?:            number;  // 默认 1.05            ← 鲁棒性修复
    bodySmoothingSegments?:      number;  // 默认 12
}
```

控制点契约:`points[0..1]` 决定尾部位置与宽度;`points[2..n]` 是脊线;
`points[n-1]` 是尖端。**最少 3 个,2 个时会退化为 `createFineArrow`**。

### `createSwallowtailAttackArrow( points, options? )` — 3+ 点燕尾攻击箭头

继承所有 `AttackArrowOptions`,新增:

```ts
interface SwallowtailAttackArrowOptions extends AttackArrowOptions {
    swallowtailFactor?:   number;  // 默认 1.0  —— 燕尾凸出深度倍率
    tailWidthFactor?:     number;  // 默认 0.10 —— 燕尾凸出参考宽度
}
```

体型完全与 AttackArrow 相同,**仅尾部多一个 V 形凹口**。`swallowtailFactor: 0`
退化为普通攻击箭头。

### `createCurvedArrow( points, options? )` — 2+ 点曲线箭头

```ts
interface CurvedArrowOptions {
    bodyWidthFactor?:            number;  // 默认 0.09  —— 体宽相对总弧长
    headWidthFactor?:            number;  // 默认 0.16  —— 头宽相对总弧长
    headLengthFactor?:           number;  // 默认 0.14  —— 头长相对总弧长
    neckWidthRelativeToHead?:    number;  // 默认 0.60  —— 颈宽相对头宽
    curveSmoothingSegments?:     number;  // 默认 16    —— Catmull-Rom 段采样
    bodyTaperRatio?:             number;  // 默认 0.0   —— 体部尾→颈渐窄比
}
```

**与 cesium-plot-js 的关键差异**:其 `CurvedArrow` 输出 `polyline`(折线),
本实现输出**闭合多边形**(带状箭头),以适配本项目仅有 polygon primitive 的渲染管线。

---

## 修复的 5 处 bug 对照表

针对原 `ArrowUtils.js` 移植自 cesium-plot-js v0.x 的实现:

| 编号  | 文件                                | 原 bug                                                            | 本模块修复                                                       |
| ----- | ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| **1** | `arrow-geometry.ts`/`azimuthBackward` | `asin + 四象限 if` 在轴对齐 / 零距离时产生 NaN,污染下游 | 用 `Math.atan2(dy, dx)` 一次性覆盖所有象限,重合点返回 0 |
| **2** | `attack-arrow.ts`/`computeArrowBodyPoints` | `w = (tw/2 - dropoff) / sin(halfAngle)` 在锐角时 sin → 0,w 爆炸 → 多边形外翻自交 | 三重 clamp:`sin ≥ sin(π/12)`、`w ≤ tailWidth/2 × 1.05`、`w ≥ neckWidth/2` |
| **3** | `arrow-curves.ts`/`centripetalCatmullRomSamples` | QBSpline 端点跳到 `(P0+P1)/2`,3 点时被掩盖,4+ 点时体部边线偏离尾部 | 用 Centripetal Catmull-Rom(α=0.5)替换,严格通过所有控制点 |
| **4** | `attack-arrow.ts`/`computeArrowHeadPoints` | `headWidth`/`neckWidth` 用未 clamp 的 `headHeight` 计算,头被压缩时翼宽相对过宽 | `headHeight` 二次 clamp 之后才计算 `headWidth`/`neckWidth` |
| **5** | `attack-arrow.ts`/拼接环节 | `leftPnts.last == headPnts[0]`(neckLeft 共享)产生连续重复顶点 → 零长边 | `leftSide.slice(0, -1)` 去尾,让 `headPnts` 唯一表达 neck |

**额外**:`isClockWise` 重写期保持与 cesium-plot-js 严格等价的判别式
(早期版本曾因符号反转导致 3 点直线箭头自交,见
`arrow-geometry.ts` 中函数注释的"修复历史")。

### 本模块自身的修复历史(非移植 bug)

| 编号  | 文件                                  | 原 bug                                                                                       | 修复                                                                                                                                |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **6** | `arrow-polygon.ts`/`clampVertexCount` | 均匀步进降采样在环 > 120 顶点时把头部 3 个**连续**特征顶点(headLeft/tip/headRight)整组抽掉 → 手绘钩形曲线箭头渲染成"平头无三角" | 特征保留式降采样:转角 ≥ 20° 的顶点(尖端/翼尖/尾角/燕尾凹口)无条件保留,预算只在平滑段内按比例分配(最大余数法)               |
| **7** | `shapes/curved-arrow.ts`              | 手绘上百控制点 → CR 密采样后环上千点,依赖环级降采样兜底(触发 bug 6)                       | 脊线**弧长均匀重采样**到 58 样本(环 ≤ 119),在偏移之前锁定顶点预算;同时滤掉手抖聚点,稳定切线与曲率估计                        |
| **8** | `shapes/curved-arrow.ts`              | headLength 沿弧长回退,钩形/回环末端急弯时颈点绕过弯曲段,三角头横穿体部自交                  | 头长按"末端累计转角 ≤ 45°"二次 clamp(下限 30% 头长),把头部锁在末端近直段内       |
| **9** | `arrow-curves.ts`/`trimLocalPolylineLoops` | Frenet 偏移边在 halfWidth ≈ 局部曲率半径处残留小自交环(曲率突变点的离散估计偏大)          | untrimmed offset → local trimming:近距离(≤ 6 段)线段对相交时用交点替换环段,curved / attack / swallowtail 三类箭头的偏移边共用 |
| **10** | `arrow-polygon.ts`/`resolveSelfIntersections` | 钩形 / 回环 / 回头脊线使带状体**全局自重叠**,单环自交 → earcut 渲染大面积错误填充             | 检测到自交时用 `polygon-clipping` 多边形**自并集**(nonzero 填充)解析为干净外环,取最大面积外环;非自交环零开销跳过(常规箭头无回归) |
| **11** | `shapes/curved-arrow.ts`(头部构造) | 头部翼尖与体颈衔接处出现凹口 / 描边突起,且左右翼不等长                                       | 对齐 cesium-plot-js 画法:头部严格关于"颈中心 → 尖端"轴对称构造(等腰三角 → **左右翼等长**),体部末端 K 个截面平滑旋转到该轴法线,使颈点与翼尖**沿同一射线共线**(纯径向外扩 → 零凹口) |

---

## 几何与算法笔记

- **`finalizePolygon`(arrow-polygon.ts)** 是每个 shape 函数最末一步,
  统一做去重 / CCW / 顶点降采样,确保输出永远符合
  `MAX_POLYGON_STYLE_VERTICES = 128` 的下游约束(本模块 clamp 到 120,留 8 余量)。
- **体部宽度三重 clamp** 是修复 4+ 点 bug 的核心,详见 `attack-arrow.ts`
  `computeArrowBodyPoints` 上方的注释。
- **Centripetal Catmull-Rom**(α=0.5)在 Yuksel et al. 2011 中证明无自交、
  无尖点,这是本模块用它替代 QBSpline 的根本原因。
- 所有几何计算都在 `[lng°, lat°]` 二维平面上完成(小尺度近似平面),
  不做地球球面投影修正——足够用于绘制尺寸 < 数千公里的标绘符号。

---

## 已知几何限制

以下两类输入是**所有"沿脊线偏移生成带状多边形"算法的固有限制**,
不是本实现的 bug:

### 1. 攻击箭头 / 燕尾箭头:脊线"折返"(hairpin)

输入示例:
```ts
createAttackArrow([
    [100, 30], [100, 30.05],
    [100.2, 30.025],   // 脊线向东延伸
    [100.10, 30.040],  // 然后向西折返(tip 在 mid 的西侧)
]);
```

折返点处,箭头体必须"通过自身"才能跟随脊线 → 输出多边形自交。

**建议**:绘制脊线时保持单调推进(spine 不回头)。若业务真的需要"绕圈"
的标绘,改用多段独立箭头拼接。

### 2. 曲线箭头:offset distance > 局部曲率半径(已自动兜底)

S 形等急转弯处,若体宽/2 > 局部曲率半径,带状偏移线会在弯曲内侧自交。
`createCurvedArrow` 内部有**四层防线**自动兜底:

1. **全局曲率限宽**:扫描整条脊线找最紧曲率半径,把体 / 颈 / 头宽以及
   头长**按同一比例**整体缩小到安全范围(≤ 0.5 × 曲率半径);
2. **脊线弧长重采样**(≤ 58 样本):滤掉手抖聚点,曲率估计不被单个抖动
   点拉爆,同时把输出环锁定在 ≤ 119 顶点(环级降采样永不触发);
3. **头长末端转角 clamp**(≤ 60° 累计转角):钩形/回环末端急弯时头部
   不会绕过弯曲段横穿体部;
4. **偏移边局部微环裁剪**:曲率突变点(直线直接衔接圆弧)残留的小自交
   环被精确剪掉。

因此急转弯 / 钩形 / 回环手绘输入下箭头会整体变细、头部按比例缩小,
但**头部三角永远存在且可见、多边形不自交**。

```ts
createCurvedArrow([
    [100.0, 30.0], [100.05, 30.10],
    [100.15, 29.95], [100.25, 30.05],   // S 形,latitude 摆动 ±0.075°
]);   // body 0.14 在 S 弯处会被自动 cap 到 ~0.085,形态平滑无自交
```

**可选**:若希望急转弯处仍保持较粗体部,可增加平滑控制点、放大曲率半径,
或显式调小 `bodyWidthFactor` 让限宽更少触发。

### 3. 曲线箭头:轨迹自身交叉(带状体全局重叠)

手绘轨迹若**自身交叉**(画"8 字"、画圈后穿过来时路径),带状体必然与
自身重叠 —— 单个 ≤ 120 顶点的简单多边形环在拓扑上无法表达这种形状,
重叠区在 earcut 三角化下渲染结果不确定(可能出现大块错误填充)。
彻底解决需要多边形布尔并集(引入 clipper 类依赖),当前版本不做。

**建议**:绘制时避免轨迹穿越自身;需要表达回环攻势时,用多段独立箭头。

---

## 集成示例

把箭头多边形直接喂给 ground primitive:

```ts
import { createAttackArrow } from '@/lib/arrow';
import { CesiumGroundPolygonPrimitive } from '@/lib/ground/primitives';

const controlPoints = [
    [ 116.30, 39.90 ],
    [ 116.30, 39.92 ],
    [ 116.40, 39.91 ],
    [ 116.50, 39.93 ],
    [ 116.60, 39.91 ],
];

const ring = createAttackArrow(controlPoints, {
    headHeightFactor: 0.20,            // 头部更长
    bodySmoothingSegments: 16,         // 体部更平滑(增加顶点数)
});

if (ring.length === 0) {
    console.warn('退化输入,无法生成箭头');
} else {
    const primitive = new CesiumGroundPolygonPrimitive({
        points: ring,
        fillColor: [1.0, 0.2, 0.0, 0.55],
        strokeColor: [0.5, 0.0, 0.0, 1.0],
        strokeWidth: 2.0,
    } );
    scene.add(primitive);
}
```

---

## 文件清单

```
arrow/
├── README.md                              ← 本文件
├── arrow-types.ts                         ← 公共类型 + 默认值常量
├── arrow-geometry.ts                      ← mathDistance / azimuthBackward / getThirdPoint 等基础几何
├── arrow-curves.ts                        ← Centripetal Catmull-Rom + cubic Bézier + 切线计算
├── arrow-polygon.ts                       ← 去重 / CCW / 顶点降采样 / finalizePolygon
├── index.ts                               ← 公共 API barrel
└── shapes/
    ├── fine-arrow.ts                      ← 2 点细箭头
    ├── assault-direction-arrow.ts         ← 2 点窄长突击
    ├── attack-arrow.ts                    ← 3+ 点攻击箭头(核心 bug 修复)
    ├── swallowtail-attack-arrow.ts        ← 3+ 点燕尾攻击(复用 attack-arrow 内部 helper)
    └── curved-arrow.ts                    ← 2+ 点曲线箭头(extruded polygon 版本)
```

依赖图(L0 = 零依赖,L1 = 依赖 L0,L2 = 模块出口):

```
arrow-types.ts (L0)
    ↑
arrow-geometry.ts (L0)
    ↑
arrow-curves.ts (L0, 还依赖 arrow-geometry)
arrow-polygon.ts (L0, 还依赖 arrow-types)
    ↑
shapes/*.ts (L1,均依赖 arrow-types/geometry/curves/polygon)
    ↑
index.ts (L2)
```
