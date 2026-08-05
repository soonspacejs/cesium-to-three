import { Group, Mesh, PerspectiveCamera, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltinGeometryAdapterRegistry } from '../../../src/lib/plot-editor/adapters/builtins';
import { HeightReference, type PlotFeature } from '../../../src/lib/plot-editor/document/types';
import { normalizeFeature } from '../../../src/lib/plot-editor/document/validate';
import { EditorOverlayRenderer } from '../../../src/lib/plot-editor/render/EditorOverlayRenderer';
import { EditorOverlayLayer } from '../../../src/lib/plot-editor/render/layers';

const STYLE = Object.freeze( {
	strokeColor: '#ffffff', strokeWidth: 2, strokeOpacity: 100,
	fillColor: '#1473e6', fillOpacity: 35,
} );

function line( id: string, offset = 0, revision = 0 ): PlotFeature {
	return normalizeFeature( {
		id,
		type: 'line',
		geometry: { positions: [ [ 116 + offset, 39, 10 ], [ 116.01 + offset, 39.01, 10 ] ] },
		style: {
			...STYLE, strokeStyle: 'solid', showArrow: false,
			startArrowStyle: null, endArrowStyle: null,
		},
		heightReference: HeightReference.NONE,
		visible: true,
		properties: {},
		revision,
	} );
}

function point(): PlotFeature {
	return normalizeFeature( {
		id: 'point-a', type: 'point', geometry: { position: [ 116, 39, 10 ] },
		style: { ...STYLE, pointStyle: 'circle', size: 12 },
		heightReference: HeightReference.NONE, visible: true, properties: {}, revision: 0,
	} );
}

function createRenderer() {
	const scene = new Group();
	const camera = new PerspectiveCamera( 60, 16 / 9, 1, 1e8 );
	camera.position.set( 6378137 + 1000, 0, 0 );
	camera.lookAt( 0, 0, 0 );
	camera.layers.enable( 7 );
	const requestRender = vi.fn();
	const onRenderError = vi.fn();
	const overlay = new EditorOverlayRenderer( {
		scene,
		camera,
		adapters: createBuiltinGeometryAdapterRegistry(),
		requestRender,
		onRenderError,
	} );
	return { scene, camera, requestRender, onRenderError, overlay };
}

describe( 'EditorOverlayRenderer', () => {
	it( '以固定顺序挂载五个根，并开启对应相机 layer', () => {
		const { scene, camera, overlay } = createRenderer();
		expect( scene.children.map( ( child ) => child.name ) ).toEqual( [
			'plotCommittedRoot', 'plotDraftRoot', 'plotSelectionRoot',
			'plotHandleRoot', 'plotGizmoRoot',
		] );
		for ( const layer of Object.values( EditorOverlayLayer ) ) {
			expect( camera.layers.isEnabled( layer ) ).toBe( true );
		}
		overlay.dispose();
	} );

	it( '同帧显示 committed、selection outline、单选控制点与 ENU Gizmo', () => {
		const { overlay } = createRenderer();
		const feature = line( 'line-a' );
		const result = overlay.sync( {
			features: [ feature ], documentRevision: 0, sessionRevision: 1,
			selection: { ids: [ 'line-a' ], primaryId: 'line-a', activeHandleId: 'vertex:0' },
			showHandles: true,
			transformMode: 'translate',
			activeGizmoHandleId: 'translate:east',
		} );
		expect( result.committed.renderedCount ).toBe( 1 );
		expect( result.selection.renderedCount ).toBe( 1 );
		expect( result.handleCount ).toBe( 5 );
		expect( result.gizmoCount ).toBe( 4 );
		expect( overlay.plotHandleRoot.children.some( ( child ) =>
			child.userData.editorPickProxy?.handleId === 'vertex:0'
			&& child.material.depthTest === false,
		) ).toBe( true );

		// 普通/RTE overlay mesh 不得遗留在默认 camera-raycast layer 0。
		for ( const root of [ overlay.plotCommittedRoot, overlay.plotSelectionRoot ] ) {
			root.traverse( ( object ) => {
				if ( object instanceof Mesh ) expect( object.layers.isEnabled( 0 ) ).toBe( false );
			} );
		}
	} );

	it( '控制点/Gizmo 命中使用 CSS 形状代理，完全不依赖 Three Raycaster', () => {
		const { overlay } = createRenderer();
		overlay.sync( {
			features: [ line( 'line-a' ) ], documentRevision: 0, sessionRevision: 1,
			selection: { ids: [ 'line-a' ], primaryId: 'line-a' },
			showHandles: true, transformMode: 'translate',
		} );
		const projection = {
			project: () => ( { x: 100, y: 100, depth: 0.5, visible: true } ),
		};
		const handleHits = overlay.hitTestOverlayMarkers( { x: 100, y: 100 }, projection );
		expect( handleHits.some( ( hit ) => hit.layer === 'handle' ) ).toBe( true );
		const axisHits = overlay.hitTestOverlayMarkers( { x: 140, y: 100 }, projection );
		expect( axisHits.some( ( hit ) =>
			hit.layer === 'gizmo' && hit.target.handleId === 'translate:east',
		) ).toBe( true );
	} );

	it( '多选只显示整体 Gizmo，不混入任一图形的顶点控制点', () => {
		const { overlay } = createRenderer();
		const features = [ line( 'a' ), line( 'b', 0.02 ) ];
		const result = overlay.sync( {
			features, documentRevision: 0, sessionRevision: 1,
			selection: { ids: [ 'a', 'b' ], primaryId: 'b' },
			showHandles: true, transformMode: 'scale',
		} );
		expect( result.handleCount ).toBe( 0 );
		expect( result.gizmoCount ).toBe( 4 );
	} );

	it( '非法 draft 仍保持可见，取消只清理 draft 而不替换 committed 图元', () => {
		const { overlay } = createRenderer();
		const committed = line( 'line-a' );
		overlay.sync( {
			features: [ committed ], documentRevision: 0, sessionRevision: 1,
			draftFeatures: [ line( 'line-a', 0.02 ) ], draftValid: false,
		} );
		const committedObject = overlay.plotCommittedRoot.children[ 0 ];
		expect( overlay.plotDraftRoot.children.length ).toBeGreaterThan( 0 );

		const cancelled = overlay.sync( {
			features: [ committed ], documentRevision: 0, sessionRevision: 2,
			draftFeatures: [],
		} );
		expect( cancelled.draft.renderedCount ).toBe( 0 );
		expect( overlay.plotDraftRoot.children ).toHaveLength( 1 );
		expect( overlay.plotDraftRoot.children[ 0 ].name ).toBe( 'drawingDraftPreviewRoot' );
		expect( overlay.plotCommittedRoot.children[ 0 ] ).toBe( committedObject );
	} );

	it( '直接消费 DrawingSession preview，未达最小拓扑也不伪造 canonical feature', () => {
		const { overlay } = createRenderer();
		const result = overlay.sync( {
			features: [], documentRevision: 0, sessionRevision: 1,
			drawingDraft: {
				id: 'drawing-raw', revision: 1, heightReference: HeightReference.NONE, valid: false,
				preview: {
					primitive: 'polyline', positions: [ [ 116, 39, 10 ] ],
					closed: false, sourceType: 'line', generated: false,
				},
			},
		} );
		expect( result.drawingDraftVisible ).toBe( true );
		expect( result.draft.renderedCount ).toBe( 0 );
		expect( overlay.plotDraftRoot.getObjectByName(
			'EditorMarker:drawing-raw:draft-vertex:0',
		) ).toBeDefined();
	} );

	it( '点/文本选择使用独立屏幕反馈，不复制业务内容材质', () => {
		const { overlay } = createRenderer();
		const feature = point();
		const result = overlay.sync( {
			features: [ feature ], documentRevision: 0, sessionRevision: 1,
			selection: { ids: [ feature.id ], primaryId: feature.id },
		} );
		expect( result.selection.renderedCount ).toBe( 0 );
		expect( overlay.plotSelectionRoot.getObjectByName( 'EditorMarker:selection-marker:point-a' ) ).toBeDefined();
	} );

	it( 'hover outline 与 selection 并存，且 hover 不改变文档', () => {
		const { overlay } = createRenderer();
		const features = [ line( 'selected' ), line( 'hovered', 0.03 ) ];
		const result = overlay.sync( {
			features, documentRevision: 7, sessionRevision: 2,
			selection: {
				ids: [ 'selected' ], primaryId: 'selected',
				hoverTarget: { kind: 'entity', entityId: 'hovered', distanceCssPixels: 1, depth: 0.5, zOrder: 0 },
			},
		} );
		expect( result.selection.renderedCount ).toBe( 2 );
		expect( result.committed.documentRevision ).toBe( 7 );
		expect( overlay.plotSelectionRoot.children.length ).toBeGreaterThan( 2 );
	} );

	it( '框选矩形位于 PLOT_FEEDBACK，不进入选择拾取或文档', () => {
		const { overlay, camera } = createRenderer();
		const result = overlay.sync( {
			features: [], documentRevision: 3, sessionRevision: 1,
			boxSelection: {
				start: { x: 10, y: 20 }, current: { x: 120, y: 160 },
				additive: true, valid: true,
			},
		} );
		expect( result.boxSelectionVisible ).toBe( true );
		expect( result.selection.renderedCount ).toBe( 0 );
		expect( overlay.plotSelectionRoot.getObjectByName( 'boxSelectionFeedbackRoot' ) ).toBeDefined();
		overlay.update( {
			depthTexture: new Texture(), width: 1600, height: 1200, pixelRatio: 2, camera,
		} );
		expect( overlay.plotSelectionRoot.getObjectByName( 'boxSelectionFeedbackRoot' )?.children )
			.toHaveLength( 2 );
	} );

	it( 'update 更新三条图元路径和屏幕标记；dispose 幂等且不处置宿主资源', () => {
		const { scene, camera, requestRender, overlay } = createRenderer();
		overlay.sync( {
			features: [ line( 'line-a' ) ], documentRevision: 0, sessionRevision: 1,
			selection: { ids: [ 'line-a' ], primaryId: 'line-a' }, showHandles: true,
		} );
		expect( () => overlay.update( {
			depthTexture: new Texture(), width: 1920, height: 1080,
			camera, pixelRatio: 2,
		} ) ).not.toThrow();

		overlay.dispose();
		overlay.dispose();
		expect( scene.children ).toHaveLength( 0 );
		expect( camera.layers.isEnabled( 7 ) ).toBe( true );
		expect( camera.layers.isEnabled( EditorOverlayLayer.PLOT_CONTENT ) ).toBe( false );
		expect( requestRender ).toHaveBeenCalledWith( 'dispose' );
		expect( () => overlay.sync( {
			features: [], documentRevision: 0, sessionRevision: 2,
		} ) ).toThrow( /已销毁/ );
	} );

	it( '投影失败带上 pass 语义与 feature id', () => {
		const { overlay, onRenderError } = createRenderer();
		const malformed = { ...line( 'broken' ), type: 'model' } as unknown as PlotFeature;
		const result = overlay.sync( {
			features: [ malformed ], documentRevision: 0, sessionRevision: 0,
		} );
		expect( result.committed.failedIds ).toEqual( [ 'broken' ] );
		expect( onRenderError ).toHaveBeenCalledWith( expect.objectContaining( {
			pass: 'committed', featureId: 'broken', code: 'RENDER_BUILD_FAILED',
		} ) );
	} );
} );
