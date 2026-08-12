import {
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	OrthographicCamera,
	PerspectiveCamera,
	PlaneGeometry,
	Vector2,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
	clientPointToNdc,
	PlotEntityRaycaster,
	PlotPickRegistry,
	type PlotPickMetadata,
} from '../../../src/lib/plot-editor/picking';
import { EditorOverlayLayer } from '../../../src/lib/plot-editor/render/layers';

function registerPlane(
	registry: PlotPickRegistry,
	id: string,
	z: number,
	plotOrder = 0,
	pickPriority = 0,
): Mesh {
	const mesh = new Mesh(
		new PlaneGeometry( 4, 4 ),
		new MeshBasicMaterial( { side: DoubleSide } ),
	);
	mesh.position.z = z;
	registry.replace( {
		metadata: Object.freeze( {
			kind: 'plot-entity', featureId: id, featureType: 'polygon',
			source: 'proxy', part: 'fill', pickPriority, plotOrder,
		} satisfies PlotPickMetadata ),
		revision: { featureRevision: 0, resolvedGeometryRevision: 0 },
		targets: [ mesh ], ownedGeometries: [ mesh.geometry ],
	} );
	return mesh;
}

function perspectiveCamera(): PerspectiveCamera {
	const camera = new PerspectiveCamera( 60, 1, 0.1, 100 );
	camera.position.set( 0, 0, 10 );
	camera.lookAt( 0, 0, 0 );
	camera.updateMatrixWorld();
	return camera;
}

describe( 'clientPointToNdc', () => {
	it( 'canvas 偏移和 CSS 缩放下按视觉位置换算，不读取 DPR', () => {
		const rect = { left: 100, top: 50, width: 400, height: 200 };
		expect( clientPointToNdc( 300, 150, rect )?.toArray() ).toEqual( [ 0, 0 ] );
		expect( clientPointToNdc( 100, 50, rect )?.toArray() ).toEqual( [ -1, 1 ] );
		expect( clientPointToNdc( 500, 250, rect )?.toArray() ).toEqual( [ 1, -1 ] );
	} );

	it( '零视口、非有限值和视口外坐标返回空命中输入', () => {
		expect( clientPointToNdc( 0, 0, { left: 0, top: 0, width: 0, height: 1 } ) ).toBeNull();
		expect( clientPointToNdc( -1, 0, { left: 0, top: 0, width: 1, height: 1 } ) ).toBeNull();
		expect( clientPointToNdc( Number.NaN, 0, { left: 0, top: 0, width: 1, height: 1 } ) ).toBeNull();
	} );
} );

describe( 'PlotEntityRaycaster', () => {
	it( '透视相机通过原生 setFromCamera 命中最近标准 Mesh，并按 feature 去重', () => {
		const registry = new PlotPickRegistry();
		registerPlane( registry, 'far', 0 );
		const near = registerPlane( registry, 'near', 2 );
		// 同一 feature 的子对象会产生多个交点，标准化结果仍只返回一项。
		near.add( new Mesh( new PlaneGeometry( 1, 1 ), new MeshBasicMaterial( { side: DoubleSide } ) ) );
		const raycaster = new PlotEntityRaycaster( registry );
		const hits = raycaster.hitTestAll( new Vector2( 0, 0 ), perspectiveCamera() );
		expect( hits.map( ( hit ) => hit.featureId ) ).toEqual( [ 'near', 'far' ] );
		expect( hits[ 0 ].distance ).toBeCloseTo( 8 );
		expect( raycaster.raycaster.layers.isEnabled( EditorOverlayLayer.PLOT_PICK ) ).toBe( true );
		expect( raycaster.raycaster.layers.mask ).toBe( 1 << EditorOverlayLayer.PLOT_PICK );
	} );

	it( '正交相机同样使用原生 Raycaster，相同深度按 order、priority、id 稳定排序', () => {
		const registry = new PlotPickRegistry();
		registerPlane( registry, 'z-last', 0, 1, 0 );
		registerPlane( registry, 'priority', 0, 0, 2 );
		registerPlane( registry, 'a-first', 0, 1, 0 );
		const camera = new OrthographicCamera( -5, 5, 5, -5, 0.1, 100 );
		camera.position.set( 0, 0, 10 );
		camera.lookAt( 0, 0, 0 );
		const raycaster = new PlotEntityRaycaster( registry );
		expect( raycaster.hitTestAll( new Vector2(), camera ).map( ( hit ) => hit.featureId ) )
			.toEqual( [ 'priority', 'a-first', 'z-last' ] );
	} );

	it( '过滤临时禁选对象；越界 NDC 和 dispose 后不访问悬空目标', () => {
		const registry = new PlotPickRegistry();
		registerPlane( registry, 'locked', 0 );
		const raycaster = new PlotEntityRaycaster( registry, {
			isSelectable: ( value ) => value.featureId !== 'locked',
		} );
		expect( raycaster.hitTest( new Vector2(), perspectiveCamera() ) ).toBeNull();
		expect( raycaster.hitTestAll( new Vector2( 2, 0 ), perspectiveCamera() ) ).toEqual( [] );
		raycaster.dispose();
		expect( raycaster.hitTest( new Vector2(), perspectiveCamera() ) ).toBeNull();
	} );
} );
