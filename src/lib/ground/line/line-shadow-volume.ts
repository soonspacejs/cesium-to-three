// ============================================================
// line/line-shadow-volume.ts — 贴地线几何 facade
// 层级：L4（贴地线几何子模块）。
// 职责：把 doc 02-04 串成单一入口：options → BufferGeometry。
//        ① preprocess（归一 + XZ 拆段 + cartographic 去重）
//        ② buildWallArrays（加密 + 几何法线）
//        ③ buildSegmentBoxAttributes（5 vec4 + 位置 + 索引）
//        ④ RTE 拆分位置 → BufferGeometry 装配（9 个属性）
// 依赖：Three.js BufferGeometry / BufferAttribute、math/rte-encoding.ts、
//        line/* 全部模块。
// 被消费：primitives.ts CesiumGroundPolylinePrimitive 构造期、单测。
// 算法对应：Cesium `GroundPolylineGeometry.createGeometry` 整体。
// ============================================================

import { BufferAttribute, BufferGeometry } from 'three';

import { encodePositionsToHighLowArrays } from '../math/rte-encoding';

import { computeEndpointFrames, type EndpointFrame } from './line-arrowhead';
import { buildWallArrays } from './line-geometry-normals';
import { preprocessLine } from './line-preprocess';
import { buildSegmentBoxAttributes } from './line-segment-attributes';
import type { LineShadowVolumeOptions } from './line-types';

/**
 * `geometry.userData` 上挂的扩展信息。CesiumGroundPolylinePrimitive 在构造
 * 期读出 `length3D` 写到 `u_lineTotalMeters`（doc 06 §4 虚线相位用）。
 * `startFrame` / `endFrame` 是端点标架，供线端箭头几何 `buildArrowHeadGeometry`
 * 使用——挂在 wall facade 这里避免外部调用方再走一遍 cartographic / 法线
 * 抽取逻辑。
 */
export interface LineGeometryUserData {
	length3D: number;
	pointCount: number;
	segmentCount: number;
	startFrame: EndpointFrame;
	endFrame: EndpointFrame;
}

/**
 * 构造贴地线 BufferGeometry。一次性、纯 CPU、零 GPU 调用。
 *
 * @param options 内部选项（已校验 + 填默认）。
 * @returns       9-attribute BufferGeometry，`userData.length3D` 含全线长度。
 */
export function buildLineShadowVolumeGeometry(
	options: LineShadowVolumeOptions,
): BufferGeometry {
	// 1. 预处理（doc 02）
	const cartographics = preprocessLine( options.points, options.arcType );

	// 2. 加密 + 法线（doc 03，墙构建主循环）
	const wall = buildWallArrays(
		cartographics,
		options.loop,
		options.arcType,
		options.granularity,
	);

	// 3. 8 顶点 box 打包（doc 04）
	const seg = buildSegmentBoxAttributes(
		wall,
		options.minimumHeight,
		options.maximumHeight,
	);

	// 4. 位置 RTE 拆分（Float64 → high/low Float32）
	const { high, low } = encodePositionsToHighLowArrays( seg.positions );

	// 5. BufferGeometry 装配。零 Three `position` 属性（用 position3DHigh/Low），
	//    包围球会留空 → mesh.frustumCulled 在调用方手动置 false（doc 04 §11）。
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position3DHigh', new BufferAttribute( high, 3 ) );
	geometry.setAttribute( 'position3DLow', new BufferAttribute( low, 3 ) );
	geometry.setAttribute(
		'startHiAndForwardOffsetX',
		new BufferAttribute( seg.startHiFwdX, 4 ),
	);
	geometry.setAttribute(
		'startLoAndForwardOffsetY',
		new BufferAttribute( seg.startLoFwdY, 4 ),
	);
	geometry.setAttribute(
		'startNormalAndForwardOffsetZ',
		new BufferAttribute( seg.startNormFwdZ, 4 ),
	);
	geometry.setAttribute(
		'endNormalAndTextureCoordinateNormalizationX',
		new BufferAttribute( seg.endNormTexX, 4 ),
	);
	geometry.setAttribute(
		'rightNormalAndTextureCoordinateNormalizationY',
		new BufferAttribute( seg.rightNormTexY, 4 ),
	);
	geometry.setAttribute(
		'batchId',
		new BufferAttribute( new Float32Array( seg.vertexCount ), 1 ),
	);
	geometry.setIndex( new BufferAttribute( seg.indices, 1 ) );

	// 端点标架（箭头几何用）。即使调用方不画箭头，也算好挂着——开销可忽略，
	// 但避免运行时 `setArrowMode` 时还要再回去摸 wall。
	const { startFrame, endFrame } = computeEndpointFrames( wall );

	const userData: LineGeometryUserData = {
		length3D: seg.length3D,
		pointCount: wall.pointCount,
		segmentCount: wall.pointCount - 1,
		startFrame,
		endFrame,
	};
	geometry.userData = userData;
	return geometry;
}
