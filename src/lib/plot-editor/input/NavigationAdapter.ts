import type {
	NavigationAdapter,
	NavigationLease,
	NavigationLeaseKind,
} from './types';

export interface EnabledControls {
	enabled: boolean;
}

interface MutableLease extends NavigationLease {
	released: boolean;
}

/** 可嵌套、幂等且保留宿主原始 enabled 状态的导航锁适配器。 */
export class GlobeControlsNavigationAdapter implements NavigationAdapter {
	private readonly _controls: EnabledControls;
	private readonly _leases = new Map<string, MutableLease>();
	private _enabledBeforeFirstLease: boolean | undefined;
	private _nextLeaseId = 1;
	private _disposed = false;

	public constructor( controls: EnabledControls ) {
		this._controls = controls;
	}

	public get enabled(): boolean {
		return this._controls.enabled;
	}

	public acquire( reason: {
		readonly owner: 'plot-editor';
		readonly kind: NavigationLeaseKind;
		readonly pointerId?: number;
	} ): NavigationLease {
		if ( this._disposed ) {
			throw new Error( 'NavigationAdapter 已销毁。' );
		}
		if ( reason.owner !== 'plot-editor' ) {
			throw new TypeError( 'NavigationAdapter 只接受 plot-editor owner。' );
		}
		if ( this._leases.size === 0 ) {
			this._enabledBeforeFirstLease = this._controls.enabled;
			this._controls.enabled = false;
		}
		const id = `navigation-lease-${ this._nextLeaseId++ }`;
		const lease: MutableLease = {
			id,
			released: false,
			release: () => this._release( id ),
		};
		this._leases.set( id, lease );
		return lease;
	}

	public dispose(): void {
		if ( this._disposed ) {
			return;
		}
		this._disposed = true;
		for ( const lease of this._leases.values() ) {
			lease.released = true;
		}
		this._leases.clear();
		this._restoreHostState();
	}

	private _release( id: string ): void {
		const lease = this._leases.get( id );
		if ( lease === undefined || lease.released ) {
			return;
		}
		lease.released = true;
		this._leases.delete( id );
		if ( this._leases.size === 0 ) {
			this._restoreHostState();
		}
	}

	private _restoreHostState(): void {
		if ( this._enabledBeforeFirstLease !== undefined ) {
			this._controls.enabled = this._enabledBeforeFirstLease;
			this._enabledBeforeFirstLease = undefined;
		}
	}
}
