// ============================================================
// main.ts
// 层级:Vite 应用入口。
// 职责:在 ground-demo（默认）与 plot-demo（标绘端到端测试）之间二选一。
//      切换方式：
//        - URL 加 `?demo=plot` 或 `?demo=ground`；
//        - 或环境变量 VITE_DEMO 取同名值。
//      未指定时默认 ground-demo，保持既有行为。
// 依赖:demo/ground-demo.ts、demo/plot-demo.ts。
// 被消费:index.html。
// ============================================================

import { runGroundDemo } from './demo/ground-demo';
import { runPlotDemo } from './demo/plot-demo';

function pickDemo(): 'ground' | 'plot' {
	const fromUrl = new URLSearchParams( window.location.search ).get( 'demo' );
	const fromEnv = ( import.meta.env as Record<string, string | undefined> ).VITE_DEMO;
	const choice = ( fromUrl ?? fromEnv ?? '' ).trim().toLowerCase();
	if ( choice === 'plot' ) return 'plot';
	return 'ground';
}

if ( pickDemo() === 'plot' ) {
	runPlotDemo();
} else {
	runGroundDemo();
}
