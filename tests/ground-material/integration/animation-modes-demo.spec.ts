import { expect, test } from '@playwright/test';

test( 'runs floating, real-terrain, and small oblique texture animation', async ({ page }) => {
	const shaderErrors: string[] = [];
	page.on( 'console', message => {
		if ( message.type() !== 'error' ) return;
		const text = message.text();
		if ( /shader|VALIDATE_STATUS|compile/i.test( text ) ) shaderErrors.push( text );
	} );
	page.on( 'pageerror', error => shaderErrors.push( error.message ) );

	await page.goto( '/?demo=animation' );
	await page.waitForFunction( () => {
		return ( window as unknown as {
			__demo?: { ready?: boolean };
		} ).__demo?.ready === true;
	}, undefined, { timeout: 30_000 } );

	const report = await page.evaluate( () => {
		const demo = ( window as unknown as {
			__demo: {
				modeNames: string[];
				modelStatus: string;
				terrainStatus: string;
				modelRadius: number;
				modelDecalSize: number;
				lastRenderPasses: string[];
				baseTiles: { group: { name: string } };
				modelTiles: { group: { name: string } };
				groundPrimitive: { classification: { classificationType: number } };
				modelPrimitive: {
					classification: { classificationType: number };
					imageWidth: number;
					imageHeight: number;
				};
				floatingMesh: { name: string };
				frameState: {
					classificationDepthTextures?: { terrain?: unknown; tileset?: unknown };
				};
				stop: () => void;
			};
		} ).__demo;
		const result = {
			modeNames: demo.modeNames,
			modelStatus: demo.modelStatus,
			terrainStatus: demo.terrainStatus,
			modelDiameter: demo.modelRadius * 2,
			decalSize: demo.modelDecalSize,
			renderPasses: demo.lastRenderPasses,
			decalWidth: demo.modelPrimitive.imageWidth,
			decalHeight: demo.modelPrimitive.imageHeight,
			terrainRoot: demo.baseTiles.group.name,
			modelRoot: demo.modelTiles.group.name,
			groundType: demo.groundPrimitive.classification.classificationType,
			modelType: demo.modelPrimitive.classification.classificationType,
			floatingName: demo.floatingMesh.name,
			hasTerrainDepth: demo.frameState.classificationDepthTextures?.terrain != null,
			hasModelDepth: demo.frameState.classificationDepthTextures?.tileset != null,
		};
		demo.stop();
		return result;
	} );

	expect( report.modeNames ).toEqual( [ 'floating', 'terrain', 'oblique-texture' ] );
	expect( report.modelStatus ).toBe( 'ready' );
	expect( report.terrainStatus ).toBe( 'loaded' );
	expect( report.renderPasses ).toEqual( [
		'terrain+terrain-classification',
		'oblique-occlusion',
		'oblique-texture-classification',
		'floating',
	] );
	expect( report.terrainRoot ).toBe( 'CesiumIonTilesRendererGroup' );
	expect( report.modelRoot ).toBe( 'AnimationObliqueTilesGroup' );
	expect( report.groundType ).toBe( 0 );
	expect( report.modelType ).toBe( 1 );
	expect( report.floatingName ).toBe( 'RealSceneFloatingVertexMesh' );
	expect( report.decalWidth ).toBe( report.decalSize );
	expect( report.decalHeight ).toBe( report.decalSize );
	expect( report.decalSize ).toBeLessThan( report.modelDiameter * 0.05 );
	expect( report.hasTerrainDepth ).toBe( true );
	expect( report.hasModelDepth ).toBe( true );
	expect( shaderErrors ).toEqual( [] );
} );
