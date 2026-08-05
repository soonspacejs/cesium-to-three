import type { PlotAddOptions } from '../../plot/plugins/types';
import type { PlotFeature } from '../document/types';
import type { RenderFeature, RenderVertex } from './RenderProjection';

export type LegacyPlotUnsupportedReason =
	| 'VARIABLE_VERTEX_HEIGHT'
	| 'SURFACE_UNAVAILABLE';

export type LegacyPlotAdaptResult =
	| {
		readonly supported: true;
		readonly options: PlotAddOptions;
	}
	| {
		readonly supported: false;
		readonly reason: LegacyPlotUnsupportedReason;
		readonly message: string;
	};

/**
 * canonical feature 到旧 PlotPrimitiveBridge 入参的单向兼容适配器。
 *
 * 旧接口只能表达二维点加统一高度；逐顶点高度必须明确返回 unsupported，绝不取
 * 平均高度伪装。canonical id 由上层 bridge 的 Map key 保留，不交给旧自增 id。
 */
export function adaptRenderFeatureToLegacyPlot(
	feature: Readonly<PlotFeature>,
	render: RenderFeature,
): LegacyPlotAdaptResult {
	if ( render.surfaceStatus === 'unavailable' ) {
		return unsupported( 'SURFACE_UNAVAILABLE', `图形 ${ feature.id } 的目标表面不可用。` );
	}
	const height = commonWorldHeight( render.sourceVertices );
	if ( render.path === 'plain-rte' && height === null ) {
		return unsupported(
			'VARIABLE_VERTEX_HEIGHT',
			`图形 ${ feature.id } 含逐顶点高度，不能压缩为旧 heightMeters。`,
		);
	}
	const common = {
		points: render.sourceVertices.map(
			( vertex ) => [ vertex.longitude, vertex.latitude ] as [ number, number ],
		),
		strokeColor: feature.style.strokeColor,
		strokeWidth: feature.style.strokeWidth,
		strokeOpacity: feature.style.strokeOpacity,
		fillColor: feature.style.fillColor,
		fillOpacity: feature.style.fillOpacity,
		visible: render.visible,
		clampToGround: render.path === 'ground-classification',
		...( render.path === 'plain-rte' ? { heightMeters: height ?? 0 } : {} ),
		...( render.classificationType === undefined
			? {} : { classificationType: render.classificationType } ),
	};
	let options: PlotAddOptions;
	switch ( feature.type ) {
		case 'point':
			options = feature.style.pointStyle === 'image'
				? {
					...common, type: 'point', pointStyle: 'image',
					imageUrl: feature.style.imageUrl,
					imageWidth: feature.style.imageWidth,
					imageHeight: feature.style.imageHeight,
					rotation: feature.style.rotation,
				}
				: {
					...common, type: 'point', pointStyle: feature.style.pointStyle,
					size: feature.style.size,
				};
			break;
		case 'line':
			options = {
				...common, type: 'line', strokeStyle: feature.style.strokeStyle,
				showArrow: feature.style.showArrow,
				startArrowStyle: feature.style.startArrowStyle,
				endArrowStyle: feature.style.endArrowStyle,
			};
			break;
		case 'polygon':
			options = { ...common, type: 'polygon' };
			break;
		case 'rectangle':
			options = { ...common, type: 'rectangle' };
			break;
		case 'circle':
			options = { ...common, type: 'circle', radius: feature.geometry.radius };
			break;
		case 'sector':
			options = {
				...common, type: 'sector', radius: feature.geometry.radius,
				startAngle: feature.geometry.startAngle,
				sectorAngle: feature.geometry.sectorAngle,
			};
			break;
		case 'arrow':
			options = {
				...common, type: 'arrow', arrowType: feature.geometry.arrowType,
				sizeScale: feature.geometry.sizeScale,
				...( feature.geometry.curvedBodyWidthFactor === undefined ? {} : {
					curvedBodyWidthFactor: feature.geometry.curvedBodyWidthFactor,
				} ),
				...( feature.geometry.curvedHeadWidthFactor === undefined ? {} : {
					curvedHeadWidthFactor: feature.geometry.curvedHeadWidthFactor,
				} ),
				...( feature.geometry.curvedHeadLengthFactor === undefined ? {} : {
					curvedHeadLengthFactor: feature.geometry.curvedHeadLengthFactor,
				} ),
			};
			break;
		case 'text':
			options = {
				...common, type: 'text', content: feature.style.content,
				fontColor: feature.style.fontColor,
				fontSize: feature.style.fontSize,
				scale: feature.style.scale,
				textAlign: feature.style.textAlign,
				verticalAlign: feature.style.verticalAlign,
				anchorX: feature.style.anchorX,
				anchorY: feature.style.anchorY,
				...( feature.style.boxWidth === undefined ? {} : { boxWidth: feature.style.boxWidth } ),
				...( feature.style.boxHeight === undefined ? {} : { boxHeight: feature.style.boxHeight } ),
				padding: copyLegacyPadding( feature.style.padding ),
				layoutDirection: feature.style.layoutDirection,
				rotation: feature.style.rotation,
				offsetX: feature.style.offsetX,
				offsetY: feature.style.offsetY,
				showBorder: feature.style.showBorder,
			};
			break;
	}
	return Object.freeze( { supported: true, options: Object.freeze( options ) as PlotAddOptions } );
}

function commonWorldHeight( vertices: readonly RenderVertex[] ): number | null {
	const first = vertices[ 0 ]?.resolvedWorldHeight ?? 0;
	return vertices.every( ( vertex ) =>
		Math.abs( vertex.resolvedWorldHeight - first ) <= 1e-6 )
		? first
		: null;
}

function copyLegacyPadding(
	padding: number | readonly [ number, number, number, number ],
): number | [ number, number, number, number ] {
	return typeof padding === 'number'
		? padding
		: [ padding[ 0 ], padding[ 1 ], padding[ 2 ], padding[ 3 ] ];
}

function unsupported(
	reason: LegacyPlotUnsupportedReason,
	message: string,
): LegacyPlotAdaptResult {
	return Object.freeze( { supported: false, reason, message } );
}
