// ============================================================
// material/validation.ts
// Purpose: one authoritative validation boundary for user uniforms and defines.
// Keeping the reserved tables here prevents built-ins, safe compilation and Raw
// factories from drifting into subtly different naming policies.
// ============================================================

import { CesiumGroundMaterialError } from './errors';
import type {
	GroundDefines,
	GroundDefineValue,
	GroundUserUniforms,
} from './types';

const GLSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Prefixes owned by Cesium compatibility or the versioned C23 shader ABI. */
export const C23_RESERVED_IDENTIFIER_PREFIXES = [ 'czm_', 'c23_', 'C23_' ] as const;

/**
 * Three injects these uniforms independently of a RawShaderMaterial's user map.
 * Treating them as user schema would create two owners for one GLSL declaration.
 */
export const THREE_AUTOMATIC_UNIFORM_NAMES = new Set( [
	'modelMatrix',
	'modelViewMatrix',
	'projectionMatrix',
	'viewMatrix',
	'normalMatrix',
	'cameraPosition',
	'isOrthographic',
] );

/** Returns the reserved prefix at the start of `name`, if one is present. */
export function getReservedIdentifierPrefix(
	name: string,
): typeof C23_RESERVED_IDENTIFIER_PREFIXES[number] | undefined {
	return C23_RESERVED_IDENTIFIER_PREFIXES.find( prefix => name.startsWith( prefix ) );
}

/**
 * Validates one user-uniform key before it can enter a logical Material or Raw
 * Appearance. The check is case-sensitive by design: only the exact ABI-owned
 * namespaces are reserved.
 */
export function assertUserUniformName( name: string ): void {
	if ( ! GLSL_IDENTIFIER.test( name ) ) {
		throw new CesiumGroundMaterialError(
			'GROUND_RESERVED_IDENTIFIER',
			`Ground user uniform "${ name }" is not a valid GLSL identifier.`,
			{ identifier: name, reason: 'invalid-glsl-identifier' },
		);
	}

	const prefix = getReservedIdentifierPrefix( name );
	if ( prefix !== undefined ) {
		throw new CesiumGroundMaterialError(
			'GROUND_RESERVED_IDENTIFIER',
			`Ground user uniform "${ name }" uses the reserved "${ prefix }" prefix.`,
			{ identifier: name, prefix, domain: 'uniform' },
		);
	}

	if ( THREE_AUTOMATIC_UNIFORM_NAMES.has( name ) ) {
		throw new CesiumGroundMaterialError(
			'GROUND_UNIFORM_CONFLICT',
			`Ground user uniform "${ name }" conflicts with a Three automatic uniform.`,
			{ identifier: name, domain: 'three-automatic-uniform' },
		);
	}
}

/** Validates every wrapper in a user schema without cloning its map or values. */
export function assertGroundUserUniforms( uniforms: GroundUserUniforms ): void {
	if ( uniforms === null || typeof uniforms !== 'object' || Array.isArray( uniforms ) ) {
		throw new TypeError( 'Ground user uniforms must be an object map.' );
	}

	for ( const [ name, uniform ] of Object.entries( uniforms ) ) {
		assertUserUniformName( name );
		if ( uniform === null || typeof uniform !== 'object' || !( 'value' in uniform ) ) {
			throw new TypeError(
				`Ground user uniform "${ name }" must be an object containing a value property.`,
			);
		}
	}
}

/** Validates and returns a single define value without changing its semantics. */
function assertGroundDefineValue( name: string, value: unknown ): asserts value is GroundDefineValue {
	if ( typeof value === 'boolean' ) return;
	if ( typeof value === 'number' ) {
		if ( Number.isFinite( value ) ) return;
		throwInvalidDefine( name, value, 'number values must be finite' );
	}
	if ( typeof value === 'string' ) {
		const containsInjectionToken =
			value.length === 0 ||
			/[\r\n#]/.test( value ) ||
			value.includes( '//' ) ||
			value.includes( '/*' ) ||
			value.includes( '*/' );
		if ( ! containsInjectionToken ) return;
		throwInvalidDefine( name, value, 'string values must be one safe preprocessor expression' );
	}
	throwInvalidDefine( name, value, 'value must be a boolean, finite number, or string' );
}

function throwInvalidDefine( name: string, value: unknown, reason: string ): never {
	throw new CesiumGroundMaterialError(
		'GROUND_INVALID_DEFINE',
		`Ground define "${ name }" is invalid: ${ reason }.`,
		{ identifier: name, value, reason },
	);
}

/** Validates define names, values, and the ABI-owned macro namespace. */
export function assertGroundDefines( defines: GroundDefines ): void {
	if ( defines === null || typeof defines !== 'object' || Array.isArray( defines ) ) {
		throw new TypeError( 'Ground defines must be an object map.' );
	}

	for ( const [ name, value ] of Object.entries( defines ) ) {
		if ( ! GLSL_IDENTIFIER.test( name ) ) {
			throwInvalidDefine( name, value, 'name is not a valid GLSL identifier' );
		}
		if ( name.startsWith( 'C23_' ) ) {
			throw new CesiumGroundMaterialError(
				'GROUND_RESERVED_IDENTIFIER',
				`Ground define "${ name }" uses the reserved "C23_" prefix.`,
				{ identifier: name, prefix: 'C23_', domain: 'define' },
			);
		}
		assertGroundDefineValue( name, value );
	}
}

/**
 * Produces the canonical define sequence used by logical signatures. False is
 * retained as an explicit off state even though it emits no GLSL `#define`.
 */
export function canonicalizeGroundDefines(
	defines: GroundDefines,
): ReadonlyArray<readonly [ string, GroundDefineValue ]> {
	assertGroundDefines( defines );
	return Object.keys( defines )
		.sort()
		.map( name => [ name, defines[ name ] ] as const );
}
