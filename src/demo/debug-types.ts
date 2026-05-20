// ============================================================
// debug-types.ts
// Layer: demo UI state model.
// Role: define the mutable lil-gui state objects used by the ground demo.
// Dependencies: none.
// Consumed by: ground-demo.ts.
// ============================================================

export interface GroundDebugSettings {
	centerLon: number;
	centerLat: number;
	widthDegrees: number;
	heightDegrees: number;
	widthMeters: number;
	heightMeters: number;
	halfWidth: number;
	halfHeight: number;
	color: string;
	alpha: number;
	showRectangle: boolean;
	rectanglePlotOrder: number;
	showDebugBorder: boolean;
	borderColor: string;
	borderOpacity: number;
	borderWidthMeters: number;
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
