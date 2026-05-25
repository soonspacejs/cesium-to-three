// ============================================================
// dom.ts
// 层级:demo 页面 DOM 工具。
// 职责:安装 Cesium 贴地 demo 使用的页面样式与信息面板。
// 依赖:浏览器 DOM API。
// 被消费:ground-demo.ts。
// ============================================================

/**
 * 注入紧凑页面样式，避免 demo 额外依赖独立样式文件。
 */
export function installPageStyle(): void {
	const style = document.createElement( 'style' );
	style.textContent = `
		body {
			margin: 0;
			overflow: hidden;
			background: #05070a;
			color: #d8e7f2;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		#app {
			width: 100vw;
			height: 100vh;
		}

		#info-panel {
			position: fixed;
			left: 16px;
			top: 16px;
			width: min(470px, calc(100vw - 32px));
			box-sizing: border-box;
			border: 1px solid rgba(255, 255, 255, 0.14);
			border-radius: 8px;
			background: rgba(5, 7, 10, 0.78);
			backdrop-filter: blur(10px);
			padding: 14px 16px;
			pointer-events: none;
			box-shadow: 0 16px 52px rgba(0, 0, 0, 0.34);
		}

		#info-panel .title {
			font-weight: 700;
			margin-bottom: 8px;
		}

		#info-panel .body,
		#info-panel .hint {
			white-space: pre-line;
			font-family: "SFMono-Regular", Consolas, monospace;
			font-size: 12px;
			line-height: 1.55;
			color: #aebdca;
		}

		#info-panel .hint {
			margin-top: 10px;
			color: #8edeb5;
		}
	`;
	document.head.appendChild( style );
}

/**
 * 创建 demo 页面固定信息面板。
 *
 * @returns 每帧更新文本内容的面板主体元素。
 */
export function createInfoPanel(): HTMLElement {
	const oldInfoPanel = document.getElementById( 'info-panel' );
	oldInfoPanel?.remove();

	const panel = document.createElement( 'div' );
	panel.id = 'info-panel';
	panel.innerHTML = `
		<div class="title">Cesium GroundPrimitive -> Three + 3D Tiles</div>
		<div class="body" id="info-body"></div>
		<div class="hint">左键拖拽:旋转 / 滚轮:缩放 / 右键拖拽:平移</div>
	`;
	document.body.appendChild( panel );

	return panel.querySelector( '#info-body' ) as HTMLElement;
}
