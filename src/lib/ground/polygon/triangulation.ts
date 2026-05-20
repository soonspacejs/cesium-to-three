// ============================================================
// polygon/triangulation.ts — 多边形 2D 三角剖分(earcut 包装)
// 层级:L1(基于第三方 earcut 库的轻量包装)
// 职责:把已被 ellipsoid-tangent-plane.ts 投到 2D 切平面的多边形顶点
//      (含外环 + 可选洞)按 earcut 算法三角化,返回顶点索引数组
//      (每 3 个一组构成一个三角形)。
// 依赖:earcut(npm 库,已在 package.json:earcut@^3.0.2,
//      与 Cesium 内部使用的 earcut 是同一个 npm 包 → V5 字节级一致可达)
//      Three.js Vector2
// 被消费:polygon-cap-construction.ts
// 算法对应:Cesium Source/Core/PolygonPipeline.js#triangulate(L67-78)+
//          createGeometryFromPositions(L974-977)length<3 兜底
// ============================================================

import earcut from 'earcut';
import type { Vector2 } from 'three';

/**
 * 对 2D 多边形(outer ring + 可选 holes)做三角剖分,返回索引数组。
 *
 * 顶点排列约定(必须与 caller polygon-rings.ts 输出一致):
 *   positions2D = [
 *     outer ring 顶点 0,
 *     outer ring 顶点 1,
 *     ...,
 *     outer ring 顶点 (outerN - 1),
 *     hole_0 顶点 0,
 *     hole_0 顶点 1,
 *     ...,
 *     hole_M 顶点 (lastHoleN - 1),
 *   ]
 *   holeStartIndices = [ outer 之后的第一个 hole 起点, ... ]   (顶点索引,非浮点偏移)
 *
 * winding 约定:
 *   - outer ring 必须 CCW(有向面积 > 0)
 *   - 每个 hole 必须 CW(有向面积 < 0)
 *
 * 上述 winding 由 polygon-rings.ts 的 `processRing` 用 shoelace 公式校正,
 * 本函数**不再做** winding 检查或反转 — 分层职责。
 *
 * earcut 库版本:本项目 `package.json:earcut@^3.0.2` 与 Cesium 通过 npm 解析后的
 * earcut 是同一个安装(都 import "earcut" 字符串,Node 解析到同一 node_modules)。
 * 因此 V5 字节级一致路径理论可达。
 *
 * 退化兜底:
 *   - 若 positions2D 长度 < 3(< 1 个三角形),或 earcut 返回 < 3 个索引(共线 / 自相交
 *     等极端情况),返回 `[0, 1, 2]` 占位三角形,避免下游 computeSubdivision 崩溃。
 *     Cesium 在 createGeometryFromPositions(L974-977)做同样兜底,本函数把这一层
 *     合并进来。
 *
 * @param positions2D      切平面 2D 顶点(由 ellipsoid-tangent-plane.projectPointsOntoPlane 产出)。
 * @param holeStartIndices 每个洞的起始顶点索引(可选;无洞时省略或 undefined)。
 * @returns                顶点索引数组,长度 = 3 × 三角形数(典型 N 顶点凸 polygon → 3·(N-2) 个索引)。
 */
export function triangulate(
	positions2D: readonly Vector2[],
	holeStartIndices?: readonly number[],
): number[] {
	const vertexCount = positions2D.length;

	// 一级兜底:输入顶点数 < 3 无法构成三角形
	if ( vertexCount < 3 ) {
		return [ 0, 1, 2 ];
	}

	// 把 Vector2[] 拍成 earcut 要求的扁平 [x0, y0, x1, y1, ...] 一维数组。
	// 等价 Cesium `Cartesian2.packArray(positions)`,但直接展开循环更快(无虚函数)。
	const flattened: number[] = new Array( vertexCount * 2 );
	for ( let i = 0; i < vertexCount; i++ ) {
		flattened[ i * 2 ] = positions2D[ i ].x;
		flattened[ i * 2 + 1 ] = positions2D[ i ].y;
	}

	// earcut 第 3 参 = dim = 2(2D)。3 时表示 3D 输入(earcut 会忽略 z)。
	// holeStartIndices 可以是 undefined → earcut 解释为"无洞"。
	// 类型转换:earcut TypeScript 签名要 number[](readonly 数组在传入时
	// 通过结构兼容,但为了符号清晰这里显式 cast。
	const indices = earcut(
		flattened,
		holeStartIndices as number[] | undefined,
		2,
	);

	// 二级兜底:earcut 罕见地返回空 / 1 个三角形以下
	// (例如 polygon 所有顶点共线,无法 ear-clip)
	if ( indices.length < 3 ) {
		return [ 0, 1, 2 ];
	}

	return indices;
}
