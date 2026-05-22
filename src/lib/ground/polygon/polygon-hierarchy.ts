// ============================================================
// polygon/polygon-hierarchy.ts — Polygon hierarchy 数据结构 + plot-spec 适配
// 层级:L0(基于 math/ellipsoid 与 math/cartographic 的最薄适配层)
// 职责:定义 polygon "外环 + 洞" 的纯 Three.js 数据结构,
//      并提供从 plot-spec (LonLatPoint[] / holes?) 到内部
//      PolygonHierarchy(Vector3 ECEF)的转换。
//      所有校验(顶点数、有限性、WGS84 范围、跨 IDL / 极地)集中
//      在 normalizePolygonPoints 一处,保证下游模块不再处理非法输入。
// 依赖:Three.js Vector3,math/cartographic.ts,math/ellipsoid.ts,
//      constants.ts(MAX_POLYGON_STYLE_VERTICES),types.ts(LonLatPoint)
// 被消费:polygon-rings.ts、polygon-construct-extruded.ts、primitives.ts
// 算法对应:迁移自 primitives.ts:90-146(normalizePolygonPoints +
//          polygonHierarchyDegreesFromLonLatPoints),增加跨 IDL / 极地
//          校验(对应 R6),并把"度 → ECEF"一步到位(不经 Cesium 中间格式)。
// ============================================================

import { Vector3 } from 'three';

import { MAX_POLYGON_STYLE_VERTICES } from '../constants';
import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';
import type { LonLatPoint } from '../types';

/**
 * 已经过校验、用 Vector3 表达的 polygon 层次结构。
 *
 * - `positions` 是外环 ECEF 顶点(WGS84,米),按 plot-spec 输入顺序排列;
 *    winding(CCW/CW)在此阶段未校正,由下游 `polygon-rings.ts` 处理。
 * - `holes` 是 0..M 个洞环,每个洞自成一个 `positions: Vector3[]`。
 *
 * 与 Cesium `PolygonHierarchy` 形状一致(都有 `positions` + `holes` 字段),
 * 仅把 `Cesium.Cartesian3` 换成 Three.js `Vector3`(满足 `CartesianLike`
 * 接口约束 — 都有 .x .y .z 三个 number)。
 */
export interface PolygonHierarchy {
	/** 外环 ECEF 顶点(plot-spec 输入顺序;winding 由下游校正) */
	positions: Vector3[];

	/** 洞环 ECEF 顶点(可选;空数组与 undefined 等价,统一用 undefined) */
	holes?: { positions: Vector3[] }[];
}

/**
 * 校验并克隆 plot-spec 输入的 lon/lat 度坐标点序列。
 *
 * 校验项(逐字保留 primitives.ts:90-116 的现有逻辑,且新增 R6 跨 IDL / 极地保护):
 *   1. 至少 3 个点(凸 polygon 最小拓扑)
 *   2. 不超过 MAX_POLYGON_STYLE_VERTICES(着色器侧 style points uniform 槽位限制)
 *   3. 每个点 [lon, lat] 必须为有限 number
 *   4. 经度范围 [-180, 180],纬度范围 [-90, 90](WGS84 度坐标)
 *   5. (新增 R6)经度跨度 ≤ 180°(本期不支持跨国际日期变更线 polygon)
 *   6. (新增 R6)纬度不能恰为 ±90°(本期不支持覆盖极地 polygon)
 *
 * 校验通过后返回一个浅拷贝数组(每个点也是新数组),caller 可以安全持有
 * 与变更而不影响输入。
 *
 * @param points plot-spec 输入的 [lon, lat] 度坐标点序列。
 * @returns      与输入同 winding 的克隆数组。
 * @throws       任意校验项不通过时抛 Error。
 */
export function normalizePolygonPoints( points: readonly LonLatPoint[] ): LonLatPoint[] {
	if ( points.length < 3 ) {
		throw new Error(
			'Cesium ground polygon requires at least three lon/lat points.',
		);
	}
	if ( points.length > MAX_POLYGON_STYLE_VERTICES ) {
		throw new Error(
			`Cesium ground polygon supports at most ${ MAX_POLYGON_STYLE_VERTICES } points.`,
		);
	}

	// ── 第一遍:单点级校验 + 浅拷贝 + 记录经纬度极值 ──
	let lonMin = Number.POSITIVE_INFINITY;
	let lonMax = Number.NEGATIVE_INFINITY;
	let latMin = Number.POSITIVE_INFINITY;
	let latMax = Number.NEGATIVE_INFINITY;
	const cloned: LonLatPoint[] = new Array( points.length );

	for ( let i = 0; i < points.length; i++ ) {
		const longitude = points[ i ][ 0 ];
		const latitude = points[ i ][ 1 ];

		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
			throw new Error(
				'Cesium ground polygon points must contain finite lon/lat numbers.',
			);
		}
		if (
			longitude < -180.0 ||
			longitude > 180.0 ||
			latitude < -90.0 ||
			latitude > 90.0
		) {
			throw new Error(
				'Cesium ground polygon points must be valid WGS84 lon/lat degrees.',
			);
		}

		if ( longitude < lonMin ) { lonMin = longitude; }
		if ( longitude > lonMax ) { lonMax = longitude; }
		if ( latitude < latMin ) { latMin = latitude; }
		if ( latitude > latMax ) { latMax = latitude; }

		cloned[ i ] = [ longitude, latitude ];
	}

	// ── 第二遍:跨 IDL 与极地保护(R6) ──
	// 经度跨度 > 180° 通常意味着 polygon 跨过国际日期变更线(±180° 经线)。
	// Cesium 用 Stereographic 投影 + splitPolygonsOnEquator 处理这种情形,
	// 算法复杂且本期 demo 不需要,显式抛错而非默默给出错误结果。
	if ( lonMax - lonMin > 180.0 ) {
		throw new Error(
			'Cross-IDL polygons are not supported in this version of the ground primitive.',
		);
	}
	// 纬度恰为 ±90°(极地)时,EllipsoidTangentPlane 的"east 基底"无定义
	// (任何水平方向"既东又西"),本期显式拒绝。一般 GIS 数据极少包含极点顶点。
	if ( latMin === -90.0 || latMax === 90.0 ) {
		throw new Error(
			'Polar polygons (containing ±90° latitude vertices) are not supported in this version.',
		);
	}

	return cloned;
}

/**
 * 把一个 ring 的 [lon°, lat°] 点序列转为椭球面 ECEF Vector3 数组。
 *
 * 高度统一设 0(椭球面),逐点调用 `cartographicToCartesian` (math/ellipsoid)。
 * 每点产出新 Vector3,可以安全持有。
 *
 * @param normalizedPoints 已通过 normalizePolygonPoints 校验的 [lon, lat] 数组。
 * @returns                椭球面 ECEF Vector3 数组(每个 Vector3 独立实例)。
 */
function ringPointsToEcef( normalizedPoints: readonly LonLatPoint[] ): Vector3[] {
	// 模块内复用一个 Cartographic 即可 — cartographicToCartesian 内部只读
	// 输入而不持有引用。Vector3 输出每次新建,因为 caller 持有。
	const carto = createCartographic( 0.0, 0.0, 0.0 );
	const result: Vector3[] = new Array( normalizedPoints.length );

	for ( let i = 0; i < normalizedPoints.length; i++ ) {
		carto.longitude = normalizedPoints[ i ][ 0 ] * Math.PI / 180.0;
		carto.latitude = normalizedPoints[ i ][ 1 ] * Math.PI / 180.0;
		carto.height = 0.0;

		const out = new Vector3();
		cartographicToCartesian( carto, out );
		result[ i ] = out;
	}

	return result;
}

/**
 * 把 plot-spec (LonLatPoint[] + holes?) 一步转换为内部 `PolygonHierarchy`(Vector3 ECEF)。
 *
 * 这是 polygon 路径的"plot-spec 入口" — 把上层度坐标转为下游模块可直接消费的
 * 椭球面 ECEF 顶点数组,过程不经任何 Cesium 数据结构。
 *
 * 调用栈:
 *   1. normalizePolygonPoints(outer) → 5 项校验
 *   2. normalizePolygonPoints(每个 hole) → 同上校验
 *   3. ringPointsToEcef(outer) → Vector3 数组
 *   4. ringPointsToEcef(每个 hole) → Vector3 数组,封装成 { positions } 对象
 *   5. 拼装 hierarchy(holes 为空时不设字段,与 Cesium PolygonHierarchy 一致)
 *
 * @param points plot-spec 外环 lon/lat 度坐标。
 * @param holes  plot-spec 洞环 lon/lat 度坐标数组(可选,默认空)。
 * @returns      内部 PolygonHierarchy(Vector3 ECEF)。
 * @throws       任意 ring 校验不通过时抛 Error。
 */
export function polygonHierarchyFromLonLatPoints(
	points: readonly LonLatPoint[],
	holes: readonly ( readonly LonLatPoint[] )[] = [],
): PolygonHierarchy {
	const normalizedOuter = normalizePolygonPoints( points );
	const normalizedHoles = holes.map( ( hole ) => normalizePolygonPoints( hole ) );

	const outerPositions = ringPointsToEcef( normalizedOuter );
	const holesPositions = normalizedHoles.map( ( hole ) => ( {
		positions: ringPointsToEcef( hole ),
	} ) );

	const hierarchy: PolygonHierarchy = {
		positions: outerPositions,
	};
	if ( holesPositions.length > 0 ) {
		hierarchy.holes = holesPositions;
	}
	return hierarchy;
}
