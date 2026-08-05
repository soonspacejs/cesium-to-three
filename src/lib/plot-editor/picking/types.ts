import type {
	HeightReference,
	Position3D,
} from '../document/types';

export type PickSurface = 'terrain' | '3d-tile' | 'ellipsoid';
export type SurfaceTarget = 'ground' | 'terrain' | '3d-tile';

export interface ScreenPosition {
	readonly clientX: number;
	readonly clientY: number;
}

export interface SurfaceHit {
	/** 命中表面相对 WGS84 椭球的绝对坐标。 */
	readonly surfacePosition: Position3D;
	readonly surface: PickSurface;
	readonly distanceFromCamera: number;
	readonly sourceId?: string;
}

export interface PlotPickResult {
	readonly authorPosition: Position3D;
	readonly surfacePosition: Position3D;
	readonly surface: PickSurface;
	readonly heightReference: HeightReference;
}

export interface PickOptions {
	readonly heightReference: HeightReference;
	readonly absoluteHeight?: number;
	readonly relativeOffset?: number;
	readonly allowEllipsoidFallback?: boolean;
}

export interface PlotSurfacePicker {
	pick( screen: ScreenPosition, options: PickOptions ): PlotPickResult | null;
}

export interface HeightSampleRequest {
	readonly positions: readonly Position3D[];
	readonly target: SurfaceTarget;
	readonly signal: AbortSignal;
}

export interface HeightSample {
	readonly longitude: number;
	readonly latitude: number;
	readonly surfaceHeight: number | null;
	readonly source: PickSurface | null;
}

export interface PlotSurfaceHeightProvider {
	sampleHeights( request: HeightSampleRequest ): Promise<readonly HeightSample[]>;
	subscribe( listener: () => void ): () => void;
}

/** Three/宿主负责坐标系变换，本端口只接收已经转为 WGS84 的候选命中。 */
export interface SurfaceRaycastPort {
	pickTerrain( screen: ScreenPosition ): readonly SurfaceHit[];
	pickTiles( screen: ScreenPosition ): readonly SurfaceHit[];
	pickEllipsoid( screen: ScreenPosition ): SurfaceHit | null;
}
