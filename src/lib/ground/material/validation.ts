// ============================================================
// material/validation.ts
// Purpose: one authoritative validation boundary for user uniforms and defines.
// Keeping the reserved tables here prevents built-ins, safe compilation and Raw
// factories from drifting into subtly different naming policies.
// ============================================================

import { CesiumGroundMaterialError } from './errors';
import type { CesiumGroundMaterial } from './CesiumGroundMaterial';
import { C23_GROUND_SHADER_ABI_VERSION } from './shader-abi';
import type {
	GroundDefines,
	GroundDefineValue,
	GroundPrimitiveKind,
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

// ---------------------------------------------------------------------------
// Safe fragment-source lexical validation
// ---------------------------------------------------------------------------

/** Minimal token categories needed to reason about declarations and scopes. */
type GroundGlslTokenKind = 'identifier' | 'number' | 'symbol';

/**
 * A token retains its original source location even after comments and
 * preprocessor lines have been masked. This location is copied into stable
 * diagnostics so applications can point at the real user-authored line.
 */
interface GroundGlslToken {
	kind: GroundGlslTokenKind;
	value: string;
	index: number;
	line: number;
	column: number;
}

interface GroundSourceValidationContext {
	materialType: string;
	kind: GroundPrimitiveKind;
}

interface GroundFunctionCandidate {
	name: GroundGlslToken;
	/** Header tokens from the return type through the closing parenthesis. */
	header: readonly GroundGlslToken[];
}

/** Result used by tests and the compiler's schema diagnostics. */
export interface GroundMaterialSourceAnalysis {
	/** Sorted user uniform declarations found in the safe GLSL source. */
	readonly declaredUserUniforms: readonly string[];
	/** Number of real lexical tokens, excluding whitespace and comments. */
	readonly tokenCount: number;
}

/** Only conditional branching is legal inside a safe user shader. */
const SAFE_PREPROCESSOR_DIRECTIVES = new Set( [
	'if',
	'ifdef',
	'ifndef',
	'elif',
	'else',
	'endif',
] );

/**
 * Qualifiers that can precede the type of a top-level variable declaration.
 * They are skipped only to locate the declared identifier; separate policy
 * checks still reject fragment inputs/outputs and precision statements.
 */
const TOP_LEVEL_DECLARATION_QUALIFIERS = new Set( [
	'const',
	'uniform',
	'highp',
	'mediump',
	'lowp',
	'invariant',
	'centroid',
	'flat',
	'smooth',
	'noperspective',
	'precise',
	'coherent',
	'volatile',
	'restrict',
	'readonly',
	'writeonly',
	'buffer',
	'shared',
] );

/** Inputs/outputs belong to the library-owned stage interface, never Material. */
const FORBIDDEN_TOP_LEVEL_STORAGE = new Set( [ 'in', 'out', 'varying', 'attribute' ] );

function lineAndColumnAt( source: string, index: number ): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for ( let cursor = 0; cursor < index; cursor += 1 ) {
		if ( source.charCodeAt( cursor ) === 10 ) {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

/**
 * Creates one source-policy error with identical context for every scanner
 * branch. `token` can be synthetic for a missing entry point, but real tokens
 * always contribute exact one-based line and column values.
 */
function throwGroundSourceError(
	code:
		| 'GROUND_MATERIAL_FUNCTION_MISSING'
		| 'GROUND_MATERIAL_FUNCTION_INVALID'
		| 'GROUND_MATERIAL_MAIN_FORBIDDEN'
		| 'GROUND_MATERIAL_SOURCE_FORBIDDEN',
	context: GroundSourceValidationContext,
	token: GroundGlslToken | string,
	reason: string,
	message: string,
): never {
	const tokenValue = typeof token === 'string' ? token : token.value;
	const location = typeof token === 'string'
		? {}
		: { line: token.line, column: token.column, index: token.index };
	throw new CesiumGroundMaterialError( code, message, {
		materialType: context.materialType,
		kind: context.kind,
		token: tokenValue,
		reason,
		abiVersion: C23_GROUND_SHADER_ABI_VERSION,
		...location,
	} );
}

/** Replaces comment bytes with spaces while preserving every newline/index. */
function maskGlslComments(
	source: string,
	context: GroundSourceValidationContext,
): string {
	const masked = source.split( '' );
	let cursor = 0;

	while ( cursor < source.length ) {
		const first = source[ cursor ];
		const second = source[ cursor + 1 ];
		if ( first !== '/' || ( second !== '/' && second !== '*' ) ) {
			cursor += 1;
			continue;
		}

		const commentStart = cursor;
		if ( second === '/' ) {
			// A line comment ends before the newline so line accounting survives.
			while ( cursor < source.length && source.charCodeAt( cursor ) !== 10 ) {
				masked[ cursor ] = ' ';
				cursor += 1;
			}
			continue;
		}

		// Block comments may span lines. Newline characters remain untouched;
		// every other byte is masked to prevent keywords inside comments leaking.
		masked[ cursor ] = ' ';
		masked[ cursor + 1 ] = ' ';
		cursor += 2;
		let terminated = false;
		while ( cursor < source.length ) {
			if ( source[ cursor ] === '*' && source[ cursor + 1 ] === '/' ) {
				masked[ cursor ] = ' ';
				masked[ cursor + 1 ] = ' ';
				cursor += 2;
				terminated = true;
				break;
			}
			if ( source.charCodeAt( cursor ) !== 10 ) masked[ cursor ] = ' ';
			cursor += 1;
		}

		if ( ! terminated ) {
			const location = lineAndColumnAt( source, commentStart );
			throwGroundSourceError(
				'GROUND_MATERIAL_SOURCE_FORBIDDEN',
				context,
				{
					kind: 'symbol',
					value: '/*',
					index: commentStart,
					...location,
				},
				'unterminated-block-comment',
				'Ground Material source contains an unterminated block comment.',
			);
		}
	}

	return masked.join( '' );
}

/** Returns whether a physical preprocessor line continues with a backslash. */
function hasLineContinuation( line: string ): boolean {
	let cursor = line.length - 1;
	while ( cursor >= 0 && /[\t\f\v ]/.test( line[ cursor ] ) ) cursor -= 1;
	return cursor >= 0 && line[ cursor ] === '\\';
}

/**
 * Validates directives and masks their complete logical lines. Directive
 * payloads are intentionally not parsed as GLSL declarations: they only choose
 * which already-validated source branch the driver will compile.
 */
function maskAndValidatePreprocessor(
	source: string,
	context: GroundSourceValidationContext,
): string {
	const masked = source.split( '' );
	let lineStart = 0;
	let lineNumber = 1;
	let continuingDirective = false;

	while ( lineStart <= source.length ) {
		const newlineIndex = source.indexOf( '\n', lineStart );
		const lineEnd = newlineIndex === -1 ? source.length : newlineIndex;
		const line = source.slice( lineStart, lineEnd );
		const firstCodeOffset = line.search( /[^\t\f\v\r ]/ );
		const startsDirective = firstCodeOffset >= 0 && line[ firstCodeOffset ] === '#';

		if ( continuingDirective || startsDirective ) {
			if ( startsDirective && ! continuingDirective ) {
				const directiveText = line.slice( firstCodeOffset );
				const match = /^#\s*([A-Za-z_][A-Za-z0-9_]*)/.exec( directiveText );
				const directive = match?.[ 1 ];
				const tokenValue = directive === undefined ? '#' : `#${ directive }`;
				if ( directive === undefined || ! SAFE_PREPROCESSOR_DIRECTIVES.has( directive ) ) {
					const tokenIndex = lineStart + firstCodeOffset;
					throwGroundSourceError(
						'GROUND_MATERIAL_SOURCE_FORBIDDEN',
						context,
						{
							kind: 'symbol',
							value: tokenValue,
							index: tokenIndex,
							line: lineNumber,
							column: firstCodeOffset + 1,
						},
						'preprocessor-directive-forbidden',
						`Ground Material source cannot contain ${ tokenValue } directives.`,
					);
				}
			}

			for ( let cursor = lineStart; cursor < lineEnd; cursor += 1 ) masked[ cursor ] = ' ';
			continuingDirective = hasLineContinuation( line );
		} else {
			continuingDirective = false;
		}

		if ( newlineIndex === -1 ) break;
		lineStart = newlineIndex + 1;
		lineNumber += 1;
	}

	return masked.join( '' );
}

/** Converts comment/directive-free GLSL into location-aware lexical tokens. */
function tokenizeGroundGlsl( source: string ): GroundGlslToken[] {
	const tokens: GroundGlslToken[] = [];
	let cursor = 0;
	let line = 1;
	let column = 1;

	while ( cursor < source.length ) {
		const character = source[ cursor ];
		if ( character === '\n' ) {
			cursor += 1;
			line += 1;
			column = 1;
			continue;
		}
		if ( /\s/.test( character ) ) {
			cursor += 1;
			column += 1;
			continue;
		}

		const tokenIndex = cursor;
		const tokenColumn = column;
		if ( /[A-Za-z_]/.test( character ) ) {
			cursor += 1;
			column += 1;
			while ( cursor < source.length && /[A-Za-z0-9_]/.test( source[ cursor ] ) ) {
				cursor += 1;
				column += 1;
			}
			tokens.push( {
				kind: 'identifier',
				value: source.slice( tokenIndex, cursor ),
				index: tokenIndex,
				line,
				column: tokenColumn,
			} );
			continue;
		}

		if ( /[0-9]/.test( character ) || ( character === '.' && /[0-9]/.test( source[ cursor + 1 ] ?? '' ) ) ) {
			cursor += 1;
			column += 1;
			while ( cursor < source.length && /[A-Za-z0-9_.+-]/.test( source[ cursor ] ) ) {
				// A sign belongs to a numeric exponent only. Stopping at ordinary
				// arithmetic signs keeps `1+value` as three useful tokens.
				const next = source[ cursor ];
				if ( ( next === '+' || next === '-' ) && ! /[eEpP]/.test( source[ cursor - 1 ] ) ) break;
				cursor += 1;
				column += 1;
			}
			tokens.push( {
				kind: 'number',
				value: source.slice( tokenIndex, cursor ),
				index: tokenIndex,
				line,
				column: tokenColumn,
			} );
			continue;
		}

		tokens.push( {
			kind: 'symbol',
			value: character,
			index: tokenIndex,
			line,
			column: tokenColumn,
		} );
		cursor += 1;
		column += 1;
	}

	return tokens;
}

/** Finds a declaration-style function header, excluding constructor calls. */
function findFunctionCandidate(
	segment: readonly GroundGlslToken[],
): GroundFunctionCandidate | undefined {
	let squareDepth = 0;
	let openingParenthesis = -1;
	for ( let index = 0; index < segment.length; index += 1 ) {
		const value = segment[ index ].value;
		if ( value === '[' ) squareDepth += 1;
		else if ( value === ']' ) squareDepth -= 1;
		else if ( value === '=' && squareDepth === 0 ) return undefined;
		else if ( value === '(' && squareDepth === 0 ) {
			openingParenthesis = index;
			break;
		}
	}

	if ( openingParenthesis < 2 ) return undefined;
	const name = segment[ openingParenthesis - 1 ];
	const returnType = segment[ openingParenthesis - 2 ];
	if ( name.kind !== 'identifier' || returnType.kind !== 'identifier' ) return undefined;

	let parenthesisDepth = 0;
	let closingParenthesis = -1;
	for ( let index = openingParenthesis; index < segment.length; index += 1 ) {
		if ( segment[ index ].value === '(' ) parenthesisDepth += 1;
		if ( segment[ index ].value === ')' ) {
			parenthesisDepth -= 1;
			if ( parenthesisDepth === 0 ) {
				closingParenthesis = index;
				break;
			}
		}
	}
	if ( closingParenthesis === -1 ) return undefined;

	return {
		name,
		header: segment.slice( 0, closingParenthesis + 1 ),
	};
}

function assertTopLevelNameAvailable(
	token: GroundGlslToken,
	domain: 'function' | 'struct' | 'global',
	context: GroundSourceValidationContext,
): void {
	if ( token.value === 'c23_getMaterial' ) {
		if ( domain === 'function' ) return;
		throwGroundSourceError(
			'GROUND_MATERIAL_FUNCTION_INVALID',
			context,
			token,
			'material-entry-not-a-function',
			'c23_getMaterial must be the exact safe Material entry function.',
		);
	}

	const prefix = getReservedIdentifierPrefix( token.value );
	if ( prefix === undefined ) return;
	throwGroundSourceError(
		'GROUND_MATERIAL_SOURCE_FORBIDDEN',
		context,
		token,
		'reserved-top-level-identifier',
		`Ground Material ${ domain } "${ token.value }" uses the reserved "${ prefix }" prefix.`,
	);
}

/** Validates the name of a struct or interface block before entering its body. */
function validateTopLevelBlockHeader(
	header: readonly GroundGlslToken[],
	context: GroundSourceValidationContext,
): void {
	const structIndex = header.findIndex( token => token.value === 'struct' );
	if ( structIndex >= 0 ) {
		const structName = header[ structIndex + 1 ];
		if ( structName?.kind === 'identifier' ) {
			assertTopLevelNameAvailable( structName, 'struct', context );
		}
		return;
	}

	// GLSL interface-block names are declarations too. Safe Material has no
	// valid reason to own an input/output block; uniform blocks remain subject
	// to the same reserved namespace check even though ordinary names compile.
	const blockName = [ ...header ].reverse().find( token => token.kind === 'identifier' );
	if ( blockName !== undefined ) assertTopLevelNameAvailable( blockName, 'struct', context );
}

/** Finds declared globals (including comma-separated arrays) in one statement. */
function collectTopLevelVariables(
	segment: readonly GroundGlslToken[],
	context: GroundSourceValidationContext,
	declaredUserUniforms: Set<string>,
): void {
	if ( segment.length === 0 ) return;

	const precision = segment.find( token => token.value === 'precision' );
	if ( precision !== undefined ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			context,
			precision,
			'precision-declaration-forbidden',
			'Ground Material source cannot declare fragment precision.',
		);
	}

	const layout = segment.find( token => token.value === 'layout' );
	if ( layout !== undefined ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			context,
			layout,
			'layout-declaration-forbidden',
			'Ground Material source cannot declare a layout qualifier.',
		);
	}

	const stageStorage = segment.find( token => FORBIDDEN_TOP_LEVEL_STORAGE.has( token.value ) );
	if ( stageStorage !== undefined ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			context,
			stageStorage,
			'stage-interface-declaration-forbidden',
			`Ground Material source cannot declare top-level ${ stageStorage.value } stage storage.`,
		);
	}

	const structIndex = segment.findIndex( token => token.value === 'struct' );
	let cursor = 0;
	if ( structIndex >= 0 ) {
		const structName = segment[ structIndex + 1 ];
		if ( structName?.kind === 'identifier' ) {
			assertTopLevelNameAvailable( structName, 'struct', context );
		}
		cursor = structIndex + 2;
	} else {
		while (
			cursor < segment.length &&
			segment[ cursor ].kind === 'identifier' &&
			TOP_LEVEL_DECLARATION_QUALIFIERS.has( segment[ cursor ].value )
		) cursor += 1;
		// The first non-qualifier identifier is the declared GLSL type.
		if ( segment[ cursor ]?.kind !== 'identifier' ) return;
		cursor += 1;
	}

	const isUniform = segment.some( token => token.value === 'uniform' );
	let expectingName = true;
	let parenthesisDepth = 0;
	let squareDepth = 0;
	for ( ; cursor < segment.length; cursor += 1 ) {
		const token = segment[ cursor ];
		if ( expectingName && token.kind === 'identifier' ) {
			assertTopLevelNameAvailable( token, 'global', context );
			if ( isUniform ) declaredUserUniforms.add( token.value );
			expectingName = false;
		}

		if ( token.value === '(' ) parenthesisDepth += 1;
		else if ( token.value === ')' ) parenthesisDepth -= 1;
		else if ( token.value === '[' ) squareDepth += 1;
		else if ( token.value === ']' ) squareDepth -= 1;
		else if ( token.value === ',' && parenthesisDepth === 0 && squareDepth === 0 ) {
			expectingName = true;
		}
	}
}

/** Validates one helper/entry declaration and returns whether it is the entry. */
function validateFunctionCandidate(
	candidate: GroundFunctionCandidate,
	isDefinition: boolean,
	context: GroundSourceValidationContext,
): boolean {
	const { name, header } = candidate;
	if ( name.value === 'main' ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_MAIN_FORBIDDEN',
			context,
			name,
			'main-function-forbidden',
			'Ground Material source cannot define or declare main().',
		);
	}

	assertTopLevelNameAvailable( name, 'function', context );
	if ( name.value !== 'c23_getMaterial' ) return false;

	const exactSignature = [
		'c23_material',
		'c23_getMaterial',
		'(',
		'c23_materialInput',
		// `input` is a reserved future keyword in GLSL ES 3.00 and is rejected
		// by ANGLE/SwiftShader. Fixing the parameter name here keeps validation
		// aligned with the actual WebGL2 compiler instead of accepting source that
		// can only fail later during a render.
		'materialInput',
		')',
	];
	const signatureMatches =
		isDefinition &&
		header.length === exactSignature.length &&
		header.every(( token, index ) => token.value === exactSignature[ index ] );
	if ( ! signatureMatches ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_FUNCTION_INVALID',
			context,
			name,
			isDefinition ? 'material-entry-signature-invalid' : 'material-entry-must-be-defined',
			'Ground Material entry must be exactly c23_material c23_getMaterial(c23_materialInput materialInput).',
		);
	}
	return true;
}

/**
 * Walks only top-level declarations. Function bodies are skipped for ownership
 * checks, but their lexical tokens were already scanned for globally forbidden
 * operations such as discard and gl_FragDepth.
 */
function analyzeGroundTopLevel(
	tokens: readonly GroundGlslToken[],
	context: GroundSourceValidationContext,
): { declaredUserUniforms: Set<string>; entryCount: number } {
	const declaredUserUniforms = new Set<string>();
	let entryCount = 0;
	let braceDepth = 0;
	let rootBraceKind: 'function' | 'declaration' | undefined;
	let segment: GroundGlslToken[] = [];

	for ( const token of tokens ) {
		if ( braceDepth > 0 ) {
			if ( token.value === '{' ) braceDepth += 1;
			else if ( token.value === '}' ) {
				braceDepth -= 1;
				if ( braceDepth === 0 ) {
					if ( rootBraceKind === 'function' ) segment = [];
					rootBraceKind = undefined;
				}
			}
			continue;
		}

		if ( token.value === '}' ) {
			throwGroundSourceError(
				'GROUND_MATERIAL_SOURCE_FORBIDDEN',
				context,
				token,
				'unmatched-closing-brace',
				'Ground Material source contains an unmatched closing brace.',
			);
		}

		if ( token.value === '{' ) {
			const functionCandidate = findFunctionCandidate( segment );
			if ( functionCandidate !== undefined ) {
				if ( validateFunctionCandidate( functionCandidate, true, context ) ) entryCount += 1;
				rootBraceKind = 'function';
			} else {
				validateTopLevelBlockHeader( segment, context );
				rootBraceKind = 'declaration';
			}
			braceDepth = 1;
			continue;
		}

		if ( token.value === ';' ) {
			const functionCandidate = findFunctionCandidate( segment );
			if ( functionCandidate !== undefined ) {
				if ( validateFunctionCandidate( functionCandidate, false, context ) ) entryCount += 1;
			} else {
				collectTopLevelVariables( segment, context, declaredUserUniforms );
			}
			segment = [];
			continue;
		}

		segment.push( token );
	}

	if ( braceDepth !== 0 ) {
		const token = tokens[ tokens.length - 1 ] ?? '{';
		throwGroundSourceError(
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			context,
			token,
			'unterminated-top-level-block',
			'Ground Material source contains an unterminated block.',
		);
	}
	if ( segment.length > 0 ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_SOURCE_FORBIDDEN',
			context,
			segment[ 0 ],
			'incomplete-top-level-declaration',
			'Ground Material source contains an incomplete top-level declaration.',
		);
	}

	return { declaredUserUniforms, entryCount };
}

/** Ensures GLSL declarations and JavaScript uniform wrappers are one schema. */
function assertGroundUniformSchemaMatches(
	declaredUserUniforms: ReadonlySet<string>,
	material: Pick<CesiumGroundMaterial, 'type' | 'uniforms'>,
	context: GroundSourceValidationContext,
): void {
	for ( const declaredName of [ ...declaredUserUniforms ].sort() ) {
		if ( Object.prototype.hasOwnProperty.call( material.uniforms, declaredName ) ) continue;
		throw new CesiumGroundMaterialError(
			'GROUND_UNIFORM_NOT_DECLARED',
			`Ground GLSL uniform "${ declaredName }" has no user wrapper.`,
			{
				materialType: context.materialType,
				kind: context.kind,
				token: declaredName,
				reason: 'uniform-wrapper-missing',
				abiVersion: C23_GROUND_SHADER_ABI_VERSION,
			},
		);
	}

	for ( const wrapperName of Object.keys( material.uniforms ).sort() ) {
		if ( declaredUserUniforms.has( wrapperName ) ) continue;
		throw new CesiumGroundMaterialError(
			'GROUND_UNIFORM_NOT_DECLARED',
			`Ground user wrapper "${ wrapperName }" has no GLSL uniform declaration.`,
			{
				materialType: context.materialType,
				kind: context.kind,
				token: wrapperName,
				reason: 'uniform-declaration-missing',
				abiVersion: C23_GROUND_SHADER_ABI_VERSION,
			},
		);
	}
}

/**
 * Performs the complete safe-source lexical contract before assembly. This is
 * deliberately a tokenizer/scanner, not substring matching: comments are
 * ignored, declarations are checked only at top level, and diagnostics retain
 * exact source coordinates.
 */
export function validateGroundMaterialSource(
	material: Pick<CesiumGroundMaterial, 'type' | 'fragmentShader' | 'uniforms'>,
	kind: GroundPrimitiveKind,
): GroundMaterialSourceAnalysis {
	const context: GroundSourceValidationContext = {
		materialType: material.type,
		kind,
	};
	const commentFree = maskGlslComments( material.fragmentShader, context );
	const declarationSource = maskAndValidatePreprocessor( commentFree, context );
	const tokens = tokenizeGroundGlsl( declarationSource );

	for ( const token of tokens ) {
		if ( token.value === 'discard' ) {
			throwGroundSourceError(
				'GROUND_MATERIAL_SOURCE_FORBIDDEN',
				context,
				token,
				'discard-forbidden',
				'Ground Material source cannot discard fragments; return alpha 0 instead.',
			);
		}
		if ( token.value === 'gl_FragDepth' ) {
			throwGroundSourceError(
				'GROUND_MATERIAL_SOURCE_FORBIDDEN',
				context,
				token,
				'fragment-depth-forbidden',
				'Ground Material source cannot access gl_FragDepth.',
			);
		}
		if ( token.value === '#' || token.value === '"' || token.value === "'" ) {
			throwGroundSourceError(
				'GROUND_MATERIAL_SOURCE_FORBIDDEN',
				context,
				token,
				'unexpected-lexical-token',
				`Ground Material source contains forbidden token "${ token.value }".`,
			);
		}
	}

	const analysis = analyzeGroundTopLevel( tokens, context );
	if ( analysis.entryCount === 0 ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_FUNCTION_MISSING',
			context,
			'c23_getMaterial',
			'material-entry-missing',
			'Ground Material source must define c23_getMaterial exactly once.',
		);
	}
	if ( analysis.entryCount !== 1 ) {
		throwGroundSourceError(
			'GROUND_MATERIAL_FUNCTION_INVALID',
			context,
			'c23_getMaterial',
			'material-entry-duplicate',
			'Ground Material source must define c23_getMaterial exactly once.',
		);
	}

	assertGroundUniformSchemaMatches( analysis.declaredUserUniforms, material, context );
	return Object.freeze( {
		declaredUserUniforms: Object.freeze( [ ...analysis.declaredUserUniforms ].sort() ),
		tokenCount: tokens.length,
	} );
}
