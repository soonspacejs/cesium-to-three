// ============================================================
// vite.lib.config.ts
// Library build used for npm publishing. It intentionally exposes only
// ground、arrow 与完整 plot-editor API；旧 src/lib/plot 仍保持 demo/internal。
// ============================================================

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

function fromRoot( path: string ): string {
	return fileURLToPath( new URL( path, import.meta.url ) );
}

export default defineConfig( {
	build: {
		target: 'es2022',
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: true,
		lib: {
			entry: {
				index: fromRoot( './src/cesium-three-ground.ts' ),
				ground: fromRoot( './src/lib/ground/index.ts' ),
				arrow: fromRoot( './src/lib/arrow/index.ts' ),
				'plot-editor': fromRoot( './src/lib/plot-editor/index.ts' ),
			},
			formats: [ 'es' ],
			fileName: ( _format, entryName ) => `${ entryName }.js`,
		},
		rollupOptions: {
			external: [
				'earcut',
				'mersenne-twister',
				'rbush',
				'three',
				'urijs',
			],
		},
	},
} );
