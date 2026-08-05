import type {
	CommandContext,
	KeyboardCommandResult,
	NormalizedKeyboardInput,
	PointerDispatch,
} from './types';
import type {
	EditorIntent,
	EnuAxis,
	HitTarget,
	ScreenPoint,
	SelectionOperation,
} from '../state/types';

export type RouterInteraction =
	| 'idle'
	| 'drawing'
	| 'pointer-pending'
	| 'dragging-handle'
	| 'dragging-entity'
	| 'box-selecting'
	| 'transforming'
	| 'text-editing';

export interface RouterContext {
	readonly lifecycle: 'created' | 'ready' | 'disposed';
	readonly mode: 'select' | 'draw' | 'transform' | 'text-edit';
	readonly interaction: RouterInteraction;
	readonly draftPointCount: number;
	readonly draftRedoCount: number;
	readonly selectionCount: number;
	readonly selectedText: boolean;
	readonly pendingHit?: HitTarget;
	readonly transformSupportsScale: boolean;
	readonly transformAxis?: EnuAxis;
	readonly clampToSurface: boolean;
	readonly nudgeStepMeters: number;
}

export interface RoutedCommand {
	readonly result: KeyboardCommandResult;
	readonly intents: readonly EditorIntent[];
}

const POINTER_TRANSACTION_STATES = new Set<RouterInteraction>( [
	'dragging-handle',
	'dragging-entity',
	'box-selecting',
] );

/**
 * 将归一化输入转换为领域意图。路由器只判断优先级和参数，不修改文档。
 */
export class CommandRouter {
	private _context: RouterContext;

	public constructor( initialContext: RouterContext ) {
		this._context = freezeContext( initialContext );
	}

	public setContext( context: RouterContext ): void {
		this._context = freezeContext( context );
	}

	public get context(): RouterContext {
		return this._context;
	}

	public routePointer(
		dispatch: PointerDispatch,
		hit: HitTarget | null = null,
	): readonly EditorIntent[] {
		const context = this._context;
		if ( context.lifecycle !== 'ready' ) return Object.freeze( [] );
		const input = dispatch.input;
		const screen = freezeScreen( input.canvasX, input.canvasY );

		if ( input.phase === 'cancel' || input.phase === 'lost-capture' ) {
			return one( {
				type: 'cancelCurrentOperation',
				reason: input.phase === 'cancel' ? 'pointercancel' : 'lost-capture',
			} );
		}
		if ( input.phase === 'double-click' ) {
			return context.interaction === 'drawing' && dispatch.gesture === 'click'
				? one( { type: 'commitDrawing' } )
				: Object.freeze( [] );
		}
		if ( input.phase === 'move' ) {
			if ( context.interaction === 'drawing' ) {
				return one( { type: 'updateDraftPointer', screen } );
			}
			if ( POINTER_TRANSACTION_STATES.has( context.interaction ) ) {
				return one( { type: 'updatePointerTransaction', pointerId: input.pointerId, screen } );
			}
			if ( context.interaction === 'pointer-pending' ) {
				const pending = context.pendingHit;
				return dispatch.gesture === 'dragging' && pending?.kind === 'entity'
					&& pending.entityId !== undefined
					? one( {
						type: 'beginEntityDrag',
						pointerId: input.pointerId,
						entityId: pending.entityId,
						screen,
					} )
					: Object.freeze( [] );
			}
			return dispatch.owner === 'editor'
				? Object.freeze( [] )
				: one( { type: 'hoverAt', screen } );
		}
		if ( input.phase === 'down' ) {
			return this._routePointerDown( dispatch, hit, screen );
		}
		if ( input.phase === 'up' ) {
			return this._routePointerUp( dispatch, hit, screen );
		}
		return Object.freeze( [] );
	}

	/** 将 keymap 解析出的稳定 command ID 转为一个 reducer intent。 */
	public routeCommand(
		commandId: string,
		input: Pick<NormalizedKeyboardInput, 'phase' | 'code' | 'modifiers'>,
	): RoutedCommand {
		const context = this._context;
		if ( context.lifecycle !== 'ready' ) return blocked();
		const intent = this._intentForCommand( commandId, input );
		return intent === null ? blocked() : consumed( intent );
	}

	/** 供 createDefaultEditorKeymap 使用；事件详情由 KeyboardInput 的订阅再补充。 */
	public canExecuteCommand( commandId: string, context: CommandContext ): KeyboardCommandResult {
		if ( this._context.lifecycle !== 'ready' || context.focus === 'outside'
			|| context.focus === 'native-editable' ) {
			return 'ignored';
		}
		return this._commandAllowed( commandId ) ? 'consumed' : 'blocked';
	}

	private _routePointerDown(
		dispatch: PointerDispatch,
		hit: HitTarget | null,
		screen: ScreenPoint,
	): readonly EditorIntent[] {
		const { input } = dispatch;
		if ( dispatch.owner !== 'editor' || input.button !== 'primary' ) {
			return Object.freeze( [] );
		}
		if ( this._context.interaction === 'drawing' ) {
			return this._context.draftPointCount === 0
				? one( { type: 'beginDrawingAt', screen } )
				: Object.freeze( [] );
		}
		if ( hit?.kind === 'vertex' || hit?.kind === 'midpoint' || hit?.kind === 'gizmo' ) {
			return hit.entityId !== undefined && hit.handleId !== undefined
				? one( {
					type: 'beginHandleDrag',
					pointerId: input.pointerId,
					entityId: hit.entityId,
					handleId: hit.handleId,
					screen,
				} )
				: Object.freeze( [] );
		}
		if ( hit?.kind === 'entity' && hit.entityId !== undefined ) {
			return one( {
				type: 'beginPointerPending',
				pointerId: input.pointerId,
				hit,
				screen,
				operation: selectionOperation( input.modifiers.primary, input.modifiers.shift ),
			} );
		}
		if ( input.modifiers.primary ) {
			return one( {
				type: 'beginBoxSelection',
				pointerId: input.pointerId,
				screen,
				additive: input.modifiers.shift,
			} );
		}
		return Object.freeze( [] );
	}

	private _routePointerUp(
		dispatch: PointerDispatch,
		hit: HitTarget | null,
		screen: ScreenPoint,
	): readonly EditorIntent[] {
		const { input } = dispatch;
		if ( POINTER_TRANSACTION_STATES.has( this._context.interaction ) ) {
			return dispatch.owner === 'editor'
				? one( { type: 'finishPointerTransaction', pointerId: input.pointerId, screen } )
				: Object.freeze( [] );
		}
		if ( dispatch.gesture !== 'click' ) return Object.freeze( [] );
		if ( this._context.interaction === 'pointer-pending' ) {
			return one( {
				type: 'selectAt',
				screen,
				hit: this._context.pendingHit ?? hit,
				operation: selectionOperation( input.modifiers.primary, input.modifiers.shift ),
			} );
		}
		if ( this._context.interaction === 'drawing' ) {
			if ( input.button === 'secondary' ) return one( { type: 'commitDrawing' } );
			if ( input.button === 'primary' && dispatch.owner === 'editor' ) {
				return one( { type: 'appendDraftPoint', screen } );
			}
			return Object.freeze( [] );
		}
		if ( input.button !== 'primary' || dispatch.owner !== 'editor' ) {
			return Object.freeze( [] );
		}
		return one( {
			type: 'selectAt',
			screen,
			hit,
			operation: selectionOperation( input.modifiers.primary, input.modifiers.shift ),
		} );
	}

	private _intentForCommand(
		commandId: string,
		input: Pick<NormalizedKeyboardInput, 'phase' | 'code' | 'modifiers'>,
	): EditorIntent | null {
		if ( ! this._commandAllowed( commandId ) ) return null;
		switch ( commandId ) {
			case 'interaction.cancel': return { type: 'cancelCurrentOperation', reason: 'escape' };
			case 'interaction.commit': return this._context.interaction === 'drawing'
				? { type: 'commitDrawing' }
				: { type: 'commitTransform' };
			case 'drawing.removeLastPoint': return { type: 'removeLastDraftPoint' };
			case 'selection.delete': return { type: 'deleteSelection' };
			case 'selection.selectAll': return { type: 'selectAll' };
			case 'history.undo': return this._context.interaction === 'drawing'
				? { type: 'undoDraft' }
				: { type: 'undo' };
			case 'history.redo': return this._context.interaction === 'drawing'
				? { type: 'redoDraft' }
				: { type: 'redo' };
			case 'document.save': return { type: 'save' };
			case 'transform.translate': return { type: 'beginTransform', mode: 'translate' };
			case 'transform.rotate': return { type: 'beginTransform', mode: 'rotate' };
			case 'transform.scale': return { type: 'beginTransform', mode: 'scale' };
			case 'transform.constrainAxis': {
				const axis = axisForCode( input.code );
				return axis === 'up' && this._context.clampToSurface
					? null
					: { type: 'constrainTransform', axis };
			}
			case 'transform.nudgeEast': return nudgeIntent(
				'east', input.code === 'ArrowLeft' ? -1 : 1, input, this._context.nudgeStepMeters,
			);
			case 'transform.nudgeNorth': return nudgeIntent(
				'north', input.code === 'ArrowDown' ? -1 : 1, input, this._context.nudgeStepMeters,
			);
			case 'transform.nudgeUp': return nudgeIntent(
				'up', input.code === 'PageDown' ? -1 : 1, input, this._context.nudgeStepMeters,
			);
			case 'text.beginEdit': return { type: 'beginTextEdit' };
			case 'text.commit': return { type: 'commitTextEdit' };
			case 'text.cancel': return { type: 'cancelTextEdit' };
			default: return null;
		}
	}

	private _commandAllowed( commandId: string ): boolean {
		const context = this._context;
		switch ( commandId ) {
			case 'interaction.cancel': return true;
			case 'interaction.commit': return context.interaction === 'drawing'
				|| context.interaction === 'transforming';
			case 'drawing.removeLastPoint': return context.interaction === 'drawing'
				&& context.draftPointCount > 0;
			case 'selection.delete': return context.selectionCount > 0
				&& context.interaction !== 'drawing';
			case 'history.undo': return context.interaction === 'drawing'
				? context.draftPointCount > 0
				: ! hasActiveTransaction( context.interaction );
			case 'history.redo': return context.interaction === 'drawing'
				? context.draftRedoCount > 0
				: ! hasActiveTransaction( context.interaction );
			case 'selection.selectAll': return context.mode === 'select';
			case 'document.save': return true;
			case 'transform.translate':
			case 'transform.rotate': return context.selectionCount > 0
				&& ( context.mode === 'select' || context.mode === 'transform' );
			case 'transform.scale': return context.selectionCount > 0
				&& context.transformSupportsScale
				&& ( context.mode === 'select' || context.mode === 'transform' );
			case 'transform.constrainAxis': return context.interaction === 'transforming';
			case 'transform.nudgeEast':
			case 'transform.nudgeNorth': return context.interaction === 'transforming';
			case 'transform.nudgeUp': return context.interaction === 'transforming'
				&& ! context.clampToSurface;
			case 'text.beginEdit': return context.selectionCount === 1 && context.selectedText;
			case 'text.commit':
			case 'text.cancel': return context.interaction === 'text-editing';
			default: return false;
		}
	}
}

function selectionOperation( primary: boolean, shift: boolean ): SelectionOperation {
	if ( primary ) return 'toggle';
	return shift ? 'add' : 'replace';
}

function axisForCode( code: string ): EnuAxis {
	if ( code === 'KeyX' ) return 'east';
	if ( code === 'KeyY' ) return 'north';
	return 'up';
}

function nudgeIntent(
	axis: EnuAxis,
	sign: number,
	input: Pick<NormalizedKeyboardInput, 'phase' | 'modifiers'>,
	baseStep: number,
): EditorIntent {
	const multiplier = ( input.modifiers.shift ? 10 : 1 )
		* ( input.modifiers.alt ? 0.1 : 1 );
	return {
		type: 'nudgeSelection',
		axis,
		amountMeters: sign * baseStep * multiplier,
		phase: input.phase,
	};
}

function hasActiveTransaction( interaction: RouterInteraction ): boolean {
	return interaction === 'drawing'
		|| interaction === 'dragging-handle'
		|| interaction === 'dragging-entity'
		|| interaction === 'transforming'
		|| interaction === 'text-editing';
}

function freezeContext( context: RouterContext ): RouterContext {
	if ( ! Number.isFinite( context.nudgeStepMeters ) || context.nudgeStepMeters <= 0 ) {
		throw new RangeError( 'nudgeStepMeters 必须是正有限数。' );
	}
	return Object.freeze( {
		...context,
		...( context.pendingHit === undefined
			? {}
			: { pendingHit: Object.freeze( { ...context.pendingHit } ) } ),
	} );
}

function freezeScreen( x: number, y: number ): ScreenPoint {
	return Object.freeze( { x, y } );
}

function one( intent: EditorIntent ): readonly EditorIntent[] {
	return Object.freeze( [ Object.freeze( intent ) ] );
}

function consumed( intent: EditorIntent ): RoutedCommand {
	return Object.freeze( { result: 'consumed', intents: one( intent ) } );
}

function blocked(): RoutedCommand {
	return Object.freeze( { result: 'blocked', intents: Object.freeze( [] ) } );
}
