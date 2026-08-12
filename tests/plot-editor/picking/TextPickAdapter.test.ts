import { Box3, DoubleSide, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createEnuFrame, enuToEcef } from '../../../src/lib/plot-editor/document/geodesy';
import { HeightReference, type TextFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { TextPickAdapter } from '../../../src/lib/plot-editor/picking/adapters/TextPickAdapter';

function text( patch: Partial<TextFeature[ 'style' ]> = {} ): TextFeature {
	return normalizeFeature( { id: 'text', type: 'text', geometry: { position: [ 116, 39, 100 ] },
		style: { strokeColor: '#fff', strokeWidth: 1, strokeOpacity: 100,
			fillColor: '#000', fillOpacity: 50, content: '中文AB', fontColor: '#fff',
			fontSize: 20, scale: 1, textAlign: 'center', verticalAlign: 'middle',
			anchorX: 'center', anchorY: 'middle', padding: 4,
			layoutDirection: 'horizontal', rotation: 0, offsetX: 0, offsetY: 0,
			showBorder: true, ...patch }, heightReference: HeightReference.NONE,
		visible: true, properties: {}, revision: 0 } ) as TextFeature;
}

describe( 'TextPickAdapter', () => {
	it( '内容宽度与字号直接来自共享测量函数，不使用固定默认框', () => {
		const measure = vi.fn( ( value: string, fontSize: number ) => value.length * fontSize );
		const adapter = new TextPickAdapter( { measureText: measure } );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const short = adapter.build( text( { content: 'A' } ), [ 116, 39, 100 ], material )!;
		const long = adapter.build( text( { content: 'AAAAAA' } ), [ 116, 39, 100 ], material )!;
		const edgeWidth = ( result: typeof short ) => {
			const positions = result.geometries[ 0 ].getAttribute( 'position' );
			return new Vector3().fromBufferAttribute( positions, 0 ).distanceTo(
				new Vector3().fromBufferAttribute( positions, 1 ),
			);
		};
		// 1 字宽 20 + 左右 padding 8；6 字宽 120 + 左右 padding 8。
		expect( edgeWidth( short ) ).toBeCloseTo( 28, 1 );
		expect( edgeWidth( long ) ).toBeCloseTo( 128, 1 );
		expect( measure ).toHaveBeenCalled();
	} );

	it( 'anchor、offset 与 rotation 会改变实际平面包围方向和位置', () => {
		const adapter = new TextPickAdapter( { measureText: ( value, size ) => value.length * size } );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const base = adapter.build( text( { boxWidth: 120, boxHeight: 20 } ), [ 116, 39, 100 ], material )!;
		const rotated = adapter.build( text( { boxWidth: 120, boxHeight: 20, rotation: 90,
			anchorX: 'left', anchorY: 'top', offsetX: 30, offsetY: -20 } ),
		[ 116, 39, 100 ], material )!;
		const baseBox = new Box3().setFromObject( base.root );
		const rotatedBox = new Box3().setFromObject( rotated.root );
		expect( rotatedBox.getCenter( new Vector3() ).distanceTo( baseBox.getCenter( new Vector3() ) ) )
			.toBeGreaterThan( 20 );
		expect( rotatedBox.getSize( new Vector3() ).distanceTo( baseBox.getSize( new Vector3() ) ) )
			.toBeGreaterThan( 40 );
	} );

	it( '旋转文本只命中真实四边形，不命中轴对齐外包框的空角', () => {
		const worldPosition = [ 116, 39, 100 ] as const;
		const adapter = new TextPickAdapter( { measureText: ( value, size ) => value.length * size } );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const result = adapter.build(
			text( { boxWidth: 120, boxHeight: 20, rotation: 45 } ),
			worldPosition,
			material,
		)!;
		result.root.updateWorldMatrix( true, true );
		const frame = createEnuFrame( worldPosition );
		const raycaster = new Raycaster();
		const castAt = ( east: number, north: number ) => {
			const surface = enuToEcef( [ east, north, 0 ], frame );
			const origin = new Vector3(
				surface[ 0 ] + frame.up[ 0 ] * 100,
				surface[ 1 ] + frame.up[ 1 ] * 100,
				surface[ 2 ] + frame.up[ 2 ] * 100,
			);
			raycaster.set( origin, new Vector3( ...frame.up ).negate() );
			return raycaster.intersectObject( result.root, true );
		};
		expect( castAt( 0, 0 ) ).toHaveLength( 1 );
		// (0, 40) 位于旋转后 AABB 内，但位于 120×20 的真实文本四边形外。
		expect( castAt( 0, 40 ) ).toHaveLength( 0 );
	} );

	it( '竖排布局改变代理宽高，拾取平面与显示排版继续同源', () => {
		const adapter = new TextPickAdapter( { measureText: ( value, size ) => value.length * size } );
		const material = new MeshBasicMaterial( { side: DoubleSide } );
		const horizontal = adapter.build( text( { content: 'ABCD', layoutDirection: 'horizontal' } ),
			[ 116, 39, 100 ], material )!;
		const vertical = adapter.build( text( { content: 'ABCD', layoutDirection: 'vertical-rl' } ),
			[ 116, 39, 100 ], material )!;
		const horizontalSize = new Box3().setFromObject( horizontal.root ).getSize( new Vector3() );
		const verticalSize = new Box3().setFromObject( vertical.root ).getSize( new Vector3() );
		expect( horizontalSize.distanceTo( verticalSize ) ).toBeGreaterThan( 50 );
	} );
} );
