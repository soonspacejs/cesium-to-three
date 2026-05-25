// ============================================================
// arrow/index.ts — 箭头标绘模块的公共 API
// 层级：L2(模块出口)
// 职责：把所有箭头生成函数与类型集中导出,作为模块对外的唯一入口。
//      上层(如 demo / 业务代码)只应 `import { createXxx } from '.../arrow'`,
//      不应深入到 `shapes/` 子目录,以便后续重命名或重构子文件不影响外部。
//
// 设计原则:
//   - 每个箭头函数返回 `ArrowPolygon` (LonLatPoint[]),可直接喂给
//     `new CesiumGroundPolygonPrimitive({ points, fillColor, ... })`。
//   - 所有函数都是纯函数,不持有状态,不依赖 Cesium / Three.js;
//     可以在 Worker、SSR、单元测试中无副作用调用。
//   - 函数返回的多边形已经过 finalizePolygon 处理:去重、CCW 绕向、
//     顶点数 ≤ 120(为 MAX_POLYGON_STYLE_VERTICES = 128 留出余量)。
//
// 依赖:./shapes/*.ts、./arrow-types.ts。
// 被消费:src/demo/*、src/lib/ground 之上的业务渲染代码。
// ============================================================

export { createFineArrow } from './shapes/fine-arrow';
export { createAssaultDirectionArrow } from './shapes/assault-direction-arrow';
export { createAttackArrow } from './shapes/attack-arrow';
export { createSwallowtailAttackArrow } from './shapes/swallowtail-attack-arrow';
export { createCurvedArrow } from './shapes/curved-arrow';

// ── 公共类型(选项与输出契约)──
// 重新导出类型,使上层不必同时 import 自 'arrow' 与 'arrow/arrow-types'。
export type {
	ArrowPolygon,
	LonLatPoint,
	FineArrowOptions,
	AssaultDirectionArrowOptions,
	AttackArrowOptions,
	SwallowtailAttackArrowOptions,
	CurvedArrowOptions,
} from './arrow-types';

// ── 进阶导出:输出多边形的顶点上限常量 ──
// 业务代码若需要在调用前预判顶点数(例如根据视野裁剪决定是否绘制),
// 可以参照此常量。MAX_POLYGON_STYLE_VERTICES = 128,本模块统一 clamp 到 120。
export { ARROW_OUTPUT_MAX_VERTICES } from './arrow-polygon';
