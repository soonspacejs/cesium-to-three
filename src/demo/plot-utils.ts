// ============================================================
// plot-utils.ts
// Layer: demo plotting helpers.
// Role: build editable local ENU polygon control shapes and plot ordering.
// Dependencies: ground adapter shared GIS types.
// Consumed by: ground-demo.ts.
// ============================================================

import type { EastNorthOffsetMeters } from '../lib/ground';

const PLOT_RENDER_ORDER_COMMAND_COUNT = 3;
const PLOT_RENDER_ORDER_BASE = 1000;

/**
 * Clamps a number to a closed interval.
 *
 * @param value Input value.
 * @param min Minimum accepted value.
 * @param max Maximum accepted value.
 * @returns Clamped finite value.
 */
export function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * Converts a user-facing plot order to a finite non-negative integer.
 *
 * @param plotOrder User-facing plot order from GUI or plot data.
 * @returns Sanitized plot order.
 */
export function sanitizePlotOrder( plotOrder: number ): number {
	return Number.isFinite( plotOrder ) ? Math.max( Math.round( plotOrder ), 0 ) : 0;
}

/**
 * Tracks plot-order ownership so plotOrder itself is globally unique.
 *
 * The registry is intentionally stateful: renderOrder can only be reliable when
 * each plot has a real owner record, instead of deriving uniqueness from a
 * numeric spacing trick.
 */
export class PlotOrderRegistry<PlotId> {
	private readonly plotOrderById = new Map<PlotId, number>();
	private readonly plotIdByOrder = new Map<number, PlotId>();
	private nextPlotOrder = 0;

	/**
	 * Registers a plot and returns the unique order assigned to it.
	 *
	 * @param plotId Stable plot identity.
	 * @param preferredPlotOrder Optional order requested by the caller.
	 * @returns Unique plot order owned by plotId.
	 */
	public register( plotId: PlotId, preferredPlotOrder?: number ): number {
		if ( this.plotOrderById.has( plotId ) ) {
			return this.update( plotId, preferredPlotOrder ?? this.get( plotId ) );
		}

		const preferred = sanitizePlotOrder( preferredPlotOrder ?? this.nextPlotOrder );
		const plotOrder = this.plotIdByOrder.has( preferred )
			? this.allocateNextPlotOrder()
			: preferred;
		this.assignPlotOrder( plotId, plotOrder );
		return plotOrder;
	}

	/**
	 * Updates one plot's order without rewriting other plots.
	 *
	 * @param plotId Stable plot identity.
	 * @param preferredPlotOrder Order requested for this plot.
	 * @returns Unique plot order actually assigned to plotId.
	 */
	public update( plotId: PlotId, preferredPlotOrder: number ): number {
		const currentPlotOrder = this.get( plotId );
		const preferred = sanitizePlotOrder( preferredPlotOrder );
		const owner = this.plotIdByOrder.get( preferred );

		if ( owner !== undefined && owner !== plotId ) {
			return currentPlotOrder;
		}

		if ( preferred === currentPlotOrder ) {
			return currentPlotOrder;
		}

		this.plotOrderById.delete( plotId );
		this.plotIdByOrder.delete( currentPlotOrder );
		this.assignPlotOrder( plotId, preferred );
		return preferred;
	}

	/**
	 * Returns the unique order currently owned by one plot.
	 *
	 * @param plotId Stable plot identity.
	 * @returns Registered plot order.
	 */
	public get( plotId: PlotId ): number {
		const plotOrder = this.plotOrderById.get( plotId );
		if ( plotOrder === undefined ) {
			throw new Error( 'Plot id is not registered in PlotOrderRegistry.' );
		}

		return plotOrder;
	}

	/**
	 * Removes one plot from the registry.
	 *
	 * @param plotId Stable plot identity.
	 */
	public release( plotId: PlotId ): void {
		const plotOrder = this.plotOrderById.get( plotId );
		if ( plotOrder === undefined ) {
			return;
		}

		this.plotOrderById.delete( plotId );
		this.plotIdByOrder.delete( plotOrder );
	}

	/**
	 * Stores an already available order for one plot.
	 *
	 * @param plotId Stable plot identity.
	 * @param plotOrder Unique order reserved for this plot.
	 */
	private assignPlotOrder( plotId: PlotId, plotOrder: number ): void {
		this.plotOrderById.set( plotId, plotOrder );
		this.plotIdByOrder.set( plotOrder, plotId );
		this.nextPlotOrder = Math.max( this.nextPlotOrder, plotOrder + 1 );
		if ( ! Number.isSafeInteger( this.nextPlotOrder ) ) {
			throw new Error( 'Plot order exceeded JavaScript safe integer range.' );
		}
	}

	/**
	 * Allocates the next unused order without scanning or rewriting existing plots.
	 *
	 * @returns Next unique plot order.
	 */
	private allocateNextPlotOrder(): number {
		while ( this.plotIdByOrder.has( this.nextPlotOrder ) ) {
			this.nextPlotOrder ++;
			if ( ! Number.isSafeInteger( this.nextPlotOrder ) ) {
				throw new Error( 'Plot order exceeded JavaScript safe integer range.' );
			}
		}

		return this.nextPlotOrder;
	}
}

/**
 * Converts one degree value to radians.
 *
 * @param degrees Angle in degrees.
 * @returns Angle in radians.
 */
function degreesToRadians( degrees: number ): number {
	return degrees * Math.PI / 180.0;
}

/**
 * Builds local ENU offsets for a rotated polygon.
 *
 * The offsets are converted to WGS84 later, so Cesium still owns the actual
 * ground polygon triangulation and shadow-volume construction.
 *
 * @param widthMeters Width in local east-west meters.
 * @param heightMeters Height in local north-south meters.
 * @param vertexCount Number of polygon vertices.
 * @param rotationDegrees Counter-clockwise visual rotation in local ENU.
 * @param dentRatio Radius scale for every alternate vertex.
 * @returns Local east/north offsets in counter-clockwise order.
 */
export function createLocalPolygonOffsets(
	widthMeters: number,
	heightMeters: number,
	vertexCount: number,
	rotationDegrees: number,
	dentRatio: number,
): EastNorthOffsetMeters[] {
	const safeVertexCount = Math.round( clampNumber( vertexCount, 3, 64 ) );
	const halfWidthMeters = Math.max( widthMeters, 1.0 ) * 0.5;
	const halfHeightMeters = Math.max( heightMeters, 1.0 ) * 0.5;
	const safeDentRatio = clampNumber( dentRatio, 0.05, 1.0 );
	const rotationRadians = degreesToRadians( rotationDegrees );
	const cosRotation = Math.cos( rotationRadians );
	const sinRotation = Math.sin( rotationRadians );
	const offsets: EastNorthOffsetMeters[] = [];

	for ( let i = 0; i < safeVertexCount; i ++ ) {
		const angle = Math.PI * 0.5 + i * Math.PI * 2.0 / safeVertexCount;
		const radiusScale = i % 2 === 0 ? 1.0 : safeDentRatio;
		const localEast = Math.cos( angle ) * halfWidthMeters * radiusScale;
		const localNorth = Math.sin( angle ) * halfHeightMeters * radiusScale;
		offsets.push( {
			eastMeters: localEast * cosRotation - localNorth * sinRotation,
			northMeters: localEast * sinRotation + localNorth * cosRotation,
		} );
	}

	return offsets;
}

/**
 * Converts a user-facing plot order to a Three renderOrder command block.
 *
 * This function is only an expansion from one already-unique plot order to the
 * three draw commands used by the stencil pipeline. PlotOrderRegistry owns the
 * real uniqueness guarantee; this function must not be used as a de-duplicator.
 *
 * @param plotOrder Unique user-facing plot order.
 * @returns Base renderOrder for the primitive's front-stencil command.
 */
export function plotOrderToRenderOrder( plotOrder: number ): number {
	const safePlotOrder = sanitizePlotOrder( plotOrder );
	const renderOrder = PLOT_RENDER_ORDER_BASE + safePlotOrder * PLOT_RENDER_ORDER_COMMAND_COUNT;
	if ( ! Number.isSafeInteger( renderOrder ) ) {
		throw new Error( 'Plot renderOrder exceeded JavaScript safe integer range.' );
	}

	return renderOrder;
}
