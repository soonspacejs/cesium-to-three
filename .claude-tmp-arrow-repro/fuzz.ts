// 模糊测试:确定性伪随机生成大量控制点,断言箭头生成器永不崩溃、输出合法。
import {
	createAttackArrow,
	createCurvedArrow,
	createSwallowtailAttackArrow,
} from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

// 确定性 LCG(可复现)。
let seed = 1234567;
function rand(): number {
	seed = ( seed * 1103515245 + 12345 ) & 0x7fffffff;
	return seed / 0x7fffffff;
}

function selfX( ring: readonly LonLatPoint[] ): number {
	const n = ring.length; if ( n < 4 ) return 0; let h = 0;
	const seg = ( a: LonLatPoint, b: LonLatPoint, c: LonLatPoint, d: LonLatPoint ): boolean => {
		const cr = ( o: LonLatPoint, p: LonLatPoint, q: LonLatPoint ): number => ( p[ 0 ] - o[ 0 ] ) * ( q[ 1 ] - o[ 1 ] ) - ( p[ 1 ] - o[ 1 ] ) * ( q[ 0 ] - o[ 0 ] );
		const d1 = cr( c, d, a ), d2 = cr( c, d, b ), d3 = cr( a, b, c ), d4 = cr( a, b, d );
		return ( ( d1 > 0 && d2 < 0 ) || ( d1 < 0 && d2 > 0 ) ) && ( ( d3 > 0 && d4 < 0 ) || ( d3 < 0 && d4 > 0 ) );
	};
	for ( let i = 0; i < n; i++ ) for ( let j = i + 2; j < n; j++ ) { if ( i === 0 && j === n - 1 ) continue; if ( seg( ring[ i ], ring[ ( i + 1 ) % n ], ring[ j ], ring[ ( j + 1 ) % n ] ) ) h++; }
	return h;
}

type Shape = 'walk' | 'spiral' | 'zigzag' | 'coincident' | 'collinear' | 'tiny' | 'huge' | 'nan';

function gen( shape: Shape, count: number ): LonLatPoint[] {
	const cx = 116 + ( rand() - 0.5 ) * 20, cy = 30 + ( rand() - 0.5 ) * 40;
	const pts: LonLatPoint[] = [];
	switch ( shape ) {
		case 'walk': { let x = 0, y = 0; for ( let i = 0; i < count; i++ ) { x += ( rand() - 0.5 ) * 0.02; y += ( rand() - 0.5 ) * 0.02; pts.push( [ cx + x, cy + y ] ); } break; }
		case 'spiral': { for ( let i = 0; i < count; i++ ) { const t = i / count; const a = t * Math.PI * ( 2 + rand() * 6 ); const r = 0.01 * ( 1 - t * 0.7 ); pts.push( [ cx + r * Math.cos( a ), cy + r * Math.sin( a ) ] ); } break; }
		case 'zigzag': { for ( let i = 0; i < count; i++ ) { pts.push( [ cx + i * 0.005, cy + ( i % 2 ) * 0.01 ] ); } break; }
		case 'coincident': { for ( let i = 0; i < count; i++ ) { pts.push( rand() < 0.4 ? [ cx, cy ] : [ cx + rand() * 0.02, cy + rand() * 0.02 ] ); } break; }
		case 'collinear': { for ( let i = 0; i < count; i++ ) { pts.push( [ cx + i * 0.003, cy ] ); } break; }
		case 'tiny': { for ( let i = 0; i < count; i++ ) { pts.push( [ cx + i * 1e-7, cy + ( rand() - 0.5 ) * 1e-7 ] ); } break; }
		case 'huge': { for ( let i = 0; i < count; i++ ) { pts.push( [ cx + ( rand() - 0.5 ) * 50, cy + ( rand() - 0.5 ) * 50 ] ); } break; }
		case 'nan': { for ( let i = 0; i < count; i++ ) { const bad = rand() < 0.2; pts.push( [ bad ? NaN : cx + rand() * 0.02, bad ? Infinity : cy + rand() * 0.02 ] ); } break; }
	}
	return pts;
}

const shapes: Shape[] = [ 'walk', 'spiral', 'zigzag', 'coincident', 'collinear', 'tiny', 'huge', 'nan' ];
const gens = [
	{ name: 'curved', fn: ( cp: LonLatPoint[] ) => createCurvedArrow( cp ) },
	{ name: 'attack', fn: ( cp: LonLatPoint[] ) => createAttackArrow( cp ) },
	{ name: 'swallow', fn: ( cp: LonLatPoint[] ) => createSwallowtailAttackArrow( cp ) },
];

let total = 0, fails = 0;
const failSamples: string[] = [];
for ( let iter = 0; iter < 400; iter++ ) {
	const shape = shapes[ Math.floor( rand() * shapes.length ) ];
	const count = 2 + Math.floor( rand() * 200 );
	const cp = gen( shape, count );
	for ( const g of gens ) {
		total++;
		try {
			const ring = g.fn( cp );
			// 断言
			const tooMany = ring.length > 120;
			const badLen = ring.length !== 0 && ring.length < 3;
			const hasNaN = ring.some( ( p ) => ! Number.isFinite( p[ 0 ] ) || ! Number.isFinite( p[ 1 ] ) );
			const sx = ring.length > 0 ? selfX( ring ) : 0;
			if ( tooMany || badLen || hasNaN || sx > 0 ) {
				fails++;
				if ( failSamples.length < 25 ) {
					failSamples.push( `${ g.name } shape=${ shape } n=${ count } → ring=${ ring.length } tooMany=${ tooMany } badLen=${ badLen } NaN=${ hasNaN } selfX=${ sx }` );
				}
			}
		} catch ( e ) {
			fails++;
			if ( failSamples.length < 25 ) failSamples.push( `${ g.name } shape=${ shape } n=${ count } THREW ${ ( e as Error ).message }` );
		}
	}
}
console.log( `fuzz: ${ total } runs, ${ fails } failures` );
for ( const s of failSamples ) console.log( '  FAIL ' + s );
if ( fails === 0 ) console.log( 'ALL PASS ✅' );
