/**
 * Emergency-resource ontology identifiers mapped to SVG assets served from
 * public/icon.
 */
export const EMERGENCY_RESOURCE_ICON_BY_ONTOLOGY_ID = {
	OutdoorFireHydrant: '/icon/outdoor-hydrant.svg',
	UndergroundHydrant: '/icon/outdoor-hydrant-underground.svg',
	AboveGroundHydrant: '/icon/outdoor-hydrant-above-ground.svg',
	MunicipalFireHydrants: '/icon/municipal-hydrant.svg',
	FireWaterReservoir: '/icon/fire-water-pool.svg',
	NaturalWater: '/icon/natural-water-source.svg',
	HospitalResourcePoint: '/icon/hospital-resource.svg',
	PublicSecurityResourcePoint: '/icon/police-resource.svg',
	SupportMaterialPoint: '/icon/emergency-supplies.svg',
	FireStation: '/icon/fire-station.svg',
	LinkageUnit: '/icon/coordination-unit.svg',
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
