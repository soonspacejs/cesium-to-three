// ============================================================
// arrow.ts — GisPlotArrow 数据模型子类（唯一带几何派生）
// 层级：L1（数据模型层；依赖 base.ts + types.ts + src/lib/arrow）
// 职责：箭头标绘的数据模型。
//   - generateCoords()：根据 arrowType 调用 c2t arrow SDK 对应函数，
//     把控制点 (options.points) 转换为闭合多边形 generatedCoords。
//   - getSnapshot / getSnapshotDeep 覆写，在 { type, options } 之外附带
//     generatedCoords（深快照同时深拷贝 generatedCoords）。
// 依赖：./base.ts、./types.ts、../../arrow（c2t arrow 库，已 clamp ≤120 顶点、
//       CCW 规范化、含曲线 / 攻击 / 燕尾 / 突击方向箭头的鲁棒性修复）。
// 被消费：GroundDecalManager（addPlot 'arrow' 分支）、桥接器（构建箭头图元前调用
//        generateCoords）。
//
// arrowType → c2t arrow SDK 函数映射：
//   - 'fine'              → createFineArrow( cp[0], cp[1] )
//   - 'assaultDirection'  → createAssaultDirectionArrow( cp[0], cp[1] )
//   - 'attack'            → createAttackArrow( cp )（cp.length >= 3 推荐；
//                           = 2 时 SDK 内部退化为 fine）
//   - 'swallowtailAttack' → createSwallowtailAttackArrow( cp )（同 attack 约定）
//   - 'curved'            → createCurvedArrow( cp )（≥2 控制点，全部作为脊线）
//
// 边界：cp.length < 2 → 清空 generatedCoords 并返回 []。
// ============================================================

import {
	createAssaultDirectionArrow,
	createAttackArrow,
	createCurvedArrow,
	createFineArrow,
	createSwallowtailAttackArrow,
	type ArrowPolygon,
} from '../../arrow';

import { GisPlotBase } from './base';
import type { GisPlotArrowSnapshot, LonLatPoint, PlotArrowOptions } from './types';

export class GisPlotArrow extends GisPlotBase {

	public override readonly category = 'arrow' as const;
	public declare options: PlotArrowOptions;

	/** generateCoords() 填充的闭合多边形顶点；初始为空。 */
	public generatedCoords: ArrowPolygon = [];

	/**
	 * @param options 箭头标绘选项。
	 */
	public constructor( options: PlotArrowOptions ) {
		super( options );
	}

	/**
	 * 类型收窄：patch 限定为 PlotArrowOptions 的子集 + 任意扩展键。
	 * 方法体与基类相同（不可变整表替换）。注意更新后 generatedCoords 不会自动
	 * 重算，调用方（桥接器）在使用前应再调一次 generateCoords。
	 *
	 * @param patch 局部补丁。
	 */
	public override update(
		patch: Partial<PlotArrowOptions> & Record<string, unknown>,
	): void {
		this.options = { ...this.options, ...patch } as PlotArrowOptions;
	}

	/**
	 * 根据 arrowType 把控制点转为闭合多边形顶点序列，存入 generatedCoords。
	 * 内部调用 c2t arrow SDK（src/lib/arrow），结果已 CCW 规范化、去除连续重复
	 * 顶点并 clamp 到 ≤120 顶点，可直接喂给 CesiumGroundPolygonPrimitive。
	 *
	 * 边界：
	 *   - 控制点 < 2 → generatedCoords = []，返回 []。
	 *   - 'fine' / 'assaultDirection' 只用前 2 个控制点。
	 *   - 'attack' / 'swallowtailAttack' / 'curved' 用全部控制点；attack /
	 *     swallowtailAttack 推荐 ≥ 3 点（前 2 = 尾边、后续 = 脊线）。
	 *   - 未知 arrowType 退化为 createFineArrow( cp[0], cp[last] )。
	 *
	 * @returns generatedCoords 引用。
	 */
	public generateCoords(): ArrowPolygon {
		const cp = this.options.points;
		if ( ! cp || cp.length < 2 ) {
			this.generatedCoords = [];
			return this.generatedCoords;
		}
		// sizeScale:整体大小(宽度)倍率,对全部 arrowType 生效,透传为各 SDK
		// 的 widthScale;未提供或非正数时按 1.0(不缩放)。
		const widthScale =
			typeof this.options.sizeScale === 'number' && this.options.sizeScale > 0
				? this.options.sizeScale
				: 1.0;
		switch ( this.options.arrowType ) {
			case 'fine':
				this.generatedCoords = createFineArrow( cp[ 0 ], cp[ 1 ], { widthScale } );
				break;
			case 'assaultDirection':
				this.generatedCoords = createAssaultDirectionArrow(
					cp[ 0 ], cp[ 1 ], { widthScale },
				);
				break;
			case 'attack':
				this.generatedCoords = createAttackArrow( cp, { widthScale } );
				break;
			case 'swallowtailAttack':
				this.generatedCoords = createSwallowtailAttackArrow( cp, { widthScale } );
				break;
			case 'curved': {
				// 仅把已显式提供的曲线体型字段传入 SDK;未提供的走 SDK 默认值。
				// widthScale 与体型因子同时生效(SDK 内 bodyWidthFactor×widthScale)。
				const curvedOptions: {
					bodyWidthFactor?: number;
					headWidthFactor?: number;
					headLengthFactor?: number;
					widthScale?: number;
				} = { widthScale };
				if ( typeof this.options.curvedBodyWidthFactor === 'number' ) {
					curvedOptions.bodyWidthFactor = this.options.curvedBodyWidthFactor;
				}
				if ( typeof this.options.curvedHeadWidthFactor === 'number' ) {
					curvedOptions.headWidthFactor = this.options.curvedHeadWidthFactor;
				}
				if ( typeof this.options.curvedHeadLengthFactor === 'number' ) {
					curvedOptions.headLengthFactor = this.options.curvedHeadLengthFactor;
				}
				this.generatedCoords = createCurvedArrow( cp, curvedOptions );
				break;
			}
			default:
				this.generatedCoords = createFineArrow(
					cp[ 0 ], cp[ cp.length - 1 ], { widthScale },
				);
				break;
		}
		return this.generatedCoords;
	}

	/**
	 * 浅快照：附带 generatedCoords（与内部共享引用，不深拷贝）。
	 *
	 * @returns 箭头浅快照。
	 */
	public override getSnapshot(): GisPlotArrowSnapshot {
		return {
			type: this.category,
			options: { ...this.options } as PlotArrowOptions,
			generatedCoords: this.generatedCoords.map(
				( c ) => [ c[ 0 ], c[ 1 ] ] as LonLatPoint,
			),
		};
	}

	/**
	 * 深快照：options.points 与 generatedCoords 各自每个顶点都是新数组。
	 *
	 * @returns 箭头深快照。
	 */
	public override getSnapshotDeep(): GisPlotArrowSnapshot {
		const s = super.getSnapshotDeep();
		return {
			type: s.type,
			options: s.options as PlotArrowOptions,
			generatedCoords: this.generatedCoords.map(
				( c ) => [ c[ 0 ], c[ 1 ] ] as LonLatPoint,
			),
		};
	}
}
