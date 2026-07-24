import coordinationUnitUrl from '../../assets/coordination-unit.svg';
import emergencySuppliesUrl from '../../assets/emergency-supplies.svg';
import fireStationUrl from '../../assets/fire-station.svg';
import fireWaterPoolUrl from '../../assets/fire-water-pool.svg';
import hospitalResourceUrl from '../../assets/hospital-resource.svg';
import municipalHydrantUrl from '../../assets/municipal-hydrant.svg';
import naturalWaterSourceUrl from '../../assets/natural-water-source.svg';
import outdoorHydrantAboveGroundUrl from '../../assets/outdoor-hydrant-above-ground.svg';
import outdoorHydrantUndergroundUrl from '../../assets/outdoor-hydrant-underground.svg';
import outdoorHydrantUrl from '../../assets/outdoor-hydrant.svg';
import policeResourceUrl from '../../assets/police-resource.svg';

/** Emergency-resource ontology identifiers mapped to imported SVG assets. */
export const EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID = {
	OutdoorFireHydrant: outdoorHydrantUrl,
	UndergroundHydrant: outdoorHydrantUndergroundUrl,
	AboveGroundHydrant: outdoorHydrantAboveGroundUrl,
	MunicipalFireHydrants: municipalHydrantUrl,
	FireWaterReservoir: fireWaterPoolUrl,
	NaturalWater: naturalWaterSourceUrl,
	HospitalResourcePoint: hospitalResourceUrl,
	PublicSecurityResourcePoint: policeResourceUrl,
	SupportMaterialPoint: emergencySuppliesUrl,
	FireStation: fireStationUrl,
	LinkageUnit: coordinationUnitUrl,
} as const;

export type EmergencyResourceOntologyId =
	keyof typeof EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID;

export const EMERGENCY_RESOURCE_ONTOLOGY_IDS = Object.freeze(
	Object.keys( EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID ) as EmergencyResourceOntologyId[],
);

/** Resolve an ontology identifier to its public SVG URL. */
export function resolveEmergencyResourceIcon(
	ontologyId: string | null | undefined,
): string | null {
	const normalized = ontologyId?.trim();
	if ( ! normalized ||
		! Object.prototype.hasOwnProperty.call(
			EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID,
			normalized,
		) ) {
		return null;
	}

	return EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID[
		normalized as EmergencyResourceOntologyId
	];
}

/** Explicit URLs remain supported and take precedence over ontology mapping. */
export function resolvePlotPointImageUrl( source: {
	imageUrl?: string;
	ontologyId?: string;
} ): string | null {
	const imageUrl = source.imageUrl?.trim();
	return imageUrl || resolveEmergencyResourceIcon( source.ontologyId );
}
