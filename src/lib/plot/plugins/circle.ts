// ============================================================
// circle.ts — GisPlotCircle 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts + three）
// 职责：圆形标绘的数据模型。points[0] 为圆心；半径 radius（米）。
//       覆写 getExtentPoints：按半径把米换成经纬度增量，返回西南角 / 东北角
//       包围盒两点。
// 依赖：./base.ts、./types.ts、three（MathUtils.DEG2RAD）。
// 被消费：GroundDecalManager（addPlot 'circle' 分支）、桥接器。
//
// 经纬度增量近似公式（参考项目原算法保持等价）：
//   1° 纬度 ≈ 111320 米
//   dLon = r / ( 111320 × cos(lat × DEG2RAD) )
//   dLat = r / 111320
// ============================================================

import { MathUtils } from 'three';

import { GisPlotBase } from './base';
import type { LonLatPoint, PlotCircleOptions } from './types';

const DEG2RAD = MathUtils.DEG2RAD;

/** 1° 纬度对应的经线长度近似（米）。参考项目同名常量。 */
const METERS_PER_DEGREE_LATITUDE = 111320;

export class GisPlotCircle extends GisPlotBase {

	public override readonly category = 'circle' as const;
	public declare options: PlotCircleOptions;

	/**
	 * @param options 圆形标绘选项。
	 */
	public constructor( options: PlotCircleOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotCircleOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotCircleOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotCircleOptions;
	}

	/**
	 * 按半径外扩的经纬度包围盒（两点：西南角、东北角）。
	 *
	 * @returns 两点包围盒；无顶点时返回空数组。
	 */
	public override getExtentPoints(): LonLatPoint[] {
		const p = this.options.points;
		if ( ! p || p.length === 0 ) {
			return [];
		}
		const lon = p[ 0 ][ 0 ];
		const lat = p[ 0 ][ 1 ];
		const r = this.options.radius || 0;
		const dLon = r / ( METERS_PER_DEGREE_LATITUDE * Math.cos( lat * DEG2RAD ) );
		const dLat = r / METERS_PER_DEGREE_LATITUDE;
		return [
			[ lon - dLon, lat - dLat ],
			[ lon + dLon, lat + dLat ],
		];
	}
}
