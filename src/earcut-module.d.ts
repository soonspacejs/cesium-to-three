// ============================================================
// earcut-module.d.ts — earcut@^3.0.2 (npm) 的最小 TypeScript 声明
// 项目使用 earcut 进行 polygon 2D 三角剖分(见 src/lib/ground/polygon/triangulation.ts)。
// 该包发布时不带 .d.ts,也没有 @types/earcut,因此在此手写声明。
// 签名参考 earcut 源码 src/earcut.js 主导出。
// ============================================================

declare module 'earcut' {
	/**
	 * 把 2D 多边形(outer ring + 可选 holes)按 ear-clipping 算法三角化。
	 *
	 * @param data         扁平顶点数组,[x0, y0, x1, y1, ...] 或 dim=3 时 [x0,y0,z0,...](z 被忽略)。
	 * @param holeIndices  每个洞起始顶点的索引(顶点索引,非浮点偏移);无洞时省略或 undefined。
	 * @param dim          每个顶点的分量数(默认 2;3 时输入是 3D,仍只用 x/y 做剖分)。
	 * @returns            三角形索引数组,长度 = 3 × 三角形数。
	 */
	function earcut(
		data: number[] | ArrayLike<number>,
		holeIndices?: number[] | null,
		dim?: number,
	): number[];

	export default earcut;
}
