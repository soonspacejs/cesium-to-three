import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import {
	WGS84_SEMI_MAJOR_AXIS,
	WGS84_SEMI_MINOR_AXIS,
	createEnuFrame,
	ecefToGeodetic,
	geodeticToEcef,
	type Vector3Tuple,
} from '../document/geodesy';
import { isHeightReferenceClamp } from '../document/height-reference';
import type { PlotFeature, PlotFeatureId, Position3D } from '../document/types';
import type { TransformMode } from '../state/types';
import type {
	GizmoCapabilities,
	GizmoHandleDescription,
	PivotDiagnostic,
	SelectionPivot,
} from './types';

export interface ComputeSelectionPivotOptions {
	readonly primaryId: PlotFeatureId;
	readonly onDiagnostic?: ( diagnostic: PivotDiagnostic ) => void;
}

/** 以 adapter 的 center/anchor handle 为唯一 pivot 语义来源。 */
export function featureAnchor(
	feature: Readonly<PlotFeature>,
	adapters: GeometryAdapterRegistry,
): Position3D {
	const adapter = adapters.require( feature.type );
	const handles = adapter.listHandles( feature as never );
	const center = handles.find( ( handle ) => handle.id === 'center' );
	if ( center !== undefined ) return center.position;
	const render = adapter.toRenderDescription( feature as never );
	const first = render.positions[ 0 ];
	if ( first === undefined ) throw new Error( `PIVOT_FRAME_INVALID：图形 ${ feature.id } 没有 anchor。` );
	return first;
}

/** 多选平均方向接近零时确定性回退 primary，不构造 NaN ENU frame。 */
export function computeSelectionPivot(
	features: readonly Readonly<PlotFeature>[],
	adapters: GeometryAdapterRegistry,
	options: ComputeSelectionPivotOptions,
): SelectionPivot {
	if ( features.length === 0 ) throw new Error( 'PIVOT_FRAME_INVALID：至少需要一个选中图形。' );
	const primary = features.find( ( feature ) => feature.id === options.primaryId );
	if ( primary === undefined ) throw new Error( 'PIVOT_FRAME_INVALID：primary 必须属于 selection。' );
	const anchors = features.map( ( feature ) => featureAnchor( feature, adapters ) );
	if ( anchors.length === 1 ) return freezePivot( anchors[ 0 ], false );

	let x = 0;
	let y = 0;
	let z = 0;
	let height = 0;
	for ( const anchor of anchors ) {
		const ecef = geodeticToEcef( [ anchor[ 0 ], anchor[ 1 ], 0 ] );
		const length = Math.hypot( ...ecef );
		x += ecef[ 0 ] / length;
		y += ecef[ 1 ] / length;
		z += ecef[ 2 ] / length;
		height += anchor[ 2 ];
	}
	const directionLength = Math.hypot( x, y, z );
	if ( directionLength < 1e-12 ) {
		const anchor = featureAnchor( primary, adapters );
		options.onDiagnostic?.( Object.freeze( {
			code: 'PIVOT_FALLBACK_PRIMARY',
			severity: 'warning',
			message: '多选 anchor 近似对跖，pivot 已回退 primary 图形。',
			primaryId: primary.id,
		} ) );
		return freezePivot( anchor, true );
	}
	const direction: Vector3Tuple = [
		x / directionLength,
		y / directionLength,
		z / directionLength,
	];
	const surfaceScale = 1 / Math.sqrt(
		( direction[ 0 ] ** 2 + direction[ 1 ] ** 2 ) / WGS84_SEMI_MAJOR_AXIS ** 2
		+ direction[ 2 ] ** 2 / WGS84_SEMI_MINOR_AXIS ** 2,
	);
	const surface = ecefToGeodetic( [
		direction[ 0 ] * surfaceScale,
		direction[ 1 ] * surfaceScale,
		direction[ 2 ] * surfaceScale,
	], featureAnchor( primary, adapters )[ 0 ] );
	return freezePivot( [
		surface[ 0 ], surface[ 1 ], height / anchors.length,
	], false );
}

/** 组能力取所有 adapter/高度策略的交集，避免多选部分提交。 */
export function getSelectionGizmoCapabilities(
	features: readonly Readonly<PlotFeature>[],
	adapters: GeometryAdapterRegistry,
): GizmoCapabilities {
	if ( features.length === 0 ) return allCapabilitiesDisabled();
	const every = ( predicate: ( feature: Readonly<PlotFeature> ) => boolean ) =>
		features.every( predicate );
	return Object.freeze( {
		translateEast: every( ( feature ) => adapters.require( feature.type ).capabilities.translate ),
		translateNorth: every( ( feature ) => adapters.require( feature.type ).capabilities.translate ),
		translateUp: every( ( feature ) => adapters.require( feature.type ).capabilities.translate
			&& ! isHeightReferenceClamp( feature.heightReference ) ),
		rotateHeading: every( ( feature ) => adapters.require( feature.type ).capabilities.rotateHeading ),
		rotatePitch: every( ( feature ) => adapters.require( feature.type ).capabilities.rotatePitchRoll
			&& ! isHeightReferenceClamp( feature.heightReference ) ),
		rotateRoll: every( ( feature ) => adapters.require( feature.type ).capabilities.rotatePitchRoll
			&& ! isHeightReferenceClamp( feature.heightReference ) ),
		scaleHorizontal: every( ( feature ) => adapters.require( feature.type ).capabilities.scaleHorizontal ),
		scaleVertical: every( ( feature ) => adapters.require( feature.type ).capabilities.scaleVertical
			&& ! isHeightReferenceClamp( feature.heightReference ) ),
		editVertices: features.length === 1
			&& adapters.require( features[ 0 ].type ).capabilities.editVertices,
	} );
}

/** 屏幕尺寸均为 CSS px；DPR 只由 renderer 转为 device px，不改变命中语义。 */
export function createGizmoHandleDescriptions(
	mode: TransformMode,
	capabilities: GizmoCapabilities,
): readonly GizmoHandleDescription[] {
	const handles: GizmoHandleDescription[] = [];
	if ( mode === 'translate' ) {
		handles.push(
			gizmoHandle( 'translate:east', 'translate-axis', 'east', capabilities.translateEast ),
			gizmoHandle( 'translate:north', 'translate-axis', 'north', capabilities.translateNorth ),
			gizmoHandle( 'translate:up', 'translate-axis', 'up', capabilities.translateUp, '贴地或 adapter 不支持 Up 平移。' ),
			gizmoHandle(
				'translate:east-north', 'translate-plane', 'uniform',
				capabilities.translateEast && capabilities.translateNorth,
			),
		);
	} else if ( mode === 'rotate' ) {
		handles.push(
			gizmoHandle( 'rotate:heading', 'rotate-ring', undefined, capabilities.rotateHeading, undefined, 'heading' ),
			gizmoHandle( 'rotate:pitch', 'rotate-ring', undefined, capabilities.rotatePitch, '贴地或 adapter 不支持 pitch。', 'pitch' ),
			gizmoHandle( 'rotate:roll', 'rotate-ring', undefined, capabilities.rotateRoll, '贴地或 adapter 不支持 roll。', 'roll' ),
		);
	} else {
		handles.push(
			gizmoHandle( 'scale:east', 'scale-axis', 'east', capabilities.scaleHorizontal ),
			gizmoHandle( 'scale:north', 'scale-axis', 'north', capabilities.scaleHorizontal ),
			gizmoHandle( 'scale:up', 'scale-axis', 'up', capabilities.scaleVertical, '贴地或 adapter 不支持垂直缩放。' ),
			gizmoHandle( 'scale:uniform', 'scale-uniform', 'uniform', capabilities.scaleHorizontal ),
		);
	}
	return Object.freeze( handles );
}

function gizmoHandle(
	id: string,
	kind: GizmoHandleDescription[ 'kind' ],
	axis: GizmoHandleDescription[ 'axis' ],
	enabled: boolean,
	disabledReason?: string,
	rotation?: GizmoHandleDescription[ 'rotation' ],
): GizmoHandleDescription {
	return Object.freeze( {
		id, kind,
		...( axis === undefined ? {} : { axis } ),
		...( rotation === undefined ? {} : { rotation } ),
		visible: enabled,
		enabled,
		pickable: enabled,
		cursor: kind === 'rotate-ring'
			? 'rotate'
			: kind === 'scale-axis' || kind === 'scale-uniform' ? 'ew-resize' : 'move',
		screenSizeCssPixels: kind === 'rotate-ring' ? 96 : 72,
		pickRadiusCssPixels: 8,
		priority: 500,
		...( enabled || disabledReason === undefined ? {} : { disabledReason } ),
	} );
}

function freezePivot( position: Position3D, fallbackToPrimary: boolean ): SelectionPivot {
	const frozenPosition = Object.freeze( [ ...position ] ) as Position3D;
	const frame = createEnuFrame( frozenPosition );
	return Object.freeze( {
		position: frozenPosition,
		ecef: frame.origin,
		frame,
		fallbackToPrimary,
	} );
}

function allCapabilitiesDisabled(): GizmoCapabilities {
	return Object.freeze( {
		translateEast: false, translateNorth: false, translateUp: false,
		rotateHeading: false, rotatePitch: false, rotateRoll: false,
		scaleHorizontal: false, scaleVertical: false, editVertices: false,
	} );
}
