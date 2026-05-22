// ============================================================
// earcut-module.d.ts — minimal TypeScript declaration for earcut ^3.0.2.
// Layer: type-only ambient module for the polygon path.
// Role:  earcut ships JS without .d.ts and no @types/earcut exists. The
//        polygon triangulation step (src/lib/ground/polygon/triangulation.ts)
//        consumes its default export, so we declare just enough of the
//        function signature here for the type-check pass to succeed.
// Reference: earcut source src/earcut.js (main export).
// ============================================================

declare module 'earcut' {
	/**
	 * Triangulates a 2D polygon (outer ring plus optional holes) using the
	 * ear-clipping algorithm.
	 *
	 * @param data        Flat vertex array — `[x0, y0, x1, y1, ...]` for
	 *                    dim = 2 or `[x0, y0, z0, ...]` for dim = 3 (z is
	 *                    ignored, only x/y participate in triangulation).
	 * @param holeIndices Starting vertex index of each hole ring. Omit for
	 *                    polygons with no holes.
	 * @param dim         Components per vertex; defaults to 2.
	 * @returns           Flat triangle index array (length = 3 × triangles).
	 */
	function earcut(
		data: number[] | ArrayLike<number>,
		holeIndices?: number[] | null,
		dim?: number,
	): number[];

	export default earcut;
}
