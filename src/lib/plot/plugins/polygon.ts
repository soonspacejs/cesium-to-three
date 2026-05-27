// ============================================================
// polygon.ts — GisPlotPolygon 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts）
// 职责：多边形标绘的数据模型。无几何派生，沿用基类的 getCenterPoints /
//       getExtentPoints。≥3 顶点由管理器 removeCoord 的下限逻辑保证。
// 依赖：./base.ts、./types.ts。
// 被消费：GroundDecalManager（addPlot 'polygon' 分支）、桥接器。
// ============================================================

import { GisPlotBase } from './base';
import type { PlotPolygonOptions } from './types';

export class GisPlotPolygon extends GisPlotBase {

	public override readonly category = 'polygon' as const;
	public declare options: PlotPolygonOptions;

	/**
	 * @param options 多边形标绘选项。
	 */
	public constructor( options: PlotPolygonOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotPolygonOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotPolygonOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotPolygonOptions;
	}
}
