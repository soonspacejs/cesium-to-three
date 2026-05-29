// ============================================================
// geometry.ts
// Layer: Cesium-to-Three ground geometry utilities.
// Role: convert WGS84 lon/lat inputs into Cesium geometry, encode Cesium
//       positions for RTE shaders, and compute planar meter extents used by
//       Cesium shadow-volume ground classification.
// Dependencies: Three.js geometry classes and unmodified Cesium Core geometry.
// Consumed by: cesium-ground-adapter.ts and demo coordinate helpers.
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
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

import { BORDER_GEOMETRY_EXPANSION_SCALE } from './constants';
import type {
	CartesianLike,
	CesiumGeometryResult,
	EastNorthOffsetMeters,
	EncodedScalar,
	LonLatPoint,
	LongitudeLatitude,
	PlanarBounds,
	PlanarExtents,
	PolygonHierarchyDegrees,
	RectangleDegrees,
	RectangleMeterSize,
	RectangleRadians,
} from './types';

/**
 * Encodes one float using Cesium's EncodedCartesian3.encode algorithm.
 *
 * @param value 64-bit JavaScript number in model coordinates.
 * @returns The high and low parts consumed by czm_translateRelativeToEye.
 */
function encodeCesiumFloat( value: number ): EncodedScalar {
	let doubleHigh: number;

	if ( value >= 0.0 ) {
		doubleHigh = Math.floor( value / 65536.0 ) * 65536.0;
		return { high: doubleHigh, low: value - doubleHigh };
	}

	doubleHigh = Math.floor( - value / 65536.0 ) * 65536.0;
	return { high: - doubleHigh, low: value + doubleHigh };
}

/**
 * Encodes a Three vector with the same fixed-point split used by Cesium.
 *
 * @param source ECEF/model-coordinate vector.
 * @param high Output high vector.
 * @param low Output low vector.
 */
export function encodeCesiumVector3( source: Vector3, high: Vector3, low: Vector3 ): void {
	const x = encodeCesiumFloat( source.x );
	const y = encodeCesiumFloat( source.y );
	const z = encodeCesiumFloat( source.z );

	high.set( x.high, y.high, z.high );
	low.set( x.low, y.low, z.low );
}

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
export function polygonHierarchyDegreesToCesium( hierarchy: PolygonHierarchyDegrees ): { positions: CartesianLike[]; holes: unknown[] } {
	const positions = hierarchy.positions.map( cartesianFromLongitudeLatitude );
	const holes = ( hierarchy.holes ?? [] ).map( polygonHierarchyDegreesToCesium );
	return new PolygonHierarchy( positions, holes );
}

/**
 * Converts Cesium Geometry attributes to a Three BufferGeometry.
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
 * Builds a visible debug surface from the same geographic rectangle.
 *
 * The classification pipeline uses Cesium shadow-volume geometry with encoded
 * high/low positions, which is correct for Cesium shaders but not renderable by
 * Three's MeshBasicMaterial. This helper creates a plain position-only grid in
 * the same WGS84 ECEF frame so a red rectangle is guaranteed to be visible when
 * the primitive's geographic placement is correct.
 *
 * @param rectangle Cesium rectangle in radians.
 * @param height Height above WGS84 in meters.
 * @param longitudeSegments Number of longitudinal subdivisions.
 * @param latitudeSegments Number of latitudinal subdivisions.
 * @returns Three geometry with position attributes and triangle indices.
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
	const cartographic = new Cartographic();
	const cartesian = new Cartesian3();

	let positionOffset = 0;
	for ( let row = 0; row < vertexRows; row ++ ) {
		const v = row / rows;
		const latitude = rectangle.south + ( rectangle.north - rectangle.south ) * v;

		for ( let column = 0; column < vertexColumns; column ++ ) {
			const u = column / columns;
			const longitude = rectangle.west + ( rectangle.east - rectangle.west ) * u;
			cartographic.longitude = longitude;
			cartographic.latitude = latitude;
			cartographic.height = height;
			Ellipsoid.WGS84.cartographicToCartesian( cartographic, cartesian );

			positions[ positionOffset ++ ] = cartesian.x;
			positions[ positionOffset ++ ] = cartesian.y;
			positions[ positionOffset ++ ] = cartesian.z;
		}
	}

	let indexOffset = 0;
	for ( let row = 0; row < rows; row ++ ) {
		for ( let column = 0; column < columns; column ++ ) {
			const southWest = row * vertexColumns + column;
			const southEast = southWest + 1;
			const northWest = southWest + vertexColumns;
			const northEast = northWest + 1;

			indices[ indexOffset ++ ] = southWest;
			indices[ indexOffset ++ ] = southEast;
			indices[ indexOffset ++ ] = northEast;
			indices[ indexOffset ++ ] = southWest;
			indices[ indexOffset ++ ] = northEast;
			indices[ indexOffset ++ ] = northWest;
		}
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	geometry.setIndex( new BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Clamps a scalar to a closed interval.
 *
 * @param value Input value.
 * @param min Minimum returned value.
 * @param max Maximum returned value.
 * @returns Clamped value.
 */
function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * Converts local ENU meter bounds back to a geographic rectangle.
 *
 * @param centerLongitudeDegrees Center longitude in degrees.
 * @param centerLatitudeDegrees Center latitude in degrees.
 * @param minX Minimum east offset in meters.
 * @param maxX Maximum east offset in meters.
 * @param minY Minimum north offset in meters.
 * @param maxY Maximum north offset in meters.
 * @returns Geographic rectangle containing the sampled ENU bounds.
 */
function rectangleDegreesFromEnuBounds(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): RectangleDegrees {
	const centerCartographic = new Cartographic(
		centerLongitudeDegrees * Math.PI / 180.0,
		centerLatitudeDegrees * Math.PI / 180.0,
		0.0,
	);
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const samples = [
		new Cartesian3( minX, minY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, minY, 0.0 ),
		new Cartesian3( maxX, minY, 0.0 ),
		new Cartesian3( maxX, ( minY + maxY ) * 0.5, 0.0 ),
		new Cartesian3( maxX, maxY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, maxY, 0.0 ),
		new Cartesian3( minX, maxY, 0.0 ),
		new Cartesian3( minX, ( minY + maxY ) * 0.5, 0.0 ),
	];

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const cartographic = new Cartographic();

	for ( const sample of samples ) {
		Matrix4Cesium.multiplyByPoint( enuMatrix, sample, sample );
		Ellipsoid.WGS84.cartesianToCartographic( sample, cartographic );
		west = Math.min( west, cartographic.longitude );
		east = Math.max( east, cartographic.longitude );
		south = Math.min( south, cartographic.latitude );
		north = Math.max( north, cartographic.latitude );
	}

	return {
		west: clampNumber( west * 180.0 / Math.PI, - 180.0, 180.0 ),
		south: clampNumber( south * 180.0 / Math.PI, - 89.999999, 89.999999 ),
		east: clampNumber( east * 180.0 / Math.PI, - 180.0, 180.0 ),
		north: clampNumber( north * 180.0 / Math.PI, - 89.999999, 89.999999 ),
	};
}

/**
 * Creates a geographic rectangle from a center point and meter dimensions.
 *
 * The requested width and height are first represented in the local ENU meter
 * plane, then converted back to WGS84 degrees so Cesium remains the geometry
 * source of truth.
 *
 * @param centerLongitudeDegrees Center longitude in degrees.
 * @param centerLatitudeDegrees Center latitude in degrees.
 * @param widthMeters Rectangle width in local east-west meters.
 * @param heightMeters Rectangle height in local north-south meters.
 * @returns WGS84 degree rectangle.
 */
export function rectangleDegreesFromCenterSizeMeters(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	widthMeters: number,
	heightMeters: number,
): RectangleDegrees {
	const safeWidthMeters = Math.max( widthMeters, 1.0 );
	const safeHeightMeters = Math.max( heightMeters, 1.0 );
	const halfWidthMeters = safeWidthMeters * 0.5;
	const halfHeightMeters = safeHeightMeters * 0.5;

	return rectangleDegreesFromEnuBounds(
		centerLongitudeDegrees,
		centerLatitudeDegrees,
		- halfWidthMeters,
		halfWidthMeters,
		- halfHeightMeters,
		halfHeightMeters,
	);
}

/**
 * Builds an axis-aligned Cesium rectangle from four lon/lat corner points.
 *
 * The public plot API stores rectangles as four WGS84 corner points to match
 * SoonSpace plot snapshots. Cesium RectangleGeometry still consumes west,
 * south, east, and north degree bounds, so this helper validates the four
 * corners and derives those bounds without changing the caller's point order.
 *
 * @param points Four rectangle corner points as [longitude, latitude] degrees.
 * @returns WGS84 degree bounds suitable for Cesium RectangleGeometry.
 */
export function rectangleDegreesFromLonLatPoints( points: LonLatPoint[] ): RectangleDegrees {
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
			throw new Error( 'Cesium ground rectangle points must contain finite lon/lat numbers.' );
		}
		if ( longitude < - 180.0 || longitude > 180.0 || latitude < - 90.0 || latitude > 90.0 ) {
			throw new Error( 'Cesium ground rectangle points must be valid WGS84 lon/lat degrees.' );
		}

		west = Math.min( west, longitude );
		south = Math.min( south, latitude );
		east = Math.max( east, longitude );
		north = Math.max( north, latitude );
	}

	if ( east <= west || north <= south ) {
		throw new Error( 'Cesium ground rectangle points must describe a non-degenerate rectangle.' );
	}

	return { west, south, east, north };
}

/**
 * Converts local ENU meter offsets around a center point to WGS84 lon/lat points.
 *
 * @param centerLongitudeDegrees Center longitude in degrees.
 * @param centerLatitudeDegrees Center latitude in degrees.
 * @param offsets Local east/north offsets in meters.
 * @returns Points in WGS84 degrees.
 */
export function longitudeLatitudeFromCenterOffsetsMeters(
	centerLongitudeDegrees: number,
	centerLatitudeDegrees: number,
	offsets: EastNorthOffsetMeters[],
): LongitudeLatitude[] {
	const centerCartographic = new Cartographic(
		centerLongitudeDegrees * Math.PI / 180.0,
		centerLatitudeDegrees * Math.PI / 180.0,
		0.0,
	);
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const cartographic = new Cartographic();

	return offsets.map( offset => {
		const localPoint = new Cartesian3( offset.eastMeters, offset.northMeters, 0.0 );
		Matrix4Cesium.multiplyByPoint( enuMatrix, localPoint, localPoint );
		Ellipsoid.WGS84.cartesianToCartographic( localPoint, cartographic );

		return {
			longitude: cartographic.longitude * 180.0 / Math.PI,
			latitude: cartographic.latitude * 180.0 / Math.PI,
		};
	} );
}

/**
 * Measures one geographic rectangle in the local ENU meter plane.
 *
 * @param rectangleDegrees Rectangle in WGS84 degrees.
 * @returns Width and height in meters.
 */
export function rectangleMeterSizeFromDegrees( rectangleDegrees: RectangleDegrees ): RectangleMeterSize {
	const rectangle = Rectangle.fromDegrees(
		rectangleDegrees.west,
		rectangleDegrees.south,
		rectangleDegrees.east,
		rectangleDegrees.north,
	);
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = 0.0;
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const bounds = computeRectanglePlanarBounds( rectangle, Ellipsoid.WGS84, 0.0, inverseEnu );

	return {
		widthMeters: Math.max( bounds.maxX - bounds.minX, 1.0 ),
		heightMeters: Math.max( bounds.maxY - bounds.minY, 1.0 ),
	};
}

/**
 * Expands a geographic rectangle by converting it to a local meter plane first.
 *
 * The rectangle is projected into an ENU frame centered on the original
 * rectangle, the border is added in meters on that plane, and the expanded
 * meter bounds are converted back to cartographic degrees for Cesium geometry.
 *
 * @param rectangle Source rectangle in degrees.
 * @param borderWidthMeters Outward border width in meters.
 * @returns Expanded rectangle in degrees.
 */
export function expandRectangleDegreesThroughMeters( rectangle: RectangleDegrees, borderWidthMeters: number ): RectangleDegrees {
	const safeWidthMeters = Math.max( borderWidthMeters, 0.0 );
	if ( safeWidthMeters === 0.0 ) {
		return { ...rectangle };
	}

	const sourceRectangle = Rectangle.fromDegrees(
		rectangle.west,
		rectangle.south,
		rectangle.east,
		rectangle.north,
	);
	const centerCartographic = Rectangle.center( sourceRectangle, new Cartographic() );
	centerCartographic.height = 0.0;
	const centerCartesian = Ellipsoid.WGS84.cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);
	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		Ellipsoid.WGS84,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );
	const innerBounds = computeRectanglePlanarBounds( sourceRectangle, Ellipsoid.WGS84, 0.0, inverseEnu );
	const expansionMeters = safeWidthMeters * BORDER_GEOMETRY_EXPANSION_SCALE;
	const minX = innerBounds.minX - expansionMeters;
	const maxX = innerBounds.maxX + expansionMeters;
	const minY = innerBounds.minY - expansionMeters;
	const maxY = innerBounds.maxY + expansionMeters;
	const samples = [
		new Cartesian3( minX, minY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, minY, 0.0 ),
		new Cartesian3( maxX, minY, 0.0 ),
		new Cartesian3( maxX, ( minY + maxY ) * 0.5, 0.0 ),
		new Cartesian3( maxX, maxY, 0.0 ),
		new Cartesian3( ( minX + maxX ) * 0.5, maxY, 0.0 ),
		new Cartesian3( minX, maxY, 0.0 ),
		new Cartesian3( minX, ( minY + maxY ) * 0.5, 0.0 ),
	];

	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const cartographic = new Cartographic();

	for ( const sample of samples ) {
		Matrix4Cesium.multiplyByPoint( enuMatrix, sample, sample );
		Ellipsoid.WGS84.cartesianToCartographic( sample, cartographic );
		west = Math.min( west, cartographic.longitude );
		east = Math.max( east, cartographic.longitude );
		south = Math.min( south, cartographic.latitude );
		north = Math.max( north, cartographic.latitude );
	}

	return {
		west: clampNumber( west * 180.0 / Math.PI, - 180.0, 180.0 ),
		south: clampNumber( south * 180.0 / Math.PI, - 89.999999, 89.999999 ),
		east: clampNumber( east * 180.0 / Math.PI, - 180.0, 180.0 ),
		north: clampNumber( north * 180.0 / Math.PI, - 89.999999, 89.999999 ),
	};
}

/**
 * Projects a Cesium rectangle onto an ENU plane and returns its planar bounds.
 *
 * @param rectangle Rectangle in radians.
 * @param ellipsoid Cesium ellipsoid used by the geometry.
 * @param height Projection height in meters.
 * @param inverseEnu Matrix from ECEF to the shared ENU plane.
 * @returns Planar min/max coordinates in ENU meters.
 */
function computeRectanglePlanarBounds(
	rectangle: unknown,
	ellipsoid: unknown,
	height: number,
	inverseEnu: unknown,
): PlanarBounds {
	const west = ( rectangle as { west: number } ).west;
	const east = ( rectangle as { east: number } ).east;
	const north = ( rectangle as { north: number } ).north;
	const south = ( rectangle as { south: number } ).south;
	const longitudeCenter = ( west + east ) * 0.5;
	const latitudeCenter = ( north + south ) * 0.5;
	const cartographics = [
		new Cartographic( west, south, height ),
		new Cartographic( west, north, height ),
		new Cartographic( east, north, height ),
		new Cartographic( east, south, height ),
		new Cartographic( longitudeCenter, south, height ),
		new Cartographic( longitudeCenter, north, height ),
		new Cartographic( west, latitudeCenter, height ),
		new Cartographic( east, latitudeCenter, height ),
	];

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for ( const cartographic of cartographics ) {
		const pointCartesian = ( ellipsoid as typeof Ellipsoid.WGS84 ).cartographicToCartesian(
			cartographic,
			new Cartesian3(),
		);
		Matrix4Cesium.multiplyByPoint( inverseEnu, pointCartesian, pointCartesian );
		pointCartesian.z = 0.0;
		minX = Math.min( minX, pointCartesian.x );
		maxX = Math.max( maxX, pointCartesian.x );
		minY = Math.min( minY, pointCartesian.y );
		maxY = Math.max( maxY, pointCartesian.y );
	}

	return { minX, maxX, minY, maxY };
}

/**
 * Computes a planar bounding rectangle for arbitrary polygon hierarchy points.
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
 * Computes the planar texture-coordinate extent attributes used by Cesium.
 *
 * This is a direct TypeScript port of ShadowVolumeAppearance.computeRectangleBounds
 * plus the specific attributes needed by ShadowVolumeAppearanceVS for planar
 * ground-primitive culling.
 *
 * @param rectangle Cesium render rectangle in radians.
 * @param ellipsoid Cesium WGS84 ellipsoid.
 * @param height Maximum shadow-volume height.
 * @param innerRectangle Original fill rectangle in radians.
 * @returns Encoded planar extent uniforms.
 */
export function computePlanarExtents(
	rectangle: unknown,
	ellipsoid: unknown,
	height: number,
	innerRectangle: unknown = rectangle,
): PlanarExtents {
	const centerCartographic = Rectangle.center( rectangle, new Cartographic() );
	centerCartographic.height = height;

	const centerCartesian = ( ellipsoid as typeof Ellipsoid.WGS84 ).cartographicToCartesian(
		centerCartographic,
		new Cartesian3(),
	);

	const enuMatrix = Transforms.eastNorthUpToFixedFrame(
		centerCartesian,
		ellipsoid,
		new Matrix4Cesium(),
	);
	const inverseEnu = Matrix4Cesium.inverse( enuMatrix, new Matrix4Cesium() );

	const outerBounds = computeRectanglePlanarBounds( rectangle, ellipsoid, height, inverseEnu );
	const innerBounds = computeRectanglePlanarBounds( innerRectangle, ellipsoid, height, inverseEnu );
	const eastExtentMeters = Math.max( outerBounds.maxX - outerBounds.minX, 1.0 );
	const northExtentMeters = Math.max( outerBounds.maxY - outerBounds.minY, 1.0 );

	const southWestCorner = new Cartesian3( outerBounds.minX, outerBounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southWestCorner, southWestCorner );

	const southEastCorner = new Cartesian3( outerBounds.maxX, outerBounds.minY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, southEastCorner, southEastCorner );

	const northWestCorner = new Cartesian3( outerBounds.minX, outerBounds.maxY, 0.0 );
	Matrix4Cesium.multiplyByPoint( enuMatrix, northWestCorner, northWestCorner );

	const southWest = cesiumCartesianToVector3( southWestCorner );
	const southEast = cesiumCartesianToVector3( southEastCorner );
	const northWest = cesiumCartesianToVector3( northWestCorner );
	const eastward = southEast.sub( southWest );
	const northward = northWest.sub( southWest );
	const high = new Vector3();
	const low = new Vector3();
	encodeCesiumVector3( southWest, high, low );

	const innerMinX = clampNumber( innerBounds.minX - outerBounds.minX, 0.0, eastExtentMeters );
	const innerMinY = clampNumber( innerBounds.minY - outerBounds.minY, 0.0, northExtentMeters );
	const innerMaxX = clampNumber( innerBounds.maxX - outerBounds.minX, 0.0, eastExtentMeters );
	const innerMaxY = clampNumber( innerBounds.maxY - outerBounds.minY, 0.0, northExtentMeters );

	return {
		southWestHigh: high,
		southWestLow: low,
		eastward,
		northward,
		uvMinAndExtents: new Vector4( 0.0, 0.0, 1.0, 1.0 ),
		uMaxVmax: new Vector4( 0.0, 1.0, 1.0, 0.0 ),
		innerMetersRect: new Vector4( innerMinX, innerMinY, innerMaxX, innerMaxY ),
	};
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
	encodeCesiumVector3( southWest, high, low );

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
 * Converts lon/lat/height degrees to a Three vector using Cesium Ellipsoid.WGS84.
 *
 * @param longitudeDegrees Longitude in degrees.
 * @param latitudeDegrees Latitude in degrees.
 * @param height Height in meters.
 * @returns ECEF position in the shared Three/Cesium world frame.
 */
export function wgs84PositionFromDegrees(
	longitudeDegrees: number,
	latitudeDegrees: number,
	height = 0.0,
): Vector3 {
	const cartographic = new Cartographic(
		longitudeDegrees * Math.PI / 180.0,
		latitudeDegrees * Math.PI / 180.0,
		height,
	);
	const cartesian = Ellipsoid.WGS84.cartographicToCartesian( cartographic, new Cartesian3() );
	return cesiumCartesianToVector3( cartesian );
}

/**
 * Computes the geodetic up vector using Cesium Ellipsoid.WGS84.
 *
 * @param longitudeDegrees Longitude in degrees.
 * @param latitudeDegrees Latitude in degrees.
 * @returns Unit normal in ECEF coordinates.
 */
export function wgs84NormalFromDegrees( longitudeDegrees: number, latitudeDegrees: number ): Vector3 {
	const cartographic = new Cartographic(
		longitudeDegrees * Math.PI / 180.0,
		latitudeDegrees * Math.PI / 180.0,
		0.0,
	);
	const normal = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic( cartographic, new Cartesian3() );
	return cesiumCartesianToVector3( normal );
}
