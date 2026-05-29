// ============================================================
// earcut-module.d.ts - earcut ^3.0.2 的最小 TypeScript 声明。
// 层级:polygon 路径使用的类型补充模块。
// 职责:earcut 只发布 JavaScript，且没有 @types/earcut；polygon 三角剖分
//      只消费默认导出的函数，因此这里声明足够通过类型检查的函数签名。
// 参考:earcut 源码 src/earcut.js 的主导出。
// ============================================================

declare module 'earcut' {
	/**
	 * 使用耳切算法三角化二维多边形，支持外环和可选洞环。
	 *
	 * @param data        扁平顶点数组；dim = 2 时为 `[x0, y0, x1, y1, ...]`，
	 *                    dim = 3 时为 `[x0, y0, z0, ...]`，z 会被忽略。
	 * @param holeIndices 每个洞环的起始顶点索引；没有洞时可省略。
	 * @param dim         每个顶点的分量数，默认 2。
	 * @returns           扁平三角形索引数组，长度等于 3 * 三角形数量。
	 */
	function earcut(
		data: number[] | ArrayLike<number>,
		holeIndices?: number[] | null,
		dim?: number,
	): number[];

	export default earcut;
}
