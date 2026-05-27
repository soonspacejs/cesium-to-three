// ============================================================
// sector.ts — GisPlotSector 数据模型子类
// 层级：L1（数据模型层；依赖 base.ts + types.ts + three）
// 职责：扇形标绘的数据模型。points[0] 为扇心；半径 radius（米）、
//       startAngle / sectorAngle（度）。getExtentPoints 与 GisPlotCircle
//       行为完全一致（按半径外扩包围盒，不区分扇区角度）。
// 依赖：./base.ts、./types.ts、three（MathUtils.DEG2RAD）。
// 被消费：GroundDecalManager（addPlot 'sector' 分支）、桥接器。
// ============================================================

import { MathUtils } from 'three';

import { GisPlotBase } from './base';
import type { LonLatPoint, PlotSectorOptions } from './types';

const DEG2RAD = MathUtils.DEG2RAD;

/** 1° 纬度对应的经线长度近似（米）。 */
const METERS_PER_DEGREE_LATITUDE = 111320;

export class GisPlotSector extends GisPlotBase {

	public override readonly category = 'sector' as const;
	public declare options: PlotSectorOptions;

	/**
	 * @param options 扇形标绘选项。
	 */
	public constructor( options: PlotSectorOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotSectorOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotSectorOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotSectorOptions;
	}

	/**
	 * 按半径外扩的经纬度包围盒（与 GisPlotCircle 完全一致；不区分扇区角度）。
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
