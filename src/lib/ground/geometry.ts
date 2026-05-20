// ============================================================
// geometry.ts
// Layer: Polygon-only Cesium geometry utilities (rectangle 已抽离)。
// Role: convert WGS84 lon/lat inputs into Cesium polygon geometry,
//       encode Cesium positions for RTE shaders(re-export),
//       compute polygon planar meter extents used by Cesium shadow-volume
//       ground classification.
// Dependencies: Three.js geometry classes 与 Cesium Core(仅 polygon 路径)。
// Consumed by: cesium-ground-adapter.ts、primitives.ts(polygon 部分)。
//
// 本期工作:矩形相关 helper(encodeCesium* / cesiumGeometryToThree 中矩形用法 /
// createDebugRectangleSurfaceGeometry / rectangleDegreesFromLonLatPoints /
// rectangleDegreesFromCenterSizeMeters / rectangleDegreesFromEnuBounds /
// longitudeLatitudeFromCenterOffsetsMeters / rectangleMeterSizeFromDegrees /
// expandRectangleDegreesThroughMeters / computeRectanglePlanarBounds /
// computePlanarExtents 的矩形分支 / wgs84PositionFromDegrees /
// wgs84NormalFromDegrees)已迁移到 math/* 与 rectangle/*。
// 此处只保留 polygon 路径使用的:
//   - polygonHierarchyDegreesToCesium(度→Cesium Cartesian3)
//   - cesiumGeometryToThree(Cesium Geometry → Three BufferGeometry)
//   - computePolygonPlanarExtents(polygon shadow volume uniform)
//   - computePolygonPlanarBounds(私有,polygon ENU 包围盒)
// 同时通过 re-export 将 math/* 与 rectangle/* 中的相关函数暴露给上层(adapter / demo)。
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
	Vector2,
	Vector3,
	Vector4,
} from 'three';

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Rectangle from '../../../cesium-ground-source/engine/Source/Core/Rectangle.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import PolygonHierarchy from '../../../cesium-ground-source/engine/Source/Core/PolygonHierarchy.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartographic from '../../../cesium-ground-source/engine/Source/Core/Cartographic.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Cartesian3 from '../../../cesium-ground-source/engine/Source/Core/Cartesian3.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Matrix4Cesium from '../../../cesium-ground-source/engine/Source/Core/Matrix4.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Transforms from '../../../cesium-ground-source/engine/Source/Core/Transforms.js';

import { encodeVec3RTE } from './math/rte-encoding';
import type {
	CartesianLike,
	CesiumGeometryResult,
	LonLatPoint,
	LongitudeLatitude,
	PlanarBounds,
	PlanarExtents,
	PolygonHierarchyDegrees,
} from './types';

// 把 math/rectangle 模块的公共 API 通过 geometry.ts re-export,保持上层向后兼容。
// 这样 cesium-ground-adapter.ts 仍可以从 './geometry' import 这些 helper。
export {
	rectangleDegreesFromLonLatPoints,
	rectangleDegreesFromCenterSizeMeters,
	longitudeLatitudeFromCenterOffsetsMeters,
	rectangleMeterSizeFromDegrees,
	expandRectangleDegreesThroughMeters,
} from './rectangle/rectangle-helpers';
export {
	wgs84PositionFromDegrees,
	wgs84NormalFromDegrees,
} from './math/wgs84-helpers';
export {
	encodeScalarRTE as encodeCesiumFloat,
	encodeVec3RTE as encodeCesiumVector3,
} from './math/rte-encoding';
export { computeRectanglePlanarExtents } from './rectangle/rectangle-extents';
export { createDebugRectangleSurfaceGeometry } from './rectangle/rectangle-debug';

/**
 * Copies a Cesium Cartesian3-like object into a Three Vector3.
 *
 * @param cartesian Object with x/y/z fields.
 * @returns A new Three Vector3.
 */
function cesiumCartesianToVector3( cartesian: CartesianLike ): Vector3 {
	return new Vector3( cartesian.x, cartesian.y, cartesian.z );
}

/**
 * Converts one WGS84 lon/lat point to a Cesium Cartesian on the ellipsoid.
 *
 * Polygon 路径专用 — 矩形路径不再调用此函数。
 *
 * @param point Longitude/latitude point in degrees.
 * @returns Cesium Cartesian3 in ECEF coordinates.
 */
function cartesianFromLongitudeLatitude( point: LongitudeLatitude ): CartesianLike {
	const cartographic = new Cartographic(
		point.longitude * Math.PI / 180.0,
		point.latitude * Math.PI / 180.0,
		0.0,
	);
	return Ellipsoid.WGS84.cartographicToCartesian( cartographic, new Cartesian3() );
}

/**
 * Converts a degree-based polygon hierarchy to Cesium's PolygonHierarchy.
 *
 * @param hierarchy Polygon hierarchy in WGS84 degrees.
 * @returns Cesium PolygonHierarchy with Cartesian3 positions.
 */
export function polygonHierarchyDegreesToCesium(
	hierarchy: PolygonHierarchyDegrees,
): { positions: CartesianLike[]; holes: unknown[] } {
	const positions = hierarchy.positions.map( cartesianFromLongitudeLatitude );
	const holes = ( hierarchy.holes ?? [] ).map( polygonHierarchyDegreesToCesium );
	return new PolygonHierarchy( positions, holes );
}

/**
 * Converts Cesium Geometry attributes to a Three BufferGeometry.
 *
 * Polygon 路径专用 — 矩形路径已迁移到 rectangle-shadow-volume.ts 内部直接装配。
 *
 * @param cesiumGeometry Geometry returned by Cesium createGeometry.
 * @returns Three BufferGeometry with matching attribute names.
 */
export function cesiumGeometryToThree( cesiumGeometry: CesiumGeometryResult ): BufferGeometry {
	if (
		! cesiumGeometry ||
		! cesiumGeometry.attributes ||
		Object.keys( cesiumGeometry.attributes ).length === 0
	) {
		throw new Error( 'Cesium geometry conversion failed: geometry has no vertex attributes.' );
	}

	const geometry = new BufferGeometry();

	for ( const [ name, attribute ] of Object.entries( cesiumGeometry.attributes ) ) {
		const sourceValues = attribute.values;
		const values = sourceValues instanceof Float32Array
			? sourceValues
			: new Float32Array( Array.from( sourceValues ) );

		geometry.setAttribute(
			name,
			new BufferAttribute( values, attribute.componentsPerAttribute ),
		);
	}

	const firstAttribute = Object.values( cesiumGeometry.attributes )[ 0 ];
	const vertexCount = firstAttribute.values.length / firstAttribute.componentsPerAttribute;
	const batchIds = new Float32Array( vertexCount );
	geometry.setAttribute( 'batchId', new BufferAttribute( batchIds, 1 ) );

	if ( cesiumGeometry.indices ) {
		const indices = cesiumGeometry.indices;
		const indexArray = indices instanceof Uint16Array || indices instanceof Uint32Array
			? indices
			: new Uint32Array( Array.from( indices ) );
		geometry.setIndex( new BufferAttribute( indexArray, 1 ) );
	}

	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Computes a planar bounding rectangle for arbitrary polygon hierarchy points.
 *
 * Polygon 路径专用。Cesium 仍是该几何的 source of truth。
 *
 * @param hierarchy Polygon hierarchy in Cesium Cartesian coordinates.
 * @param ellipsoid Cesium ellipsoid used by the geometry.
 * @param height Projection height in meters.
 * @param inverseEnu Matrix from ECEF to local ENU.
 * @returns Planar min/max bounds in meters.
 */
function computePolygonPlanarBounds(
	hierarchy: { positions: CartesianLike[]; holes?: unknown[] },
	ellipsoid: typeof Ellipsoid.WGS84,
	height: number,
	inverseEnu: unknown,
): PlanarBounds {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const cartographic = new Cartographic();
	const pointCartesian = new Cartesian3();

	/**
	 * Includes all positions in one hierarchy level and its holes.
	 *
	 * @param node Current polygon hierarchy node.
	 */
	function includeHierarchy( node: { positions: CartesianLike[]; holes?: unknown[] } ): void {
		for ( const position of node.positions ) {
			ellipsoid.cartesianToCartographic( position, cartographic );
			cartographic.height = height;
			ellipsoid.cartographicToCartesian( cartographic, pointCartesian );
			Matrix4Cesium.multiplyByPoint( inverseEnu, pointCartesian, pointCartesian );
			pointCartesian.z = 0.0;
			minX = Math.min( minX, pointCartesian.x );
			maxX = Math.max( maxX, pointCartesian.x );
			minY = Math.min( minY, pointCartesian.y );
			maxY = Math.max( maxY, pointCartesian.y );
		}

		for ( const hole of node.holes ?? [] ) {
			includeHierarchy( hole as { positions: CartesianLike[]; holes?: unknown[] } );
		}
	}

	includeHierarchy( hierarchy );
	return { minX, maxX, minY, maxY };
}

/**
 * Computes planar texture-coordinate attributes for polygon shadow volumes.
 *
 * Cesium's polygon ground path still uses planar texture coordinates for
 * ordinary local polygons. This adapter supplies equivalent batch-table
 * uniforms so ShadowVolumeAppearanceVS can classify the polygon volume.
 *
 * @param rectangle Polygon bounding rectangle in radians.
 * @param hierarchy Cesium polygon hierarchy.
 * @param ellipsoid Cesium WGS84 ellipsoid.
 * @param height Maximum shadow-volume height.
 * @returns Encoded planar extent uniforms.
 */
export function computePolygonPlanarExtents(
	rectangle: unknown,
	hierarchy: unknown,
	ellipsoid: typeof Ellipsoid.WGS84,
	height: number,
): PlanarExtents {
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = height;

	const centerCartesian = ellipsoid.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		ellipsoid,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const bounds = computePolygonPlanarBounds(
		hierarchy as { positions: CartesianLike[]; holes?: unknown[] },
		ellipsoid,
		height,
		inverseEnu,
	);
	const eastExtentMeters = Math.max( bounds.maxX - bounds.minX, 1.0 );
	const northExtentMeters = Math.max( bounds.maxY - bounds.minY, 1.0 );

	const southWestCorner = new Cartesian3( bounds.minX, bounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southWestCorner, southWestCorner );

	const southEastCorner = new Cartesian3( bounds.maxX, bounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southEastCorner, southEastCorner );

	const northWestCorner = new Cartesian3( bounds.minX, bounds.maxY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, northWestCorner, northWestCorner );

	const southWest = cesiumCartesianToVector3( southWestCorner );
	const southEast = cesiumCartesianToVector3( southEastCorner );
	const northWest = cesiumCartesianToVector3( northWestCorner );
	const eastward = southEast.sub( southWest );
	const northward = northWest.sub( southWest );
	const high = new Vector3();
	const low = new Vector3();
	encodeVec3RTE( southWest, high, low );

	return {
		southWestHigh: high,
		southWestLow: low,
		eastward,
		northward,
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		innerMetersRect: new Vector4( 0.0, 0.0, eastExtentMeters, northExtentMeters ),
	};
}

/**
 * Projects public polygon fill points into the same local meter frame as uv.
 *
 * @param rectangle Render polygon bounding rectangle in radians.
 * @param renderHierarchy Cesium render polygon hierarchy after stroke expansion.
 * @param fillPoints Original public polygon vertices in WGS84 degrees.
 * @param ellipsoid Cesium WGS84 ellipsoid.
 * @param height Maximum shadow-volume height.
 * @returns Fill polygon vertices in planar meters from the render SW corner.
 */
export function computePolygonPlanarStylePoints(
	rectangle: unknown,
	renderHierarchy: unknown,
	fillPoints: readonly LonLatPoint[],
	ellipsoid: typeof Ellipsoid.WGS84,
	height: number,
): Vector2[] {
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = height;

	const centerCartesian = ellipsoid.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		ellipsoid,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const renderBounds = computePolygonPlanarBounds(
		renderHierarchy as { positions: CartesianLike[]; holes?: unknown[] },
		ellipsoid,
		height,
		inverseEnu,
	);
	const cartographic = new Cartographic();
	const pointCartesian = new Cartesian3();

	return fillPoints.map( ( point ) => {
		cartographic.longitude = point[ 0 ] * Math.PI / 180.0;
		cartographic.latitude = point[ 1 ] * Math.PI / 180.0;
		cartographic.height = height;
		ellipsoid.cartographicToCartesian( cartographic, pointCartesian );
		Matrix4Cesium.multiplyByPoint( inverseEnu, pointCartesian, pointCartesian );

		return new Vector2(
			pointCartesian.x - renderBounds.minX,
			pointCartesian.y - renderBounds.minY,
		);
	} );
}
