// ============================================================
// dom.ts
// Layer: demo page DOM utilities.
// Role: install the page chrome used by the Cesium ground demo.
// Dependencies: browser DOM APIs.
// Consumed by: ground-demo.ts.
// ============================================================

/**
 * Installs a compact page style without relying on a separate stylesheet.
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
 * Creates the fixed info panel expected by the demo page.
 *
 * @returns The body element whose text is updated per frame.
 */
export function createInfoPanel(): HTMLElement {
	const oldInfoPanel = document.getElementById( 'info-panel' );
	oldInfoPanel?.remove();

	const panel = document.createElement( 'div' );
	panel.id = 'info-panel';
	panel.innerHTML = `
		<div class="title">Cesium GroundPrimitive -> Three + 3D Tiles</div>
		<div class="body" id="info-body"></div>
		<div class="hint">drag: globe controls / wheel: zoom / right drag: pan</div>
	`;
	document.body.appendChild( panel );

	return panel.querySelector( '#info-body' ) as HTMLElement;
}
