import { Matrix4, PerspectiveCamera, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { HeightReference } from '../../../src/lib/plot-editor/document/types';
import { DrawingDraftLayer } from '../../../src/lib/plot-editor/render/DrawingDraftLayer';

function lineDraft( revision = 0, valid = true ) {
	return {
		id: 'drawing-1', revision, heightReference: HeightReference.NONE, valid,
		preview: {
			primitive: 'polyline' as const,
			positions: [ [ 116, 39, 10 ], [ 116.01, 39.01, 20 ] ] as const,
			closed: false, sourceType: 'line' as const, generated: false,
		},
	};
}

describe( 'DrawingDraftLayer', () => {
	it( '原始 polyline/polygon preview 使用逐顶点 RTE，非法状态仍可见', () => {
		const layer = new DrawingDraftLayer();
		layer.sync( lineDraft( 1, false ) );
		const primitive = layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' );
		expect( primitive ).toBeDefined();
		expect( layer.visible ).toBe( true );
		expect( layer.root.getObjectByName( 'EditorMarker:drawing-1:draft-vertex:0' ) ).toBeDefined();
	} );

	it( '同 revision 保留 GPU 对象，新 revision 原子替换，取消清空', () => {
		const layer = new DrawingDraftLayer();
		layer.sync( lineDraft( 1 ) );
		const previous = layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' );
		layer.sync( lineDraft( 1 ) );
		expect( layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' ) ).toBe( previous );
		layer.sync( lineDraft( 2 ) );
		expect( layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' ) ).not.toBe( previous );
		layer.sync( null );
		expect( layer.visible ).toBe( false );
		expect( layer.root.children ).toHaveLength( 1 );
	} );

	it( '同 revision 的有效性与异步 resolved height 变化仍会替换预览', () => {
		const layer = new DrawingDraftLayer();
		layer.sync( lineDraft( 1, false ) );
		const invalid = layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' );

		layer.sync( lineDraft( 1, true ) );
		const valid = layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' );
		expect( valid ).not.toBe( invalid );

		layer.sync( {
			...lineDraft( 1, true ),
			resolvedPositions: [ [ 116, 39, 110 ], [ 116.01, 39.01, 120 ] ],
		} );
		expect( layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' ) ).not.toBe( valid );
	} );

	it( '点/文本在尚未能构成 canonical feature 时仍显示可编辑锚点', () => {
		const layer = new DrawingDraftLayer();
		layer.sync( {
			id: 'text-draft', revision: 0, heightReference: HeightReference.CLAMP_TO_TERRAIN,
			valid: false,
			preview: {
				primitive: 'text', positions: [ [ 120, 30, 0 ] ], closed: false,
				sourceType: 'text', generated: false, text: '',
			},
		} );
		expect( layer.visible ).toBe( true );
		expect( layer.root.getObjectByName( 'EditorMarker:text-draft:draft-vertex:0' ) ).toBeDefined();
	} );

	it( '拒绝解算高度数量不匹配，且 update/dispose 幂等', () => {
		const layer = new DrawingDraftLayer();
		expect( () => layer.sync( {
			...lineDraft(), resolvedPositions: [ [ 116, 39, 100 ] ],
		} ) ).toThrow( /DRAFT_RESOLVED_LENGTH_MISMATCH/ );
		layer.sync( lineDraft() );
		const camera = new PerspectiveCamera();
		expect( () => layer.update( {
			depthTexture: new Texture(), width: 800, height: 600, camera, pixelRatio: 1,
		}, {
			widthDevicePixels: 800, heightDevicePixels: 600, devicePixelRatio: 1,
			cameraPositionEcef: [ 6378137, 0, 0 ],
			viewProjectionRotation: new Matrix4().toArray(),
			projectionMatrix: new Matrix4().toArray(),
		} ) ).not.toThrow();
		layer.dispose();
		layer.dispose();
		expect( layer.root.children ).toHaveLength( 0 );
		expect( () => layer.sync( null ) ).toThrow( /已销毁/ );
	} );

	it( '3D Tiles 草稿 unavailable 时不回退到椭球高度', () => {
		const layer = new DrawingDraftLayer();
		layer.sync( {
			...lineDraft( 1 ),
			heightReference: HeightReference.CLAMP_TO_3D_TILE,
			surfaceStatus: 'unavailable',
		} );
		expect( layer.visible ).toBe( false );
		expect( layer.root.getObjectByName( 'PlotVariableHeight:drawing-1' ) ).toBeUndefined();
	} );
} );
