// ============================================================
// main.ts
// 层级:Vite 应用入口。
// 职责:启动 Cesium GroundPrimitive 到 Three.js 的贴地渲染 demo。
// 依赖:demo/ground-demo.ts。
// 被消费:index.html。
// ============================================================

import { runGroundDemo } from './demo/ground-demo';

runGroundDemo();
