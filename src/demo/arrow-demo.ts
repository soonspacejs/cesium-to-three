// ============================================================
// arrow-demo.ts
// 层级:演示用箭头标绘子系统。
// 职责:把 5 类特殊形状箭头(fine arrow、assault direction arrow、attack arrow、
//        swallowtail attack arrow、curved arrow)封装成一组自包含的
//        `CesiumGroundPolygonPrimitive` 实例,并提供完整 lil-gui 操作面板。
//        每个箭头类型都有自己的文件夹,暴露 `src/lib/arrow/arrow-types.ts`
//        中完整选项集的数值滑块 / 颜色选择器,以及一个控制点 JSON 文本框;
//        该文本框行为与 `ground-demo.ts` 中矩形 + 多边形模式一致。
//
//        设计目标:
//          - 本文件不承载几何知识。所有数学都在 `src/lib/arrow` 中;本模块只消费
//            `LonLatPoint[]` 输出环,并直接交给 CesiumGroundPolygonPrimitive。
//          - 任意影响几何的选项变化时,每个箭头图元都可完整重建。描边 / 填充 /
//            可见性 / 渲染顺序修改无需重建几何即可应用。
//          - 5 个箭头通过 `applyPassVisibility(...)` 与 `applyFragmentCull(...)`
//            hook 共享宿主的 `Passes`(front stencil / back stencil / color)
//            开关和 `fragmentCull` 标志,让现有 `applyGroundDebugSettings()`
//            宿主管线继续作为共享渲染状态的唯一来源。
//          - 标绘顺序通过宿主 `PlotOrderRegistry<DemoPlotId>` 路由,使箭头与
//            矩形 / 多边形 / 圆图元参与同一个全局渲染顺序池。
//
// 依赖:src/lib/arrow(5 个工厂 + 选项类型)、src/lib/ground
//      (CesiumGroundPolygonPrimitive + CesiumGroundFrameState)、demo plot-utils
//      (PlotOrderRegistry、plotOrderToRenderOrder)。
// 被消费:src/demo/ground-demo.ts。
// ============================================================

import { Color, type Scene } from 'three';
import type GUI from 'lil-gui';

import {
	createAssaultDirectionArrow,
	createAttackArrow,
	createCurvedArrow,
	createFineArrow,
	createSwallowtailAttackArrow,
	type ArrowPolygon,
	type AssaultDirectionArrowOptions,
	type AttackArrowOptions,
	type CurvedArrowOptions,
	type FineArrowOptions,
	type LonLatPoint,
	type SwallowtailAttackArrowOptions,
} from '../lib/arrow';
import {
	CesiumGroundPolygonPrimitive,
	type CesiumGroundFrameState,
} from '../lib/ground';
import { plotOrderToRenderOrder } from './plot-utils';

// ── 箭头标绘标识联合类型 ──
// 导出这些 id,让 ground-demo.ts 中的宿主 `DemoPlotId` 可扩展并包含它们,
// 从而共享同一个 `PlotOrderRegistry` 实例。
export type ArrowPlotId =
	| 'fineArrow'
	| 'assaultDirection'
	| 'attackArrow'
	| 'swallowtailAttackArrow'
	| 'curvedArrow'
	| 'hookCurvedArrow'
	| 'uCurvedArrow'
	| 'largeFineArrow'
	| 'largeAssaultDirection'
	| 'largeAttackArrow'
	| 'largeSwallowtailAttackArrow'
	| 'largeCurvedArrow';

type ArrowKind =
	| 'fineArrow'
	| 'assaultDirection'
	| 'attackArrow'
	| 'swallowtailAttackArrow'
	| 'curvedArrow';

/**
 * 本模块消费的最小 registry 结构。
 *
 * 宿主拥有一个 `PlotOrderRegistry<DemoPlotId>`,其中 `DemoPlotId` 是
 * 矩形 / 多边形 / 圆 + 全部 {@link ArrowPlotId} 扩展后的联合类型。
 * 该类对 `PlotId` 泛型化,而它的私有 `Map<PlotId, ...>` 字段会触发
 * TypeScript 名义私有字段规则下的不变性,所以即使 `ArrowPlotId ⊂ DemoPlotId`,
 * `PlotOrderRegistry<DemoPlotId>` 也不能赋值给 `PlotOrderRegistry<ArrowPlotId>`。
 *
 * 修复方式是结构化:声明一个只列出本模块使用的两个方法的接口。方法简写下的
 * 方法参数双变性意味着,以 ArrowPlotId 超集参数化的 registry 仍可赋值给此接口
 * (更宽的方法接受更窄输入)。调用点无需 `unknown` cast。
 */
export interface ArrowPlotOrderRegistry {
	register( plotId: ArrowPlotId, preferredPlotOrder?: number ): number;
	update( plotId: ArrowPlotId, preferredPlotOrder: number ): number;
}

// 有序列表用于确定性遍历 entry(GUI 顺序、信息行顺序、dispose 顺序),并与 `ArrowPlotId` 保持同步。
const ARROW_PLOT_IDS: readonly ArrowPlotId[] = [
	'fineArrow',
	'assaultDirection',
	'attackArrow',
	'swallowtailAttackArrow',
	'curvedArrow',
	'hookCurvedArrow',
	'uCurvedArrow',
	'largeFineArrow',
	'largeAssaultDirection',
	'largeAttackArrow',
	'largeSwallowtailAttackArrow',
	'largeCurvedArrow',
];

// ── 每个箭头用于 GUI 文件夹 + 信息面板的人类可读标签 ──
const ARROW_LABELS: Record<ArrowPlotId, string> = {
	fineArrow: 'Fine Arrow',
	assaultDirection: 'Assault Direction',
	attackArrow: 'Attack Arrow',
	swallowtailAttackArrow: 'Swallowtail Attack',
	curvedArrow: 'Curved Arrow',
	hookCurvedArrow: 'Hook Curved Arrow (freehand)',
	uCurvedArrow: 'U-Shaped Curved Arrow',
	largeFineArrow: 'Large Fine Arrow',
	largeAssaultDirection: 'Large Assault Direction',
	largeAttackArrow: 'Large Attack Arrow',
	largeSwallowtailAttackArrow: 'Large Swallowtail Attack',
	largeCurvedArrow: 'Large Curved Arrow',
};

// ── 每个箭头使用不同填充色,便于一眼区分 ──
const ARROW_FILL_COLORS: Record<ArrowPlotId, string> = {
	fineArrow: '#ffaa00',
	assaultDirection: '#ff4488',
	attackArrow: '#ff2200',
	swallowtailAttackArrow: '#aa44ff',
	curvedArrow: '#22ddaa',
	hookCurvedArrow: '#3a86ff',
	uCurvedArrow: '#2b6cff',
	largeFineArrow: '#ffd54d',
	largeAssaultDirection: '#ff77aa',
	largeAttackArrow: '#ff6644',
	largeSwallowtailAttackArrow: '#c477ff',
	largeCurvedArrow: '#55f0cc',
};

// ── 共享默认描边 / 填充状态 ──
const DEFAULT_STROKE_COLOR = '#ffffff';
const DEFAULT_STROKE_OPACITY = 95.0;
const DEFAULT_STROKE_WIDTH_METERS = 0.35;
const DEFAULT_FILL_OPACITY = 70.0;

// ── 初始标绘顺序 ──
// Rectangle/Polygon/Circle 宿主占用 0/1/2。箭头占用 3..7。如果这些值与用户编辑后的
// 顺序冲突,`PlotOrderRegistry` 会重新分配,所以这些数字只是 *首选* 起始顺序。
const PREFERRED_PLOT_ORDERS: Record<ArrowPlotId, number> = {
	fineArrow: 3,
	assaultDirection: 4,
	attackArrow: 5,
	swallowtailAttackArrow: 6,
	curvedArrow: 7,
	hookCurvedArrow: 8,
	uCurvedArrow: 9,
	largeFineArrow: 11,
	largeAssaultDirection: 12,
	largeAttackArrow: 13,
	largeSwallowtailAttackArrow: 14,
	largeCurvedArrow: 15,
};

// ── 每个箭头的默认工厂选项 ──
// 这些值镜像 `src/lib/arrow/shapes/*.ts` 中的常量。把它们暴露在这里,
// 可让 GUI 从工厂同款默认值启动,因此"重置"只需要刷新页面。
const DEFAULT_FINE_ARROW_OPTIONS: Required<FineArrowOptions> = {
	tailWidthFactor: 0.10,
	neckWidthFactor: 0.20,
	headWidthFactor: 0.25,
	headAngleRadians: Math.PI / 8.5,
	neckAngleRadians: Math.PI / 13.0,
	widthScale: 1.0,
};

const DEFAULT_ASSAULT_DIRECTION_OPTIONS: Required<AssaultDirectionArrowOptions> = {
	lengthScale: 1.5,
	tailWidthFactor: 0.08,
	neckWidthFactor: 0.10,
	headWidthFactor: 0.13,
	headAngleRadians: Math.PI / 4.0,
	neckAngleRadians: Math.PI * 0.17741,
	widthScale: 1.0,
};

const DEFAULT_ATTACK_ARROW_OPTIONS: Required<AttackArrowOptions> = {
	headHeightFactor: 0.28,
	headWidthFactor: 0.55,
	neckHeightFactor: 0.85,
	neckWidthFactor: 0.22,
	headTailFactor: 1.25,
	minBodyHalfAngleRadians: Math.PI / 12.0,
	bodyWidthMargin: 1.05,
	bodySmoothingSegments: 12,
	widthScale: 1.0,
};

const DEFAULT_SWALLOWTAIL_OPTIONS: Required<SwallowtailAttackArrowOptions> = {
	headHeightFactor: 0.28,
	headWidthFactor: 0.55,
	neckHeightFactor: 0.85,
	neckWidthFactor: 0.22,
	headTailFactor: 1.25,
	minBodyHalfAngleRadians: Math.PI / 12.0,
	bodyWidthMargin: 1.05,
	bodySmoothingSegments: 12,
	swallowtailFactor: 0.70,
	tailWidthFactor: 0.08,
	widthScale: 1.0,
};

const DEFAULT_CURVED_ARROW_OPTIONS: Required<CurvedArrowOptions> = {
	bodyWidthFactor: 0.05,
	headWidthFactor: 0.16,
	headLengthFactor: 0.18,
	neckWidthRelativeToHead: 0.40,
	curveSmoothingSegments: 16,
	bodyTaperRatio: 0.0,
	widthScale: 1.0,
};

/**
 * 单个箭头 demo entry:持有一个 CesiumGroundPolygonPrimitive 以及全部 GUI 状态。
 * 基于 `kind` 的可辨识联合让 `rebuildArrow` 无需类型断言即可分派到正确工厂。
 */
interface BaseArrowEntry {
	readonly id: ArrowPlotId;
	readonly label: string;
	visible: boolean;
	plotOrder: number;
	pointsJson: string;
	points: LonLatPoint[];
	fillColor: string;
	fillOpacity: number;
	strokeColor: string;
	strokeOpacity: number;
	strokeWidth: number;
	primitive: CesiumGroundPolygonPrimitive | null;
}

interface FineArrowEntry extends BaseArrowEntry {
	readonly kind: 'fineArrow';
	options: Required<FineArrowOptions>;
}

interface AssaultDirectionEntry extends BaseArrowEntry {
	readonly kind: 'assaultDirection';
	options: Required<AssaultDirectionArrowOptions>;
}

interface AttackArrowEntry extends BaseArrowEntry {
	readonly kind: 'attackArrow';
	options: Required<AttackArrowOptions>;
}

interface SwallowtailAttackEntry extends BaseArrowEntry {
	readonly kind: 'swallowtailAttackArrow';
	options: Required<SwallowtailAttackArrowOptions>;
}

interface CurvedArrowEntry extends BaseArrowEntry {
	readonly kind: 'curvedArrow';
	options: Required<CurvedArrowOptions>;
}

type ArrowEntry =
	| FineArrowEntry
	| AssaultDirectionEntry
	| AttackArrowEntry
	| SwallowtailAttackEntry
	| CurvedArrowEntry;

interface ArrowEntryByKind {
	fineArrow: FineArrowEntry;
	assaultDirection: AssaultDirectionEntry;
	attackArrow: AttackArrowEntry;
	swallowtailAttackArrow: SwallowtailAttackEntry;
	curvedArrow: CurvedArrowEntry;
	hookCurvedArrow: CurvedArrowEntry;
	uCurvedArrow: CurvedArrowEntry;
	largeFineArrow: FineArrowEntry;
	largeAssaultDirection: AssaultDirectionEntry;
	largeAttackArrow: AttackArrowEntry;
	largeSwallowtailAttackArrow: SwallowtailAttackEntry;
	largeCurvedArrow: CurvedArrowEntry;
}

/**
 * 以 1:1 测试尺度为每种箭头构建初始控制点集合:每个箭头主体跨度约 10 m,
 * 5 个箭头生成在宿主矩形中心附近不同的 lon/lat 位置,避免彼此或与矩形 /
 * 多边形 / 圆重叠。散布半径约 40-60 m,因此常见近景相机(高度约 50-200 m)
 * 无需拉远即可容纳整个场景。
 *
 * 布局(纬度 28° 处,1° lon ≈ 98 km,1° lat ≈ 111 km):
 *
 *                         hookCurved (NE, 钩形回环手绘 ~40 m)
 *           curved (NW, S-shape spans ~30 m)
 *
 *               fineArrow (N, ~12 m pointer east)
 *
 *          [rectangle]  attackArrow (E, ~14 m wedge)
 *
 *               swallowtail (S, ~14 m wedge with V tail)
 *
 *           assaultDirection (SW, ~12 m pointer west)
 *
 * @param centerLon   宿主 demo 矩形中心经度。
 * @param centerLat   宿主 demo 矩形中心纬度。
 * @returns 每种箭头类型的控制点集合。每个集合都已满足对应箭头工厂的最小点数要求。
 */
function buildInitialControlPoints(
	centerLon: number,
	centerLat: number,
): Record<ArrowPlotId, LonLatPoint[]> {
	// 纬度 28° 处 "N 米对应多少度" 的便捷常量。lat 基本独立(111 km/°),
	// lon 会随 cos(lat) 缩小;在此纬度 cos(28°) ≈ 0.883
	// (1 m ≈ 1.02e-5 度 lon,1 m ≈ 9.01e-6 度 lat)。
	const mLon = 1.02e-5;
	const mLat = 9.01e-6;

	const smallPoints: Record<ArrowKind, LonLatPoint[]> = {
		// 2-point fine arrow, ~12 m long, pointing east, 40 m north of centre
		fineArrow: [
			[ centerLon - 6.0 * mLon, centerLat + 40.0 * mLat ],
			[ centerLon + 6.0 * mLon, centerLat + 40.0 * mLat ],
		],
		// 2-point assault direction, ~12 m long, pointing west, 60 m SW of centre
		assaultDirection: [
			[ centerLon - 25.0 * mLon, centerLat - 55.0 * mLat ],
			[ centerLon - 37.0 * mLon, centerLat - 55.0 * mLat ],
		],
		// 4-point attack arrow, ~18 m total, pointing east, 50 m east of centre.
		// Keep the tail narrow at meter scale; otherwise the attack body
		// degenerates visually into a broad triangle.
		attackArrow: [
			[ centerLon + 40.0 * mLon, centerLat + 1.5 * mLat ],
			[ centerLon + 40.0 * mLon, centerLat - 1.5 * mLat ],
			[ centerLon + 50.0 * mLon, centerLat + 0.0 * mLat ],
			[ centerLon + 58.0 * mLon, centerLat + 0.0 * mLat ],
		],
		// 4-point swallowtail attack arrow, ~18 m total, pointing east,
		// 40 m south of centre
		swallowtailAttackArrow: [
			[ centerLon - 4.0 * mLon, centerLat - 38.5 * mLat ],
			[ centerLon - 4.0 * mLon, centerLat - 41.5 * mLat ],
			[ centerLon + 6.0 * mLon, centerLat - 40.0 * mLat ],
			[ centerLon + 14.0 * mLon, centerLat - 40.0 * mLat ],
		],
		// 4-point curved arrow, ~30 m S-curve, NW of centre
		curvedArrow: [
			[ centerLon - 55.0 * mLon, centerLat + 30.0 * mLat ],
			[ centerLon - 45.0 * mLon, centerLat + 38.0 * mLat ],
			[ centerLon - 32.0 * mLon, centerLat + 30.0 * mLat ],
			[ centerLon - 22.0 * mLon, centerLat + 38.0 * mLat ],
		],
	};

	// ── 钩形回环手绘轨迹(复刻"手绘钩形曲线箭头无头" bug 的真实场景)──
	// 48 个密集控制点(模拟手绘逐点采样),轨迹:先向东长直行 → 东侧大半圆
	// 向南掉头 → 向西回扫 → 末端向内卷曲 ~160°,尖端朝东指向回环中心。
	// 总转角 > 340°、CR 密采样后脊线远超 58 样本预算,完整覆盖三条修复路径:
	// 弧长重采样、头长末端转角 clamp、特征保留式降采样兜底。
	// 放在中心东北 ~80 m 处,跨度 ~40 m,不与其它箭头重叠。
	const hookCenterLon = centerLon + 55.0 * mLon;
	const hookCenterLat = centerLat + 75.0 * mLat;
	const hookScaleMeters = 12.0;
	const hookPointCount = 48;
	const hookCurvedArrowPoints: LonLatPoint[] = [];
	for ( let i = 0; i < hookPointCount; i++ ) {
		const t = i / ( hookPointCount - 1 );
		let xMeters: number;
		let yMeters: number;
		if ( t < 0.40 ) {
			// 第一段(40% 弧长):向东直行。
			const u = t / 0.40;
			xMeters = ( -2.0 + u * 2.0 ) * hookScaleMeters;
			yMeters = 0.8 * hookScaleMeters;
		} else if ( t < 0.75 ) {
			// 第二段(35%):东侧大弯,从向东顺时针转 180° 到向西(椭圆,东西向拉宽)。
			const u = ( t - 0.40 ) / 0.35;
			const a = Math.PI / 2 - u * Math.PI;
			xMeters = 0.8 * hookScaleMeters * Math.cos( a ) * 1.4;
			yMeters = 0.8 * hookScaleMeters * Math.sin( a );
		} else {
			// 第三段(25%):末端向内卷曲(继续顺时针 ~160°),尖端指向回环中心。
			const u = ( t - 0.75 ) / 0.25;
			const a = -Math.PI / 2 - u * ( 160.0 * Math.PI / 180.0 );
			xMeters = ( -0.4 + 0.45 * Math.cos( a ) ) * hookScaleMeters;
			yMeters = ( -0.45 + 0.45 * Math.sin( a ) ) * hookScaleMeters;
		}
		hookCurvedArrowPoints.push( [
			hookCenterLon + xMeters * mLon,
			hookCenterLat + yMeters * mLat,
		] );
	}

	// ── U 型曲线箭头(宽 U,开口朝左,尖端在左下)──
	// 上臂向右 → 右侧半圆向下(180°)→ 下臂向左回到起点正下方,尖端朝左。
	// 复刻用户手绘的 U 型轨迹。放在中心正北 ~125 m 处,跨度 ~43 m,不与其它箭头
	// (含中心东北的钩形)重叠。44 个密集控制点(模拟手绘)。
	const uCenterLon = centerLon - 5.0 * mLon;
	const uCenterLat = centerLat + 125.0 * mLat;
	const uScaleMeters = 11.0;
	const uPointCount = 44;
	const uCurvedArrowPoints: LonLatPoint[] = [];
	for ( let i = 0; i < uPointCount; i++ ) {
		const t = i / ( uPointCount - 1 );
		let xMeters: number;
		let yMeters: number;
		if ( t < 0.40 ) {
			// 上臂:从左到右。
			const u = t / 0.40;
			xMeters = ( -1.8 + u * 3.6 ) * uScaleMeters;
			yMeters = 0.9 * uScaleMeters;
		} else if ( t < 0.70 ) {
			// 右侧半圆:上 → 下(顺时针 180°,圆心 x = 1.8、半径 0.9)。
			const u = ( t - 0.40 ) / 0.30;
			const a = Math.PI / 2 - u * Math.PI;
			xMeters = ( 1.8 + 0.9 * Math.cos( a ) ) * uScaleMeters;
			yMeters = ( 0.9 * Math.sin( a ) ) * uScaleMeters;
		} else {
			// 下臂:从右回到左(尖端在左下)。
			const u = ( t - 0.70 ) / 0.30;
			xMeters = ( 1.8 - u * 3.6 ) * uScaleMeters;
			yMeters = -0.9 * uScaleMeters;
		}
		uCurvedArrowPoints.push( [
			uCenterLon + xMeters * mLon,
			uCenterLat + yMeters * mLat,
		] );
	}

	const largeCenterLon = centerLon + 0.018;
	const largeCenterLat = centerLat + 0.13;
	const kmLon = 1000.0 * mLon;
	const kmLat = 1000.0 * mLat;
	const largePoints: Record<
		| 'largeFineArrow'
		| 'largeAssaultDirection'
		| 'largeAttackArrow'
		| 'largeSwallowtailAttackArrow'
		| 'largeCurvedArrow',
		LonLatPoint[]
	> = {
		largeFineArrow: [
			[ largeCenterLon - 5.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
			[ largeCenterLon + 5.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
		],
		largeAssaultDirection: [
			[ largeCenterLon - 3.0 * kmLon, largeCenterLat - 8.0 * kmLat ],
			[ largeCenterLon - 10.0 * kmLon, largeCenterLat - 8.0 * kmLat ],
		],
		largeAttackArrow: [
			[ largeCenterLon + 4.0 * kmLon, largeCenterLat + 1.8 * kmLat ],
			[ largeCenterLon + 4.0 * kmLon, largeCenterLat - 1.8 * kmLat ],
			[ largeCenterLon + 10.0 * kmLon, largeCenterLat + 0.0 * kmLat ],
			[ largeCenterLon + 14.0 * kmLon, largeCenterLat + 0.0 * kmLat ],
		],
		largeSwallowtailAttackArrow: [
			[ largeCenterLon - 2.5 * kmLon, largeCenterLat - 4.0 * kmLat ],
			[ largeCenterLon - 2.5 * kmLon, largeCenterLat - 7.5 * kmLat ],
			[ largeCenterLon + 3.5 * kmLon, largeCenterLat - 5.75 * kmLat ],
			[ largeCenterLon + 9.0 * kmLon, largeCenterLat - 5.75 * kmLat ],
		],
		largeCurvedArrow: [
			[ largeCenterLon - 12.0 * kmLon, largeCenterLat + 1.5 * kmLat ],
			[ largeCenterLon - 8.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
			[ largeCenterLon - 2.0 * kmLon, largeCenterLat + 1.5 * kmLat ],
			[ largeCenterLon + 2.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
		],
	};

	return {
		...smallPoints,
		hookCurvedArrow: hookCurvedArrowPoints,
		uCurvedArrow: uCurvedArrowPoints,
		...largePoints,
	};
}

/**
 * 校验并解析 JSON 文本字段,输出 `[lon, lat]` 点对数组。它镜像 ground-demo.ts
 * 中的矩形 / 多边形解析辅助函数,让整个 demo 的错误信息保持一致。
 *
 * @param value         lil-gui 中输入的 JSON 文本。
 * @param label         错误信息中使用的人类可读箭头名称。
 * @param minimumPoints 每个箭头类型的最小控制点数量。
 * @returns 校验后的 lon/lat 数组。
 * @throws 当输入未通过结构或数值检查时抛出 Error。
 */
function parseArrowPointsText(
	value: string,
	label: string,
	minimumPoints: number,
): LonLatPoint[] {
	const parsed = JSON.parse( value ) as unknown;
	if ( ! Array.isArray( parsed ) || parsed.length < minimumPoints ) {
		throw new Error(
			`${ label } points must be JSON with at least ${ minimumPoints } [lon, lat] pairs.`,
		);
	}

	return parsed.map( ( point ) => {
		if ( ! Array.isArray( point ) || point.length !== 2 ) {
			throw new Error( `Each ${ label } point must be a [lon, lat] pair.` );
		}
		const longitude = Number( point[ 0 ] );
		const latitude = Number( point[ 1 ] );
		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
			throw new Error( `${ label } point coordinates must be finite numbers.` );
		}
		return [ longitude, latitude ] as LonLatPoint;
	} );
}

/**
 * 每个箭头类型的最小控制点数量,来自 `src/lib/arrow/README.md` 中记录的
 * 各工厂契约。
 */
const ARROW_MINIMUM_POINTS: Record<ArrowPlotId, number> = {
	fineArrow: 2,
	assaultDirection: 2,
	attackArrow: 3,
	swallowtailAttackArrow: 3,
	curvedArrow: 2,
	hookCurvedArrow: 2,
	uCurvedArrow: 2,
	largeFineArrow: 2,
	largeAssaultDirection: 2,
	largeAttackArrow: 3,
	largeSwallowtailAttackArrow: 3,
	largeCurvedArrow: 2,
};

/**
 * 根据 entry 的 `kind` 判别字段调用正确的箭头工厂。输入退化时返回空数组,
 * 让调用方可以跳过图元构造而不抛错。
 *
 * @param entry 包含已解析点与当前选项的箭头 entry。
 * @returns 闭合的逆时针多边形环;输入退化时为空。
 */
function computeArrowRing( entry: ArrowEntry ): ArrowPolygon {
	switch ( entry.kind ) {
		case 'fineArrow':
			if ( entry.points.length < 2 ) {
				return [];
			}
			return createFineArrow( entry.points[ 0 ], entry.points[ 1 ], entry.options );

		case 'assaultDirection':
			if ( entry.points.length < 2 ) {
				return [];
			}
			return createAssaultDirectionArrow(
				entry.points[ 0 ],
				entry.points[ 1 ],
				entry.options,
			);

		case 'attackArrow':
			return createAttackArrow( entry.points, entry.options );

		case 'swallowtailAttackArrow':
			return createSwallowtailAttackArrow( entry.points, entry.options );

		case 'curvedArrow':
			return createCurvedArrow( entry.points, entry.options );
	}
}

/**
 * 箭头子系统构造函数消费的选项。
 */
export interface ArrowSubsystemOptions {
	/** 添加 / 移除 classification group 的 Three.js scene。 */
	scene: Scene;
	/** 用于追加每个箭头文件夹的父级 lil-gui。 */
	parentGui: GUI;
	/**
	 * 宿主持有的标绘顺序 registry。registry 的 PlotId 联合类型必须包含
	 * {@link ArrowPlotId};实际使用中宿主会把自己的 `DemoPlotId` 扩展为包含箭头 id,
	 * 再把带类型的 registry 传入。
	 *
	 * 这里标注为最小结构形状 {@link ArrowPlotOrderRegistry},用于绕过宿主
	 * registry 不变泛型参数的限制(方差推理见上方接口 JSDoc)。
	 */
	plotOrderRegistry: ArrowPlotOrderRegistry;
	/** 宿主矩形中心经度,用于锚定初始控制点。 */
	centerLongitude: number;
	/** 宿主矩形中心纬度,用于锚定初始控制点。 */
	centerLatitude: number;
	/** 宿主 `fragmentCull` 开关的初始值。 */
	fragmentCull: boolean;
	/** 宿主 `Passes` 开关组的初始状态。 */
	passVisibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	};
}

/**
 * Self-contained arrow plotting subsystem. Construct once during demo boot,
 * call `update(frameState)` every frame from the host render loop, and
 * `dispose()` only on shutdown.
 */
export class ArrowSubsystem {
	private readonly scene: Scene;
	private readonly registry: ArrowPlotOrderRegistry;
	private readonly entries: ArrowEntryByKind;
	private readonly orderedEntries: ArrowEntry[];
	private fragmentCull: boolean;
	private passVisibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	};

	public constructor( options: ArrowSubsystemOptions ) {
		this.scene = options.scene;
		this.registry = options.plotOrderRegistry;
		this.fragmentCull = options.fragmentCull;
		this.passVisibility = { ...options.passVisibility };

		const initialPoints = buildInitialControlPoints(
			options.centerLongitude,
			options.centerLatitude,
		);

		// Reserve a plot order per arrow before any primitive is built so the
		// initial render order matches the documented PREFERRED_PLOT_ORDERS.
		const reservedPlotOrders: Record<ArrowPlotId, number> = {} as Record<
			ArrowPlotId,
			number
		>;
		for ( const id of ARROW_PLOT_IDS ) {
			reservedPlotOrders[ id ] = this.registry.register(
				id,
				PREFERRED_PLOT_ORDERS[ id ],
			);
		}

		this.entries = {
			fineArrow: this.createEntry(
				'fineArrow',
				'fineArrow',
				initialPoints.fineArrow,
				reservedPlotOrders.fineArrow,
				DEFAULT_FINE_ARROW_OPTIONS,
			) as FineArrowEntry,
			assaultDirection: this.createEntry(
				'assaultDirection',
				'assaultDirection',
				initialPoints.assaultDirection,
				reservedPlotOrders.assaultDirection,
				DEFAULT_ASSAULT_DIRECTION_OPTIONS,
			) as AssaultDirectionEntry,
			attackArrow: this.createEntry(
				'attackArrow',
				'attackArrow',
				initialPoints.attackArrow,
				reservedPlotOrders.attackArrow,
				DEFAULT_ATTACK_ARROW_OPTIONS,
			) as AttackArrowEntry,
			swallowtailAttackArrow: this.createEntry(
				'swallowtailAttackArrow',
				'swallowtailAttackArrow',
				initialPoints.swallowtailAttackArrow,
				reservedPlotOrders.swallowtailAttackArrow,
				DEFAULT_SWALLOWTAIL_OPTIONS,
			) as SwallowtailAttackEntry,
			curvedArrow: this.createEntry(
				'curvedArrow',
				'curvedArrow',
				initialPoints.curvedArrow,
				reservedPlotOrders.curvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
			) as CurvedArrowEntry,
			hookCurvedArrow: this.createEntry(
				'hookCurvedArrow',
				'curvedArrow',
				initialPoints.hookCurvedArrow,
				reservedPlotOrders.hookCurvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
			) as CurvedArrowEntry,
			uCurvedArrow: this.createEntry(
				'uCurvedArrow',
				'curvedArrow',
				initialPoints.uCurvedArrow,
				reservedPlotOrders.uCurvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
			) as CurvedArrowEntry,
			largeFineArrow: this.createEntry(
				'largeFineArrow',
				'fineArrow',
				initialPoints.largeFineArrow,
				reservedPlotOrders.largeFineArrow,
				DEFAULT_FINE_ARROW_OPTIONS,
				100.0,
			) as FineArrowEntry,
			largeAssaultDirection: this.createEntry(
				'largeAssaultDirection',
				'assaultDirection',
				initialPoints.largeAssaultDirection,
				reservedPlotOrders.largeAssaultDirection,
				DEFAULT_ASSAULT_DIRECTION_OPTIONS,
				100.0,
			) as AssaultDirectionEntry,
			largeAttackArrow: this.createEntry(
				'largeAttackArrow',
				'attackArrow',
				initialPoints.largeAttackArrow,
				reservedPlotOrders.largeAttackArrow,
				DEFAULT_ATTACK_ARROW_OPTIONS,
				100.0,
			) as AttackArrowEntry,
			largeSwallowtailAttackArrow: this.createEntry(
				'largeSwallowtailAttackArrow',
				'swallowtailAttackArrow',
				initialPoints.largeSwallowtailAttackArrow,
				reservedPlotOrders.largeSwallowtailAttackArrow,
				DEFAULT_SWALLOWTAIL_OPTIONS,
				100.0,
			) as SwallowtailAttackEntry,
			largeCurvedArrow: this.createEntry(
				'largeCurvedArrow',
				'curvedArrow',
				initialPoints.largeCurvedArrow,
				reservedPlotOrders.largeCurvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
				100.0,
			) as CurvedArrowEntry,
		};

		this.orderedEntries = ARROW_PLOT_IDS.map( ( id ) => this.entries[ id ] );

		// Build all primitives + add them to the scene.
		for ( const entry of this.orderedEntries ) {
			this.rebuildPrimitive( entry );
		}

		this.applyAllSettings();
		this.installGuiFolders( options.parentGui );
	}

	/**
	 * Forwards the host's per-frame frame state to every arrow primitive.
	 *
	 * @param frameState Depth texture + viewport / camera state from the host.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.update( frameState );
		}
	}

	/**
	 * Pushes the host's current `fragmentCull` flag into every primitive.
	 * Called from the host's `applyGroundDebugSettings()` so the GUI knob
	 * stays a single source of truth.
	 *
	 * @param fragmentCull Whether the fragment-cull classification path runs.
	 */
	public applyFragmentCull( fragmentCull: boolean ): void {
		this.fragmentCull = fragmentCull;
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.classification.setFragmentCulling( fragmentCull );
		}
	}

	/**
	 * Pushes the host's `Passes` toggle state into every primitive.
	 *
	 * @param visibility Whether front-stencil / back-stencil / color passes run.
	 */
	public applyPassVisibility( visibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	} ): void {
		this.passVisibility = { ...visibility };
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.classification.setCommandVisibility( {
				frontStencil: visibility.frontStencil,
				backStencil: visibility.backStencil,
				color: visibility.color,
			} );
		}
	}

	/**
	 * 重新应用每个图元的填充 / 描边 / 可见性 / 渲染顺序,不重建几何。
	 * 适合在大范围状态变化后调用。
	 */
	public applyAllSettings(): void {
		for ( const entry of this.orderedEntries ) {
			this.applyEntrySettings( entry );
		}
	}

	/**
	 * 为每个箭头返回一行信息文本,用于补充宿主固定信息面板。
	 *
	 * @returns 每行包含箭头标签、开关状态、顺序、控制点数量与输出环点数。
	 */
	public getInfoLines(): string[] {
		return this.orderedEntries.map( ( entry ) => {
			const state = entry.visible ? 'on' : 'off';
			const ringSize = entry.primitive
				? entry.primitive.polygonHierarchy.positions.length
				: 0;
			return (
				`${ entry.label }: ${ state } / order ${ entry.plotOrder } / ` +
				`pts ${ entry.points.length } / ring ${ ringSize }`
			);
		} );
	}

	/**
	 * 从 scene 中移除 classification group,并释放全部图元。
	 */
	public dispose(): void {
		for ( const entry of this.orderedEntries ) {
			if ( entry.primitive ) {
				this.scene.remove( entry.primitive.classification.group );
				entry.primitive.dispose();
				entry.primitive = null;
			}
		}
	}

	// ── Entry / primitive lifecycle ────────────────────────────────────

	/**
	 * 使用默认共享状态分配一个 ArrowEntry。具体 `kind` + `options` 类型由调用方
	 * 通过 `as` 向上转型,因为通用 `BaseArrowEntry` 形状本身不携带判别字段。
 *
	 * @param id          用于渲染顺序注册的稳定 plot id。
	 * @param kind        箭头几何类型(驱动工厂分派)。
	 * @param points      初始控制点(已校验满足对应类型的最小点数)。
	 * @param plotOrder   从 registry 预分配的唯一标绘顺序。
	 * @param options     此类型的默认工厂选项快照。
	 * @param strokeWidth 默认描边宽度,单位米。
	 * @returns 可由调用方向下转换的宽松类型 base entry。
	 */
	private createEntry(
		id: ArrowPlotId,
		kind: ArrowKind,
		points: LonLatPoint[],
		plotOrder: number,
		options: Required<
			| FineArrowOptions
			| AssaultDirectionArrowOptions
			| AttackArrowOptions
			| SwallowtailAttackArrowOptions
			| CurvedArrowOptions
		>,
		strokeWidth = DEFAULT_STROKE_WIDTH_METERS,
	): ArrowEntry {
		const entry = {
			id,
			kind,
			label: ARROW_LABELS[ id ],
			visible: true,
			plotOrder,
			pointsJson: JSON.stringify( points ),
			points: points.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint ),
			fillColor: ARROW_FILL_COLORS[ id ],
			fillOpacity: DEFAULT_FILL_OPACITY,
			strokeColor: DEFAULT_STROKE_COLOR,
			strokeOpacity: DEFAULT_STROKE_OPACITY,
			strokeWidth,
			// 通过 unknown 转换:options 形状随 kind 变化,调用方负责最终的 `as FineArrowEntry` 式向下转换。
			options: { ...options },
			primitive: null,
		} as unknown as ArrowEntry;
		return entry;
	}

	/**
	 * 释放 entry 当前图元(如存在),通过对应工厂重新生成箭头环,并重建图元。
	 * scene graph 会原子更新,避免屏幕显示半构造状态的箭头。
 *
	 * @param entry 几何或点位发生变化的箭头 entry。
	 */
	private rebuildPrimitive( entry: ArrowEntry ): void {
		// 先拆除旧图元。
		if ( entry.primitive ) {
			this.scene.remove( entry.primitive.classification.group );
			entry.primitive.dispose();
			entry.primitive = null;
		}

		const ring = computeArrowRing( entry );
		if ( ring.length < 3 ) {
			// 退化输入 -> 不创建图元。GUI 文本框仍保留用户输入的 JSON 以便修正;
			// 信息面板会报告 `ring 0`。
			console.warn(
				`[arrow-demo] ${ entry.label }: degenerate input, primitive skipped.`,
			);
			return;
		}

		entry.primitive = new CesiumGroundPolygonPrimitive( {
			points: ring,
			strokeColor: entry.strokeColor,
			strokeWidth: entry.strokeWidth,
			strokeOpacity: entry.strokeOpacity,
			fillColor: entry.fillColor,
			fillOpacity: entry.fillOpacity,
			visible: entry.visible,
			renderOrder: plotOrderToRenderOrder( entry.plotOrder ),
			fragmentCull: this.fragmentCull,
		} );
		this.scene.add( entry.primitive.classification.group );

		this.applyEntrySettings( entry );
	}

	/**
	 * 为单个 entry 重新应用填充 / 描边 / 可见性 / 渲染顺序 / pass 可见性 /
	 * fragment-cull,不重建几何。
 *
	 * @param entry 非几何状态发生变化的箭头 entry。
	 */
	private applyEntrySettings( entry: ArrowEntry ): void {
		const primitive = entry.primitive;
		if ( ! primitive ) {
			return;
		}

		primitive.classification.setColor(
			new Color( entry.fillColor ),
			entry.fillOpacity / 100.0,
		);
		primitive.classification.setFragmentCulling( this.fragmentCull );
		primitive.setRenderOrder( plotOrderToRenderOrder( entry.plotOrder ) );
		primitive.classification.group.visible = entry.visible;
		primitive.classification.setCommandVisibility( {
			frontStencil: this.passVisibility.frontStencil,
			backStencil: this.passVisibility.backStencil,
			color: this.passVisibility.color,
		} );
		primitive.classification.setBorderStyle(
			entry.strokeWidth > 0.0,
			new Color( entry.strokeColor ),
			entry.strokeOpacity / 100.0,
			entry.strokeWidth,
		);
	}

	// ── Plot order ─────────────────────────────────────────────────────

	/**
	 * 把编辑后的标绘顺序推回 registry。registry 可能通过返回原顺序来拒绝冲突;
	 * 本方法会把 *registry 选择的* 顺序写回 entry,让 lil-gui `.listen()` 字段反映真实状态。
 *
	 * @param entry plot order GUI 值发生变化的箭头 entry。
	 */
	private applyEntryPlotOrder( entry: ArrowEntry ): void {
		entry.plotOrder = this.registry.update( entry.id, entry.plotOrder );
		this.applyEntrySettings( entry );
	}

	// ── GUI construction ───────────────────────────────────────────────

	/**
	 * 在父 GUI 下为每个箭头安装一个默认折叠的 lil-gui 文件夹。每个文件夹都包含
	 * 该形状的完整数值滑块选项集,以及共享填充 / 描边 / 可见性控件。
	 * 文件夹默认关闭,避免 GUI 过长;用户按需展开。
 *
	 * @param parentGui 来自 ground-demo.ts 的宿主 lil-gui 实例。
	 */
	private installGuiFolders( parentGui: GUI ): void {
		const arrowsRoot = parentGui.addFolder( 'Arrows' );
		const smallRoot = arrowsRoot.addFolder( '1:1' );
		const largeRoot = arrowsRoot.addFolder( 'Large Scale' );

		this.installFineArrowFolder( smallRoot, this.entries.fineArrow );
		this.installAssaultDirectionFolder( smallRoot, this.entries.assaultDirection );
		this.installAttackArrowFolder( smallRoot, this.entries.attackArrow );
		this.installSwallowtailFolder( smallRoot, this.entries.swallowtailAttackArrow );
		this.installCurvedArrowFolder( smallRoot, this.entries.curvedArrow );
		this.installCurvedArrowFolder( smallRoot, this.entries.hookCurvedArrow );
		this.installCurvedArrowFolder( smallRoot, this.entries.uCurvedArrow );

		this.installFineArrowFolder( largeRoot, this.entries.largeFineArrow );
		this.installAssaultDirectionFolder( largeRoot, this.entries.largeAssaultDirection );
		this.installAttackArrowFolder( largeRoot, this.entries.largeAttackArrow );
		this.installSwallowtailFolder( largeRoot, this.entries.largeSwallowtailAttackArrow );
		this.installCurvedArrowFolder( largeRoot, this.entries.largeCurvedArrow );

		smallRoot.close();
		largeRoot.close();
		arrowsRoot.close();
	}

	/**
	 * 为一个箭头 entry 构建通用(共享)控件:visible / plot order / points JSON /
	 * fill / stroke。返回一个回调,供形状专用安装器在接好自己的滑块后调用。
 *
	 * @param folder 调用方创建的文件夹(每个箭头一个)。
	 * @param entry  此文件夹编辑的箭头 entry。
	 */
	private installSharedControls( folder: GUI, entry: ArrowEntry ): void {
		folder
			.add( entry, 'visible' )
			.name( 'visible' )
			.onChange( () => this.applyEntrySettings( entry ) );

		// 整体大小:对**所有箭头类型**生效的宽度倍率(长度由控制点决定)。
		// widthScale 已加入全部 *ArrowOptions,各 shape 内部把自身宽度量同乘此值。
		folder
			.add( entry.options, 'widthScale', 0.2, 3.0, 0.05 )
			.name( '★ size scale' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );

		folder
			.add( entry, 'plotOrder', 0, 100, 1 )
			.name( 'plot order' )
			.onChange( () => this.applyEntryPlotOrder( entry ) )
			.listen();

		folder
			.add( entry, 'pointsJson' )
			.name( 'points (JSON)' )
			.onFinishChange( ( value: string ) =>
				this.applyPointsJsonEdit( entry, value ),
			)
			.listen();

		folder
			.addColor( entry, 'fillColor' )
			.name( 'fillColor' )
			.onChange( () => this.applyEntrySettings( entry ) );
		folder
			.add( entry, 'fillOpacity', 0.0, 100.0, 1.0 )
			.name( 'fillOpacity' )
			.onChange( () => this.applyEntrySettings( entry ) );

		folder
			.addColor( entry, 'strokeColor' )
			.name( 'strokeColor' )
			.onChange( () => this.applyEntrySettings( entry ) );
		folder
			.add( entry, 'strokeWidth', 0.0, 20.0, 0.25 )
			.name( 'strokeWidth' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		folder
			.add( entry, 'strokeOpacity', 0.0, 100.0, 1.0 )
			.name( 'strokeOpacity' )
			.onChange( () => this.applyEntrySettings( entry ) );
	}

	/**
	 * 把 JSON 文本编辑应用到 entry 的 `points` 字段;解析失败时回滚
	 * (匹配宿主矩形 / 多边形 GUI 行为)。
 *
	 * @param entry 接收新点位的箭头 entry。
	 * @param value 来自 lil-gui 字段的原始 JSON 文本。
	 */
	private applyPointsJsonEdit( entry: ArrowEntry, value: string ): void {
		try {
			const parsed = parseArrowPointsText(
				value,
				entry.label,
				ARROW_MINIMUM_POINTS[ entry.kind ],
			);
			entry.points = parsed;
			entry.pointsJson = JSON.stringify( parsed );
			this.rebuildPrimitive( entry );
		} catch ( error ) {
			console.error( error );
			// Restore the previous valid JSON so the GUI field reverts.
			entry.pointsJson = JSON.stringify( entry.points );
		}
	}

	private installFineArrowFolder( parent: GUI, entry: FineArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		// Geometry-affecting options: rebuild on finishChange to keep the GUI
		// responsive during scrubbing (rebuild is only on release).
		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'tailWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'headWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'headAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'neckAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		folder.close();
	}

	private installAssaultDirectionFolder(
		parent: GUI,
		entry: AssaultDirectionEntry,
	): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'lengthScale', 0.25, 4.0, 0.05 )
			.name( 'lengthScale' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'tailWidthFactor', 0.01, 0.30, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'neckWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'headWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'headAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'neckAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		folder.close();
	}

	private installAttackArrowFolder( parent: GUI, entry: AttackArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'headHeightFactor', 0.05, 0.60, 0.005 )
			.name( 'headHeight /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.10, 0.80, 0.01 )
			.name( 'headWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckHeightFactor', 0.20, 1.00, 0.01 )
			.name( 'neckHeight /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headTailFactor', 0.20, 1.50, 0.01 )
			.name( 'headTail clamp' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		const robust = folder.addFolder( 'Robustness' );
		robust
			.add(
				entry.options,
				'minBodyHalfAngleRadians',
				0.0,
				Math.PI / 4.0,
				0.005,
			)
			.name( 'minBodyHalf rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodyWidthMargin', 0.80, 2.00, 0.01 )
			.name( 'bodyWidth margin' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodySmoothingSegments', 2, 32, 1 )
			.name( 'body samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust.close();

		folder.close();
	}

	private installSwallowtailFolder(
		parent: GUI,
		entry: SwallowtailAttackEntry,
	): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'headHeightFactor', 0.05, 0.60, 0.005 )
			.name( 'headHeight /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.10, 0.80, 0.01 )
			.name( 'headWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckHeightFactor', 0.20, 1.00, 0.01 )
			.name( 'neckHeight /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headTailFactor', 0.20, 1.50, 0.01 )
			.name( 'headTail clamp' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		const swallow = folder.addFolder( 'Swallowtail' );
		swallow
			.add( entry.options, 'swallowtailFactor', 0.0, 3.0, 0.01 )
			.name( 'depth factor' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		swallow
			.add( entry.options, 'tailWidthFactor', 0.02, 0.30, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		swallow.close();

		const robust = folder.addFolder( 'Robustness' );
		robust
			.add(
				entry.options,
				'minBodyHalfAngleRadians',
				0.0,
				Math.PI / 4.0,
				0.005,
			)
			.name( 'minBodyHalf rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodyWidthMargin', 0.80, 2.00, 0.01 )
			.name( 'bodyWidth margin' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodySmoothingSegments', 2, 32, 1 )
			.name( 'body samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust.close();

		folder.close();
	}

	private installCurvedArrowFolder( parent: GUI, entry: CurvedArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		// 宽度三件套直接放在文件夹一级(不再藏进子文件夹),方便快速调粗细。
		// 三者都相对曲线总弧长:bodyWidth = 带子粗细,headWidth = 箭翼展开,
		// headLength = 箭头三角的长度。
		folder
			.add( entry.options, 'bodyWidthFactor', 0.005, 0.20, 0.005 )
			.name( '★ bodyWidth /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		folder
			.add( entry.options, 'headWidthFactor', 0.02, 0.40, 0.005 )
			.name( '★ headWidth /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		folder
			.add( entry.options, 'headLengthFactor', 0.02, 0.40, 0.005 )
			.name( '★ headLength /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		folder
			.add( entry.options, 'curveSmoothingSegments', 2, 64, 1 )
			.name( 'curve samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		// 注:neckWidthRelativeToHead / bodyTaperRatio 在当前曲线箭头算法
		// (五点头部 + 等宽体)中已不再生效,故不再暴露滑块。

		folder.close();
	}
}
