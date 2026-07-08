// 一次性校验:用 demo 中 hookCurvedArrow / plot-demo hook 的精确控制点跑几何检查。
import { createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

// 与 arrow-demo.ts buildInitialControlPoints 完全一致(中心取 ground-demo 的
// RECTANGLE_CENTER;此处近似 28°N 任意中心,几何形状与纬度无关紧要)。
function buildDemoHook( centerLon: number, centerLat: number, scaleMeters: number, count: number ): LonLatPoint[] {
	const mLon = 1.02e-5;
	const mLat = 9.01e-6;
	const pts: LonLatPoint[] = [];
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number; let y: number;
		if ( t < 0.40 ) { const u = t / 0.40; x = ( -2.0 + u * 2.0 ) * scaleMeters; y = 0.8 * scaleMeters; }
		else if ( t < 0.75 ) { const u = ( t - 0.40 ) / 0.35; const a = Math.PI / 2 - u * Math.PI; x = 0.8 * scaleMeters * Math.cos( a ) * 1.4; y = 0.8 * scaleMeters * Math.sin( a ); }
		else { const u = ( t - 0.75 ) / 0.25; const a = -Math.PI / 2 - u * ( 160.0 * Math.PI / 180.0 ); x = ( -0.4 + 0.45 * Math.cos( a ) ) * scaleMeters; y = ( -0.45 + 0.45 * Math.sin( a ) ) * scaleMeters; }
		pts.push( [ centerLon + x * mLon, centerLat + y * mLat ] );
	}
	return pts;
}

function segIntersect( a: LonLatPoint, b: LonLatPoint, c: LonLatPoint, d: LonLatPoint ): boolean {
	const cross = ( o: LonLatPoint, p: LonLatPoint, q: LonLatPoint ): number =>
		( p[ 0 ] - o[ 0 ] ) * ( q[ 1 ] - o[ 1 ] ) - ( p[ 1 ] - o[ 1 ] ) * ( q[ 0 ] - o[ 0 ] );
	const d1 = cross( c, d, a ); const d2 = cross( c, d, b );
	const d3 = cross( a, b, c ); const d4 = cross( a, b, d );
	return ( ( d1 > 0 && d2 < 0 ) || ( d1 < 0 && d2 > 0 ) ) && ( ( d3 > 0 && d4 < 0 ) || ( d3 < 0 && d4 > 0 ) );
}

function check( name: string, cp: LonLatPoint[] ): void {
	const ring = createCurvedArrow( cp );
	const tip = cp[ cp.length - 1 ];
	let tipOk = false;
	for ( const p of ring ) {
		if ( Math.hypot( p[ 0 ] - tip[ 0 ], p[ 1 ] - tip[ 1 ] ) < 1e-9 ) { tipOk = true; break; }
	}
	let selfX = 0;
	const n = ring.length;
	for ( let i = 0; i < n; i++ ) {
		for ( let j = i + 2; j < n; j++ ) {
			if ( i === 0 && j === n - 1 ) continue;
			if ( segIntersect( ring[ i ], ring[ ( i + 1 ) % n ], ring[ j ], ring[ ( j + 1 ) % n ] ) ) selfX++;
		}
	}
	const nanCount = ring.filter( ( p ) => ! Number.isFinite( p[ 0 ] ) || ! Number.isFinite( p[ 1 ] ) ).length;
	console.log( `${ name }: ring=${ ring.length } tipOk=${ tipOk } selfX=${ selfX } nan=${ nanCount }` );
}

// ground-demo arrow showcase 的 hookCurvedArrow(scale 12 m, 48 pts, ~28.2°N 附近)
check( 'arrow-demo hookCurvedArrow', buildDemoHook( 119.0, 28.2, 12.0, 48 ) );
// plot-demo 的 hook(scale 14 m, 48 pts)
check( 'plot-demo  hook curved   ', buildDemoHook( 119.0, 28.2, 14.0, 48 ) );
