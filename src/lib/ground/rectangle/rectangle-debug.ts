// ============================================================
// rectangle/rectangle-debug.ts — Debug 用矩形椭球面网格
// 层级:L2(debug 辅助,可选)
// 职责:把 RectangleRadians 转化为一个仅 position 的 Three BufferGeometry,
//      贴在椭球面上,用于调试可视化矩形轮廓与边界。
//      生产路径不消费;仅当 CesiumGroundRectanglePrimitiveOptions.debugSurface
//      = true 时由 primitives.ts 调用。
// 依赖:Three.js BufferAttribute + BufferGeometry + Vector3、
//      math/cartographic.ts、math/ellipsoid.ts、rectangle-radians.ts
// 被消费:primitives.ts(debug 分支,可选)
// 来源:迁移自 src/lib/ground/geometry.ts:180-236
// ============================================================

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

import { createCartographic } from '../math/cartographic';
import { cartographicToCartesian } from '../math/ellipsoid';
import type { RectangleRadians } from './rectangle-radians';

/**
 * 构造贴在椭球面上的矩形 debug 网格(线框可视化)。
 *
 * Classification 渲染路径使用 RTE 编码的 shadow volume 几何,Three 自带
 * Mesh 材质无法直接渲染。此 helper 产出一个普通 POSITION-only 网格,
 * 在同一个 ECEF 世界坐标系下贴在椭球面上,便于:
 *   - 验证矩形地理位置是否正确
 *   - 与 classification 输出对比 debug
 *
 * 网格分辨率默认 96×64(列 × 行),足够覆盖珠峰尺度矩形的曲面。
 *
 * @param rectangle         矩形(弧度,west < east, south < north)。
 * @param height            网格点高度,米(在椭球面以上)。
 * @param longitudeSegments 经度方向段数(顶点数 = segments + 1)。
 * @param latitudeSegments  纬度方向段数。
 * @returns                 Three BufferGeometry,含 `position` attribute(Float32, 3)
 *                          + index(Uint32);computeBoundingSphere 已计算。
 */
export function createDebugRectangleSurfaceGeometry(
	rectangle: RectangleRadians,
	height: number,
	longitudeSegments = 96,
	latitudeSegments = 64,
): BufferGeometry {
	const columns = Math.max( 1, Math.floor( longitudeSegments ) );
	const rows = Math.max( 1, Math.floor( latitudeSegments ) );
	const vertexColumns = columns + 1;
	const vertexRows = rows + 1;

	const positions = new Float32Array( vertexColumns * vertexRows * 3 );
	const indices = new Uint32Array( columns * rows * 6 );
	const cartographic = createCartographic();
	const cartesian = new Vector3();

	let positionOffset = 0;
	for ( let row = 0; row < vertexRows; row++ ) {
		const v = row / rows;
		const latitude = rectangle.south + ( rectangle.north - rectangle.south ) * v;

		for ( let column = 0; column < vertexColumns; column++ ) {
			const u = column / columns;
			const longitude =
				rectangle.west + ( rectangle.east - rectangle.west ) * u;
			cartographic.longitude = longitude;
			cartographic.latitude = latitude;
			cartographic.height = height;
			cartographicToCartesian( cartographic, cartesian );

			positions[ positionOffset++ ] = cartesian.x;
			positions[ positionOffset++ ] = cartesian.y;
			positions[ positionOffset++ ] = cartesian.z;
		}
	}

	let indexOffset = 0;
	for ( let row = 0; row < rows; row++ ) {
		for ( let column = 0; column < columns; column++ ) {
			const southWest = row * vertexColumns + column;
			const southEast = southWest + 1;
			const northWest = southWest + vertexColumns;
			const northEast = northWest + 1;

			// 两个 CCW 三角形(从地表上方看)
			indices[ indexOffset++ ] = southWest;
			indices[ indexOffset++ ] = southEast;
			indices[ indexOffset++ ] = northEast;
			indices[ indexOffset++ ] = southWest;
			indices[ indexOffset++ ] = northEast;
			indices[ indexOffset++ ] = northWest;
		}
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	geometry.setIndex( new BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;
}
