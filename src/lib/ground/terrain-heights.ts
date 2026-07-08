// ============================================================
// terrain-heights.ts
// 层级:Cesium-to-Three 贴地适配器地形高度初始化（去 Cesium 源码依赖版）。
// 职责:在不引入任何 Cesium 运行时的前提下,提供与 Cesium
//      `ApproximateTerrainHeights.getMinimumMaximumHeights` 行为一致的
//      瓦片级 min/max 地形高度查询,供 GroundPrimitive 风格几何在构造
//      shadow-volume 时确定挤出高度窗口,且无需运行时 fetch。
// 依赖:
//   - 本地 math/* 椭球函数(cartographicToCartesian / scaleToGeodeticSurface)
//   - 随包地形高度表 assets/approximate-terrain-heights.json
//   - constants.ts 的默认高度
//   - three 的 Vector3(纯几何运算,无 GIS 语义)
// 被消费:primitives.ts 与公开贴地适配器入口。
//
// ── 与旧版的差异(去 Cesium) ──
//   旧版 import 了 Cesium 的 ApproximateTerrainHeights.js / Ellipsoid.js /
//   Rectangle.js,经传递依赖拉入 ~73 个 Cesium Core 源文件 + mersenne-twister
//   + urijs。本版把所需算法（GeographicTilingScheme.positionToTileXY +
//   getTileXYLevel + getMinimumMaximumHeights 的对角中点修正）以纯 TS 复现,
//   并复用本项目已有的 math/ellipsoid 椭球函数。数值与分支与 Cesium 原算法
//   逐项对齐,因此在任意输入下返回相同的 min/max。
//
// ── 算法来源(仅作对照,无代码依赖) ──
//   Cesium Source/Core/ApproximateTerrainHeights.js
//   Cesium Source/Core/GeographicTilingScheme.js#positionToTileXY
// ============================================================

import { Vector3 } from 'three';

import {
	APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
} from './constants';
import { createCartographic, type Cartographic } from './math/cartographic';
import {
	cartographicToCartesian,
	scaleToGeodeticSurface,
} from './math/ellipsoid';
import type { LonLatPoint, RectangleDegrees } from './types';

// 随包地形高度表:`"{level}-{x}-{y}" -> [minHeight(m), maxHeight(m)]`。
// 与 Cesium 官方 approximateTerrainHeights.json 同构(level 0..6,约 1.1 万条),
// 由 Cesium World Terrain 预计算得到。运行时只读,不修改。
import approximateTerrainHeightsJson from './assets/approximate-terrain-heights.json';

// ── 与 Cesium ApproximateTerrainHeights 对齐的常量 ──
// 这三个常量必须与 Cesium 内部值完全一致,否则越界 / 无表项 / 退化情形下
// 返回的兜底高度会与原实现不同,进而改变 shadow-volume 的挤出范围。
/** 高度表的最深层级。Cesium `_terrainHeightsMaxLevel`。 */
const TERRAIN_HEIGHTS_MAX_LEVEL = 6;
/** 兜底最小高度(m)。Cesium `_defaultMinTerrainHeight`,本项目常量与之相等(-100000)。 */
const DEFAULT_MIN_TERRAIN_HEIGHT = APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT;
/** 兜底最大高度(m)。Cesium `_defaultMaxTerrainHeight`,本项目常量与之相等(9000)。 */
const DEFAULT_MAX_TERRAIN_HEIGHT = APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT;

// ── 全球 GeographicTilingScheme 参数(平面卡雷 / equirectangular) ──
// 对应 Cesium `new GeographicTilingScheme()` 的默认配置:
// 覆盖矩形 = Rectangle.MAX_VALUE = [-π, -π/2, π, π/2](弧度),
// level-0 在 X 方向 2 块、Y 方向 1 块。瓦片是经纬度直接线性切分。
const TILING_WEST = -Math.PI; // 覆盖区西边界(rad)
const TILING_SOUTH = -Math.PI / 2.0; // 覆盖区南边界(rad)
const TILING_EAST = Math.PI; // 覆盖区东边界(rad)
const TILING_NORTH = Math.PI / 2.0; // 覆盖区北边界(rad)
const TILING_WIDTH = TILING_EAST - TILING_WEST; // 2π
const TILING_HEIGHT = TILING_NORTH - TILING_SOUTH; // π
const LEVEL_ZERO_TILES_X = 2; // numberOfLevelZeroTilesX
const LEVEL_ZERO_TILES_Y = 1; // numberOfLevelZeroTilesY

/** 度 → 弧度换算因子。 */
const RADIANS_PER_DEGREE = Math.PI / 180.0;

/**
 * 把地形高度表收窄为只读 `[min, max]` 元组映射,便于类型检查。
 * JSON 顶层是普通对象,这里用一次断言固化形状。
 */
const terrainHeights = approximateTerrainHeightsJson as unknown as Readonly<
	Record<string, readonly [number, number]>
>;

/**
 * 适配器同步返回的 min/max 高度对。
 */
export interface TerrainMinMaxHeights {
	minimumTerrainHeight: number;
	maximumTerrainHeight: number;
}

/** `getTileXYLevel` 命中时返回的瓦片坐标 + 层级。 */
interface TileXYLevel {
	x: number;
	y: number;
	level: number;
}

let initialized = false;

// ── 模块级 scratch(零 GC:复用同一批对象,避免每次查询都分配) ──
// 注意:`getMinimumMaximumHeights` 在一次调用内先把 NE、SW 两个角分别
// 转成 ECEF,再求中点——NE 转完即被 cartographicToCartesian 消费,因此
// 一个 Cartographic scratch 足够顺序复用。
const scratchCorner: Cartographic = createCartographic();
const scratchCartesianNE = new Vector3();
const scratchCartesianSW = new Vector3();
const scratchCenter = new Vector3();
const scratchSurface = new Vector3();

/**
 * 计算某个地理位置在指定层级所属的瓦片 X/Y。
 *
 * 完整复刻 Cesium `GeographicTilingScheme.positionToTileXY`(默认全球配置)。
 * 由于覆盖矩形是 Rectangle.MAX_VALUE(east > west,不跨 IDL),原实现中
 * "east < west 时 longitude += 2π" 的反子午线分支在此恒为假,故省略。
 *
 * @param longitude 经度,弧度。
 * @param latitude  纬度,弧度。
 * @param level     瓦片层级(0 最粗)。
 * @returns 瓦片 `{x, y}`;位置落在覆盖矩形之外时返回 undefined(对应
 *          Cesium `Rectangle.contains` 为 false 的情形)。
 */
function positionToTileXY(
	longitude: number,
	latitude: number,
	level: number,
): { x: number; y: number } | undefined {
	// Rectangle.contains:位置必须在覆盖矩形内,否则该瓦片方案无法定位它。
	if (
		longitude < TILING_WEST ||
		longitude > TILING_EAST ||
		latitude < TILING_SOUTH ||
		latitude > TILING_NORTH
	) {
		return undefined;
	}

	// 该层级的瓦片数 = level-0 瓦片数 << level(每升一级，每个轴翻倍）。
	const xTiles = LEVEL_ZERO_TILES_X << level;
	const yTiles = LEVEL_ZERO_TILES_Y << level;

	const xTileWidth = TILING_WIDTH / xTiles;
	const yTileHeight = TILING_HEIGHT / yTiles;

	// X:从西边界起按瓦片宽度取整。Cesium 用 `| 0`(向零取整);
	// 这里 (longitude - west) ≥ 0 恒成立,故 Math.floor 与 `| 0` 等价,
	// 且不受 `| 0` 的 32 位溢出限制(瓦片号远小于 2^31)。
	let xTileCoordinate = Math.floor((longitude - TILING_WEST) / xTileWidth);
	if (xTileCoordinate >= xTiles) {
		xTileCoordinate = xTiles - 1; // 落在最东边界上时夹到最后一块
	}

	// Y:从北边界向下按瓦片高度取整(瓦片行号自北向南递增)。
	let yTileCoordinate = Math.floor((TILING_NORTH - latitude) / yTileHeight);
	if (yTileCoordinate >= yTiles) {
		yTileCoordinate = yTiles - 1; // 落在最南边界上时夹到最后一行
	}

	return { x: xTileCoordinate, y: yTileCoordinate };
}

/**
 * 找到「矩形四个角同属一个瓦片」的最深层级,返回该瓦片坐标与层级。
 *
 * 完整复刻 Cesium `ApproximateTerrainHeights.getTileXYLevel`:
 * 从 level 0 向 level 6 逐级尝试,只要四角仍落在同一 (x, y) 瓦片就继续加深;
 * 一旦某级四角分属不同瓦片(或越界),就停在上一成功级。
 *
 * 与原实现的唯一行为差异:原实现里 `positionToTileXY` 越界时返回 undefined
 * 并保留 scratch 旧值,可能产生与"四角不一致"等价的失败;本版把越界显式视为
 * 失败(break)。两者在所有四角都在覆盖矩形内的现实输入下结果完全相同
 * (本适配器只用真实经纬度构造查询,故恒在界内)。
 *
 * @param west  矩形西边界(rad)
 * @param south 矩形南边界(rad)
 * @param east  矩形东边界(rad)
 * @param north 矩形北边界(rad)
 * @returns 命中瓦片 `{x, y, level}`;连 level 0 都无法令四角一致时返回 undefined。
 */
function getTileXYLevel(
	west: number,
	south: number,
	east: number,
	north: number,
): TileXYLevel | undefined {
	// 四角顺序与 Cesium scratchCorners 一致:NE、NW、SE、SW。
	// 顺序本身不影响结果(只比较是否全相等),但保持一致便于对照。
	const cornerLon = [east, west, east, west];
	const cornerLat = [north, north, south, south];

	let lastLevelX = 0;
	let lastLevelY = 0;
	let currentX = 0;
	let currentY = 0;

	let level: number;
	for (level = 0; level <= TERRAIN_HEIGHTS_MAX_LEVEL; ++level) {
		let failed = false;

		for (let j = 0; j < 4; ++j) {
			const tile = positionToTileXY(cornerLon[j], cornerLat[j], level);
			if (tile === undefined) {
				// 角点越界:无法在该级定位 → 视为四角不一致。
				failed = true;
				break;
			}
			if (j === 0) {
				currentX = tile.x;
				currentY = tile.y;
			} else if (currentX !== tile.x || currentY !== tile.y) {
				// 某角与第一个角不在同一瓦片 → 本级失败。
				failed = true;
				break;
			}
		}

		if (failed) {
			break;
		}

		// 本级四角一致,记录为目前已知的最深命中。
		lastLevelX = currentX;
		lastLevelY = currentY;
	}

	// level === 0 表示连最粗一级都失败(四角分属 level-0 的两块,
	// 多见于 micro-bbox 恰好横跨经度 0° 的 level-0 X 边界)→ 无可用瓦片。
	if (level === 0) {
		return undefined;
	}

	return {
		x: lastLevelX,
		y: lastLevelY,
		// 循环正常跑完时 level = maxLevel + 1,命中级即 maxLevel;
		// 中途 break 时命中级是 level - 1(最后一次成功的级）。
		level: level > TERRAIN_HEIGHTS_MAX_LEVEL ? TERRAIN_HEIGHTS_MAX_LEVEL : level - 1,
	};
}

/**
 * 复刻 Cesium `ApproximateTerrainHeights.getMinimumMaximumHeights`。
 *
 * 步骤:
 *   1. `getTileXYLevel` 找到四角同属的最深瓦片,查表得到该瓦片的 [min, max]。
 *   2. **对角中点修正 min**:矩形 NE↔SW 连成的直线弦的中点位于椭球面之下,
 *      其到椭球面的距离 = 这块瓦片几何上能"下凹"到椭球面以下的量。把它取负
 *      并与表 min 取较小者,确保 shadow-volume 底部足够低,覆盖瓦片的最低几何点。
 *   3. 用 `_defaultMinTerrainHeight` 对 min 做下限钳制。
 *
 * @param west  矩形西边界(rad)
 * @param south 矩形南边界(rad)
 * @param east  矩形东边界(rad)
 * @param north 矩形北边界(rad)
 * @returns 该矩形的最小 / 最大地形高度(m)。
 */
function getMinimumMaximumHeights(
	west: number,
	south: number,
	east: number,
	north: number,
): TerrainMinMaxHeights {
	const xyLevel = getTileXYLevel(west, south, east, north);

	let minTerrainHeight = DEFAULT_MIN_TERRAIN_HEIGHT;
	let maxTerrainHeight = DEFAULT_MAX_TERRAIN_HEIGHT;

	if (xyLevel !== undefined) {
		// ① 查表
		const key = `${xyLevel.level}-${xyLevel.x}-${xyLevel.y}`;
		const heights = terrainHeights[key];
		if (heights !== undefined) {
			minTerrainHeight = heights[0];
			maxTerrainHeight = heights[1];
		}

		// ② 对角中点到椭球面的距离修正 min。
		// NE 角 → ECEF
		scratchCorner.longitude = east;
		scratchCorner.latitude = north;
		scratchCorner.height = 0.0;
		cartographicToCartesian(scratchCorner, scratchCartesianNE);
		// SW 角 → ECEF(复用同一 Cartographic scratch)
		scratchCorner.longitude = west;
		scratchCorner.latitude = south;
		scratchCorner.height = 0.0;
		cartographicToCartesian(scratchCorner, scratchCartesianSW);

		// 弦中点 = (NE + SW) / 2 —— 等价于 Cesium Cartesian3.midpoint。
		scratchCenter
			.addVectors(scratchCartesianSW, scratchCartesianNE)
			.multiplyScalar(0.5);

		const surface = scaleToGeodeticSurface(scratchCenter, scratchSurface);
		if (surface !== undefined) {
			const distance = scratchCenter.distanceTo(surface);
			// 弦中点在椭球面下方 distance 米 → 该瓦片最低可达 -distance。
			minTerrainHeight = Math.min(minTerrainHeight, -distance);
		} else {
			// 中点恰在椭球中心附近(理论上不会发生于地表瓦片)→ 退回兜底。
			minTerrainHeight = DEFAULT_MIN_TERRAIN_HEIGHT;
		}
	}

	// ③ 下限钳制:min 不得低于兜底最小高度。
	minTerrainHeight = Math.max(DEFAULT_MIN_TERRAIN_HEIGHT, minTerrainHeight);

	return {
		minimumTerrainHeight: minTerrainHeight,
		maximumTerrainHeight: maxTerrainHeight,
	};
}

/**
 * 启用地形高度查询。
 *
 * 去 Cesium 后高度表已随包静态导入,本函数不再发起任何异步 fetch,也不再向
 * Cesium 全局对象注入数据;它只是一个幂等的"就绪"开关,以保留旧版"必须先
 * initialize 再查询"的契约——在调用本函数前,查询函数一律返回兜底范围。
 * 可从多个入口安全重复调用。
 */
export function initializeApproximateTerrainHeights(): void {
	if (initialized) {
		return;
	}
	initialized = true;
}

/**
 * 报告适配器是否已经启用地形高度表。
 */
export function isApproximateTerrainHeightsReady(): boolean {
	return initialized;
}

/**
 * 查询地理矩形内按瓦片对齐的 min/max 地形高度。
 * 若尚未 initialize,则返回兜底范围,保证调用方总能得到可用的 shadow-volume
 * 高度窗口,而不是抛错。
 *
 * **仅适合矩形图元。** 对多边形(含箭头),优先使用
 * {@link getTerrainMinMaxHeightsForPolygon}:多边形 bbox 可能远大于真实覆盖范围,
 * 且瓦片查询算法在 bbox 跨越瓦片边界时会回退到更粗瓦片(= 更大地理区域,
 * 可能包含远处高峰)。逐顶点采样版本通过 micro-bbox 查询避免该回退,每次查询
 * 都落在单个最深层瓦片内。
 *
 * @param rectangleDegrees WGS84 度制标绘矩形。
 * @returns 最小与最大地形高度,单位米。
 */
export function getTerrainMinMaxHeightsForRectangle(
	rectangleDegrees: RectangleDegrees,
): TerrainMinMaxHeights {
	if (!initialized) {
		return {
			minimumTerrainHeight: DEFAULT_MIN_TERRAIN_HEIGHT,
			maximumTerrainHeight: DEFAULT_MAX_TERRAIN_HEIGHT,
		};
	}

	const result = getMinimumMaximumHeights(
		rectangleDegrees.west * RADIANS_PER_DEGREE,
		rectangleDegrees.south * RADIANS_PER_DEGREE,
		rectangleDegrees.east * RADIANS_PER_DEGREE,
		rectangleDegrees.north * RADIANS_PER_DEGREE,
	);

	return {
		minimumTerrainHeight: Number.isFinite(result.minimumTerrainHeight)
			? result.minimumTerrainHeight
			: DEFAULT_MIN_TERRAIN_HEIGHT,
		maximumTerrainHeight: Number.isFinite(result.maximumTerrainHeight)
			? result.maximumTerrainHeight
			: DEFAULT_MAX_TERRAIN_HEIGHT,
	};
}

/**
 * 多边形逐顶点采样使用的 micro-bbox 半边长,单位度。
 *
 * 该值被选为**远小于**随包高度表中最深瓦片尺寸(level 6,每边 2.8125°)。
 * 这个半边长在赤道约为 5.6 cm,因此任意采样点周围查询矩形的 4 个角都能共享
 * 同一个 level-6 瓦片;`getTileXYLevel` 总能返回最深(最小)瓦片,得到局部
 * 瓦片 max,而不会因为意外跨边界被迫回退到粗瓦片。
 *
 * 为什么要这么小(而不只是"小"):瓦片查询要求查询矩形的**四个角**都在同一
 * 瓦片。如果采样点恰好落在瓦片边界上,即使 1e-3° 半边长也可能跨界。5e-7°
 * 半边长让四角几乎重合,从而保证任意采样都驻留在单瓦片内。
 */
const POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES = 5e-7;

/**
 * 查询多边形内部按瓦片对齐的 min/max 地形高度,同时避免
 * `getTerrainMinMaxHeightsForRectangle` 在细长/弯曲形状上产生的 bbox 回退偏差。
 *
 * **为什么 bbox 路径不适合多边形**:
 *   瓦片查询会寻找四角共享同一瓦片的最深层级并返回该层级瓦片的 min/max。
 *   当矩形跨越深层瓦片边界时,算法会回退到更浅(= 地理范围更大)的瓦片,
 *   返回的 max 就变成该**更大**区域内的最大值。
 *
 *   demo 案例(珠穆朗玛峰,纬度 27.988°):level-5 纬度边界正好在 28.125°。
 *   若一个曲线箭头顶点横跨 28.10°..28.15°,就会跨过该边界,回退到 level 4
 *   (11.25° × 11.25°,约半个青藏高原),返回的 max 包含 8848m 的珠峰,
 *   即使箭头本身从未触及该高峰。随后箭头 shadow volume 会挤出到约 9km 高度,
 *   在典型缩放高度下被相机远裁剪面切掉,产生弯曲填充截断伪影。
 *
 * **修复方式**:在每个多边形顶点处使用 **micro-bbox** 采样,使每次查询矩形都
 * 足够小,始终位于单个 level-6 瓦片内。然后对所有样本取逐项 min/max。
 *
 * **仍可能遗漏的情况**:某个高峰位于两个顶点之间,且所在 level-6 瓦片没有被
 * 任何顶点触及。对典型标绘多边形(箭头 ≤ 50 顶点,最大边长远小于 level-6 瓦片
 * 宽度 313 km),顶点集已足够密集,实践中无需担心;若需更严格覆盖,可在传入前
 * 预加密多边形。
 *
 * @param points WGS84 度制多边形环顶点,至少 1 个。
 * @returns 逐顶点样本的逐项 min/max;若没有样本或尚未 initialize,则回退到默认范围。
 */
export function getTerrainMinMaxHeightsForPolygon(
	points: readonly LonLatPoint[],
): TerrainMinMaxHeights {
	if (!initialized || points.length === 0) {
		return {
			minimumTerrainHeight: DEFAULT_MIN_TERRAIN_HEIGHT,
			maximumTerrainHeight: DEFAULT_MAX_TERRAIN_HEIGHT,
		};
	}

	const halfSide = POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES;
	let minTerrainHeight = Number.POSITIVE_INFINITY;
	let maxTerrainHeight = Number.NEGATIVE_INFINITY;

	for (let i = 0; i < points.length; i++) {
		const lon = points[i][0];
		const lat = points[i][1];

		// 以顶点为中心的 micro-rectangle(度 → 弧度后传入)。四角彼此仅相距
		// 1e-6°,远小于任意 level-6 瓦片宽度(2.8125°),因此 getTileXYLevel
		// 会解析到 level 6,得到该顶点所在最深瓦片的局部 max。
		const result = getMinimumMaximumHeights(
			(lon - halfSide) * RADIANS_PER_DEGREE,
			(lat - halfSide) * RADIANS_PER_DEGREE,
			(lon + halfSide) * RADIANS_PER_DEGREE,
			(lat + halfSide) * RADIANS_PER_DEGREE,
		);

		if (Number.isFinite(result.minimumTerrainHeight)) {
			if (result.minimumTerrainHeight < minTerrainHeight) {
				minTerrainHeight = result.minimumTerrainHeight;
			}
		}
		if (Number.isFinite(result.maximumTerrainHeight)) {
			if (result.maximumTerrainHeight > maxTerrainHeight) {
				maxTerrainHeight = result.maximumTerrainHeight;
			}
		}
	}

	if (!Number.isFinite(minTerrainHeight)) {
		minTerrainHeight = DEFAULT_MIN_TERRAIN_HEIGHT;
	}
	if (!Number.isFinite(maxTerrainHeight)) {
		maxTerrainHeight = DEFAULT_MAX_TERRAIN_HEIGHT;
	}

	return {
		minimumTerrainHeight: minTerrainHeight,
		maximumTerrainHeight: maxTerrainHeight,
	};
}
