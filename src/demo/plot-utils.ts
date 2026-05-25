// ============================================================
// plot-utils.ts
// 层级:demo 标绘辅助工具。
// 职责:生成可编辑的局部 ENU 多边形控制形状，并管理标绘顺序。
// 依赖:贴地适配器共享 GIS 类型。
// 被消费:ground-demo.ts。
// ============================================================

import type { EastNorthOffsetMeters } from '../lib/ground';

const PLOT_RENDER_ORDER_COMMAND_COUNT = 3;
const PLOT_RENDER_ORDER_BASE = 1000;

/**
 * 将数值限制在闭区间内。
 *
 * @param value 输入值。
 * @param min 允许的最小值。
 * @param max 允许的最大值。
 * @returns 限制后的有限数值。
 */
export function clampNumber( value: number, min: number, max: number ): number {
	return Math.min( Math.max( value, min ), max );
}

/**
 * 将用户侧标绘顺序转换为有限的非负整数。
 *
 * @param plotOrder 来自 GUI 或标绘数据的用户侧顺序。
 * @returns 清洗后的标绘顺序。
 */
export function sanitizePlotOrder( plotOrder: number ): number {
	return Number.isFinite( plotOrder ) ? Math.max( Math.round( plotOrder ), 0 ) : 0;
}

/**
 * 记录标绘顺序的归属关系，保证 plotOrder 本身全局唯一。
 *
 * 该注册表刻意保持状态:只有每个标绘都有真实 owner 记录时，renderOrder 才可靠；
 * 不能只依赖数值间隔技巧推导唯一性。
 */
export class PlotOrderRegistry<PlotId> {
	private readonly plotOrderById = new Map<PlotId, number>();
	private readonly plotIdByOrder = new Map<number, PlotId>();
	private nextPlotOrder = 0;

	/**
	 * 注册一个标绘，并返回分配给它的唯一顺序。
	 *
	 * @param plotId 稳定的标绘身份。
	 * @param preferredPlotOrder 调用方可选请求的顺序。
	 * @returns plotId 拥有的唯一标绘顺序。
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
	 * 更新一个标绘的顺序，不改写其他标绘。
	 *
	 * @param plotId 稳定的标绘身份。
	 * @param preferredPlotOrder 为该标绘请求的顺序。
	 * @returns 实际分配给 plotId 的唯一标绘顺序。
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
	 * 返回某个标绘当前拥有的唯一顺序。
	 *
	 * @param plotId 稳定的标绘身份。
	 * @returns 已注册的标绘顺序。
	 */
	public get( plotId: PlotId ): number {
		const plotOrder = this.plotOrderById.get( plotId );
		if ( plotOrder === undefined ) {
			throw new Error( 'Plot id is not registered in PlotOrderRegistry.' );
		}

		return plotOrder;
	}

	/**
	 * 从注册表中移除一个标绘。
	 *
	 * @param plotId 稳定的标绘身份。
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
	 * 为一个标绘存储已经确认可用的顺序。
	 *
	 * @param plotId 稳定的标绘身份。
	 * @param plotOrder 为该标绘保留的唯一顺序。
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
	 * 分配下一个未使用顺序，不扫描或改写已有标绘。
	 *
	 * @returns 下一个唯一标绘顺序。
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
 * 将角度值转换为弧度。
 *
 * @param degrees 角度值，单位为度。
 * @returns 弧度值。
 */
function degreesToRadians( degrees: number ): number {
	return degrees * Math.PI / 180.0;
}

/**
 * 为旋转多边形生成局部 ENU 偏移。
 *
 * 这些偏移稍后会转换到 WGS84，因此真实三角剖分和 shadow-volume 构造仍由几何路径负责。
 *
 * @param widthMeters 局部东西方向宽度，单位米。
 * @param heightMeters 局部南北方向高度，单位米。
 * @param vertexCount 多边形顶点数量。
 * @param rotationDegrees 局部 ENU 中的逆时针视觉旋转角度。
 * @returns 按逆时针顺序排列的局部 east/north 偏移。
 */
export function createLocalPolygonOffsets(
	widthMeters: number,
	heightMeters: number,
	vertexCount: number,
	rotationDegrees: number,
): EastNorthOffsetMeters[] {
	const safeVertexCount = Math.round( clampNumber( vertexCount, 3, 64 ) );
	const halfWidthMeters = Math.max( widthMeters, 1.0 ) * 0.5;
	const halfHeightMeters = Math.max( heightMeters, 1.0 ) * 0.5;
	const rotationRadians = degreesToRadians( rotationDegrees );
	const cosRotation = Math.cos( rotationRadians );
	const sinRotation = Math.sin( rotationRadians );
	const offsets: EastNorthOffsetMeters[] = [];

	for ( let i = 0; i < safeVertexCount; i ++ ) {
		const angle = Math.PI * 0.5 + i * Math.PI * 2.0 / safeVertexCount;
		const localEast = Math.cos( angle ) * halfWidthMeters;
		const localNorth = Math.sin( angle ) * halfHeightMeters;
		offsets.push( {
			eastMeters: localEast * cosRotation - localNorth * sinRotation,
			northMeters: localEast * sinRotation + localNorth * cosRotation,
		} );
	}

	return offsets;
}

/**
 * 将用户侧标绘顺序转换为 Three renderOrder 命令块。
 *
 * 该函数只把已经唯一的 plotOrder 展开为 stencil 管线使用的三个绘制命令。
 * 真正的唯一性由 PlotOrderRegistry 保证；不要把这个函数当成去重器。
 *
 * @param plotOrder 唯一的用户侧标绘顺序。
 * @returns 图元 front-stencil 命令的基础 renderOrder。
 */
export function plotOrderToRenderOrder( plotOrder: number ): number {
	const safePlotOrder = sanitizePlotOrder( plotOrder );
	const renderOrder = PLOT_RENDER_ORDER_BASE + safePlotOrder * PLOT_RENDER_ORDER_COMMAND_COUNT;
	if ( ! Number.isSafeInteger( renderOrder ) ) {
		throw new Error( 'Plot renderOrder exceeded JavaScript safe integer range.' );
	}

	return renderOrder;
}
