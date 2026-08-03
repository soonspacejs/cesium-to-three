// ============================================================
// material/appearances.ts
// Layer: compilation strategy descriptors. Safe and Raw appearances are peers:
//        one delegates surface shading to CesiumGroundMaterial, while the other
//        delegates complete per-pass construction to an expert factory.
// This module deliberately does not invoke factories; compiler ownership starts
// in the later pass-compilation layer.
// ============================================================

import { EventDispatcher } from 'three';

import { CesiumGroundMaterial } from './CesiumGroundMaterial';
import { CesiumGroundMaterialError } from './errors';
import type { GroundMaterialFactory, GroundUserUniforms } from './types';
import { assertGroundUserUniforms } from './validation';

export interface CesiumGroundMaterialAppearanceOptions {
	material: CesiumGroundMaterial;
}

/** Safe strategy that exposes only the stable material-function ABI. */
export class CesiumGroundMaterialAppearance {
	public readonly kind = 'material' as const;
	public readonly material: CesiumGroundMaterial;

	public constructor( options: CesiumGroundMaterialAppearanceOptions ) {
		if ( options === null || typeof options !== 'object' ||
			! ( options.material instanceof CesiumGroundMaterial ) ) {
			throw new CesiumGroundMaterialError(
				'GROUND_APPEARANCE_INCOMPATIBLE',
				'CesiumGroundMaterialAppearance requires a CesiumGroundMaterial instance.',
				{ appearanceKind: 'material' },
			);
		}
		this.material = options.material;
	}

	/** No duplicate counter exists: Material is the sole structural authority. */
	public get version(): number {
		return this.material.version;
	}
}

export interface CesiumGroundRawShaderAppearanceOptions {
	/** User schema shared by all passes created for this Raw Appearance. */
	uniforms?: GroundUserUniforms;
	/** Immutable factory identity; changing implementation requires a new object. */
	factory: GroundMaterialFactory;
}

export interface CesiumGroundRawShaderAppearanceEventMap {
	change: { type: 'change' };
	dispose: { type: 'dispose' };
}

/** Expert strategy that can replace complete GLSL and render state per pass. */
export class CesiumGroundRawShaderAppearance extends EventDispatcher<
	CesiumGroundRawShaderAppearanceEventMap
> {
	public readonly kind = 'raw' as const;
	public readonly uniforms: GroundUserUniforms;
	public readonly factory: GroundMaterialFactory;

	private _version = 0;

	public constructor( options: CesiumGroundRawShaderAppearanceOptions ) {
		super();
		if ( options === null || typeof options !== 'object' || typeof options.factory !== 'function' ) {
			throw new CesiumGroundMaterialError(
				'GROUND_APPEARANCE_INCOMPATIBLE',
				'CesiumGroundRawShaderAppearance requires a synchronous material factory.',
				{ appearanceKind: 'raw' },
			);
		}

		const uniforms = options.uniforms ?? {};
		assertGroundUserUniforms( uniforms );
		// Preserve the original wrappers exactly; Raw default materials and complete
		// replacements must point at these same objects when they bind a user name.
		this.uniforms = uniforms;
		this.factory = options.factory;
	}

	/** Monotonic revision used to rerun every pass factory for a bound primitive. */
	public get version(): number {
		return this._version;
	}

	/** `true` records a structural factory change; `false` intentionally does nothing. */
	public set needsUpdate( value: boolean ) {
		if ( value !== true ) return;
		this._version += 1;
		this.dispatchEvent( { type: 'change' } );
	}

	/** Repeatable consumer-release notification; user uniform resources remain borrowed. */
	public dispose(): void {
		this.dispatchEvent( { type: 'dispose' } );
	}
}

/** Public union accepted by every appearance-enabled Ground primitive slot. */
export type CesiumGroundAppearance =
	| CesiumGroundMaterialAppearance
	| CesiumGroundRawShaderAppearance;

/** Common option fragment mixed into every public Appearance-enabled primitive. */
export interface CesiumGroundAppearanceOptions {
	appearance?: CesiumGroundAppearance;
}

/** Structural owner contract shared by all public Ground primitive classes. */
export interface CesiumGroundAppearanceOwner {
	readonly appearance: CesiumGroundAppearance;
	setAppearance( appearance?: CesiumGroundAppearance ): void;
}
