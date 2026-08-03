// ============================================================
// classification.ts
// 层级:Cesium-to-Three 贴地 classification 命令组。
// 职责:把 Cesium 的 front-stencil、back-stencil、color 命令作为连续的
//      Three renderOrder 命令块执行。
// 依赖:Three.js 网格/uniform、材质桥接、几何 RTE。
// 被消费:primitives.ts。
// ============================================================

import {
	BackSide,
	BufferGeometry,
	Color,
	DecrementWrapStencilOp,
	FrontSide,
	Group,
	IncrementWrapStencilOp,
	Matrix3,
	Matrix4,
	Mesh,
	Vector2,
	Vector3,
	Vector4,
	type Material,
	type RawShaderMaterial,
	type Texture,
} from 'three';

import {
	CESIUM_GLOBE_MINIMUM_ALTITUDE,
	CESIUM_GROUND_NON_PICKABLE_LAYER,
	CESIUM_MAXIMUM_SCREEN_SPACE_ERROR,
	MAX_POLYGON_STYLE_VERTICES,
	SCENE_MODE_3D,
} from './constants';
import { encodeCesiumVector3 } from './geometry';
import { createColorMaterial, createStencilMaterial } from './materials';
import {
	CesiumGroundMaterialAppearance,
	type CesiumGroundAppearance,
} from './material/appearances';
import { createColorGroundMaterial } from './material/builtins';
import {
	compileGroundPass,
	type GroundCompiledMaterial,
} from './material/compiler';
import { createCanonicalGroundSystemUniforms } from './material/system-uniforms';
import type { GroundSystemUniforms } from './material/types';
import {
	ClassificationType,
	type CesiumClassificationCommandVisibility,
	type CesiumGroundFrameState,
	type PlanarExtents,
	type SharedUniforms,
} from './types';

/**
 * 据分类目标从帧状态中解析出该图元应采样的 packed 深度纹理。
 *
 * 这是"标绘贴模型 / 倾斜摄影"多纹理深度管线的消费端：宿主用
 * {@link ClassificationDepthManager} 渲染出 terrain / tileset / both 三张纹理后，
 * 通过 {@link CesiumGroundFrameState.classificationDepthTextures} 传入；本函数按
 * 图元自身的 {@link ClassificationType} 选对应纹理。
 *
 * 向后兼容：当宿主未提供 `classificationDepthTextures`（旧宿主 / 纯地形场景）时，
 * 一律回退到 `frameState.depthTexture` 单纹理，行为与历史完全一致。某个分类目标
 * 的纹理缺省时同样回退到单纹理，保证不会因配置不全而黑屏。
 *
 * @param frameState 当前帧状态。
 * @param classificationType 图元的分类目标（TERRAIN / CESIUM_3D_TILE / BOTH）。
 * @returns 应绑定到 `czm_globeDepthTexture` 的纹理。
 */
export function resolveClassificationDepthTexture(
	frameState: CesiumGroundFrameState,
	classificationType: ClassificationType,
): Texture | null {
	const fallback = frameState.depthTexture ?? null;
	const set = frameState.classificationDepthTextures;
	if ( set === undefined ) {
		return fallback;
	}

	switch ( classificationType ) {
		case ClassificationType.TERRAIN:
			return set.terrain ?? fallback;
		case ClassificationType.CESIUM_3D_TILE:
			return set.tileset ?? fallback;
		case ClassificationType.BOTH:
		default:
			return set.both ?? fallback;
	}
}

/**
 * 创建 Cesium 用于 window-to-eye 重建的 viewport transform。
 *
 * @param width 绘制缓冲宽度，单位物理像素。
 * @param height 绘制缓冲高度，单位物理像素。
 * @returns 等价于 Cesium viewportTransformation 的矩阵。
 */
function createViewportTransformation( width: number, height: number ): Matrix4 {
	const matrix = new Matrix4();

	matrix.set(
		width * 0.5, 0.0, 0.0, width * 0.5,
		0.0, height * 0.5, 0.0, height * 0.5,
		0.0, 0.0, 0.5, 0.5,
		0.0, 0.0, 0.0, 1.0,
	);

	return matrix;
}

// Float64 scratch buffer 在 CPU 侧保持完整 RTE 矩阵链的双精度。
// Three.js Matrix4.elements 是 Float32Array，任何经过 `multiplyMatrices` / `copy`
// 的往返都会静默丢失约 7 位有效数字。这里用 Float64Array scratch 完成数学计算，
// 最后只把 mat4 uniform 写回 Float32 Three.js Matrix4 一次。
const viewRotationFloat64 = new Float64Array( 16 );
const projectionFloat64 = new Float64Array( 16 );
const mvpFloat64 = new Float64Array( 16 );
const cpuPlaneScratch = {
	swEye: new Float64Array( 3 ),
	eastEye: new Float64Array( 3 ),
	northEye: new Float64Array( 3 ),
};

/**
 * 从 `camera.quaternion` 构建列主序、仅旋转的 Float64 view matrix。
 * 它等价于把 camera.matrixWorldInverse 的平移列清零，但避免 quaternion 转矩阵时
 * 经由 Three.js Matrix4.elements 的 Float32 往返。
 *
 * @param qx 四元数 x 分量。
 * @param qy 四元数 y 分量。
 * @param qz 四元数 z 分量。
 * @param qw 四元数 w 分量。
 * @param out Float64Array(16) 输出，列主序布局。
 */
function writeViewRotationFloat64(
	qx: number, qy: number, qz: number, qw: number,
	out: Float64Array,
): void {
	const x2 = qx + qx;
	const y2 = qy + qy;
	const z2 = qz + qz;
	const xx = qx * x2;
	const xy = qx * y2;
	const xz = qx * z2;
	const yy = qy * y2;
	const yz = qy * z2;
	const zz = qz * z2;
	const wx = qw * x2;
	const wy = qw * y2;
	const wz = qw * z2;

	// 直接由四元数推导 camera-to-world 旋转列。
	const camToWorld00 = 1.0 - ( yy + zz );
	const camToWorld10 = xy + wz;
	const camToWorld20 = xz - wy;
	const camToWorld01 = xy - wz;
	const camToWorld11 = 1.0 - ( xx + zz );
	const camToWorld21 = yz + wx;
	const camToWorld02 = xz + wy;
	const camToWorld12 = yz - wx;
	const camToWorld22 = 1.0 - ( xx + yy );

	// View rotation = camera-to-world rotation 的转置。相机平移清零后即 relativeToEye view matrix。
	out[ 0 ] = camToWorld00; out[ 1 ] = camToWorld01; out[ 2 ] = camToWorld02; out[ 3 ] = 0.0;
	out[ 4 ] = camToWorld10; out[ 5 ] = camToWorld11; out[ 6 ] = camToWorld12; out[ 7 ] = 0.0;
	out[ 8 ] = camToWorld20; out[ 9 ] = camToWorld21; out[ 10 ] = camToWorld22; out[ 11 ] = 0.0;
	out[ 12 ] = 0.0; out[ 13 ] = 0.0; out[ 14 ] = 0.0; out[ 15 ] = 1.0;
}

/**
 * 使用 Float64 中间值复刻 Three.js PerspectiveCamera.updateProjectionMatrix。
 * 对称居中视锥(无 film offset、无 view offset)下输出与 camera.projectionMatrix 一致，
 * 但不会携带 Three.js Float32 elements 中已舍入的值。
 *
 * @param fovDegrees 垂直视场角，单位度。
 * @param aspect 宽高比(width / height)。
 * @param near 近裁剪面距离。
 * @param far 远裁剪面距离。
 * @param out Float64Array(16) 输出，列主序布局。
 */
function writePerspectiveProjectionFloat64(
	fovDegrees: number, aspect: number, near: number, far: number,
	out: Float64Array,
): void {
	const fovRad = fovDegrees * Math.PI / 180.0;
	const top = near * Math.tan( 0.5 * fovRad );
	const bottom = - top;
	const right = top * aspect;
	const left = - right;

	const x = ( 2.0 * near ) / ( right - left );
	const y = ( 2.0 * near ) / ( top - bottom );
	const a = ( right + left ) / ( right - left );
	const b = ( top + bottom ) / ( top - bottom );
	const c = - ( far + near ) / ( far - near );
	const d = - ( 2.0 * far * near ) / ( far - near );

	out[ 0 ] = x; out[ 1 ] = 0.0; out[ 2 ] = 0.0; out[ 3 ] = 0.0;
	out[ 4 ] = 0.0; out[ 5 ] = y; out[ 6 ] = 0.0; out[ 7 ] = 0.0;
	out[ 8 ] = a; out[ 9 ] = b; out[ 10 ] = c; out[ 11 ] = - 1.0;
	out[ 12 ] = 0.0; out[ 13 ] = 0.0; out[ 14 ] = d; out[ 15 ] = 0.0;
}

/**
 * Float64 矩阵乘法:out = a * b。布局为列主序，与 Three.js Matrix4.elements 匹配。
 * 变量命名 `aRowCol` 采用数学约定，索引访问则使用列主序偏移。
 *
 * @param a 左操作数，16 个 Float64，列主序。
 * @param b 右操作数，16 个 Float64，列主序。
 * @param out 输出矩阵，16 个 Float64，列主序。
 */
function multiplyMatricesFloat64(
	a: Float64Array, b: Float64Array, out: Float64Array,
): void {
	const a11 = a[ 0 ];
	const a21 = a[ 1 ];
	const a31 = a[ 2 ];
	const a41 = a[ 3 ];
	const a12 = a[ 4 ];
	const a22 = a[ 5 ];
	const a32 = a[ 6 ];
	const a42 = a[ 7 ];
	const a13 = a[ 8 ];
	const a23 = a[ 9 ];
	const a33 = a[ 10 ];
	const a43 = a[ 11 ];
	const a14 = a[ 12 ];
	const a24 = a[ 13 ];
	const a34 = a[ 14 ];
	const a44 = a[ 15 ];

	const b11 = b[ 0 ];
	const b21 = b[ 1 ];
	const b31 = b[ 2 ];
	const b41 = b[ 3 ];
	const b12 = b[ 4 ];
	const b22 = b[ 5 ];
	const b32 = b[ 6 ];
	const b42 = b[ 7 ];
	const b13 = b[ 8 ];
	const b23 = b[ 9 ];
	const b33 = b[ 10 ];
	const b43 = b[ 11 ];
	const b14 = b[ 12 ];
	const b24 = b[ 13 ];
	const b34 = b[ 14 ];
	const b44 = b[ 15 ];

	out[ 0 ] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
	out[ 1 ] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
	out[ 2 ] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
	out[ 3 ] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;

	out[ 4 ] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
	out[ 5 ] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
	out[ 6 ] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
	out[ 7 ] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;

	out[ 8 ] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
	out[ 9 ] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
	out[ 10 ] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
	out[ 11 ] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;

	out[ 12 ] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
	out[ 13 ] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
	out[ 14 ] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
	out[ 15 ] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

/**
 * 将 Cesium normal matrix(modelView 旋转的 3x3 部分)从 16 项 Float64
 * 列主序矩阵写入 Three.js Matrix3 elements。
 *
 * @param source Float64 列主序矩阵。
 * @param destination Three Matrix3 接收者。
 */
function writeMatrix3FromFloat64Mat4( source: Float64Array, destination: Matrix3 ): void {
	const elements = destination.elements;
	elements[ 0 ] = source[ 0 ];
	elements[ 1 ] = source[ 1 ];
	elements[ 2 ] = source[ 2 ];
	elements[ 3 ] = source[ 4 ];
	elements[ 4 ] = source[ 5 ];
	elements[ 5 ] = source[ 6 ];
	elements[ 6 ] = source[ 8 ];
	elements[ 7 ] = source[ 9 ];
	elements[ 8 ] = source[ 10 ];
}

/**
 * 将世界空间方向乘以 Float64 view rotation 矩阵。
 *
 * @param source ECEF/world 坐标中的方向向量。
 * @param out Float64Array(3) 接收 eye 坐标方向。
 */
function writeEyeDirectionFloat64( source: Vector3, out: Float64Array ): void {
	const x = source.x;
	const y = source.y;
	const z = source.z;

	out[ 0 ] = viewRotationFloat64[ 0 ] * x + viewRotationFloat64[ 4 ] * y + viewRotationFloat64[ 8 ] * z;
	out[ 1 ] = viewRotationFloat64[ 1 ] * x + viewRotationFloat64[ 5 ] * y + viewRotationFloat64[ 9 ] * z;
	out[ 2 ] = viewRotationFloat64[ 2 ] * x + viewRotationFloat64[ 6 ] * y + viewRotationFloat64[ 10 ] * z;
}

/**
 * 使用 CPU Float64 数学写入 eye-space 平面 classification 平面。
 *
 * Cesium shader 通常在顶点着色器中从 RTE uniform 推导这些平面。
 * 对大范围 classification 没问题，但 1:1 米级小圆会在程序化 ring/circle 样式中暴露
 * float 轴向漂移。因此这里在 CPU 上计算精确的 eye-space west/south 平面，
 * 让片元着色器直接消费它们来获得局部米制坐标。
 *
 * @param frameState 当前 Three 侧帧状态。
 * @param uniforms 原地更新的共享材质 uniform。
 */
function updateCpuPlanarUniforms(
	frameState: CesiumGroundFrameState,
	uniforms: SharedUniforms,
): void {
	const swHigh = uniforms.u_southWest_HIGH.value;
	const swLow = uniforms.u_southWest_LOW.value;
	const eastward = uniforms.u_eastward.value;
	const northward = uniforms.u_northward.value;
	const cameraPosition = frameState.camera.position;
	const scratch = cpuPlaneScratch;

	const swRelativeX = swHigh.x + swLow.x - cameraPosition.x;
	const swRelativeY = swHigh.y + swLow.y - cameraPosition.y;
	const swRelativeZ = swHigh.z + swLow.z - cameraPosition.z;

	scratch.swEye[ 0 ] =
		viewRotationFloat64[ 0 ] * swRelativeX +
		viewRotationFloat64[ 4 ] * swRelativeY +
		viewRotationFloat64[ 8 ] * swRelativeZ;
	scratch.swEye[ 1 ] =
		viewRotationFloat64[ 1 ] * swRelativeX +
		viewRotationFloat64[ 5 ] * swRelativeY +
		viewRotationFloat64[ 9 ] * swRelativeZ;
	scratch.swEye[ 2 ] =
		viewRotationFloat64[ 2 ] * swRelativeX +
		viewRotationFloat64[ 6 ] * swRelativeY +
		viewRotationFloat64[ 10 ] * swRelativeZ;

	writeEyeDirectionFloat64( eastward, scratch.eastEye );
	writeEyeDirectionFloat64( northward, scratch.northEye );

	const eastLength = Math.max(
		Math.hypot( scratch.eastEye[ 0 ], scratch.eastEye[ 1 ], scratch.eastEye[ 2 ] ),
		1.0e-12,
	);
	const northLength = Math.max(
		Math.hypot( scratch.northEye[ 0 ], scratch.northEye[ 1 ], scratch.northEye[ 2 ] ),
		1.0e-12,
	);

	const eastX = scratch.eastEye[ 0 ] / eastLength;
	const eastY = scratch.eastEye[ 1 ] / eastLength;
	const eastZ = scratch.eastEye[ 2 ] / eastLength;
	const northX = scratch.northEye[ 0 ] / northLength;
	const northY = scratch.northEye[ 1 ] / northLength;
	const northZ = scratch.northEye[ 2 ] / northLength;

	uniforms.u_cpuWestPlane.value.set(
		eastX,
		eastY,
		eastZ,
		- (
			eastX * scratch.swEye[ 0 ] +
			eastY * scratch.swEye[ 1 ] +
			eastZ * scratch.swEye[ 2 ]
		),
	);
	uniforms.u_cpuSouthPlane.value.set(
		northX,
		northY,
		northZ,
		- (
			northX * scratch.swEye[ 0 ] +
			northY * scratch.swEye[ 1 ] +
			northZ * scratch.swEye[ 2 ]
		),
	);
}

/**
 * 更新本帧 Cesium automatic uniform，包括 shadow-volume 顶点/片元着色器需要的
 * LOG_DEPTH uniform。
 *
 * 导出该函数是为了让位于 stencil 命令组之外的贴地折线图元复用同一套逐帧 uniform 管线。
 * 折线通过在自己的 uniform map 中声明额外字段(`czm_projection`、`czm_pixelRatio`)
 * 来 opt-in；下面的守卫式写入不会影响 stencil/color/text 材质。
 *
 * @param frameState 当前 Three 侧帧状态。
 * @param uniforms 原地更新的共享材质 uniform。
 */
export function updateFrameStateUniforms( frameState: CesiumGroundFrameState, uniforms: SharedUniforms ): void {
	const camera = frameState.camera;
	const quaternion = camera.quaternion;

	// 直接从相机四元数构造 Float64 view rotation，避免 model-view-relative-to-eye
	// 矩阵被 Three.js Float32 存储卡住精度。平移保持为零；真实偏移在 shader 中通过
	// czm_translateRelativeToEye(positionHigh, positionLow) 与编码后的相机位置计算。
	writeViewRotationFloat64(
		quaternion.x, quaternion.y, quaternion.z, quaternion.w,
		viewRotationFloat64,
	);

	writePerspectiveProjectionFloat64(
		camera.fov, camera.aspect, camera.near, camera.far,
		projectionFloat64,
	);

	multiplyMatricesFloat64( projectionFloat64, viewRotationFloat64, mvpFloat64 );

	// Three.js Matrix4.elements 是普通 `number[]`，不是 Float32Array，因此没有 typed-array
	// `set()` 方法。`fromArray()` 会逐索引复制 16 项，和我们的 Float64Array scratch 配合一致。
	uniforms.czm_modelViewRelativeToEye.value.fromArray( viewRotationFloat64 );
	uniforms.czm_modelViewProjectionRelativeToEye.value.fromArray( mvpFloat64 );
	writeMatrix3FromFloat64Mat4( viewRotationFloat64, uniforms.czm_normal.value );
	updateCpuPlanarUniforms( frameState, uniforms );

	uniforms.czm_globeDepthTexture.value = frameState.depthTexture;
	uniforms.czm_viewport.value.set( 0.0, 0.0, frameState.width, frameState.height );
	uniforms.czm_inverseProjection.value.copy( camera.projectionMatrixInverse );
	uniforms.czm_viewportTransformation.value.copy(
		createViewportTransformation( frameState.width, frameState.height ),
	);

	const near = camera.near;
	const far = camera.far;
	const fovRad = camera.fov * Math.PI / 180.0;
	const top = near * Math.tan( 0.5 * fovRad );
	const right = top * camera.aspect;
	uniforms.czm_frustumPlanes.value.set( top, - top, - right, right );
	uniforms.czm_currentFrustum.value.set( near, far, 0.0 );

	const farDepthFromNearPlusOne = ( far - near ) + 1.0;
	const log2FarDepthFromNearPlusOne = Math.log2( farDepthFromNearPlusOne );
	const oneOverLog2FarDepthFromNearPlusOne = log2FarDepthFromNearPlusOne > 0.0
		? 1.0 / log2FarDepthFromNearPlusOne
		: 1.0;
	uniforms.czm_farDepthFromNearPlusOne.value = farDepthFromNearPlusOne;
	uniforms.czm_log2FarDepthFromNearPlusOne.value = log2FarDepthFromNearPlusOne;
	uniforms.czm_oneOverLog2FarDepthFromNearPlusOne.value = oneOverLog2FarDepthFromNearPlusOne;

	// Cesium UniformState.update 将 czm_geometricToleranceOverMeter 推导为
	// `pixelSizePerMeter * frameState.maximumScreenSpaceError`。旧适配器曾硬编码为 1.0，
	// 导致 ShadowVolumeAppearanceVS 的 EXTRUDED_GEOMETRY 分支无论 eye distance 如何，
	// 都 clamp 到 u_globeMinimumAltitude(55 km)。使用真实公式后，近相机标绘只获得微小挤出，
	// 远处标绘仍覆盖配置的像素容差。
	const viewportSize = Math.max( frameState.width, frameState.height, 1.0 );
	const pixelSizePerMeter = ( Math.tan( 0.5 * fovRad ) * 2.0 ) / viewportSize;
	uniforms.czm_geometricToleranceOverMeter.value =
		pixelSizePerMeter * CESIUM_MAXIMUM_SCREEN_SPACE_ERROR;

	// ── 贴地线扩展（guard 式写入：面图元的 uniform map 不含这两键
	//    → 守卫跳过；线图元的 uniform map 含这两键 → 每帧刷新）──
	// `czm_projection`：纯投影矩阵（Float64 算后落 Three Matrix4）。线 VS
	// 需要「EC 内挤出 → 再投影」，所以除了 mvp 还要单独提供 projection。
	if ( uniforms.czm_projection !== undefined ) {
		( uniforms.czm_projection.value as Matrix4 ).fromArray( projectionFloat64 );
	}
	// `czm_pixelRatio`：metersPerPixel 内部要乘它，HiDPI 必须正确填。
	if ( uniforms.czm_pixelRatio !== undefined ) {
		( uniforms.czm_pixelRatio as { value: number } ).value =
			frameState.pixelRatio !== undefined ? frameState.pixelRatio : 1.0;
	}
}

/**
 * 可选注入点，供需要非默认 color material 的调用方使用。
 * 例如贴地文字和图片点需要用纹理 sampler 替代 per-instance 填充色。
 * 其它调用方省略该参数时，图元回退到 `createColorMaterial`，
 * 圆形/矩形/多边形行为保持不变。
 */
export interface ClassificationColorInjection {
	/** 自定义 color material 工厂。未设置时使用默认 `createColorMaterial`。 */
	colorMaterialFactory?: ( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;
	/** 材质构建前合并到共享 uniform map 的额外 uniform。 */
	extraUniforms?: Record<string, { value: unknown }>;
	/** Stage 5 safe Material Appearance；Raw Appearance 留到后续三 pass 阶段。 */
	appearance?: CesiumGroundAppearance;
	/**
	 * 仅供 Ground primitive 分阶段迁移使用的内部开关。
	 *
	 * `true` 时 front/back stencil 仍由历史固定工厂创建，只有 color 命令进入
	 * Material assembler/compiler。文字和图片贴花当前仍依赖自定义 legacy color
	 * factory，因此不得同时传入 `colorMaterialFactory`；等 decal 阶段迁移时会改由
	 * 独立的 `primitiveKind: 'decal'` 管线接管。
	 */
	useMaterialPipeline?: boolean;
}

/**
 * 一个 classification 实例私有的 color 编译上下文。
 *
 * system map、logical Material 和 Appearance 都在构造时只创建一次；后续
 * `setFragmentCulling()` 只替换 `compiledColor`。这样旧 style setter 写入的
 * SharedUniform wrapper 会被 canonical map 持续别名引用，既不复制值，也不会
 * 因重编译丢失 wrapper 身份。
 */
interface ClassificationMaterialPipelineRuntime {
	readonly systemUniforms: GroundSystemUniforms;
	readonly defaultMaterial: ReturnType<typeof createColorGroundMaterial>;
	readonly defaultAppearance: CesiumGroundMaterialAppearance;
	appearance: CesiumGroundMaterialAppearance;
	readonly primitiveId: number;
	compiledColor: GroundCompiledMaterial;
}

/** 每个 primitive 的 Raw factory 所有权诊断必须有稳定且互不相同的身份。 */
let nextClassificationMaterialPrimitiveId = 1;

/**
 * 使用同一组 immutable compile inputs 构建一个 surface color pass。
 * attributeLayoutKey 描述 shadow-volume attribute schema，而不是任何 attribute
 * 数值；因此颜色、透明度或相机更新不会制造新的 program key。
 */
function compileClassificationColor(
	runtime: Pick<ClassificationMaterialPipelineRuntime, 'systemUniforms' | 'defaultMaterial' | 'appearance' | 'primitiveId'>,
	fragmentCull: boolean,
): GroundCompiledMaterial {
	return compileGroundPass( {
		primitiveKind: 'surface',
		pass: 'color',
		appearance: runtime.appearance,
		systemUniforms: runtime.systemUniforms,
		defaultMaterial: runtime.defaultMaterial,
		pipelineState: {
			fragmentCull,
			debugVolume: false,
			attributeLayoutKey: 'classification-shadow-volume-v1',
			primitiveId: runtime.primitiveId,
		},
	} );
}

/**
 * 为一个 classification 创建隔离的默认 Color Material 运行时。
 * canonical system map 只保存 legacy SharedUniform wrapper 的别名；白色 logical
 * Color Material 是乘法恒等元，所以迁移后的默认结果仍完全由原 fill/stroke
 * wrappers 决定。
 */
function createClassificationMaterialPipelineRuntime(
	uniforms: SharedUniforms,
	fragmentCull: boolean,
	requestedAppearance?: CesiumGroundAppearance,
): ClassificationMaterialPipelineRuntime {
	const defaultMaterial = createColorGroundMaterial();
	const defaultAppearance = new CesiumGroundMaterialAppearance( { material: defaultMaterial } );
	if (
		requestedAppearance !== undefined &&
		! ( requestedAppearance instanceof CesiumGroundMaterialAppearance )
	) {
		throw new TypeError(
			'Classification surface appearance must be a CesiumGroundMaterialAppearance in Stage 5.',
		);
	}
	const appearance = requestedAppearance ?? defaultAppearance;
	const systemUniforms = createCanonicalGroundSystemUniforms( uniforms, 'surface' );
	const runtimeWithoutCompiled = {
		systemUniforms,
		defaultMaterial,
		defaultAppearance,
		appearance,
		primitiveId: nextClassificationMaterialPrimitiveId ++,
	};

	return {
		...runtimeWithoutCompiled,
		compiledColor: compileClassificationColor( runtimeWithoutCompiled, fragmentCull ),
	};
}

/**
 * 在 Three 中执行 Cesium ClassificationPrimitive 的两个 stencil 命令和一个 color 命令。
 */
export class CesiumClassificationPrimitive {
	public readonly group: Group;

	private readonly stencilMesh: Mesh;
	private readonly backStencilMesh: Mesh;
	private readonly colorMesh: Mesh;
	private readonly uniforms: SharedUniforms;
	private readonly cameraHigh = new Vector3();
	private readonly cameraLow = new Vector3();
	private readonly colorMaterialFactory:
		( uniforms: SharedUniforms, fragmentCull: boolean ) => RawShaderMaterial;
	/** null 表示该实例仍完整使用 legacy color factory（当前 text/image 即如此）。 */
	private readonly materialPipeline: ClassificationMaterialPipelineRuntime | null;
	private colorFragmentCull: boolean;

	/**
	 * 分类目标：决定 {@link update} 时采样哪张 packed 深度纹理（贴地形 / 贴模型 / 二者）。
	 * 默认 BOTH。单纹理宿主下该值不影响结果（始终回退到 frameState.depthTexture）。
	 */
	private classificationType: ClassificationType = ClassificationType.BOTH;

	public constructor(
		geometry: BufferGeometry,
		extents: PlanarExtents,
		color: Color,
		alpha: number,
		renderOrder: number,
		fragmentCull: boolean,
		injection?: ClassificationColorInjection,
	) {
		this.group = new Group();
		this.group.name = 'CesiumClassificationPrimitive';
		this.colorFragmentCull = fragmentCull;

		this.uniforms = {
			czm_encodedCameraPositionMCHigh: { value: this.cameraHigh },
			czm_encodedCameraPositionMCLow: { value: this.cameraLow },
			czm_modelViewRelativeToEye: { value: new Matrix4() },
			czm_modelViewProjectionRelativeToEye: { value: new Matrix4() },
			czm_normal: { value: new Matrix3() },
			// 初始值会在第一帧由 updateFrameStateUniforms 使用当前相机 fov / 绘制缓冲尺寸覆盖。
			// 占位值有意保持极小，避免 uniform 填好前顶点着色器产生非平凡挤出。
			czm_geometricToleranceOverMeter: { value: 0.0 },
			czm_sceneMode: { value: SCENE_MODE_3D },
			u_globeMinimumAltitude: { value: CESIUM_GLOBE_MINIMUM_ALTITUDE },
			u_southWest_HIGH: { value: extents.southWestHigh },
			u_southWest_LOW: { value: extents.southWestLow },
			u_eastward: { value: extents.eastward },
			u_northward: { value: extents.northward },
			u_uvMinAndExtents: { value: extents.uvMinAndExtents },
			u_uMaxVmax: { value: extents.uMaxVmax },
			u_color: { value: new Vector4( color.r, color.g, color.b, alpha ) },
			u_borderColor: { value: new Vector4( 1.0, 1.0, 1.0, 1.0 ) },
			u_borderEnabled: { value: 0.0 },
			u_borderWidthMeters: { value: 0.0 },
			u_innerMetersRect: { value: extents.innerMetersRect },
			u_cpuWestPlane: { value: new Vector4( 1.0, 0.0, 0.0, 0.0 ) },
			u_cpuSouthPlane: { value: new Vector4( 0.0, 1.0, 0.0, 0.0 ) },
			// Polygon-stroke uniform：附加能力，在现有 color 命令内做 point-in-polygon 测试，
			// 不影响 LOG_DEPTH / Float64 / LessEqualDepth 精度路径。
			u_polygonBorderMode: { value: 0.0 },
			u_polygonMiterStrokeMode: { value: 0.0 },
			u_polygonPointCount: { value: 0.0 },
			u_polygonPoints: {
				value: Array.from(
					{ length: MAX_POLYGON_STYLE_VERTICES },
					() => new Vector2(),
				),
			},
			// Circle border / ring / sector uniform：附加能力，在 color 命令内做环线与扇区装饰，
			// 同样不影响精度路径。
			u_circleBorderMode: { value: 0.0 },
			u_circleCenterMeters: { value: new Vector2() },
			u_circleFillRadiusMeters: { value: 0.0 },
			u_circleRenderRadiusMeters: { value: 0.0 },
			u_circleRingCount: { value: 1.0 },
			u_circleRingGapMeters: { value: 0.0 },
			u_circleSectorStartRadians: { value: 0.0 },
			u_circleSectorAngleRadians: { value: Math.PI * 2.0 },
			czm_globeDepthTexture: { value: null },
			czm_viewport: { value: new Vector4( 0.0, 0.0, 1.0, 1.0 ) },
			czm_inverseProjection: { value: new Matrix4() },
			czm_viewportTransformation: { value: createViewportTransformation( 1, 1 ) },
			czm_frustumPlanes: { value: new Vector4() },
			czm_currentFrustum: { value: new Vector3() },
			czm_farDepthFromNearPlusOne: { value: 1.0 },
			czm_log2FarDepthFromNearPlusOne: { value: 1.0 },
			czm_oneOverLog2FarDepthFromNearPlusOne: { value: 1.0 },
			// 历史贴地文字纹理槽，保留在 SharedUniforms 中兼容旧扩展；新文字和图片点
			// 统一使用下方 u_decalTexture/u_decalOpacity。
			u_textTexture: { value: null },
			// 通用透明纹理贴花槽。文字与图片点都通过 extraUniforms 覆盖。
			u_decalTexture: { value: null },
			u_decalOpacity: { value: 1.0 },
		};

		// 在任何材质构建前合并调用方提供的 uniform（例如 `u_decalTexture`），
		// 使三个命令共享同一张 map。
		if ( injection !== undefined && injection.extraUniforms !== undefined ) {
			for ( const key in injection.extraUniforms ) {
				if ( Object.prototype.hasOwnProperty.call( injection.extraUniforms, key ) ) {
					this.uniforms[ key ] = injection.extraUniforms[ key ];
				}
			}
		}

		if ( injection?.useMaterialPipeline === true && injection.colorMaterialFactory !== undefined ) {
			throw new TypeError(
				'Classification Material pipeline cannot be combined with a legacy colorMaterialFactory.',
			);
		}

		// 保存 color material 工厂，使 `setFragmentCulling` 后续重建 color mesh 时
		// 不会丢失 textured-decal color 注入。
		this.colorMaterialFactory =
			injection !== undefined && injection.colorMaterialFactory !== undefined
				? injection.colorMaterialFactory
				: createColorMaterial;
		// 此处只创建 color 编译上下文。front/back 继续在下方调用既有 stencil
		// 工厂，确保 Stage 4 迁移不会改变它们的 GLSL、render state 或对象身份。
		this.materialPipeline = injection?.useMaterialPipeline === true
			? createClassificationMaterialPipelineRuntime(
				this.uniforms,
				fragmentCull,
				injection.appearance,
			)
			: null;

		const frontStencilMaterial = createStencilMaterial(
			this.uniforms,
			FrontSide,
			DecrementWrapStencilOp,
			'CesiumClassificationFrontStencilDepthMaterial',
		);
		const backStencilMaterial = createStencilMaterial(
			this.uniforms,
			BackSide,
			IncrementWrapStencilOp,
			'CesiumClassificationBackStencilDepthMaterial',
		);
		const colorMaterial = this.materialPipeline?.compiledColor.material
			?? this.colorMaterialFactory( this.uniforms, fragmentCull );

		this.stencilMesh = new Mesh( geometry, frontStencilMaterial );
		this.stencilMesh.name = 'CesiumClassificationFrontStencilDepthCommand';
		this.stencilMesh.frustumCulled = false;

		this.backStencilMesh = new Mesh( geometry, backStencilMaterial );
		this.backStencilMesh.name = 'CesiumClassificationBackStencilDepthCommand';
		this.backStencilMesh.frustumCulled = false;

		this.colorMesh = new Mesh( geometry, colorMaterial );
		this.colorMesh.name = 'CesiumClassificationColorCommand';
		this.colorMesh.frustumCulled = false;

		// 将三个 shadow-volume 网格移动到不可拾取 layer，使场景 raycast
		// (例如 GlobeControls 的 adjustHeight + zoomPoint 解析，
		// 通过 `EnvironmentControls._raycast` → `raycaster.intersectObject(scene)`)
		// 静默跳过它们。
		//
		// 这样做很重要：这些网格是数公里级挤出 box(terrainMinHeight → terrainMaxHeight)，
		// 只用于驱动 stencil + color pass，并不是用户应该点击或让相机碰撞的“真实几何”。
		// 它们自动计算出的 boundingSphere 为空(几何使用 RTE 编码的 `position3DHigh` /
		// `position3DLow`，而不是标准 `position` attribute)，所以目前实践中本来也不会产生
		// raycast 命中。显式标记 layer 是防御性措施，避免未来某次改动加入标准
		// `position` attribute 后突然把相机钉住。
		//
		// Three.js Raycaster.intersect 由 `object.layers.test(raycaster.layers)` 控制，
		// 不检查 `object.visible`。因此即便宿主短暂通过 `group.visible = false` 隐藏组，
		// 这里的 layer 语义仍正确。宿主相机必须调用
		// `camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER )`，
		// 让这些网格仍处于渲染路径中；见 ground-demo.ts。
		this.stencilMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.backStencilMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );
		this.colorMesh.layers.set( CESIUM_GROUND_NON_PICKABLE_LAYER );

		this.setRenderOrder( renderOrder );
		this.group.add( this.stencilMesh, this.backStencilMesh, this.colorMesh );
	}

	/**
	 * 更新该图元连续命令块的基础渲染顺序。
	 *
	 * @param renderOrder 分配给 front-stencil 命令的基础顺序。
	 */
	public setRenderOrder( renderOrder: number ): void {
		const safeRenderOrder = Number.isFinite( renderOrder ) ? renderOrder : 0;
		this.stencilMesh.renderOrder = safeRenderOrder;
		this.backStencilMesh.renderOrder = safeRenderOrder + 1;
		this.colorMesh.renderOrder = safeRenderOrder + 2;
	}

	/**
	 * 切换单个绘制命令的可见性，不将其从场景图中分离。
	 *
	 * @param visibility 可选的逐命令可见性标志。
	 */
	public setCommandVisibility( visibility: CesiumClassificationCommandVisibility ): void {
		if ( visibility.frontStencil !== undefined ) {
			this.stencilMesh.visible = visibility.frontStencil;
		}
		if ( visibility.backStencil !== undefined ) {
			this.backStencilMesh.visible = visibility.backStencil;
		}
		if ( visibility.color !== undefined ) {
			this.colorMesh.visible = visibility.color;
		}
	}

	/**
	 * 更新 Cesium shader 消费的 per-instance color uniform。
	 *
	 * @param color Three 线性颜色。
	 * @param alpha 预乘输出 alpha 因子。
	 */
	public setColor( color: Color, alpha: number ): void {
		this.uniforms.u_color.value.set( color.r, color.g, color.b, alpha );
	}

	/**
	 * Returns the logical Appearance currently bound to the color pass.
	 *
	 * Legacy injected decal/text instances deliberately have no safe pipeline in
	 * Stage 5 and therefore throw a clear error instead of exposing a misleading
	 * partial Appearance. Surface primitives always enable the pipeline and return
	 * either their internal default or the exact user Appearance object.
	 */
	public get appearance(): CesiumGroundAppearance {
		if ( this.materialPipeline === null ) {
			throw new Error( 'This legacy classification instance has no Material Appearance.' );
		}
		return this.materialPipeline.appearance;
	}

	/**
	 * Atomically swaps a safe surface Appearance without touching geometry or the
	 * fixed stencil meshes. `undefined` restores the constructor-created default
	 * Appearance; user-owned logical materials are never disposed here.
	 */
	public setAppearance( appearance?: CesiumGroundAppearance ): void {
		if ( this.materialPipeline === null ) {
			throw new Error( 'This legacy classification instance does not support Appearance switching.' );
		}
		if (
			appearance !== undefined &&
			! ( appearance instanceof CesiumGroundMaterialAppearance )
		) {
			throw new TypeError(
				'Classification surface appearance must be a CesiumGroundMaterialAppearance in Stage 5.',
			);
		}

		const nextAppearance = appearance ?? this.materialPipeline.defaultAppearance;
		if ( nextAppearance === this.materialPipeline.appearance ) return;

		// Compile first. A validation failure leaves the current material and
		// Appearance untouched, so a failed custom shader cannot create a half-updated
		// command block or a transient transparent frame.
		const nextCompiled = compileClassificationColor( {
			...this.materialPipeline,
			appearance: nextAppearance,
		}, this.colorFragmentCull );
		const previousMaterial = this.colorMesh.material as Material;
		this.materialPipeline.appearance = nextAppearance;
		this.materialPipeline.compiledColor = nextCompiled;
		this.colorMesh.material = nextCompiled.material;
		previousMaterial.dispose();
	}

	/**
	 * 更新现有 Cesium color 命令中的边框样式。
	 *
	 * @param enabled shader 是否混入边框颜色。
	 * @param color Three 线性颜色表示的边框颜色。
	 * @param opacity classification blend pass 之前使用的 straight alpha。
	 * @param widthMeters 局部米制坐标中的边框宽度。
	 */
	public setBorderStyle( enabled: boolean, color: Color, opacity: number, widthMeters: number ): void {
		const safeOpacity = Math.min( Math.max( opacity, 0.0 ), 1.0 );
		const safeWidthMeters = Math.max( widthMeters, 0.0 );

		this.uniforms.u_borderEnabled.value = enabled && safeOpacity > 0.0 && safeWidthMeters > 0.0 ? 1.0 : 0.0;
		this.uniforms.u_borderColor.value.set( color.r, color.g, color.b, safeOpacity );
		this.uniforms.u_borderWidthMeters.value = safeWidthMeters;
	}

	/**
	 * 以平面米制坐标提供原始多边形填充环，使 color fragment 能为描边样式执行
	 * point-in-polygon 测试。
	 *
	 * shader 仅在 `u_polygonBorderMode` 开启时使用这些值；调用方通过传入 3 个及以上
	 * 点启用该模式。少于 3 个点时禁用 polygon-border 模式，并回退到已有的矩形
	 * `u_innerMetersRect` 轴对齐边框。
	 *
	 * @param points 填充多边形顶点，相对于顶点着色器从 `u_southWest_HIGH/LOW`
	 *               推导出的同一 SW 米制原点。
	 */
	public setPolygonBorderPoints( points: readonly Vector2[] ): void {
		const polygonPoints = this.uniforms.u_polygonPoints.value;
		const pointCount = Math.min( points.length, MAX_POLYGON_STYLE_VERTICES );

		for ( let i = 0; i < pointCount; i ++ ) {
			polygonPoints[ i ].copy( points[ i ] );
		}

		this.uniforms.u_polygonPointCount.value = pointCount;
		this.uniforms.u_polygonBorderMode.value = pointCount >= 3 ? 1.0 : 0.0;
		// 激活 polygon 分支会禁用 circle 分支，避免 fragment shader 读取上一个图元设置
		// 遗留下来的 circle uniform。
		this.uniforms.u_circleBorderMode.value = 0.0;
	}

	/**
	 * 选择 fragment shader 使用的多边形描边分类器。
	 *
	 * round 模式按到填充环的距离裁剪描边，对通用多边形更鲁棒。
	 * miter 模式信任已扩张的渲染几何，只测试 fill-vs-border，
	 * 可在米级尺度保留尖锐箭头头部和凹口。
	 *
	 * @param enabled render ring 是真实 miter 偏移外壳时为 true。
	 */
	public setPolygonMiterStrokeMode( enabled: boolean ): void {
		this.uniforms.u_polygonMiterStrokeMode.value = enabled ? 1.0 : 0.0;
	}

	/**
	 * 以平面米制坐标提供圆形样式值，使 color fragment 能为圆盘添加同心环、
	 * 扇区裁切和外侧描边带。两个半径都为 0 时禁用 circle 分支，
	 * 由 rectangle / polygon 路径接管。
	 *
	 * @param centerMeters 相对于 shader SW 米制原点的圆心。
	 * @param fillRadiusMeters 公开填充半径，单位米。
	 * @param renderRadiusMeters shadow-volume 渲染半径，单位米。
	 * @param ringCount 填充同心带数量，默认 1。
	 * @param ringGapMeters 填充带之间的透明间隔宽度，单位米。
	 * @param sectorStartRadians 圆局部 ENU 平面中的起始角。
	 * @param sectorAngleRadians 正向角度扫掠；±2π 表示完整圆。
	 */
	public setCircleBorderStyle(
		centerMeters: Vector2,
		fillRadiusMeters: number,
		renderRadiusMeters: number,
		ringCount = 1.0,
		ringGapMeters = 0.0,
		sectorStartRadians = 0.0,
		sectorAngleRadians = Math.PI * 2.0,
	): void {
		const safeRingCount = Number.isFinite( ringCount )
			? Math.max( Math.floor( ringCount ), 1.0 )
			: 1.0;
		const safeRingGapMeters = Number.isFinite( ringGapMeters )
			? Math.max( ringGapMeters, 0.0 )
			: 0.0;
		const safeSectorStartRadians = Number.isFinite( sectorStartRadians )
			? sectorStartRadians
			: 0.0;
		const safeSectorAngleRadians = Number.isFinite( sectorAngleRadians )
			? Math.min( Math.max( sectorAngleRadians, - Math.PI * 2.0 ), Math.PI * 2.0 )
			: Math.PI * 2.0;

		this.uniforms.u_circleCenterMeters.value.copy( centerMeters );
		this.uniforms.u_circleFillRadiusMeters.value = Math.max( fillRadiusMeters, 0.0 );
		this.uniforms.u_circleRenderRadiusMeters.value = Math.max( renderRadiusMeters, 0.0 );
		this.uniforms.u_circleRingCount.value = safeRingCount;
		this.uniforms.u_circleRingGapMeters.value = safeRingGapMeters;
		this.uniforms.u_circleSectorStartRadians.value = safeSectorStartRadians;
		this.uniforms.u_circleSectorAngleRadians.value = safeSectorAngleRadians;
		this.uniforms.u_circleBorderMode.value =
			fillRadiusMeters > 0.0 && renderRadiusMeters > 0.0 ? 1.0 : 0.0;
		// 激活 circle 分支会禁用 polygon 分支(二者在 fragment shader 中互斥)。
		this.uniforms.u_polygonBorderMode.value = 0.0;
		this.uniforms.u_polygonPointCount.value = 0.0;
	}

	/**
	 * Polls the logical safe Material revision at the render boundary.
	 *
	 * Uniform `.value` changes intentionally do not affect `version`, so ordinary
	 * animation remains allocation-free. A caller that changes source/defines or
	 * schema and then sets `needsUpdate=true` is reconciled on the next update;
	 * candidate compilation completes before the old color material is disposed.
	 */
	private reconcileMaterialAppearance(): void {
		if ( this.materialPipeline === null ) return;
		const currentVersion = this.materialPipeline.appearance.version;
		if ( this.materialPipeline.compiledColor.appearanceVersion === currentVersion ) return;

		const nextCompiled = compileClassificationColor( this.materialPipeline, this.colorFragmentCull );
		const previousMaterial = this.colorMesh.material as Material;
		this.materialPipeline.compiledColor = nextCompiled;
		this.colorMesh.material = nextCompiled.material;
		previousMaterial.dispose();
	}

	/**
	 * fragment culling 开关变化时重建 color material。
	 *
	 * @param enabled Cesium 的 CULL_FRAGMENTS define 是否启用。
	 */
	public setFragmentCulling( enabled: boolean ): void {
		if ( this.colorFragmentCull === enabled ) {
			return;
		}

		// compiler 路径先完整构建候选产物；只有编译期校验全部成功后才改变
		// 当前开关和 Mesh.material。若未来 safe/Raw appearance 构建抛错，旧 color
		// command 仍保持可用，不会出现半套命令或一帧空白。
		const nextCompiled = this.materialPipeline === null
			? null
			: compileClassificationColor( this.materialPipeline, enabled );
		const nextMaterial = nextCompiled?.material
			?? this.colorMaterialFactory( this.uniforms, enabled );
		const oldMaterial = this.colorMesh.material as Material;

		this.colorFragmentCull = enabled;
		this.colorMesh.material = nextMaterial;
		if ( nextCompiled !== null && this.materialPipeline !== null ) {
			this.materialPipeline.compiledColor = nextCompiled;
		}
		oldMaterial.dispose();
	}

	/**
	 * 设置分类目标（贴地形 / 贴模型 / 二者）。
	 *
	 * @param classificationType 目标枚举；undefined 时保持当前值不变。
	 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		if ( classificationType !== undefined ) {
			this.classificationType = classificationType;
		}
	}

	/**
	 * 更新本帧 Cesium automatic uniform。
	 *
	 * @param frameState Cesium frame state 的 Three 侧等价结构。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.reconcileMaterialAppearance();
		encodeCesiumVector3( frameState.camera.position, this.cameraHigh, this.cameraLow );
		updateFrameStateUniforms( frameState, this.uniforms );
		// updateFrameStateUniforms 已写入默认深度纹理（frameState.depthTexture）。
		// 这里按本图元的分类目标覆盖为对应的 packed 深度纹理：
		//   TERRAIN→terrain、CESIUM_3D_TILE→tileset、BOTH→both。
		// 多纹理未提供时 resolveClassificationDepthTexture 返回同一张默认纹理，
		// 故单纹理宿主行为不变。
		this.uniforms.czm_globeDepthTexture.value =
			resolveClassificationDepthTexture( frameState, this.classificationType );
	}

	/**
	 * 释放几何和材质 GPU 资源。
	 */
	public dispose(): void {
		this.stencilMesh.geometry.dispose();
		( this.stencilMesh.material as Material ).dispose();
		( this.backStencilMesh.material as Material ).dispose();
		( this.colorMesh.material as Material ).dispose();
	}
}
