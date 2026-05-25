// ============================================================
// rectangle/rectangle-helpers.ts — 度/米/弧度换算 + plot-spec 适配
// 层级:L3(基于 math/ + rectangle-radians 的组合)
// 职责:为 primitives.ts(CesiumGroundRectanglePrimitive)与 rectangle-extents
//      提供:
//        - rectangleDegreesFromLonLatPoints — plot-spec 4 lon/lat 点 → 度矩形
//        - rectangleDegreesFromCenterSizeMeters — (lon, lat, W, H) → 度矩形
//        - longitudeLatitudeFromCenterOffsetsMeters — 中心 + 偏移米 → 经纬度
//        - rectangleMeterSizeFromDegrees — 度矩形 → 米宽高
//        - expandRectangleDegreesThroughMeters — 度矩形按米向外扩
//      逻辑零改动,只是把 Cesium 数学依赖切换到 math/*。
// 依赖:Three.js Vector3 + Matrix4、math/cartographic.ts、math/ellipsoid.ts、
//      math/enu-frame.ts、math/matrix4-helpers.ts、math/wgs84-helpers.ts、
//      types.ts、constants.ts
// 被消费:primitives.ts、rectangle/rectangle-extents.ts
// 来源:迁移自 src/lib/ground/geometry.ts:261-547(逻辑零改动)
// ============================================================

import { Matrix4, Vector3 } from 'three';

import { BORDER_GEOMETRY_EXPANSION_SCALE } from '../constants';
import { createCartographic } from '../math/cartographic';
import {
	cartesianToCartographic,
	cartographicToCartesian,
} from '../math/ellipsoid';
import { eastNorthUpToFixedFrame } from '../math/enu-frame';
import { matrix4MultiplyByPoint } from '../math/matrix4-helpers';
import { wgs84PositionFromDegrees } from '../math/wgs84-helpers';
import type {
	EastNorthOffsetMeters,
	LonLatPoint,
	LongitudeLatitude,
	RectangleDegrees,
	RectangleMeterSize,
} from '../types';
import type { RectangleRadians } from './rectangle-radians';

// 度↔弧度常量,避免每次调用都重新乘法。
const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;

// 模块级 scratch:helper 函数在 demo 启动期被多次调用,复用以减少 GC。
const _helperCenterCarto = createCartographic();
const _helperCenterEcef = new Vector3();
const _helperEnuMatrix = new Matrix4();
const _helperInverseEnu = new Matrix4();
const _helperSampleEnu = new Vector3();
const _helperSampleEcef = new Vector3();
const _helperSampleCarto = createCartographic();
const _helperCornerCarto = createCartographic();
const _helperCornerEcef = new Vector3();

/**
 * Clamp 数值到 [min, max]。
 *
 * 提取出来便于在多个 helper 中复用(与 geometry.ts 旧实现等价)。
 *
 * @param value 输入。
 * @param min   下界。
 * @param max   上界。
 * @returns     钳制后的值。
 */
function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * 把 plot-spec `points: LonLatPoint[]`(4 个 [lon°, lat°])规整为
 * 轴对齐 RectangleDegrees(取 lon/lat min/max)。
 *
 * 公共 API 的入口校验函数(L5 → L5' 适配):
 *   - 必须正好 4 个点(throw)
 *   - 每个点 lon/lat 都必须是有限实数(throw)
 *   - lon ∈ [-180, 180],lat ∈ [-90, 90](throw)
 *   - 规整后必须 east > west 且 north > south(throw,拒绝退化矩形)
 *
 * 设计取舍:对真正轴对齐矩形(4 点恰好在 west/east × south/north 4 组合上)
 * 精确无损;对斜矩形会静默退化为 AABB。本期保留此行为,不引入旋转支持。
 *
 * 当前位置:迁移自 geometry.ts:363-395。
 *
 * @param points 4 个 [lon°, lat°] 角点(顺序任意)。
 * @returns      轴对齐 RectangleDegrees。
 * @throws       校验失败(点数 / 数值类型 / 范围 / 退化)。
 */
export function rectangleDegreesFromLonLatPoints(
	points: LonLatPoint[],
): RectangleDegrees {
	if ( points.length !== 4 ) {
		throw new Error( 'Cesium ground rectangle requires exactly four lon/lat points.' );
	}

	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( const point of points ) {
		const longitude = point[ 0 ];
		const latitude = point[ 1 ];

		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
			throw new Error(
				'Cesium ground rectangle points must contain finite lon/lat numbers.',
			);
		}
		if (
			longitude < -180.0 ||
			longitude > 180.0 ||
			latitude < -90.0 ||
			latitude > 90.0
		) {
			throw new Error(
				'Cesium ground rectangle points must be valid WGS84 lon/lat degrees.',
			);
		}

		west = Math.min( west, longitude );
		south = Math.min( south, latitude );
		east = Math.max( east, longitude );
		north = Math.max( north, latitude );
	}

	if ( east <= west || north <= south ) {
		throw new Error(
			'Cesium ground rectangle points must describe a non-degenerate rectangle.',
		);
	}

	return { west, south, east, north };
}

/**
 * 由 ENU 米平面 8 个采样点(4 角 + 4 边中点)反算度矩形。
 *
 * 私有 helper,被 `rectangleDegreesFromCenterSizeMeters` 与
 * `expandRectangleDegreesThroughMeters` 共用。逻辑:
 *   1. 在 center 处构建 ENU→ECEF 矩阵
 *   2. 把 8 个 ENU 米偏移点变换到 ECEF
 *   3. ECEF → cartographic → 经纬度,取 lon/lat min/max
 *   4. 钳制纬度到 ±89.999999 避免极点畸形
 *
 * @param centerLongitudeDegrees 中心经度,度。
 * @param centerLatitudeDegrees  中心纬度,度。
 * @param minX 最小 east 偏移,米。
 * @param maxX 最大 east 偏移,米。
 * @param minY 最小 north 偏移,米。
 * @param maxY 最大 north 偏移,米。
 * @returns    轴对齐度矩形。
 */
function rectangleDegreesFromEnuBounds(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): RectangleDegrees {
	_helperCenterCarto.longitude = centerLongitudeDegrees * DEG_TO_RAD;
	_helperCenterCarto.latitude = centerLatitudeDegrees * DEG_TO_RAD;
	_helperCenterCarto.height = 0.0;
	cartographicToCartesian( _helperCenterCarto, _helperCenterEcef );
	eastNorthUpToFixedFrame( _helperCenterEcef, _helperEnuMatrix );

	// 8 个采样点:4 角 + 4 边中点。曲面投影使得边中点的经纬度可能略偏出
	// 角点的 lon/lat 包围盒(尤其在大矩形 / 高纬度),8 点采样保证充分覆盖。
	const samplePoints: [ number, number ][] = [
		[ minX, minY ],
		[ ( minX + maxX ) * 0.5, minY ],
		[ maxX, minY ],
		[ maxX, ( minY + maxY ) * 0.5 ],
		[ maxX, maxY ],
		[ ( minX + maxX ) * 0.5, maxY ],
		[ minX, maxY ],
		[ minX, ( minY + maxY ) * 0.5 ],
	];

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for ( const [ dx, dy ] of samplePoints ) {
		_helperSampleEnu.set( dx, dy, 0.0 );
		matrix4MultiplyByPoint( _helperEnuMatrix, _helperSampleEnu, _helperSampleEcef );
		const carto = cartesianToCartographic( _helperSampleEcef, _helperSampleCarto );
		if ( carto === undefined ) {
			// 不可能发生:ENU 米平面点变换后仍在椭球附近
			continue;
		}
		west = Math.min( west, carto.longitude );
		east = Math.max( east, carto.longitude );
		south = Math.min( south, carto.latitude );
		north = Math.max( north, carto.latitude );
	}

	return {
		west: clampNumber( west * RAD_TO_DEG, -180.0, 180.0 ),
		south: clampNumber( south * RAD_TO_DEG, -89.999999, 89.999999 ),
		east: clampNumber( east * RAD_TO_DEG, -180.0, 180.0 ),
		north: clampNumber( north * RAD_TO_DEG, -89.999999, 89.999999 ),
	};
}

/**
 * 由中心点 + 米尺寸构造度矩形。
 *
 * 用法:demo 配置 "中心 + 宽 / 高(米)" 时,本函数把它转为度矩形。
 *
 * 当前位置:迁移自 geometry.ts:330-349。
 *
 * @param centerLongitudeDegrees 中心经度,度。
 * @param centerLatitudeDegrees  中心纬度,度。
 * @param widthMeters            东西总宽度,米(钳制到 ≥ 1)。
 * @param heightMeters           南北总高度,米(钳制到 ≥ 1)。
 * @returns                      度矩形。
 */
export function rectangleDegreesFromCenterSizeMeters(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	widthMeters: number,
	heightMeters: number,
): RectangleDegrees {
	const safeWidthMeters = Math.max( widthMeters, 1.0 );
	const safeHeightMeters = Math.max( heightMeters, 1.0 );
	const halfWidth = safeWidthMeters * 0.5;
	const halfHeight = safeHeightMeters * 0.5;

	return rectangleDegreesFromEnuBounds(
		centerLongitudeDegrees,
		centerLatitudeDegrees,
		-halfWidth,
		halfWidth,
		-halfHeight,
		halfHeight,
	);
}

/**
 * 把"中心 + (eastMeters, northMeters) 偏移"批量转为经纬度。
 *
 * 用法:demo 在中心点旁边放偏移点(如"中心北 100m"），本函数转为度。
 *
 * 当前位置:迁移自 geometry.ts:398-440。
 *
 * @param centerLongitudeDegrees 中心经度,度。
 * @param centerLatitudeDegrees  中心纬度,度。
 * @param offsets                ENU 米偏移数组。
 * @returns                      与 offsets 顺序对应的经纬度数组。
 */
export function longitudeLatitudeFromCenterOffsetsMeters(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	offsets: EastNorthOffsetMeters[],
): LongitudeLatitude[] {
	_helperCenterCarto.longitude = centerLongitudeDegrees * DEG_TO_RAD;
	_helperCenterCarto.latitude = centerLatitudeDegrees * DEG_TO_RAD;
	_helperCenterCarto.height = 0.0;
	cartographicToCartesian( _helperCenterCarto, _helperCenterEcef );
	eastNorthUpToFixedFrame( _helperCenterEcef, _helperEnuMatrix );

	return offsets.map( ( offset ) => {
		_helperSampleEnu.set( offset.eastMeters, offset.northMeters, 0.0 );
		matrix4MultiplyByPoint( _helperEnuMatrix, _helperSampleEnu, _helperSampleEcef );
		const carto = cartesianToCartographic( _helperSampleEcef, _helperSampleCarto );
		if ( carto === undefined ) {
			// 不可能,但 TypeScript 需要兜底返回值
			return { longitude: centerLongitudeDegrees, latitude: centerLatitudeDegrees };
		}
		return {
			longitude: carto.longitude * RAD_TO_DEG,
			latitude: carto.latitude * RAD_TO_DEG,
		};
	} );
}

/**
 * 在 ENU 平面上对矩形做 8 点采样,返回米宽 / 米高。
 *
 * 用法:demo "矩形米尺寸" 显示;实际上等价于把 rect 转回 ENU 取 maxX-minX 等。
 *
 * 当前位置:迁移自 geometry.ts:447-472。
 *
 * @param rectangleDegrees 度矩形。
 * @returns                米宽 / 米高(均钳制到 ≥ 1)。
 */
export function rectangleMeterSizeFromDegrees(
	rectangleDegrees: RectangleDegrees,
): RectangleMeterSize {
	const rect: RectangleRadians = {
		west: rectangleDegrees.west * DEG_TO_RAD,
		south: rectangleDegrees.south * DEG_TO_RAD,
		east: rectangleDegrees.east * DEG_TO_RAD,
		north: rectangleDegrees.north * DEG_TO_RAD,
	};

	const centerLon = ( rect.west + rect.east ) * 0.5;
	const centerLat = ( rect.south + rect.north ) * 0.5;
	_helperCenterCarto.longitude = centerLon;
	_helperCenterCarto.latitude = centerLat;
	_helperCenterCarto.height = 0.0;
	cartographicToCartesian( _helperCenterCarto, _helperCenterEcef );
	eastNorthUpToFixedFrame( _helperCenterEcef, _helperEnuMatrix );
	_helperInverseEnu.copy( _helperEnuMatrix ).invert();

	const bounds = sampleRectangleEnuBounds( rect, 0.0, _helperInverseEnu );

	return {
		widthMeters: Math.max( bounds.maxX - bounds.minX, 1.0 ),
		heightMeters: Math.max( bounds.maxY - bounds.minY, 1.0 ),
	};
}

/**
 * 把度矩形沿东西南北 4 方向各扩 `borderWidthMeters` 米。
 *
 * 算法:
 *   1. 在中心点构造 ENU 矩阵
 *   2. 把矩形 4 角投到 ENU 平面,得到 (xMin, yMin, xMax, yMax)
 *   3. 扩张 ± borderWidthMeters · BORDER_GEOMETRY_EXPANSION_SCALE
 *   4. 8 点采样反算度矩形
 *
 * 用法:`CesiumGroundRectanglePrimitive` 构造时,根据 strokeWidth 把 fill
 * 矩形扩为 render 矩形,使得 border shadow volume 比 fill 大一圈避免接缝。
 *
 * 当前位置:迁移自 geometry.ts:485-547。
 *
 * @param rectangle         源度矩形(fill)。
 * @param borderWidthMeters 外扩宽度,米(钳制到 ≥ 0;= 0 则原样返回)。
 * @returns                 扩张后的度矩形。
 */
export function expandRectangleDegreesThroughMeters(
	rectangle: RectangleDegrees,
	borderWidthMeters: number,
): RectangleDegrees {
	const safeWidth = Math.max( borderWidthMeters, 0.0 );
	if ( safeWidth === 0.0 ) {
		return { ...rectangle };
	}

	const rect: RectangleRadians = {
		west: rectangle.west * DEG_TO_RAD,
		south: rectangle.south * DEG_TO_RAD,
		east: rectangle.east * DEG_TO_RAD,
		north: rectangle.north * DEG_TO_RAD,
	};

	const centerLon = ( rect.west + rect.east ) * 0.5;
	const centerLat = ( rect.south + rect.north ) * 0.5;
	_helperCenterCarto.longitude = centerLon;
	_helperCenterCarto.latitude = centerLat;
	_helperCenterCarto.height = 0.0;
	cartographicToCartesian( _helperCenterCarto, _helperCenterEcef );
	eastNorthUpToFixedFrame( _helperCenterEcef, _helperEnuMatrix );
	_helperInverseEnu.copy( _helperEnuMatrix ).invert();

	const innerBounds = sampleRectangleEnuBounds( rect, 0.0, _helperInverseEnu );
	const expansion = safeWidth * BORDER_GEOMETRY_EXPANSION_SCALE;
	const minX = innerBounds.minX - expansion;
	const maxX = innerBounds.maxX + expansion;
	const minY = innerBounds.minY - expansion;
	const maxY = innerBounds.maxY + expansion;

	return rectangleDegreesFromEnuBounds(
		centerLon * RAD_TO_DEG,
		centerLat * RAD_TO_DEG,
		minX,
		maxX,
		minY,
		maxY,
	);
}

/**
 * 把度矩形沿四边向内收缩指定米数,用于“描边占据面内部”的 fill 区。
 *
 * @param rectangle         外轮廓度矩形。
 * @param borderWidthMeters 内描边宽度,米。
 * @returns                 内缩后的 fill 度矩形;过大的描边会钳制到最小 1mm 尺寸。
 */
export function insetRectangleDegreesThroughMeters(
	rectangle: RectangleDegrees,
	borderWidthMeters: number,
): RectangleDegrees {
	const safeWidth = Math.max( borderWidthMeters, 0.0 );
	if ( safeWidth === 0.0 ) {
		return { ...rectangle };
	}

	const rect: RectangleRadians = {
		west: rectangle.west * DEG_TO_RAD,
		south: rectangle.south * DEG_TO_RAD,
		east: rectangle.east * DEG_TO_RAD,
		north: rectangle.north * DEG_TO_RAD,
	};

	const centerLon = ( rect.west + rect.east ) * 0.5;
	const centerLat = ( rect.south + rect.north ) * 0.5;
	_helperCenterCarto.longitude = centerLon;
	_helperCenterCarto.latitude = centerLat;
	_helperCenterCarto.height = 0.0;
	cartographicToCartesian( _helperCenterCarto, _helperCenterEcef );
	eastNorthUpToFixedFrame( _helperCenterEcef, _helperEnuMatrix );
	_helperInverseEnu.copy( _helperEnuMatrix ).invert();

	const outerBounds = sampleRectangleEnuBounds( rect, 0.0, _helperInverseEnu );
	const widthMeters = Math.max( outerBounds.maxX - outerBounds.minX, 0.001 );
	const heightMeters = Math.max( outerBounds.maxY - outerBounds.minY, 0.001 );
	const inset = Math.min(
		safeWidth * BORDER_GEOMETRY_EXPANSION_SCALE,
		Math.max( ( widthMeters - 0.001 ) * 0.5, 0.0 ),
		Math.max( ( heightMeters - 0.001 ) * 0.5, 0.0 ),
	);

	return rectangleDegreesFromEnuBounds(
		centerLon * RAD_TO_DEG,
		centerLat * RAD_TO_DEG,
		outerBounds.minX + inset,
		outerBounds.maxX - inset,
		outerBounds.minY + inset,
		outerBounds.maxY - inset,
	);
}

/**
 * 把(lon°, lat°)度矩形投到 ENU 平面,8 点采样取包围盒。
 *
 * 私有 helper,被 `rectangleMeterSizeFromDegrees` 与
 * `expandRectangleDegreesThroughMeters` 共用。
 *
 * 算法:8 个 cartographic 采样点 → ECEF → 经 inverseEnu → 取 x/y 范围。
 *
 * @param rect       矩形(弧度)。
 * @param height     采样 cartographic 的 height(米,通常 0)。
 * @param inverseEnu ECEF → ENU 的 4×4 矩阵。
 * @returns          ENU 米平面包围盒。
 */
function sampleRectangleEnuBounds(
	rect: RectangleRadians,
	height: number,
	inverseEnu: Matrix4,
): { minX: number; maxX: number; minY: number; maxY: number } {
	const longitudeCenter = ( rect.west + rect.east ) * 0.5;
	const latitudeCenter = ( rect.south + rect.north ) * 0.5;

	const cartographics: [ number, number ][] = [
		[ rect.west, rect.south ],
		[ rect.west, rect.north ],
		[ rect.east, rect.north ],
		[ rect.east, rect.south ],
		[ longitudeCenter, rect.south ],
		[ longitudeCenter, rect.north ],
		[ rect.west, latitudeCenter ],
		[ rect.east, latitudeCenter ],
	];

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for ( const [ longitude, latitude ] of cartographics ) {
		_helperCornerCarto.longitude = longitude;
		_helperCornerCarto.latitude = latitude;
		_helperCornerCarto.height = height;
		cartographicToCartesian( _helperCornerCarto, _helperCornerEcef );
		matrix4MultiplyByPoint( inverseEnu, _helperCornerEcef, _helperCornerEcef );
		// 投到 z=0 平面(因 inverseEnu 已把 origin 平移到原点)
		minX = Math.min( minX, _helperCornerEcef.x );
		maxX = Math.max( maxX, _helperCornerEcef.x );
		minY = Math.min( minY, _helperCornerEcef.y );
		maxY = Math.max( maxY, _helperCornerEcef.y );
	}

	return { minX, maxX, minY, maxY };
}

// re-export 给 rectangle-extents.ts 用(私有但同包内共享)
export { sampleRectangleEnuBounds as _sampleRectangleEnuBounds };

// 内部 wgs84 import 重新导出 — 避免向 demo 同时 import 两个路径
// (demo 仅用 wgs84PositionFromDegrees 这个公共 API,通过 index.ts 路径访问)
export { wgs84PositionFromDegrees };
