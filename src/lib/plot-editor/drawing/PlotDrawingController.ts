import type { CommandExecutor } from '../commands/CommandExecutor';
import type { HistoryManager } from '../commands/HistoryManager';
import type { CommandResult } from '../commands/types';
import { getHeightMode } from '../document/height-reference';
import { normalizePosition } from '../document/normalize';
import type { PlotDocument } from '../document/PlotDocument';
import type {
	PlotFeature,
	PlotFeatureId,
	PlotFeatureType,
	Position3D,
} from '../document/types';
import type { PlotPickResult } from '../picking/types';
import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type {
	DrawToolContext,
	DrawingDraft,
	DrawingValidation,
	DraftPreviewGeometry,
	GeometryAdapter,
} from '../adapters/types';

export interface DrawingSession {
	readonly id: string;
	readonly type: PlotFeatureType;
	readonly draft: DrawingDraft;
	readonly preview: DraftPreviewGeometry;
	/** 与非派生 preview 顶点等长的运行时世界坐标，不进入 document/history。 */
	readonly resolvedPositions?: readonly Position3D[];
}

export interface DrawingControllerResult {
	readonly ok: boolean;
	readonly id?: PlotFeatureId;
	readonly validation?: DrawingValidation;
	readonly command?: CommandResult;
}

export interface PlotDrawingControllerOptions {
	readonly registry: GeometryAdapterRegistry;
	readonly document: PlotDocument;
	readonly executor: CommandExecutor;
	readonly history: HistoryManager;
	readonly createFeatureId?: () => PlotFeatureId;
	readonly onDraftChange?: ( session: DrawingSession | null ) => void;
}

/** 八类绘制工具的 transient session 与单次 add transaction 编排器。 */
export class PlotDrawingController {
	private readonly _options: PlotDrawingControllerOptions;
	private readonly _createFeatureId: () => PlotFeatureId;
	private _session: MutableDrawingSession | null = null;
	private _nextSessionId = 1;
	private _nextFeatureId = 1;
	private _disposed = false;

	public constructor( options: PlotDrawingControllerOptions ) {
		this._options = options;
		this._createFeatureId = options.createFeatureId ?? ( () => {
			let id: string;
			do id = `plot-${ this._nextFeatureId++ }`; while ( options.document.has( id ) );
			return id;
		} );
	}

	public get session(): DrawingSession | null {
		return this._session === null ? null : freezeSession( this._session );
	}

	public arm( context: DrawToolContext<any> ): string {
		this._assertOpen();
		this.cancel( 'rearm' );
		const adapter = this._options.registry.require( context.type );
		const id = `drawing-${ this._nextSessionId++ }`;
		this._session = {
			id,
			type: context.type,
			adapter,
			draft: adapter.begin( context ),
			resolvedPoints: Object.freeze( [] ),
		};
		this._emit();
		return id;
	}

	public addPick( hit: PlotPickResult | null ): DrawingControllerResult {
		this._assertOpen();
		const session = this._requireSession();
		if ( hit === null ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_PICK_MISS',
					message: '当前指针没有命中允许的 surface。',
				} ),
			} );
		}
		if ( hit.heightReference !== session.draft.heightReference ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_INVALID_HEIGHT',
					message: '一次绘制 session 不能混用不同 HeightReference。',
				} ),
			} );
		}
		const previousDraft = session.draft;
		session.draft = session.adapter.addPoint( previousDraft, hit.authorPosition, hit );
		session.resolvedPoints = remapResolvedPoints(
			previousDraft.points,
			session.resolvedPoints,
			session.draft.points,
			hit,
		);
		session.resolvedPreviewPoint = undefined;
		this._emit();
		return resultFromValidation( session.adapter.validateDraft( session.draft ) );
	}

	public movePick( hit: PlotPickResult | null ): DrawingControllerResult {
		this._assertOpen();
		const session = this._requireSession();
		if ( hit === null ) return this._pickMiss();
		if ( hit.heightReference !== session.draft.heightReference ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_INVALID_HEIGHT',
					message: 'preview HeightReference 与 session 不一致。',
				} ),
			} );
		}
		session.draft = session.adapter.movePointer( session.draft, hit.authorPosition, hit );
		session.resolvedPreviewPoint = resolvedPositionFromHit( hit );
		this._emit();
		return resultFromValidation( session.adapter.validateDraft( session.draft ) );
	}

	public removeLastPoint(): DrawingControllerResult {
		this._assertOpen();
		const session = this._requireSession();
		const previousDraft = session.draft;
		session.draft = session.adapter.removeLastPoint( previousDraft );
		session.resolvedPoints = remapResolvedPoints(
			previousDraft.points,
			session.resolvedPoints,
			session.draft.points,
		);
		session.resolvedPreviewPoint = undefined;
		this._emit();
		return resultFromValidation( session.adapter.validateDraft( session.draft ) );
	}

	public updateText( content: string ): DrawingControllerResult {
		this._assertOpen();
		const session = this._requireSession();
		if ( session.adapter.setText === undefined ) {
			throw new Error( `DRAW_TEXT_INPUT_REQUIRED：${ session.type } 不是 text adapter。` );
		}
		session.draft = session.adapter.setText( session.draft, content );
		this._emit();
		return resultFromValidation( session.adapter.validateDraft( session.draft ) );
	}

	public finish(): DrawingControllerResult {
		this._assertOpen();
		const session = this._requireSession();
		const validation = session.adapter.validateDraft( session.draft );
		if ( ! validation.valid || ! session.adapter.canFinish( session.draft ) ) {
			return Object.freeze( { ok: false, validation } );
		}
		let id: PlotFeatureId;
		try {
			id = this._createFeatureId();
			if ( typeof id !== 'string' || id.trim().length === 0 ) {
				throw new Error( 'feature id factory 必须返回非空字符串。' );
			}
		} catch ( error ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_INVALID_PARAMETER',
					message: error instanceof Error ? error.message : 'feature id 生成失败。',
				} ),
			} );
		}
		if ( this._options.document.has( id ) ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_INVALID_PARAMETER',
					message: `feature id 已存在：${ id }。`,
				} ),
			} );
		}
		let feature: PlotFeature;
		try {
			feature = session.adapter.finish( session.draft, { id } );
		} catch ( error ) {
			return Object.freeze( {
				ok: false,
				validation: Object.freeze( {
					valid: false,
					code: 'DRAW_INVALID_PARAMETER',
					message: error instanceof Error ? error.message : 'adapter finish 失败。',
				} ),
			} );
		}
		const command = this._options.history.execute(
			this._options.executor,
			{ type: 'feature.add', feature },
			undefined,
			`绘制${ session.type }`,
		);
		if ( ! command.ok ) {
			return Object.freeze( { ok: false, command } );
		}
		this._session = null;
		this._emit();
		return Object.freeze( { ok: true, id, command } );
	}

	public cancel( _reason = 'cancel' ): void {
		if ( this._disposed || this._session === null ) return;
		this._session.adapter.cancel( this._session.draft );
		this._session = null;
		this._emit();
	}

	public dispose(): void {
		if ( this._disposed ) return;
		this.cancel( 'dispose' );
		this._disposed = true;
	}

	private _pickMiss(): DrawingControllerResult {
		return Object.freeze( {
			ok: false,
			validation: Object.freeze( {
				valid: false,
				code: 'DRAW_PICK_MISS',
				message: '当前指针没有命中允许的 surface。',
			} ),
		} );
	}

	private _requireSession(): MutableDrawingSession {
		if ( this._session === null ) throw new Error( '当前没有 active drawing session。' );
		return this._session;
	}

	private _emit(): void {
		this._options.onDraftChange?.( this.session );
	}

	private _assertOpen(): void {
		if ( this._disposed ) throw new Error( 'PlotDrawingController 已销毁。' );
	}
}

interface MutableDrawingSession {
	readonly id: string;
	readonly type: PlotFeatureType;
	readonly adapter: GeometryAdapter;
	draft: DrawingDraft;
	resolvedPoints: readonly Position3D[];
	resolvedPreviewPoint?: Position3D;
}

function freezeSession( session: MutableDrawingSession ): DrawingSession {
	const preview = session.adapter.preview( session.draft );
	const resolvedPositions = resolvePreviewPositions( session, preview );
	return Object.freeze( {
		id: session.id,
		type: session.type,
		draft: session.draft,
		preview,
		...( resolvedPositions === undefined ? {} : { resolvedPositions } ),
	} );
}

function remapResolvedPoints(
	previousPoints: readonly Position3D[],
	previousResolved: readonly Position3D[],
	nextPoints: readonly Position3D[],
	hit?: PlotPickResult,
): readonly Position3D[] {
	const hitResolved = hit === undefined ? undefined : resolvedPositionFromHit( hit );
	// adapter 会先规范经度并把 clamp 作者高度归零；映射表面点时必须比较同一 canonical 值。
	const canonicalHitPosition = hit === undefined
		? undefined
		: normalizePosition( hit.authorPosition, hit.heightReference );
	return Object.freeze( nextPoints.map( ( point ) => {
		if ( canonicalHitPosition !== undefined && samePosition( point, canonicalHitPosition ) ) {
			return hitResolved as Position3D;
		}
		const previousIndex = previousPoints.findIndex( ( value ) => samePosition( value, point ) );
		return previousResolved[ previousIndex ] ?? point;
	} ) );
}

function resolvePreviewPositions(
	session: MutableDrawingSession,
	preview: DraftPreviewGeometry,
): readonly Position3D[] | undefined {
	if ( preview.generated ) return undefined;
	const resolved: Position3D[] = [];
	for ( const position of preview.positions ) {
		if ( session.draft.previewPoint !== undefined
			&& session.resolvedPreviewPoint !== undefined
			&& samePosition( position, session.draft.previewPoint ) ) {
			resolved.push( session.resolvedPreviewPoint );
			continue;
		}
		const index = session.draft.points.findIndex( ( point ) => samePosition( point, position ) );
		if ( index < 0 || session.resolvedPoints[ index ] === undefined ) return undefined;
		resolved.push( session.resolvedPoints[ index ] );
	}
	return Object.freeze( resolved );
}

function resolvedPositionFromHit( hit: PlotPickResult ): Position3D {
	const mode = getHeightMode( hit.heightReference );
	if ( mode === 'absolute' ) return hit.authorPosition;
	return Object.freeze( [
		hit.surfacePosition[ 0 ],
		hit.surfacePosition[ 1 ],
		hit.surfacePosition[ 2 ] + ( mode === 'relative' ? hit.authorPosition[ 2 ] : 0 ),
	] as Position3D );
}

function samePosition( left: Position3D, right: Position3D ): boolean {
	return Math.abs( left[ 0 ] - right[ 0 ] ) <= 1e-10
		&& Math.abs( left[ 1 ] - right[ 1 ] ) <= 1e-10
		&& Math.abs( left[ 2 ] - right[ 2 ] ) <= 1e-8;
}

function resultFromValidation( validation: DrawingValidation ): DrawingControllerResult {
	return Object.freeze( { ok: validation.valid, validation } );
}
