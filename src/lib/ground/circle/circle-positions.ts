// ============================================================
// circle/circle-positions.ts — Circle fill 网格 + 外圈点生成
// 层级:L1(基于 Three.js Vector3/Quaternion 容器,但浮点路径完全自托管)
// 职责:
//   - 在 circle center 处建立局部坐标系(unitPos / eastVec / northVec)
//   - 用 _pointOnEllipsoid 在椭球周界上算单点
//   - 4 region 遍历产生 fill 网格(numPts × (numPts + 2) × 2 顶点)
//   - 同时填充外圈数组 outerPositions(numPts × 4 顶点,绕圆一圈)
// 依赖:Three.js Vector3 / Quaternion(仅用作 number 字段容器,
//        所有浮点路径手写以匹配 Cesium IEEE-754 行为)
// 被消费:circle-top-bottom.ts、circle-wall-construction.ts、
//        circle-construct-extruded.ts
// 算法对应:
//   - Cesium EllipseGeometryLibrary.js#pointOnEllipsoid(L13-49)
//   - Cesium EllipseGeometryLibrary.js#computeEllipsePositions(L113-364)
//   - Cesium Matrix3.js#fromQuaternion(L296-337)
//   - Cesium Matrix3.js#multiplyByVector(L1145-1164)
//   - Cesium Quaternion.js#fromAxisAngle(L60-82)
//   - Cesium Cartesian3.js#normalize(L405-424)
//   圆形特化 a = b = r,但算法路径**逐字保留**(不做特化简化)以确保
//   V5 严格字节级一致。
// ============================================================

import { Quaternion, Vector3 } from 'three';

// ============================================================
// 模块级 scratch
//   命名对齐 Cesium EllipseGeometryLibrary.js 同位置 scratch 变量,
//   便于人眼 visual diff。所有 scratch 仅在同步路径上复用,JS 单线程
//   保证不冲突;禁止在异步 await 上下文中跨 yield 持有这些 scratch。
// ============================================================

// Cesium Cartesian3.UNIT_Z(EllipseGeometryLibrary.js L136 处使用)。
// 用 Object.freeze 防误改;每次 cross 通过 .x/.y/.z 字段读取。
const _UNIT_Z = Object.freeze( new Vector3( 0.0, 0.0, 1.0 ) );

// 局部基(对应 Cesium L106-108)
const _unitPosScratch = new Vector3();
const _eastVecScratch = new Vector3();
const _northVecScratch = new Vector3();

// computeEllipsePositions 主循环 scratch(对应 Cesium L51-53)
const _scratchCartesian1 = new Vector3();
const _scratchCartesian2 = new Vector3();
const _scratchCartesian3 = new Vector3();

// _pointOnEllipsoid 内部 scratch(对应 Cesium L8-11)
const _rotAxisScratch = new Vector3();
const _tempVecScratch = new Vector3();
const _unitQuatScratch = new Quaternion();

// _matrix3FromQuaternion 输出 column-major 9 元素 storage。
// 对应 Cesium L11 的 `const rotMtx = new Matrix3()`(底层是
// 长度 9 的 Float64 数组,column-major)。
const _rotMtxStorage: number[] = new Array( 9 );

/**
 * Cesium 风格 Cartesian3.normalize:result = source / |source|。
 *
 * 与 Three.js Vector3.normalize() 不同:Three.js 走
 * `multiplyScalar(1 / length)` 路径(先求倒数再乘),
 * 浮点路径有 1 ULP 差异。本函数逐字复刻 Cesium 的
 * `divide each component by magnitude` 路径以保证字节级一致。
 *
 * Cesium 对应:Cartesian3.js#normalize(L405-424)
 */
function _cartesianNormalize( source: Vector3, result: Vector3 ): Vector3 {
	const magnitude = Math.sqrt(
		source.x * source.x +
		source.y * source.y +
		source.z * source.z,
	);
	result.x = source.x / magnitude;
	result.y = source.y / magnitude;
	result.z = source.z / magnitude;
	return result;
}

/**
 * Cesium 风格 Cartesian3.cross:result = left × right。
 *
 * 与 Three.js Vector3.crossVectors() 浮点路径**理论一致**(都是
 * `(ay·bz − az·by, az·bx − ax·bz, ax·by − ay·bx)`),但为了保险
 * 用同名 helper 也手写一次,避免 Three.js 内部某次重构改变运算顺序。
 *
 * 注意:source.x 与 result.x 可能是同一个对象的字段(in-place),
 * 因此先取 3 个本地变量再写入。Cesium Cartesian3.cross 也做了同样
 * 的本地变量缓存。
 *
 * Cesium 对应:Cartesian3.js#cross(L580+,逐字)。
 */
function _cartesianCross( left: Vector3, right: Vector3, result: Vector3 ): Vector3 {
	const leftX = left.x;
	const leftY = left.y;
	const leftZ = left.z;
	const rightX = right.x;
	const rightY = right.y;
	const rightZ = right.z;

	const x = leftY * rightZ - leftZ * rightY;
	const y = leftZ * rightX - leftX * rightZ;
	const z = leftX * rightY - leftY * rightX;

	result.x = x;
	result.y = y;
	result.z = z;
	return result;
}

/**
 * Cesium 风格 Cartesian3.multiplyByScalar:result = source · scalar。
 *
 * 与 Three.js Vector3.multiplyScalar() 一致,但 Three.js 是
 * `this.x *= scalar`(in-place 只能作用于 this),不允许 source/result
 * 不同。本函数允许两者不同,与 Cesium API 对齐。
 *
 * Cesium 对应:Cartesian3.js#multiplyByScalar。
 */
function _cartesianMultiplyByScalar(
	source: Vector3, scalar: number, result: Vector3,
): Vector3 {
	result.x = source.x * scalar;
	result.y = source.y * scalar;
	result.z = source.z * scalar;
	return result;
}

/**
 * Cesium 风格 Cartesian3.add:result = left + right。
 *
 * Cesium 对应:Cartesian3.js#add。
 */
function _cartesianAdd(
	left: Vector3, right: Vector3, result: Vector3,
): Vector3 {
	result.x = left.x + right.x;
	result.y = left.y + right.y;
	result.z = left.z + right.z;
	return result;
}

/**
 * Cesium 风格 Cartesian3.lerp:result = start + (end − start) · t。
 *
 * 注意:这与 `(1 − t) · start + t · end` 浮点路径**不同** —
 * 后者在 t = 0 / t = 1 时精确返回 start / end,前者可能有 1 ULP 误差。
 * 本期严格按 Cesium 顺序 `start + (end − start) · t` 复刻。
 *
 * Cesium 对应:Cartesian3.js#lerp(内部用 subtract + multiplyByScalar + add)。
 */
function _cartesianLerp(
	start: Vector3, end: Vector3, t: number, result: Vector3,
): Vector3 {
	// Cesium 内部:Cartesian3.subtract(end, start, lerpScratch);
	//             Cartesian3.multiplyByScalar(lerpScratch, t, lerpScratch);
	//             Cartesian3.add(start, lerpScratch, result);
	// 等价的展开式(每分量一行)— 与 Cesium subtract → multiplyByScalar → add
	// 三步浮点路径一致(同一组乘加顺序)。
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const dz = end.z - start.z;
	result.x = start.x + dx * t;
	result.y = start.y + dy * t;
	result.z = start.z + dz * t;
	return result;
}

/**
 * Cesium 风格 Quaternion.fromAxisAngle:把 (axis, angle) 转为单位四元数。
 *
 * Cesium 关键:**内部对 axis 做了 normalize**(L68),Three.js 的
 * setFromAxisAngle 假设 axis 已经归一化。本期复刻 Cesium 行为以保证
 * 即使传入未归一化 axis 也字节级一致(实际本期 caller 都传入归一化 axis,
 * 但保留 normalize 以确保浮点路径完全一致)。
 *
 * Cesium 对应:Quaternion.js#fromAxisAngle(L60-82)
 */
function _quaternionFromAxisAngle(
	axis: Vector3, angle: number, result: Quaternion,
): Quaternion {
	const halfAngle = angle / 2.0;
	const s = Math.sin( halfAngle );

	// Cesium L68: fromAxisAngleScratch = Cartesian3.normalize(axis, fromAxisAngleScratch);
	// 用 _tempVecScratch 临时存归一化后的 axis(Cesium 用 fromAxisAngleScratch 私有 scratch)。
	const normalizedAxis = _cartesianNormalize( axis, _tempVecScratch );

	const x = normalizedAxis.x * s;
	const y = normalizedAxis.y * s;
	const z = normalizedAxis.z * s;
	const w = Math.cos( halfAngle );

	result.x = x;
	result.y = y;
	result.z = z;
	result.w = w;
	return result;
}

/**
 * Cesium 风格 Matrix3.fromQuaternion:把四元数转为 3×3 旋转矩阵
 *(column-major,9 元素)。
 *
 * 字节级关键:Cesium 算 9 个临时积(x2, xy, xz, xw, y2, yz, yw, z2, zw, w2),
 * 再用它们组合出 m00..m22,然后按 column-major 存入 result[0..8]:
 *
 *      result[0] = m00  result[3] = m01  result[6] = m02
 *      result[1] = m10  result[4] = m11  result[7] = m12
 *      result[2] = m20  result[5] = m21  result[8] = m22
 *
 * Three.js 的 Matrix3 没有 fromQuaternion API(只有 Matrix4 有,
 * 且其内部公式与 Cesium 不同 — Three.js 用 `1 - 2*(y² + z²)` 而
 * Cesium 用 `x² - y² - z² + w²`,浮点结果可能差 1 ULP)。本期手写
 * 逐字复刻 Cesium 公式。
 *
 * Cesium 对应:Matrix3.js#fromQuaternion(L296-337)
 */
function _matrix3FromQuaternion(
	quaternion: Quaternion, result: number[],
): void {
	const x2 = quaternion.x * quaternion.x;
	const xy = quaternion.x * quaternion.y;
	const xz = quaternion.x * quaternion.z;
	const xw = quaternion.x * quaternion.w;
	const y2 = quaternion.y * quaternion.y;
	const yz = quaternion.y * quaternion.z;
	const yw = quaternion.y * quaternion.w;
	const z2 = quaternion.z * quaternion.z;
	const zw = quaternion.z * quaternion.w;
	const w2 = quaternion.w * quaternion.w;

	const m00 = x2 - y2 - z2 + w2;
	const m01 = 2.0 * ( xy - zw );
	const m02 = 2.0 * ( xz + yw );

	const m10 = 2.0 * ( xy + zw );
	const m11 = -x2 + y2 - z2 + w2;
	const m12 = 2.0 * ( yz - xw );

	const m20 = 2.0 * ( xz - yw );
	const m21 = 2.0 * ( yz + xw );
	const m22 = -x2 - y2 + z2 + w2;

	// Column-major 存储:result[col*3 + row]
	result[ 0 ] = m00;
	result[ 1 ] = m10;
	result[ 2 ] = m20;
	result[ 3 ] = m01;
	result[ 4 ] = m11;
	result[ 5 ] = m21;
	result[ 6 ] = m02;
	result[ 7 ] = m12;
	result[ 8 ] = m22;
}

/**
 * Cesium 风格 Matrix3.multiplyByVector:result = matrix · cartesian。
 *
 * Column-major × column-vector:
 *      x = m[0]·vX + m[3]·vY + m[6]·vZ
 *      y = m[1]·vX + m[4]·vY + m[7]·vZ
 *      z = m[2]·vX + m[5]·vY + m[8]·vZ
 *
 * Cesium 对应:Matrix3.js#multiplyByVector(L1145-1164)
 */
function _matrix3MultiplyByVector(
	matrix: number[], cartesian: Vector3, result: Vector3,
): Vector3 {
	const vX = cartesian.x;
	const vY = cartesian.y;
	const vZ = cartesian.z;

	const x = matrix[ 0 ] * vX + matrix[ 3 ] * vY + matrix[ 6 ] * vZ;
	const y = matrix[ 1 ] * vX + matrix[ 4 ] * vY + matrix[ 7 ] * vZ;
	const z = matrix[ 2 ] * vX + matrix[ 5 ] * vY + matrix[ 8 ] * vZ;

	result.x = x;
	result.y = y;
	result.z = z;
	return result;
}

/**
 * 椭圆周界单点定位。
 *
 * 给定参数角 theta(π/2=最北,0=最东,-π/2=最南)与 stRotation,
 * 算椭球面上对应的 ECEF 位置。圆形特化 a = b = r,但算法**逐字保留**
 * Cesium EllipseGeometryLibrary.js#pointOnEllipsoid(L13-49)的浮点
 * 运算路径(包括 `radius = ab / sqrt(bSqr·cos² + aSqr·sin²)` 完整公式)。
 *
 * 算法 5 步:
 *   1. azimuth = theta + rotation
 *      rotAxis = eastVec·cos(azimuth) + northVec·sin(azimuth)
 *      (Cesium 分两步:先 multiplyByScalar 后 add,本期同序复刻)
 *   2. radius = ab / sqrt(bSqr·cos²(theta) + aSqr·sin²(theta))
 *      (圆形特化 = r,但浮点路径含 sqrt 与除法,不直接简化为 r)
 *   3. angle = radius / mag(从 center 法向偏转的弧度数)
 *   4. unitQuat = Quaternion.fromAxisAngle(rotAxis, angle)
 *      rotMtx = Matrix3.fromQuaternion(unitQuat)
 *      result = Matrix3.multiplyByVector(rotMtx, unitPos)
 *   5. result = normalize(result) · mag
 *
 * 字节级关键(R1):**不能用 Three.js Vector3.applyQuaternion** —
 * 后者用 `q × v × q⁻¹` 精简公式,浮点路径与 Cesium 的
 * Matrix3.fromQuaternion + multiplyByVector 三步不一致。
 *
 * Cesium 对应:EllipseGeometryLibrary.js#pointOnEllipsoid(L13-49)。
 *
 * @param theta    参数角(弧度)。
 * @param rotation stRotation(弧度)。
 * @param northVec 局部北单位向量(由 _computeLocalFrame 计算)。
 * @param eastVec  局部东单位向量。
 * @param aSqr     semiMinorAxis²(注意:Cesium 命名反直觉,本期保留)。
 * @param ab       semiMajorAxis · semiMinorAxis(圆形 = r²)。
 * @param bSqr     semiMajorAxis²(命名同上,反直觉但保留)。
 * @param mag      |center|(center 到地心距离,米)。
 * @param unitPos  center / mag(单位中心向量)。
 * @param result   输出 ECEF 位置。
 * @returns        result。
 */
function _pointOnEllipsoid(
	theta: number,
	rotation: number,
	northVec: Vector3,
	eastVec: Vector3,
	aSqr: number,
	ab: number,
	bSqr: number,
	mag: number,
	unitPos: Vector3,
	result: Vector3,
): Vector3 {
	// ── 步骤 1 · rotAxis = cos(az)·east + sin(az)·north ──
	const azimuth = theta + rotation;

	// Cesium 顺序(L27-29):
	//   multiplyByScalar(eastVec, cos(az), rotAxis)
	//   multiplyByScalar(northVec, sin(az), tempVec)
	//   add(rotAxis, tempVec, rotAxis)
	_cartesianMultiplyByScalar( eastVec, Math.cos( azimuth ), _rotAxisScratch );
	_cartesianMultiplyByScalar( northVec, Math.sin( azimuth ), _tempVecScratch );
	_cartesianAdd( _rotAxisScratch, _tempVecScratch, _rotAxisScratch );

	// ── 步骤 2 · radius = ab / sqrt(bSqr·cos² + aSqr·sin²) ──
	// Cesium L31-38:cos/sin 各调一次后乘自己,**不能改为 Math.pow**。
	let cosThetaSquared = Math.cos( theta );
	cosThetaSquared = cosThetaSquared * cosThetaSquared;

	let sinThetaSquared = Math.sin( theta );
	sinThetaSquared = sinThetaSquared * sinThetaSquared;

	const radius = ab / Math.sqrt(
		bSqr * cosThetaSquared + aSqr * sinThetaSquared,
	);

	// ── 步骤 3 · angle = radius / mag ──
	const angle = radius / mag;

	// ── 步骤 4 · quaternion → matrix → multiplyByVector ──
	_quaternionFromAxisAngle( _rotAxisScratch, angle, _unitQuatScratch );
	_matrix3FromQuaternion( _unitQuatScratch, _rotMtxStorage );
	_matrix3MultiplyByVector( _rotMtxStorage, unitPos, result );

	// ── 步骤 5 · normalize(result) · mag ──
	_cartesianNormalize( result, result );
	_cartesianMultiplyByScalar( result, mag, result );
	return result;
}

/**
 * Circle fill 网格 + 外圈点的返回结构。
 *
 * 注意 Cesium 原版 `computeEllipsePositions` 返回 `new Array(...)` 的
 * 标量数组,本期改用 Float64Array 以提升 V8 优化与内存效率。
 * **数值上完全一致**:JS Array<number> 与 Float64Array 都用 IEEE-754
 * Float64 存储,写入读取无差异。
 */
export interface CircleFillResult {
	/**
	 * Fill 网格扁平 ECEF 顶点数组,长度 = numPts × (numPts + 2) × 2 × 3。
	 *
	 * 排列:4 region 顺序(北顶点 → 东半 → 西半 → 南顶点),每个 region
	 * 内按 ring 0..numPts 顺序写入 (position, interior×(2i), reflected)。
	 */
	positions: Float64Array;

	/**
	 * 外圈点扁平 ECEF 数组,长度 = numPts × 4 × 3。
	 *
	 * 写入策略:左半数组(outerLeftIndex 递增)= 反射点(西半,北→南),
	 * 右半数组(outerRightIndex 递减,所以每点先写 z 后 y 后 x)= 原点
	 *(东半,南→北)。最终整数组绕圆一圈(西半北→西半南→东半南→东半北)。
	 */
	outerPositions: Float64Array;

	/** 校正后的第一象限环数(可能因 if-branch 比初始 numPts 小)。 */
	numPts: number;
}

/**
 * 计算 Circle fill 网格 + 外圈点。
 *
 * 复刻 Cesium `EllipseGeometryLibrary.computeEllipsePositions(options, true, true)`,
 * 圆形特化 `semiMajorAxis = semiMinorAxis = radius`。
 *
 * 4 region 遍历:
 *   - Region 1:最北顶点(theta = π/2),写 1 个 fill + 1 个 outer
 *   - Region 2:东半象限主循环(i = 1..numPts),每 i 写 (2i+2) 个 fill +
 *               2 个 outer(原点 + 反射点)
 *   - Region 3:西半象限主循环(i = numPts..2,反向),每 i 写 (2(i-1)+2)
 *               个 fill + 2 个 outer
 *   - Region 4:最南顶点(theta = -π/2),写 1 个 fill + 1 个 outer
 *
 * 字节级关键(R2/R4):
 *   - `granularity × 8.0` 因子在函数内部应用(Cesium L127)
 *   - if (theta < 0) numPts 减少分支必须保留(Cesium L145-147)
 *   - lerp 路径必须用 `start + (end − start) · t`(R5,见 _cartesianLerp 注释)
 *   - outerPositions 写入顺序:左半递增、右半递减(Cesium L171-176)
 *
 * @param center      已 scaleToGeodeticSurface 的 center ECEF。
 * @param radius      圆半径,米(> 0)。
 * @param granularity caller 原始 granularity 弧度(未 × 8;函数内部自动放大)。
 * @param rotation    stRotation 弧度(默认 0)。
 * @returns           fill + outer + numPts 三元组。
 */
export function computeCircleFillPositions(
	center: Vector3,
	radius: number,
	granularity: number,
	rotation: number,
): CircleFillResult {
	// ============================================================
	// 6.3.1 · 准备阶段(逐字 Cesium L118-138)
	// ============================================================
	const semiMinorAxis = radius;
	const semiMajorAxis = radius;

	// R4 · ×8 因子:Cesium 注释 L123-126 说明这是为了让弧长匹配椭圆而非
	// 球面。本期严格保留,**caller 传入的 granularity 是"原始值"**。
	const internalGranularity = granularity * 8.0;

	const aSqr = semiMinorAxis * semiMinorAxis;
	const bSqr = semiMajorAxis * semiMajorAxis;
	const ab = semiMajorAxis * semiMinorAxis;

	// mag = |center|(Cesium Cartesian3.magnitude)
	const mag = Math.sqrt(
		center.x * center.x +
		center.y * center.y +
		center.z * center.z,
	);

	// ── 局部基(详见 doc 03 节)──
	// unitPos = center / mag(Cesium normalize 路径)
	const unitPos = _cartesianNormalize( center, _unitPosScratch );

	// eastVec = normalize(UNIT_Z × center)
	// 用 Cesium Cartesian3.cross 严格复刻,而非 Three.js Vector3.crossVectors —
	// 两者公式相同但通过手写函数避免未来 Three.js 重构改变浮点路径。
	let eastVec = _cartesianCross( _UNIT_Z as unknown as Vector3, center, _eastVecScratch );
	eastVec = _cartesianNormalize( eastVec, eastVec );

	// northVec = unitPos × eastVec
	// 因 unitPos 与 eastVec 都是单位向量且正交,叉积本身就是单位向量
	// —— Cesium 不再调用 normalize,本期同行为。
	const northVec = _cartesianCross( unitPos, eastVec, _northVecScratch );

	// ============================================================
	// 6.3.2 · numPts 计算 + if-branch 兜底(逐字 Cesium L141-147)
	// ============================================================
	let numPts = 1 + Math.ceil(
		( Math.PI / 2.0 ) / internalGranularity,
	);

	const deltaTheta = ( Math.PI / 2.0 ) / ( numPts - 1 );
	let theta = ( Math.PI / 2.0 ) - numPts * deltaTheta;
	if ( theta < 0.0 ) {
		// 越过南极的兜底(R2)。圆形大部分输入不触发,但必须保留以
		// 复刻 Cesium 行为(某些 granularity 输入会触发)。
		numPts -= Math.ceil( Math.abs( theta ) / deltaTheta );
	}

	// ============================================================
	// 6.3.3 · 缓冲区分配(逐字 Cesium L165-176)
	// ============================================================
	// size = 2 × numPts × (numPts + 2):fill 顶点总数。
	const size = 2 * ( numPts * ( numPts + 2 ) );
	const positions = new Float64Array( size * 3 );

	const outerPositionsLength = numPts * 4 * 3;
	let outerRightIndex = outerPositionsLength - 1;
	let outerLeftIndex = 0;
	const outerPositions = new Float64Array( outerPositionsLength );

	let positionIndex = 0;
	let position = _scratchCartesian1;
	let reflectedPosition = _scratchCartesian2;

	let i: number;
	let j: number;
	let numInterior: number;
	let t: number;
	let interiorPosition: Vector3;

	// ============================================================
	// 6.3.4 · Region 1:最北顶点(逐字 Cesium L185-208)
	// ============================================================
	theta = Math.PI / 2.0;
	position = _pointOnEllipsoid(
		theta, rotation,
		northVec, eastVec,
		aSqr, ab, bSqr,
		mag, unitPos, position,
	);

	// fill 写入(addFillPositions = true)
	positions[ positionIndex++ ] = position.x;
	positions[ positionIndex++ ] = position.y;
	positions[ positionIndex++ ] = position.z;

	// outer 写入:递减索引,所以先 z 后 y 后 x;实际数组内存中
	// 仍是 (x, y, z) 三联(因为 outerRightIndex 递减 3 次,
	// 第一次写最高地址 = z,然后 y,然后 x)。
	outerPositions[ outerRightIndex-- ] = position.z;
	outerPositions[ outerRightIndex-- ] = position.y;
	outerPositions[ outerRightIndex-- ] = position.x;

	// 为 Region 2 第一次循环预设 theta:π/2 - deltaTheta
	theta = ( Math.PI / 2.0 ) - deltaTheta;

	// ============================================================
	// 6.3.5 · Region 2:东半象限主循环(逐字 Cesium L209-269)
	// ============================================================
	for ( i = 1; i < numPts + 1; ++i ) {
		position = _pointOnEllipsoid(
			theta, rotation,
			northVec, eastVec,
			aSqr, ab, bSqr,
			mag, unitPos, position,
		);
		reflectedPosition = _pointOnEllipsoid(
			Math.PI - theta, rotation,
			northVec, eastVec,
			aSqr, ab, bSqr,
			mag, unitPos, reflectedPosition,
		);

		// fill 写入:position → 内插 ×(numInterior-2) → reflectedPosition
		positions[ positionIndex++ ] = position.x;
		positions[ positionIndex++ ] = position.y;
		positions[ positionIndex++ ] = position.z;

		// 关键:东半 numInterior = 2 × i + 2,西半是 2 × (i-1) + 2(R2)
		numInterior = 2 * i + 2;
		for ( j = 1; j < numInterior - 1; ++j ) {
			t = j / ( numInterior - 1 );
			interiorPosition = _cartesianLerp(
				position, reflectedPosition, t, _scratchCartesian3,
			);
			positions[ positionIndex++ ] = interiorPosition.x;
			positions[ positionIndex++ ] = interiorPosition.y;
			positions[ positionIndex++ ] = interiorPosition.z;
		}

		positions[ positionIndex++ ] = reflectedPosition.x;
		positions[ positionIndex++ ] = reflectedPosition.y;
		positions[ positionIndex++ ] = reflectedPosition.z;

		// outer 写入:position → 右半(递减),reflectedPosition → 左半(递增)
		outerPositions[ outerRightIndex-- ] = position.z;
		outerPositions[ outerRightIndex-- ] = position.y;
		outerPositions[ outerRightIndex-- ] = position.x;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.x;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.y;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.z;

		// 更新 theta 用 (i+1):为下一次循环预设,Cesium 同序。
		theta = ( Math.PI / 2.0 ) - ( i + 1 ) * deltaTheta;
	}

	// ============================================================
	// 6.3.6 · Region 3:西半象限主循环(逐字 Cesium L272-332)
	// ============================================================
	for ( i = numPts; i > 1; --i ) {
		// 西半 theta 在循环开头预设(Region 2 是末尾更新,这里是开头)
		theta = ( Math.PI / 2.0 ) - ( i - 1 ) * deltaTheta;

		// position 用 -theta(南半象限);reflectedPosition 用 theta + π
		position = _pointOnEllipsoid(
			-theta, rotation,
			northVec, eastVec,
			aSqr, ab, bSqr,
			mag, unitPos, position,
		);
		reflectedPosition = _pointOnEllipsoid(
			theta + Math.PI, rotation,
			northVec, eastVec,
			aSqr, ab, bSqr,
			mag, unitPos, reflectedPosition,
		);

		positions[ positionIndex++ ] = position.x;
		positions[ positionIndex++ ] = position.y;
		positions[ positionIndex++ ] = position.z;

		// 关键:西半 numInterior = 2 × (i - 1) + 2(与东半 2i+2 不同)
		numInterior = 2 * ( i - 1 ) + 2;
		for ( j = 1; j < numInterior - 1; ++j ) {
			t = j / ( numInterior - 1 );
			interiorPosition = _cartesianLerp(
				position, reflectedPosition, t, _scratchCartesian3,
			);
			positions[ positionIndex++ ] = interiorPosition.x;
			positions[ positionIndex++ ] = interiorPosition.y;
			positions[ positionIndex++ ] = interiorPosition.z;
		}

		positions[ positionIndex++ ] = reflectedPosition.x;
		positions[ positionIndex++ ] = reflectedPosition.y;
		positions[ positionIndex++ ] = reflectedPosition.z;

		outerPositions[ outerRightIndex-- ] = position.z;
		outerPositions[ outerRightIndex-- ] = position.y;
		outerPositions[ outerRightIndex-- ] = position.x;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.x;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.y;
		outerPositions[ outerLeftIndex++ ] = reflectedPosition.z;
	}

	// ============================================================
	// 6.3.7 · Region 4:最南顶点(逐字 Cesium L334-362)
	// ============================================================
	theta = Math.PI / 2.0;
	position = _pointOnEllipsoid(
		-theta, rotation,
		northVec, eastVec,
		aSqr, ab, bSqr,
		mag, unitPos, position,
	);

	positions[ positionIndex++ ] = position.x;
	positions[ positionIndex++ ] = position.y;
	positions[ positionIndex++ ] = position.z;

	outerPositions[ outerRightIndex-- ] = position.z;
	outerPositions[ outerRightIndex-- ] = position.y;
	outerPositions[ outerRightIndex-- ] = position.x;

	return {
		positions,
		outerPositions,
		numPts,
	};
}
