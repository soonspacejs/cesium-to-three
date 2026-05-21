// ============================================================
// debug-types.ts
// Layer: demo UI state model.
// Role: define the mutable lil-gui state objects used by the ground demo.
// Dependencies: ground adapter shared GIS types.
// Consumed by: ground-demo.ts.
// ============================================================

import type { LonLatPoint } from '../lib/ground';

export interface GroundDebugSettings {
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
	polygonDentRatio: number;
	polygonHole: boolean;
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
	circleRingGapRatio: number;
	circleSectorStartDegrees: number;
	circleSectorAngleDegrees: number;
	circleStrokeColor: string;
	circleStrokeOpacity: number;
	circleStrokeWidth: number;
	circleFillColor: string;
	circleFillOpacity: number;
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
