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

// Cesium globe minimum altitude used by the shadow-volume vertex shader.
export const CESIUM_GLOBE_MINIMUM_ALTITUDE = 55000.0;

// Lower bound for Cesium CircleGeometry tessellation in interactive demos.
export const MIN_CIRCLE_GRANULARITY_RADIANS = 0.0025;

// Upper bound for Cesium CircleGeometry tessellation in interactive demos.
export const MAX_CIRCLE_GRANULARITY_RADIANS = 0.2;

// Geometry expansion equals the requested meter border width.
export const BORDER_GEOMETRY_EXPANSION_SCALE = 1.0;

// Maximum polygon vertices mirrored into shader uniforms for edge styling.
export const MAX_POLYGON_STYLE_VERTICES = 128;
