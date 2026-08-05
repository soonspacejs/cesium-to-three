import type { FocusDomain } from './types';

/** 不依赖全局 HTMLElement，可在 iframe、测试替身和跨 realm DOM 中工作。 */
export function isNativeEditableTarget( target: EventTarget | null ): boolean {
	if ( target === null || typeof target !== 'object' ) {
		return false;
	}
	const candidate = target as {
		isContentEditable?: unknown;
		tagName?: unknown;
		getAttribute?: ( name: string ) => string | null;
	};
	if ( candidate.isContentEditable === true ) {
		return true;
	}
	const tagName = typeof candidate.tagName === 'string'
		? candidate.tagName.toLowerCase()
		: '';
	if ( tagName === 'input' || tagName === 'textarea' || tagName === 'select' ) {
		return true;
	}
	return candidate.getAttribute?.( 'contenteditable' )?.toLowerCase() === 'true';
}

export function resolveFocusDomain(
	root: HTMLElement,
	target: EventTarget | null,
	explicitlyFocused: boolean,
	pointerCaptureActive: boolean,
): FocusDomain {
	if ( isNativeEditableTarget( target ) ) {
		return 'native-editable';
	}
	const activeElement = root.ownerDocument.activeElement;
	if ( activeElement === root ) {
		return 'canvas';
	}
	if ( activeElement !== null && root.contains( activeElement ) ) {
		return isNativeEditableTarget( activeElement )
			? 'native-editable'
			: 'editor-ui';
	}
	return explicitlyFocused || pointerCaptureActive ? 'canvas' : 'outside';
}
