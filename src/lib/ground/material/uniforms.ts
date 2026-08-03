// ============================================================
// material/uniforms.ts
// Purpose: explicit r185-compatible UniformsUtils.clone semantics for logical
//          Ground Material cloning. The runtime package is Three 0.183.x, whose
//          helper did not yet clone arrays of Three objects item-by-item, so the
//          versioned public contract is implemented here instead of delegated.
// ============================================================

import type { IUniform } from 'three';

import type { GroundUserUniforms } from './types';

interface ThreeCloneable {
	clone(): unknown;
	isColor?: boolean;
	isMatrix3?: boolean;
	isMatrix4?: boolean;
	isQuaternion?: boolean;
	isTexture?: boolean;
	isRenderTargetTexture?: boolean;
	isVector2?: boolean;
	isVector3?: boolean;
	isVector4?: boolean;
}

/**
 * Uses Three's public discriminator flags rather than `instanceof`. This keeps
 * cloning correct when a Texture or math object came from another Three bundle.
 */
function asThreeCloneable( value: unknown ): ThreeCloneable | undefined {
	if ( value === null || typeof value !== 'object' ) return undefined;
	const candidate = value as ThreeCloneable;
	const isSupported =
		candidate.isColor === true ||
		candidate.isMatrix3 === true ||
		candidate.isMatrix4 === true ||
		candidate.isQuaternion === true ||
		candidate.isTexture === true ||
		candidate.isVector2 === true ||
		candidate.isVector3 === true ||
		candidate.isVector4 === true;
	return isSupported && typeof candidate.clone === 'function' ? candidate : undefined;
}

/** Clones one wrapper property using the locked r185 UniformsUtils decision tree. */
function cloneUniformProperty( property: unknown ): unknown {
	const threeObject = asThreeCloneable( property );
	if ( threeObject !== undefined ) {
		if ( threeObject.isRenderTargetTexture === true ) {
			console.warn(
				'UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms().',
			);
			return null;
		}
		return threeObject.clone();
	}

	if ( Array.isArray( property ) ) {
		const first = asThreeCloneable( property[ 0 ] );
		if ( first !== undefined ) {
			// The r185 contract assumes a homogeneous array when the first element is
			// a supported Three object, exactly like Three's own implementation.
			return property.map( value => ( asThreeCloneable( value ) as ThreeCloneable ).clone() );
		}
		return property.slice();
	}

	// Primitives, functions, TypedArrays, and arbitrary business objects retain
	// their original identity. JSON/deep-clone behavior would violate prototypes
	// and could duplicate opaque GPU handles.
	return property;
}

/**
 * Creates a new uniform map and a new wrapper object for every schema entry.
 * User Texture clones remain caller-owned; this utility never disposes values.
 */
export function cloneGroundUniforms( source: GroundUserUniforms ): GroundUserUniforms {
	const cloned: GroundUserUniforms = {};
	for ( const name of Object.keys( source ) ) {
		const sourceUniform = source[ name ] as IUniform & Record<string, unknown>;
		const clonedUniform: Record<string, unknown> = {};
		for ( const propertyName of Object.keys( sourceUniform ) ) {
			clonedUniform[ propertyName ] = cloneUniformProperty( sourceUniform[ propertyName ] );
		}
		cloned[ name ] = clonedUniform as unknown as IUniform;
	}
	return cloned;
}
