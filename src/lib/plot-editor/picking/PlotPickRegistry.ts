import {
	BufferGeometry,
	Group,
	Material,
	type Object3D,
} from 'three';
import type { PlotFeatureId } from '../document/types';
import { EditorOverlayLayer } from '../render/layers';
import {
	clearPlotPickMetadata,
	setPlotPickMetadata,
	type PlotPickMetadata,
} from './PlotPickMetadata';

export interface PlotPickRevision {
	readonly featureRevision: number;
	readonly resolvedGeometryRevision: number;
	readonly layoutRevision?: number;
}

export interface PlotPickRegistration {
	readonly metadata: PlotPickMetadata;
	readonly revision: PlotPickRevision;
	readonly targets: readonly Object3D[];
	/** 代理独占的几何；registry 在替换、注销或销毁时各释放一次。 */
	readonly ownedGeometries?: readonly BufferGeometry[];
}

export interface PlotPickEntry extends PlotPickRegistration {
	readonly featureId: PlotFeatureId;
}

/**
 * 保存 feature 到拾取 Object3D 的唯一映射，并精确管理图层与 GPU 资源所有权。
 * 候选会先完整校验，再原子替换旧 entry，构建失败不会破坏上一版可用对象。
 */
export class PlotPickRegistry {
	public readonly root: Group;
	private readonly _entries = new Map<PlotFeatureId, PlotPickEntry>();
	private readonly _originalLayerMasks = new Map<Object3D, number>();
	private readonly _sharedMaterials = new Set<Material>();
	private _targets: readonly Object3D[] = Object.freeze( [] );
	private _disposed = false;

	public constructor( root = createPickRoot() ) {
		this.root = root;
		this.root.layers.set( EditorOverlayLayer.PLOT_PICK );
	}

	public get targets(): readonly Object3D[] { return this._targets; }
	public get size(): number { return this._entries.size; }

	public get( featureId: PlotFeatureId ): PlotPickEntry | undefined {
		return this._entries.get( featureId );
	}

	public registerSharedMaterial( material: Material ): void {
		this._assertOpen();
		this._sharedMaterials.add( material );
	}

	public replace( registration: PlotPickRegistration ): PlotPickEntry {
		this._assertOpen();
		validateRegistration( registration );
		const entry = Object.freeze( {
			...registration,
			featureId: registration.metadata.featureId,
			targets: Object.freeze( [ ...registration.targets ] ),
			ownedGeometries: Object.freeze( [ ...registration.ownedGeometries ?? [] ] ),
		} );

		// 先完成候选对象的元数据和 layer 配置，再切换 Map，保证替换是原子的。
		this._activate( entry );
		const previous = this._entries.get( entry.featureId );
		this._entries.set( entry.featureId, entry );
		this._rebuildTargets();
		if ( previous !== undefined ) {
			// 显示桥可能用同一个 Object3D 提升 revision；保留新 entry 仍在使用的
			// 对象，避免旧 entry 清理时误删 metadata 或恢复 PLOT_PICK layer。
			this._deactivate( previous, collectObjects( entry.targets ) );
		}
		return entry;
	}

	public remove( featureId: PlotFeatureId ): boolean {
		if ( this._disposed ) return false;
		const entry = this._entries.get( featureId );
		if ( entry === undefined ) return false;
		this._entries.delete( featureId );
		this._rebuildTargets();
		this._deactivate( entry );
		return true;
	}

	public has( featureId: PlotFeatureId ): boolean {
		return ! this._disposed && this._entries.has( featureId );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this._disposed = true;
		for ( const entry of this._entries.values() ) this._deactivate( entry );
		this._entries.clear();
		this._targets = Object.freeze( [] );
		for ( const material of this._sharedMaterials ) material.dispose();
		this._sharedMaterials.clear();
		this.root.clear();
	}

	private _activate( entry: PlotPickEntry ): void {
		for ( const target of entry.targets ) {
			setPlotPickMetadata( target, entry.metadata );
			if ( entry.metadata.source === 'proxy' ) {
				setPickLayerRecursively( target );
				this.root.add( target );
			} else {
				target.traverse( ( object ) => {
					if ( ! this._originalLayerMasks.has( object ) ) {
						this._originalLayerMasks.set( object, object.layers.mask );
					}
					object.layers.enable( EditorOverlayLayer.PLOT_PICK );
				} );
			}
		}
	}

	private _deactivate(
		entry: PlotPickEntry,
		retainedObjects: ReadonlySet<Object3D> = EMPTY_OBJECT_SET,
	): void {
		for ( const target of entry.targets ) {
			if ( ! retainedObjects.has( target ) ) clearPlotPickMetadata( target );
			if ( entry.metadata.source === 'proxy' ) {
				if ( ! retainedObjects.has( target ) ) target.removeFromParent();
			} else {
				target.traverse( ( object ) => {
					if ( retainedObjects.has( object ) ) return;
					const mask = this._originalLayerMasks.get( object );
					if ( mask === undefined ) return;
					object.layers.mask = mask;
					this._originalLayerMasks.delete( object );
				} );
			}
		}
		for ( const geometry of entry.ownedGeometries ?? [] ) geometry.dispose();
	}

	private _rebuildTargets(): void {
		this._targets = Object.freeze( [ ...this._entries.values() ]
			.flatMap( ( entry ) => entry.targets ) );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'PlotPickRegistry 已销毁。' );
	}
}

const EMPTY_OBJECT_SET: ReadonlySet<Object3D> = new Set();

function collectObjects( targets: readonly Object3D[] ): ReadonlySet<Object3D> {
	const objects = new Set<Object3D>();
	for ( const target of targets ) target.traverse( ( object ) => objects.add( object ) );
	return objects;
}

function createPickRoot(): Group {
	const root = new Group();
	root.name = 'plotEntityPickRoot';
	root.layers.set( EditorOverlayLayer.PLOT_PICK );
	return root;
}

function setPickLayerRecursively( root: Object3D ): void {
	root.traverse( ( object ) => object.layers.set( EditorOverlayLayer.PLOT_PICK ) );
}

function validateRegistration( registration: PlotPickRegistration ): void {
	if ( registration.metadata.kind !== 'plot-entity' ) {
		throw new Error( '拾取元数据 kind 必须为 plot-entity。' );
	}
	if ( registration.targets.length === 0 ) throw new Error( '拾取对象不能为空。' );
	if ( new Set( registration.targets ).size !== registration.targets.length ) {
		throw new Error( '同一拾取 entry 不能重复登记 Object3D。' );
	}
	if ( registration.metadata.source === 'visual'
		&& ( registration.ownedGeometries?.length ?? 0 ) > 0 ) {
		throw new Error( '直接复用显示对象时不能把显示 geometry 交给 registry 释放。' );
	}
}
