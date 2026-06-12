// ============================================================
// curved-arrow-repro.ts — 钩形轨迹下曲线箭头渲染错误的复现与诊断脚本
// 运行:npx tsx .claude-tmp-arrow-repro/curved-arrow-repro.ts
// 职责:
//   1. 构造三组控制点:钩形手绘(密集 60 点)、钩形点击(稀疏 8 点)、平缓 S 形(对照)
//   2. 调用 createCurvedArrow,统计输出环顶点数、头部 3 顶点是否存活、是否自交
//   3. 输出 SVG(输入脊线 + 输出环)用于人工目视对比
// 临时脚本,不进入构建。
// ============================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { createAttackArrow, createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

const OUT_DIR = '.claude-tmp-arrow-repro';
mkdirSync( OUT_DIR, { recursive: true } );

// ── 构造钩形轨迹(模拟用户截图:先向东长直行,右侧向南弯,向西回扫,末端向上卷曲回钩,尖端朝东) ──
// 用参数方程拼接:直线段 + 大半圆 + 内卷小弧。坐标单位:度(围绕 116E/39N,跨度 ~0.02°≈2km)。
function buildHookPoints( count: number ): LonLatPoint[] {
	const pts: LonLatPoint[] = [];
	const cx = 116.0;
	const cy = 39.0;
	const S = 0.01; // 总体尺度(度)

	// 三段弧长占比:直线 40%,外侧大弯(从向东转到向西,转角 ~180°) 35%,内卷小弧(再转 ~160°) 25%
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number;
		let y: number;
		if ( t < 0.40 ) {
			// 直线:向东
			const u = t / 0.40;
			x = -2.0 * S + u * 2.0 * S;
			y = 0.8 * S;
		} else if ( t < 0.75 ) {
			// 大弯:半径 0.8S,圆心 (0, 0),从 90°(顶部) 顺时针转到 -90°(底部)
			const u = ( t - 0.40 ) / 0.35;
			const a = Math.PI / 2 - u * Math.PI; // 90° → -90°
			x = 0.8 * S * Math.cos( a ) * 1.4; // 椭圆拉宽一点更像截图
			y = 0.8 * S * Math.sin( a );
		} else {
			// 内卷:半径 0.45S,圆心 (-0.4S, -0.45S),从 -90° 继续顺时针转 160°
			const u = ( t - 0.75 ) / 0.25;
			const a = -Math.PI / 2 - u * ( 160 * Math.PI / 180 );
			x = -0.4 * S + 0.45 * S * Math.cos( a );
			y = -0.45 * S + 0.45 * S * Math.sin( a );
		}
		pts.push( [ cx + x, cy + y ] );
	}
	return pts;
}

// 平缓 S 形对照(README 示例)
const S_CURVE: LonLatPoint[] = [
	[ 116.00, 39.000 ],
	[ 116.05, 39.010 ],
	[ 116.15, 38.995 ],
	[ 116.25, 39.005 ],
];

// ── 自交检测:O(n²) 线段相交(忽略相邻边) ──
function segIntersect(
	a: LonLatPoint, b: LonLatPoint, c: LonLatPoint, d: LonLatPoint,
): boolean {
	const cross = ( o: LonLatPoint, p: LonLatPoint, q: LonLatPoint ): number =>
		( p[ 0 ] - o[ 0 ] ) * ( q[ 1 ] - o[ 1 ] ) - ( p[ 1 ] - o[ 1 ] ) * ( q[ 0 ] - o[ 0 ] );
	const d1 = cross( c, d, a );
	const d2 = cross( c, d, b );
	const d3 = cross( a, b, c );
	const d4 = cross( a, b, d );
	return ( ( d1 > 0 && d2 < 0 ) || ( d1 < 0 && d2 > 0 ) )
		&& ( ( d3 > 0 && d4 < 0 ) || ( d3 < 0 && d4 > 0 ) );
}

function countSelfIntersections( ring: readonly LonLatPoint[] ): number {
	const n = ring.length;
	let hits = 0;
	for ( let i = 0; i < n; i++ ) {
		const a = ring[ i ];
		const b = ring[ ( i + 1 ) % n ];
		for ( let j = i + 2; j < n; j++ ) {
			if ( i === 0 && j === n - 1 ) continue; // 首尾相邻
			const c = ring[ j ];
			const d = ring[ ( j + 1 ) % n ];
			if ( segIntersect( a, b, c, d ) ) hits++;
		}
	}
	return hits;
}

// ── 头部存活检测:tip(末控制点)是否仍是环中的一个顶点(容差内) ──
function tipSurvives( ring: readonly LonLatPoint[], tip: LonLatPoint ): { survives: boolean; minDist: number } {
	let minDist = Infinity;
	for ( const p of ring ) {
		const d = Math.hypot( p[ 0 ] - tip[ 0 ], p[ 1 ] - tip[ 1 ] );
		if ( d < minDist ) minDist = d;
	}
	return { survives: minDist < 1e-9, minDist };
}

// ── SVG 输出 ──
function toSvg(
	name: string,
	spine: readonly LonLatPoint[],
	ring: readonly LonLatPoint[],
	tip: LonLatPoint,
): void {
	const all = [ ...spine, ...ring, tip ];
	const xs = all.map( ( p ) => p[ 0 ] );
	const ys = all.map( ( p ) => p[ 1 ] );
	const minX = Math.min( ...xs );
	const maxX = Math.max( ...xs );
	const minY = Math.min( ...ys );
	const maxY = Math.max( ...ys );
	const w = maxX - minX || 1;
	const h = maxY - minY || 1;
	const PX = 900;
	const scale = PX / Math.max( w, h );
	const H = Math.ceil( h * scale ) + 40;
	const mx = ( x: number ): number => ( x - minX ) * scale + 20;
	const my = ( y: number ): number => H - ( ( y - minY ) * scale + 20 ); // y 翻转(SVG y 向下)

	const ringPath = ring.map( ( p, i ) =>
		`${ i === 0 ? 'M' : 'L' }${ mx( p[ 0 ] ).toFixed( 1 ) },${ my( p[ 1 ] ).toFixed( 1 ) }`,
	).join( ' ' ) + ' Z';
	const spinePath = spine.map( ( p, i ) =>
		`${ i === 0 ? 'M' : 'L' }${ mx( p[ 0 ] ).toFixed( 1 ) },${ my( p[ 1 ] ).toFixed( 1 ) }`,
	).join( ' ' );
	const ringDots = ring.map( ( p ) =>
		`<circle cx="${ mx( p[ 0 ] ).toFixed( 1 ) }" cy="${ my( p[ 1 ] ).toFixed( 1 ) }" r="2" fill="#900"/>`,
	).join( '' );

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ PX + 40 }" height="${ H }">
<rect width="100%" height="100%" fill="#fff"/>
<path d="${ ringPath }" fill="#4a90d9" fill-opacity="0.55" stroke="#1a50a9" stroke-width="2" fill-rule="evenodd"/>
<path d="${ spinePath }" fill="none" stroke="#f80" stroke-width="1" stroke-dasharray="4 3"/>
${ ringDots }
<circle cx="${ mx( tip[ 0 ] ).toFixed( 1 ) }" cy="${ my( tip[ 1 ] ).toFixed( 1 ) }" r="5" fill="none" stroke="#0a0" stroke-width="2"/>
</svg>`;
	writeFileSync( `${ OUT_DIR }/${ name }.svg`, svg );
}

// ── 头部翼展检测:尖端在环中的两个相邻顶点(headLeft/headRight)间距应明显
//    大于零(有可见三角头),返回翼展间距与头长(尖端到翼中点) ──
function headMetrics(
	ring: readonly LonLatPoint[],
	tip: LonLatPoint,
): { wingSpan: number; headLen: number } | null {
	let tipIdx = -1;
	for ( let i = 0; i < ring.length; i++ ) {
		if ( Math.hypot( ring[ i ][ 0 ] - tip[ 0 ], ring[ i ][ 1 ] - tip[ 1 ] ) < 1e-9 ) {
			tipIdx = i;
			break;
		}
	}
	if ( tipIdx < 0 ) return null;
	const n = ring.length;
	const left = ring[ ( tipIdx - 1 + n ) % n ];
	const right = ring[ ( tipIdx + 1 ) % n ];
	const wingSpan = Math.hypot( left[ 0 ] - right[ 0 ], left[ 1 ] - right[ 1 ] );
	const midX = ( left[ 0 ] + right[ 0 ] ) / 2;
	const midY = ( left[ 1 ] + right[ 1 ] ) / 2;
	const headLen = Math.hypot( tip[ 0 ] - midX, tip[ 1 ] - midY );
	return { wingSpan, headLen };
}

// ── 跑一组用例 ──
function runCase(
	name: string,
	controlPoints: LonLatPoint[],
	generator: ( cp: LonLatPoint[] ) => LonLatPoint[] = ( cp ) => createCurvedArrow( cp ),
): void {
	const tip = controlPoints[ controlPoints.length - 1 ];
	const ring = generator( controlPoints );
	const tipCheck = tipSurvives( ring, tip );
	const selfX = countSelfIntersections( ring );
	const head = headMetrics( ring, tip );
	console.log( `\n=== ${ name } ===` );
	console.log( `controlPoints: ${ controlPoints.length }` );
	console.log( `ring vertices: ${ ring.length } ${ ring.length > 120 ? '!! EXCEEDS 120' : '(<=120 ok)' }` );
	console.log( `tip survives in ring: ${ tipCheck.survives } (min dist to tip: ${ tipCheck.minDist.toExponential( 3 ) } deg)` );
	console.log( `head: ${ head ? `wingSpan=${ head.wingSpan.toExponential( 3 ) } headLen=${ head.headLen.toExponential( 3 ) }` : 'MISSING' }` );
	console.log( `self-intersections: ${ selfX }` );
	toSvg( name, controlPoints, ring, tip );
}

// 极端末端螺旋:末尾 270° 小半径卷曲(比截图更狠)
function buildTightSpiralEnd( count: number ): LonLatPoint[] {
	const pts: LonLatPoint[] = [];
	const S = 0.01;
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		if ( t < 0.5 ) {
			pts.push( [ 116.0 - 2 * S + ( t / 0.5 ) * 2 * S, 39.0 ] );
		} else {
			const u = ( t - 0.5 ) / 0.5;
			const a = Math.PI / 2 + u * ( 270 * Math.PI / 180 ); // 逆时针卷 270°
			const r = 0.35 * S * ( 1 - 0.4 * u ); // 半径渐缩,真螺旋
			pts.push( [ 116.0 + r * Math.cos( a ), 39.0 - 0.35 * S + r * Math.sin( a ) ] );
		}
	}
	return pts;
}

// 手抖抖动版钩形(每点加 ±0.5% 尺度伪随机抖动,确定性种子)
function buildJitteryHook( count: number ): LonLatPoint[] {
	const base = buildHookPoints( count );
	let seed = 42;
	const rand = (): number => {
		seed = ( seed * 1103515245 + 12345 ) % 2147483648;
		return seed / 2147483648 - 0.5;
	};
	return base.map( ( p ) => [
		p[ 0 ] + rand() * 0.00005,
		p[ 1 ] + rand() * 0.00005,
	] as LonLatPoint );
}

runCase( 'hook-freehand-60pts', buildHookPoints( 60 ) );
runCase( 'hook-clicks-8pts', buildHookPoints( 8 ) );
runCase( 'gentle-s-4pts', S_CURVE );
runCase( 'tight-spiral-end-80pts', buildTightSpiralEnd( 80 ) );
runCase( 'jittery-hook-90pts', buildJitteryHook( 90 ) );
runCase( 'two-points-line', [ [ 116.0, 39.0 ], [ 116.02, 39.01 ] ] );
runCase( 'collinear-5pts', [
	[ 116.00, 39.0 ], [ 116.01, 39.0 ], [ 116.02, 39.0 ], [ 116.03, 39.0 ], [ 116.04, 39.0 ],
] );
runCase( 'duplicate-points', [
	[ 116.00, 39.0 ], [ 116.00, 39.0 ], [ 116.02, 39.005 ], [ 116.02, 39.005 ], [ 116.04, 39.0 ],
] );
// 攻击箭头手绘(前 2 点为尾边,后续 40 点为钩形脊线)→ 验证特征保留式降采样
const attackSpine = buildHookPoints( 40 );
runCase(
	'attack-freehand-hook',
	[ [ 115.978, 38.998 ], [ 115.982, 39.006 ], ...attackSpine.slice( 1 ) ],
	( cp ) => createAttackArrow( cp ),
);
