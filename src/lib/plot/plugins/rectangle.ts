// ============================================================
// rectangle.ts — GisPlotRectangle 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts）
// 职责：矩形标绘的数据模型。points 语义为 4 角点（顺 / 逆时针）。
//       桥接器映射到 CesiumGroundPolygonPrimitive（任意四边形，能精确还原
//       可旋转矩形）。
// 依赖：./base.ts、./types.ts。
// 被消费：GroundDecalManager（addPlot 'rectangle' 分支）、桥接器。
// ============================================================

import { GisPlotBase } from './base';
import type { PlotRectangleOptions } from './types';

export class GisPlotRectangle extends GisPlotBase {

	public override readonly category = 'rectangle' as const;
	public declare options: PlotRectangleOptions;

	/**
	 * @param options 矩形标绘选项。
	 */
	public constructor( options: PlotRectangleOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotRectangleOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotRectangleOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotRectangleOptions;
	}
}
