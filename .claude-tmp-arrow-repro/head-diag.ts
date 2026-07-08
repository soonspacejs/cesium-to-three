// 精确诊断头部:是否退化 / 是否与体部重叠 / tip 角度。
// 直接复制 curved-arrow 的局部米制构造,绕过 finalizePolygon,拿到 raw 头部 3 点
// 与体部两侧,做几何判定。
import { createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

function buildHook( cx: number, cy: number, scaleM: number, count: number, endCurlDeg: number ): LonLatPoint[] {
	const mLon = 1.02e-5, mLat = 9.01e-6;
	const pts: LonLatPoint[] = [];
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number, y: number;
		if ( t < 0.40 ) { const u = t / 0.40; x = ( -2 + u * 2 ) * scaleM; y = 0.8 * scaleM; }
		else if ( t < 0.75 ) { const u = ( t - 0.4 ) / 0.35; const a = Math.PI / 2 - u * Math.PI; x = 0.8 * scaleM * Math.cos( a ) * 1.4; y = 0.8 * scaleM * Math.sin( a ); }
		else { const u = ( t - 0.75 ) / 0.25; const a = -Math.PI / 2 - u * ( endCurlDeg * Math.PI / 180 ); x = ( -0.4 + 0.45 * Math.cos( a ) ) * scaleM; y = ( -0.45 + 0.45 * Math.sin( a ) ) * scaleM; }
		pts.push( [ cx + x * mLon, cy + y * mLat ] );
	}
	return pts;
}

// 点在三角形内(含边界外侧排除)
function pointInTri( p: LonLatPoint, a: LonLatPoint, b: LonLatPoint, c: LonLatPoint ): boolean {
	const d = ( u: LonLatPoint, v: LonLatPoint, w: LonLatPoint ): number =>
		( u[ 0 ] - w[ 0 ] ) * ( v[ 1 ] - w[ 1 ] ) - ( v[ 0 ] - w[ 0 ] ) * ( u[ 1 ] - w[ 1 ] );
	const d1 = d( p, a, b ), d2 = d( p, b, c ), d3 = d( p, c, a );
	const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
	return ! ( neg && pos );
}

// 找 ring 中 tip 的索引;返回 tip 两侧邻点(= headLeft/headRight)与 tip 角度
function analyzeHead( ring: LonLatPoint[], tip: LonLatPoint ): void {
	const n = ring.length;
	let ti = -1;
	for ( let i = 0; i < n; i++ ) if ( Math.hypot( ring[ i ][ 0 ] - tip[ 0 ], ring[ i ][ 1 ] - tip[ 1 ] ) < 1e-9 ) { ti = i; break; }
	if ( ti < 0 ) { console.log( '   tip NOT in ring (head removed!)' ); return; }
	const hl = ring[ ( ti - 1 + n ) % n ], hr = ring[ ( ti + 1 ) % n ];
	// tip 角度
	const v1x = hl[ 0 ] - tip[ 0 ], v1y = hl[ 1 ] - tip[ 1 ];
	const v2x = hr[ 0 ] - tip[ 0 ], v2y = hr[ 1 ] - tip[ 1 ];
	const dot = v1x * v2x + v1y * v2y;
	const tipAngle = Math.acos( Math.max( -1, Math.min( 1, dot / ( Math.hypot( v1x, v1y ) * Math.hypot( v2x, v2y ) ) ) ) ) * 180 / Math.PI;
	// wingSpan(度) → 米
	const mLon = 1.02e-5;
	const wingSpanM = Math.hypot( hl[ 0 ] - hr[ 0 ], hl[ 1 ] - hr[ 1 ] ) / mLon;
	// head 三角是否覆盖了其它 ring 顶点(体部点落进头三角 = 重叠)
	let bodyInHead = 0;
	for ( let i = 0; i < n; i++ ) {
		if ( i === ti || i === ( ti - 1 + n ) % n || i === ( ti + 1 ) % n ) continue;
		if ( pointInTri( ring[ i ], hl, tip, hr ) ) bodyInHead++;
	}
	console.log( `   tipAngle=${ tipAngle.toFixed( 1 ) }deg  wingSpan=${ wingSpanM.toFixed( 2 ) }m  bodyVertsInsideHead=${ bodyInHead }` );
}

const cases: [ string, LonLatPoint[] ][] = [
	[ 'demo hook (12m,48,160deg)', buildHook( 119, 28.2, 12, 48, 160 ) ],
	[ 'tight end (12m,48,220deg)', buildHook( 119, 28.2, 12, 48, 220 ) ],
	[ 'very tight  (12m,60,300deg)', buildHook( 119, 28.2, 12, 60, 300 ) ],
	[ 'gentle hook (12m,48,90deg)', buildHook( 119, 28.2, 12, 48, 90 ) ],
];

for ( const [ name, cp ] of cases ) {
	const ring = createCurvedArrow( cp );
	console.log( `\n${ name }: ring=${ ring.length }` );
	analyzeHead( ring, cp[ cp.length - 1 ] );
}
