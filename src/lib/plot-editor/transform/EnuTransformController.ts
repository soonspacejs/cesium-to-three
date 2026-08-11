import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { CommandResult, EditorError, EnuTransform } from '../commands/types';
import type { PlotDocument } from '../document/PlotDocument';
import type { PlotFeature, PlotFeatureId } from '../document/types';
import type { TransformMode } from '../state/types';
import { WorkingCopy } from '../state/working-copy';
import { applyEnuTransformToFeature } from './feature-transform';
import {
	computeSelectionPivot,
	getSelectionGizmoCapabilities,
} from './gizmo';
import type {
	GizmoAxis,
	GizmoCapabilities,
	PivotDiagnostic,
	SelectionPivot,
	TransformDelta,
	TransformPreview,
	TransformSessionState,
} from './types';

export interface EnuTransformControllerOptions {
	readonly document: PlotDocument;
	readonly executor: CommandExecutor;
	readonly history: HistoryManager;
	readonly adapters: GeometryAdapterRegistry;
	readonly createTransactionId?: () => string;
	readonly onPreviewChange?: ( preview: TransformPreview | null ) => void;
	readonly onDiagnostic?: ( diagnostic: PivotDiagnostic ) => void;
}

export interface TransformControllerResult {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly revision: number;
	readonly preview?: TransformPreview;
	readonly error?: EditorError;
}

interface ActiveTransformSession {
	readonly transactionId: string;
	readonly mode: TransformMode;
	readonly selectedIds: readonly PlotFeatureId[];
	readonly primaryId: PlotFeatureId;
	readonly sourceDocumentRevision: number;
	readonly sourceFeatures: ReadonlyMap<PlotFeatureId, PlotFeature>;
	readonly working: WorkingCopy;
	readonly pivot: SelectionPivot;
	readonly capabilities: GizmoCapabilities;
	axis?: GizmoAxis;
	dirty: boolean;
	committable: boolean;
	lastTransform?: EnuTransform;
	lastError?: EditorError;
}

/** 多选 G/R/S、Gizmo drag 与键盘 nudge 共用的原子 ENU 事务。 */
export class EnuTransformController {
	private readonly _document: PlotDocument;
	private readonly _executor: CommandExecutor;
	private readonly _history: HistoryManager;
	private readonly _adapters: GeometryAdapterRegistry;
	private readonly _createTransactionId: () => string;
	private readonly _onPreviewChange?: ( preview: TransformPreview | null ) => void;
	private readonly _onDiagnostic?: ( diagnostic: PivotDiagnostic ) => void;
	private _session: ActiveTransformSession | undefined;
	private _disposed = false;

	public constructor( options: EnuTransformControllerOptions ) {
		this._document = options.document;
		this._executor = options.executor;
		this._history = options.history;
		this._adapters = options.adapters;
		this._createTransactionId = options.createTransactionId ?? defaultTransactionId;
		this._onPreviewChange = options.onPreviewChange;
		this._onDiagnostic = options.onDiagnostic;
	}

	public get session(): TransformSessionState | null {
		const session = this._session;
		return session === undefined ? null : Object.freeze( {
			transactionId: session.transactionId,
			mode: session.mode,
			selectedIds: session.selectedIds,
			sourceDocumentRevision: session.sourceDocumentRevision,
			pivot: session.pivot,
			capabilities: session.capabilities,
			...( session.axis === undefined ? {} : { axis: session.axis } ),
			dirty: session.dirty,
			committable: session.committable,
		} );
	}

	public begin(
		ids: readonly PlotFeatureId[],
		primaryId: PlotFeatureId,
		mode: TransformMode,
	): TransformControllerResult {
		if ( this._disposed ) return this._failure( 'EDITOR_DISPOSED', 'ENU 变换控制器已销毁。' );
		if ( this._session !== undefined ) {
			return this._failure( 'TRANSFORM_TRANSACTION_ACTIVE', '已有 ENU 变换事务正在进行。' );
		}
		const selectedIds = Object.freeze( [ ...new Set( ids ) ] );
		if ( selectedIds.length === 0 || ! selectedIds.includes( primaryId ) ) {
			return this._failure( 'TRANSFORM_SELECTION_INVALID', '变换 selection 不能为空，primary 必须属于 selection。' );
		}
		const features: PlotFeature[] = [];
		for ( const id of selectedIds ) {
			const feature = this._document.get( id );
			if ( feature === undefined ) return this._failure( 'FEATURE_NOT_FOUND', `图形不存在：${ id }。` );
			if ( feature.visible === false
				|| feature.properties.editable === false
				|| feature.properties.locked === true ) {
				return this._failure( 'TRANSFORM_SELECTION_INVALID', `图形 ${ id } 隐藏、锁定或只读。` );
			}
			features.push( feature as PlotFeature );
		}
		const capabilities = getSelectionGizmoCapabilities( features, this._adapters );
		if ( ! modeEnabled( mode, capabilities ) ) {
			return this._failure( 'TRANSFORM_CAPABILITY_BLOCKED', `selection 不支持 ${ mode } 变换。` );
		}
		let pivot: SelectionPivot;
		try {
			pivot = computeSelectionPivot( features, this._adapters, {
				primaryId,
				onDiagnostic: this._onDiagnostic,
			} );
		} catch ( error ) {
			return this._failureFromUnknown( error );
		}
		const sourceFeatures = new Map( features.map( ( feature ) => [ feature.id, feature ] ) );
		const session: ActiveTransformSession = {
			transactionId: this._createTransactionId(),
			mode,
			selectedIds,
			primaryId,
			sourceDocumentRevision: this._document.revision,
			sourceFeatures,
			working: new WorkingCopy( this._document, selectedIds ),
			pivot,
			capabilities,
			dirty: false,
			committable: false,
		};
		this._session = session;
		const preview = this._preview( session );
		this._emitPreview( preview );
		return Object.freeze( {
			ok: true, changed: false, revision: this._document.revision, preview,
		} );
	}

	public constrain( axis: GizmoAxis | undefined ): TransformControllerResult {
		if ( this._disposed ) return this._failure( 'EDITOR_DISPOSED', 'ENU 变换控制器已销毁。' );
		const session = this._session;
		if ( session === undefined ) return this._failure( 'TRANSFORM_TRANSACTION_MISSING', '没有活动变换事务。' );
		if ( axis !== undefined && ! axisEnabled( session.mode, axis, session.capabilities ) ) {
			return this._failure( 'TRANSFORM_CAPABILITY_BLOCKED', `${ axis } 约束在当前 selection 上被禁用。` );
		}
		session.axis = axis;
		const preview = this._preview( session );
		this._emitPreview( preview );
		return Object.freeze( {
			ok: true, changed: false, revision: this._document.revision, preview,
		} );
	}

	/** delta 相对事务起点，避免把每帧位移/角度累计两次。 */
	public update( delta: TransformDelta ): TransformControllerResult {
		if ( this._disposed ) return this._failure( 'EDITOR_DISPOSED', 'ENU 变换控制器已销毁。' );
		const session = this._session;
		if ( session === undefined ) return this._failure( 'TRANSFORM_TRANSACTION_MISSING', '没有活动变换事务。' );
		if ( this._document.revision !== session.sourceDocumentRevision ) {
			return this._rollbackFailure( session, 'REVISION_CONFLICT', '变换期间文档被外部修改，整组已回滚。' );
		}
		let transform: EnuTransform;
		try {
			transform = constrainTransform( session, delta );
			const batch = session.working.updateAll( ( _current, id ) => {
				const source = session.sourceFeatures.get( id );
				if ( source === undefined ) throw new Error( `FEATURE_NOT_FOUND：${ id }。` );
				return applyEnuTransformToFeature( source, transform, this._adapters );
			} );
			if ( ! batch.ok ) throw batch.error;
		} catch ( error ) {
			session.committable = false;
			session.lastError = editorErrorFromUnknown( error );
			const preview = this._preview( session );
			this._emitPreview( preview );
			return Object.freeze( {
				ok: false, changed: false, revision: this._document.revision,
				error: session.lastError, preview,
			} );
		}
		session.lastTransform = transform;
		session.dirty = true;
		session.committable = true;
		session.lastError = undefined;
		const preview = this._preview( session );
		this._emitPreview( preview );
		return Object.freeze( {
			ok: true, changed: true, revision: this._document.revision, preview,
		} );
	}

	/** held key 重复调用只更新同一 working transaction，keyup 时再 commit。 */
	public nudge( axis: Exclude<GizmoAxis, 'uniform'>, amountMeters: number ): TransformControllerResult {
		const session = this._session;
		if ( session === undefined ) return this._failure( 'TRANSFORM_TRANSACTION_MISSING', '没有活动变换事务。' );
		if ( session.mode !== 'translate' ) return this._failure( 'TRANSFORM_MODE_MISMATCH', 'nudge 只能用于 translate 事务。' );
		if ( ! Number.isFinite( amountMeters ) ) return this._failure( 'TRANSFORM_INVALID', 'nudge 米数必须是有限数。' );
		const previous = session.lastTransform?.translationMeters ?? [ 0, 0, 0 ];
		const index = axis === 'east' ? 0 : axis === 'north' ? 1 : 2;
		const translation = [ ...previous ] as [ number, number, number ];
		translation[ index ] += amountMeters;
		const previousAxis = session.axis;
		session.axis = undefined;
		const result = this.update( { translationMeters: translation } );
		session.axis = previousAxis;
		return result;
	}

	public commit( label = 'ENU 组变换' ): CommandResult {
		if ( this._disposed ) return this._commandFailure( 'EDITOR_DISPOSED', 'ENU 变换控制器已销毁。' );
		const session = this._session;
		if ( session === undefined ) return this._commandFailure( 'TRANSFORM_TRANSACTION_MISSING', '没有活动变换事务。' );
		this._session = undefined;
		const candidateEmpty = session.working.getAll().every( ( feature ) => {
			const source = session.sourceFeatures.get( feature.id );
			return source !== undefined && featuresSemanticallyEqual( source, feature as PlotFeature );
		} );
		if ( ! session.committable || ! session.dirty
			|| session.lastTransform === undefined || candidateEmpty ) {
			session.working.cancel();
			this._emitPreview( null );
			return this._commandFailure(
				session.lastError?.code ?? 'TRANSFORM_EMPTY',
				session.lastError?.message ?? '变换没有产生可提交的有效变化。',
			);
		}
		if ( this._document.revision !== session.sourceDocumentRevision ) {
			session.working.cancel();
			this._emitPreview( null );
			return this._commandFailure( 'REVISION_CONFLICT', '变换期间文档被外部修改，整组已回滚。' );
		}
		const beforeRevisions: Record<PlotFeatureId, number> = {};
		for ( const [ id, feature ] of session.sourceFeatures ) beforeRevisions[ id ] = feature.revision;
		const result = this._history.execute(
			this._executor,
			{
				type: 'feature.transform',
				ids: session.selectedIds,
				beforeRevisions: Object.freeze( beforeRevisions ),
				transform: session.lastTransform,
			},
			undefined,
			label,
		);
		session.working.cancel();
		this._emitPreview( null );
		return result;
	}

	public cancel(): void {
		const session = this._session;
		if ( session === undefined ) return;
		this._session = undefined;
		session.working.cancel();
		this._emitPreview( null );
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this.cancel();
		this._disposed = true;
	}

	private _preview( session: ActiveTransformSession ): TransformPreview {
		return Object.freeze( {
			transactionId: session.transactionId,
			mode: session.mode,
			selectedIds: session.selectedIds,
			pivot: session.pivot,
			capabilities: session.capabilities,
			...( session.axis === undefined ? {} : { axis: session.axis } ),
			features: session.working.getAll(),
			committable: session.committable,
			...( session.lastError === undefined ? {} : { error: session.lastError } ),
		} );
	}

	private _rollbackFailure(
		session: ActiveTransformSession,
		code: string,
		message: string,
	): TransformControllerResult {
		this._session = undefined;
		session.working.cancel();
		this._emitPreview( null );
		return this._failure( code, message );
	}

	private _failureFromUnknown( error: unknown ): TransformControllerResult {
		const value = editorErrorFromUnknown( error );
		return this._failure( value.code, value.message );
	}

	private _failure( code: string, message: string ): TransformControllerResult {
		return Object.freeze( {
			ok: false, changed: false, revision: this._document.revision,
			error: errorValue( code, message ),
		} );
	}

	private _commandFailure( code: string, message: string ): CommandResult {
		return Object.freeze( {
			ok: false, changed: false, revision: this._document.revision,
			affectedIds: Object.freeze( [] ), error: errorValue( code, message ),
		} );
	}

	private _emitPreview( preview: TransformPreview | null ): void {
		this._onPreviewChange?.( preview );
	}
}

function constrainTransform(
	session: ActiveTransformSession,
	delta: TransformDelta,
): EnuTransform {
	if ( session.mode === 'translate' ) {
		if ( delta.rotationDegrees !== undefined || delta.scale !== undefined ) {
			throw new Error( 'TRANSFORM_MODE_MISMATCH：translate 事务只接受 translationMeters。' );
		}
		let translation = delta.translationMeters ?? [ 0, 0, 0 ];
		if ( session.axis !== undefined && session.axis !== 'uniform' ) {
			const index = session.axis === 'east' ? 0 : session.axis === 'north' ? 1 : 2;
			translation = translation.map( ( value, current ) => current === index ? value : 0 ) as [ number, number, number ];
		}
		return Object.freeze( { pivot: session.pivot.position, translationMeters: translation } );
	}
	if ( session.mode === 'rotate' ) {
		if ( delta.translationMeters !== undefined || delta.scale !== undefined ) {
			throw new Error( 'TRANSFORM_MODE_MISMATCH：rotate 事务只接受 rotationDegrees。' );
		}
		let rotation = delta.rotationDegrees ?? [ 0, 0, 0 ];
		if ( session.axis !== undefined && session.axis !== 'uniform' ) {
			const index = session.axis === 'up' ? 0 : session.axis === 'east' ? 1 : 2;
			rotation = rotation.map( ( value, current ) => current === index ? value : 0 ) as [ number, number, number ];
		}
		return Object.freeze( { pivot: session.pivot.position, rotationDegrees: rotation } );
	}
	if ( delta.translationMeters !== undefined || delta.rotationDegrees !== undefined ) {
		throw new Error( 'TRANSFORM_MODE_MISMATCH：scale 事务只接受 scale。' );
	}
	let scale = delta.scale ?? [ 1, 1, 1 ];
	if ( session.axis === 'east' ) {
		scale = selectionRequiresUniformHorizontalScale( session )
			? [ scale[ 0 ], scale[ 0 ], 1 ] : [ scale[ 0 ], 1, 1 ];
	} else if ( session.axis === 'north' ) {
		scale = selectionRequiresUniformHorizontalScale( session )
			? [ scale[ 1 ], scale[ 1 ], 1 ] : [ 1, scale[ 1 ], 1 ];
	}
	else if ( session.axis === 'up' ) scale = [ 1, 1, scale[ 2 ] ];
	else if ( session.axis === 'uniform' ) {
		const uniform = scale[ 0 ];
		scale = [ uniform, uniform, session.capabilities.scaleVertical ? uniform : 1 ];
	}
	return Object.freeze( { pivot: session.pivot.position, scale } );
}

/** 参数化圆形只有一个水平尺寸；组内包含此类图形时，水平轴手柄必须整体等比缩放。 */
function selectionRequiresUniformHorizontalScale( session: ActiveTransformSession ): boolean {
	return [ ...session.sourceFeatures.values() ].some( ( feature ) =>
		feature.type === 'circle'
		|| feature.type === 'sector'
		|| feature.type === 'point' && feature.style.pointStyle !== 'image',
	);
}

function modeEnabled( mode: TransformMode, capabilities: GizmoCapabilities ): boolean {
	if ( mode === 'translate' ) return capabilities.translateEast || capabilities.translateNorth || capabilities.translateUp;
	if ( mode === 'rotate' ) return capabilities.rotateHeading || capabilities.rotatePitch || capabilities.rotateRoll;
	return capabilities.scaleHorizontal || capabilities.scaleVertical;
}

function axisEnabled(
	mode: TransformMode,
	axis: GizmoAxis,
	capabilities: GizmoCapabilities,
): boolean {
	if ( mode === 'translate' ) {
		if ( axis === 'east' ) return capabilities.translateEast;
		if ( axis === 'north' ) return capabilities.translateNorth;
		if ( axis === 'up' ) return capabilities.translateUp;
		return capabilities.translateEast && capabilities.translateNorth;
	}
	if ( mode === 'rotate' ) {
		if ( axis === 'east' ) return capabilities.rotatePitch;
		if ( axis === 'north' ) return capabilities.rotateRoll;
		if ( axis === 'up' ) return capabilities.rotateHeading;
		return false;
	}
	if ( axis === 'east' || axis === 'north' || axis === 'uniform' ) return capabilities.scaleHorizontal;
	return capabilities.scaleVertical;
}

function editorErrorFromUnknown( error: unknown ): EditorError {
	if ( error !== null && typeof error === 'object' ) {
		const diagnostic = ( error as { diagnostic?: { code?: unknown; message?: unknown } } ).diagnostic;
		if ( diagnostic !== undefined
			&& typeof diagnostic.code === 'string'
			&& typeof diagnostic.message === 'string' ) {
			const nested = /^([A-Z][A-Z0-9_]+)[：:]/.exec( diagnostic.message )?.[ 1 ];
			return errorValue(
				diagnostic.code === 'INVALID_COMMAND' && nested !== undefined ? nested : diagnostic.code,
				diagnostic.message,
			);
		}
	}
	const message = error instanceof Error ? error.message : 'ENU 变换失败。';
	const code = /^([A-Z][A-Z0-9_]+)[：:]/.exec( message )?.[ 1 ] ?? 'TRANSFORM_INVALID';
	return errorValue( code, message );
}

function errorValue( code: string, message: string ): EditorError {
	return Object.freeze( { code, message } );
}

function featuresSemanticallyEqual( left: PlotFeature, right: PlotFeature ): boolean {
	const { revision: _leftRevision, ...leftValue } = left;
	const { revision: _rightRevision, ...rightValue } = right;
	return JSON.stringify( leftValue ) === JSON.stringify( rightValue );
}

let nextTransactionId = 1;

function defaultTransactionId(): string {
	return `enu-transform:${ nextTransactionId++ }`;
}
