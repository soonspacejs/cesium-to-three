// ============================================================
// primitives.ts
// Layer: Ground primitive construction(rectangle 与 polygon 路径均已 Cesium-free)。
// Role: build rectangle and polygon shadow volumes。
//       两条路径都基于本地 math/ + rectangle/ + polygon/ 模块,完全不再 import
//       cesium-ground-source 中的任何对象。共享 classification 运行时(`classification.ts`
//       不动)。
// Dependencies: Three.js debug meshes,本地 ground rectangle/polygon/math 模块。
// Consumed by: public ground adapter and demos。
// ============================================================

import {
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	type Material,
} from 'three';

import { CesiumClassificationPrimitive } from './classification';
import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
} from './constants';
import {
	expandPolygonPointsThroughMeters,
} from './polygon/polygon-helpers';
import {
	normalizePolygonPoints,
	polygonHierarchyFromLonLatPoints,
	type PolygonHierarchy,
} from './polygon/polygon-hierarchy';
import { POLYGON_DEFAULT_GRANULARITY } from './polygon/polygon-options';
import { computePolygonPlanarExtents } from './polygon/polygon-extents';
import {
	buildPolygonShadowVolumeGeometry,
	type PolygonGeometryUserData,
} from './polygon/polygon-shadow-volume';
import { computePolygonPlanarStylePoints } from './polygon/polygon-style-points';
import { createDebugRectangleSurfaceGeometry } from './rectangle/rectangle-debug';
import { computeRectanglePlanarExtents } from './rectangle/rectangle-extents';
import {
	expandRectangleDegreesThroughMeters,
	rectangleDegreesFromLonLatPoints,
} from './rectangle/rectangle-helpers';
import {
	rectangleRadiansFromDegrees,
} from './rectangle/rectangle-radians';
import { buildRectangleShadowVolumeGeometry } from './rectangle/rectangle-shadow-volume';
import type {
	CesiumGroundFrameState,
	CesiumGroundPolygonPrimitiveOptions,
	CesiumGroundRectanglePrimitiveOptions,
	RectangleRadians,
} from './types';

/**
 * Converts SoonSpace-style integer opacity into the normalized shader range.
 *
 * @param opacity Percent opacity in the 0-100 store format.
 * @returns Clamped opacity in the 0-1 range used by Three uniforms.
 */
function normalizePercentOpacity( opacity: number ): number {
	const safeOpacity = Number.isFinite( opacity ) ? opacity : 100.0;
	return Math.min( Math.max( safeOpacity, 0.0 ), 100.0 ) / 100.0;
}

/**
 * Ground rectangle implemented with the native rectangle shadow-volume pipeline.
 *
 * 本类的公共 API(类名、构造选项、`update / setRenderOrder / dispose` 方法、
 * `classification / debugSurface / rectangle` 字段)与重构前完全一致;
 * 内部 6 步 Cesium 几何调用(Rectangle.fromDegrees → new RectangleGeometry →
 * createShadowVolume → createGeometry → encodeAttribute → cesiumGeometryToThree)
 * 被替换为 1 步 `buildRectangleShadowVolumeGeometry`,plot-spec 4 lon/lat 点
 * 适配、米外扩、opacity 归一化、setBorderStyle / visible 控制全部保留不动。
 */
export class CesiumGroundRectanglePrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly debugSurface: Mesh | null;
	public readonly rectangle: RectangleRadians;

	public constructor( options: CesiumGroundRectanglePrimitiveOptions ) {
		// ── plot-spec 4 lon/lat 点 → 轴对齐度矩形 ──
		const rectangleDegrees = rectangleDegreesFromLonLatPoints( options.points );

		// ── strokeWidth 米外扩 → render 度矩形 ──
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);
		const renderRectangleDegrees = expandRectangleDegreesThroughMeters(
			rectangleDegrees,
			strokeWidthMeters,
		);

		// ── 度→弧度(fill 与 render 两份)──
		const fillRectangleRadians = rectangleRadiansFromDegrees(
			rectangleDegrees.west,
			rectangleDegrees.south,
			rectangleDegrees.east,
			rectangleDegrees.north,
		);
		const renderRectangleRadians = rectangleRadiansFromDegrees(
			renderRectangleDegrees.west,
			renderRectangleDegrees.south,
			renderRectangleDegrees.east,
			renderRectangleDegrees.north,
		);
		this.rectangle = fillRectangleRadians;

		// ── 默认值 ──
		const granularity = options.granularityRadians ?? ( Math.PI / 180.0 / 32.0 );
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;

		// ── 几何构造(1 步取代原 6 步 Cesium 调用)──
		const threeGeometry = buildRectangleShadowVolumeGeometry( {
			rectangle: renderRectangleRadians,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// ── PlanarExtents uniforms ──
		const extents = computeRectanglePlanarExtents(
			renderRectangleRadians,
			fillRectangleRadians,
			maximumHeight,
		);

		// ── 颜色 / opacity 归一化(0-100 → 0-1,保留行为)──
		const color = new Color( options.fillColor );
		const alpha = normalizePercentOpacity( options.fillOpacity );

		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 10,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible;
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);

		// ── Debug 椭球面网格(可选)──
		this.debugSurface = null;
		if ( options.debugSurface === true ) {
			const debugThreeGeometry = createDebugRectangleSurfaceGeometry(
				fillRectangleRadians,
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
 * Ground polygon implemented with the native polygon shadow-volume pipeline.
 *
 * 本类的公共 API(类名、构造选项、`update / setRenderOrder / dispose` 方法、
 * `classification / polygonHierarchy / rotationDegrees / dentRatio / hole`
 * 字段)与重构前完全一致;内部 6 步 Cesium 几何调用
 * (polygonHierarchyDegreesToCesium → new PolygonGeometry → createShadowVolume →
 * createGeometry → GeometryPipeline.encodeAttribute → cesiumGeometryToThree)
 * 被替换为 1 步 `buildPolygonShadowVolumeGeometry`,plot-spec 校验、stroke 米外扩、
 * opacity 归一化、setBorderStyle / setPolygonBorderPoints / visible 控制全部保留不动。
 *
 * `polygonHierarchy` 字段类型从 `{ positions: CartesianLike[]; holes: unknown[] }`
 * 改为 `PolygonHierarchy`(Vector3 ECEF + Vector3 hole),Vector3 与 Cesium Cartesian3
 * 在 `CartesianLike`(`.x .y .z`)契约上结构兼容,但 `instanceof Cesium.Cartesian3`
 * 与 Cesium 特有 API 调用不可用(R7 文档化决策)。
 */
export class CesiumGroundPolygonPrimitive {
	public readonly classification: CesiumClassificationPrimitive;
	public readonly polygonHierarchy: PolygonHierarchy;
	public readonly rotationDegrees: number;
	public readonly dentRatio: number;
	public readonly hole: boolean;

	public constructor( options: CesiumGroundPolygonPrimitiveOptions ) {
		// ── plot-spec 校验 + 浅拷贝 ──
		// normalizePolygonPoints 在 polygon-hierarchy.ts 中迁移版本上还增加了
		// 跨 IDL / 极地保护(R6),非合法输入会抛 Error。
		const fillPoints = normalizePolygonPoints( options.points );

		// ── 旋转 / 凹陷比 / hole 开关 ──
		this.rotationDegrees = Number.isFinite( options.rotationDegrees )
			? options.rotationDegrees
			: 0.0;
		this.dentRatio = Number.isFinite( options.dentRatio )
			? Math.min( Math.max( options.dentRatio, 0.05 ), 1.0 )
			: 1.0;
		this.hole = options.hole === true;

		// ── 描边宽度(米)归一化 ──
		const strokeWidthMeters = Math.max(
			Number.isFinite( options.strokeWidth ) ? options.strokeWidth : 0.0,
			0.0,
		);

		// ── fill → render 米外扩(plot-spec 描边覆盖区)──
		const renderPoints = expandPolygonPointsThroughMeters(
			fillPoints,
			strokeWidthMeters,
		);

		// ── 构建两份 PolygonHierarchy(Vector3 ECEF;一步到位,不经 Cesium 中间格式)──
		const holesInput = this.hole ? options.holes ?? [] : [];
		const fillHierarchy = polygonHierarchyFromLonLatPoints( fillPoints, holesInput );
		const renderHierarchy = polygonHierarchyFromLonLatPoints( renderPoints, holesInput );
		this.polygonHierarchy = fillHierarchy;

		// ── 默认值 ──
		const granularity = options.granularityRadians ?? POLYGON_DEFAULT_GRANULARITY;
		const minimumHeight = options.minimumHeight ?? - CESIUM_GLOBE_MINIMUM_ALTITUDE;
		const maximumHeight = options.maximumHeight ?? CESIUM_GLOBE_MINIMUM_ALTITUDE;

		// ── 几何构造(1 步取代原 6 步 Cesium 调用)──
		const threeGeometry = buildPolygonShadowVolumeGeometry( {
			hierarchy: renderHierarchy,
			granularity,
			minimumHeight,
			maximumHeight,
		} );

		// ── 从 BufferGeometry.userData 取 polygonRectangle(由 buildPolygonShadowVolumeGeometry 挂载)──
		const userData = threeGeometry.userData as PolygonGeometryUserData;
		const polygonRectangle = userData.polygonRectangle;

		// ── PlanarExtents uniforms + style points(用 render hierarchy + fill 顶点)──
		const extents = computePolygonPlanarExtents(
			polygonRectangle,
			renderHierarchy,
			maximumHeight,
		);
		const stylePoints = computePolygonPlanarStylePoints(
			polygonRectangle,
			renderHierarchy,
			fillPoints,
			maximumHeight,
		);

		// ── 颜色 / opacity 归一化(0-100 → 0-1,保留行为)──
		const color = new Color( options.fillColor );
		const alpha = normalizePercentOpacity( options.fillOpacity );

		this.classification = new CesiumClassificationPrimitive(
			threeGeometry,
			extents,
			color,
			alpha,
			options.renderOrder ?? 30,
			options.fragmentCull ?? true,
		);
		this.classification.group.visible = options.visible;
		this.classification.setBorderStyle(
			strokeWidthMeters > 0.0,
			new Color( options.strokeColor ),
			normalizePercentOpacity( options.strokeOpacity ),
			strokeWidthMeters,
		);
		this.classification.setPolygonBorderPoints( stylePoints );
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
