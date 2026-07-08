// 原型 2:对 createCurvedArrow 的最终环做"自并集"清理,测量:
//   - 最终环是否自交(清理前)
//   - 自并集后:外环顶点数、tip 是否外露、洞数量与洞面积占比
import polygonClipping from 'polygon-clipping';
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

function selfX( ring: LonLatPoint[] ): number {
	const n = ring.length; let h = 0;
	const seg = ( a: LonLatPoint, b: LonLatPoint, c: LonLatPoint, d: LonLatPoint ): boolean => {
		const cr = ( o: LonLatPoint, p: LonLatPoint, q: LonLatPoint ): number => ( p[ 0 ] - o[ 0 ] ) * ( q[ 1 ] - o[ 1 ] ) - ( p[ 1 ] - o[ 1 ] ) * ( q[ 0 ] - o[ 0 ] );
		const d1 = cr( c, d, a ), d2 = cr( c, d, b ), d3 = cr( a, b, c ), d4 = cr( a, b, d );
		return ( ( d1 > 0 && d2 < 0 ) || ( d1 < 0 && d2 > 0 ) ) && ( ( d3 > 0 && d4 < 0 ) || ( d3 < 0 && d4 > 0 ) );
	};
	for ( let i = 0; i < n; i++ ) for ( let j = i + 2; j < n; j++ ) { if ( i === 0 && j === n - 1 ) continue; if ( seg( ring[ i ], ring[ ( i + 1 ) % n ], ring[ j ], ring[ ( j + 1 ) % n ] ) ) h++; }
	return h;
}
function area( ring: { 0: number; 1: number }[] ): number {
	let a = 0; const n = ring.length;
	for ( let i = 0; i < n; i++ ) { const p = ring[ i ], q = ring[ ( i + 1 ) % n ]; a += p[ 0 ] * q[ 1 ] - q[ 0 ] * p[ 1 ]; }
	return Math.abs( a ) / 2;
}

for ( const [ name, deg, cnt ] of [ [ 'demo160', 160, 48 ], [ 'tight220', 220, 48 ], [ 'vtight300', 300, 60 ], [ 'gentle90', 90, 48 ], [ 's-curve', 0, 4 ] ] as [ string, number, number ][] ) {
	const cp = deg === 0
		? [ [ 119, 28.2 ], [ 119.0005, 28.2009 ], [ 119.0014, 28.1996 ], [ 119.0023, 28.2004 ] ] as LonLatPoint[]
		: buildHook( 119, 28.2, 12, cnt, deg );
	const ring = createCurvedArrow( cp );
	const tip = cp[ cp.length - 1 ];
	const sx = selfX( ring );
	const closed: [ number, number ][] = ring.map( ( p ) => [ p[ 0 ], p[ 1 ] ] );
	closed.push( [ ring[ 0 ][ 0 ], ring[ 0 ][ 1 ] ] );
	const res = polygonClipping.union( [ closed ] );
	let outerVerts = 0, holes = 0, biggestArea = -1, holeAreaSum = 0;
	let biggest: [ number, number ][] = [];
	for ( const poly of res ) {
		const outer = poly[ 0 ];
		const a = area( outer );
		for ( let k = 1; k < poly.length; k++ ) holeAreaSum += area( poly[ k ] );
		holes += poly.length - 1;
		if ( a > biggestArea ) { biggestArea = a; outerVerts = outer.length - 1; biggest = outer; }
	}
	let tipD = Infinity;
	for ( const p of biggest ) tipD = Math.min( tipD, Math.hypot( p[ 0 ] - tip[ 0 ], p[ 1 ] - tip[ 1 ] ) );
	const holeFrac = biggestArea > 0 ? ( holeAreaSum / biggestArea * 100 ) : 0;
	console.log( `${ name.padEnd( 9 ) }: ringSelfX=${ sx }  union[outerVerts=${ outerVerts } holes=${ holes } holeArea=${ holeFrac.toFixed( 1 ) }% tipOnOuter=${ tipD < 1e-9 }]` );
}
