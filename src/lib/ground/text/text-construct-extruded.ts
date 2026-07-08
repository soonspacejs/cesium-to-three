// ============================================================
// text-construct-extruded.ts
// Layer: L2 text shadow-volume geometry construction.
// Responsibility:
//   Convert a text footprint quad in ECEF into a closed, ellipsoid-following
//   shadow volume for the shared Cesium classification pipeline.
// ============================================================

import { Vector3 } from 'three';

import {
	geodeticSurfaceNormal,
	scaleToGeodeticSurface,
} from '../math/ellipsoid';
import { createIndexTypedArray } from '../rectangle/rectangle-attributes';

import {
	TEXT_DEFAULT_MAX_HEIGHT,
	TEXT_DEFAULT_MIN_HEIGHT,
	type TextShadowVolumeOptions,
} from './text-options';

/** Assembled text shadow-volume arrays consumed by text-shadow-volume.ts. */
export interface ExtrudedTextResult {
	/** ECEF positions, encoded later into high/low attributes. */
	positions: Float64Array;
	/** Top vertices keep (0,0,0); bottom vertices store -geodetic normal. */
	extrudeDirection: Float32Array;
	/** Closed volume triangles: top cap, bottom cap, and four side walls. */
	indices: Uint16Array | Uint32Array;
}

// Keep text footprint chords short enough that a large text box follows the
// ellipsoid instead of becoming a single long prism through the globe.
const TEXT_SURFACE_SEGMENT_TARGET_METERS = 4096.0;
const TEXT_SURFACE_MAX_SEGMENTS_PER_AXIS = 64;

const _sample = new Vector3();
const _surface = new Vector3();
const _normal = new Vector3();
const _scaled = new Vector3();
const _top = new Vector3();
const _bottom = new Vector3();

/**
 * Builds a closed text shadow volume from the four footprint corners.
 *
 * Text boxes are measured in CSS pixels, then multiplied by metersPerPixel.
 * At kilometer scales a four-corner prism is too coarse for zoomed-out globe
 * views: its long chords can diverge from the ellipsoid and destabilize the
 * stencil Z-fail classification. This function adaptively tessellates the
 * footprint before lifting it to top/bottom heights.
 *
 * @param options Text footprint corners plus optional min/max heights.
 * @returns Positions, extrusion directions, and triangle indices.
 */
export function constructExtrudedTextShadowVolume(
	options: TextShadowVolumeOptions,
): ExtrudedTextResult {
	const maximumHeight = options.maximumHeight !== undefined
		? options.maximumHeight
		: TEXT_DEFAULT_MAX_HEIGHT;
	const minimumHeight = options.minimumHeight !== undefined
		? options.minimumHeight
		: TEXT_DEFAULT_MIN_HEIGHT;

	if ( ! Number.isFinite( minimumHeight ) || ! Number.isFinite( maximumHeight ) ) {
		throw new Error(
			'constructExtrudedTextShadowVolume: minimumHeight and maximumHeight must be finite numbers.',
		);
	}
	if ( maximumHeight <= minimumHeight ) {
		throw new Error(
			`constructExtrudedTextShadowVolume: maximumHeight (${ maximumHeight }) must be greater than minimumHeight (${ minimumHeight }).`,
		);
	}

	const widthSegments = segmentCountForLength( Math.max(
		options.swEcef.distanceTo( options.seEcef ),
		options.nwEcef.distanceTo( options.neEcef ),
	) );
	const heightSegments = segmentCountForLength( Math.max(
		options.swEcef.distanceTo( options.nwEcef ),
		options.seEcef.distanceTo( options.neEcef ),
	) );
	const columns = widthSegments + 1;
	const rows = heightSegments + 1;
	const surfaceVertexCount = columns * rows;
	const vertexCount = surfaceVertexCount * 2;
	const positions = new Float64Array( vertexCount * 3 );
	const extrudeDirection = new Float32Array( vertexCount * 3 );
	const bottomFloatOffset = surfaceVertexCount * 3;

	for ( let y = 0; y < rows; y ++ ) {
		const v = y / heightSegments;
		for ( let x = 0; x < columns; x ++ ) {
			const u = x / widthSegments;
			writeExtrudedGridVertex(
				options,
				u,
				v,
				maximumHeight,
				minimumHeight,
				gridIndex( x, y, columns ),
				bottomFloatOffset,
				positions,
				extrudeDirection,
			);
		}
	}

	const indexCount =
		widthSegments * heightSegments * 12 +
		( widthSegments + heightSegments ) * 12;
	const indices = createIndexTypedArray( vertexCount, indexCount );
	writeGridIndices(
		widthSegments,
		heightSegments,
		columns,
		surfaceVertexCount,
		indices,
	);

	return { positions, extrudeDirection, indices };
}

function segmentCountForLength( lengthMeters: number ): number {
	if ( ! Number.isFinite( lengthMeters ) || lengthMeters <= 0.0 ) {
		return 1;
	}
	return Math.min(
		Math.max( Math.ceil( lengthMeters / TEXT_SURFACE_SEGMENT_TARGET_METERS ), 1 ),
		TEXT_SURFACE_MAX_SEGMENTS_PER_AXIS,
	);
}

function gridIndex( x: number, y: number, columns: number ): number {
	return y * columns + x;
}

function writeExtrudedGridVertex(
	options: TextShadowVolumeOptions,
	u: number,
	v: number,
	maximumHeight: number,
	minimumHeight: number,
	vertexIndex: number,
	bottomFloatOffset: number,
	positions: Float64Array,
	extrudeDirection: Float32Array,
): void {
	const oneMinusU = 1.0 - u;
	const oneMinusV = 1.0 - v;
	_sample.set(
		options.swEcef.x * oneMinusU * oneMinusV +
			options.seEcef.x * u * oneMinusV +
			options.nwEcef.x * oneMinusU * v +
			options.neEcef.x * u * v,
		options.swEcef.y * oneMinusU * oneMinusV +
			options.seEcef.y * u * oneMinusV +
			options.nwEcef.y * oneMinusU * v +
			options.neEcef.y * u * v,
		options.swEcef.z * oneMinusU * oneMinusV +
			options.seEcef.z * u * oneMinusV +
			options.nwEcef.z * oneMinusU * v +
			options.neEcef.z * u * v,
	);

	const surface = scaleToGeodeticSurface( _sample, _surface );
	if ( surface === undefined ) {
		throw new Error(
			`PlotText footprint sample u=${ u }, v=${ v } projects to ellipsoid center.`,
		);
	}

	const normal = geodeticSurfaceNormal( _surface, _normal );
	if ( normal === undefined ) {
		throw new Error(
			`PlotText footprint sample u=${ u }, v=${ v } cannot compute geodetic normal.`,
		);
	}

	_scaled.copy( normal ).multiplyScalar( maximumHeight );
	_top.copy( _surface ).add( _scaled );
	_scaled.copy( normal ).multiplyScalar( minimumHeight );
	_bottom.copy( _surface ).add( _scaled );

	const topBase = vertexIndex * 3;
	const bottomBase = bottomFloatOffset + topBase;
	positions[ topBase ] = _top.x;
	positions[ topBase + 1 ] = _top.y;
	positions[ topBase + 2 ] = _top.z;
	positions[ bottomBase ] = _bottom.x;
	positions[ bottomBase + 1 ] = _bottom.y;
	positions[ bottomBase + 2 ] = _bottom.z;

	extrudeDirection[ bottomBase ] = -normal.x;
	extrudeDirection[ bottomBase + 1 ] = -normal.y;
	extrudeDirection[ bottomBase + 2 ] = -normal.z;
}

function writeGridIndices(
	widthSegments: number,
	heightSegments: number,
	columns: number,
	bottomVertexOffset: number,
	indices: Uint16Array | Uint32Array,
): void {
	let cursor = 0;
	for ( let y = 0; y < heightSegments; y ++ ) {
		for ( let x = 0; x < widthSegments; x ++ ) {
			const sw = gridIndex( x, y, columns );
			const se = gridIndex( x + 1, y, columns );
			const nw = gridIndex( x, y + 1, columns );
			const ne = gridIndex( x + 1, y + 1, columns );

			cursor = writeTriangle( indices, cursor, sw, se, ne );
			cursor = writeTriangle( indices, cursor, sw, ne, nw );
			cursor = writeTriangle(
				indices,
				cursor,
				bottomVertexOffset + sw,
				bottomVertexOffset + ne,
				bottomVertexOffset + se,
			);
			cursor = writeTriangle(
				indices,
				cursor,
				bottomVertexOffset + sw,
				bottomVertexOffset + nw,
				bottomVertexOffset + ne,
			);
		}
	}

	for ( let x = 0; x < widthSegments; x ++ ) {
		const sw = gridIndex( x, 0, columns );
		const se = gridIndex( x + 1, 0, columns );
		cursor = writeWallSegment( indices, cursor, sw, se, bottomVertexOffset );
	}
	for ( let y = 0; y < heightSegments; y ++ ) {
		const se = gridIndex( widthSegments, y, columns );
		const ne = gridIndex( widthSegments, y + 1, columns );
		cursor = writeWallSegment( indices, cursor, se, ne, bottomVertexOffset );
	}
	for ( let x = widthSegments; x > 0; x -- ) {
		const ne = gridIndex( x, heightSegments, columns );
		const nw = gridIndex( x - 1, heightSegments, columns );
		cursor = writeWallSegment( indices, cursor, ne, nw, bottomVertexOffset );
	}
	for ( let y = heightSegments; y > 0; y -- ) {
		const nw = gridIndex( 0, y, columns );
		const sw = gridIndex( 0, y - 1, columns );
		cursor = writeWallSegment( indices, cursor, nw, sw, bottomVertexOffset );
	}
}

function writeWallSegment(
	indices: Uint16Array | Uint32Array,
	cursor: number,
	topA: number,
	topB: number,
	bottomVertexOffset: number,
): number {
	const bottomA = bottomVertexOffset + topA;
	const bottomB = bottomVertexOffset + topB;
	cursor = writeTriangle( indices, cursor, topA, bottomA, bottomB );
	return writeTriangle( indices, cursor, topA, bottomB, topB );
}

function writeTriangle(
	indices: Uint16Array | Uint32Array,
	cursor: number,
	a: number,
	b: number,
	c: number,
): number {
	indices[ cursor ] = a;
	indices[ cursor + 1 ] = b;
	indices[ cursor + 2 ] = c;
	return cursor + 3;
}
