// ============================================================
// primitives.ts
// Layer: Cesium GroundPrimitive geometry construction.
// Role: build rectangle and polygon shadow volumes with unmodified Cesium
//       geometry generators, then wrap them in Three classification commands.
// Dependencies: Cesium Core geometry, Three.js debug meshes, ground geometry
//       helpers, and classification command group.
// Consumed by: public ground adapter and demos.
// ============================================================

import {
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	type Material,
} from 'three';

// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Rectangle from '../../../cesium-ground-source/engine/Source/Core/Rectangle.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import RectangleGeometry from '../../../cesium-ground-source/engine/Source/Core/RectangleGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import PolygonGeometry from '../../../cesium-ground-source/engine/Source/Core/PolygonGeometry.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import VertexFormat from '../../../cesium-ground-source/engine/Source/Core/VertexFormat.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import Ellipsoid from '../../../cesium-ground-source/engine/Source/Core/Ellipsoid.js';
// @ts-ignore Cesium source is intentionally kept as unmodified JavaScript.
import GeometryPipeline from '../../../cesium-ground-source/engine/Source/Core/GeometryPipeline.js';

import { CesiumClassificationPrimitive } from './classification';
import { CESIUM_GLOBE_MINIMUM_ALTITUDE } from './constants';
import {
	cesiumGeometryToThree,
	computePlanarExtents,
	computePolygonPlanarExtents,
	createDebugRectangleSurfaceGeometry,
	expandRectangleDegreesThroughMeters,
	polygonHierarchyDegreesToCesium,
} from './geometry';
import type {
	CartesianLike,
	CesiumGeometryResult,
	CesiumGroundFrameState,
	CesiumGroundPolygonOptions,
	CesiumGroundRectangleOptions,
	RectangleRadians,
} from './types';

/**
 * Ground rectangle implemented with Cesium RectangleGeometry.createShadowVolume.
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: unknown;

	public constructor( options: CesiumGroundRectangleOptions ) {
		const fillRectangle = Rectangle.fromDegrees(
			options.rectangleDegrees.west,
			options.rectangleDegrees.south,
			options.rectangleDegrees.east,
			options.rectangleDegrees.north,
		);
		const borderWidthMeters = options.borderWidthMeters ?? 0.0;
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			options.rectangleDegrees,
			borderWidthMeters,
		);
		const renderRectangle = Rectangle.fromDegrees(
			renderRectangleDegrees.west,
			renderRectangleDegrees.south,
			renderRectangleDegrees.east,
			renderRectangleDegrees.north,
		);
		this.rectangle = fillRectangle;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const rectangleGeometry = new RectangleGeometry( {
			rectangle: renderRectangle,
			ellipsoid: Ellipsoid.WGS84,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
		} );
		const shadowVolumeGeometry = RectangleGeometry.createShadowVolume(
			rectangleGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = RectangleGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult;

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );

		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const extents = computePlanarExtents( renderRectangle, Ellipsoid.WGS84, maximumHeight, fillRectangle );
		const color = new Color( options.color ?? 0xff2f2f );
		const alpha = options.alpha ?? 0.65;
		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 10,
			options.fragmentCull ?? true,
		);
		this.classification.setBorderStyle(
			options.border ?? false,
			new Color( options.borderColor ?? 0xffffff ),
			options.borderOpacity ?? 0.95,
			borderWidthMeters,
		);

		this.debugSurface = null;
		if ( options.debugSurface === true ) {
			const debugThreeGeometry = createDebugRectangleSurfaceGeometry(
				fillRectangle as RectangleRadians,
				options.debugSurfaceHeight ?? 5000.0,
			);
			const debugMaterial = new MeshBasicMaterial( {
				color,
				transparent: true,
				opacity: options.debugSurfaceOpacity ?? alpha,
				depthTest: false,
				depthWrite: false,
				side: DoubleSide,
				toneMapped: false,
			} );
			debugMaterial.name = 'CesiumGroundRectangleDebugSurfaceMaterial';

			this.debugSurface = new Mesh( debugThreeGeometry, debugMaterial );
			this.debugSurface.name = 'CesiumGroundRectangleDebugSurface';
			this.debugSurface.frustumCulled = false;
			this.debugSurface.renderOrder = ( options.renderOrder ?? 10 ) + 2;
			this.classification.group.add( this.debugSurface );
		}
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Updates this rectangle's command-block render order.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
		if ( this.debugSurface ) {
			this.debugSurface.renderOrder = renderOrder + 2;
		}
	}

	/**
	 * Releases resources.
	 */
	public dispose(): void {
		this.classification.dispose();
		if ( this.debugSurface ) {
			this.debugSurface.geometry.dispose();
			( this.debugSurface.material as Material ).dispose();
		}
	}
}

/**
 * Ground polygon implemented with Cesium PolygonGeometry.createShadowVolume.
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: { positions: CartesianLike[]; holes: unknown[] };

	public constructor( options: CesiumGroundPolygonOptions ) {
		const polygonHierarchy = polygonHierarchyDegreesToCesium( options.polygonHierarchyDegrees );
		this.polygonHierarchy = polygonHierarchy;

		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const polygonGeometry = new PolygonGeometry( {
			polygonHierarchy,
			ellipsoid: Ellipsoid.WGS84,
			granularity,
			vertexFormat: VertexFormat.POSITION_ONLY,
			perPositionHeight: false,
		} );
		const shadowVolumeGeometry = PolygonGeometry.createShadowVolume(
			polygonGeometry,
			() => minimumHeight,
			() => maximumHeight,
		);
		const cesiumGeometry = PolygonGeometry.createGeometry( shadowVolumeGeometry ) as CesiumGeometryResult;

		GeometryPipeline.encodeAttribute( cesiumGeometry, 'position', 'position3DHigh', 'position3DLow' );

		const threeGeometry = cesiumGeometryToThree( cesiumGeometry );
		const extents = computePolygonPlanarExtents(
			polygonGeometry.rectangle,
			polygonHierarchy,
			Ellipsoid.WGS84,
			maximumHeight,
		);
		const color = new Color( options.color ?? 0x00aaff );
		const alpha = options.alpha ?? 0.65;
		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 30,
			options.fragmentCull ?? true,
		);
		this.classification.setBorderStyle( false, new Color( 0xffffff ), 0.0, 0.0 );
	}

	/**
	 * Updates per-frame uniforms.
	 *
	 * @param frameState Current Three-side frame state.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.classification.update( frameState );
	}

	/**
	 * Updates this polygon's command-block render order.
	 *
	 * @param renderOrder Base order assigned to the front-stencil command.
	 */
	public setRenderOrder( renderOrder: number ): void {
		this.classification.setRenderOrder( renderOrder );
	}

	/**
	 * Releases resources.
	 */
	public dispose(): void {
		this.classification.dispose();
	}
}
