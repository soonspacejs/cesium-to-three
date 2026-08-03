import {
	LinearFilter,
	LinearMipmapLinearFilter,
	SRGBColorSpace,
	Texture,
	TextureLoader,
} from 'three';

/** 单个 URL 的 GPU 纹理及当前图元引用状态。 */
interface CacheEntry {
	texture: Texture;
	refCount: number;
	disposeQueued: boolean;
}

/** 调用方持有的纹理租约；release 可重复调用且只生效一次。 */
export interface ImageTextureHandle {
	texture: Texture;
	release(): void;
}

const cache = new Map<string, CacheEntry>();
const warnedUrls = new Set<string>();
const loader = new TextureLoader();

/**
 * 获取 URL 对应的共享纹理。
 *
 * 相同 URL 只创建一次 TextureLoader 请求和 GPU 纹理。最后一个使用者释放时，
 * 销毁工作推迟到微任务末尾；这样 setStyle 同步重建同一 URL 时可以直接复用，
 * 不会产生一次无意义的重新下载与上传。
 */
export function acquireImageTexture( url: string ): ImageTextureHandle {
	const normalizedUrl = url.trim();
	if ( normalizedUrl.length === 0 ) {
		throw new Error( 'Ground image imageUrl must be a non-empty string.' );
	}

	let entry = cache.get( normalizedUrl );
	if ( entry === undefined ) {
		const texture = loader.load(
			normalizedUrl,
			loaded => {
				configureTexture( loaded );
			},
			undefined,
			() => {
				installTransparentFallback( texture );
				if ( ! warnedUrls.has( normalizedUrl ) ) {
					warnedUrls.add( normalizedUrl );
					console.warn( `[cesium-to-three] Failed to load point image: ${ normalizedUrl }` );
				}
			},
		);
		configureTexture( texture );
		entry = { texture, refCount: 0, disposeQueued: false };
		cache.set( normalizedUrl, entry );
	}

	entry.refCount += 1;
	entry.disposeQueued = false;
	let released = false;
	return {
		texture: entry.texture,
		release(): void {
			if ( released ) return;
			released = true;
			entry!.refCount = Math.max( entry!.refCount - 1, 0 );
			if ( entry!.refCount !== 0 || entry!.disposeQueued ) return;
			entry!.disposeQueued = true;
			queueMicrotask( () => {
				if ( entry!.refCount !== 0 || ! entry!.disposeQueued ) return;
				// A release/reacquire/release sequence can leave two callbacks queued
				// for the same entry. Only the callback that still owns the live cache
				// slot may dispose it; later stale callbacks must be inert.
				if ( cache.get( normalizedUrl ) !== entry ) return;
				cache.delete( normalizedUrl );
				entry!.disposeQueued = false;
				entry!.texture.dispose();
			} );
		},
	};
}

/** 设置贴花图片统一的颜色空间、采样、翻转和 mipmap 行为。 */
function configureTexture( texture: Texture ): void {
	texture.minFilter = LinearMipmapLinearFilter;
	texture.magFilter = LinearFilter;
	texture.generateMipmaps = true;
	texture.anisotropy = 16;
	texture.premultiplyAlpha = false;
	texture.flipY = false;
	texture.colorSpace = SRGBColorSpace;
	// TextureLoader 返回后、图片解码完成前 texture.image 仍为空。此时提前置
	// needsUpdate 会让 WebGLRenderer 报“no image data”；加载回调或透明兜底就绪后
	// 再上传即可。
	if ( texture.image != null ) {
		texture.needsUpdate = true;
	}
}

/**
 * 加载失败时把原 Texture 替换为透明 1×1 画布，保持 uniform 引用不变。
 * 服务端渲染环境没有 document，此时 Three 的未完成纹理本身也不会输出颜色。
 */
function installTransparentFallback( texture: Texture ): void {
	if ( typeof document === 'undefined' ) return;
	const canvas = document.createElement( 'canvas' );
	canvas.width = 1;
	canvas.height = 1;
	texture.image = canvas;
	texture.needsUpdate = true;
}
