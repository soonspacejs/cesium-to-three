// 渲染 + 凹口诊断:对若干钩形输入跑 createCurvedArrow,渲染 PNG-ish SVG,
// 并报告 tip 邻域(头-体衔接)是否存在异常凹角(notch)。
import { writeFileSync } from 'node:fs';
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

// 找 tip 索引,报告它前后各 4 个顶点的转角(凸/凹)。CCW 环中凸=左转(cross>0)。
function junctionReport( ring: LonLatPoint[], tip: LonLatPoint ): string {
	const n = ring.length;
	let ti = -1;
	for ( let i = 0; i < n; i++ ) if ( Math.hypot( ring[ i ][ 0 ] - tip[ 0 ], ring[ i ][ 1 ] - tip[ 1 ] ) < 1e-9 ) { ti = i; break; }
	if ( ti < 0 ) return 'tip MISSING';
	const turns: string[] = [];
	for ( let k = -4; k <= 4; k++ ) {
		const i = ( ti + k + n ) % n;
		const prev = ring[ ( i - 1 + n ) % n ], cur = ring[ i ], nxt = ring[ ( i + 1 ) % n ];
		const v1x = cur[ 0 ] - prev[ 0 ], v1y = cur[ 1 ] - prev[ 1 ];
		const v2x = nxt[ 0 ] - cur[ 0 ], v2y = nxt[ 1 ] - cur[ 1 ];
		const cross = v1x * v2y - v1y * v2x;
		const dot = v1x * v2x + v1y * v2y;
		const ang = Math.atan2( cross, dot ) * 180 / Math.PI;
		const mark = k === 0 ? 'TIP' : ( ang < -1 ? 'REFLEX' : 'conv' );
		turns.push( `${ k }:${ ang.toFixed( 0 ) }°${ mark === 'REFLEX' ? '!!' : '' }` );
	}
	return turns.join( ' ' );
}

function toSvg( name: string, ring: LonLatPoint[], spine: LonLatPoint[] ): void {
	const all = ring.concat( spine );
	const xs = all.map( p => p[ 0 ] ), ys = all.map( p => p[ 1 ] );
	const minX = Math.min( ...xs ), maxX = Math.max( ...xs ), minY = Math.min( ...ys ), maxY = Math.max( ...ys );
	const w = maxX - minX || 1, h = maxY - minY || 1, PX = 700, sc = PX / Math.max( w, h ), H = Math.ceil( h * sc ) + 40;
	const mx = ( x: number ): number => ( x - minX ) * sc + 20, my = ( y: number ): number => H - ( ( y - minY ) * sc + 20 );
	const path = ring.map( ( p, i ) => `${ i === 0 ? 'M' : 'L' }${ mx( p[ 0 ] ).toFixed( 1 ) },${ my( p[ 1 ] ).toFixed( 1 ) }` ).join( ' ' ) + ' Z';
	const sp = spine.map( ( p, i ) => `${ i === 0 ? 'M' : 'L' }${ mx( p[ 0 ] ).toFixed( 1 ) },${ my( p[ 1 ] ).toFixed( 1 ) }` ).join( ' ' );
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ PX + 40 }" height="${ H }"><rect width="100%" height="100%" fill="#fff"/><path d="${ path }" fill="#2b6cff" fill-opacity="0.65" stroke="#0a2f8f" stroke-width="6" stroke-linejoin="round"/><path d="${ sp }" fill="none" stroke="#f80" stroke-width="1" stroke-dasharray="3 3"/></svg>`;
	writeFileSync( `.claude-tmp-arrow-repro/render-${ name }.svg`, svg );
}

for ( const [ name, deg, cnt ] of [ [ 'h160', 160, 48 ], [ 'h200', 200, 48 ], [ 'h240', 240, 60 ], [ 'h90', 90, 48 ] ] as [ string, number, number ][] ) {
	const cp = buildHook( 119, 28.2, 12, cnt, deg );
	const ring = createCurvedArrow( cp );
	console.log( `${ name }: ring=${ ring.length }  junction[${ junctionReport( ring, cp[ cp.length - 1 ] ) }]` );
	toSvg( name, ring, cp );
}
