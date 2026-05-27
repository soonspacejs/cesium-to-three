// ============================================================
// line.ts — GisPlotLine 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts）
// 职责：折线标绘的数据模型。无几何派生，沿用基类的 getCenterPoints /
//       getExtentPoints（全部顶点）。
// 依赖：./base.ts、./types.ts。
// 被消费：GroundDecalManager（addPlot 'line' 分支）、桥接器。
// ============================================================

import { GisPlotBase } from './base';
import type { PlotLineOptions } from './types';

export class GisPlotLine extends GisPlotBase {

	public override readonly category = 'line' as const;
	public declare options: PlotLineOptions;

	/**
	 * @param options 折线标绘选项。
	 */
	public constructor( options: PlotLineOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotLineOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotLineOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotLineOptions;
	}
}
