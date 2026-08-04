// ============================================================
// main.ts
// 层级:Vite 应用入口。
// 职责:在 ground-demo（默认）/ plot-demo（标绘端到端测试）/ model-demo
//      （标绘贴模型 / 倾斜摄影）之间三选一。
//      切换方式：
//        - URL 加 `?demo=plot` / `?demo=ground` / `?demo=model`；
//        - 或环境变量 VITE_DEMO 取同名值。
//      未指定时默认 ground-demo，保持既有行为。
// 依赖:demo/ground-demo.ts、demo/plot-demo.ts、demo/model-clamp-demo.ts。
// 被消费:index.html。
// ============================================================

import { runGroundDemo } from './demo/ground-demo';
import { runAnimationModesDemo } from './demo/animation-modes-demo';
import { runModelClampDemo } from './demo/model-clamp-demo';
import { runPlotDemo } from './demo/plot-demo';

function pickDemo(): 'ground' | 'plot' | 'model' | 'animation' {
	const fromUrl = new URLSearchParams( window.location.search ).get( 'demo' );
	const fromEnv = ( import.meta.env as Record<string, string | undefined> ).VITE_DEMO;
	const choice = ( fromUrl ?? fromEnv ?? '' ).trim().toLowerCase();
	if ( choice === 'plot' ) return 'plot';
	if ( choice === 'model' ) return 'model';
	if ( choice === 'animation' || choice === 'vertex-animation' ) return 'animation';
	return 'ground';
}

const demo = pickDemo();
if ( demo === 'plot' ) {
	runPlotDemo();
} else if ( demo === 'model' ) {
	runModelClampDemo();
} else if ( demo === 'animation' ) {
	runAnimationModesDemo();
} else {
	runGroundDemo();
}
