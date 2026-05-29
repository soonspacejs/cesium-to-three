// ============================================================
// base.ts — GisPlotBase 数据模型基类
// 层级：L1（数据模型层；仅依赖 types.ts）
// 职责：定义所有 GisPlot* 共有的字段（id / category / options）与方法
//       （update / getSnapshot / getSnapshotDeep / getCenterPoints /
//       getExtentPoints），并维护模块级自增 id 计数器。
// 依赖：./types.ts。
// 被消费：plugins/<子类>.ts、GroundDecalManager、PlotPrimitiveBridge。
//
// 关键不变量（移植与升级时必须保持）：
//   1. id 由模块级 _nextId 自增分配，跨实例单调递增；id 为字符串。
//   2. 构造时对 options 浅拷贝一层，并对 points 每个顶点做 [a, b] 新数组深拷贝，
//      防止业务侧后续修改原数组污染内部。
//   3. update 是不可变整表替换（重建 options 对象）。
//   4. getSnapshot 浅（新 options 对象，但 points 与内部共享引用）；
//      getSnapshotDeep 深（points 每个顶点新数组）。
// ============================================================

import type {
	GisPlotBaseOptions,
	GisPlotCategory,
	GisPlotSnapshot,
	LonLatPoint,
} from './types';

/**
 * 模块级 id 计数器。所有 GisPlotBase 实例共享，自 1 开始单调递增。
 * 仅当模块被多次加载（重复打包）时 id 会回到 1；ESM 单例语义保证不会发生。
 */
let _nextId = 1;

/**
 * 标绘数据模型基类。每个实例是一个**纯数据对象**：只持有 id / category /
 * options，不持有任何 GPU 资源 / Three 对象 / DOM 节点。
 */
export class GisPlotBase {

	/** 自增字符串 id（'1' / '2' / '3' ...）。 */
	public readonly id: string;

	/**
	 * 类别。基类构造为空串，子类用 `readonly category = 'xxx' as const` 覆写。
	 * 桥接器据此 switch 分支。
	 */
	public category: GisPlotCategory = '' as GisPlotCategory;

	/**
	 * 标绘选项。基类持 GisPlotBaseOptions，子类用 `declare options: 具体Options`
	 * 收窄类型提示，方法体相同。
	 */
	public options: GisPlotBaseOptions;

	/**
	 * @param options 标绘选项。构造会浅拷贝一层 options，并对 points 每个顶点
	 *                做新数组深拷贝，防止业务侧引用泄漏。
	 */
	public constructor( options: GisPlotBaseOptions ) {
		this.id = String( _nextId++ );
		this.category = '' as GisPlotCategory;
		this.options = { ...options };
		if ( this.options.points ) {
			this.options.points = this.options.points.map(
				( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint,
			);
		}
	}

	/**
	 * 不可变整表替换：用展开 + patch 重建 options。
	 * 注意：patch.points 若传入是直接引用赋值（不再深拷贝）——这是参考项目的
	 * 既有行为，管理器的 setCoords 会自行深拷贝后再调用。
	 *
	 * 子类覆写此方法仅为收窄 patch 的类型提示，方法体相同。
	 *
	 * @param patch 局部补丁（基类字段 + 任意扩展键）。
	 */
	public update( patch: Partial<GisPlotBaseOptions> & Record<string, unknown> ): void {
		this.options = { ...this.options, ...patch } as GisPlotBaseOptions;
	}

	/**
	 * 浅快照：options 是新对象（展开一层），但 options.points 与内部共享引用。
	 * 用途：管理器 getItem 默认走这里。外部读取快照、不打算改 points 时用。
	 *
	 * @returns 浅快照。
	 */
	public getSnapshot(): GisPlotSnapshot {
		return {
			type: this.category,
			options: { ...this.options } as GisPlotBaseOptions,
		};
	}

	/**
	 * 深快照：points 每个顶点都是新数组 → 改返回值不影响内部。
	 * 管理器 getItemDeep 走这里。
	 *
	 * @returns 深快照。
	 */
	public getSnapshotDeep(): GisPlotSnapshot {
		const o = { ...this.options } as GisPlotBaseOptions;
		if ( o.points ) {
			o.points = o.points.map( ( p ) => [ ...p ] as LonLatPoint );
		}
		return {
			type: this.category,
			options: o,
		};
	}

	/**
	 * 基类默认：返回全部顶点。上层用来算 ENU 参考中心。
	 * 子类（point / text / circle / sector 等）可覆写为更紧的语义。
	 *
	 * @returns 中心点候选顶点序列。
	 */
	public getCenterPoints(): LonLatPoint[] {
		return this.options.points || [];
	}

	/**
	 * 基类默认：返回全部顶点。上层用来算最大空间范围。
	 * circle / sector 子类覆写为按半径外扩的经纬度包围盒。
	 *
	 * @returns 范围点候选顶点序列。
	 */
	public getExtentPoints(): LonLatPoint[] {
		return this.options.points || [];
	}
}
