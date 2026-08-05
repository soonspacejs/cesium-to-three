import type { GeometryAdapterRegistry } from '../adapters/GeometryAdapterRegistry';
import type { EnuTransform, FeatureTransform } from '../commands/types';
import {
	createEnuFrame,
	ecefToEnu,
	ecefToGeodetic,
	enuToEcef,
	geodeticToEcef,
	type Vector3Tuple,
} from '../document/geodesy';
import { isHeightReferenceClamp } from '../document/height-reference';
import { normalizeFeature } from '../document/validate';
import type { PlotFeature, Position3D } from '../document/types';

const SCALE_MINIMUM = 1e-6;
const SCALE_MAXIMUM = 1e6;
const TRANSFORM_EPSILON = 1e-12;

/** CommandExecutor 可注入的确定性 ENU feature.transform 策略。 */
export function createEnuFeatureTransform(
	adapters: GeometryAdapterRegistry,
): FeatureTransform {
	return ( feature, transform ) => applyEnuTransformToFeature( feature, transform, adapters );
}

/**
 * 对 source author geometry 应用同一个 pivot ENU 变换。
 * circle/sector/arrow 的派生轮廓不参与输入，提交后仍由 adapter 重建。
 */
export function applyEnuTransformToFeature(
	feature: Readonly<PlotFeature>,
	transform: EnuTransform,
	adapters: GeometryAdapterRegistry,
): PlotFeature {
	const normalized = normalizeTransform( transform );
	assertTransformSupported( feature, normalized, adapters );
	const frame = createEnuFrame( normalized.pivot );
	const transformPosition = ( position: Position3D ): Position3D => {
		let local = ecefToEnu( geodeticToEcef( position ), frame );
		local = applyScale( local, normalized.scale );
		local = applyRotations( local, normalized.rotationDegrees );
		local = [
			local[ 0 ] + normalized.translationMeters[ 0 ],
			local[ 1 ] + normalized.translationMeters[ 1 ],
			local[ 2 ] + normalized.translationMeters[ 2 ],
		];
		const geographic = ecefToGeodetic(
			enuToEcef( local, frame ),
			position[ 0 ],
		);
		return Object.freeze( [
			geographic[ 0 ],
			geographic[ 1 ],
			isHeightReferenceClamp( feature.heightReference ) ? 0 : geographic[ 2 ],
		] ) as Position3D;
	};

	const heading = normalized.rotationDegrees[ 0 ];
	const eastScale = normalized.scale[ 0 ];
	const northScale = normalized.scale[ 1 ];
	let candidate: unknown;
	if ( feature.type === 'point' ) {
		const style = feature.style.pointStyle === 'image'
			? {
				...feature.style,
				imageWidth: feature.style.imageWidth * eastScale,
				imageHeight: feature.style.imageHeight * northScale,
				rotation: wrapDegrees( feature.style.rotation + heading ),
			}
			: {
				...feature.style,
				size: feature.style.size * eastScale,
			};
		candidate = {
			...feature,
			geometry: { position: transformPosition( feature.geometry.position ) },
			style,
			revision: feature.revision + 1,
		};
	} else if ( feature.type === 'text' ) {
		const uniformScale = Math.sqrt( eastScale * northScale );
		candidate = {
			...feature,
			geometry: { position: transformPosition( feature.geometry.position ) },
			style: {
				...feature.style,
				rotation: wrapDegrees( feature.style.rotation + heading ),
				scale: feature.style.scale * uniformScale,
				...( feature.style.boxWidth === undefined
					? {} : { boxWidth: feature.style.boxWidth * eastScale } ),
				...( feature.style.boxHeight === undefined
					? {} : { boxHeight: feature.style.boxHeight * northScale } ),
			},
			revision: feature.revision + 1,
		};
	} else if ( feature.type === 'circle' ) {
		candidate = {
			...feature,
			geometry: {
				center: transformPosition( feature.geometry.center ),
				radius: feature.geometry.radius * eastScale,
			},
			revision: feature.revision + 1,
		};
	} else if ( feature.type === 'sector' ) {
		candidate = {
			...feature,
			geometry: {
				...feature.geometry,
				center: transformPosition( feature.geometry.center ),
				radius: feature.geometry.radius * eastScale,
				startAngle: wrapDegrees( feature.geometry.startAngle + heading ),
			},
			revision: feature.revision + 1,
		};
	} else {
		candidate = {
			...feature,
			geometry: {
				...feature.geometry,
				positions: Object.freeze( feature.geometry.positions.map( transformPosition ) ),
			},
			revision: feature.revision + 1,
		};
	}
	return normalizeFeature( candidate, { path: `/transform/${ feature.id }` } );
}

function normalizeTransform( transform: EnuTransform ): Required<EnuTransform> {
	if ( transform === null || typeof transform !== 'object' ) {
		throw new Error( 'TRANSFORM_INVALID：变换必须是对象。' );
	}
	const pivot = finiteTuple( transform.pivot, 'pivot' );
	if ( pivot[ 1 ] < -90 || pivot[ 1 ] > 90 ) {
		throw new Error( 'PIVOT_FRAME_INVALID：pivot 纬度必须位于 [-90,90]。' );
	}
	const translationMeters = transform.translationMeters === undefined
		? [ 0, 0, 0 ] as const
		: finiteTuple( transform.translationMeters, 'translationMeters' );
	const rotationDegrees = transform.rotationDegrees === undefined
		? [ 0, 0, 0 ] as const
		: finiteTuple( transform.rotationDegrees, 'rotationDegrees' );
	const scale = transform.scale === undefined
		? [ 1, 1, 1 ] as const
		: finiteTuple( transform.scale, 'scale' );
	if ( scale.some( ( value ) => value < SCALE_MINIMUM || value > SCALE_MAXIMUM ) ) {
		throw new Error(
			`TRANSFORM_INVALID_SCALE：scale 必须位于 [${ SCALE_MINIMUM },${ SCALE_MAXIMUM }]。`,
		);
	}
	return Object.freeze( { pivot, translationMeters, rotationDegrees, scale } );
}

function assertTransformSupported(
	feature: Readonly<PlotFeature>,
	transform: Required<EnuTransform>,
	adapters: GeometryAdapterRegistry,
): void {
	const capabilities = adapters.require( feature.type ).capabilities;
	const [ east, north, up ] = transform.translationMeters;
	const [ heading, pitch, roll ] = transform.rotationDegrees;
	const [ scaleEast, scaleNorth, scaleUp ] = transform.scale;
	const clamped = isHeightReferenceClamp( feature.heightReference );
	if ( ( different( east, 0 ) || different( north, 0 ) ) && ! capabilities.translate ) {
		throw blocked( feature, 'East/North 平移' );
	}
	if ( different( up, 0 ) && ( ! capabilities.translate || clamped ) ) {
		throw blocked( feature, 'Up 平移' );
	}
	if ( different( heading, 0 ) && ! capabilities.rotateHeading ) {
		throw blocked( feature, 'heading 旋转' );
	}
	if ( ( different( pitch, 0 ) || different( roll, 0 ) )
		&& ( ! capabilities.rotatePitchRoll || clamped ) ) {
		throw blocked( feature, 'pitch/roll 旋转' );
	}
	if ( ( different( scaleEast, 1 ) || different( scaleNorth, 1 ) )
		&& ! capabilities.scaleHorizontal ) {
		throw blocked( feature, '水平缩放' );
	}
	if ( different( scaleUp, 1 ) && ( ! capabilities.scaleVertical || clamped ) ) {
		throw blocked( feature, '垂直缩放' );
	}
	if ( ( feature.type === 'circle' || feature.type === 'sector'
			|| feature.type === 'point' && feature.style.pointStyle !== 'image' )
		&& different( scaleEast, scaleNorth ) ) {
		throw new Error( `TRANSFORM_INCOMPATIBLE_ADAPTER：${ feature.type } 不支持非等比水平缩放。` );
	}
}

function applyScale(
	point: Vector3Tuple,
	scale: readonly [ number, number, number ],
): Vector3Tuple {
	return [ point[ 0 ] * scale[ 0 ], point[ 1 ] * scale[ 1 ], point[ 2 ] * scale[ 2 ] ];
}

function applyRotations(
	point: Vector3Tuple,
	rotationDegrees: readonly [ number, number, number ],
): Vector3Tuple {
	let [ east, north, up ] = point;
	const heading = radians( rotationDegrees[ 0 ] );
	if ( heading !== 0 ) {
		const cosine = Math.cos( heading );
		const sine = Math.sin( heading );
		[ east, north ] = [
			east * cosine + north * sine,
			-east * sine + north * cosine,
		];
	}
	const pitch = radians( rotationDegrees[ 1 ] );
	if ( pitch !== 0 ) {
		const cosine = Math.cos( pitch );
		const sine = Math.sin( pitch );
		[ north, up ] = [ north * cosine - up * sine, north * sine + up * cosine ];
	}
	const roll = radians( rotationDegrees[ 2 ] );
	if ( roll !== 0 ) {
		const cosine = Math.cos( roll );
		const sine = Math.sin( roll );
		[ east, up ] = [ east * cosine + up * sine, -east * sine + up * cosine ];
	}
	return [ east, north, up ];
}

function finiteTuple(
	value: readonly [ number, number, number ],
	name: string,
): readonly [ number, number, number ] {
	if ( ! Array.isArray( value ) || value.length !== 3 || value.some( ( item ) => ! Number.isFinite( item ) ) ) {
		throw new Error( `TRANSFORM_INVALID：${ name } 必须是三个有限数。` );
	}
	return Object.freeze( [ value[ 0 ], value[ 1 ], value[ 2 ] ] );
}

function blocked( feature: Readonly<PlotFeature>, operation: string ): Error {
	return new Error( `TRANSFORM_CAPABILITY_BLOCKED：${ feature.type}/${ feature.id } 不支持${ operation}。` );
}

function different( left: number, right: number ): boolean {
	return Math.abs( left - right ) > TRANSFORM_EPSILON;
}

function radians( degrees: number ): number {
	return degrees * Math.PI / 180;
}

function wrapDegrees( value: number ): number {
	const wrapped = ( value % 360 + 360 ) % 360;
	return Object.is( wrapped, -0 ) ? 0 : wrapped;
}
