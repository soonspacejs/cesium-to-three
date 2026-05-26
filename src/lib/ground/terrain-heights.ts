// ============================================================
// terrain-heights.ts
// 层级:Cesium-to-Three 贴地适配器地形高度初始化。
// 职责:向 Cesium ApproximateTerrainHeights 注入随包携带的 approximateTerrainHeights.json，
//      使 GroundPrimitive 风格几何在构造 shadow-volume 时无需运行时 fetch，
//      也能查询瓦片级 min/max 高度。
// 依赖:未改动的 Cesium ApproximateTerrainHeights + 随包 JSON。
// 被消费:primitives.ts 与公开贴地适配器入口。
// ============================================================

// @ts-ignore Cesium 源码有意保持为未改动 JavaScript。
import ApproximateTerrainHeights from '../../../cesium-ground-source/engine/Source/Core/ApproximateTerrainHeights.js';
// @ts-ignore Cesium 源码有意保持为未改动 JavaScript。
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium 源码有意保持为未改动 JavaScript。
import Rectangle from '../../../cesium-ground-source/engine/Source/Core/Rectangle.js';
import approximateTerrainHeightsJson from '../../../cesium-ground-source/engine/Source/Assets/approximateTerrainHeights.json';

import {
	APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
} from './constants';
import type { LonLatPoint, RectangleDegrees } from './types';

/**
 * 适配器同步返回的 min/max 高度对。
 */
export interface TerrainMinMaxHeights {
	minimumTerrainHeight: number;
	maximumTerrainHeight: number;
}

let initialized = false;

/**
 * 将随包携带的 approximateTerrainHeights.json 注入 Cesium ApproximateTerrainHeights，
 * 且不触发其异步 Resource.fetchJson 路径。该函数幂等，可从多个入口安全调用。
 */
export function initializeApproximateTerrainHeights(): void {
	if ( initialized ) {
		return;
	}

	ApproximateTerrainHeights._terrainHeights = approximateTerrainHeightsJson;
	// 匹配 resolved promise 契约：即便调用方防御性等待 initialize()，
	// 也会得到已 settled 的 promise，而不是通过 buildModuleUrl / Resource 发起网络请求。
	ApproximateTerrainHeights._initPromise = Promise.resolve();
	initialized = true;
}

/**
 * 报告适配器是否已经注入地形高度表。
 */
export function isApproximateTerrainHeightsReady(): boolean {
	return initialized;
}

const lookupRectangleScratch = new Rectangle();

/**
 * 查询地理矩形内按瓦片对齐的 Cesium ApproximateTerrainHeights min/max。
 * 如果高度表尚未初始化，则返回 Cesium 默认范围，保证调用方总能得到可用的
 * shadow-volume 高度窗口，而不是抛错。
 *
 * **仅适合矩形图元。** 对多边形(含箭头)，优先使用
 * {@link getTerrainMinMaxHeightsForPolygon}:多边形 bbox 可能远大于真实覆盖范围，
 * 且 Cesium 瓦片查询算法在 bbox 跨越瓦片边界时会回退到更粗瓦片
 * (= 更大地理区域，可能包含远处高峰)。逐顶点采样版本通过 micro-bbox 查询避免该回退，
 * 每次查询都落在单个最深层瓦片内。
 *
 * @param rectangleDegrees WGS84 度制标绘矩形。
 * @returns 最小与最大地形高度，单位米。
 */
export function getTerrainMinMaxHeightsForRectangle(
	rectangleDegrees: RectangleDegrees,
): TerrainMinMaxHeights {
	if ( ! initialized ) {
		return {
			minimumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
			maximumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
		};
	}

	const rectangle = Rectangle.fromDegrees(
		rectangleDegrees.west,
		rectangleDegrees.south,
		rectangleDegrees.east,
		rectangleDegrees.north,
		lookupRectangleScratch,
	);

	const result = ApproximateTerrainHeights.getMinimumMaximumHeights(
		rectangle,
		Ellipsoid.WGS84,
	) as TerrainMinMaxHeights;

	return {
		minimumTerrainHeight: Number.isFinite( result.minimumTerrainHeight )
			? result.minimumTerrainHeight
			: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
		maximumTerrainHeight: Number.isFinite( result.maximumTerrainHeight )
			? result.maximumTerrainHeight
			: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
	};
}

/**
 * 多边形逐顶点采样使用的 micro-bbox 半边长，单位度。
 *
 * 该值被选为**远小于**随包 ApproximateTerrainHeights 表中最深瓦片尺寸
 * (level 6，每边 2.8125°)。这个半边长在赤道约为 5.6 cm，因此任意采样点周围
 * 查询矩形的 4 个角都能共享同一个 level-6 瓦片；`getTileXYLevel` 总能返回
 * 最深(最小)瓦片，得到局部瓦片 max，而不会因为意外跨边界被迫回退到粗瓦片。
 *
 * 为什么要这么小(而不只是“小”)：Cesium 算法要求查询矩形的**四个角**都在同一瓦片。
 * 如果采样点恰好落在瓦片边界上，即使 1e-3° 半边长也可能跨界。5e-7° 半边长
 * 让四角几乎重合，从而保证任意采样都驻留在单瓦片内。
 */
const POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES = 5e-7;

/**
 * 查询多边形内部按瓦片对齐的 Cesium ApproximateTerrainHeights min/max，
 * 同时避免 `getTerrainMinMaxHeightsForRectangle` 在细长/弯曲形状上产生的
 * bbox 回退偏差。
 *
 * **为什么 bbox 路径不适合多边形**:
 *   Cesium 的 `ApproximateTerrainHeights.getMinimumMaximumHeights` 会调用
 *   `getTileXYLevel(rectangle)`，寻找**四个角共享同一瓦片的最深层级**，
 *   并返回该层级瓦片的 min/max。当矩形跨越深层瓦片边界时，算法会回退到更浅
 *   (= 地理范围更大)的瓦片，返回的 max 就变成该**更大**区域内的最大值。
 *
 *   demo 案例(珠穆朗玛峰，纬度 27.988°)：level-5 纬度边界正好在 28.125°。
 *   若一个曲线箭头顶点横跨 28.10°..28.15°，就会跨过该边界，回退到 level 4
 *   (11.25° x 11.25°，约半个青藏高原)，返回的 max 包含 8848m 的珠峰，
 *   即使箭头本身从未触及该高峰。随后箭头 shadow volume 会挤出到约 9km 高度，
 *   在典型缩放高度下被相机远裁剪面切掉，产生弯曲填充截断伪影。
 *
 * **修复方式**:在每个多边形顶点处使用 **micro-bbox** 采样，使每次查询矩形都足够小，
 * 始终位于单个 level-6 瓦片(随包表中的最深层级)内。然后对所有样本取逐项 min/max。
 * 得到的 max 只受多边形顶点**实际触及的 level-6 瓦片**约束，而不是受恰好包住
 * 整体 bbox 的浅层瓦片约束。
 *
 * **仍可能遗漏的情况**:某个高峰位于两个顶点之间，且所在 level-6 瓦片没有被任何顶点触及。
 * 对典型标绘多边形(箭头约 ≤ 50 个顶点，最大边长远小于 level-6 瓦片宽度 2.8125°
 * ≈ 313 km)，顶点集已经足够密集，能覆盖多边形进入的每个 level-6 瓦片，
 * 实践中无需担心。若后续调用方需要更严格覆盖，可在传入前预加密多边形
 * (例如通过 Catmull-Rom 细分)。
 *
 * @param points WGS84 度制多边形环顶点，至少 1 个。
 * @returns 逐顶点样本的逐项 min/max；若没有样本或高度表尚未初始化，则回退到适配器默认范围。
 */
export function getTerrainMinMaxHeightsForPolygon(
	points: readonly LonLatPoint[],
): TerrainMinMaxHeights {
	if ( ! initialized || points.length === 0 ) {
		return {
			minimumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT,
			maximumTerrainHeight: APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT,
		};
	}

	const halfSide = POLYGON_VERTEX_QUERY_HALF_SIDE_DEGREES;
	let minTerrainHeight = Number.POSITIVE_INFINITY;
	let maxTerrainHeight = Number.NEGATIVE_INFINITY;

	for ( let i = 0; i < points.length; i++ ) {
		const lon = points[ i ][ 0 ];
		const lat = points[ i ][ 1 ];

		// 构造以顶点为中心的 micro-rectangle。四角彼此仅相距 5e-7°，
		// 远小于任意 level-6 瓦片宽度(2.8125°)，因此 `getTileXYLevel`
		// 会解析到 level 6；除非顶点正好落在 level-6 瓦片边界上，
		// 此时 +ε/-ε 偏移会帮助消除歧义。
		const rectangle = Rectangle.fromDegrees(
			lon - halfSide,
			lat - halfSide,
			lon + halfSide,
			lat + halfSide,
			lookupRectangleScratch,
		);
		const result = ApproximateTerrainHeights.getMinimumMaximumHeights(
			rectangle,
			Ellipsoid.WGS84,
		) as TerrainMinMaxHeights;

		if ( Number.isFinite( result.minimumTerrainHeight ) ) {
			if ( result.minimumTerrainHeight < minTerrainHeight ) {
				minTerrainHeight = result.minimumTerrainHeight;
			}
		}
		if ( Number.isFinite( result.maximumTerrainHeight ) ) {
			if ( result.maximumTerrainHeight > maxTerrainHeight ) {
				maxTerrainHeight = result.maximumTerrainHeight;
			}
		}
	}

	if ( ! Number.isFinite( minTerrainHeight ) ) {
		minTerrainHeight = APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT;
	}
	if ( ! Number.isFinite( maxTerrainHeight ) ) {
		maxTerrainHeight = APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT;
	}

	return {
		minimumTerrainHeight: minTerrainHeight,
		maximumTerrainHeight: maxTerrainHeight,
	};
}
