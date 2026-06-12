// ============================================================
// ellipsoid-depth-source.ts
// 层级:Cesium-to-Three 贴地深度兜底层（无地形渲染保障）。
// 职责:在“没有地形瓦片覆盖”的屏幕区域，向贴地 classification 管线依赖的两份
//      深度表示同时写入一个 WGS84 椭球面（海平面）兜底深度，从而让所有贴地
//      标绘类型（point / circle / sector / polygon / rectangle / arrow / line）
//      在没有地形（无 Ion Token、瓦片仍在下载、缩放超过最深 LOD）时依然能渲染。
//      两份深度表示：
//        1. 主帧缓冲深度（gl_FragDepth，log-depth 空间）—— 供 stencil shadow
//           volume 的 Z-fail 深度测试（depthFunc = LESS_OR_EQUAL）比对。
//        2. packed globe depth 纹理（czm_globeDepthTexture）—— 供 color pass
//           重建眼坐标 + CULL_FRAGMENTS（depth==0 处 discard）。
//      二者缺一不可：缺主缓冲兜底 → stencil 记不到值；缺 packed 兜底 → color
//      pass 读到空深度被整段 discard。本模块把这两个兜底网格打包成一个可复用、
//      自管理的单元。
//
// Cesium 源码参照（packages/engine/Source/Scene/DepthPlane.js）:
//   Cesium 永远不存在“无地形”——它的 Globe 至少渲染一个平滑椭球面
//   （EllipsoidTerrainProvider），并额外渲染一个 DepthPlane：一块“只写深度、
//   不写色”（colorMask 全关）、朝向相机、贴合椭球“天际线（limb）”的切平面四边形，
//   在 globe depth 清屏后立即执行（Scene.js: depthPlane.execute），保证即使瓦片
//   缺失或在天际线附近，globe depth 也始终有有效深度。它的 FS（DepthPlaneFS.glsl）
//   用 czm_rayEllipsoidIntersectionInterval 把四边形裁剪到真实椭球轮廓，并用
//   czm_writeLogDepth() 写 log 深度；并暴露 depthPlaneEllipsoidOffset 把平面压到
//   海平面以下以避免与地形 z-fighting。
//
//   本移植与 Cesium 的两点差异及理由：
//     A. 几何用“完整 WGS84 椭球球面”而非 Cesium 的“天际线切平面四边形”。
//        原因:Cesium 的切平面是“天际线圆所在平面”，其深度在“相机正下方点”处
//        与真实椭球面相差最大（高轨可达数百 km）。Cesium 能接受这种近似是因为
//        相机正下方区域总有地形瓦片覆盖并写入精确深度，切平面只在天际线附近
//        （误差→0）与瓦片缺口处起作用。但本项目的核心诉求恰恰是“完全没有地形”
//        时（用户俯视标绘，正处于相机正下方）的渲染，切平面在此处最不准。完整
//        椭球球面在可见半球上逐像素给出精确椭球深度，是无地形场景的正确选择。
//        Cesium 的天际线四边形几何作为可选工具函数保留见
//        {@link computeEllipsoidLimbQuadPositions}（忠实移植 computeDepthQuad）。
//     B. 主缓冲兜底材质写 log 深度（czm log-depth），而非朴素 NDC 深度。
//        原因:开启 LOG_DEPTH 后，瓦片（applyCesiumLogDepthToMaterial）、stencil
//        与 color pass（czm_writeLogDepth）全部在 log 空间写主缓冲深度；若兜底
//        网格写 NDC 深度，stencil 的 LESS_OR_EQUAL 会在不同深度空间间误判，
//        Z-fail 记不到值 → 无地形时标绘依然消失。这与 Cesium DepthPlaneFS 调用
//        czm_writeLogDepth() 的行为一致。
//
// 依赖:Three.js 几何/材质、./constants（WGS84 半径）、./materials（packed depth
//      材质，保证 packed 兜底与瓦片同编码）、./depth（CesiumGlobeDepth 类型）。
// 被消费:demo/plot-demo.ts、lib/plot/GroundDecalManager.ts（可选一行接入），
//        以及任何复用贴地 classification 管线的外部宿主。
// ============================================================

import {
	GLSL3,
	Mesh,
	type Object3D,
	type PerspectiveCamera,
	RawShaderMaterial,
	type Scene,
	SphereGeometry,
} from 'three';

import {
	WGS84_X_RADIUS,
	WGS84_Y_RADIUS,
	WGS84_Z_RADIUS,
} from './constants';
import type { CesiumGlobeDepth } from './depth';
import { createPackDepthMaterial } from './materials';
import {
	terrainLogDepthUniforms,
	updateTerrainLogDepthUniforms,
} from './terrain-log-depth';

/**
 * 椭球三轴半径（米）。默认取 WGS84。
 */
export interface EllipsoidRadii {
	/** X 轴半长轴（米）。 */
	x: number;
	/** Y 轴半长轴（米）。 */
	y: number;
	/** Z 轴半短轴（米）。 */
	z: number;
}

/** 默认 WGS84 椭球半径常量（避免每次 new 时重复字面量）。 */
const DEFAULT_WGS84_RADII: Readonly<EllipsoidRadii> = {
	x: WGS84_X_RADIUS, // 6378137.0
	y: WGS84_Y_RADIUS, // 6378137.0
	z: WGS84_Z_RADIUS, // 6356752.3142451793
};

/** 构造 {@link EllipsoidDepthSource} 的选项。 */
export interface EllipsoidDepthSourceOptions {
	/**
	 * 椭球球面经度方向分段数。越高越平滑、越贴合真实椭球。默认 192。
	 * 高分段主要影响几何在天际线处的平滑度；192×96 即可让 14000 km 视高下的
	 * 天际线无可见多边形棱角。
	 */
	widthSegments?: number;
	/** 椭球球面纬度方向分段数。默认 96。 */
	heightSegments?: number;
	/**
	 * 椭球半径偏移（米），等价于 Cesium DepthPlane 的 `depthPlaneEllipsoidOffset`。
	 * 正值把兜底面抬高、负值压低。典型用法:取一个小负值（如 -100）把兜底面压到
	 * 海平面以下，避免在“海平面附近有真实地形”时兜底面与地形 z-fighting。
	 * 默认 0（兜底面正好落在 WGS84 椭球面 / 海平面）。
	 */
	ellipsoidOffset?: number;
	/** 椭球三轴半径（米）。默认 WGS84。 */
	radii?: Partial<EllipsoidRadii>;
}

/** 把椭球面网格挂接到宿主渲染管线时所需的两个目标。 */
export interface EllipsoidDepthAttachTarget {
	/**
	 * 主场景（或其下任意容器对象）。兜底主深度网格会被加入此处，
	 * 在主帧缓冲渲染时为 stencil Z-fail 提供深度。
	 */
	mainScene: Scene | Object3D;
	/**
	 * packed globe depth 通道。兜底 packed 深度网格会通过
	 * {@link CesiumGlobeDepth.addDepthMesh} 注入其私有场景，
	 * 在 packed 深度纹理里为 color pass 提供深度。
	 */
	globeDepth: CesiumGlobeDepth;
}

/**
 * 创建“主帧缓冲兜底深度材质”。
 *
 * 与 ./terrain-log-depth.ts 注入瓦片材质的 `TERRAIN_FRAGMENT_WRITE` 同口径:
 * 顶点阶段算出 Cesium 的 `depthFromNearPlusOne`（线性于裁剪空间 w），片元阶段
 * 把它映射到 `log2(depth) / log2(farDepthFromNearPlusOne)` 写入 gl_FragDepth。
 * 这保证兜底椭球面与真实地形瓦片落在“同一 log 深度空间”，stencil 的
 * LESS_OR_EQUAL Z-fail 才能正确比对（见文件头“差异 B”）。
 *
 * 该材质 colorWrite 关闭——它只为深度缓冲服务，不产生任何颜色。out_FragColor
 * 仍需声明并写入（GLSL3 片元着色器要求有输出），但会被 colorWrite=false 屏蔽。
 *
 * 该材质复用 ./terrain-log-depth.ts 的【共享】log-depth uniform 对象引用:瓦片材质
 * （applyCesiumLogDepthToMaterial）用的就是这同一组 {value} 容器，宿主每帧调用
 * updateTerrainLogDepthUniforms（或本源 update()）刷新一次即同步到所有引用方。
 * 这样兜底椭球面与瓦片【逐字节】落在同一 log 深度空间，零漂移风险。
 *
 * @returns 配置好的主缓冲兜底深度 RawShaderMaterial。
 */
function createEllipsoidMainDepthMaterial(): RawShaderMaterial {
	const material = new RawShaderMaterial( {
		glslVersion: GLSL3,
		// 直接引用共享 uniform 对象（不是拷贝值），与瓦片材质共用同一组容器。
		uniforms: {
			// (near, far, 0)；仅用到 .x = near。
			czm_currentFrustum: terrainLogDepthUniforms.czm_currentFrustum,
			// (far - near) + 1。
			czm_farDepthFromNearPlusOne: terrainLogDepthUniforms.czm_farDepthFromNearPlusOne,
			// 1 / log2((far - near) + 1)，预除避免片元里每像素再做一次 log2 + 除法。
			czm_oneOverLog2FarDepthFromNearPlusOne:
				terrainLogDepthUniforms.czm_oneOverLog2FarDepthFromNearPlusOne,
		},
		vertexShader: /* glsl */ `
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
// czm_currentFrustum.x = near 裁剪面（米）。
uniform vec3 czm_currentFrustum;

in vec3 position;

// Cesium log-depth:把“距近平面的线性深度 + 1”传到片元做 log 编码。
out float v_depthFromNearPlusOne;

void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

	// depthFromNearPlusOne = (w - near) + 1。+1 保证 log2 的输入恒 >= 1（log2(1)=0）。
	v_depthFromNearPlusOne = ( gl_Position.w - czm_currentFrustum.x ) + 1.0;

	// 把裁剪空间 z 钳到 [-w, w]（即 NDC z ∈ [-1,1]），避免几何因后续 gl_FragDepth
	// 改写而被硬件 near/far 裁剪掉。真正的深度值在片元阶段由 v_depthFromNearPlusOne
	// 决定，这里的 z 只用于光栅化阶段不被裁剪。
	gl_Position.z = clamp( gl_Position.z / gl_Position.w, - 1.0, 1.0 ) * gl_Position.w;
}
`,
		fragmentShader: /* glsl */ `
precision highp float;
precision highp int;

uniform float czm_farDepthFromNearPlusOne;
uniform float czm_oneOverLog2FarDepthFromNearPlusOne;

in float v_depthFromNearPlusOne;

// colorWrite=false 会屏蔽颜色输出，但 GLSL3 片元着色器仍需声明一个输出变量。
out vec4 out_FragColor;

void main() {
	float depth = v_depthFromNearPlusOne;

	// 与 terrain-log-depth.ts 的 TERRAIN_FRAGMENT_WRITE 完全一致:
	// 近平面外（depth<=1，即 w<=near）写 0；远平面外写 1；区间内写 log 深度。
	// 这里用 clamp 语义（写 0/1）而非 discard，让兜底椭球面在近/远边界处仍能
	// 占据深度，从而正确遮挡。
	if ( depth <= 1.0 ) {
		gl_FragDepth = 0.0;
	} else if ( depth > czm_farDepthFromNearPlusOne ) {
		gl_FragDepth = 1.0;
	} else {
		gl_FragDepth = log2( depth ) * czm_oneOverLog2FarDepthFromNearPlusOne;
	}

	// 颜色被 colorWrite=false 屏蔽，此处写入仅为满足 GLSL3 片元输出要求。
	out_FragColor = vec4( 0.0 );
}
`,
		// 只写深度，不写颜色——兜底层不能污染最终画面。
		colorWrite: false,
		depthWrite: true,
		depthTest: true,
		toneMapped: false,
	} );
	material.name = 'EllipsoidFallbackMainDepthMaterial';
	return material;
}

// ── computeEllipsoidLimbQuadPositions 的标量 scratch（零 GC）──
// 全部为模块级单例:本函数非可重入（与 Cesium DepthPlane 的 scratch 用法一致），
// 多次调用必须串行（每帧一次，天然满足）。
const limbScratch = {
	// 相机在“椭球缩放空间”（每轴除以半径）中的位置 q。
	qx: 0.0, qy: 0.0, qz: 0.0,
	// q 的单位向量。
	qux: 0.0, quy: 0.0, quz: 0.0,
	// 该处的东(e)、北(n)单位向量。
	ex: 0.0, ey: 0.0, ez: 0.0,
	nx: 0.0, ny: 0.0, nz: 0.0,
	// 四边形中心（缩放空间）。
	cx: 0.0, cy: 0.0, cz: 0.0,
};

/**
 * 忠实移植 Cesium `DepthPlane.computeDepthQuad`（透视分支 / SCENE3D）。
 *
 * 计算一块朝向相机、贴合椭球“天际线（limb）圆所在平面”的四边形顶点，输出
 * 4 个顶点 × 3 分量（米，ECEF/世界系）到 `out`，顺序为
 * 上左(0..2)、下左(3..5)、上右(6..8)、下右(9..11)，配合索引 [0,1,2, 2,1,3]
 * 组成两个三角形（与 Cesium DepthPlane.update 一致）。
 *
 * 算法（与 Cesium 逐字对应）:
 *   1. 把相机位置 p 变换到“椭球缩放空间” q = p * (1/radii)，此空间下椭球是单位球。
 *   2. qMagnitude = |q|；天际线圆在缩放空间的半径 wMagnitude = sqrt(qMag² - 1)
 *      （相机到单位球切点构成的圆）。
 *   3. 中心 center = qUnit / qMagnitude（天际线平面与视线方向的交点，缩放空间）。
 *   4. 东/北 = 由 Z 轴与 q 叉乘得到的该点切向。
 *   5. 四角 = center ± (东/北)·(wMagnitude/qMagnitude)，再乘回 radii 变换回真实空间。
 *
 * 用途说明:本模块的 {@link EllipsoidDepthSource} 默认使用“完整椭球球面”几何
 * （见文件头“差异 A”），不调用本函数。本函数作为公开工具忠实保留 Cesium 的
 * 天际线四边形几何，供需要“最小三角形数量兜底面”的高级宿主自行构建深度平面
 * （需自行配合写深度材质与 packed 通道；注意切平面深度在相机正下方点不精确，
 * 仅适合“通常有地形覆盖”的场景）。
 *
 * @param camPosX 相机世界坐标 X（米，ECEF）。
 * @param camPosY 相机世界坐标 Y（米，ECEF）。
 * @param camPosZ 相机世界坐标 Z（米，ECEF）。
 * @param radii   椭球三轴半径（米）。
 * @param ellipsoidOffset 椭球半径偏移（米），与 Cesium depthPlaneEllipsoidOffset 一致。
 * @param out     长度 >= 12 的 Float32Array 输出缓冲（顶点位置，米）。
 * @returns       是否成功（相机在椭球内部 / 在面上时 qMag<=1，无天际线，返回 false 且不写 out）。
 */
export function computeEllipsoidLimbQuadPositions(
	camPosX: number,
	camPosY: number,
	camPosZ: number,
	radii: EllipsoidRadii,
	ellipsoidOffset: number,
	out: Float32Array,
): boolean {
	// 偏移后的三轴半径。
	const rx = radii.x + ellipsoidOffset;
	const ry = radii.y + ellipsoidOffset;
	const rz = radii.z + ellipsoidOffset;

	// (1) q = p * oneOverRadii —— 相机在缩放空间的位置。
	limbScratch.qx = camPosX / rx;
	limbScratch.qy = camPosY / ry;
	limbScratch.qz = camPosZ / rz;

	const qMag = Math.sqrt(
		limbScratch.qx * limbScratch.qx +
		limbScratch.qy * limbScratch.qy +
		limbScratch.qz * limbScratch.qz,
	);

	// 相机不在椭球外部（qMag<=1）时没有有效天际线（看不到完整圆盘轮廓）。
	if ( ! ( qMag > 1.0 ) ) {
		return false;
	}

	// qUnit = q / |q|。
	const invQMag = 1.0 / qMag;
	limbScratch.qux = limbScratch.qx * invQMag;
	limbScratch.quy = limbScratch.qy * invQMag;
	limbScratch.quz = limbScratch.qz * invQMag;

	// (4) 东 eUnit = normalize(UNIT_Z × q)。UNIT_Z=(0,0,1)，叉乘 = (-q.y, q.x, 0)。
	let ex = - limbScratch.qy;
	let ey = limbScratch.qx;
	let ez = 0.0;
	let eLen = Math.sqrt( ex * ex + ey * ey + ez * ez );
	// 退化保护:相机正好在极轴上时 (q.x,q.y)=0，东向不定，取 X 轴兜底。
	if ( eLen < 1.0e-12 ) {
		ex = 1.0; ey = 0.0; ez = 0.0; eLen = 1.0;
	}
	const invELen = 1.0 / eLen;
	limbScratch.ex = ex * invELen;
	limbScratch.ey = ey * invELen;
	limbScratch.ez = ez * invELen;

	// 北 nUnit = normalize(qUnit × eUnit)。
	const nx = limbScratch.quy * limbScratch.ez - limbScratch.quz * limbScratch.ey;
	const ny = limbScratch.quz * limbScratch.ex - limbScratch.qux * limbScratch.ez;
	const nz = limbScratch.qux * limbScratch.ey - limbScratch.quy * limbScratch.ex;
	const nLen = Math.sqrt( nx * nx + ny * ny + nz * nz ) || 1.0;
	const invNLen = 1.0 / nLen;
	limbScratch.nx = nx * invNLen;
	limbScratch.ny = ny * invNLen;
	limbScratch.nz = nz * invNLen;

	// (2) 天际线圆半径（缩放空间）:wMag = sqrt(qMag² - 1)。
	const wMag = Math.sqrt( qMag * qMag - 1.0 );
	// (3) 中心（缩放空间）= qUnit / qMag。
	limbScratch.cx = limbScratch.qux * invQMag;
	limbScratch.cy = limbScratch.quy * invQMag;
	limbScratch.cz = limbScratch.quz * invQMag;

	// 偏移标量 = wMag / qMag（缩放空间下四边形半边长）。
	const scalar = wMag * invQMag;

	// 上左 = (center + north - east) * radii。
	out[ 0 ] = ( limbScratch.cx + limbScratch.nx * scalar - limbScratch.ex * scalar ) * rx;
	out[ 1 ] = ( limbScratch.cy + limbScratch.ny * scalar - limbScratch.ey * scalar ) * ry;
	out[ 2 ] = ( limbScratch.cz + limbScratch.nz * scalar - limbScratch.ez * scalar ) * rz;

	// 下左 = (center - north - east) * radii。
	out[ 3 ] = ( limbScratch.cx - limbScratch.nx * scalar - limbScratch.ex * scalar ) * rx;
	out[ 4 ] = ( limbScratch.cy - limbScratch.ny * scalar - limbScratch.ey * scalar ) * ry;
	out[ 5 ] = ( limbScratch.cz - limbScratch.nz * scalar - limbScratch.ez * scalar ) * rz;

	// 上右 = (center + north + east) * radii。
	out[ 6 ] = ( limbScratch.cx + limbScratch.nx * scalar + limbScratch.ex * scalar ) * rx;
	out[ 7 ] = ( limbScratch.cy + limbScratch.ny * scalar + limbScratch.ey * scalar ) * ry;
	out[ 8 ] = ( limbScratch.cz + limbScratch.nz * scalar + limbScratch.ez * scalar ) * rz;

	// 下右 = (center - north + east) * radii。
	out[ 9 ] = ( limbScratch.cx - limbScratch.nx * scalar + limbScratch.ex * scalar ) * rx;
	out[ 10 ] = ( limbScratch.cy - limbScratch.ny * scalar + limbScratch.ey * scalar ) * ry;
	out[ 11 ] = ( limbScratch.cz - limbScratch.nz * scalar + limbScratch.ez * scalar ) * rz;

	return true;
}

/**
 * WGS84 椭球面贴地深度兜底源。
 *
 * 一次 {@link attach} 即把两个兜底网格分别挂到主场景与 packed globe depth 通道，
 * 此后每帧 {@link update} 同步 log-depth uniform。它让“贴地标绘能否渲染”与
 * “地形瓦片是否加载”彻底解耦:有地形时瓦片更近，凭 LESS_OR_EQUAL 覆盖椭球面，
 * 不影响既有效果;无地形时标绘精确贴到 WGS84 椭球面（海平面）。
 *
 * 用法（宿主渲染循环）:
 * ```ts
 * const depthSource = new EllipsoidDepthSource();
 * depthSource.attach( { mainScene: scene, globeDepth } );
 * // 每帧（在 globeDepth.render 之前更新 uniform）:
 * depthSource.update( camera );
 * globeDepth.render( renderer, camera, scene, tilesRenderer.group );
 * // ... renderer.render( scene, camera );
 * ```
 */
export class EllipsoidDepthSource {

	/**
	 * 主帧缓冲兜底网格（renderOrder = -10000，只写深度不写色）。
	 * 应加入“宿主渲染 renderer.render(scene) 的那个场景”，为 stencil Z-fail 兜底。
	 */
	public readonly mainDepthMesh: Mesh;

	/**
	 * packed 深度纹理兜底网格。应通过 globeDepth.addDepthMesh 注入其私有场景，
	 * 为 color pass 的 CULL_FRAGMENTS / EC 重建兜底。其材质在 packed 通道里会被
	 * CesiumGlobeDepth 的 overrideMaterial 覆盖，故此处材质仅占位。
	 */
	public readonly packedDepthMesh: Mesh;

	/** 主缓冲兜底材质（持有自己的 log-depth uniform）。 */
	private readonly mainDepthMaterial: RawShaderMaterial;

	/** 椭球三轴半径（米，未含 offset）。 */
	private readonly radii: EllipsoidRadii;

	/** 当前椭球半径偏移（米）。 */
	private ellipsoidOffset: number;

	/** 已挂接的主场景（detach 时用）。 */
	private attachedMainScene: ( Scene | Object3D ) | null = null;

	/** 已挂接的 packed 深度通道（detach 时用）。 */
	private attachedGlobeDepth: CesiumGlobeDepth | null = null;

	/** 是否已释放。 */
	private disposed = false;

	/**
	 * @param options 构造选项（分段数 / 半径 / 偏移），均可缺省。
	 */
	public constructor( options: EllipsoidDepthSourceOptions = {} ) {
		const widthSegments = options.widthSegments ?? 192;
		const heightSegments = options.heightSegments ?? 96;
		this.ellipsoidOffset = options.ellipsoidOffset ?? 0.0;
		this.radii = {
			x: options.radii?.x ?? DEFAULT_WGS84_RADII.x,
			y: options.radii?.y ?? DEFAULT_WGS84_RADII.y,
			z: options.radii?.z ?? DEFAULT_WGS84_RADII.z,
		};

		// 单位球几何:绕 X 轴旋 90°，把 Three 默认“Y 轴为极轴”改成“Z 轴为极轴”，
		// 与 WGS84/ECEF 约定一致（与 createCesiumEllipsoidDepthMeshes 同口径）。
		// 半径通过 mesh.scale 施加（见 applyScale），便于 setEllipsoidOffset 时
		// 只改 scale、无需重建几何。
		const geometry = new SphereGeometry( 1.0, widthSegments, heightSegments );
		geometry.rotateX( Math.PI * 0.5 );
		geometry.computeBoundingSphere();

		this.mainDepthMaterial = createEllipsoidMainDepthMaterial();

		this.mainDepthMesh = new Mesh( geometry, this.mainDepthMaterial );
		this.mainDepthMesh.name = 'EllipsoidFallbackMainDepthMesh';
		// 先于地形（renderOrder 0）渲染:有地形处地形凭 LESS_OR_EQUAL 覆盖椭球面。
		this.mainDepthMesh.renderOrder = -10000;
		// 兜底面始终需要参与深度，不能被视锥剔除（它本来就横跨整个可见半球）。
		this.mainDepthMesh.frustumCulled = false;

		// packed 网格用独立几何克隆（dispose 各自独立），材质用项目既有的 packed
		// depth 材质——在 packed 通道里会被 globeDepth.overrideMaterial 覆盖，
		// 这里赋值仅为让网格自洽（材质与瓦片同编码，零编码风险）。
		this.packedDepthMesh = new Mesh( geometry.clone(), createPackDepthMaterial() );
		this.packedDepthMesh.name = 'EllipsoidFallbackPackedDepthMesh';
		this.packedDepthMesh.frustumCulled = false;

		this.applyScale();
	}

	/**
	 * 把当前 ellipsoidOffset 体现的三轴半径写到两个网格的 scale 上。
	 * 用 Object3D.scale 而非烘焙到几何,这样 {@link setEllipsoidOffset} 只需重设
	 * scale,无需重建/重新上传几何。
	 */
	private applyScale(): void {
		const sx = this.radii.x + this.ellipsoidOffset;
		const sy = this.radii.y + this.ellipsoidOffset;
		const sz = this.radii.z + this.ellipsoidOffset;
		this.mainDepthMesh.scale.set( sx, sy, sz );
		this.mainDepthMesh.updateMatrix();
		this.mainDepthMesh.updateMatrixWorld( true );
		this.packedDepthMesh.scale.set( sx, sy, sz );
		this.packedDepthMesh.updateMatrix();
		this.packedDepthMesh.updateMatrixWorld( true );
	}

	/**
	 * 把两个兜底网格挂接到宿主渲染管线。重复调用前会先 detach 上一次的挂接。
	 *
	 * @param target 主场景 + packed 深度通道。
	 * @returns      this，便于链式调用。
	 */
	public attach( target: EllipsoidDepthAttachTarget ): this {
		if ( this.disposed ) {
			return this;
		}
		this.detach();

		target.mainScene.add( this.mainDepthMesh );
		target.globeDepth.addDepthMesh( this.packedDepthMesh );

		this.attachedMainScene = target.mainScene;
		this.attachedGlobeDepth = target.globeDepth;
		return this;
	}

	/**
	 * 从已挂接的场景/通道移除两个兜底网格（不释放 GPU 资源，可再次 attach）。
	 */
	public detach(): void {
		if ( this.attachedMainScene !== null ) {
			this.attachedMainScene.remove( this.mainDepthMesh );
			this.attachedMainScene = null;
		}
		if ( this.attachedGlobeDepth !== null ) {
			// CesiumGlobeDepth 的私有场景就是其 .scene；packed 网格当初通过
			// addDepthMesh 加入该场景，这里对称地从该场景移除。
			this.attachedGlobeDepth.scene.remove( this.packedDepthMesh );
			this.attachedGlobeDepth = null;
		}
	}

	/**
	 * 设置椭球半径偏移（米），等价 Cesium depthPlaneEllipsoidOffset。
	 *
	 * @param meters 偏移量（正抬高、负压低）。
	 */
	public setEllipsoidOffset( meters: number ): void {
		if ( ! Number.isFinite( meters ) || meters === this.ellipsoidOffset ) {
			return;
		}
		this.ellipsoidOffset = meters;
		this.applyScale();
	}

	/**
	 * 每帧调用:依据相机 near/far 刷新【共享】log-depth uniform（与瓦片同一组对象）。
	 * 即便宿主完全没有地形瓦片、从未调用过 updateTerrainLogDepthUniforms，这里也
	 * 确保兜底椭球面的 log 深度编码随相机 near/far 正确更新（这正是“纯无地形”场景的
	 * 关键）。若宿主已为瓦片调用过同一函数，此处为幂等重复（重算同值），无副作用。
	 *
	 * 球面几何本身不随相机变化（不像 Cesium 的天际线四边形需要每帧重算顶点），
	 * 故本方法只刷新 uniform。应在 renderer.render 主场景之前调用（通常也在
	 * globeDepth.render 之前，以便两份深度都用上当帧 near/far）。
	 *
	 * @param camera 当前透视相机。
	 */
	public update( camera: PerspectiveCamera ): void {
		if ( this.disposed ) {
			return;
		}
		updateTerrainLogDepthUniforms( camera.near, camera.far );
	}

	/**
	 * 释放本源持有的全部 GPU 资源（几何 + 主缓冲材质 + packed 材质），并从
	 * 已挂接的场景/通道移除网格。释放后不可再用。
	 */
	public dispose(): void {
		if ( this.disposed ) {
			return;
		}
		this.detach();

		this.mainDepthMesh.geometry.dispose();
		this.mainDepthMaterial.dispose();

		this.packedDepthMesh.geometry.dispose();
		( this.packedDepthMesh.material as RawShaderMaterial ).dispose();

		this.disposed = true;
	}
}
