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

// ── Ground polyline (line-shadow-volume) shared constants ──
// Standard wall height window used by the geometry builder BEFORE
// `adjustHeights` pushes vertices to the user-configured min/max.
// Same constants as Cesium's GroundPolylineGeometry.
export const WALL_INITIAL_MIN_HEIGHT = 0.0;
export const WALL_INITIAL_MAX_HEIGHT = 1000.0;

// Miter break thresholds. Cesium ports cos(30°) / cos(150°), used by
// `breakMiter` to decide when a corner is sharp enough to warrant rotating
// the geometry normal by ±90° instead of letting the miter blow up.
export const MITER_BREAK_SMALL = Math.cos( Math.PI / 6.0 );  // ≈ 0.8660254037844387
export const MITER_BREAK_LARGE = Math.cos( 5.0 * Math.PI / 6.0 ); // ≈ -0.8660254037844387

// Nudge epsilons used inside the per-segment box generator.
// LINE_NORMAL_NUDGE (EPSILON5) — push the 8 box corners ±1e-5 m along the
//   right normal to avoid zero-thickness boxes (FS reconstruction would be
//   numerically unstable on a degenerate face).
// LINE_NUDGE_XZ (EPSILON2) — when a vertex sits within 1 cm of the XZ plane
//   (y == 0 in WGS84), push it ~1 cm along the segment direction so
//   GeometryPipeline-style numeric paths don't collapse it.
export const LINE_NORMAL_NUDGE = 1.0e-5;
export const LINE_NUDGE_XZ = 1.0e-2;

// Epsilon used by `splitAcrossXZPlane` to discard near-coincident split
// intersections (ECEF magnitude scale).
export const LINE_SPLIT_EPSILON = 1.0e-7;

// Epsilon used by the cartographic dedup pass (compares radian lon/lat).
export const LINE_DEDUP_EPSILON = 1.0e-12;

// Default per-segment densification step **in METERS** (despite the
// historic "granularity radians" naming). Matches Cesium's
// `GroundPolylineGeometry` default (see
// `cesium-ground-source/.../GroundPolylineGeometry.js`:107
// `this.granularity = options.granularity ?? 9999.0`). The function
// `interpolateSegment` computes `segments = ceil(surfaceDistance(meters) /
// granularity)` and Cesium's JSDoc explicitly states
// "distance interval in meters". A 50 km line at this default produces ~6
// interpolation points — well below the millions a radian-scale default
// would generate, which froze the tab.
export const LINE_DEFAULT_GRANULARITY = 9999.0;

// Default screen-space stroke width in CSS pixels (matches Cesium's default).
export const LINE_DEFAULT_WIDTH_PIXELS = 3.0;

// Default render-order for polylines. Higher than the polygon default (30)
// so lines paint above filled ground primitives.
export const LINE_DEFAULT_RENDER_ORDER = 40;

// Three.js layer index used by every Cesium-ground "non-pickable" mesh
// (classification shadow-volume stencil/back-stencil/color meshes, and the
// rectangle debug-surface mesh). These meshes need to **render** as part of
// the ground pipeline but must NEVER be hit by camera-control raycasts:
//   - shadow-volume meshes are extruded multi-km boxes — picking them would
//     pin the camera at maximumHeight altitude
//   - debug-surface is a debug-only visualization plane at debugSurfaceHeight
//     (default 5km) — picking it would pin the camera at that altitude
// Three.js Raycaster.intersect only honours `layers`, not `visible`, so a
// hidden mesh still raycasts unless its layer mask excludes the raycaster's
// mask. By assigning these meshes to a non-default layer, the demo's default
// raycaster (layer 0) silently skips them; the host camera must
// `camera.layers.enable( CESIUM_GROUND_NON_PICKABLE_LAYER )` so they still
// render. See ground-demo.ts for the camera-side opt-in.
export const CESIUM_GROUND_NON_PICKABLE_LAYER = 1;
