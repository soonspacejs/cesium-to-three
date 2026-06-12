// 复现 + 渲染 swallowtailAttack(用 demo 的精确控制点与选项)。
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createSwallowtailAttackArrow, createAttackArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

const mLon = 1.02e-5, mLat = 9.01e-6;
const cLon = 119, cLat = 28.2;
// demo arrow-demo.ts 的 swallowtailAttackArrow 控制点
const cp: LonLatPoint[] = [
	[ cLon - 4.0 * mLon, cLat - 38.5 * mLat ],
	[ cLon - 4.0 * mLon, cLat - 41.5 * mLat ],
	[ cLon + 6.0 * mLon, cLat - 40.0 * mLat ],
	[ cLon + 14.0 * mLon, cLat - 40.0 * mLat ],
];
const opts = { headHeightFactor: 0.28, headWidthFactor: 0.55, neckHeightFactor: 0.85, neckWidthFactor: 0.22, headTailFactor: 1.25, minBodyHalfAngleRadians: Math.PI / 12, bodyWidthMargin: 1.05, bodySmoothingSegments: 12, swallowtailFactor: 0.70, tailWidthFactor: 0.08 };

const ringS = createSwallowtailAttackArrow( cp, opts );
const ringA = createAttackArrow( cp, opts );
console.log( 'swallowtail ring length:', ringS.length );
console.log( 'attack     ring length:', ringA.length );
console.log( 'swallowtail ring:', JSON.stringify( ringS.map( p => [ +( ( p[ 0 ] - cLon ) / mLon ).toFixed( 1 ), +( ( p[ 1 ] - cLat ) / mLat ).toFixed( 1 ) ] ) ) );

// 渲染对比图
const W = 760, H = 420;
function newImg(): Uint8Array { const b = new Uint8Array( W * H * 4 ); for ( let i = 0; i < W * H; i++ ) { b[ i * 4 ] = 22; b[ i * 4 + 1 ] = 24; b[ i * 4 + 2 ] = 26; b[ i * 4 + 3 ] = 255; } return b; }
function setPx( img: Uint8Array, x: number, y: number, r: number, g: number, b: number ): void { if ( x < 0 || x >= W || y < 0 || y >= H ) return; const i = ( y * W + x ) * 4; img[ i ] = r; img[ i + 1 ] = g; img[ i + 2 ] = b; }
function fillPoly( img: Uint8Array, poly: [ number, number ][], r: number, g: number, b: number ): void { if ( poly.length < 3 ) return; let minY = Infinity, maxY = -Infinity; for ( const p of poly ) { minY = Math.min( minY, p[ 1 ] ); maxY = Math.max( maxY, p[ 1 ] ); } minY = Math.max( 0, Math.floor( minY ) ); maxY = Math.min( H - 1, Math.ceil( maxY ) ); for ( let y = minY; y <= maxY; y++ ) { const xs: number[] = []; for ( let i = 0; i < poly.length; i++ ) { const a = poly[ i ], c = poly[ ( i + 1 ) % poly.length ]; if ( ( a[ 1 ] <= y && c[ 1 ] > y ) || ( c[ 1 ] <= y && a[ 1 ] > y ) ) xs.push( a[ 0 ] + ( y - a[ 1 ] ) / ( c[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] ) ); } xs.sort( ( p, q ) => p - q ); for ( let k = 0; k + 1 < xs.length; k += 2 ) { const xa = Math.max( 0, Math.ceil( xs[ k ] ) ), xb = Math.min( W - 1, Math.floor( xs[ k + 1 ] ) ); for ( let x = xa; x <= xb; x++ ) setPx( img, x, y, r, g, b ); } } }
function drawLine( img: Uint8Array, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number ): void { const steps = Math.ceil( Math.hypot( x1 - x0, y1 - y0 ) ) + 1; for ( let s = 0; s <= steps; s++ ) { const t = s / steps; setPx( img, Math.round( x0 + ( x1 - x0 ) * t ), Math.round( y0 + ( y1 - y0 ) * t ), r, g, b ); } }
function encodePng( img: Uint8Array ): Buffer { const raw = Buffer.alloc( ( W * 4 + 1 ) * H ); for ( let y = 0; y < H; y++ ) { raw[ y * ( W * 4 + 1 ) ] = 0; img.subarray( y * W * 4, ( y + 1 ) * W * 4 ).forEach( ( v, i ) => { raw[ y * ( W * 4 + 1 ) + 1 + i ] = v; } ); } const idat = deflateSync( raw ); const ct = ( (): number[] => { const t: number[] = []; for ( let n = 0; n < 256; n++ ) { let c = n; for ( let k = 0; k < 8; k++ ) c = c & 1 ? 0xedb88320 ^ ( c >>> 1 ) : c >>> 1; t[ n ] = c >>> 0; } return t; } )(); const crc = ( buf: Buffer ): number => { let c = 0xffffffff; for ( let i = 0; i < buf.length; i++ ) c = ct[ ( c ^ buf[ i ] ) & 0xff ] ^ ( c >>> 8 ); return ( c ^ 0xffffffff ) >>> 0; }; const chunk = ( type: string, data: Buffer ): Buffer => { const len = Buffer.alloc( 4 ); len.writeUInt32BE( data.length ); const tt = Buffer.from( type, 'ascii' ); const cr = Buffer.alloc( 4 ); cr.writeUInt32BE( crc( Buffer.concat( [ tt, data ] ) ) ); return Buffer.concat( [ len, tt, data, cr ] ); }; const sig = Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ); const ihdr = Buffer.alloc( 13 ); ihdr.writeUInt32BE( W, 0 ); ihdr.writeUInt32BE( H, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 6; return Buffer.concat( [ sig, chunk( 'IHDR', ihdr ), chunk( 'IDAT', idat ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] ); }

function bbox( rings: LonLatPoint[][] ): [ number, number, number, number ] { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for ( const r of rings ) for ( const p of r ) { a = Math.min( a, p[ 0 ] ); b = Math.min( b, p[ 1 ] ); c = Math.max( c, p[ 0 ] ); d = Math.max( d, p[ 1 ] ); } return [ a, b, c, d ]; }
const [ minX, minY, maxX, maxY ] = bbox( [ ringS, ringA, cp ] );
const sc = ( Math.min( W / 2, H ) - 50 ) / Math.max( maxX - minX, maxY - minY );
const img = newImg();
function place( ring: LonLatPoint[], ox: number, col: [ number, number, number ] ): void { const px = ( p: LonLatPoint ): [ number, number ] => [ ( p[ 0 ] - minX ) * sc + ox, H - ( ( p[ 1 ] - minY ) * sc + 25 ) ]; const poly = ring.map( px ); fillPoly( img, poly, col[ 0 ], col[ 1 ], col[ 2 ] ); for ( let i = 0; i < poly.length; i++ ) { const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ]; drawLine( img, a[ 0 ], a[ 1 ], b[ 0 ], b[ 1 ], 240, 240, 255 ); } }
place( ringA, 25, [ 200, 60, 40 ] );          // attack (左, 红)
place( ringS, W / 2 + 10, [ 150, 50, 220 ] );  // swallowtail (右, 紫)
writeFileSync( '.claude-tmp-arrow-repro/png-swallow.png', encodePng( img ) );
console.log( 'wrote png-swallow.png (left=attack red, right=swallowtail purple)' );
