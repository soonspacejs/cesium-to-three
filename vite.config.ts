// ============================================================
// vite.config.ts
// 用途:Vite 构建配置。
// 关键设置:
//   - server.host: '0.0.0.0' 允许局域网访问，本机调试时无影响。
//   - server.open: true 启动后自动打开浏览器。
//   - build.target: 'es2022' 与 tsconfig 对齐。
// ============================================================

import { defineConfig, loadEnv } from 'vite';

export default defineConfig( ( { mode } ) => {

	// 加载 .env 文件，VITE_ 前缀的变量会被注入到客户端。
	const env = loadEnv( mode, process.cwd(), '' );

	return {
		server: {
			port: 5180,
			strictPort: true,
			open: false,
			host: '0.0.0.0',
		},
		build: {
			target: 'es2022',
			sourcemap: true,
			rollupOptions: {
				output: {
					// 拆分 three / 3d-tiles-renderer 为独立 chunk，加速冷启动。
					manualChunks: {
						three: [ 'three' ],
						'tiles-renderer': [ '3d-tiles-renderer', '3d-tiles-renderer/plugins' ],
					},
				},
			},
		},
		define: {
			// 让 main.ts 能使用 import.meta.env.VITE_CESIUM_ION_TOKEN。
			__APP_ENV__: JSON.stringify( env.APP_ENV ),
		},
		optimizeDeps: {
			// 预构建这些依赖，避免冷启动时反复刷新。
			include: [ 'three', '3d-tiles-renderer', '3d-tiles-renderer/plugins' ],
		},
	};

} );
