// ============================================================
// cesium-source-modules.d.ts
// 层级:Cesium 源码快照的模块声明。
// 职责:允许 TypeScript 以默认导入方式消费 cesium-ground-source 中保留的
//      未改动 JavaScript 模块。
// 依赖:cesium-ground-source/engine/Source。
// 被消费:terrain-heights.ts 等复用 Cesium 原始实现的模块。
// ============================================================

declare module '*cesium-ground-source/engine/Source/*.js' {
	const value: any;
	export default value;
}

