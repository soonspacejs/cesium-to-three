// ============================================================
// text/index.ts — 贴地文本标绘模块公共 API
// 层级：L4（模块出口）
// 职责：集中导出公开类与类型，作为模块唯一入口。上层只 import 自此，
//      不深入子文件。
// 依赖：本目录各文件。
// 被消费：src/lib/ground/index.ts、demo、业务渲染代码。
// ============================================================

export { CesiumGroundTextPrimitive } from './text-primitive';

export type {
	PlotTextOptions,
	CesiumGroundTextPrimitiveOptions,
	PlotTextAlign,
	PlotTextVerticalAlign,
	PlotTextAnchorX,
	PlotTextAnchorY,
	PlotTextLayoutDirection,
	PlotTextBoxOverflow,
	LonLatPoint,
} from './text-types';

// 进阶导出：供需要单独算足迹 / 几何 / extents 的高级用法。
export { computeTextFootprint, type TextFootprint } from './text-placement';
export { buildTextShadowVolumeGeometry } from './text-shadow-volume';
export { computeTextPlanarExtents } from './text-extents';
export {
	type TextShadowVolumeOptions,
	TEXT_DEFAULT_MAX_HEIGHT,
	TEXT_DEFAULT_MIN_HEIGHT,
} from './text-options';
