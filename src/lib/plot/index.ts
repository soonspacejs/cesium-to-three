// ============================================================
// index.ts — plot 模块对外出口
// 层级：模块出口（顶层公共 API）
// 职责：导出管理器、桥接器、数据模型类、全部类型与工具，构成对外契约。
//       业务层只 `import { GroundDecalManager, ... } from '<repo>/src/lib/plot'`，
//       不应深入到子目录，以便后续重构内部文件不影响外部。
// 依赖：本目录各文件。
// 被消费：业务层（demo / 上层应用）。
// ============================================================

// 管理器与构造类型
export { GroundDecalManager } from './GroundDecalManager';
export type {
	GroundDecalManagerOptions,
	GisPlotItemSnapshot,
	GisPlotStylePatch,
	CenterLonLat,
} from './GroundDecalManager';

// 数据模型类 + 全部类型（plugins 桶导出已含 types）
export * from './plugins/index';

// 工具：对外保留与参考项目一致的导出
export {
	parseColorToRGBA,
	resolveOpacity,
} from './plugins/utils/colorUtils';
export type {
	NormalizedRGBA,
	StyleOpacityInput,
} from './plugins/utils/colorUtils';

export * from './plugins/utils/ArrowUtils';

// 桥接器一般无需对外，业务若需自定义场景接入再选择性使用
export { PlotPrimitiveBridge } from './PlotPrimitiveBridge';
export type { PlotPrimitiveBridgeOptions } from './PlotPrimitiveBridge';

export {
	EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID,
	EMERGENCY_RESOURCE_ONTOLOGY_IDS,
	resolveEmergencyResourceIcon,
	resolvePlotPointImageUrl,
} from './emergency-resource-icons';
export type { EmergencyResourceOntologyId } from './emergency-resource-icons';

// 标绘顺序工具（与 demo plot-utils 一致的入口）
export {
	plotOrderToRenderOrder,
	sanitizePlotOrder,
} from './plot-order';
