// ============================================================
// playwright.config.ts
// Purpose: real WebGL2 integration, visual-regression and resource tests for
//          Ground primitives. All rendering inputs are pinned here so a later
//          implementation cannot make a regression disappear by changing DPR,
//          viewport, browser locale, or the selected ANGLE backend.
// ============================================================

import { defineConfig } from '@playwright/test';

const FIXTURE_PORT = 5181;
const FIXTURE_BASE_URL = `http://127.0.0.1:${ FIXTURE_PORT }`;

export default defineConfig( {
	testDir: '.',
	// Integration shaders can compile lazily on the first frame. This timeout is
	// generous enough for software WebGL while individual assertions remain fast.
	timeout: 45_000,
	expect: {
		timeout: 10_000,
		toHaveScreenshot: {
			// Exact pixels are kept for the pinned SwiftShader project. Tests that
			// intentionally support hardware GPUs must declare their documented
			// per-assertion tolerance rather than weakening this global baseline.
			maxDiffPixels: 0,
		},
	},
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean( process.env.CI ),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [ [ 'line' ], [ 'html', { open: 'never' } ] ] : 'list',
	use: {
		baseURL: FIXTURE_BASE_URL,
		browserName: 'chromium',
		viewport: { width: 960, height: 640 },
		deviceScaleFactor: 1,
		colorScheme: 'light',
		locale: 'en-US',
		timezoneId: 'Asia/Shanghai',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		video: 'off',
		launchOptions: {
			args: [
				'--use-angle=swiftshader',
				'--enable-webgl',
				'--ignore-gpu-blocklist',
			],
		},
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --port ${ FIXTURE_PORT }`,
		url: FIXTURE_BASE_URL,
		reuseExistingServer: ! process.env.CI,
		timeout: 120_000,
	},
} );
