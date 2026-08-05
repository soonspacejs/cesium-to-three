import { geodesicDistanceMeters } from '../../document/geodesy';
import type { PointFeature, PointStyle } from '../../document/types';
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
	headingDegreesFrom,
	invalidDrawing,
	mergeStyle,
	normalizeAuthorPosition,
	positionAtEnuOffset,
	validDrawing,
} from './shared';

interface PointParameters {
	readonly pointStyle: 'circle' | 'square' | 'image';
	readonly size?: number;
	readonly imageUrl?: string;
	readonly imageWidth?: number;
	readonly imageHeight?: number;
	readonly rotation?: number;
}

export type PointDrawingDraft = DrawingDraft<PointParameters> & { readonly type: 'point' };

export class PointGeometryAdapter implements GeometryAdapter<PointDrawingDraft, PointFeature> {
	public readonly kind = 'point' as const;
	public readonly capabilities = Object.freeze( {
		editable: true as const,
		editVertices: false,
		insertVertices: false,
		removeVertices: false,
		translate: true,
		rotateHeading: true,
		scaleHorizontal: true,
		parameterHandles: Object.freeze( [ 'center', 'size', 'width', 'height', 'rotation' ] as const ),
	} );

	public begin( context: DrawToolContext<PointParameters> ): PointDrawingDraft {
		const options = context.options ?? { pointStyle: 'circle', size: 16 };
		const draft = {
			type: 'point' as const,
			heightReference: context.heightReference,
			phase: 'armed' as const,
			points: Object.freeze( [] ),
			parameters: Object.freeze( { ...options } ),
			style: Object.freeze( { ...( context.style ?? {} ) } ),
			validation: invalidDrawing( 'DRAW_TOO_FEW_POINTS', '点图形需要一个 anchor。' ),
		};
		return this._revalidate( freezeDraft( draft ) );
	}

	public addPoint( draft: PointDrawingDraft, point: readonly [ number, number, number ] ): PointDrawingDraft {
		return this._revalidate( freezeDraft( {
			...draft,
			phase: 'ready',
			points: Object.freeze( [ normalizeAuthorPosition( point, draft.heightReference ) ] ),
			previewPoint: undefined,
		} ) );
	}

	public movePointer( draft: PointDrawingDraft, point: readonly [ number, number, number ] ): PointDrawingDraft {
		return freezeDraft( {
			...draft,
			previewPoint: normalizeAuthorPosition( point, draft.heightReference ),
		} );
	}

	public removeLastPoint( draft: PointDrawingDraft ): PointDrawingDraft {
		// point 的一个 anchor 就是拓扑下限；Backspace 不把 ready 草稿降成空图形。
		return draft;
	}

	public validateDraft( draft: PointDrawingDraft ): DrawingValidation {
		if ( draft.points.length !== 1 ) {
			return invalidDrawing( 'DRAW_TOO_FEW_POINTS', '点图形必须且只能有一个 anchor。' );
		}
		const parameters = draft.parameters;
		if ( parameters.pointStyle !== 'circle'
			&& parameters.pointStyle !== 'square'
			&& parameters.pointStyle !== 'image' ) {
			return invalidDrawing( 'DRAW_INVALID_PARAMETER', 'pointStyle 必须是 circle、square 或 image。' );
		}
		if ( parameters.pointStyle === 'image' ) {
			if ( typeof parameters.imageUrl !== 'string' || parameters.imageUrl.trim().length === 0
				|| ! positive( parameters.imageWidth ) || ! positive( parameters.imageHeight )
				|| ! finite( parameters.rotation ?? 0 ) ) {
				return invalidDrawing( 'DRAW_INVALID_PARAMETER', '图片点需要 URL、正宽高和有限旋转角。' );
			}
		} else if ( ! positive( parameters.size ) ) {
			return invalidDrawing( 'DRAW_INVALID_PARAMETER', '点尺寸必须为正有限数。' );
		}
		return validDrawing();
	}

	public canFinish( draft: PointDrawingDraft ): boolean {
		return this.validateDraft( draft ).valid;
	}

	public finish( draft: PointDrawingDraft, options: FinishFeatureOptions ): PointFeature {
		const validation = this.validateDraft( draft );
		if ( ! validation.valid ) throw new Error( `${ validation.code }：${ validation.message }` );
		const parameters = draft.parameters;
		const style = parameters.pointStyle === 'image'
			? mergeStyle( draft.style, {
				pointStyle: 'image', imageUrl: parameters.imageUrl,
				imageWidth: parameters.imageWidth, imageHeight: parameters.imageHeight,
				rotation: parameters.rotation ?? 0,
			} )
			: mergeStyle( draft.style, {
				pointStyle: parameters.pointStyle,
				size: parameters.size,
			} );
		return canonicalFeature<PointFeature>( {
			...commonFeatureFields( draft, options ),
			type: 'point', geometry: { position: draft.points[ 0 ] }, style,
		} );
	}

	public cancel(): void {}

	public preview( draft: PointDrawingDraft ): DraftPreviewGeometry {
		const position = draft.previewPoint ?? draft.points[ 0 ];
		return Object.freeze( {
			primitive: 'point',
			positions: Object.freeze( position === undefined ? [] : [ position ] ),
			closed: false,
			sourceType: 'point',
			generated: false,
		} );
	}

	public listHandles( feature: PointFeature ): readonly EditHandle[] {
		const center = feature.geometry.position;
		const handles: EditHandle[] = [ {
			id: 'center', entityId: feature.id, kind: 'center', position: center, priority: 100,
		} ];
		if ( feature.style.pointStyle === 'image' ) {
			handles.push( {
				id: 'width', entityId: feature.id, kind: 'width', priority: 90,
				position: positionAtEnuOffset( center, feature.style.imageWidth / 2, 0, feature.heightReference ),
			} );
			handles.push( {
				id: 'height', entityId: feature.id, kind: 'height', priority: 90,
				position: positionAtEnuOffset( center, 0, feature.style.imageHeight / 2, feature.heightReference ),
			} );
			handles.push( {
				id: 'rotation', entityId: feature.id, kind: 'rotation', priority: 80,
				position: positionAtEnuOffset( center, 0, feature.style.imageHeight, feature.heightReference ),
			} );
		} else {
			handles.push( {
				id: 'size', entityId: feature.id, kind: 'size', priority: 90,
				position: positionAtEnuOffset( center, feature.style.size / 2, 0, feature.heightReference ),
			} );
		}
		return Object.freeze( handles.map( ( handle ) => Object.freeze( handle ) ) );
	}

	public applyHandle(
		feature: PointFeature,
		handleId: string,
		movement: HandleMovement,
	): PointFeature {
		const center = feature.geometry.position;
		if ( handleId === 'center' ) {
			return canonicalFeature<PointFeature>( {
				...feature,
				geometry: { position: normalizeAuthorPosition( movement.authorPosition, feature.heightReference ) },
				revision: feature.revision + 1,
			} );
		}
		const distance = geodesicDistanceMeters( center, movement.authorPosition );
		if ( distance <= 0 ) throw new Error( 'EDIT_INVALID_SIZE：尺寸必须为正。' );
		const supported = feature.style.pointStyle === 'image'
			? [ 'width', 'height', 'rotation' ].includes( handleId )
			: handleId === 'size';
		if ( ! supported ) throw new Error( `EDIT_HANDLE_NOT_FOUND：${ handleId }。` );
		const style: PointStyle = feature.style.pointStyle === 'image'
			? {
				...feature.style,
				...( handleId === 'width' ? { imageWidth: distance * 2 } : {} ),
				...( handleId === 'height' ? { imageHeight: distance * 2 } : {} ),
				...( handleId === 'rotation' ? {
					rotation: headingDegreesFrom( center, movement.authorPosition ),
				} : {} ),
			}
			: handleId === 'size'
				? { ...feature.style, size: distance * 2 }
				: feature.style;
		return canonicalFeature<PointFeature>( { ...feature, style, revision: feature.revision + 1 } );
	}

	public removeVertex(): PointFeature {
		throw new Error( 'EDIT_TOPOLOGY_UNSUPPORTED：point 不支持删除 anchor。' );
	}

	public toRenderDescription( feature: PointFeature ): DraftPreviewGeometry {
		return Object.freeze( {
			primitive: 'point', positions: Object.freeze( [ feature.geometry.position ] ),
			closed: false, sourceType: 'point', generated: false,
		} );
	}

	public toJSON( feature: PointFeature ): unknown { return cloneJson( feature ); }

	private _revalidate( draft: PointDrawingDraft ): PointDrawingDraft {
		try {
			return freezeDraft( { ...draft, validation: this.validateDraft( draft ) } );
		} catch ( error ) {
			return freezeDraft( { ...draft, validation: drawingValidationFromError( error ) } );
		}
	}
}

function positive( value: unknown ): value is number {
	return typeof value === 'number' && Number.isFinite( value ) && value > 0;
}

function finite( value: unknown ): value is number {
	return typeof value === 'number' && Number.isFinite( value );
}
