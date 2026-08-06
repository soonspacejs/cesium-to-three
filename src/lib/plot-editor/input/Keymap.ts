import type {
	CommandContext,
	EditorCommandDefinition,
	EditorKeymap,
	EditorKeymapOverrides,
	KeyboardCommandResult,
	KeymapConflict,
	KeyStroke,
} from './types';

interface MutableCommandDefinition {
	readonly definition: EditorCommandDefinition;
	readonly bindings: KeyStroke[];
}

/** 可重绑定并能在启动时检测同 scope 冲突的键位表。 */
export class ConfigurableEditorKeymap implements EditorKeymap {
	private readonly _commands = new Map<string, MutableCommandDefinition>();

	public constructor( commands: readonly EditorCommandDefinition[] = [] ) {
		for ( const command of commands ) {
			this.register( command );
		}
	}

	public register( command: EditorCommandDefinition ): void {
		if ( this._commands.has( command.id ) ) {
			throw new Error( `command id 重复：${ command.id }。` );
		}
		this._commands.set( command.id, {
			definition: command,
			bindings: command.bindings.map( normalizeStroke ),
		} );
	}

	public bind( commandId: string, stroke: KeyStroke ): void {
		const command = this._requireCommand( commandId );
		const normalized = normalizeStroke( stroke );
		if ( ! command.bindings.some( ( item ) => strokesEqual( item, normalized ) ) ) {
			command.bindings.push( normalized );
		}
	}

	public unbind( commandId: string, stroke?: KeyStroke ): void {
		const command = this._requireCommand( commandId );
		if ( stroke === undefined ) {
			command.bindings.length = 0;
			return;
		}
		const normalized = normalizeStroke( stroke );
		for ( let index = command.bindings.length - 1; index >= 0; index-- ) {
			if ( strokesEqual( command.bindings[ index ], normalized ) ) {
				command.bindings.splice( index, 1 );
			}
		}
	}

	public resolve(
		event: KeyboardEvent,
		context: CommandContext,
	): EditorCommandDefinition | undefined {
		if ( context.keyboard.altGraph ) {
			return undefined;
		}
		const matches = [ ...this._commands.values() ].filter( ( command ) => {
			const repeatPolicy = command.definition.repeat ?? 'never';
			if ( event.repeat && repeatPolicy === 'never' ) {
				return false;
			}
			if ( command.definition.when !== undefined
				&& ! command.definition.when( context ) ) {
				return false;
			}
			return command.bindings.some( ( stroke ) => {
				// held 命令必须收到对应 keyup，状态机才能在最后一键释放时合并提交。
				const effectiveStroke = event.type === 'keyup'
					&& repeatPolicy === 'held'
					&& ( stroke.phase ?? 'keydown' ) === 'keydown'
					? { ...stroke, phase: 'keyup' as const }
					: stroke;
				return matchesStroke( event, context, effectiveStroke );
			} );
		} );
		matches.sort( ( left, right ) =>
			( right.definition.priority ?? 0 ) - ( left.definition.priority ?? 0 ),
		);
		return matches[ 0 ]?.definition;
	}

	public validate(): readonly KeymapConflict[] {
		const conflicts: KeymapConflict[] = [];
		const commands = [ ...this._commands.values() ];
		for ( let left = 0; left < commands.length; left++ ) {
			for ( let right = left + 1; right < commands.length; right++ ) {
				const first = commands[ left ];
				const second = commands[ right ];
				if ( ( first.definition.scope ?? 'global' )
					!== ( second.definition.scope ?? 'global' ) ) {
					continue;
				}
				for ( const stroke of first.bindings ) {
					if ( second.bindings.some( ( item ) => strokesEqual( stroke, item ) ) ) {
						conflicts.push( Object.freeze( {
							commandId: first.definition.id,
							conflictWith: second.definition.id,
							stroke: Object.freeze( { ...stroke } ),
						} ) );
					}
				}
			}
		}
		return Object.freeze( conflicts );
	}

	private _requireCommand( id: string ): MutableCommandDefinition {
		const command = this._commands.get( id );
		if ( command === undefined ) {
			throw new Error( `command 不存在：${ id }。` );
		}
		return command;
	}
}

export type DefaultKeymapExecutor = (
	commandId: string,
	context: CommandContext,
) => KeyboardCommandResult;

/** 创建完整默认表，或在默认表上应用宿主提供的部分覆盖。 */
export function createEditorKeymap(
	execute: DefaultKeymapExecutor,
	configuration?: EditorKeymap | EditorKeymapOverrides,
): EditorKeymap {
	if ( configuration !== undefined && isEditorKeymap( configuration ) ) return configuration;
	const keymap = createDefaultEditorKeymap( execute );
	if ( configuration === undefined ) return keymap;
	for ( const [ commandId, bindings ] of Object.entries( configuration ) ) {
		keymap.unbind( commandId );
		if ( bindings !== null && bindings !== undefined ) {
			for ( const stroke of bindings ) keymap.bind( commandId, stroke );
		}
	}
	return keymap;
}

/** 创建设计文档锁定的 v1 默认键位矩阵。 */
export function createDefaultEditorKeymap(
	execute: DefaultKeymapExecutor,
): ConfigurableEditorKeymap {
	const command = (
		id: string,
		scope: string,
		bindings: readonly KeyStroke[],
		when?: ( context: CommandContext ) => boolean,
		repeat: 'never' | 'repeat' | 'held' = 'never',
		priority = 0,
	): EditorCommandDefinition => ( {
		id,
		scope,
		bindings,
		when,
		repeat,
		priority,
		execute: ( context ) => execute( id, context ),
	} );
	const hasSelection = ( context: CommandContext ) => context.selectionCount > 0;
	const isDrawing = ( context: CommandContext ) => context.mode === 'draw';
	const isTransforming = ( context: CommandContext ) => context.mode === 'transform';
	const selectedOrTransform = ( context: CommandContext ) =>
		hasSelection( context ) && ( context.mode === 'select' || context.mode === 'transform' );

	return new ConfigurableEditorKeymap( [
		command( 'interaction.cancel', 'global', [ { key: 'Escape' } ], undefined, 'never', 100 ),
		command( 'interaction.commit', 'interaction', [ { key: 'Enter' } ],
			( context ) => isDrawing( context ) || isTransforming( context ), 'never', 90 ),
		command( 'drawing.removeLastPoint', 'drawing', [ { key: 'Backspace' } ], isDrawing, 'never', 90 ),
		command( 'selection.delete', 'selection', [ { key: 'Delete' } ], hasSelection, 'never', 50 ),
		command( 'history.undo', 'global', [ { key: 'z', primary: true } ], undefined, 'never', 20 ),
		command( 'history.redo', 'global', [
			{ key: 'z', primary: true, shift: true },
			{ key: 'y', primary: true },
		], undefined, 'never', 21 ),
		command( 'selection.selectAll', 'global', [ { key: 'a', primary: true } ] ),
		command( 'document.save', 'global', [ { key: 's', primary: true } ] ),
		command( 'transform.translate', 'selection', [ { code: 'KeyG' } ], selectedOrTransform ),
		command( 'transform.rotate', 'selection', [ { code: 'KeyR' } ], selectedOrTransform ),
		command( 'transform.scale', 'selection', [ { code: 'KeyS' } ], selectedOrTransform ),
		command( 'transform.constrainAxis', 'transform', [
			{ code: 'KeyX' }, { code: 'KeyY' }, { code: 'KeyZ' },
		], isTransforming ),
		command( 'transform.nudgeEast', 'transform', [
			{ code: 'ArrowLeft' }, { code: 'ArrowRight' },
		], isTransforming, 'held' ),
		command( 'transform.nudgeNorth', 'transform', [
			{ code: 'ArrowDown' }, { code: 'ArrowUp' },
		], isTransforming, 'held' ),
		command( 'transform.nudgeUp', 'transform', [
			{ code: 'PageDown' }, { code: 'PageUp' },
		], isTransforming, 'held' ),
		command( 'text.beginEdit', 'selection', [ { key: 'F2' } ], hasSelection ),
		command( 'text.commit', 'text-edit', [ { key: 'Enter', primary: true } ],
			( context ) => context.mode === 'text-edit', 'never', 95 ),
		command( 'text.cancel', 'text-edit', [ { key: 'Escape' } ],
			( context ) => context.mode === 'text-edit', 'never', 110 ),
	] );
}

function isEditorKeymap( value: EditorKeymap | EditorKeymapOverrides ): value is EditorKeymap {
	return typeof ( value as EditorKeymap ).bind === 'function'
		&& typeof ( value as EditorKeymap ).unbind === 'function'
		&& typeof ( value as EditorKeymap ).resolve === 'function'
		&& typeof ( value as EditorKeymap ).validate === 'function';
}

function matchesStroke(
	event: KeyboardEvent,
	context: CommandContext,
	stroke: KeyStroke,
): boolean {
	const phase = event.type === 'keyup' ? 'keyup' : 'keydown';
	if ( ( stroke.phase ?? 'keydown' ) !== phase ) return false;
	if ( stroke.key !== undefined && normalizeKey( event.key ) !== stroke.key ) return false;
	if ( stroke.code !== undefined && event.code !== stroke.code ) return false;
	if ( context.keyboard.shift !== ( stroke.shift ?? false ) ) return false;
	if ( context.keyboard.alt !== ( stroke.alt ?? false ) ) return false;
	if ( context.keyboard.primary !== ( stroke.primary ?? false ) ) return false;
	if ( stroke.primary !== true ) {
		if ( context.keyboard.ctrl !== ( stroke.ctrl ?? false ) ) return false;
		if ( context.keyboard.meta !== ( stroke.meta ?? false ) ) return false;
	} else {
		if ( stroke.ctrl !== undefined && context.keyboard.ctrl !== stroke.ctrl ) return false;
		if ( stroke.meta !== undefined && context.keyboard.meta !== stroke.meta ) return false;
	}
	return true;
}

function normalizeStroke( stroke: KeyStroke ): KeyStroke {
	if ( stroke.key === undefined && stroke.code === undefined ) {
		throw new TypeError( 'KeyStroke 必须提供 key 或 code。' );
	}
	return Object.freeze( {
		...stroke,
		...( stroke.key === undefined ? {} : { key: normalizeKey( stroke.key ) } ),
		phase: stroke.phase ?? 'keydown',
	} );
}

function normalizeKey( key: string ): string {
	return key.length === 1 ? key.toLocaleLowerCase( 'en-US' ) : key;
}

function strokesEqual( left: KeyStroke, right: KeyStroke ): boolean {
	return left.key === right.key
		&& left.code === right.code
		&& ( left.primary ?? false ) === ( right.primary ?? false )
		&& ( left.shift ?? false ) === ( right.shift ?? false )
		&& ( left.ctrl ?? false ) === ( right.ctrl ?? false )
		&& ( left.alt ?? false ) === ( right.alt ?? false )
		&& ( left.meta ?? false ) === ( right.meta ?? false )
		&& ( left.phase ?? 'keydown' ) === ( right.phase ?? 'keydown' );
}
