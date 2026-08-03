import { BufferAttribute, Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { CesiumGroundPolylinePrimitive } from '../../../src/lib/ground/primitives';
import type { LineGeometryUserData } from '../../../src/lib/ground/line/line-shadow-volume';

describe( 'polyline distance ABI packing', () => {
	it( 'keeps distanceAlongMeters monotonic and continuous across every segment', () => {
		const primitive = new CesiumGroundPolylinePrimitive( {
			// Unequal legs force distinct segment-length fractions and exercise the
			// densifier boundaries instead of accidentally testing a uniform split.
			points: [
				[ 121.4, 31.2 ],
				[ 121.4004, 31.2002 ],
				[ 121.4025, 31.2014 ],
			],
			strokeColor: '#ffffff',
			strokeOpacity: 100,
			visible: true,
			granularityRadians: 20,
		} );
		const line = primitive.group.getObjectByName( 'CesiumGroundPolylineColorCommand' );
		if ( ! ( line instanceof Mesh ) ) throw new Error( 'Polyline line Mesh is missing.' );

		const geometry = line.geometry;
		const userData = geometry.userData as LineGeometryUserData;
		const segmentLengthFraction = geometry.getAttribute(
			'endNormalAndTextureCoordinateNormalizationX',
		) as BufferAttribute;
		const segmentStartFraction = geometry.getAttribute(
			'rightNormalAndTextureCoordinateNormalizationY',
		) as BufferAttribute;

		let previousEndRatio = 0;
		let previousEndMeters = 0;
		for ( let segment = 0; segment < userData.segmentCount; segment ++ ) {
			// Each segment owns eight box vertices. Vertex 2 is both on the positive
			// right-plane half and the top half, so its packed `.w` components carry
			// positive texNormX/texNormY values without the first-segment `9.0`
			// sentinel used by negative zero on bottom vertices.
			const vertex = segment * 8 + 2;
			const startRatio = segmentStartFraction.getW( vertex );
			const lengthRatio = segmentLengthFraction.getW( vertex );
			const endRatio = startRatio + lengthRatio;
			const startMeters = startRatio * userData.length3D;
			const endMeters = endRatio * userData.length3D;

			// The fragment system stage computes:
			// globalRatio = segmentRatio * texNormX + texNormY, then multiplies by
			// c23_lineTotalMeters. Therefore these endpoint assertions directly lock
			// the ABI values observed at segmentRatio 0 and 1.
			expect( startRatio ).toBeCloseTo( previousEndRatio, 5 );
			expect( startMeters ).toBeCloseTo( previousEndMeters, 2 );
			expect( endRatio ).toBeGreaterThan( startRatio );
			expect( endMeters ).toBeGreaterThan( startMeters );

			previousEndRatio = endRatio;
			previousEndMeters = endMeters;
		}

		expect( previousEndRatio ).toBeCloseTo( 1, 5 );
		expect( previousEndMeters ).toBeCloseTo( userData.length3D, 2 );
		primitive.dispose();
	} );
} );
