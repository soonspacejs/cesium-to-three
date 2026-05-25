// ============================================================
// debug-types.ts
// 层级:demo UI 状态模型。
// 职责:定义贴地 demo 中 lil-gui 使用的可变状态对象。
// 依赖:贴地适配器共享 GIS 类型。
// 被消费:ground-demo.ts。
// ============================================================

import type { LonLatPoint } from '../lib/ground';

export interface GroundDebugSettings {
	// 矩形标绘
	points: LonLatPoint[];
	centerLon: number;
	centerLat: number;
	widthDegrees: number;
	heightDegrees: number;
	widthMeters: number;
	heightMeters: number;
	halfWidth: number;
	halfHeight: number;
	fillColor: string;
	fillOpacity: number;
	visible: boolean;
	rectanglePlotOrder: number;
	strokeColor: string;
	strokeOpacity: number;
	strokeWidth: number;
	fragmentCull: boolean;
	useTilesDepth: boolean;
	showTiles: boolean;
	showFrontStencil: boolean;
	showBackStencil: boolean;
	showColorPass: boolean;

	// 多边形标绘
	polygonVisible: boolean;
	polygonPlotOrder: number;
	polygonStrokeColor: string;
	polygonStrokeOpacity: number;
	polygonStrokeWidth: number;
	polygonFillColor: string;
	polygonFillOpacity: number;
	polygonPoints: LonLatPoint[];
	polygonHoles: LonLatPoint[][];
	polygonRotationDegrees: number;
	polygonHole: boolean;

	// 圆形标绘
	circleVisible: boolean;
	circlePlotOrder: number;
	circleCenterLon: number;
	circleCenterLat: number;
	circleRadius: number;
	circleHeight: number;
	circleExtrudedHeight: number;
	circleMinimumHeight: number;
	circleMaximumHeight: number;
	circleGranularityRadians: number;
	circleStRotationRadians: number;
	circleRingCount: number;
	circleRingGapMeters: number;
	circleSectorStartDegrees: number;
	circleSectorAngleDegrees: number;
	circleStrokeColor: string;
	circleStrokeOpacity: number;
	circleStrokeWidth: number;
	circleFillColor: string;
	circleFillOpacity: number;

	// 大尺度对照标绘
	largeRectangleVisible: boolean;
	largeRectanglePlotOrder: number;
	largeRectangleStrokeColor: string;
	largeRectangleStrokeOpacity: number;
	largeRectangleStrokeWidth: number;
	largeRectangleFillColor: string;
	largeRectangleFillOpacity: number;
	largeRectanglePoints: LonLatPoint[];
	largeRectangleWidthMeters: number;
	largeRectangleHeightMeters: number;
	largePolygonVisible: boolean;
	largePolygonPlotOrder: number;
	largePolygonStrokeColor: string;
	largePolygonStrokeOpacity: number;
	largePolygonStrokeWidth: number;
	largePolygonFillColor: string;
	largePolygonFillOpacity: number;
	largePolygonPoints: LonLatPoint[];
	largePolygonRotationDegrees: number;
	largeCircleVisible: boolean;
	largeCirclePlotOrder: number;
	largeCircleCenterLon: number;
	largeCircleCenterLat: number;
	largeCircleRadius: number;
	largeCircleStrokeColor: string;
	largeCircleStrokeOpacity: number;
	largeCircleStrokeWidth: number;
	largeCircleFillColor: string;
	largeCircleFillOpacity: number;

	// 调试面
	showDebugSurface: boolean;
	debugSurfaceHeight: number;
	debugSurfaceOpacity: number;
	rebuild: () => void;
}

export interface GroundDebugStatus {
	root: string;
	models: number;
	visibleTiles: number;
	cacheTiles: number;
	loadedTiles: number;
	queue: string;
	error: string;
}
