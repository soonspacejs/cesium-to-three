// ============================================================
// material/errors.ts
// Purpose: stable, machine-readable errors for all synchronous Material and
//          Appearance validation. Callers can branch on `code` without parsing
//          wording, while `detail` preserves the exact offending identifier.
// ============================================================

export type CesiumGroundMaterialErrorCode =
	| 'GROUND_RESERVED_IDENTIFIER'
	| 'GROUND_UNIFORM_NOT_DECLARED'
	| 'GROUND_UNIFORM_CONFLICT'
	| 'GROUND_INVALID_DEFINE'
	| 'GROUND_MATERIAL_FUNCTION_MISSING'
	| 'GROUND_MATERIAL_FUNCTION_INVALID'
	| 'GROUND_MATERIAL_MAIN_FORBIDDEN'
	| 'GROUND_MATERIAL_SOURCE_FORBIDDEN'
	| 'GROUND_APPEARANCE_INCOMPATIBLE'
	| 'GROUND_RAW_FACTORY_RESULT_INVALID'
	| 'GROUND_RAW_MATERIAL_REUSED'
	| 'GROUND_RAW_REQUIRED_PASS_MISSING';

/** Error raised when a public Ground Material contract is violated. */
export class CesiumGroundMaterialError extends Error {
	public readonly code: CesiumGroundMaterialErrorCode;
	public readonly detail?: Readonly<Record<string, unknown>>;

	public constructor(
		code: CesiumGroundMaterialErrorCode,
		message: string,
		detail?: Readonly<Record<string, unknown>>,
	) {
		super( message );
		this.name = 'CesiumGroundMaterialError';
		this.code = code;
		this.detail = detail;
	}
}
