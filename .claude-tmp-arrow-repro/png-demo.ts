// 用两个 demo 的精确 hook 控制点渲染 PNG,确认界面将看到的效果。
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';

// 与 arrow-demo.ts / plot-demo.ts 完全一致的钩形生成(scale 由 demo 决定)。
function demoHook( cx: number, cy: number, scaleM: number, count: number ): LonLatPoint[] {
	const mLon = 1.02e-5, mLat = 9.01e-6;
	const pts: LonLatPoint[] = [];
	for ( let i = 0; i < count; i++ ) {
		const t = i / ( count - 1 );
		let x: number, y: number;
		if ( t < 0.40 ) { const u = t / 0.40; x = ( -2 + u * 2 ) * scaleM; y = 0.8 * scaleM; }
		else if ( t < 0.75 ) { const u = ( t - 0.4 ) / 0.35; const a = Math.PI / 2 - u * Math.PI; x = 0.8 * scaleM * Math.cos( a ) * 1.4; y = 0.8 * scaleM * Math.sin( a ); }
		else { const u = ( t - 0.75 ) / 0.25; const a = -Math.PI / 2 - u * ( 160 * Math.PI / 180 ); x = ( -0.4 + 0.45 * Math.cos( a ) ) * scaleM; y = ( -0.45 + 0.45 * Math.sin( a ) ) * scaleM; }
		pts.push( [ cx + x * mLon, cy + y * mLat ] );
	}
	return pts;
}

const W = 760, H = 620;
function newImg(): Uint8Array { const b = new Uint8Array( W * H * 4 ); for ( let i = 0; i < W * H; i++ ) { b[ i * 4 ] = 20; b[ i * 4 + 1 ] = 22; b[ i * 4 + 2 ] = 24; b[ i * 4 + 3 ] = 255; } return b; }
function setPx( img: Uint8Array, x: number, y: number, r: number, g: number, b: number ): void { if ( x < 0 || x >= W || y < 0 || y >= H ) return; const i = ( y * W + x ) * 4; img[ i ] = r; img[ i + 1 ] = g; img[ i + 2 ] = b; }
function fillPoly( img: Uint8Array, poly: [ number, number ][], r: number, g: number, b: number ): void {
	let minY = Infinity, maxY = -Infinity; for ( const p of poly ) { minY = Math.min( minY, p[ 1 ] ); maxY = Math.max( maxY, p[ 1 ] ); }
	minY = Math.max( 0, Math.floor( minY ) ); maxY = Math.min( H - 1, Math.ceil( maxY ) );
	for ( let y = minY; y <= maxY; y++ ) { const xs: number[] = []; for ( let i = 0; i < poly.length; i++ ) { const a = poly[ i ], c = poly[ ( i + 1 ) % poly.length ]; if ( ( a[ 1 ] <= y && c[ 1 ] > y ) || ( c[ 1 ] <= y && a[ 1 ] > y ) ) xs.push( a[ 0 ] + ( y - a[ 1 ] ) / ( c[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] ) ); } xs.sort( ( p, q ) => p - q ); for ( let k = 0; k + 1 < xs.length; k += 2 ) { const xa = Math.max( 0, Math.ceil( xs[ k ] ) ), xb = Math.min( W - 1, Math.floor( xs[ k + 1 ] ) ); for ( let x = xa; x <= xb; x++ ) setPx( img, x, y, r, g, b ); } }
}
function drawLine( img: Uint8Array, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, wd: number ): void { const steps = Math.ceil( Math.hypot( x1 - x0, y1 - y0 ) ) + 1; for ( let s = 0; s <= steps; s++ ) { const t = s / steps; const x = x0 + ( x1 - x0 ) * t, y = y0 + ( y1 - y0 ) * t; for ( let dx = -wd; dx <= wd; dx++ ) for ( let dy = -wd; dy <= wd; dy++ ) setPx( img, Math.round( x + dx ), Math.round( y + dy ), r, g, b ); } }
function encodePng( img: Uint8Array ): Buffer { const raw = Buffer.alloc( ( W * 4 + 1 ) * H ); for ( let y = 0; y < H; y++ ) { raw[ y * ( W * 4 + 1 ) ] = 0; img.subarray( y * W * 4, ( y + 1 ) * W * 4 ).forEach( ( v, i ) => { raw[ y * ( W * 4 + 1 ) + 1 + i ] = v; } ); } const idat = deflateSync( raw ); const ct = ( (): number[] => { const t: number[] = []; for ( let n = 0; n < 256; n++ ) { let c = n; for ( let k = 0; k < 8; k++ ) c = c & 1 ? 0xedb88320 ^ ( c >>> 1 ) : c >>> 1; t[ n ] = c >>> 0; } return t; } )(); const crc = ( buf: Buffer ): number => { let c = 0xffffffff; for ( let i = 0; i < buf.length; i++ ) c = ct[ ( c ^ buf[ i ] ) & 0xff ] ^ ( c >>> 8 ); return ( c ^ 0xffffffff ) >>> 0; }; const chunk = ( type: string, data: Buffer ): Buffer => { const len = Buffer.alloc( 4 ); len.writeUInt32BE( data.length ); const t = Buffer.from( type, 'ascii' ); const cr = Buffer.alloc( 4 ); cr.writeUInt32BE( crc( Buffer.concat( [ t, data ] ) ) ); return Buffer.concat( [ len, t, data, cr ] ); }; const sig = Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ); const ihdr = Buffer.alloc( 13 ); ihdr.writeUInt32BE( W, 0 ); ihdr.writeUInt32BE( H, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 6; return Buffer.concat( [ sig, chunk( 'IHDR', ihdr ), chunk( 'IDAT', idat ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] ); }

function render( name: string, cp: LonLatPoint[] ): void {
	const ring = createCurvedArrow( cp );
	const all = ring.concat( cp );
	const xs = all.map( p => p[ 0 ] ), ys = all.map( p => p[ 1 ] );
	const minX = Math.min( ...xs ), maxX = Math.max( ...xs ), minY = Math.min( ...ys ), maxY = Math.max( ...ys );
	const sc = ( Math.min( W, H ) - 70 ) / Math.max( maxX - minX, maxY - minY );
	const px = ( p: LonLatPoint ): [ number, number ] => [ ( p[ 0 ] - minX ) * sc + 35, H - ( ( p[ 1 ] - minY ) * sc + 35 ) ];
	const img = newImg();
	const poly = ring.map( px );
	fillPoly( img, poly, 40, 90, 230 );
	for ( let i = 0; i < poly.length; i++ ) { const a = poly[ i ], b = poly[ ( i + 1 ) % poly.length ]; drawLine( img, a[ 0 ], a[ 1 ], b[ 0 ], b[ 1 ], 235, 240, 255, 1 ); }
	writeFileSync( `.claude-tmp-arrow-repro/png-${ name }.png`, encodePng( img ) );
	console.log( `${ name }: ring=${ ring.length }` );
}

render( 'demo-ground', demoHook( 119, 28.2, 12, 48 ) );
render( 'demo-plot', demoHook( 119, 28.2, 14, 48 ) );
