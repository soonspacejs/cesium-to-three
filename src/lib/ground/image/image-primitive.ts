import { Color, Group, type IUniform } from 'three';

import { CesiumClassificationPrimitive } from '../classification';
import type { CesiumGroundAppearance } from '../material/appearances';
import { createTexturedDecalMaterial } from '../material/builtins';
import type { CesiumGroundMaterial } from '../material/CesiumGroundMaterial';
import {
	buildTexturedDecalShadowVolumeGeometry,
	computeTexturedDecalFootprint,
	computeTexturedDecalPlanarExtents,
} from '../textured-decal';
import type {
	CesiumGroundFrameState,
	CesiumGroundImagePrimitiveOptions,
	ClassificationType,
} from '../types';
import { acquireImageTexture, type ImageTextureHandle } from './image-texture-cache';

const DEG_TO_RAD = Math.PI / 180.0;

/**
 * 贴地图片点图元。
 *
 * 图元以点击经纬度为中心，用显式米制宽高和顺时针角生成 ENU 足迹，再复用
 * classification 的 shadow-volume 管线投射到地形、3D Tiles 或二者表面。
 * PNG 原始 alpha 与 fillOpacity 在着色器中相乘，不生成背景矩形或描边。
 */
export class CesiumGroundImagePrimitive {
	public readonly group: Group;
	public readonly classification: CesiumClassificationPrimitive;
	public readonly imageUrl: string;
	public readonly imageWidth: number;
	public readonly imageHeight: number;
	public readonly rotation: number;

	private readonly textureHandle: ImageTextureHandle;
	private readonly defaultMaterial: CesiumGroundMaterial;
	private readonly opacityUniform: IUniform<number>;
	private disposed = false;

	/** 校验公共参数、获取共享纹理并一次性建立不依赖图片解码尺寸的地面足迹。 */
	public constructor( options: CesiumGroundImagePrimitiveOptions ) {
		const longitude = options.position?.[ 0 ];
		const latitude = options.position?.[ 1 ];
		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ||
			longitude < - 180.0 || longitude > 180.0 || latitude < - 90.0 || latitude > 90.0 ) {
			throw new Error( 'Ground image position must be a valid WGS84 [lon, lat] point.' );
		}

		this.imageUrl = options.imageUrl.trim();
		this.imageWidth = requirePositive( options.imageWidth, 'imageWidth' );
		this.imageHeight = requirePositive( options.imageHeight, 'imageHeight' );
		this.rotation = Number.isFinite( options.rotation ) ? options.rotation ?? 0.0 : 0.0;
		this.textureHandle = acquireImageTexture( this.imageUrl );
		this.defaultMaterial = createTexturedDecalMaterial( {
			texture: this.textureHandle.texture,
			opacity: normalizeOpacity( options.fillOpacity ),
			flipY: true,
		} );
		this.opacityUniform = this.defaultMaterial.uniforms.u_opacity as IUniform<number>;

		try {
			const footprint = computeTexturedDecalFootprint( {
				anchorLonDegrees: longitude,
				anchorLatDegrees: latitude,
				widthMeters: this.imageWidth,
				heightMeters: this.imageHeight,
				rotationRadians: this.rotation * DEG_TO_RAD,
			} );
			const geometry = buildTexturedDecalShadowVolumeGeometry( {
				swEcef: footprint.swEcef,
				seEcef: footprint.seEcef,
				neEcef: footprint.neEcef,
				nwEcef: footprint.nwEcef,
				minimumHeight: options.minimumHeight,
				maximumHeight: options.maximumHeight,
			} );
			this.classification = new CesiumClassificationPrimitive(
				geometry,
				computeTexturedDecalPlanarExtents( footprint ),
				new Color( 1.0, 1.0, 1.0 ),
				1.0,
				options.renderOrder ?? 10,
				options.fragmentCull ?? true,
				{
					useMaterialPipeline: true,
					primitiveKind: 'decal',
					defaultMaterial: this.defaultMaterial,
					appearance: options.appearance,
				},
			);
		} catch ( error ) {
			this.textureHandle.release();
			throw error;
		}

		this.classification.setClassificationType( options.classificationType );
		this.group = this.classification.group;
		this.group.name = 'CesiumGroundImagePrimitive';
		this.group.visible = options.visible !== false;
	}

	/** 每帧把深度纹理、相机和视口状态转发给 classification 命令。 */
	public update( frameState: CesiumGroundFrameState ): void {
		this.ensureActive();
		this.classification.update( frameState );
	}

	/** 只更新渲染顺序，不重建几何或纹理。 */
	public setRenderOrder( renderOrder: number ): void {
		this.ensureActive();
		this.classification.setRenderOrder( renderOrder );
	}

	/** 在 TERRAIN、CESIUM_3D_TILE 和 BOTH 间轻量切换。 */
	public setClassificationType( classificationType?: ClassificationType ): void {
		this.ensureActive();
		this.classification.setClassificationType( classificationType );
	}

	/** Returns the exact logical Appearance bound to the decal color pass. */
	public get appearance(): CesiumGroundAppearance {
		return this.classification.appearance;
	}

	/** Atomically switches only the decal color Appearance; geometry and texture stay put. */
	public setAppearance( appearance?: CesiumGroundAppearance ): void {
		this.ensureActive();
		this.classification.setAppearance( appearance );
	}

	/** 设置场景节点显隐。 */
	public setVisible( visible: boolean ): void {
		this.ensureActive();
		this.group.visible = visible;
	}

	/** 更新 0..100 图片透明度；原始图片 alpha 始终保留。 */
	public setOpacity( fillOpacity: number ): void {
		this.ensureActive();
		this.opacityUniform.value = normalizeOpacity( fillOpacity );
	}

	/** 释放分类几何并归还共享纹理引用。 */
	public dispose(): void {
		if ( this.disposed ) return;
		this.disposed = true;
		this.classification.dispose();
		this.textureHandle.release();
	}

	private ensureActive(): void {
		if ( this.disposed ) {
			throw new Error( 'CesiumGroundImagePrimitive: instance already disposed.' );
		}
	}
}

/** 校验图片的显式米制宽高。 */
function requirePositive( value: number, field: string ): number {
	if ( ! Number.isFinite( value ) || value <= 0.0 ) {
		throw new Error( `Ground image ${ field } must be a positive finite number.` );
	}
	return value;
}

/** 将公共 API 的 0..100 百分比转换为着色器 0..1 opacity。 */
function normalizeOpacity( value: number ): number {
	if ( ! Number.isFinite( value ) ) return 1.0;
	return Math.min( Math.max( value, 0.0 ), 100.0 ) / 100.0;
}
