import { defineConfig } from 'vitest/config';

/**
 * GIS 编辑器的独立 Node 测试配置。
 *
 * 编辑器核心必须保持与 DOM、Three.js 和真实渲染器解耦，因此文档、命令、
 * 坐标、状态机等测试统一在 Node 环境执行；需要浏览器事件或视觉结果的用例
 * 由后续独立的 Playwright 项目负责。
 */
export default defineConfig( {
	test: {
		include: [ 'tests/plot-editor/**/*.test.ts' ],
		environment: 'node',
		sequence: {
			concurrent: false,
		},
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
	},
} );
