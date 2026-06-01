// ============================================================
// vite.lib.config.ts
// Library build used for npm publishing. It intentionally exposes only
// ground and arrow APIs; src/lib/plot stays demo/internal and is not bundled.
// ============================================================
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
function fromRoot(path) {
    return fileURLToPath(new URL(path, import.meta.url));
}
export default defineConfig({
    build: {
        target: 'es2022',
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            entry: {
                index: fromRoot('./src/cesium-three-ground.ts'),
                ground: fromRoot('./src/lib/ground/index.ts'),
                arrow: fromRoot('./src/lib/arrow/index.ts'),
            },
            formats: ['es'],
            fileName: function (_format, entryName) { return "".concat(entryName, ".js"); },
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
});
