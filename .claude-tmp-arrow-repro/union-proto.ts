// 原型:验证「体部带 ∪ 头三角」的多边形并集是否能在钩形输入下产出
// 单个干净外环(头尖外露、底边并入体部、无自交、顶点可控)。
//
// 复刻 curved-arrow 的局部米制构造(简化版,仅为原型),拿到 leftSide / rightSide /
// 头三角,然后:
//   方案 A:整环(leftSide+头+rightSide)→ polygon-clipping union(自并集,消自交)
//   方案 B:体部环 ∪ 头三角 → union
// 比较两者。
import polygonClipping from 'polygon-clipping';
import {
	centripetalCatmullRomSamples,
	computeTangents,
	findPointAlongPolylineFromEnd,
	resamplePolylineByArcLength,
	trimLocalPolylineLoops,
} from '../src/lib/arrow/arrow-curves';
import { wholeDistance, mathDistance } from '../src/lib/arrow/arrow-geometry';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

function buildHookLocal( scaleM: number, count: number, endCurlDeg: number ): LonLatPoint[] {
	// 直接在米制平面构造(本原型不转经纬度,几何同构)。
	const pts: LonLatPoint[] = [];
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number, y: number;
		if ( t < 0.40 ) { const u = t / 0.40; x = ( -2 + u * 2 ) * scaleM; y = 0.8 * scaleM; }
		else if ( t < 0.75 ) { const u = ( t - 0.4 ) / 0.35; const a = Math.PI / 2 - u * Math.PI; x = 0.8 * scaleM * Math.cos( a ) * 1.4; y = 0.8 * scaleM * Math.sin( a ); }
		else { const u = ( t - 0.75 ) / 0.25; const a = -Math.PI / 2 - u * ( endCurlDeg * Math.PI / 180 ); x = ( -0.4 + 0.45 * Math.cos( a ) ) * scaleM; y = ( -0.45 + 0.45 * Math.sin( a ) ) * scaleM; }
		pts.push( [ x, y ] );
	}
	return pts;
}

function buildParts( cp: LonLatPoint[] ): { body: LonLatPoint[]; head: LonLatPoint[]; tip: LonLatPoint } {
	const raw = centripetalCatmullRomSamples( cp, 16 );
	const spine = raw.length > 58 ? resamplePolylineByArcLength( raw, 58 ) : raw;
	const totalLen = wholeDistance( spine );
	const bodyHalf = totalLen * 0.09 / 2;
	const headHalf = totalLen * 0.16 / 2;
	const neckHalf = headHalf * 0.6;
	const headLen = totalLen * 0.14;
	const neck = findPointAlongPolylineFromEnd( spine, headLen )!;
	const bodySpine = spine.slice( 0, neck.segmentIdx + 1 ).map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint );
	bodySpine.push( neck.point );
	const tangents = computeTangents( bodySpine );
	const last = bodySpine.length - 1;
	const left: LonLatPoint[] = [], right: LonLatPoint[] = [];
	for ( let i = 0; i <= last; i++ ) {
		const w = i === last ? neckHalf : bodyHalf;
		const px = -tangents[ i ][ 1 ], py = tangents[ i ][ 0 ];
		left.push( [ bodySpine[ i ][ 0 ] + px * w, bodySpine[ i ][ 1 ] + py * w ] );
		right.push( [ bodySpine[ i ][ 0 ] - px * w, bodySpine[ i ][ 1 ] - py * w ] );
	}
	const tl = trimLocalPolylineLoops( left ), tr = trimLocalPolylineLoops( right );
	const tip = cp[ cp.length - 1 ];
	let chordX = tip[ 0 ] - neck.point[ 0 ], chordY = tip[ 1 ] - neck.point[ 1 ];
	const cl = Math.hypot( chordX, chordY ); chordX /= cl; chordY /= cl;
	const hpx = -chordY, hpy = chordX;
	const headLeft: LonLatPoint = [ neck.point[ 0 ] + hpx * headHalf, neck.point[ 1 ] + hpy * headHalf ];
	const headRight: LonLatPoint = [ neck.point[ 0 ] - hpx * headHalf, neck.point[ 1 ] - hpy * headHalf ];
	// 体部环(无头):left + reverse(right)
	const body = [ ...tl, ...tr.slice().reverse() ];
	// 头三角:neckLeft(体末左) - headLeft - tip - headRight - neckRight(体末右)
	const head = [ tl[ tl.length - 1 ], headLeft, tip, headRight, tr[ tr.length - 1 ] ];
	return { body, head, tip };
}

function ringClose( r: LonLatPoint[] ): [ number, number ][] {
	const out = r.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as [ number, number ] );
	out.push( [ r[ 0 ][ 0 ], r[ 0 ][ 1 ] ] );
	return out;
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

for ( const [ name, deg, cnt ] of [ [ 'demo160', 160, 48 ], [ 'tight220', 220, 48 ], [ 'vtight300', 300, 60 ], [ 'gentle90', 90, 48 ] ] as [ string, number, number ][] ) {
	const cp = buildHookLocal( 12, cnt, deg );
	const { body, head, tip } = buildParts( cp );
	// union: 把 body 与 head 作为两个多边形求并(各自可能自交,polygon-clipping 会自处理)
	const result = polygonClipping.union( [ ringClose( body ) ], [ ringClose( head ) ] );
	// result: MultiPolygon = Polygon[]; Polygon = Ring[]; Ring = [x,y][]
	const polys = result.length;
	let totalRings = 0, outerVerts = 0, holes = 0;
	let biggest: LonLatPoint[] = [];
	let biggestArea = -1;
	for ( const poly of result ) {
		totalRings += poly.length;
		holes += poly.length - 1;
		const outer = poly[ 0 ];
		// 面积
		let a = 0;
		for ( let i = 0; i < outer.length - 1; i++ ) a += outer[ i ][ 0 ] * outer[ i + 1 ][ 1 ] - outer[ i + 1 ][ 0 ] * outer[ i ][ 1 ];
		a = Math.abs( a );
		if ( a > biggestArea ) { biggestArea = a; biggest = outer.slice( 0, -1 ).map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint ); outerVerts = outer.length - 1; }
	}
	// tip 是否在最大外环上
	let tipDist = Infinity;
	for ( const p of biggest ) tipDist = Math.min( tipDist, Math.hypot( p[ 0 ] - tip[ 0 ], p[ 1 ] - tip[ 1 ] ) );
	console.log( `${ name }: union polys=${ polys } holes=${ holes } biggestOuterVerts=${ outerVerts } tipOnOuter=${ tipDist < 1e-6 } (d=${ tipDist.toExponential( 2 ) }) selfX(outer)=${ selfX( biggest ) }` );
}
