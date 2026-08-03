// ============================================================
// material/CesiumGroundMaterial.ts
// Layer: logical, pass-independent surface shading state.
// It owns no WebGL program and starts no animation loop. Consumers compile its
// stable source/schema into their own per-pass RawShaderMaterial instances.
// ============================================================

import { EventDispatcher, MathUtils } from 'three';

import { CesiumGroundMaterialError } from './errors';
import { computeLogicalMaterialKey } from './logical-key';
import type { GroundDefines, GroundUserUniforms } from './types';
import { cloneGroundUniforms } from './uniforms';
import { assertGroundDefines, assertGroundUserUniforms } from './validation';

export interface CesiumGroundMaterialOptions {
	/** Diagnostic label only; it is intentionally absent from program cache keys. */
	type?: string;
	/** User schema whose exact wrappers are shared by every compiled consumer. */
	uniforms?: GroundUserUniforms;
	/** Compile-time user macros. False records an off state and emits no macro. */
	defines?: GroundDefines;
	/** Safe GLSL3 material source. Entry-function validation occurs at compile time. */
	fragmentShader: string;
}

export interface CesiumGroundMaterialEventMap {
	change: { type: 'change' };
	dispose: { type: 'dispose' };
}

interface GroundMaterialStructureSnapshot {
	version: number;
	key: string;
}

/**
 * Structure snapshots stay outside the public object shape. Registering the
 * constructor state catches schema/source/define edits made even before the
 * first primitive binds the Material.
 */
const GROUND_MATERIAL_STRUCTURE_SNAPSHOTS = new WeakMap<
	CesiumGroundMaterial,
	GroundMaterialStructureSnapshot
>();

/**
 * Shareable logical Ground Material. Runtime animation mutates uniform values;
 * only explicit structural invalidation increments `version`.
 */
export class CesiumGroundMaterial extends EventDispatcher<CesiumGroundMaterialEventMap> {
	public readonly uuid: string;
	public type: string;
	public uniforms: GroundUserUniforms;
	public defines: GroundDefines;
	public fragmentShader: string;

	private _version = 0;

	public constructor( options: CesiumGroundMaterialOptions ) {
		super();
		if ( options === null || typeof options !== 'object' ) {
			throw new TypeError( 'CesiumGroundMaterial options must be an object.' );
		}
		if ( typeof options.fragmentShader !== 'string' ) {
			throw new TypeError( 'CesiumGroundMaterial fragmentShader must be a string.' );
		}
		if ( options.type !== undefined && typeof options.type !== 'string' ) {
			throw new TypeError( 'CesiumGroundMaterial type must be a string.' );
		}

		const uniforms = options.uniforms ?? {};
		const defines = options.defines ?? {};
		assertGroundUserUniforms( uniforms );
		assertGroundDefines( defines );

		this.uuid = MathUtils.generateUUID();
		this.type = options.type ?? 'CesiumGroundMaterial';
		// Construction intentionally preserves caller-supplied map and wrapper
		// identity. Only an explicit clone() creates independent wrappers/values.
		this.uniforms = uniforms;
		this.defines = defines;
		this.fragmentShader = options.fragmentShader;
		GROUND_MATERIAL_STRUCTURE_SNAPSHOTS.set( this, {
			version: this.version,
			key: computeLogicalMaterialKey( this ),
		} );
	}

	/** Monotonic structural revision; uniform values never affect it. */
	public get version(): number {
		return this._version;
	}

	/**
	 * Replaces only an existing wrapper's value. Unknown names cannot silently
	 * grow the schema because every current compiled map would miss that wrapper.
	 */
	public setUniform<T>( name: string, value: T ): this {
		if ( ! Object.prototype.hasOwnProperty.call( this.uniforms, name ) ) {
			throw new CesiumGroundMaterialError(
				'GROUND_UNIFORM_NOT_DECLARED',
				`Ground uniform "${ name }" is not declared; add its wrapper and set needsUpdate=true.`,
				{ identifier: name, materialType: this.type, version: this.version },
			);
		}
		this.uniforms[ name ].value = value;
		return this;
	}

	/** Creates an independent logical Material with r185-compatible uniform values. */
	public clone(): CesiumGroundMaterial {
		return new CesiumGroundMaterial( {
			type: this.type,
			uniforms: cloneGroundUniforms( this.uniforms ),
			defines: { ...this.defines },
			fragmentShader: this.fragmentShader,
		} );
	}

	/**
	 * `true` is an explicit structural revision and always dispatches change;
	 * `false` is a no-op. There is deliberately no readable boolean dirty flag.
	 */
	public set needsUpdate( value: boolean ) {
		if ( value !== true ) return;
		this._version += 1;
		this.dispatchEvent( { type: 'change' } );
	}

	/**
	 * Emits a repeatable release notification. The logical object remains usable
	 * and never disposes user Texture values or compiled resources owned elsewhere.
	 */
	public dispose(): void {
		this.dispatchEvent( { type: 'dispose' } );
	}
}

/**
 * Validates one prospective compile without accepting a new-version snapshot.
 * The caller commits the returned key only after source assembly succeeds, so
 * a failed candidate never makes an invalid edit the accepted structure.
 *
 * @internal
 */
export function prepareGroundMaterialStructureForCompile(
	material: CesiumGroundMaterial,
	context: Readonly<Record<string, unknown>>,
): string {
	assertGroundUserUniforms( material.uniforms );
	assertGroundDefines( material.defines );
	const currentKey = computeLogicalMaterialKey( material );
	const accepted = GROUND_MATERIAL_STRUCTURE_SNAPSHOTS.get( material );
	if (
		accepted !== undefined &&
		accepted.version === material.version &&
		accepted.key !== currentKey
	) {
		throw new CesiumGroundMaterialError(
			'GROUND_APPEARANCE_INCOMPATIBLE',
			'Ground Material structure changed without needsUpdate=true.',
			{
				...context,
				materialType: material.type,
				materialVersion: material.version,
				reason: 'material-structure-changed-without-needs-update',
			},
		);
	}
	return currentKey;
}

/** Accepts a successfully assembled structure for this exact revision. @internal */
export function commitGroundMaterialStructureForCompile(
	material: CesiumGroundMaterial,
	key: string,
): void {
	GROUND_MATERIAL_STRUCTURE_SNAPSHOTS.set( material, {
		version: material.version,
		key,
	} );
}
