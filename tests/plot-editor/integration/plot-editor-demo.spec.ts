import { expect, test, type Page } from '@playwright/test';

import type { EditorCommand, PlotFeature, Position3D } from '../../../src/lib/plot-editor';
import {
	createEnuFrame,
	ecefToGeodetic,
	enuToEcef,
} from '../../../src/lib/plot-editor/document/geodesy';

interface DemoEditorApi {
	dispose(): void;
	readonly renderer: {
		getContext(): WebGL2RenderingContext;
		render( scene: object, camera: object ): void;
	};
	readonly scene: {
		readonly children: readonly { readonly name: string }[];
		getObjectByName( name: string ): { readonly children: readonly unknown[] } | undefined;
	};
	readonly camera: {
		updateMatrixWorld(): void;
		readonly position: { toArray(): number[] };
		readonly quaternion: { toArray(): number[] };
	};
	readonly controls: {
		enabled: boolean;
	};
	readonly editor: {
		readonly mode: string;
		readonly selection: ReadonlySet<string>;
		readonly selectionState: { readonly activeHandleId?: string };
		readonly document: {
			readonly revision: number;
			get( id: string ): Readonly<PlotFeature> | undefined;
			getAll(): readonly Readonly<PlotFeature>[];
		};
		activateTool( tool: string ): void;
		clearSelection(): void;
		dispose(): void;
		execute( command: EditorCommand ): { readonly ok: boolean; readonly error?: { readonly message: string } };
		select( ids: Iterable<string> ): void;
		enterVertexEdit( id: string ): void;
		focus(): void;
		readonly _pointer: { readonly activePointerId: number | null };
		readonly _transform: {
			readonly session: {
				readonly mode: string;
				readonly axis?: string;
				readonly pivot: { readonly position: Position3D };
			} | null;
		};
		_createProjectionSnapshot(): {
			project( position: readonly [ number, number, number ] ): {
				x: number;
				y: number;
				visible: boolean;
			} | null;
		};
	};
}

test.afterEach( async ( { page } ) => {
	await page.evaluate( () => window.__plotDemo?.dispose() );
} );

declare global {
	interface Window {
		__plotDemo?: DemoEditorApi;
	}
}

test( '八类图形的可见内部点均经 DOM pointer 命中 canonical selection', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const targets = await page.evaluate( () => {
		const demo = window.__plotDemo!;
		const editor = demo.editor as unknown as { readonly _overlay: { readonly plotEntityPickRoot: {
			traverse( callback: ( object: any ) => void ): void;
		} } };
		const canvas = demo.renderer.domElement;
		const rect = canvas.getBoundingClientRect();
		return demo.editor.document.getAll().map( ( feature ) => {
			let mesh: any;
			editor._overlay.plotEntityPickRoot.traverse( ( object ) => {
				if ( mesh === undefined && object.userData.plotPick?.featureId === feature.id ) {
					object.traverse( ( child: any ) => {
						if ( mesh === undefined && child.geometry?.getAttribute( 'position' ) !== undefined ) mesh = child;
					} );
				}
			} );
			if ( mesh === undefined ) throw new Error( `${ feature.id } 缺少拾取 Mesh。` );
			const attribute = mesh.geometry.getAttribute( 'position' );
			const index = mesh.geometry.index;
			const a = mesh.position.clone().fromBufferAttribute( attribute, index?.getX( 0 ) ?? 0 );
			const b = mesh.position.clone().fromBufferAttribute( attribute, index?.getX( 1 ) ?? 1 );
			const c = mesh.position.clone().fromBufferAttribute( attribute, index?.getX( 2 ) ?? 2 );
			const world = a.add( b ).add( c ).multiplyScalar( 1 / 3 );
			mesh.localToWorld( world );
			const ndc = world.project( demo.camera as any );
			return { id: feature.id as string, type: feature.type as string, point: {
				x: rect.left + ( ndc.x + 1 ) * rect.width / 2,
				y: rect.top + ( 1 - ndc.y ) * rect.height / 2,
				visible: ndc.z >= -1 && ndc.z <= 1,
			} };
		} );
	} );

	for ( const target of targets ) {
		expect( target.point, `${ target.type } 缺少可见 CSS 投影` ).not.toBeNull();
		expect( target.point?.visible, `${ target.type } 投影不在相机前方` ).toBe( true );
		await page.evaluate( () => window.__plotDemo!.editor.clearSelection() );
		await page.mouse.click( target.point!.x, target.point!.y );
		await expect.poll( () => page.evaluate( () => [ ...window.__plotDemo!.editor.selection ] ) )
			.toEqual( [ target.id ] );
	}

	const renderEvidence = await page.evaluate( () => {
		const demo = window.__plotDemo!;
		demo.renderer.render( demo.scene, demo.camera );
		const gl = demo.renderer.getContext();
		const pixels = new Uint8Array( gl.drawingBufferWidth * gl.drawingBufferHeight * 4 );
		gl.finish();
		gl.readPixels(
			0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
			gl.RGBA, gl.UNSIGNED_BYTE, pixels,
		);
		let opaquePixels = 0;
		let nonDarkPixels = 0;
		for ( let offset = 0; offset < pixels.length; offset += 4 ) {
			if ( pixels[ offset + 3 ] > 0 ) opaquePixels++;
			if ( pixels[ offset ] + pixels[ offset + 1 ] + pixels[ offset + 2 ] > 90 ) {
				nonDarkPixels++;
			}
		}
		return {
			pixelCount: pixels.length / 4,
			opaquePixels,
			nonDarkPixels,
			rootNames: demo.scene.children.map( ( child ) => child.name ).filter(
				( name ) => name.startsWith( 'plot' ),
			),
		};
	} );
	expect( renderEvidence.opaquePixels ).toBeGreaterThan( renderEvidence.pixelCount * 0.95 );
	expect( renderEvidence.nonDarkPixels ).toBeGreaterThan( 1000 );
	expect( renderEvidence.rootNames ).toEqual( [
		'plotCommittedRoot',
		'plotDraftRoot',
		'plotSelectionRoot',
		'plotHandleRoot',
		'plotGizmoRoot',
		'plotEntityPickRoot',
	] );
	await page.evaluate( () => window.__plotDemo!.editor.enterVertexEdit( 'demo-line' ) );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.scene
		.getObjectByName( 'plotHandleRoot' )?.children.length ?? 0 ) ).toBeGreaterThanOrEqual( 5 );

	expect( browserErrors ).toEqual( [] );
} );

test( '点图形的可见圆面边缘可选中，并显示整体选中轮廓', async ( { page } ) => {
	await openDemo( page );
	const point = await page.evaluate( () => {
		const editor = window.__plotDemo!.editor;
		const feature = editor.document.get( 'demo-point' );
		if ( feature?.type !== 'point' || feature.style.pointStyle === 'image' ) {
			throw new Error( 'demo-point 不存在或不是几何点。' );
		}
		return { position: feature.geometry.position, size: feature.style.size };
	} );
	const frame = createEnuFrame( point.position );
	const edgeEcef = enuToEcef( [ point.size * 0.4, 0, 0 ], frame );
	const edge = ecefToGeodetic( edgeEcef, point.position[ 0 ] );
	const target = await page.evaluate( ( edgePosition ) => {
		const projected = window.__plotDemo!.editor._createProjectionSnapshot().project( edgePosition );
		if ( projected === null || ! projected.visible ) throw new Error( '点边缘不可见。' );
		return { x: projected.x, y: projected.y };
	}, edge );

	await page.mouse.click( target.x, target.y );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point' ] );
	await expect.poll( () => page.evaluate( () => {
		const root = window.__plotDemo!.scene.getObjectByName( 'plotSelectionRoot' );
		return root?.children.length ?? 0;
	} ) ).toBeGreaterThan( 1 );
} );

test( '绘制、历史、原生文本和键盘变换形成完整浏览器闭环', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const before = await snapshot( page );
	expect( before ).toMatchObject( { revision: 0, count: 8, mode: 'select' } );

	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'point' );
		window.__plotDemo!.editor.focus();
	} );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const drawingPoint = {
		x: canvas.x + canvas.width * 0.85,
		y: canvas.y + canvas.height * 0.75,
	};
	await page.mouse.click( drawingPoint.x, drawingPoint.y );
	await page.mouse.click( drawingPoint.x, drawingPoint.y, { button: 'right' } );
	await expect.poll( () => snapshot( page ) ).toMatchObject( {
		revision: 1, count: 9, mode: 'select',
	} );

	await page.keyboard.press( 'Control+z' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 2, count: 8 } );
	await page.keyboard.press( 'Control+y' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 3, count: 9 } );

	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'text' );
		window.__plotDemo!.editor.focus();
	} );
	// 相机中心射线稳定命中 WGS84 椭球，避免用任意屏幕百分比误点天空。
	await page.mouse.click( canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5 );
	const draftTextarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( draftTextarea ).toHaveCount( 1 );
	await draftTextarea.fill( '浏览器新建文本' );
	await draftTextarea.press( 'Control+Enter' );
	await expect( draftTextarea ).toHaveCount( 0 );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 4, count: 10, mode: 'select' } );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.getAll()
		.some( ( feature ) => feature.type === 'text' && feature.style.content === '浏览器新建文本' ) ) )
		.toBe( true );

	await page.evaluate( () => {
		window.__plotDemo!.editor.select( [ 'demo-text' ] );
		window.__plotDemo!.editor.focus();
	} );
	await page.keyboard.press( 'F2' );
	const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
	await expect( textarea ).toHaveCount( 1 );
	await textarea.fill( '浏览器中文输入' );
	await textarea.press( 'Control+Enter' );
	await expect( textarea ).toHaveCount( 0 );
	await expect.poll( () => page.evaluate( () => {
		const feature = window.__plotDemo!.editor.document.get( 'demo-text' );
		return feature?.type === 'text' ? feature.style.content : null;
	} ) ).toBe( '浏览器中文输入' );

	const transformBefore = await page.evaluate( () => {
		const editor = window.__plotDemo!.editor;
		editor.select( [ 'demo-point' ] );
		editor.focus();
		const feature = editor.document.get( 'demo-point' );
		return feature?.type === 'point' ? [ ...feature.geometry.position ] : null;
	} );
	await page.keyboard.press( 'g' );
	await page.keyboard.press( 'ArrowRight' );
	await page.keyboard.press( 'Enter' );
	const transformAfter = await page.evaluate( () => {
		const feature = window.__plotDemo!.editor.document.get( 'demo-point' );
		return feature?.type === 'point' ? [ ...feature.geometry.position ] : null;
	} );
	expect( transformAfter ).not.toEqual( transformBefore );
	expect( ( await snapshot( page ) ).mode ).toBe( 'select' );
	expect( browserErrors ).toEqual( [] );
} );

test( '八类图形经 DOM pointer 采点后均由键盘完成提交', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const at = ( x: number, y: number ) => ( {
		x: canvas.x + canvas.width * 0.5 + x,
		y: canvas.y + canvas.height * 0.5 + y,
	} );
	const cases = [
		{ type: 'point', points: [ at( -80, -45 ) ] },
		{ type: 'line', points: [ at( -60, -20 ), at( -20, -35 ) ] },
		{ type: 'polygon', points: [ at( 0, -30 ), at( 38, -20 ), at( 20, 12 ) ] },
		{ type: 'rectangle', points: [ at( -45, 5 ), at( -10, 35 ) ] },
		{ type: 'circle', points: [ at( 20, 30 ), at( 48, 30 ) ] },
		{ type: 'sector', points: [ at( 65, 5 ), at( 90, 5 ), at( 65, -20 ) ] },
		{ type: 'arrow', points: [ at( -90, 55 ), at( -45, 60 ) ] },
		{ type: 'text', points: [ at( 65, 55 ) ] },
	] as const;

	for ( const item of cases ) {
		const countBefore = await page.evaluate( () => window.__plotDemo!.editor.document.getAll().length );
		await page.evaluate( ( type ) => {
			window.__plotDemo!.editor.activateTool( type );
			window.__plotDemo!.editor.focus();
		}, item.type );
		for ( const point of item.points ) await page.mouse.click( point.x, point.y );
		if ( item.type === 'text' ) {
			const textarea = page.locator( 'textarea[data-plot-editor-native-input]' );
			await expect( textarea ).toHaveCount( 1 );
			await textarea.fill( '八类键盘完成' );
			await textarea.press( 'Control+Enter' );
		} else {
			await page.keyboard.press( 'Enter' );
		}
		await expect.poll( () => snapshot( page ) ).toMatchObject( {
			count: countBefore + 1,
			mode: 'select',
		} );
	}

	const createdTypes = await page.evaluate( () => window.__plotDemo!.editor.document.getAll()
		.slice( 8 ).map( ( feature ) => feature.type ) );
	expect( createdTypes ).toEqual( cases.map( ( item ) => item.type ) );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 8 );
	expect( browserErrors ).toEqual( [] );
} );

test( '绘制中右键拖拽只导航，右键单击才完成草稿', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const canvas = await page.locator( 'canvas' ).boundingBox();
	if ( canvas === null ) throw new Error( 'Plot demo canvas 不可见。' );
	const center = {
		x: canvas.x + canvas.width * 0.5,
		y: canvas.y + canvas.height * 0.5,
	};
	await page.evaluate( () => {
		window.__plotDemo!.editor.activateTool( 'line' );
		window.__plotDemo!.editor.focus();
	} );
	await page.mouse.click( center.x - 45, center.y );
	await page.mouse.click( center.x + 45, center.y );
	expect( await snapshot( page ) ).toEqual( { revision: 0, count: 8, mode: 'draw:line' } );

	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeDrag = await cameraPose( page );
	await page.mouse.move( center.x, center.y );
	await page.mouse.down( { button: 'right' } );
	await page.mouse.move( center.x + 48, center.y + 24, { steps: 5 } );
	await page.mouse.up( { button: 'right' } );
	await expect.poll( () => cameraPose( page ) ).not.toEqual( cameraBeforeDrag );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	expect( await snapshot( page ) ).toEqual( { revision: 0, count: 8, mode: 'draw:line' } );

	await page.mouse.click( center.x, center.y, { button: 'right' } );
	await expect.poll( () => snapshot( page ) ).toEqual( {
		revision: 1, count: 9, mode: 'select',
	} );
	expect( browserErrors ).toEqual( [] );
} );

test( '鼠标修饰键点选与框选遵守选择、相机和 revision 契约', async ( { page } ) => {
	// SwiftShader 下本用例串行执行四轮完整 pointer 手势，使用慢用例预算；
	// 各阶段仍由 expect.poll 的 10 秒局部超时约束，逻辑卡死不会被掩盖。
	test.slow();
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const point = await featureAnchorProjection( page, 'demo-point' );
	const text = await featureAnchorProjection( page, 'demo-text' );

	await page.mouse.click( point.x, point.y );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point' ] );
	await page.keyboard.down( 'Shift' );
	await page.mouse.click( text.x, text.y );
	await page.keyboard.up( 'Shift' );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point', 'demo-text' ] );

	await page.keyboard.down( 'Control' );
	await page.mouse.click( point.x, point.y );
	await page.keyboard.up( 'Control' );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-text' ] );
	await page.keyboard.down( 'Control' );
	await page.mouse.click( point.x, point.y );
	await page.keyboard.up( 'Control' );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point', 'demo-text' ] );

	const pointBox = boxAround( point, 14 );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	await page.keyboard.down( 'Control' );
	await page.mouse.move( pointBox.start.x, pointBox.start.y );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await page.mouse.move( pointBox.end.x, pointBox.end.y, { steps: 4 } );
	await page.mouse.up();
	await page.keyboard.up( 'Control' );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point' ] );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 0 );

	const textBox = boxAround( text, 14 );
	await page.keyboard.down( 'Control' );
	await page.keyboard.down( 'Shift' );
	await page.mouse.move( textBox.start.x, textBox.start.y );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await page.mouse.move( textBox.end.x, textBox.end.y, { steps: 4 } );
	await page.mouse.up();
	await page.keyboard.up( 'Shift' );
	await page.keyboard.up( 'Control' );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await expect.poll( () => selectedIds( page ) ).toEqual( [ 'demo-point', 'demo-text' ] );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 0 );

	await page.mouse.click( pointBox.start.x, pointBox.start.y );
	await expect.poll( () => selectedIds( page ) ).toEqual( [] );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 0 );
	expect( browserErrors ).toEqual( [] );
} );

test( '贴地多选的 G/R/S、轴约束和一次撤销保持三元作者高度', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const ids = [ 'demo-point', 'demo-circle' ];
	const before = await page.evaluate( ( selectedIds ) => {
		const editor = window.__plotDemo!.editor;
		editor.select( selectedIds );
		editor.focus();
		return selectedIds.map( ( id ) => editor.document.get( id ) );
	}, ids );

	await page.keyboard.press( 'g' );
	await expect.poll( () => transformSession( page ) ).toMatchObject( {
		mode: 'translate', axis: null,
	} );
	expect( await gizmoMarkerNames( page ) ).toEqual( [
		'EditorMarker:gizmo:translate:east',
		'EditorMarker:gizmo:translate:north',
		'EditorMarker:gizmo:translate:east-north',
	] );
	await page.keyboard.press( 'z' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'translate', axis: null } );
	await page.keyboard.press( 'x' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'translate', axis: 'east' } );
	await page.keyboard.press( 'ArrowRight' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 1, mode: 'select' } );
	const translated = await page.evaluate( ( selectedIds ) => selectedIds.map(
		( id ) => window.__plotDemo!.editor.document.get( id ),
	), ids );
	expect( translated ).not.toEqual( before );
	expect( authorHeights( translated ) ).toEqual( [ 0, 0 ] );

	await page.keyboard.press( 'Control+z' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 2, mode: 'select' } );
	expect( await page.evaluate( ( selectedIds ) => selectedIds.map(
		( id ) => window.__plotDemo!.editor.document.get( id ),
	), ids ) ).toEqual( before );

	await page.keyboard.press( 'r' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'rotate', axis: null } );
	expect( await gizmoMarkerNames( page ) ).toEqual( [
		'EditorMarker:gizmo:rotate:heading',
	] );
	await page.keyboard.press( 'x' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'rotate', axis: null } );
	await page.keyboard.press( 'z' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'rotate', axis: 'up' } );
	await page.keyboard.press( 'Escape' );

	await page.keyboard.press( 's' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'scale', axis: null } );
	expect( await gizmoMarkerNames( page ) ).toEqual( [
		'EditorMarker:gizmo:scale:east',
		'EditorMarker:gizmo:scale:north',
		'EditorMarker:gizmo:scale:uniform',
	] );
	await page.keyboard.press( 'z' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'scale', axis: null } );
	await page.keyboard.press( 'y' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'scale', axis: 'north' } );
	await page.keyboard.press( 'Escape' );
	const finalFeatures = await page.evaluate( ( selectedIds ) => selectedIds.map(
		( id ) => window.__plotDemo!.editor.document.get( id ),
	), ids );
	expect( authorHeights( finalFeatures ) ).toEqual( [ 0, 0 ] );
	expect( browserErrors ).toEqual( [] );
} );

test( '绝对与相对高度选择启用 Up、pitch、roll 和垂直缩放', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const ids = [ 'demo-line', 'demo-polygon' ];
	const baseline = await page.evaluate( ( selectedIds ) => {
		const editor = window.__plotDemo!.editor;
		selectedIds.forEach( ( id, featureIndex ) => {
			const feature = editor.document.get( id );
			if ( feature?.type !== 'line' && feature?.type !== 'polygon' ) {
				throw new Error( `${ id } 不是线或面。` );
			}
			const result = editor.execute( {
				type: 'feature.patch',
				id,
				beforeRevision: feature.revision,
				patch: {
					heightReference: featureIndex === 0 ? 0 : 2,
					geometry: {
						positions: feature.geometry.positions.map( ( position, index ) => [
							position[ 0 ], position[ 1 ], 6 + featureIndex * 4 + index * 5,
						] ),
					},
				},
			} );
			if ( ! result.ok ) throw new Error( result.error?.message ?? `${ id } 高度迁移失败。` );
		} );
		editor.select( selectedIds );
		editor.focus();
		return selectedIds.map( ( id ) => editor.document.get( id ) );
	}, ids );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) ).toBe( 2 );
	expect( baseline.map( ( feature ) => feature?.heightReference ) ).toEqual( [ 0, 2 ] );

	await page.keyboard.press( 'g' );
	expect( await gizmoMarkerNames( page ) ).toEqual( [
		'EditorMarker:gizmo:translate:east',
		'EditorMarker:gizmo:translate:north',
		'EditorMarker:gizmo:translate:up',
		'EditorMarker:gizmo:translate:east-north',
	] );
	await page.keyboard.press( 'z' );
	expect( await transformSession( page ) ).toMatchObject( { mode: 'translate', axis: 'up' } );
	await page.keyboard.press( 'PageUp' );
	await expect.poll( () => snapshot( page ) ).toMatchObject( { revision: 3, mode: 'select' } );
	const raised = await selectedFeatures( page, ids );
	expectHeightsClose(
		positionHeights( raised ),
		positionHeights( baseline ).map( ( height ) => height + 1 ),
	);
	await page.keyboard.press( 'Control+z' );
	await expect.poll( () => selectedFeatures( page, ids ) ).toEqual( baseline );

	for ( const handleId of [ 'rotate:pitch', 'rotate:roll' ] ) {
		const before = await selectedFeatures( page, ids );
		const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
		await page.keyboard.press( 'r' );
		expect( await gizmoMarkerNames( page ) ).toEqual( [
			'EditorMarker:gizmo:rotate:heading',
			'EditorMarker:gizmo:rotate:pitch',
			'EditorMarker:gizmo:rotate:roll',
		] );
		const target = await gizmoHandleTarget( page, handleId );
		await page.mouse.move( target.x, target.y );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
		const cameraBefore = await cameraPose( page );
		await page.mouse.down();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
		await page.mouse.move( target.x + 20, target.y + 10, { steps: 4 } );
		await page.mouse.up();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
			.toBe( revisionBefore + 1 );
		const changed = await selectedFeatures( page, ids );
		expect( changed ).not.toEqual( before );
		expect( changed.map( ( feature ) => feature?.heightReference ) ).toEqual( [ 0, 2 ] );
		expect( positionHeights( changed ).every( Number.isFinite ) ).toBe( true );
		expectPoseEqual( await cameraPose( page ), cameraBefore );
		await page.keyboard.press( 'Control+z' );
		await expect.poll( () => selectedFeatures( page, ids ) ).toEqual( before );
	}

	const beforeScale = await selectedFeatures( page, ids );
	const revisionBeforeScale = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.keyboard.press( 's' );
	expect( await gizmoMarkerNames( page ) ).toEqual( [
		'EditorMarker:gizmo:scale:east',
		'EditorMarker:gizmo:scale:north',
		'EditorMarker:gizmo:scale:up',
		'EditorMarker:gizmo:scale:uniform',
	] );
	const scaleTarget = await gizmoHandleTarget( page, 'scale:up' );
	await page.mouse.move( scaleTarget.x, scaleTarget.y );
	await page.mouse.down();
	await page.mouse.move( scaleTarget.x + 18, scaleTarget.y, { steps: 4 } );
	await page.mouse.up();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( revisionBeforeScale + 1 );
	const scaled = await selectedFeatures( page, ids );
	expect( scaled ).not.toEqual( beforeScale );
	expect( positionHeights( scaled ) ).not.toEqual( positionHeights( beforeScale ) );
	await page.keyboard.press( 'Control+z' );
	await expect.poll( () => selectedFeatures( page, ids ) ).toEqual( beforeScale );
	expect( browserErrors ).toEqual( [] );
} );

test( '贴地多选的 translate、heading 与 uniform Gizmo 拖拽均原子提交', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	await openDemo( page );
	const ids = [ 'demo-point', 'demo-circle' ];
	await page.evaluate( ( selectedIds ) => {
		window.__plotDemo!.editor.select( selectedIds );
		window.__plotDemo!.editor.focus();
	}, ids );
	const cases = [
		{ key: 'g', handleId: 'translate:east' },
		{ key: 'r', handleId: 'rotate:heading' },
		{ key: 's', handleId: 'scale:uniform' },
	] as const;

	for ( const item of cases ) {
		const before = await page.evaluate( ( selectedIds ) => selectedIds.map(
			( id ) => window.__plotDemo!.editor.document.get( id ),
		), ids );
		const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
		await page.keyboard.press( item.key );
		const target = await gizmoHandleTarget( page, item.handleId );
		await page.mouse.move( target.x, target.y );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
		const cameraBefore = await cameraPose( page );
		await page.mouse.down();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
		await page.mouse.move( target.x + 22, target.y + 6, { steps: 4 } );
		await page.mouse.up();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
			.toBe( revisionBefore + 1 );
		const changed = await page.evaluate( ( selectedIds ) => selectedIds.map(
			( id ) => window.__plotDemo!.editor.document.get( id ),
		), ids );
		expect( changed ).not.toEqual( before );
		expect( authorHeights( changed ) ).toEqual( [ 0, 0 ] );
		expectPoseEqual( await cameraPose( page ), cameraBefore );

		await page.keyboard.press( 'Control+z' );
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
			.toBe( revisionBefore + 2 );
		expect( await page.evaluate( ( selectedIds ) => selectedIds.map(
			( id ) => window.__plotDemo!.editor.document.get( id ),
		), ids ) ).toEqual( before );
	}
	expect( browserErrors ).toEqual( [] );
} );

test( '控制点拖拽只更新图形，且相机姿态保持不变', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	const initialVertex = await firstVertexPosition( page, 'demo-line' );
	const initialRevision = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeHandleDrag = await cameraPose( page );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await expect.poll( () => page.evaluate(
		() => window.__plotDemo!.editor.selectionState.activeHandleId,
	) ).toBe( 'vertex:0' );
	await page.mouse.move( handle.x + 24, handle.y + 8, { steps: 4 } );
	await page.mouse.up();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( initialRevision + 1 );
	expect( await linePositions( page, 'demo-line' ) ).not.toContainEqual( initialVertex );
	expectPoseEqual( await cameraPose( page ), cameraBeforeHandleDrag );
	expect( browserErrors ).toEqual( [] );
} );

test( 'Space 从控制点起步时只导航相机，不修改图形', async ( { page } ) => {
	test.slow();
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	// Space 必须在 pointerdown 前固定 owner；即使从 handle 起步也只允许相机响应。
	const vertexBeforeNavigation = await firstVertexPosition( page, 'demo-line' );
	const revisionBeforeNavigation = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	const cameraBeforeNavigation = await cameraPose( page );
	await page.keyboard.down( 'Space' );
	await page.mouse.down();
	expect( await page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	await page.mouse.move( handle.x + 36, handle.y + 18, { steps: 5 } );
	await page.mouse.up();
	await page.keyboard.up( 'Space' );
	await expect.poll( () => cameraPose( page ) ).not.toEqual( cameraBeforeNavigation );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
	expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBeforeNavigation );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( revisionBeforeNavigation );
	expect( browserErrors ).toEqual( [] );
} );

for ( const [ label, reason ] of [
	[ 'window blur', 'blur' ],
	[ 'document hidden', 'hidden' ],
	[ 'lostpointercapture', 'lost-capture' ],
] as const ) {
	test( `${ label } 回滚控制点 working copy 并恢复相机`, async ( { page } ) => {
		const browserErrors = collectBrowserErrors( page );
		const handle = await prepareLineVertexEdit( page );
		const vertexBefore = await firstVertexPosition( page, 'demo-line' );
		const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
		await page.mouse.move( handle.x, handle.y );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
		await page.mouse.down();
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
		await expect.poll( () => page.evaluate(
			() => window.__plotDemo!.editor.selectionState.activeHandleId,
		) ).toBe( 'vertex:0' );
		await page.mouse.move( handle.x + 28, handle.y - 10, { steps: 4 } );
		if ( reason === 'blur' ) {
			await page.evaluate( () => window.dispatchEvent( new Event( 'blur' ) ) );
		} else if ( reason === 'hidden' ) {
			await page.evaluate( () => {
				Object.defineProperty( document, 'visibilityState', {
					configurable: true,
					value: 'hidden',
				} );
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
		} else {
			await page.evaluate( () => {
				const editor = window.__plotDemo!.editor;
				const pointerId = editor._pointer.activePointerId;
				if ( pointerId === null ) throw new Error( 'lost capture 前缺少 active pointer。' );
				const canvas = document.querySelector( 'canvas' );
				if ( canvas === null ) throw new Error( 'Plot demo canvas 不存在。' );
				canvas.dispatchEvent( new PointerEvent( 'lostpointercapture', {
					pointerId,
					pointerType: 'mouse',
				} ) );
			} );
		}
		await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
		await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
		expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBefore );
		expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
			.toBe( revisionBefore );
		await page.mouse.up();
		expect( browserErrors ).toEqual( [] );
	} );
}

test( 'active drag 中 dispose 回滚 working copy 并恢复相机', async ( { page } ) => {
	const browserErrors = collectBrowserErrors( page );
	const handle = await prepareLineVertexEdit( page );
	const vertexBefore = await firstVertexPosition( page, 'demo-line' );
	const revisionBefore = await page.evaluate( () => window.__plotDemo!.editor.document.revision );
	await page.mouse.move( handle.x, handle.y );
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = true; } );
	await page.mouse.down();
	await expect.poll( () => page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( false );
	await page.mouse.move( handle.x + 28, handle.y - 10, { steps: 4 } );

	await page.evaluate( () => window.__plotDemo!.editor.dispose() );

	expect( await page.evaluate( () => window.__plotDemo!.controls.enabled ) ).toBe( true );
	expect( await firstVertexPosition( page, 'demo-line' ) ).toEqual( vertexBefore );
	expect( await page.evaluate( () => window.__plotDemo!.editor.document.revision ) )
		.toBe( revisionBefore );
	await page.mouse.up();
	expect( browserErrors ).toEqual( [] );
} );

function collectBrowserErrors( page: Page ): string[] {
	const errors: string[] = [];
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) errors.push( message.text() );
	} );
	page.on( 'pageerror', ( error ) => errors.push( error.message ) );
	return errors;
}

async function openDemo( page: Page ): Promise<void> {
	await page.goto( '/?demo=plot&noterrain' );
	await page.waitForFunction( () => window.__plotDemo?.editor !== undefined );
	await page.waitForTimeout( 250 );
	// SwiftShader 下持续启用相机控制会让 demo 每帧重绘；集成测试只在编辑器失效时按需渲染。
	await page.evaluate( () => { window.__plotDemo!.controls.enabled = false; } );
}

async function snapshot( page: Page ): Promise<{
	revision: number;
	count: number;
	mode: string;
}> {
	return page.evaluate( () => ( {
		revision: window.__plotDemo!.editor.document.revision,
		count: window.__plotDemo!.editor.document.getAll().length,
		mode: window.__plotDemo!.editor.mode,
	} ) );
}

async function selectedIds( page: Page ): Promise<string[]> {
	return page.evaluate( () => [ ...window.__plotDemo!.editor.selection ] );
}

async function selectedFeatures(
	page: Page,
	ids: readonly string[],
): Promise<( Readonly<PlotFeature> | undefined )[]> {
	return page.evaluate( ( selectedIds ) => selectedIds.map(
		( id ) => window.__plotDemo!.editor.document.get( id ),
	), ids );
}

async function featureAnchorProjection(
	page: Page,
	id: string,
): Promise<{ x: number; y: number }> {
	return page.evaluate( ( featureId ) => {
		const editor = window.__plotDemo!.editor;
		const feature = editor.document.get( featureId );
		if ( feature === undefined ) throw new Error( `${ featureId } 不存在。` );
		const position = feature.type === 'point' || feature.type === 'text'
			? feature.geometry.position
			: feature.type === 'circle' || feature.type === 'sector'
				? feature.geometry.center
				: feature.geometry.positions[ 0 ];
		const projected = editor._createProjectionSnapshot().project( position );
		if ( projected === null || ! projected.visible ) throw new Error( `${ featureId } 不可见。` );
		return { x: projected.x, y: projected.y };
	}, id );
}

function boxAround(
	point: { x: number; y: number },
	radius: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
	return {
		start: { x: point.x - radius, y: point.y - radius },
		end: { x: point.x + radius, y: point.y + radius },
	};
}

async function prepareLineVertexEdit( page: Page ): Promise<{ x: number; y: number }> {
	await openDemo( page );
	await page.evaluate( () => {
		window.__plotDemo!.editor.enterVertexEdit( 'demo-line' );
	} );
	return firstVertexProjection( page, 'demo-line' );
}

async function firstVertexPosition( page: Page, id: string ): Promise<number[]> {
	return ( await linePositions( page, id ) )[ 0 ];
}

async function linePositions( page: Page, id: string ): Promise<number[][]> {
	return page.evaluate( ( featureId ) => {
		const feature = window.__plotDemo!.editor.document.get( featureId );
		if ( feature?.type !== 'line' ) throw new Error( `${ featureId } 不是 line。` );
		return feature.geometry.positions.map( ( position ) => [ ...position ] );
	}, id );
}

async function firstVertexProjection( page: Page, id: string ): Promise<{ x: number; y: number }> {
	return page.evaluate( ( featureId ) => {
		const editor = window.__plotDemo!.editor;
		const feature = editor.document.get( featureId );
		if ( feature?.type !== 'line' ) throw new Error( `${ featureId } 不是 line。` );
		const projected = editor._createProjectionSnapshot().project( feature.geometry.positions[ 0 ] );
		if ( projected === null || ! projected.visible ) throw new Error( `${ featureId } 不可见。` );
		return { x: projected.x, y: projected.y };
	}, id );
}

async function cameraPose( page: Page ): Promise<{ position: number[]; quaternion: number[] }> {
	return page.evaluate( () => {
		const camera = window.__plotDemo!.camera;
		camera.updateMatrixWorld();
		return {
			position: camera.position.toArray(),
			quaternion: camera.quaternion.toArray(),
		};
	} );
}

function expectPoseEqual(
	actual: { position: number[]; quaternion: number[] },
	expected: { position: number[]; quaternion: number[] },
): void {
	for ( let index = 0; index < actual.position.length; index++ ) {
		expect( actual.position[ index ] ).toBeCloseTo( expected.position[ index ], 9 );
	}
	for ( let index = 0; index < actual.quaternion.length; index++ ) {
		expect( actual.quaternion[ index ] ).toBeCloseTo( expected.quaternion[ index ], 12 );
	}
}

async function transformSession( page: Page ): Promise<{ mode: string | null; axis: string | null }> {
	return page.evaluate( () => {
		const session = window.__plotDemo!.editor._transform.session;
		return { mode: session?.mode ?? null, axis: session?.axis ?? null };
	} );
}

async function gizmoMarkerNames( page: Page ): Promise<string[]> {
	return page.evaluate( () => window.__plotDemo!.scene
		.getObjectByName( 'plotGizmoRoot' )?.children
		.map( ( child ) => ( child as { name?: string } ).name ?? '' ) ?? [] );
}

async function gizmoHandleTarget(
	page: Page,
	handleId: string,
): Promise<{ x: number; y: number }> {
	return page.evaluate( ( id ) => {
		const demo = window.__plotDemo!;
		const session = demo.editor._transform.session;
		if ( session === null ) throw new Error( '缺少活动 Gizmo session。' );
		const projected = demo.editor._createProjectionSnapshot().project( session.pivot.position );
		if ( projected === null || ! projected.visible ) throw new Error( 'Gizmo pivot 不可见。' );
		const marker = demo.scene.getObjectByName( 'plotGizmoRoot' )?.children.find(
			( child ) => ( child as { name?: string } ).name === `EditorMarker:gizmo:${ id }`,
		) as {
			userData?: { editorPickProxy?: {
				shape?: string;
				sizeCssPixels?: number;
				screenOffsetCssPixels?: readonly [ number, number ];
			} };
		} | undefined;
		const proxy = marker?.userData?.editorPickProxy;
		if ( proxy === undefined ) throw new Error( `Gizmo handle ${ id } 不存在。` );
		if ( proxy.shape === 'ring' ) {
			return { x: projected.x + ( proxy.sizeCssPixels ?? 0 ) / 2, y: projected.y };
		}
		const offset = proxy.screenOffsetCssPixels ?? [ 0, 0 ];
		return { x: projected.x + offset[ 0 ], y: projected.y + offset[ 1 ] };
	}, handleId );
}

function authorHeights( features: readonly ( Readonly<PlotFeature> | undefined )[] ): number[] {
	return features.map( ( feature ) => {
		if ( feature === undefined ) throw new Error( '多选 feature 不存在。' );
		if ( feature.type === 'point' || feature.type === 'text' ) return feature.geometry.position[ 2 ];
		if ( feature.type === 'circle' || feature.type === 'sector' ) return feature.geometry.center[ 2 ];
		return feature.geometry.positions[ 0 ][ 2 ];
	} );
}

function positionHeights(
	features: readonly ( Readonly<PlotFeature> | undefined )[],
): number[] {
	return features.flatMap( ( feature ) => {
		if ( feature === undefined ) throw new Error( '高度验证 feature 不存在。' );
		if ( feature.type === 'point' || feature.type === 'text' ) return [ feature.geometry.position[ 2 ] ];
		if ( feature.type === 'circle' || feature.type === 'sector' ) return [ feature.geometry.center[ 2 ] ];
		return feature.geometry.positions.map( ( position ) => position[ 2 ] );
	} );
}

function expectHeightsClose( actual: readonly number[], expected: readonly number[] ): void {
	expect( actual ).toHaveLength( expected.length );
	for ( let index = 0; index < actual.length; index++ ) {
		expect( actual[ index ] ).toBeCloseTo( expected[ index ], 7 );
	}
}
