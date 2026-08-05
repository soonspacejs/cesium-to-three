import { describe, expect, it } from 'vitest';

import { GlobeControlsNavigationAdapter } from '../../../src/lib/plot-editor/input/NavigationAdapter';

describe( 'GlobeControlsNavigationAdapter', () => {
	it( '第一份 lease 关闭 controls，最后一份释放才恢复', () => {
		const controls = { enabled: true };
		const adapter = new GlobeControlsNavigationAdapter( controls );
		const first = adapter.acquire( { owner: 'plot-editor', kind: 'draw', pointerId: 1 } );
		const second = adapter.acquire( { owner: 'plot-editor', kind: 'gizmo', pointerId: 2 } );
		expect( controls.enabled ).toBe( false );
		first.release();
		expect( first.released ).toBe( true );
		expect( second.released ).toBe( false );
		expect( controls.enabled ).toBe( false );
		second.release();
		expect( controls.enabled ).toBe( true );
	} );

	it( '宿主原本 disabled 时释放后仍保持 disabled', () => {
		const controls = { enabled: false };
		const adapter = new GlobeControlsNavigationAdapter( controls );
		const lease = adapter.acquire( { owner: 'plot-editor', kind: 'handle-drag' } );
		lease.release();
		expect( controls.enabled ).toBe( false );
	} );

	it( 'lease.release 与 dispose 都幂等', () => {
		const controls = { enabled: true };
		const adapter = new GlobeControlsNavigationAdapter( controls );
		const lease = adapter.acquire( { owner: 'plot-editor', kind: 'box-select' } );
		lease.release();
		lease.release();
		expect( controls.enabled ).toBe( true );

		const active = adapter.acquire( { owner: 'plot-editor', kind: 'entity-drag' } );
		adapter.dispose();
		adapter.dispose();
		expect( active.released ).toBe( true );
		expect( controls.enabled ).toBe( true );
		active.release();
		expect( () => adapter.acquire( { owner: 'plot-editor', kind: 'draw' } ) )
			.toThrowError( /已销毁/ );
	} );
} );
