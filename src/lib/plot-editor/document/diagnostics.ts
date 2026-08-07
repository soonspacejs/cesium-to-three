/** 公共错误码的最小稳定集合；各子系统可以在此集合上继续细分。 */
export type EditorErrorCode =
	| 'INVALID_SCHEMA'
	| 'UNSUPPORTED_VERSION'
	| 'INVALID_COORDINATE'
	| 'INVALID_HEIGHT_REFERENCE'
	| 'INVALID_GEOMETRY'
	| 'INVALID_STYLE'
	| 'INVALID_PROPERTIES'
	| 'ID_CONFLICT'
	| 'ORDER_CONFLICT'
	| 'REVISION_CONFLICT'
	| 'FEATURE_NOT_FOUND'
	| 'INVALID_COMMAND'
	| 'UNSUPPORTED_TRANSFORM'
	| 'TRANSFORM_CAPABILITY_BLOCKED'
	| 'REENTRANT_COMMAND'
	| 'TRANSACTION_CLOSED'
	| 'EDITOR_DISPOSED'
	| 'SAVE_HANDLER_MISSING'
	| 'SAVE_FAILED'
	| 'SURFACE_UNAVAILABLE'
	| 'RENDER_PROJECTION_FAILED'
	| 'UNSUPPORTED_GRAPHICS_KIND';

export type DiagnosticSeverity = 'error' | 'warning' | 'deprecated';

/** 可定位到 JSON Pointer 或 API 字段的结构化诊断。 */
export interface EditorDiagnostic {
	readonly code: EditorErrorCode | string;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly path?: string;
	/** 只保存适合展示的摘要，避免把外部对象或大型数组带入错误事件。 */
	readonly valueSummary?: string;
}

/**
 * 领域边界校验失败。
 *
 * 该错误只承载结构化诊断，不在构造时修改文档；命令层会把它转换为
 * `CommandResult`，而 codec 会把它加入 import diagnostics。
 */
export class PlotEditorValidationError extends Error {
	public readonly diagnostic: EditorDiagnostic;

	public constructor( diagnostic: EditorDiagnostic ) {
		super( diagnostic.message );
		this.name = 'PlotEditorValidationError';
		this.diagnostic = Object.freeze( { ...diagnostic } );
	}
}

/** 将未知输入压缩成不会抛错、不会无限展开的诊断摘要。 */
export function summarizeDiagnosticValue( value: unknown ): string {
	if ( typeof value === 'string' ) {
		return value.length <= 80 ? JSON.stringify( value ) : `${ JSON.stringify( value.slice( 0, 77 ) ) }...`;
	}
	if ( value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined' ) {
		return String( value );
	}
	if ( Array.isArray( value ) ) {
		return `[array length=${ value.length }]`;
	}
	return Object.prototype.toString.call( value );
}
