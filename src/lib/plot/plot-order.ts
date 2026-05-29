// ============================================================
// plot-order.ts — 标绘顺序 → Three renderOrder 换算
// 层级：plot 工具（从 demo/plot-utils.ts 提升，供 lib 内部使用，
//       避免 lib 依赖 demo）。
// 职责：把唯一的用户侧 plotOrder 展开为 stencil 管线使用的命令块基序。
//       每个标绘对应 3 个命令（前/后 stencil + color），命令块以
//       1000 为基址、3 为步长分配。
// 依赖：无。
// 被消费：PlotPrimitiveBridge（按 Map 插入序为每个标绘分配递增 plotOrder
//        再经此函数得到 renderOrder）；demo 端如需自定义层序也可复用。
// ============================================================

/** 每个标绘对应的 classification 命令数（前 stencil / 后 stencil / color）。 */
const PLOT_RENDER_ORDER_COMMAND_COUNT = 3;
/** 标绘 renderOrder 基址；> demo 里 polyline 默认（40）等所有内置图元。 */
const PLOT_RENDER_ORDER_BASE = 1000;

/**
 * 将用户侧标绘顺序清洗为有限非负整数。
 *
 * @param plotOrder 来自 GUI 或标绘数据的用户侧顺序。
 * @returns         非负整数（NaN / Infinity / 负数均回退到 0）。
 */
export function sanitizePlotOrder( plotOrder: number ): number {
	return Number.isFinite( plotOrder )
		? Math.max( Math.round( plotOrder ), 0 )
		: 0;
}

/**
 * 将唯一 plotOrder 展开为 front-stencil 命令块的基础 renderOrder。
 *
 * 该函数只把已经唯一的 plotOrder 展开为 stencil 管线使用的三个绘制命令。
 * 真正的唯一性由桥接器按 Map 插入序分配 plotOrder 保证；不要把这个函数
 * 当成去重器。
 *
 * @param plotOrder 唯一用户侧顺序。
 * @returns         基础 renderOrder = 1000 + plotOrder × 3。
 */
export function plotOrderToRenderOrder( plotOrder: number ): number {
	const safe = sanitizePlotOrder( plotOrder );
	const renderOrder = PLOT_RENDER_ORDER_BASE + safe * PLOT_RENDER_ORDER_COMMAND_COUNT;
	if ( ! Number.isSafeInteger( renderOrder ) ) {
		throw new Error( 'Plot renderOrder exceeded JavaScript safe integer range.' );
	}
	return renderOrder;
}
