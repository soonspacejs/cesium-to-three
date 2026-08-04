// ============================================================
// vitest.config.ts
// Purpose: deterministic Node-side tests for the Ground Material subsystem.
// Scope: browser/WebGL behavior deliberately stays in Playwright so unit tests
//        never pass by silently replacing Three's renderer with a DOM mock.
// ============================================================

import { defineConfig } from 'vitest/config';

export default defineConfig( {
	test: {
		// Keep discovery narrow. The repository also contains demo code whose files
		// are not tests and must not become accidental test entries.
		include: [ 'tests/ground-material/unit/**/*.test.ts' ],
		environment: 'node',
		// Stable ordering makes lifecycle/dispose failures reproducible and keeps
		// baseline output readable when a test intentionally exercises warnings.
		sequence: {
			concurrent: false,
		},
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
	},
} );
