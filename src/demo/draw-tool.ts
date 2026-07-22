// ============================================================
// draw-tool.ts
// 层级:plot-demo 交互工具(仅 demo 使用,不进库)。
// 职责:实现"点击地图绘制箭头"的第一阶段最小闭环:
//        1. 开启拾取后,左键单击地图 → 把屏幕点反投影成 (lon, lat);
//        2. 把拾取到的每个点位追加显示到坐标文本框;
//        3. 选择箭头类型 + 点"确定绘制" → 回调宿主用这些控制点绘制箭头。
//      反投影策略(与渲染所用同一椭球,保证坐标一致):
//        - 先对地形瓦片(tilesRenderer.group)做射线相交,命中真实地形表面;
//        - 未命中(无地形 / 瓦片未加载 / 点到天空外)再退回 WGS84 椭球面相交。
//      命中点统一转换到 tiles group 局部系(= 椭球系)后取经纬度,因此无论
//      group 是否带变换都正确(本 demo 下 group 为单位矩阵,worldToLocal 为恒等)。
// 依赖:Three.js 射线/向量、um-3d-tiles-renderer(TilesRenderer.ellipsoid)、
//      ../lib/ground(LonLatPoint 类型)、../lib/plot(PlotArrowType 类型)。
// 被消费:src/demo/plot-demo.ts(构造一次,onConfirm 接到 GroundDecalManager.addPlot)。
// ============================================================

import {
	type PerspectiveCamera,
	Matrix4,
	Raycaster,
	Vector2,
	Vector3,
	type WebGLRenderer,
} from 'three';
import type { TilesRenderer } from 'um-3d-tiles-renderer';

import type { LonLatPoint } from '../lib/ground';
import type { PlotArrowType } from '../lib/plot';

/** 每种箭头类型的展示标签与最小控制点数(契约见 src/lib/arrow/README.md)。 */
interface ArrowTypeMeta {
	readonly value: PlotArrowType;
	readonly label: string;
	readonly minPoints: number;
}

const ARROW_TYPES: readonly ArrowTypeMeta[] = [
	{ value: 'fine', label: '直箭头 fine', minPoints: 2 },
	{ value: 'assaultDirection', label: '突击方向 assaultDirection', minPoints: 2 },
	{ value: 'attack', label: '进攻箭头 attack', minPoints: 3 },
	{ value: 'swallowtailAttack', label: '燕尾进攻 swallowtailAttack', minPoints: 3 },
	{ value: 'curved', label: '曲线箭头 curved', minPoints: 2 },
];

/** {@link installDrawArrowTool} 的构造选项。 */
export interface DrawArrowToolOptions {
	/** 主渲染器;其 domElement 用于监听指针事件与切换光标。 */
	renderer: WebGLRenderer;
	/** 主透视相机;用于从屏幕 NDC 构造拾取射线。 */
	camera: PerspectiveCamera;
	/** 3D Tiles 渲染器;提供地形 group(射线相交)与 ellipsoid(反投影 / 兜底)。 */
	tilesRenderer: TilesRenderer;
	/**
	 * 点"确定绘制"且控制点数量满足类型要求时回调。宿主据此调用
	 * GroundDecalManager.addPlot 真正绘制箭头。
	 *
	 * @param arrowType 当前下拉框选中的箭头类型。
	 * @param points    已拾取的控制点(至少 minPoints 个)。
	 */
	onConfirm: ( arrowType: PlotArrowType, points: LonLatPoint[] ) => void;
	/** 单击有效地图点后立即完成一幅图片点标绘。未传入时隐藏图片点按钮。 */
	onImagePoint?: ( point: LonLatPoint ) => void;
}

/** {@link installDrawArrowTool} 返回的句柄,便于宿主在需要时拆除工具。 */
export interface DrawArrowToolHandle {
	/** 移除面板、解绑事件、恢复光标。 */
	dispose(): void;
}

/**
 * 把屏幕指针事件反投影为地图经纬度。先打地形,未命中退回 WGS84 椭球面。
 *
 * @returns [lon°, lat°];射线未命中地球(指向天空)时返回 null。
 */
function pickLonLat(
	event: PointerEvent,
	renderer: WebGLRenderer,
	camera: PerspectiveCamera,
	tilesRenderer: TilesRenderer,
	raycaster: Raycaster,
	scratch: { ndc: Vector2; local: Vector3; inverse: Matrix4 },
): LonLatPoint | null {
	const rect = renderer.domElement.getBoundingClientRect();
	scratch.ndc.set(
		( ( event.clientX - rect.left ) / rect.width ) * 2.0 - 1.0,
		- ( ( event.clientY - rect.top ) / rect.height ) * 2.0 + 1.0,
	);
	raycaster.setFromCamera( scratch.ndc, camera );

	// group 矩阵每帧已更新,这里再刷一次确保 worldToLocal / 局部射线精确。
	const group = tilesRenderer.group;
	group.updateMatrixWorld();

	// (1) 先尝试命中真实地形几何;命中点是世界坐标,转入 group 局部系。
	const terrainHits = raycaster.intersectObject( group, true );
	if ( terrainHits.length > 0 ) {
		scratch.local.copy( terrainHits[ 0 ].point );
		group.worldToLocal( scratch.local );
		return cartographicDegrees( tilesRenderer, scratch.local );
	}

	// (2) 退回 WGS84 椭球面:把世界射线变换到 group 局部系后与椭球求交。
	scratch.inverse.copy( group.matrixWorld ).invert();
	const localRay = raycaster.ray.clone().applyMatrix4( scratch.inverse );
	const hit = tilesRenderer.ellipsoid.intersectRay( localRay, scratch.local );
	if ( hit ) {
		return cartographicDegrees( tilesRenderer, hit );
	}

	return null;
}

/**
 * 把 group 局部系(= 椭球系)下的位置转成 [lon°, lat°]。
 * ellipsoid.getPositionToCartographic 返回弧度,这里换算成度。
 */
function cartographicDegrees(
	tilesRenderer: TilesRenderer,
	positionInEllipsoidFrame: Vector3,
): LonLatPoint {
	const carto = tilesRenderer.ellipsoid.getPositionToCartographic(
		positionInEllipsoidFrame,
		{ lat: 0, lon: 0, height: 0 },
	);
	const lon = ( carto.lon * 180.0 ) / Math.PI;
	const lat = ( carto.lat * 180.0 ) / Math.PI;
	return [ lon, lat ];
}

/** 注入面板私有样式(只注入一次)。 */
function installPanelStyle(): void {
	if ( document.getElementById( 'draw-tool-style' ) ) {
		return;
	}
	const style = document.createElement( 'style' );
	style.id = 'draw-tool-style';
	style.textContent = `
		#draw-tool-panel {
			position: fixed;
			left: 16px;
			bottom: 16px;
			width: 300px;
			box-sizing: border-box;
			z-index: 20;
			padding: 12px 14px;
			border: 1px solid rgba( 255, 255, 255, 0.16 );
			border-radius: 8px;
			background: rgba( 5, 7, 10, 0.82 );
			backdrop-filter: blur( 10px );
			box-shadow: 0 16px 52px rgba( 0, 0, 0, 0.34 );
			color: #d8e7f2;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
			font-size: 12px;
		}
		#draw-tool-panel .dt-title {
			font-weight: 700;
			margin-bottom: 10px;
		}
		#draw-tool-panel .dt-row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 8px;
		}
		#draw-tool-panel .dt-row > span { white-space: nowrap; }
		#draw-tool-panel select {
			flex: 1;
			padding: 4px 6px;
			color: inherit;
			background: rgba( 0, 0, 0, 0.3 );
			border: 1px solid rgba( 255, 255, 255, 0.18 );
			border-radius: 4px;
			font: inherit;
		}
		#draw-tool-panel button {
			padding: 6px 10px;
			color: inherit;
			background: rgba( 255, 255, 255, 0.08 );
			border: 1px solid rgba( 255, 255, 255, 0.18 );
			border-radius: 4px;
			font: inherit;
			cursor: pointer;
		}
		#draw-tool-panel button:hover { background: rgba( 255, 255, 255, 0.16 ); }
		#draw-tool-panel button.dt-active {
			background: #2b6cff;
			border-color: #2b6cff;
			color: #fff;
		}
		#draw-tool-panel button.dt-primary {
			background: #1f7a4d;
			border-color: #1f7a4d;
			color: #fff;
		}
		#draw-tool-panel button.dt-primary:hover { background: #259159; }
		#draw-tool-panel #dt-toggle { width: 100%; margin-bottom: 8px; }
		#draw-tool-panel #dt-image-toggle { width: 100%; margin-bottom: 8px; }
		#draw-tool-panel textarea {
			width: 100%;
			min-height: 88px;
			box-sizing: border-box;
			resize: vertical;
			padding: 6px 8px;
			color: #aef0c8;
			background: rgba( 0, 0, 0, 0.32 );
			border: 1px solid rgba( 255, 255, 255, 0.18 );
			border-radius: 4px;
			font-family: "SFMono-Regular", Consolas, monospace;
			font-size: 11px;
			line-height: 1.45;
		}
		#draw-tool-panel .dt-actions {
			display: flex;
			gap: 8px;
			margin: 8px 0 6px;
		}
		#draw-tool-panel .dt-actions button { flex: 1; }
		#draw-tool-panel .dt-hint { color: #8edeb5; margin-bottom: 6px; }
		#draw-tool-panel .dt-status { color: #ffd266; min-height: 16px; }
	`;
	document.head.appendChild( style );
}

/**
 * 安装"点击地图绘制箭头"工具:左下角浮动面板 + 画布拾取 + 确定回调。
 *
 * 拾取仅在"开始拾取"开启时生效,且只接受未拖动的左键单击(位移阈值内),
 * 因此不会干扰 GlobeControls 的旋转 / 缩放 / 平移。
 *
 * @param options 渲染器 / 相机 / tiles 渲染器 / 绘制回调。
 * @returns 句柄(dispose 拆除工具)。
 */
export function installDrawArrowTool(
	options: DrawArrowToolOptions,
): DrawArrowToolHandle {
	const { renderer, camera, tilesRenderer, onConfirm, onImagePoint } = options;

	installPanelStyle();

	// ── 面板 DOM ──
	const oldPanel = document.getElementById( 'draw-tool-panel' );
	oldPanel?.remove();

	const panel = document.createElement( 'div' );
	panel.id = 'draw-tool-panel';
	const optionsHtml = ARROW_TYPES
		.map( ( t ) => `<option value="${ t.value }">${ t.label }</option>` )
		.join( '' );
	panel.innerHTML = `
		<div class="dt-title">点击地图绘制箭头</div>
		<label class="dt-row">
			<span>类型</span>
			<select id="dt-type">${ optionsHtml }</select>
		</label>
		<button id="dt-toggle">开始拾取</button>
		<button id="dt-image-toggle">单击标绘消防栓图片</button>
		<div class="dt-hint" id="dt-hint"></div>
		<textarea id="dt-coords" readonly placeholder="开启拾取后,左键单击地图采集 [lon, lat]"></textarea>
		<div class="dt-actions">
			<button id="dt-undo">撤销</button>
			<button id="dt-clear">清空</button>
			<button id="dt-confirm" class="dt-primary">确定绘制</button>
		</div>
		<div class="dt-status" id="dt-status"></div>
	`;
	document.body.appendChild( panel );

	const typeSelect = panel.querySelector( '#dt-type' ) as HTMLSelectElement;
	const toggleButton = panel.querySelector( '#dt-toggle' ) as HTMLButtonElement;
	const imageToggleButton = panel.querySelector( '#dt-image-toggle' ) as HTMLButtonElement;
	const hintEl = panel.querySelector( '#dt-hint' ) as HTMLElement;
	const coordsArea = panel.querySelector( '#dt-coords' ) as HTMLTextAreaElement;
	const undoButton = panel.querySelector( '#dt-undo' ) as HTMLButtonElement;
	const clearButton = panel.querySelector( '#dt-clear' ) as HTMLButtonElement;
	const confirmButton = panel.querySelector( '#dt-confirm' ) as HTMLButtonElement;
	const statusEl = panel.querySelector( '#dt-status' ) as HTMLElement;

	// ── 状态 ──
	const points: LonLatPoint[] = [];
	let picking = false;
	let imagePicking = false;
	imageToggleButton.hidden = onImagePoint === undefined;

	const raycaster = new Raycaster();
	const scratch = {
		ndc: new Vector2(),
		local: new Vector3(),
		inverse: new Matrix4(),
	};

	// 单击判定:记录 pointerdown 的位置,pointerup 时位移小于阈值才算"点选"。
	let downX = 0;
	let downY = 0;
	let downButton = -1;
	const CLICK_MOVE_THRESHOLD_PX = 6;

	function currentMeta(): ArrowTypeMeta {
		return (
			ARROW_TYPES.find( ( t ) => t.value === typeSelect.value ) ?? ARROW_TYPES[ 0 ]
		);
	}

	function refreshHint(): void {
		const meta = currentMeta();
		hintEl.textContent =
			`需要至少 ${ meta.minPoints } 个点 · 当前 ${ points.length } 个`;
	}

	function refreshCoords(): void {
		coordsArea.value = points
			.map(
				( p, i ) =>
					`${ String( i + 1 ).padStart( 2, ' ' ) }: ` +
					`${ p[ 0 ].toFixed( 6 ) }, ${ p[ 1 ].toFixed( 6 ) }`,
			)
			.join( '\n' );
		// 滚动到底部,始终看到最新点。
		coordsArea.scrollTop = coordsArea.scrollHeight;
		refreshHint();
	}

	function setStatus( message: string ): void {
		statusEl.textContent = message;
	}

	function setPicking( on: boolean ): void {
		picking = on;
		if ( on ) imagePicking = false;
		toggleButton.textContent = on ? '停止拾取' : '开始拾取';
		toggleButton.classList.toggle( 'dt-active', on );
		imageToggleButton.classList.toggle( 'dt-active', imagePicking );
		imageToggleButton.textContent = '单击标绘消防栓图片';
		renderer.domElement.style.cursor = on || imagePicking ? 'crosshair' : '';
		setStatus( on ? '拾取中:左键单击地图采点' : '' );
	}

	/** 图片点模式与箭头多点模式互斥；成功拾取后由事件处理器立即关闭。 */
	function setImagePicking( on: boolean ): void {
		imagePicking = on;
		if ( on ) picking = false;
		toggleButton.textContent = '开始拾取';
		toggleButton.classList.toggle( 'dt-active', picking );
		imageToggleButton.classList.toggle( 'dt-active', on );
		imageToggleButton.textContent = on ? '取消消防栓图片拾取' : '单击标绘消防栓图片';
		renderer.domElement.style.cursor = on || picking ? 'crosshair' : '';
		setStatus( on ? '图片点拾取中:单击地图后立即完成' : '' );
	}

	// ── 事件处理 ──
	function onPointerDown( event: PointerEvent ): void {
		if ( ! picking && ! imagePicking ) return;
		downX = event.clientX;
		downY = event.clientY;
		downButton = event.button;
	}

	function onPointerUp( event: PointerEvent ): void {
		if ( ( ! picking && ! imagePicking ) || downButton !== 0 || event.button !== 0 ) return;
		const moved = Math.hypot( event.clientX - downX, event.clientY - downY );
		downButton = -1;
		if ( moved > CLICK_MOVE_THRESHOLD_PX ) {
			// 视为相机拖拽,不采点。
			return;
		}
		const lonLat = pickLonLat(
			event, renderer, camera, tilesRenderer, raycaster, scratch,
		);
		if ( ! lonLat ) {
			setStatus( '未命中地球表面(指向天空),已忽略' );
			return;
		}
		if ( imagePicking && onImagePoint ) {
			onImagePoint( [ lonLat[ 0 ], lonLat[ 1 ] ] );
			setImagePicking( false );
			setStatus(
				`已标绘消防栓图片:${ lonLat[ 0 ].toFixed( 6 ) }, ${ lonLat[ 1 ].toFixed( 6 ) }`,
			);
			return;
		}

		points.push( lonLat );
		refreshCoords();
		setStatus( `已采集点 ${ points.length }` );
	}

	const canvas = renderer.domElement;
	canvas.addEventListener( 'pointerdown', onPointerDown );
	canvas.addEventListener( 'pointerup', onPointerUp );

	toggleButton.addEventListener( 'click', () => setPicking( ! picking ) );
	imageToggleButton.addEventListener( 'click', () => setImagePicking( ! imagePicking ) );

	typeSelect.addEventListener( 'change', refreshHint );

	undoButton.addEventListener( 'click', () => {
		if ( points.length === 0 ) return;
		points.pop();
		refreshCoords();
		setStatus( '已撤销最后一个点' );
	} );

	clearButton.addEventListener( 'click', () => {
		points.length = 0;
		refreshCoords();
		setStatus( '已清空' );
	} );

	confirmButton.addEventListener( 'click', () => {
		const meta = currentMeta();
		if ( points.length < meta.minPoints ) {
			setStatus( `「${ meta.label }」至少需要 ${ meta.minPoints } 个点` );
			return;
		}
		// 传出副本,避免宿主持有内部数组在后续清空时被改写。
		onConfirm( meta.value, points.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint ) );
		setStatus( `已绘制「${ meta.label }」(${ points.length } 点)` );
		points.length = 0;
		refreshCoords();
	} );

	// 初始呈现。
	refreshCoords();
	setStatus( '' );

	return {
		dispose(): void {
			canvas.removeEventListener( 'pointerdown', onPointerDown );
			canvas.removeEventListener( 'pointerup', onPointerUp );
			canvas.style.cursor = '';
			panel.remove();
		},
	};
}
