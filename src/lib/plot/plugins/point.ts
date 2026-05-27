// ============================================================
// point.ts — GisPlotPoint 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts）
// 职责：点标绘的数据模型。单中心语义：中心与范围只取 points[0]。
// 依赖：./base.ts、./types.ts。
// 被消费：GroundDecalManager（addPlot 'point' 分支）、桥接器。
// ============================================================

import { GisPlotBase } from './base';
import type { LonLatPoint, PlotPointOptions } from './types';

export class GisPlotPoint extends GisPlotBase {

	public override readonly category = 'point' as const;
	public declare options: PlotPointOptions;

	/**
	 * @param options 点标绘选项。
	 */
	public constructor( options: PlotPointOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotPointOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotPointOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotPointOptions;
	}

	/**
	 * 单中心语义：只取 points[0]。
	 *
	 * @returns 包含中心点（最多 1 个）的顶点序列。
	 */
	public override getCenterPoints(): LonLatPoint[] {
		const p = this.options.points;
		return p && p.length > 0 ? [ p[ 0 ] ] : [];
	}

	/**
	 * 范围与中心相同（点无几何外扩）。
	 *
	 * @returns 同 getCenterPoints。
	 */
	public override getExtentPoints(): LonLatPoint[] {
		return this.getCenterPoints();
	}
}
