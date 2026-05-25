// ============================================================
// arrow/arrow-types.ts — 箭头标绘模块的公共类型与默认值常量
// 层级：L0(零依赖)
// 职责：定义所有箭头生成器的输入选项类型,集中维护各类箭头的比例因子、
//       角度阈值、采样上限等默认值常量。每个常量都带有几何含义注释,
//       便于上层覆盖默认值时理解效果。
// 依赖：ground 模块的 LonLatPoint 类型(re-export,避免循环依赖)。
// 被消费：arrow/ 目录下所有 shapes/*.ts 与 index.ts。
// 算法对应：与 cesium-plot-js v0.x 中各箭头类的构造器字段一一对应,数值默认值
//          保留与原项目相同的语义,新增 minBodyHalfAngleRadians 等鲁棒性参数。
// ============================================================

import type { LonLatPoint } from '../ground/types';

// 重新导出 LonLatPoint,使外部代码只需 import 自 arrow 模块即可。
export type { LonLatPoint };

/**
 * 细箭头(FineArrow)生成选项。
 *
 * 细箭头由两个端点定义,呈"窄尾 → 渐宽颈部 → 三角箭头"的填充多边形。
 * 所有比例因子相对于 `(|p1 p2|) ** 0.99`(基准长度)度量,因此长度变化时
 * 整体形状成比例缩放。
 */
export interface FineArrowOptions {
	/** 尾部宽度因子(基准长度的倍数)。默认 0.10 */
	tailWidthFactor?: number;
	/** 颈部宽度因子。默认 0.20 */
	neckWidthFactor?: number;
	/** 翼展宽度因子。默认 0.25 */
	headWidthFactor?: number;
	/** 翼展张开角(弧度)。默认 π/8.5 ≈ 0.370 rad ≈ 21.18° */
	headAngleRadians?: number;
	/** 颈部夹角(弧度)。默认 π/13 ≈ 0.242 rad ≈ 13.85° */
	neckAngleRadians?: number;
}

/**
 * 突击方向箭头(AssaultDirectionArrow)生成选项。
 *
 * 与 FineArrow 同形但更"窄长"——尾部更细、翼展更小,适合表示局部突击方向。
 * 内部计算时还会把基准长度放大 1.5 倍以让箭头看起来更修长。
 */
export interface AssaultDirectionArrowOptions {
	/** 基准长度倍率(影响整体大小)。默认 1.5 */
	lengthScale?: number;
	/** 尾部宽度因子。默认 0.08 */
	tailWidthFactor?: number;
	/** 颈部宽度因子。默认 0.10 */
	neckWidthFactor?: number;
	/** 翼展宽度因子。默认 0.13 */
	headWidthFactor?: number;
	/** 翼展张开角(弧度)。默认 π/4 = 45° */
	headAngleRadians?: number;
	/** 颈部夹角(弧度)。默认 0.5575 rad ≈ 31.94°(原 π*0.17741) */
	neckAngleRadians?: number;
}

/**
 * 攻击箭头(AttackArrow)生成选项。
 *
 * 攻击箭头至少 3 个控制点:前 2 个定义尾部宽度,从第 3 个开始定义脊线。
 * 体部沿脊线渐变(从尾宽到颈宽),末端是五点三角箭头。
 *
 * 鲁棒性参数(`minBodyHalfAngleRadians` / `bodyWidthMargin`)用于防止
 * 锐角脊线导致体部宽度爆炸(原 cesium-plot-js 的 4+ 控制点 bug)。
 */
export interface AttackArrowOptions {
	/** 头部高度相对脊线基准长度的因子。默认 0.18 */
	headHeightFactor?: number;
	/** 翼展宽度相对头部高度的因子。默认 0.30 */
	headWidthFactor?: number;
	/** 颈部高度相对头部高度的因子。默认 0.85 */
	neckHeightFactor?: number;
	/** 颈部宽度相对头部高度的因子。默认 0.15 */
	neckWidthFactor?: number;
	/** 头部高度不超过尾宽的此倍数,防止头部过大。默认 0.80 */
	headTailFactor?: number;
	/**
	 * 体部宽度计算中,脊线半角的最小值(弧度)。
	 * w = (tailWidth/2 - dropoff) / sin(halfAngle)
	 * 当 halfAngle → 0 时 w 发散,这里下限保证 sin ≥ sin(π/12) ≈ 0.259,
	 * 即 w ≤ ~3.86 倍正常值,不会让体部翻出。
	 * 默认 π/12 ≈ 15°(即原始夹角 30° 以下被钳制)。
	 */
	minBodyHalfAngleRadians?: number;
	/**
	 * 体部宽度上限相对尾宽半值的倍数。
	 * 即使 minBodyHalfAngleRadians 触发了 clamp,最终 w 也不会超过
	 * `tailWidth/2 * bodyWidthMargin`,确保体部永远在尾部宽度之内。
	 * 默认 1.05(留 5% 余量给视觉过渡)。
	 */
	bodyWidthMargin?: number;
	/**
	 * Catmull-Rom 平滑每段控制点之间的采样数(不含两端点)。
	 * 较小的值(8-16)足以让体部边缘视觉平滑,较大的值会增加最终多边形
	 * 顶点数,有命中 MAX_POLYGON_STYLE_VERTICES = 128 上限的风险。
	 * 默认 12。
	 */
	bodySmoothingSegments?: number;
}

/**
 * 燕尾攻击箭头(SwallowtailAttackArrow)生成选项。
 *
 * 比 AttackArrow 多一个"燕尾"凹口——在尾部中点向脊线相反方向凸出一个点。
 * 燕尾因子越大,尾部凹口越深。其它字段含义与 AttackArrowOptions 完全相同。
 */
export interface SwallowtailAttackArrowOptions extends AttackArrowOptions {
	/**
	 * 燕尾凸出深度因子(相对 tailWidthFactor × baseLength)。默认 1.0。
	 * 0 表示退化为普通 AttackArrow,>1 表示凸出更深。
	 */
	swallowtailFactor?: number;
	/**
	 * 燕尾凸出参考宽度因子(相对脊线基准长度)。默认 0.10。
	 * 与 swallowtailFactor 共同决定凸出距离。
	 */
	tailWidthFactor?: number;
}

/**
 * 曲线箭头(CurvedArrow)生成选项。
 *
 * 曲线箭头由 2+ 个控制点定义一条平滑曲线,沿曲线两侧偏移给定宽度后
 * 闭合成填充多边形,末端附加三角箭头。当只有 2 个控制点时退化为
 * 直线版本(FineArrow 的窄长变体)。
 *
 * 注:与 cesium-plot-js 的 CurvedArrow(line type)不同,本实现产出
 * **闭合多边形**,以适配本项目仅有 polygon primitive 的渲染管线。
 */
export interface CurvedArrowOptions {
	/**
	 * 体部线宽因子(相对曲线总长度)。默认 0.05。
	 * 越大则线条越粗。
	 */
	bodyWidthFactor?: number;
	/**
	 * 头部翼展宽度因子(相对曲线总长度)。默认 0.16。
	 */
	headWidthFactor?: number;
	/**
	 * 头部长度因子(相对曲线总长度)。默认 0.12。
	 * 决定箭头从尖端向后延伸多远。
	 */
	headLengthFactor?: number;
	/**
	 * 颈部宽度因子(相对头部翼展)。默认 0.50。
	 * 必须 < 1,否则颈部比翼尖宽,箭头形状反转。
	 */
	neckWidthRelativeToHead?: number;
	/**
	 * Catmull-Rom 平滑每段控制点之间的采样数。默认 16。
	 */
	curveSmoothingSegments?: number;
	/**
	 * 体部从尾到颈的宽度收窄比(0 = 不收窄;0.5 = 颈部宽度是尾部的 50%)。
	 * 默认 0.0(等宽线条)。
	 */
	bodyTaperRatio?: number;
}

/**
 * 所有箭头生成器统一的输出契约:
 * 一个**闭合的、CCW(逆时针)绕向、无连续重复顶点**的经纬度环。
 *
 * 可以直接作为 `CesiumGroundPolygonPrimitive` 构造选项的 `points` 字段使用。
 * 长度上限受 `MAX_POLYGON_STYLE_VERTICES = 128` 约束,本模块所有生成器
 * 都在内部 clamp 到 ≤120 以留出余量。
 */
export type ArrowPolygon = LonLatPoint[];
