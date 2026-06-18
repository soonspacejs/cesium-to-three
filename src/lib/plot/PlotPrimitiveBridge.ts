// ============================================================
// PlotPrimitiveBridge.ts 鈥?鏍囩粯鏁版嵁妯″瀷 鈫?Stencil Shadow Volume 鍥惧厓妗ユ帴鍣?// 灞傜骇锛歱lot 娓叉煋妗ユ帴锛坈esium-to-three 绉佹湁锛岀瓑浠蜂簬鍙傝€冮」鐩殑 PlotSdfPlugin锛?// 鑱岃矗锛氭秷璐?GroundDecalManager 浜や粯鐨?Map<id, GisPlot*>锛?//       涓烘瘡涓爣缁樼淮鎶や竴涓?CesiumGround*Primitive 骞舵寕鍒?scene锛?//       鍑犱綍鍙樻洿閲嶅缓銆佷粎鏍峰紡 / 鍙鎬у彉鏇磋蛋杞婚噺鍒锋柊锛?//       姣忓抚鎶?frameState 閫忎紶缁欐墍鏈夊浘鍏冦€?// 渚濊禆锛?//   - src/lib/ground 鍚?Primitive + 绫诲瀷锛?//   - src/lib/ground/text 鏂囧瓧鍥惧厓锛?//   - src/lib/plot/plugins 鏁版嵁妯″瀷锛?//   - ./plot-order plotOrderToRenderOrder銆?// 琚秷璐癸細GroundDecalManager锛堟敞鍏ワ紝绛変环 PlotSdfPlugin锛夈€佸涓绘覆鏌撳惊鐜紙update锛夈€?//
// 鍗忚锛堜笌鍙傝€冮」鐩?PlotSdfPlugin 涓€鑷达級锛?//   - set shapes( Map<string, GisPlotBase> ) / get shapes()
//   - get / set opacity( number )锛?..1 閽充綅锛?//   - redraw(): void
//   - dispose(): void
//
// 棰濆锛坈2t 澧為噺锛夛細
//   - update( frameState ): void 鈥斺€?姣忓抚鎶?frameState 閫忎紶缁欐墍鏈夊浘鍏冦€?//
// 鍚屾绛栫暐锛坮edraw锛夛細
//   鈶?鍒犻櫎锛歘shapes 涓凡涓嶅瓨鍦ㄧ殑 entry 鈫?绉婚櫎骞?dispose锛?//   鈶?鏂板/鏇存柊锛氶亶鍘?_shapes锛堜繚鎸佹彃鍏ュ簭锛夛紝鎸夊簭鍒嗛厤 plotOrder 鈫?renderOrder锛?//       - 鍑犱綍 + 鏍峰紡绛惧悕閮芥湭鍙?鈫?杞婚噺鍒锋柊锛堝彲瑙佹€?/ renderOrder + 鎶樼嚎/鏂囧瓧鐑洿鏂帮級锛?//       - 鍚﹀垯閿€姣佹棫鍥惧厓銆侀噸寤烘柊鍥惧厓銆佹寕鍥炲満鏅€?// ============================================================

import type { Group, Scene } from 'three';

import {
	CesiumGroundCirclePrimitive,
	CesiumGroundPointPrimitive,
	CesiumGroundPolygonPrimitive,
	CesiumGroundPolylinePrimitive,
} from '../ground';
import { CesiumGroundTextPrimitive } from '../ground/text';
import type {
	CesiumGroundArrowMode,
	CesiumGroundArrowStyle,
	CesiumGroundFrameState,
	LonLatPoint,
} from '../ground';

import type { GisPlotBase } from './plugins/base';
import type { GisPlotArrow } from './plugins/arrow';
import type { GisPlotText } from './plugins/text';
import type {
	PlotArrowOptions,
	PlotCircleOptions,
	PlotLineOptions,
	PlotPointOptions,
	PlotSectorOptions,
	PlotTextOptions,
} from './plugins/types';

import { plotOrderToRenderOrder } from './plot-order';
import { createPlainPlotPrimitive, PlainPlotPrimitive } from './PlainPlotPrimitive';

/**
 * 妗ユ帴鍣ㄦ瀯閫犻€夐」銆? */
export interface PlotPrimitiveBridgeOptions {
	/** 鏍囩粯鍥惧厓鎸傝浇鐨勭洰鏍囧満鏅€?*/
	scene: Scene;
}

/** 妗ユ帴鍣ㄦ敮鎸佺殑鍏ㄩ儴 c2t 娓叉煋鍥惧厓鑱斿悎銆?*/
type AnyGroundPrimitive =
	| CesiumGroundPointPrimitive
	| CesiumGroundPolylinePrimitive
	| CesiumGroundPolygonPrimitive
	| CesiumGroundCirclePrimitive
	| CesiumGroundTextPrimitive;

/**
 * 桥接器可持有的全部渲染图元：贴地路径的 CesiumGround*（classification / 折线 / 文字）
 * 与不贴地路径的 PlainPlotPrimitive。两条路径共享同一套 PlotEntry 生命周期管理
 * （resolveGroup / update / dispose / setRenderOrder / 可见性），按 clampToGround 分流。
 */
type AnyPlotPrimitive = AnyGroundPrimitive | PlainPlotPrimitive;

/**
 * 鍗曟潯鏍囩粯鍦ㄦˉ鎺ュ櫒鍐呴儴鐨勮褰曘€? *   - signature      鍑犱綍绛惧悕锛岀敤浜庡垽瀹氬嚑浣曟槸鍚﹀彉鍖栥€佹槸鍚﹂渶瑕侀噸寤哄浘鍏冦€? *   - styleSignature 鏍峰紡绛惧悕锛堥鑹?/ 涓嶉€忔槑搴?/ strokeWidth + 鍏ㄥ眬 opacity锛夛紝
 *                    闈㈢被鏃?setColor 鈫?棰滆壊鍙樺寲绾冲叆绛惧悕璧伴噸寤猴紱鎶樼嚎 / 鏂囧瓧
 *                    璧扮儹鏇存柊锛堜粛绾冲叆绛惧悕锛屼究浜庡悗缁瓥鐣ヤ竴鑷村寲锛夈€? */
interface PlotEntry {
	plot: GisPlotBase;
	primitive: AnyPlotPrimitive;
	group: Group;
	signature: string;
	styleSignature: string;
}

/**
 * 鍙栧嚭鍥惧厓搴旀寕鍒板満鏅殑 Group銆? * 鎶樼嚎涓庢枃瀛楀浘鍏冭嚜韬毚闇?group锛涘叾浣欙紙鐐?/ 澶氳竟褰?/ 鍦?/ 鎵?/ 鐭╁舰 / 绠ご锛? * 缁?classification 璐村湴锛屾寕 primitive.classification.group銆? *
 * @param primitive 浠绘剰 c2t 璐村湴鍥惧厓銆? * @returns         搴旇 scene.add 鐨?THREE.Group銆? */
function resolveGroup( primitive: AnyPlotPrimitive ): Group {
	// 不贴地图元自身就是一个 Group 持有者，直接取其 group。
	if ( primitive instanceof PlainPlotPrimitive ) {
		return primitive.group;
	}
	if ( primitive instanceof CesiumGroundPolylinePrimitive ) {
		return primitive.group;
	}
	if ( primitive instanceof CesiumGroundTextPrimitive ) {
		return primitive.group;
	}
	return ( primitive as CesiumGroundPolygonPrimitive ).classification.group;
}

/**
 * 璁＄畻鏍囩粯鐨勫嚑浣曠鍚嶃€傚彧鍖呭惈褰卞搷鍑犱綍閲嶅缓鐨勫瓧娈碉紙椤剁偣 / 鍗婂緞 / 瑙掑害 / arrowType /
 * 鏂囧瓧鎺掔増绛夛級锛屼笉鍚函鏍峰紡瀛楁锛堥鑹?/ 涓嶉€忔槑搴?/ renderOrder锛夛紝渚夸簬鏍峰紡 /
 * 鍙鎬у彉鏇磋蛋杞婚噺鍒锋柊銆佸嚑浣曞彉鏇存墠閲嶅缓銆? *
 * @param plot 鏁版嵁妯″瀷銆? * @returns    绋冲畾瀛楃涓茬鍚嶃€? */
function geometrySignature( plot: GisPlotBase ): string {
	const o = plot.options as Record<string, unknown>;
	const pts = JSON.stringify( o.points ?? [] );
	switch ( plot.category ) {

		case 'circle':
			return `circle|${ pts }|${ o.radius }`;

		case 'sector':
			return `sector|${ pts }|${ o.radius }|${ o.startAngle }|${ o.sectorAngle }`;

		case 'point':
			return `point|${ pts }|${ o.pointStyle }|${ o.size }`;

		case 'arrow':
			// 箭头体型(sizeScale 对全类型生效 + 曲线专属体型字段)影响几何 →
			// 必须进签名,否则 GUI 改大小时 geomSig 不变 → 桥接器只做轻量样式刷新、
			// 不重算 generateCoords → 改了没反应(踩过的坑)。
			return `arrow|${ pts }|${ o.arrowType }|${ o.sizeScale }`
				+ `|${ o.curvedBodyWidthFactor }|${ o.curvedHeadWidthFactor }`
				+ `|${ o.curvedHeadLengthFactor }`;

		case 'line':
			return `line|${ pts }|${ o.strokeStyle }|${ o.startArrowStyle }|${ o.endArrowStyle }`;

		case 'text':
			return `text|${ pts }|${ o.content }|${ o.fontSize }|${ o.textAlign }|${ o.verticalAlign }|${ o.anchorX }|${ o.anchorY }|${ o.layoutDirection }|${ o.rotation }|${ o.boxWidth }|${ o.boxHeight }|${ JSON.stringify( o.padding ) }|${ o.offsetX }|${ o.offsetY }|${ o.scale }`;

		default:
			return `${ plot.category }|${ pts }`;
	}
}

/**
 * 计算"贴地模式签名"，并入几何签名前缀，使切换 clampToGround / 修改不贴地高度时
 * 必然触发整图元重建（两条渲染路径产出的图元类型不同，不能走轻量刷新）。
 *   - 贴地（clampToGround !== false）：返回固定 'ground'，与 heightMeters 无关
 *     （贴地路径忽略高度，故移动高度滑杆不会让贴地图元做无谓重建）。
 *   - 不贴地（clampToGround === false）：返回 'plain|<heightMeters>'，高度变化即重建。
 *
 * @param plot 数据模型。
 * @returns    稳定的模式签名前缀。
 */
function clampModeSignature( plot: GisPlotBase ): string {
	const o = plot.options as { clampToGround?: boolean; heightMeters?: number };
	if ( o.clampToGround === false ) {
		return `plain|${ o.heightMeters ?? '' }`;
	}
	return 'ground';
}

/**
 * 璁＄畻鏍囩粯鐨勬牱寮忕鍚嶃€傚寘鍚鑹?/ 涓嶉€忔槑搴?/ strokeWidth 涓庡叏灞€ opacity銆? * 闈㈢被锛坮ectangle / polygon / circle / sector / point / arrow锛夋棤 setColor 鈫? * 鏍峰紡鍙樺寲绾冲叆绛惧悕璧伴噸寤猴紱鎶樼嚎 / 鏂囧瓧绛惧悕鍙樺寲鏃惰蛋鐑洿鏂帮紙浠嶇撼鍏ョ鍚嶈
 * 姣旇緝閫昏緫绠€鍗曚竴鑷达級銆? *
 * @param plot          鏁版嵁妯″瀷銆? * @param globalOpacity 鍏ㄥ眬 opacity锛?..1锛夈€? * @returns             绋冲畾瀛楃涓茬鍚嶃€? */
/**
 * 鐢辨姌绾?strokeWidth锛堢背锛夋寜姣斾緥绠楀嚭 c2t 鎶樼嚎绔偣绠ご鐨勭背绾у昂瀵搞€? * 缁忛獙姣斾緥锛氱澶撮暱搴?= 绾垮 脳 4锛岀澶村簳瀹?= 绾垮 脳 3锛涘苟璁炬渶灏忓€奸伩鍏嶆瀬缁嗙嚎涓嬬澶存秷澶便€? *
 * @param strokeWidthMeters 鎶樼嚎瀹藉害锛堢背锛夈€? * @returns                 绠ご lengthMeters / widthMetersArrow锛堢背锛夈€? */
function arrowSizeFromStrokeMeters( strokeWidthMeters: number ): {
	lengthMeters: number;
	widthMetersArrow: number;
} {
	const lengthMeters = Math.max( strokeWidthMeters * 4, 1 );
	const widthMetersArrow = Math.max( strokeWidthMeters * 3, 0.8 );
	return { lengthMeters, widthMetersArrow };
}

function styleSignature( plot: GisPlotBase, globalOpacity: number ): string {
	const o = plot.options as Record<string, unknown>;
	return (
		`${ o.strokeColor }|${ o.strokeWidth }|${ o.strokeOpacity }|` +
		`${ o.fillColor }|${ o.fillOpacity }|${ globalOpacity }|` +
		`${ ( o as { fontColor?: string } ).fontColor ?? '' }|` +
		`${ ( o as { fontSize?: number } ).fontSize ?? '' }`
	);
}

/**
 * 鏍囩粯鍥惧厓妗ユ帴鍣細鎶?Map<id, GisPlot*> 鍚屾涓轰竴缁?CesiumGround*Primitive銆? */
export class PlotPrimitiveBridge {

	/** 鏍囩粯 id 鈫?娓叉煋璁板綍銆?*/
	private readonly _entries = new Map<string, PlotEntry>();

	/** 鐢?GroundDecalManager 鍐欏叆鐨勬爣缁橀泦鍚堬紙寮曠敤鍏变韩锛夈€?*/
	private _shapes: Map<string, GisPlotBase> = new Map();

	/** 鍏ㄥ眬涓嶉€忔槑搴︼紙0..1锛夛紱鍐欏叆鍚庝笅娆?redraw 鐢熸晥銆?*/
	private _opacity = 1;

	/** 鎸傝浇鍦烘櫙銆?*/
	private readonly _scene: Scene;

	/** 宸查噴鏀炬爣璁般€?*/
	private _disposed = false;

	/**
	 * @param options 妗ユ帴鍣ㄦ瀯閫犻€夐」銆?	 */
	public constructor( options: PlotPrimitiveBridgeOptions ) {
		this._scene = options.scene;
	}

	// 鈹€鈹€ 涓?PlotSdfPlugin 涓€鑷寸殑鍗忚 鈹€鈹€

	/** 鎺ユ敹 GroundDecalManager 浜や粯鐨?Map锛堜笌 PlotSdfPlugin.shapes 鍗忚涓€鑷达級銆?*/
	public set shapes( value: Map<string, GisPlotBase> ) {
		this._shapes = value;
	}

	/** 褰撳墠鎸佹湁鐨勬爣缁橀泦鍚堬紙寮曠敤锛屼笌 GroundDecalManager._items 鍚屼竴锛夈€?*/
	public get shapes(): Map<string, GisPlotBase> {
		return this._shapes;
	}

	/** 鍏ㄥ眬涓嶉€忔槑搴︼紙涓?PlotSdfPlugin.opacity 鍗忚涓€鑷达級锛屽啓鍏ユ椂閽冲埌 [0, 1]銆?*/
	public set opacity( value: number ) {
		if ( ! Number.isFinite( value ) ) {
			this._opacity = 1;
			return;
		}
		this._opacity = Math.min( Math.max( value, 0 ), 1 );
	}

	public get opacity(): number {
		return this._opacity;
	}

	/**
	 * 鎶?_shapes 鍚屾鎴愬浘鍏冮泦鍚堬細鍒犻櫎娑堝け鐨勩€佹柊澧炴病鏈夌殑銆佸嚑浣?/ 鏍峰紡鍙樺寲鐨勯噸寤恒€?	 * 浠呭彲瑙佹€?/ renderOrder 鍙樺寲鐨勮交閲忓埛鏂般€備笌 PlotSdfPlugin.redraw 鍗忚涓€鑷淬€?	 */
	public redraw(): void {
		if ( this._disposed ) {
			return;
		}

		for ( const [ id, entry ] of this._entries ) {
			if ( ! this._shapes.has( id ) ) {
				this._scene.remove( entry.group );
				entry.primitive.dispose();
				this._entries.delete( id );
			}
		}

		let plotOrder = 0;
		for ( const [ id, plot ] of this._shapes ) {
			const renderOrder = plotOrderToRenderOrder( plotOrder );
			plotOrder += 1;

			const existing = this._entries.get( id );
			const geomSig = `${ clampModeSignature( plot ) }|${ geometrySignature( plot ) }`;
			const styleSig = styleSignature( plot, this._opacity );

			if (
				existing !== undefined &&
				existing.signature === geomSig &&
				( this._supportsStyleHotUpdate( existing.primitive ) ||
					existing.styleSignature === styleSig )
			) {
				this._refreshLightweight( existing, renderOrder );
				existing.styleSignature = styleSig;
				continue;
			}

			if ( existing !== undefined ) {
				this._scene.remove( existing.group );
				existing.primitive.dispose();
				this._entries.delete( id );
			}

			const primitive = this._buildPrimitive( plot, renderOrder );
			if ( primitive === null ) {
				continue;
			}
			const group = resolveGroup( primitive );
			group.visible = plot.options.visible !== false;
			this._scene.add( group );
			const entry: PlotEntry = {
				plot,
				primitive,
				group,
				signature: geomSig,
				styleSignature: styleSig,
			};
			this._entries.set( id, entry );

			if ( primitive instanceof CesiumGroundTextPrimitive ) {
				this._refreshLightweight( entry, renderOrder );
			}
		}
	}

	/**
	 * 瀹夸富姣忓抚璋冪敤锛氭妸 frameState 閫忎紶缁欐墍鏈夊浘鍏冿紙娣卞害 + 瑙嗗彛 + 鐩告満 + pixelRatio锛夈€?	 *
	 * @param frameState 褰撳墠甯х姸鎬併€?	 */
	public update( frameState: CesiumGroundFrameState ): void {
		if ( this._disposed ) {
			return;
		}
		for ( const entry of this._entries.values() ) {
			entry.primitive.update( frameState );
		}
	}

	/** 閲婃斁鍏ㄩ儴鍥惧厓涓庡満鏅寕杞姐€備笌 PlotSdfPlugin.dispose 鍗忚涓€鑷淬€?*/
	public dispose(): void {
		if ( this._disposed ) {
			return;
		}
		for ( const entry of this._entries.values() ) {
			this._scene.remove( entry.group );
			entry.primitive.dispose();
		}
		this._entries.clear();
		this._disposed = true;
	}

	// 鈹€鈹€ 鍐呴儴锛氳交閲忓埛鏂?/ 鏍峰紡鐑洿鏂版敮鎸佸垽瀹?鈹€鈹€

	/**
	 * 褰撳墠鍥惧厓鏄惁鏀寔鏍峰紡鐑洿鏂帮紙棰滆壊 / 鎻忚竟绛夛級銆?	 * 鎶樼嚎锛坰etColor / setWidth锛変笌鏂囧瓧锛坰etText锛夋敮鎸侊紱闈㈢被涓嶆敮鎸侊紝闇€閲嶅缓銆?	 *
	 * @param primitive 娓叉煋鍥惧厓銆?	 * @returns         true 琛ㄧず鏍峰紡鍙樺寲涔熷彲浠ヨ蛋杞婚噺鍒锋柊銆?	 */
	private _supportsStyleHotUpdate( primitive: AnyPlotPrimitive ): boolean {
		return (
			primitive instanceof CesiumGroundPolylinePrimitive ||
			primitive instanceof CesiumGroundTextPrimitive
		);
	}

	/**
	 * 鍑犱綍鏈彉鏃剁殑杞婚噺鍒锋柊锛?	 *   - 鎵€鏈夊浘鍏冿細group.visible + setRenderOrder銆?	 *   - 鎶樼嚎锛歴etColor / setWidth / setVisible锛堜笉閲嶅缓鍑犱綍锛夈€?	 *   - 鏂囧瓧锛歴etText锛堝唴瀹?+ 棰滆壊 + 涓嶉€忔槑搴︼級/ setVisible锛堜笉閲嶅缓鍥惧厓锛夈€?	 *
	 * @param entry       鐜版湁娓叉煋璁板綍銆?	 * @param renderOrder 鐢辨彃鍏ュ簭鎹㈢畻鐨勬覆鏌撻『搴忋€?	 */
	private _refreshLightweight( entry: PlotEntry, renderOrder: number ): void {
		entry.group.visible = entry.plot.options.visible !== false;

		( entry.primitive as { setRenderOrder?( n: number ): void } )
			.setRenderOrder?.( renderOrder );

		if ( entry.primitive instanceof CesiumGroundPolylinePrimitive ) {
			const o = entry.plot.options as PlotLineOptions;
			entry.primitive.setColor(
				o.strokeColor,
				( o.strokeOpacity ?? 100 ) * this._opacity,
			);
			const widthMeters = typeof o.strokeWidth === 'number' && o.strokeWidth > 0
				? o.strokeWidth
				: 5;
			entry.primitive.setWidth( widthMeters );
			const { lengthMeters, widthMetersArrow } = arrowSizeFromStrokeMeters( widthMeters );
			entry.primitive.setArrowSizeMeters( lengthMeters, widthMetersArrow );
			entry.primitive.setVisible( o.visible !== false );
		}

		if ( entry.primitive instanceof CesiumGroundTextPrimitive ) {
			const t = ( entry.plot as GisPlotText ).options;
			entry.primitive.setText( {
				content: t.content,
				fontColor: t.fontColor,
				fontSize: t.fontSize,
				fillColor: t.fillColor,
				fillOpacity: ( t.fillOpacity ?? 100 ) * this._opacity,
				strokeColor: t.strokeColor,
				strokeOpacity: ( t.strokeOpacity ?? 100 ) * this._opacity,
				strokeWidth: t.strokeWidth,
				textAlign: t.textAlign,
				verticalAlign: t.verticalAlign,
				anchorX: t.anchorX,
				anchorY: t.anchorY,
				layoutDirection: t.layoutDirection,
				rotation: t.rotation,
				boxWidth: t.boxWidth,
				boxHeight: t.boxHeight,
				padding: t.padding,
				showBorder: t.showBorder,
				offsetEastMeters: t.offsetX,
				offsetNorthMeters: t.offsetY,
				metersPerPixel: t.scale,
			} );
			entry.primitive.setVisible( t.visible !== false );
			entry.group = resolveGroup( entry.primitive );
			entry.group.visible = t.visible !== false;
		}
	}

	// 鈹€鈹€ 鍐呴儴锛氭寜 category 鏋勫缓鍥惧厓 鈹€鈹€

	/**
	 * 鎸?category 瀹炰緥鍖栧搴?c2t 鍥惧厓銆傜粺涓€閫忎紶 stroke/fill 棰滆壊涓?0..100 涓嶉€忔槑搴︼紝
	 * 骞舵寜鍏ㄥ眬 opacity 鎶樼畻锛堝湪 0..100 鍙ｅ緞涓婁箻 this._opacity锛夈€?	 *
	 * @param plot        鏁版嵁妯″瀷銆?	 * @param renderOrder 鐢辨彃鍏ュ簭鎹㈢畻鐨勬覆鏌撻『搴忋€?	 * @returns           娓叉煋鍥惧厓锛涙湭鐭ョ被鍨?/ 閫€鍖栨儏鍐佃繑鍥?null銆?	 */
	private _buildPrimitive(
		plot: GisPlotBase,
		renderOrder: number,
	): AnyPlotPrimitive | null {
		// 不贴地分流：clampToGround === false 时走普通 Three 图元路径
		// （PlainPlotPrimitive），在 options.heightMeters 高度成面 / 线 / 字，完全不依赖
		// 贴地深度纹理与 stencil。默认（undefined / true）仍走下方 CesiumGround* 贴地路径，
		// 既有行为零变化。
		if ( ( plot.options as { clampToGround?: boolean } ).clampToGround === false ) {
			return createPlainPlotPrimitive( plot, renderOrder, this._opacity );
		}

		const base = plot.options;
		const pts = ( base.points ?? [] ) as LonLatPoint[];
		const g = this._opacity;
		const strokeOpacity = ( base.strokeOpacity ?? 100 ) * g;
		const fillOpacity = ( base.fillOpacity ?? 100 ) * g;
		const visible = base.visible !== false;

		switch ( plot.category ) {

			case 'point': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotPointOptions;
				return new CesiumGroundPointPrimitive( {
					classificationType: base.classificationType,
					position: pts[ 0 ],
					shape: o.pointStyle ?? 'circle',
					size: o.size ?? 100,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'circle': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotCircleOptions;
				return new CesiumGroundCirclePrimitive( {
					classificationType: base.classificationType,
					center: pts[ 0 ],
					radius: o.radius ?? 100,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'sector': {
				if ( pts.length === 0 ) return null;
				const o = base as PlotSectorOptions;
				return new CesiumGroundCirclePrimitive( {
					classificationType: base.classificationType,
					center: pts[ 0 ],
					radius: o.radius ?? 100,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					sectorStartDegrees: o.startAngle ?? 0,
					sectorAngleDegrees: o.sectorAngle ?? 360,
					renderOrder,
				} );
			}

			case 'polygon':
			case 'rectangle': {
				if ( pts.length < 3 ) return null;
				return new CesiumGroundPolygonPrimitive( {
					classificationType: base.classificationType,
					points: pts,
					strokeColor: base.strokeColor,
					strokeWidth: base.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: base.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'arrow': {
				const coords = ( plot as GisPlotArrow ).generateCoords() as LonLatPoint[];
				if ( coords.length < 3 ) {
					return null;
				}
				const o = base as PlotArrowOptions;
				return new CesiumGroundPolygonPrimitive( {
					classificationType: base.classificationType,
					points: coords,
					strokeColor: o.strokeColor,
					strokeWidth: o.strokeWidth ?? 0,
					strokeOpacity,
					fillColor: o.fillColor,
					fillOpacity,
					visible,
					renderOrder,
				} );
			}

			case 'line': {
				if ( pts.length < 2 ) return null;
				const o = base as PlotLineOptions;
				const start = o.startArrowStyle ?? null;
				const end = o.endArrowStyle ?? null;
				const arrowMode: CesiumGroundArrowMode =
					( start !== null && end !== null ) ? 'both'
						: ( end !== null ) ? 'right'
							: ( start !== null ) ? 'left'
								: 'none';
				// 起 / 终端各自映射样式——**不再用 `start ?? end` 折叠成一个样式**
				// （那会让 filledArrow + unfilledArrow 两端渲染成同一种箭头）。
				// 未启用的那端样式无所谓（arrowMode 不含该端就不渲染），给 'solid' 占位。
				const startArrowStyle: CesiumGroundArrowStyle =
					start === 'unfilledArrow' ? 'open' : 'solid';
				const endArrowStyle: CesiumGroundArrowStyle =
					end === 'unfilledArrow' ? 'open' : 'solid';
				const isDash = o.strokeStyle === 'dashed';
				const dashLengthMeters = isDash ? 60 : undefined;
				const gapLengthMeters = isDash ? 40 : undefined;
				const widthMeters = typeof o.strokeWidth === 'number' && o.strokeWidth > 0
					? o.strokeWidth
					: 5;
				const { lengthMeters, widthMetersArrow } = arrowSizeFromStrokeMeters( widthMeters );
				return new CesiumGroundPolylinePrimitive( {
					classificationType: base.classificationType,
					points: pts,
					strokeColor: o.strokeColor,
					strokeOpacity,
					widthMode: 'world',
					widthMeters,
					visible,
					arrowMode,
					startArrowStyle,
					endArrowStyle,
					arrowWidthMode: 'world',
					arrowLengthMeters: lengthMeters,
					arrowWidthMeters: widthMetersArrow,
					dashLengthMeters,
					gapLengthMeters,
					renderOrder,
				} );
			}

			case 'text': {
				if ( pts.length === 0 ) return null;
				const t = base as PlotTextOptions;
				return new CesiumGroundTextPrimitive( {
					classificationType: base.classificationType,
					points: [ pts[ 0 ] ],
					content: t.content,
					fontColor: t.fontColor,
					fontSize: t.fontSize,
					fillColor: t.fillColor,
					fillOpacity,
					strokeColor: t.strokeColor,
					strokeOpacity,
					strokeWidth: t.strokeWidth ?? 0,
					textAlign: t.textAlign,
					verticalAlign: t.verticalAlign,
					anchorX: t.anchorX,
					anchorY: t.anchorY,
					layoutDirection: t.layoutDirection,
					rotation: t.rotation,
					boxWidth: t.boxWidth,
					boxHeight: t.boxHeight,
					padding: t.padding,
					showBorder: t.showBorder,
					visible,
					renderOrder,
					// 鍙傝€冧晶 offsetX / offsetY 鈫?c2t ENU 绫冲亸绉?					offsetEastMeters: t.offsetX,
					offsetNorthMeters: t.offsetY,
					// 鍙傝€冧晶 scale 鈫?c2t metersPerPixel锛堟棤 scale 鏃朵笉浼狅紝c2t 鐢ㄩ粯璁?1.0锛?					metersPerPixel: t.scale,
				} );
			}

			default:
				return null;
		}
	}
}
