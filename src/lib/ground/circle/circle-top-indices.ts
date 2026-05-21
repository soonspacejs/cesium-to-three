// ============================================================
// circle/circle-top-indices.ts — Circle 顶面三角形索引模板
// 层级:L1(纯函数,零依赖)
// 职责:给定 numPts(第一象限环数),产出顶面三角形索引数组。
//      数组长度公式:12 × numPts × (numPts + 1) − 6,与 fill 网格顶点
//      的 4 region 遍历顺序对应(circle-positions.ts 输出的索引空间)。
// 依赖:无运行时依赖。
// 被消费:circle-construct-extruded.ts(top 索引 + 镜像生成 bottom 索引)。
// 算法对应:Cesium Source/Core/EllipseGeometry.js#topIndices(L314-413)。
//          逐字复刻 4 region 顺序、变量名、递增模式与循环边界。
// ============================================================

/**
 * 计算 Circle 顶面三角形索引数组。
 *
 * 按 4 region 顺序构造索引:
 *   - Region 1:东半象限(初始 fan 3 个三角形 + i = 2..numPts 主循环)
 *   - Region 2:中心列(numInterior = numPts × 2 的水平带 + 末尾两个三角形)
 *   - Region 3:西半象限(i = numPts-1 .. 2 反向循环)
 *   - Region 4:南帽(3 个三角形,连接最南顶点与西半最后一环)
 *
 * 索引数组长度 = 12 × numPts × (numPts + 1) − 6(Cesium 注释推导)。
 *
 * 字节级关键(V5):
 *   - 变量名 `positionIndex / prevIndex / numInterior / indicesIndex` 严格保留
 *   - 后置 ++ vs 前置 ++ 模式每行都对齐 Cesium 源
 *   - Region 边界处的 `++positionIndex` / `++prevIndex` 不能漏
 *   - Region 3 末尾用 `prevIndex++` 两次 + `positionIndex++` 一次,与
 *     Region 1 末尾的 `positionIndex++` 一次不同 — 这是 Cesium 算法特性,
 *     非笔误,必须复刻
 *
 * 输出类型为 plain number[](Cesium 也用 Array<number>),由上层
 * `circle-construct-extruded.ts` 通过 `createIndexTypedArray` 转 Uint16/32。
 *
 * @param numPts 第一象限内的环数(由 computeCircleFillPositions 输出决定,
 *               经 if-branch 兜底后的最终值)。
 * @returns      三角形索引数组,长度 = 12 × numPts × (numPts + 1) − 6。
 */
export function computeTopIndices( numPts: number ): number[] {
	// Cesium L321:`new Array(12 * (numPts * (numPts + 1)) - 6)`。
	// 等价于 `12 * numPts * (numPts + 1) - 6`(算子优先级)。
	const indices: number[] = new Array( 12 * ( numPts * ( numPts + 1 ) ) - 6 );

	let indicesIndex = 0;
	let prevIndex: number;
	let numInterior: number;
	let positionIndex: number;
	let i: number;
	let j: number;

	// ============================================================
	// Region 1.A:连接最北点 (index 0) 与第 1 环 4 个内插点的 3 个三角形
	//(Cesium L330-336)
	// 写入顺序:(1, 0, 2), (2, 0, 3), (3, 0, 4)。
	// positionIndex 后置 ++ 从 1 起步,prevIndex 固定 0(最北点)。
	// ============================================================
	prevIndex = 0;
	positionIndex = 1;
	for ( i = 0; i < 3; i++ ) {
		indices[ indicesIndex++ ] = positionIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;
	}

	// ============================================================
	// Region 1.B:东半象限主循环 i = 2..numPts(Cesium L338-360)
	//
	// 每个 i 对应 fill 网格的第 i 环:
	//   positionIndex = i × (i + 1) − 1     ← 第 i 环起始位置 − 1
	//   prevIndex     = (i − 1) × i − 1     ← 第 (i-1) 环起始位置 − 1
	//   numInterior   = 2 × i                ← 当前环内"位置对"数
	//
	// 写入三段:
	//   段 1:首三角形 (positionIndex++, prevIndex, positionIndex)
	//   段 2:numInterior − 1 个"双三角形"(每次写 6 个索引)
	//   段 3:末三角形 (positionIndex++, prevIndex, positionIndex)
	// ============================================================
	for ( i = 2; i < numPts + 1; ++i ) {
		positionIndex = i * ( i + 1 ) - 1;
		prevIndex = ( i - 1 ) * i - 1;

		indices[ indicesIndex++ ] = positionIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;

		numInterior = 2 * i;
		for ( j = 0; j < numInterior - 1; ++j ) {
			indices[ indicesIndex++ ] = positionIndex;
			indices[ indicesIndex++ ] = prevIndex++;
			indices[ indicesIndex++ ] = prevIndex;

			indices[ indicesIndex++ ] = positionIndex++;
			indices[ indicesIndex++ ] = prevIndex;
			indices[ indicesIndex++ ] = positionIndex;
		}

		indices[ indicesIndex++ ] = positionIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;
	}

	// ============================================================
	// Region 2:中心列水平带(Cesium L362-383)
	//
	// 关键:Region 1 结束时 positionIndex / prevIndex 处于"最后一环末点",
	// Region 2 开头 ++positionIndex; ++prevIndex; 跳到中心列起点。
	// numInterior = numPts × 2(中心列上每边的点对数)。
	// ============================================================
	numInterior = numPts * 2;
	++positionIndex;
	++prevIndex;
	for ( i = 0; i < numInterior - 1; ++i ) {
		indices[ indicesIndex++ ] = positionIndex;
		indices[ indicesIndex++ ] = prevIndex++;
		indices[ indicesIndex++ ] = prevIndex;

		indices[ indicesIndex++ ] = positionIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;
	}

	// Region 2 末尾 2 个三角形(Cesium L376-382)
	// 第一段:(positionIndex, prevIndex++, prevIndex)
	indices[ indicesIndex++ ] = positionIndex;
	indices[ indicesIndex++ ] = prevIndex++;
	indices[ indicesIndex++ ] = prevIndex;

	// 第二段:(positionIndex++, prevIndex++, prevIndex)
	// ← 注意:这里 prevIndex 也 ++(L381),与 Region 1 末段只有
	// positionIndex++ 不同。这是 Region 2 → Region 3 之间的桥梁。
	indices[ indicesIndex++ ] = positionIndex++;
	indices[ indicesIndex++ ] = prevIndex++;
	indices[ indicesIndex++ ] = prevIndex;

	// ============================================================
	// Region 3:西半象限主循环 i = numPts-1 .. 2(反向)(Cesium L385-405)
	//
	// Region 3 开头 ++prevIndex(L385),进入西半第一环。
	// 每个 i 对应 fill 网格的镜像环:
	//   numInterior = 2 × i(与东半同公式;但 i 从 numPts-1 反向,
	//   实际处理的镜像环是 numPts - i + 第几环)。
	//
	// 关键差异 vs Region 1.B:
	//   - 首三角形写法:(prevIndex++, prevIndex, positionIndex)
	//     (Region 1.B 是 (positionIndex++, prevIndex, positionIndex))
	//   - 末三角形写法:(prevIndex++, prevIndex++, positionIndex++)
	//     用了两个 prevIndex++ 和一个 positionIndex++
	// ============================================================
	++prevIndex;
	for ( i = numPts - 1; i > 1; --i ) {
		indices[ indicesIndex++ ] = prevIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;

		numInterior = 2 * i;
		for ( j = 0; j < numInterior - 1; ++j ) {
			indices[ indicesIndex++ ] = positionIndex;
			indices[ indicesIndex++ ] = prevIndex++;
			indices[ indicesIndex++ ] = prevIndex;

			indices[ indicesIndex++ ] = positionIndex++;
			indices[ indicesIndex++ ] = prevIndex;
			indices[ indicesIndex++ ] = positionIndex;
		}

		// Region 3 末三角形:prevIndex++ × 2 + positionIndex++ × 1
		indices[ indicesIndex++ ] = prevIndex++;
		indices[ indicesIndex++ ] = prevIndex++;
		indices[ indicesIndex++ ] = positionIndex++;
	}

	// ============================================================
	// Region 4:南帽(Cesium L407-411)
	// 3 个三角形,连接西半最后一环与最南顶点(positionIndex 现指向最南)。
	// 写入顺序:(prevIndex++, prevIndex, positionIndex) × 3。
	// ============================================================
	for ( i = 0; i < 3; i++ ) {
		indices[ indicesIndex++ ] = prevIndex++;
		indices[ indicesIndex++ ] = prevIndex;
		indices[ indicesIndex++ ] = positionIndex;
	}

	return indices;
}
