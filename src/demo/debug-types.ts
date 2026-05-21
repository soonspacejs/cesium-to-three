// ============================================================
// debug-types.ts
// Layer: demo UI state model.
// Role: define the mutable lil-gui state objects used by the ground demo.
// Dependencies: ground adapter shared GIS types.
// Consumed by: ground-demo.ts.
// ============================================================

import type { LonLatPoint } from '../lib/ground';
import type { CesiumGroundPointShape } from '../lib/ground';

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
	circleRingGapMeters: number;
	circleSectorStartDegrees: number;
	circleSectorAngleDegrees: number;
	circleStrokeColor: string;
	circleStrokeOpacity: number;
	circleStrokeWidth: number;
	circleFillColor: string;
	circleFillOpacity: number;
	pointVisible: boolean;
	pointPlotOrder: number;
	pointShape: CesiumGroundPointShape;
	pointLon: number;
	pointLat: number;
	pointSize: number;
	pointStrokeColor: string;
	pointStrokeOpacity: number;
	pointStrokeWidth: number;
	pointFillColor: string;
	pointFillOpacity: number;
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
