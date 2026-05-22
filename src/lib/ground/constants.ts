// ============================================================
// constants.ts
// Layer: Cesium-to-Three ground adapter shared constants.
// Role: define WGS84 ellipsoid values and Cesium classification constants used
//       across geometry, shader, and primitive modules.
// Dependencies: none.
// Consumed by: ground geometry helpers, materials, and depth passes.
// ============================================================

// WGS84 semi-major axis in meters for the x axis.
export const WGS84_X_RADIUS = 6378137.0;

// WGS84 semi-major axis in meters for the y axis.
export const WGS84_Y_RADIUS = 6378137.0;

// WGS84 semi-minor axis in meters for the z axis.
export const WGS84_Z_RADIUS = 6356752.3142451793;

// Cesium classification bit mask used by GroundPrimitive stencil commands.
export const CLASSIFICATION_MASK = 0x0f;

// Cesium scene mode numeric value for 3D mode.
export const SCENE_MODE_3D = 3.0;

// Cesium globe minimum altitude used by the shadow-volume vertex shader as
// the upper clamp for the per-frame extrude delta. This is intentionally
// large because it is only an upper bound; the actual extrude amount is
// driven by czm_geometricToleranceOverMeter * length(positionEC).
export const CESIUM_GLOBE_MINIMUM_ALTITUDE = 55000.0;

// Geometry expansion equals the requested meter border width.
export const BORDER_GEOMETRY_EXPANSION_SCALE = 1.0;

// Maximum polygon outline vertices honoured by the geometry pipeline. Mirrors
// the shader-side uniform slot count in the reference project. The current
// adapter does not feed these into the classification material, but the
// polygon hierarchy validator still uses this cap to keep input sane.
export const MAX_POLYGON_STYLE_VERTICES = 128;

// Lower bound for circle tessellation in interactive demos. Cesium uses
// roughly 0.001 rad in production; we expose a slightly larger floor so the
// GUI slider never produces multi-million-vertex meshes by accident.
export const MIN_CIRCLE_GRANULARITY_RADIANS = 0.0025;

// Upper bound for circle tessellation in interactive demos.
export const MAX_CIRCLE_GRANULARITY_RADIANS = 0.2;

// Cesium Scene._maximumScreenSpaceError default value used by
// UniformState.update to derive czm_geometricToleranceOverMeter. Cesium uses
// 2.0 by default for the main scene; matching it keeps the shadow-volume
// vertex extrude in sync with the original GroundPrimitive behaviour.
export const CESIUM_MAXIMUM_SCREEN_SPACE_ERROR = 2.0;

// Default fallback terrain min/max heights mirroring
// ApproximateTerrainHeights._defaultMinTerrainHeight /
// _defaultMaxTerrainHeight. Used when the terrain-height table has not been
// initialized yet so the adapter still produces a valid shadow volume.
export const APPROXIMATE_TERRAIN_DEFAULT_MIN_HEIGHT = - 100000.0;
export const APPROXIMATE_TERRAIN_DEFAULT_MAX_HEIGHT = 9000.0;
