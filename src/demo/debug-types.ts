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
	showPolygon: boolean;
	polygonPlotOrder: number;
	polygonColor: string;
	polygonAlpha: number;
	polygonCenterLon: number;
	polygonCenterLat: number;
	polygonOffsetEastMeters: number;
	polygonOffsetNorthMeters: number;
	polygonWidthMeters: number;
	polygonHeightMeters: number;
	polygonRotationDegrees: number;
	polygonVertexCount: number;
	polygonDentRatio: number;
	polygonHole: boolean;
	polygonHoleScale: number;
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
