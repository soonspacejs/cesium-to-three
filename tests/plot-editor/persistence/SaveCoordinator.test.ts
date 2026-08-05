import { describe, expect, it } from 'vitest';
import { createPlotDocumentStore } from '../../../src/lib/plot-editor/document/PlotDocument';
import { SaveCoordinator } from '../../../src/lib/plot-editor/persistence/SaveCoordinator';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>( ( done ) => { resolve = done; } );
	return { promise, resolve };
}

function snapshot( revision: number ) {
	return createPlotDocumentStore( { id: 'doc', revision } ).snapshot();
}

describe( 'SaveCoordinator', () => {
	it( '新 revision 先完成时，迟到的旧保存不会覆盖 latestSavedRevision', async () => {
		const first = deferred();
		const second = deferred();
		const saves = [ first, second ];
		const coordinator = new SaveCoordinator( () => saves.shift()!.promise );
		const oldRequest = coordinator.request( snapshot( 1 ) );
		const newRequest = coordinator.request( snapshot( 2 ) );
		expect( coordinator.state.pendingCount ).toBe( 2 );

		second.resolve();
		expect( await newRequest ).toEqual( { revision: 2, acceptedAsLatest: true } );
		first.resolve();
		expect( await oldRequest ).toEqual( { revision: 1, acceptedAsLatest: false } );
		expect( coordinator.state ).toEqual( {
			pendingCount: 0, latestRequestedRevision: 2, latestSavedRevision: 2,
		} );
	} );

	it( 'dispose 后拒绝新保存请求', async () => {
		const coordinator = new SaveCoordinator( () => undefined );
		coordinator.dispose();
		await expect( coordinator.request( snapshot( 0 ) ) ).rejects.toThrow( /已销毁/ );
	} );
} );
