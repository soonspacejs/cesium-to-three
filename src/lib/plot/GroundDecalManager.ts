// ============================================================
// GroundDecalManager.ts — 地面标绘管理器（cesium-to-three 版）
// 层级：plot 管理器（对外唯一入口）
// 职责：持有 Map<id, GisPlot*>，提供创建 / 删除 / 查询 / 样式与几何编辑，
//       经 requestAnimationFrame 合并变更后驱动 PlotPrimitiveBridge 重画；
//       每帧由宿主调用 update(frameState) 透传深度 / 视口 / 相机。
// 依赖：./plugins（数据模型）、./PlotPrimitiveBridge（渲染桥接）、
//       src/lib/ground（CesiumGroundFrameState）、three（Scene）。
// 被消费：业务层（数据 API）、宿主渲染循环（update）。
//
// 兼容性：数据操作 API 与参考项目逐字一致（addPlot / setStyle / setCoord …）。
//        仅以下几处为 c2t 适配：
//          - 构造参数 { ssp } → { scene }
//          - 渲染插件 → 内置桥接器
//          - 新增 update(frameState) 钩子
//          - render 为 no-op（渲染由宿主统一负责）
// ============================================================

import type { Scene } from 'three';

import type {
	CesiumGroundFrameState,
	CesiumGlobeDepth,
	EllipsoidDepthSourceOptions,
} from '../ground';
import { ClassificationType, EllipsoidDepthSource } from '../ground';

import { GisPlotBase } from './plugins/base';
import {
	GisPlotArrow,
	GisPlotCircle,
	GisPlotLine,
	GisPlotPoint,
	GisPlotPolygon,
	GisPlotRectangle,
	GisPlotSector,
	GisPlotText,
} from './plugins/index';
import type {
	GisPlotArrowSnapshot,
	GisPlotSnapshot,
	LonLatPoint,
	PlotAddOptions,
} from './plugins/types';

import { PlotPrimitiveBridge } from './PlotPrimitiveBridge';

/** 构造 GroundDecalManager 时的选项（c2t 版：注入 scene 而非 SoonSpace）。 */
export type GroundDecalManagerOptions = {
	/** 标绘图元挂载的目标场景。 */
	scene: Scene;
	/**
	 * 可选：packed globe depth 通道。传入后，管理器会自动创建并接入一个
	 * WGS84 椭球面兜底深度源（EllipsoidDepthSource），让贴地标绘在“没有地形
	 * 瓦片覆盖”时依然能渲染（无 Ion Token / 瓦片下载中 / 缩放超过最深 LOD）。
	 * 不传则不接入兜底（宿主需自行保证深度来源）。
	 */
	globeDepth?: CesiumGlobeDepth;
	/**
	 * 可选：椭球面兜底配置（分段数 / 半径 / 偏移），或传 false 显式关闭兜底。
	 * 仅在同时传入 globeDepth 时生效。默认在传入 globeDepth 时启用。
	 */
	ellipsoidFallback?: EllipsoidDepthSourceOptions | false;
};

/** getItem / getItemDeep 的联合返回类型（箭头额外带 generatedCoords）。 */
export type GisPlotItemSnapshot = GisPlotSnapshot | GisPlotArrowSnapshot;

/** 标绘样式补丁：与 GisPlotBase.update 一致，允许基类字段之外的扩展键。 */
export type GisPlotStylePatch =
	Partial<Parameters<GisPlotBase[ 'update' ]>[ 0 ]> & Record<string, unknown>;

/** setCenter 的中心点（lon / lat 均可选；单位度）。 */
export type CenterLonLat = {
	lon?: number;
	lat?: number;
};

/**
 * 地面标绘管理器：与参考项目同名同形，数据 API 逐字保留；
 * 渲染接入收敛到桥接器（PlotPrimitiveBridge）。
 */
export class GroundDecalManager {

	/** 标绘 id → 实例；与桥接器的 shapes 共用同一引用。 */
	private readonly _items = new Map<string, GisPlotBase>();

	/** 标绘管理器 id（对外常量，保持与参考项目一致）。 */
	public readonly id: string = 'GROUND_DECAL_PLOT';

	/** 渲染桥接器（c2t 版顶替参考项目的 PlotSdfPlugin）。 */
	private readonly _bridge: PlotPrimitiveBridge;

	/** 桥接器是否已收到 shapes 引用。 */
	private _overlayAttached = false;

	/** 合并同一帧内多次 _markDirty，值为 requestAnimationFrame 句柄。 */
	private _redrawTimer: number | null = null;

	/** 可选椭球面兜底深度源（仅在构造时传入 globeDepth 才创建）。 */
	private _ellipsoidDepth: EllipsoidDepthSource | null = null;

	/**
	 * @param options 构造选项；仅需 scene。
	 */
	public constructor( options: GroundDecalManagerOptions ) {
		this._bridge = new PlotPrimitiveBridge( { scene: options.scene } );

		// 可选椭球面兜底深度：仅当宿主传入 globeDepth 且未显式关闭时启用。
		// 它把贴地标绘“能否渲染”与“地形是否加载”解耦——无地形时标绘贴到 WGS84
		// 椭球面（海平面）。详见 src/lib/ground/ellipsoid-depth-source.ts。
		if ( options.globeDepth && options.ellipsoidFallback !== false ) {
			const fallbackOptions =
				typeof options.ellipsoidFallback === 'object'
					? options.ellipsoidFallback
					: {};
			this._ellipsoidDepth = new EllipsoidDepthSource( fallbackOptions );
			this._ellipsoidDepth.attach( {
				mainScene: options.scene,
				globeDepth: options.globeDepth,
			} );
		}
	}

	/**
	 * 暴露内部桥接器（替代参考项目的 plotSdfPlugin getter；c2t 桥接器已内置）。
	 *
	 * @returns 桥接器实例。
	 */
	public get bridge(): PlotPrimitiveBridge {
		return this._bridge;
	}

	/**
	 * 兼容参考项目同名 getter：c2t 内置桥接器替代 PlotSdfPlugin。
	 * 业务旧调用 `decals.plotSdfPlugin` 仍能拿到一个具备 shapes / redraw /
	 * opacity / dispose 协议的对象。
	 *
	 * @returns 桥接器实例（与 PlotSdfPlugin 协议同名）。
	 */
	public get plotSdfPlugin(): PlotPrimitiveBridge {
		return this._bridge;
	}

	/**
	 * 暴露内部椭球面兜底深度源（若构造时启用）。便于宿主调 setEllipsoidOffset。
	 *
	 * @returns 兜底深度源；未启用时为 null。
	 */
	public get ellipsoidDepth(): EllipsoidDepthSource | null {
		return this._ellipsoidDepth;
	}

	/** 控制已构建标绘图元是否直接挂载在 Three scene 上。 */
	public setSceneAttached( attached: boolean ): void {
		this._bridge.setSceneAttached( attached );
	}

	public get sceneAttached(): boolean {
		return this._bridge.sceneAttached;
	}

	/**
	 * 兼容参考项目签名：c2t 桥接器已在构造时内置，无需外部注入。
	 * 调用仅触发一次重绘，便于旧业务无感升级。
	 *
	 * @param _plugin 兼容参数，c2t 下被忽略。
	 */
	public setPlotSDFPlugin( _plugin?: unknown ): void {
		this._overlayAttached = false;
		if ( this._items.size > 0 ) {
			this._markDirty();
		}
	}

	// ── 图形创建：返回字符串 id ──

	/**
	 * 添加标绘：由 options.type 决定实例化哪一类 GisPlot*。
	 *
	 * @param options 工厂入参（判别联合）。
	 * @returns       新建标绘的自增字符串 id。
	 * @throws        当 options.type 未知时抛错。
	 */
	public addPlot( options: PlotAddOptions ): string {
		let shape: GisPlotBase;

		switch ( options.type ) {
			case 'point': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotPoint( opts );
				break;
			}
			case 'line': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotLine( opts );
				break;
			}
			case 'polygon': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotPolygon( opts );
				break;
			}
			case 'rectangle': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotRectangle( opts );
				break;
			}
			case 'circle': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotCircle( opts );
				break;
			}
			case 'sector': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotSector( opts );
				break;
			}
			case 'text': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotText( opts );
				break;
			}
			case 'arrow': {
				const { type, ...opts } = options;
				void type;
				shape = new GisPlotArrow( opts );
				break;
			}
			default:
				throw new Error( 'GroundDecalManager.addPlot: unknown type' );
		}

		this._items.set( shape.id, shape );
		this._markDirty();
		return shape.id;
	}

	/**
	 * 按 id 移除标绘；存在并删除成功时触发重绘。
	 *
	 * @param id 标绘 id。
	 */
	public remove( id: string ): void {
		if ( this._items.delete( id ) ) {
			this._markDirty();
		}
	}

	/** 清空全部标绘。 */
	public clear(): void {
		this._items.clear();
		this._markDirty();
	}

	// ── 查询与修改 ──

	/**
	 * 读取标绘浅快照（options 为新对象，points 仍共享引用；箭头附带 generatedCoords）。
	 *
	 * @param id 标绘 id。
	 * @returns  浅快照；id 不存在时返回 null。
	 */
	public getItem( id: string ): GisPlotItemSnapshot | null {
		const shape = this._items.get( id );
		return shape ? ( shape.getSnapshot() as GisPlotItemSnapshot ) : null;
	}

	/**
	 * 读取标绘深快照：points 等嵌套数组被复制；箭头额外深拷贝 generatedCoords。
	 *
	 * @param id 标绘 id。
	 * @returns  深快照；id 不存在时返回 null。
	 */
	public getItemDeep( id: string ): GisPlotItemSnapshot | null {
		const shape = this._items.get( id );
		return shape ? ( shape.getSnapshotDeep() as GisPlotItemSnapshot ) : null;
	}

	/**
	 * 合并更新样式与几何字段（调用对应 GisPlot*.update 做不可变整表替换）。
	 *
	 * @param id    标绘 id。
	 * @param patch 局部补丁（形状需与该 id 的图元类型兼容）。
	 */
	public setStyle( id: string, patch: GisPlotStylePatch ): void {
		const shape = this._items.get( id );
		if ( ! shape ) {
			return;
		}
		shape.update( patch );
		this._markDirty();
	}

	/**
	 * 将第一个顶点设为新的经纬度中心（点 / 矩形中心 / 扇心 / 文字锚点等单中心
	 * 语义）。**就地修改** points[0]（与 update 的不可变风格不同）。
	 *
	 * @param id     标绘 id。
	 * @param center 新的中心点（lon / lat 均可选）。
	 */
	public setCenter( id: string, center: CenterLonLat ): void {
		const shape = this._items.get( id );
		if (
			! shape ||
			! shape.options.points ||
			shape.options.points.length === 0
		) {
			return;
		}
		if ( center.lon !== undefined ) {
			shape.options.points[ 0 ][ 0 ] = center.lon;
		}
		if ( center.lat !== undefined ) {
			shape.options.points[ 0 ][ 1 ] = center.lat;
		}
		this._markDirty();
	}

	/**
	 * 整体替换顶点列表（每项为 [lon, lat]，深拷贝防止外部引用泄漏）。
	 *
	 * @param id     标绘 id。
	 * @param coords 新的顶点列表。
	 */
	public setCoords( id: string, coords: LonLatPoint[] ): void {
		const shape = this._items.get( id );
		if ( ! shape ) {
			return;
		}
		shape.options.points = coords.map(
			( c ) => [ ...c ] as LonLatPoint,
		);
		this._markDirty();
	}

	/**
	 * 修改指定下标顶点；coord 分量为 undefined 表示不改该分量。越界静默返回。
	 *
	 * @param id    标绘 id。
	 * @param index 顶点下标。
	 * @param coord 经度 / 纬度分量（可缺省任一）。
	 */
	public setCoord(
		id: string,
		index: number,
		coord: Partial<LonLatPoint> | [ number?, number? ],
	): void {
		const shape = this._items.get( id );
		if ( ! shape || ! shape.options.points ) {
			return;
		}
		if ( index < 0 || index >= shape.options.points.length ) {
			return;
		}
		if ( coord[ 0 ] !== undefined ) {
			shape.options.points[ index ][ 0 ] = coord[ 0 ] as number;
		}
		if ( coord[ 1 ] !== undefined ) {
			shape.options.points[ index ][ 1 ] = coord[ 1 ] as number;
		}
		this._markDirty();
	}

	/**
	 * 在 index 处插入一个顶点（可插末尾，越界钳位）。插入顶点深拷贝。
	 *
	 * @param id    标绘 id。
	 * @param index 插入位置。
	 * @param coord 新顶点。
	 */
	public insertCoord( id: string, index: number, coord: LonLatPoint ): void {
		const shape = this._items.get( id );
		if ( ! shape || ! shape.options.points ) {
			return;
		}
		const idx = Math.max(
			0,
			Math.min( index, shape.options.points.length ),
		);
		shape.options.points.splice( idx, 0, [ ...coord ] as LonLatPoint );
		this._markDirty();
	}

	/**
	 * 删除指定下标顶点。多边形至少保留 3 点，其余至少 2 点；越界 / 触底静默返回。
	 *
	 * @param id    标绘 id。
	 * @param index 顶点下标。
	 */
	public removeCoord( id: string, index: number ): void {
		const shape = this._items.get( id );
		if ( ! shape || ! shape.options.points ) {
			return;
		}
		if ( index < 0 || index >= shape.options.points.length ) {
			return;
		}
		const minVerts = shape.category === 'polygon' ? 3 : 2;
		if ( shape.options.points.length <= minVerts ) {
			return;
		}
		shape.options.points.splice( index, 1 );
		this._markDirty();
	}

	/**
	 * 对所有顶点做经纬度平移（度），就地修改。
	 *
	 * @param id   标绘 id。
	 * @param dLon 经度增量（度）。
	 * @param dLat 纬度增量（度）。
	 */
	public translateCoords( id: string, dLon: number, dLat: number ): void {
		const shape = this._items.get( id );
		if ( ! shape || ! shape.options.points ) {
			return;
		}
		for ( const p of shape.options.points ) {
			p[ 0 ] += dLon;
			p[ 1 ] += dLat;
		}
		this._markDirty();
	}

	/**
	 * 仅对 category === 'text' 的项更新 options.content。
	 *
	 * @param id   标绘 id。
	 * @param text 新文本内容。
	 */
	public setText( id: string, text: string ): void {
		const shape = this._items.get( id );
		if ( ! shape || shape.category !== 'text' ) {
			return;
		}
		( shape as GisPlotText ).options.content = text;
		this._markDirty();
	}

	/**
	 * 设置整个标绘层的全局不透明度（0..1）。桥接器内部钳位。
	 *
	 * @param opacity 全局不透明度。
	 */
	public setGlobalOpacity( opacity: number ): void {
		this._bridge.opacity = opacity;
		this._markDirty();
	}

	/**
	 * 返回某标绘顶点数。
	 *
	 * @param id 标绘 id。
	 * @returns  顶点数（不存在返回 0）。
	 */
	public getCoordCount( id: string ): number {
		const shape = this._items.get( id );
		if ( ! shape || ! shape.options.points ) {
			return 0;
		}
		return shape.options.points.length;
	}

	/**
	 * 在经纬度平面找离 (lon, lat) 最近的顶点下标（平方距离最小）；无顶点返回 -1。
	 *
	 * @param id  标绘 id。
	 * @param lon 经度。
	 * @param lat 纬度。
	 * @returns   最近顶点下标。
	 */
	public findNearestCoord( id: string, lon: number, lat: number ): number {
		const shape = this._items.get( id );
		if (
			! shape ||
			! shape.options.points ||
			shape.options.points.length === 0
		) {
			return -1;
		}
		let bestIdx = 0;
		let bestDist = Infinity;
		for ( let i = 0; i < shape.options.points.length; i++ ) {
			const dLon = shape.options.points[ i ][ 0 ] - lon;
			const dLat = shape.options.points[ i ][ 1 ] - lat;
			const d = dLon * dLon + dLat * dLat;
			if ( d < bestDist ) {
				bestDist = d;
				bestIdx = i;
			}
		}
		return bestIdx;
	}

	/**
	 * 收集当前所有标绘用到的分类目标集合，供宿主决定每帧渲染哪些深度纹理
	 * （传给 ClassificationDepthManager.renderDepth）。贴地模式
	 * （clampToGround !== false）的标绘才计入；未显式设置 classificationType
	 * 的按默认 BOTH 计。
	 *
	 * @returns 去重后的分类目标集合（可能为空，宿主据此跳过深度渲染）。
	 */
	public collectActiveClassificationTypes(): Set<ClassificationType> {
		const set = new Set<ClassificationType>();
		for ( const shape of this._items.values() ) {
			if ( shape.options.clampToGround === false ) {
				continue; // 不贴地，不消费深度纹理
			}
			set.add( shape.options.classificationType ?? ClassificationType.BOTH );
		}
		return set;
	}

	/**
	 * 返回当前所有标绘的 id 列表（快照，顺序为插入序）。便于宿主遍历批量
	 * setStyle（如 demo 一键切换全部标绘的 classificationType）。
	 *
	 * @returns id 数组。
	 */
	public getAllIds(): string[] {
		return Array.from( this._items.keys() );
	}

	// ── 渲染接入（c2t 适配）──

	/**
	 * 宿主每帧调用：在 globeDepth.render 之后、renderer.render 之前，
	 * 把深度纹理 / 视口 / 相机透传给所有标绘图元。
	 *
	 * @param frameState 当前帧状态（含 depthTexture / width / height / camera /
	 *                   pixelRatio?）。
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		// 在主场景渲染前刷新椭球面兜底的 log-depth uniform（与 frameState.camera
		// 的 near/far 同步）。宿主调用契约：globeDepth.render 之后、renderer.render
		// 之前——此时刷新，主缓冲兜底网格在 renderer.render 时即拿到当帧 uniform。
		this._ellipsoidDepth?.update( frameState.camera );
		this._bridge.update( frameState );
	}

	/**
	 * 参考项目里是 ssp.render()；c2t 渲染由宿主统一 renderer.render，此处为
	 * 兼容钩子（no-op）。保留字段以兼容业务可能存在的 decals.render() 调用。
	 */
	public render = (): void => {
		/* no-op：c2t 渲染由宿主循环负责 */
	};

	/** 释放桥接器内部全部图元与场景挂载（含可选椭球面兜底）。 */
	public dispose(): void {
		this._ellipsoidDepth?.dispose();
		this._ellipsoidDepth = null;
		this._bridge.dispose();
	}

	/**
	 * 标记下一帧重绘；同帧多次调用只调度一次。
	 * 首次有图形时把 _items 交给桥接器（此时 shapes 已有数据，redraw 能正确建图元）。
	 */
	private _markDirty(): void {
		if ( this._redrawTimer !== null ) {
			return;
		}
		this._redrawTimer = requestAnimationFrame( () => {
			this._redrawTimer = null;

			if ( ! this._overlayAttached && this._items.size > 0 ) {
				this._bridge.shapes = this._items;
				this._overlayAttached = true;
			}

			this._bridge.redraw();
		} );
	}
}

export type { PlotAddOptions } from './plugins/types';
