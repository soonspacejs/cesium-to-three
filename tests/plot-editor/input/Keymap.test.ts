import { describe, expect, it, vi } from 'vitest';

import {
	ConfigurableEditorKeymap,
	createDefaultEditorKeymap,
} from '../../../src/lib/plot-editor/input/Keymap';
import type {
	CommandContext,
	EditorCommandDefinition,
	KeyboardStateSnapshot,
} from '../../../src/lib/plot-editor/input/types';

function keyboard(
	patch: Partial<KeyboardStateSnapshot> = {},
): KeyboardStateSnapshot {
	return {
		pressedCodes: new Set(),
		pressedKeys: new Set(),
		shift: false,
		ctrl: false,
		alt: false,
		meta: false,
		primary: false,
		space: false,
		altGraph: false,
		composing: false,
		focused: true,
		...patch,
	};
}

function context(
	patch: Partial<CommandContext> = {},
): CommandContext {
	return {
		focus: 'canvas',
		mode: 'select',
		transaction: 'none',
		selectionCount: 0,
		keyboard: keyboard(),
		...patch,
	};
}

function keyEvent(
	key: string,
	code: string,
	patch: Partial<KeyboardEvent> = {},
): KeyboardEvent {
	return {
		type: 'keydown',
		key,
		code,
		repeat: false,
		...patch,
	} as KeyboardEvent;
}

describe( '默认 EditorKeymap', () => {
	it.each( [
		[ 'Escape', 'Escape', {}, {}, 'interaction.cancel' ],
		[ 'z', 'KeyZ', { primary: true, ctrl: true }, {}, 'history.undo' ],
		[ 'Z', 'KeyZ', { primary: true, ctrl: true, shift: true }, {}, 'history.redo' ],
		[ 'y', 'KeyY', { primary: true, ctrl: true }, {}, 'history.redo' ],
		[ 'a', 'KeyA', { primary: true, ctrl: true }, {}, 'selection.selectAll' ],
		[ 's', 'KeyS', { primary: true, meta: true }, {}, 'document.save' ],
		[ 'Delete', 'Delete', {}, { selectionCount: 1 }, 'selection.delete' ],
		[ 'g', 'KeyG', {}, { selectionCount: 1 }, 'transform.translate' ],
		[ 'ArrowLeft', 'ArrowLeft', {}, { selectionCount: 1, mode: 'transform' }, 'transform.nudgeEast' ],
	] )( '解析 %s 为 %s', ( key, code, keyboardPatch, contextPatch, commandId ) => {
		const keymap = createDefaultEditorKeymap( () => 'consumed' );
		const resolved = keymap.resolve(
			keyEvent( key as string, code as string ),
			context( {
				...( contextPatch as Partial<CommandContext> ),
				keyboard: keyboard( keyboardPatch as Partial<KeyboardStateSnapshot> ),
			} ),
		);
		expect( resolved?.id ).toBe( commandId );
	} );

	it( '相同 Escape 在 text-edit scope 优先解析 text.cancel', () => {
		const keymap = createDefaultEditorKeymap( () => 'consumed' );
		const resolved = keymap.resolve(
			keyEvent( 'Escape', 'Escape' ),
			context( { mode: 'text-edit', transaction: 'text' } ),
		);
		expect( resolved?.id ).toBe( 'text.cancel' );
	} );

	it( 'one-shot repeat 被忽略，held nudge 允许 repeat', () => {
		const keymap = createDefaultEditorKeymap( () => 'consumed' );
		expect( keymap.resolve(
			keyEvent( 'Delete', 'Delete', { repeat: true } ),
			context( { selectionCount: 1 } ),
		) ).toBeUndefined();
		expect( keymap.resolve(
			keyEvent( 'ArrowRight', 'ArrowRight', { repeat: true } ),
			context( { selectionCount: 1, mode: 'transform' } ),
		)?.id ).toBe( 'transform.nudgeEast' );
	} );

	it( 'held nudge 的 keyup 仍解析为同一 command 以结束合并事务', () => {
		const keymap = createDefaultEditorKeymap( () => 'consumed' );
		expect( keymap.resolve(
			keyEvent( 'ArrowRight', 'ArrowRight', { type: 'keyup' } ),
			context( { selectionCount: 1, mode: 'transform' } ),
		)?.id ).toBe( 'transform.nudgeEast' );
	} );

	it( 'AltGraph、无选择或错误 mode 不误触发', () => {
		const keymap = createDefaultEditorKeymap( () => 'consumed' );
		expect( keymap.resolve(
			keyEvent( 'z', 'KeyZ' ),
			context( { keyboard: keyboard( {
				primary: true, ctrl: true, alt: true, altGraph: true,
			} ) } ),
		) ).toBeUndefined();
		expect( keymap.resolve( keyEvent( 'g', 'KeyG' ), context() ) ).toBeUndefined();
		expect( keymap.resolve(
			keyEvent( 'Enter', 'Enter' ),
			context( { mode: 'select' } ),
		) ).toBeUndefined();
	} );

	it( '执行器由稳定 command id 调用而不直接写文档', () => {
		const execute = vi.fn( () => 'consumed' as const );
		const keymap = createDefaultEditorKeymap( execute );
		const command = keymap.resolve(
			keyEvent( 'Escape', 'Escape' ),
			context(),
		);
		expect( command?.execute( context() ) ).toBe( 'consumed' );
		expect( execute ).toHaveBeenCalledWith( 'interaction.cancel', expect.anything() );
	} );

	it( '默认矩阵不同 scope 的复用键位没有启动冲突', () => {
		expect( createDefaultEditorKeymap( () => 'ignored' ).validate() ).toEqual( [] );
	} );
} );

describe( '自定义键位与冲突', () => {
	const definition = (
		id: string,
		scope: string,
		key: string,
	): EditorCommandDefinition => ( {
		id,
		scope,
		bindings: [ { key } ],
		execute: () => 'consumed',
	} );

	it( '同 scope 相同 stroke 报出双方 command id', () => {
		const keymap = new ConfigurableEditorKeymap( [
			definition( 'one', 'global', 'q' ),
			definition( 'two', 'global', 'q' ),
			definition( 'three', 'text', 'q' ),
		] );
		expect( keymap.validate() ).toEqual( [ {
			commandId: 'one',
			conflictWith: 'two',
			stroke: expect.objectContaining( { key: 'q', phase: 'keydown' } ),
		} ] );
	} );

	it( 'bind 去重，unbind 可精确删除或清空', () => {
		const keymap = new ConfigurableEditorKeymap( [ definition( 'one', 'global', 'q' ) ] );
		keymap.bind( 'one', { key: 'Q' } );
		keymap.bind( 'one', { key: 'w' } );
		keymap.unbind( 'one', { key: 'q' } );
		expect( keymap.resolve( keyEvent( 'w', 'KeyW' ), context() )?.id ).toBe( 'one' );
		expect( keymap.resolve( keyEvent( 'q', 'KeyQ' ), context() ) ).toBeUndefined();
		keymap.unbind( 'one' );
		expect( keymap.resolve( keyEvent( 'w', 'KeyW' ), context() ) ).toBeUndefined();
	} );

	it( '拒绝重复 command id、空 stroke 和未知绑定目标', () => {
		expect( () => new ConfigurableEditorKeymap( [
			definition( 'same', 'global', 'q' ),
			definition( 'same', 'global', 'w' ),
		] ) ).toThrowError( /重复/ );
		expect( () => new ConfigurableEditorKeymap( [ {
			id: 'empty', bindings: [ {} ], execute: () => 'ignored',
		} ] ) ).toThrowError( /key 或 code/ );
		const keymap = new ConfigurableEditorKeymap();
		expect( () => keymap.bind( 'missing', { key: 'q' } ) ).toThrowError( /不存在/ );
	} );
} );
