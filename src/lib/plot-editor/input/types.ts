import type { HeightReference } from '../document/types';

export type PointerDevice = 'mouse' | 'pen' | 'touch';
export type PointerButton = 'primary' | 'auxiliary' | 'secondary' | 'eraser';
export type PointerPhase = 'down' | 'move' | 'up' | 'cancel' | 'lost-capture';
export type PointerOwner = 'editor' | 'navigation' | 'native-ui';

export interface ModifierState {
	readonly shift: boolean;
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
	readonly primary: boolean;
	readonly altGraph: boolean;
	readonly space: boolean;
}

export interface NormalizedPointerInput {
	readonly phase: PointerPhase;
	readonly pointerId: number;
	readonly device: PointerDevice;
	readonly button: PointerButton | null;
	readonly buttons: number;
	readonly canvasX: number;
	readonly canvasY: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly movementX: number;
	readonly movementY: number;
	readonly pressure: number;
	readonly tiltX: number;
	readonly tiltY: number;
	readonly modifiers: ModifierState;
	readonly timeStamp: number;
	readonly originalEvent: PointerEvent;
}

export interface PointerClaim {
	readonly owner: PointerOwner;
	readonly reason:
		| 'draw'
		| 'handle'
		| 'entity'
		| 'box-select'
		| 'camera-override'
		| 'empty-surface'
		| 'native-ui';
	readonly capture: boolean;
	readonly preventDefault: boolean;
}

export type NavigationLeaseKind =
	| 'draw'
	| 'handle-drag'
	| 'entity-drag'
	| 'box-select'
	| 'gizmo';

export interface NavigationLease {
	readonly id: string;
	readonly released: boolean;
	release(): void;
}

export interface NavigationAdapter {
	readonly enabled: boolean;
	acquire( reason: {
		readonly owner: 'plot-editor';
		readonly kind: NavigationLeaseKind;
		readonly pointerId?: number;
	} ): NavigationLease;
	dispose(): void;
}

export type KeyPhase = 'keydown' | 'keyup';
export type RepeatPolicy = 'never' | 'repeat' | 'held';
export type KeyboardCommandResult = 'consumed' | 'blocked' | 'ignored';
export type FocusDomain = 'canvas' | 'editor-ui' | 'native-editable' | 'outside';

export interface KeyboardStateSnapshot {
	readonly pressedCodes: ReadonlySet<string>;
	readonly pressedKeys: ReadonlySet<string>;
	readonly shift: boolean;
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
	readonly primary: boolean;
	readonly space: boolean;
	readonly altGraph: boolean;
	readonly composing: boolean;
	readonly focused: boolean;
}

export interface KeyStroke {
	readonly key?: string;
	readonly code?: string;
	readonly primary?: boolean;
	readonly shift?: boolean;
	readonly ctrl?: boolean;
	readonly alt?: boolean;
	readonly meta?: boolean;
	readonly phase?: KeyPhase;
}

export interface CommandContext {
	readonly focus: FocusDomain;
	readonly mode: 'select' | 'draw' | 'transform' | 'text-edit';
	readonly transaction: 'none' | 'draft' | 'pointer-drag' | 'keyboard-nudge' | 'text';
	readonly selectionCount: number;
	readonly primarySelectionId?: string;
	readonly activeHandleId?: string;
	readonly heightReference?: HeightReference;
	readonly keyboard: KeyboardStateSnapshot;
}

export interface EditorCommandDefinition {
	readonly id: string;
	/** 相同 scope 内的相同 stroke 才构成启动冲突。 */
	readonly scope?: string;
	readonly bindings: readonly KeyStroke[];
	readonly repeat?: RepeatPolicy;
	readonly priority?: number;
	readonly when?: ( context: CommandContext ) => boolean;
	execute( context: CommandContext ): KeyboardCommandResult;
}

export interface KeymapConflict {
	readonly commandId: string;
	readonly conflictWith: string;
	readonly stroke: KeyStroke;
}

export interface EditorKeymap {
	bind( commandId: string, stroke: KeyStroke ): void;
	unbind( commandId: string, stroke?: KeyStroke ): void;
	resolve(
		event: KeyboardEvent,
		context: CommandContext,
	): EditorCommandDefinition | undefined;
	validate(): readonly KeymapConflict[];
}

export interface NormalizedKeyboardInput {
	readonly phase: KeyPhase;
	readonly key: string;
	readonly code: string;
	readonly repeat: boolean;
	readonly focus: FocusDomain;
	readonly modifiers: ModifierState;
	readonly state: KeyboardStateSnapshot;
	readonly commandId?: string;
	readonly commandResult?: KeyboardCommandResult;
	readonly originalEvent: KeyboardEvent;
}

export interface KeyboardInputOptions {
	readonly root: HTMLElement;
	readonly keymap: EditorKeymap;
	readonly platform?: 'auto' | 'windows-linux' | 'macos';
	readonly getCommandContext: (
		keyboard: KeyboardStateSnapshot,
		focus: FocusDomain,
	) => CommandContext;
	readonly onCommandError?: ( error: unknown, commandId: string ) => void;
	readonly onCancelHeld?: ( reason: 'blur' | 'hidden' | 'pagehide' | 'detach' ) => void;
}
