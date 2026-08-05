import {
	geodesicDistanceMeters,
	initialGeodesicBearingDegrees,
} from '../../document/geodesy';
import type {
	Position3D,
	TextFeature,
	TextHorizontalAlign,
	TextLayoutDirection,
	TextVerticalAlign,
} from '../../document/types';
import type {
	DrawToolContext,
	DrawingDraft,
	DrawingValidation,
	DraftPreviewGeometry,
	EditHandle,
	FinishFeatureOptions,
	GeometryAdapter,
	HandleMovement,
} from '../types';
import {
	canonicalFeature,
	cloneJson,
	commonFeatureFields,
	drawingValidationFromError,
	freezeDraft,
	invalidDrawing,
	mergeStyle,
	normalizeAuthorPosition,
} from './shared';

interface TextParameters {
	readonly content: string;
	readonly fontColor: string;
	readonly fontSize: number;
	readonly scale: number;
	readonly textAlign: TextHorizontalAlign;
	readonly verticalAlign: TextVerticalAlign;
	readonly anchorX: TextHorizontalAlign;
	readonly anchorY: TextVerticalAlign;
	readonly boxWidth?: number;
	readonly boxHeight?: number;
	readonly padding: number | readonly [ number, number, number, number ];
	readonly layoutDirection: TextLayoutDirection;
	readonly rotation: number;
	readonly offsetX: number;
	readonly offsetY: number;
	readonly showBorder: boolean;
}

export type TextDrawingDraft = DrawingDraft<TextParameters> & { readonly type: 'text' };

export class TextGeometryAdapter implements GeometryAdapter<TextDrawingDraft, TextFeature> {
	public readonly kind = 'text' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: false,
		insertVertices: false,
		removeVertices: false,
		translate: true,
		rotateHeading: true,
		rotatePitchRoll: false,
		scaleHorizontal: true,
		scaleVertical: false,
		parameterHandles: Object.freeze( [ 'text-anchor', 'width', 'height', 'rotation' ] as const ),
	} );

	public begin( context: DrawToolContext<Partial<TextParameters>> ): TextDrawingDraft {
		const options = context.options ?? {};
		const parameters: TextParameters = {
			content: options.content ?? '',
			fontColor: options.fontColor ?? '#ffffff',
			fontSize: options.fontSize ?? 24,
			scale: options.scale ?? 1,
			textAlign: options.textAlign ?? 'left',
			verticalAlign: options.verticalAlign ?? 'middle',
			anchorX: options.anchorX ?? 'center',
			anchorY: options.anchorY ?? 'middle',
			...( options.boxWidth === undefined ? {} : { boxWidth: options.boxWidth } ),
			...( options.boxHeight === undefined ? {} : { boxHeight: options.boxHeight } ),
			padding: options.padding ?? 4,
			layoutDirection: options.layoutDirection ?? 'horizontal',
			rotation: options.rotation ?? 0,
			offsetX: options.offsetX ?? 0,
			offsetY: options.offsetY ?? 0,
			showBorder: options.showBorder ?? false,
		};
		return this._withValidation( freezeDraft( {
			type: 'text' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( parameters ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TEXT_INPUT_REQUIRED', '文本需要 anchor 和非空内容。' ),
		} ) );
	}

	public addPoint( draft: TextDrawingDraft, point: Position3D ): TextDrawingDraft {
		const next = freezeDraft( {
			...draft,
			points: Object.freeze( [ normalizeAuthorPosition( point, draft.heightReference ) ] ),
			previewPoint: undefined,
		} );
		return this._withValidation( {
			...next, phase: this.validateDraft( next ).valid ? 'ready' : 'drawing',
		} );
	}

	/** native textarea/IME 提交到 adapter 的唯一文字更新入口。 */
	public setText( draft: TextDrawingDraft, content: string ): TextDrawingDraft {
		if ( typeof content !== 'string' ) throw new TypeError( '文本内容必须是 string。' );
		const next = freezeDraft( {
			...draft,
			parameters: Object.freeze( { ...draft.parameters, content } ),
		} );
		return this._withValidation( {
			...next,
			phase: this.validateDraft( next ).valid ? 'ready' : next.points.length > 0 ? 'drawing' : 'armed',
		} );
	}

	public movePointer( draft: TextDrawingDraft, point: Position3D ): TextDrawingDraft {
		return freezeDraft( {
			...draft, previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: TextDrawingDraft ): TextDrawingDraft { return draft; }

	public validateDraft( draft: TextDrawingDraft ): DrawingValidation {
		if ( draft.points.length !== 1 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '文本必须且只能有一个 GIS anchor。' );
		}
		if ( draft.parameters.content.trim().length === 0 ) {
			return invalidDrawing( 'DRAW_TEXT_INPUT_REQUIRED', '文本内容不能为空。' );
		}
		try {
			canonicalFeature<TextFeature>( this._featureInput( draft, '__draft_text__', 0 ) );
			return Object.freeze( { valid: true } );
		} catch ( error ) {
			return drawingValidationFromError( error );
		}
	}

	public canFinish( draft: TextDrawingDraft ): boolean { return this.validateDraft( draft ).valid; }

	public finish( draft: TextDrawingDraft, options: FinishFeatureOptions ): TextFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		return canonicalFeature<TextFeature>( {
			...this._featureInput( draft, options.id, options.revision ?? 0 ),
			visible: options.visible ?? true,
			properties: options.properties ?? {},
		} );
	}

	public cancel(): void {}

	public preview( draft: TextDrawingDraft ): DraftPreviewGeometry {
		const position = draft.points[ 0 ] ?? draft.previewPoint;
		return Object.freeze( {
			primitive: 'text',
			positions: Object.freeze( position === undefined ? [] : [ position ] ),
			closed: false, sourceType: 'text', generated: false,
			text: draft.parameters.content,
		} );
	}

	public listHandles( feature: TextFeature ): readonly EditHandle[] {
		const anchor = feature.geometry.position;
		const handles: EditHandle[] = [ {
			id: 'center', entityId: feature.id, kind: 'text-anchor',
			position: anchor, priority: 100,
		} ];
		if ( feature.style.boxWidth !== undefined ) {
			handles.push( {
				id: 'width', entityId: feature.id, kind: 'width', position: anchor,
				screenOffsetCssPixels: Object.freeze( [ feature.style.boxWidth / 2, 0 ] ),
				priority: 90,
			} );
		}
		if ( feature.style.boxHeight !== undefined ) {
			handles.push( {
				id: 'height', entityId: feature.id, kind: 'height', position: anchor,
				screenOffsetCssPixels: Object.freeze( [ 0, feature.style.boxHeight / 2 ] ),
				priority: 90,
			} );
		}
		const rotationOffset = Math.max( 24, feature.style.boxHeight ?? feature.style.fontSize * 2 );
		handles.push( {
			id: 'rotation', entityId: feature.id, kind: 'rotation', position: anchor,
			screenOffsetCssPixels: Object.freeze( [ 0, -rotationOffset ] ),
			priority: 80,
		} );
		return Object.freeze( handles.map( ( handle ) => Object.freeze( handle ) ) );
	}

	public applyHandle(
		feature: TextFeature,
		handleId: string,
		movement: HandleMovement,
	): TextFeature {
		if ( handleId === 'center' ) {
			return canonicalFeature<TextFeature>( {
				...feature,
				geometry: {
					position: normalizeAuthorPosition( movement.authorPosition, feature.heightReference ),
				},
				revision: feature.revision + 1,
			} );
		}
		let style = feature.style;
		if ( handleId === 'width' ) {
			if ( feature.style.boxWidth === undefined ) {
				throw new Error( 'EDIT_HANDLE_NOT_FOUND：自适应文本没有 width handle。' );
			}
			style = {
				...style,
				boxWidth: screenParameter( feature.style.boxWidth, movement, 0 ),
			};
		} else if ( handleId === 'height' ) {
			if ( feature.style.boxHeight === undefined ) {
				throw new Error( 'EDIT_HANDLE_NOT_FOUND：自适应文本没有 height handle。' );
			}
			style = {
				...style,
				boxHeight: screenParameter( feature.style.boxHeight, movement, 1 ),
			};
		} else if ( handleId === 'rotation' ) {
			if ( geodesicDistanceMeters( feature.geometry.position, movement.authorPosition ) <= 1e-3 ) {
				throw new Error( 'EDIT_INVALID_ANGLE：rotation 方向点不能与 anchor 重合。' );
			}
			style = {
				...style,
				rotation: initialGeodesicBearingDegrees(
					feature.geometry.position, movement.authorPosition,
				),
			};
		} else {
			throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		}
		return canonicalFeature<TextFeature>( {
			...feature, style, revision: feature.revision + 1,
		} );
	}

	public removeVertex(): TextFeature {
		throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：text 不支持删除 anchor。' );
	}

	public toRenderDescription( feature: TextFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'text', positions: Object.freeze( [ feature.geometry.position ] ),
			closed: false, sourceType: 'text', generated: false,
			text: feature.style.content,
		} );
	}

	public toJSON( feature: TextFeature ): unknown { return cloneJson( feature ); }

	private _featureInput(
		draft: TextDrawingDraft,
		id: string,
		revision: number,
	): Record<string, unknown> {
		return {
			...commonFeatureFields( draft, { id, revision } ),
			type: 'text', geometry: { position: draft.points[ 0 ] },
			style: mergeStyle( draft.style, draft.parameters ),
		};
	}

	private _withValidation( draft: TextDrawingDraft ): TextDrawingDraft {
		return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
	}
}

function screenParameter(
	current: number,
	movement: HandleMovement,
	axis: 0 | 1,
): number {
	const value = movement.parameterValue
		?? ( movement.screenDeltaCssPixels === undefined
			? Number.NaN
			: current + movement.screenDeltaCssPixels[ axis ] * 2 );
	if ( ! Number.isFinite( value ) || value <= 0 ) {
		throw new Error( 'EDIT_INVALID_SIZE：文本框尺寸必须为正，且需要 screen delta 或 parameterValue。' );
	}
	return value;
}
