// 一次性诊断:打印自交线段对的索引,判断是头部缺陷还是体部固有重叠。
import { createAttackArrow, createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

function buildHookPoints( count: number ): LonLatPoint[] {
	const pts: LonLatPoint[] = [];
	const S = 0.01;
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number; let y: number;
		if ( t < 0.40 ) { const u = t / 0.40; x = -2.0 * S + u * 2.0 * S; y = 0.8 * S; }
		else if ( t < 0.75 ) { const u = ( t - 0.40 ) / 0.35; const a = Math.PI / 2 - u * Math.PI; x = 0.8 * S * Math.cos( a ) * 1.4; y = 0.8 * S * Math.sin( a ); }
		else { const u = ( t - 0.75 ) / 0.25; const a = -Math.PI / 2 - u * ( 160 * Math.PI / 180 ); x = -0.4 * S + 0.45 * S * Math.cos( a ); y = -0.45 * S + 0.45 * S * Math.sin( a ); }
		pts.push( [ 116.0 + x, 39.0 + y ] );
	}
	return pts;
}

function buildTightSpiralEnd( count: number ): LonLatPoint[] {
	const pts: LonLatPoint[] = [];
	const S = 0.01;
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		if ( t < 0.5 ) { pts.push( [ 116.0 - 2 * S + ( t / 0.5 ) * 2 * S, 39.0 ] ); }
		else {
			const u = ( t - 0.5 ) / 0.5;
			const a = Math.PI / 2 + u * ( 270 * Math.PI / 180 );
			const r = 0.35 * S * ( 1 - 0.4 * u );
			pts.push( [ 116.0 + r * Math.cos( a ), 39.0 - 0.35 * S + r * Math.sin( a ) ] );
		}
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

function report( name: string, ring: LonLatPoint[], tip: LonLatPoint ): void {
	let tipIdx = -1;
	for ( let i = 0; i < ring.length; i++ ) {
		if ( Math.hypot( ring[ i ][ 0 ] - tip[ 0 ], ring[ i ][ 1 ] - tip[ 1 ] ) < 1e-9 ) { tipIdx = i; break; }
	}
	console.log( `\n=== ${ name } === ring=${ ring.length } tipIdx=${ tipIdx }` );
	const n = ring.length;
	for ( let i = 0; i < n; i++ ) {
		for ( let j = i + 2; j < n; j++ ) {
			if ( i === 0 && j === n - 1 ) continue;
			if ( segIntersect( ring[ i ], ring[ ( i + 1 ) % n ], ring[ j ], ring[ ( j + 1 ) % n ] ) ) {
				const nearHead = Math.min( Math.abs( i - tipIdx ), Math.abs( j - tipIdx ) ) <= 3;
				console.log( `  seg[${ i }] x seg[${ j }]  ${ nearHead ? '<- involves HEAD region' : '(body-body overlap)' }` );
			}
		}
	}
}

const spiral = buildTightSpiralEnd( 80 );
report( 'tight-spiral-end-80pts', createCurvedArrow( spiral ), spiral[ spiral.length - 1 ] );

const attackSpine = buildHookPoints( 40 );
const attackCp: LonLatPoint[] = [ [ 115.978, 38.998 ], [ 115.982, 39.006 ], ...attackSpine.slice( 1 ) ];
report( 'attack-freehand-hook', createAttackArrow( attackCp ), attackCp[ attackCp.length - 1 ] );
