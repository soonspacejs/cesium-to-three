// ============================================================
// arrow-demo.ts
// Layer: demo arrow plotting subsystem.
// Role:  encapsulate all 5 special-shape arrows (fine arrow, assault
//        direction arrow, attack arrow, swallowtail attack arrow, curved
//        arrow) as a self-contained set of `CesiumGroundPolygonPrimitive`
//        instances plus a complete lil-gui surface. Each arrow type lives in
//        its own folder with the full option set from
//        `src/lib/arrow/arrow-types.ts` exposed as numeric sliders / colour
//        pickers, plus a JSON text field for the control points that mirrors
//        the rectangle + polygon pattern in `ground-demo.ts`.
//
//        Design goals:
//          - Zero geometry knowledge in this file. All math lives in
//            `src/lib/arrow`; this module only consumes `LonLatPoint[]`
//            output rings and feeds them straight to
//            CesiumGroundPolygonPrimitive.
//          - Each arrow primitive is fully reconstructable when any
//            geometry-affecting option changes. Stroke / fill / visibility
//            / render order edits are applied without rebuilding geometry.
//          - The 5 arrows share the host's `Passes` (front stencil / back
//            stencil / color) toggle and the `fragmentCull` flag through
//            `applyPassVisibility(...)` and `applyFragmentCull(...)` hooks,
//            so the existing `applyGroundDebugSettings()` host pipeline
//            stays a single source of truth for shared render state.
//          - Plot orders are routed through the host's
//            `PlotOrderRegistry<DemoPlotId>` so arrows participate in the
//            same global render order pool as the rectangle / polygon /
//            circle primitives.
//
// Dependencies: src/lib/arrow (5 factories + option types),
//               src/lib/ground (CesiumGroundPolygonPrimitive +
//               CesiumGroundFrameState), demo plot-utils
//               (PlotOrderRegistry, plotOrderToRenderOrder).
// Consumed by: src/demo/ground-demo.ts.
// ============================================================

import { Color, type Scene } from 'three';
import type GUI from 'lil-gui';

import {
	createAssaultDirectionArrow,
	createAttackArrow,
	createCurvedArrow,
	createFineArrow,
	createSwallowtailAttackArrow,
	type ArrowPolygon,
	type AssaultDirectionArrowOptions,
	type AttackArrowOptions,
	type CurvedArrowOptions,
	type FineArrowOptions,
	type LonLatPoint,
	type SwallowtailAttackArrowOptions,
} from '../lib/arrow';
import {
	CesiumGroundPolygonPrimitive,
	type CesiumGroundFrameState,
} from '../lib/ground';
import { plotOrderToRenderOrder } from './plot-utils';

// ── Arrow plot identifier union ──
// These ids are exported so the host `DemoPlotId` in ground-demo.ts can be
// widened to include them, sharing one `PlotOrderRegistry` instance.
export type ArrowPlotId =
	| 'fineArrow'
	| 'assaultDirection'
	| 'attackArrow'
	| 'swallowtailAttackArrow'
	| 'curvedArrow'
	| 'largeFineArrow'
	| 'largeAssaultDirection'
	| 'largeAttackArrow'
	| 'largeSwallowtailAttackArrow'
	| 'largeCurvedArrow';

type ArrowKind =
	| 'fineArrow'
	| 'assaultDirection'
	| 'attackArrow'
	| 'swallowtailAttackArrow'
	| 'curvedArrow';

/**
 * Minimal registry shape consumed by this module.
 *
 * The host owns a `PlotOrderRegistry<DemoPlotId>` where `DemoPlotId` is the
 * widened union of rectangle / polygon / circle + every {@link ArrowPlotId}.
 * That class is generic in `PlotId` and its private `Map<PlotId, ...>`
 * fields make it invariant under TypeScript's nominal-private-field rule,
 * so a `PlotOrderRegistry<DemoPlotId>` is not assignable to a
 * `PlotOrderRegistry<ArrowPlotId>` even though `ArrowPlotId ⊂ DemoPlotId`.
 *
 * The fix is structural: declare an interface that lists only the two
 * methods this module touches. Method-parameter bivariance under method
 * shorthand means a registry parameterized over a superset of ArrowPlotId
 * is still assignable to this interface (the wider method accepts
 * narrower input). No `unknown` casts at the call site needed.
 */
export interface ArrowPlotOrderRegistry {
	register( plotId: ArrowPlotId, preferredPlotOrder?: number ): number;
	update( plotId: ArrowPlotId, preferredPlotOrder: number ): number;
}

// Ordered list used to iterate entries deterministically (GUI order, info
// lines order, dispose order). Kept in sync with `ArrowPlotId`.
const ARROW_PLOT_IDS: readonly ArrowPlotId[] = [
	'fineArrow',
	'assaultDirection',
	'attackArrow',
	'swallowtailAttackArrow',
	'curvedArrow',
	'largeFineArrow',
	'largeAssaultDirection',
	'largeAttackArrow',
	'largeSwallowtailAttackArrow',
	'largeCurvedArrow',
];

// ── Per-arrow human label for the GUI folder + info panel ──
const ARROW_LABELS: Record<ArrowPlotId, string> = {
	fineArrow: 'Fine Arrow',
	assaultDirection: 'Assault Direction',
	attackArrow: 'Attack Arrow',
	swallowtailAttackArrow: 'Swallowtail Attack',
	curvedArrow: 'Curved Arrow',
	largeFineArrow: 'Large Fine Arrow',
	largeAssaultDirection: 'Large Assault Direction',
	largeAttackArrow: 'Large Attack Arrow',
	largeSwallowtailAttackArrow: 'Large Swallowtail Attack',
	largeCurvedArrow: 'Large Curved Arrow',
};

// ── Per-arrow distinct fill colours so each is identifiable at a glance ──
const ARROW_FILL_COLORS: Record<ArrowPlotId, string> = {
	fineArrow: '#ffaa00',
	assaultDirection: '#ff4488',
	attackArrow: '#ff2200',
	swallowtailAttackArrow: '#aa44ff',
	curvedArrow: '#22ddaa',
	largeFineArrow: '#ffd54d',
	largeAssaultDirection: '#ff77aa',
	largeAttackArrow: '#ff6644',
	largeSwallowtailAttackArrow: '#c477ff',
	largeCurvedArrow: '#55f0cc',
};

// ── Shared default stroke / fill state ──
const DEFAULT_STROKE_COLOR = '#ffffff';
const DEFAULT_STROKE_OPACITY = 95.0;
const DEFAULT_STROKE_WIDTH_METERS = 0.35;
const DEFAULT_FILL_OPACITY = 70.0;

// ── Initial plot orders ──
// Rectangle/Polygon/Circle host take 0/1/2. Arrows occupy 3..7. The
// `PlotOrderRegistry` will re-allocate if these collide with a user-edited
// order, so these numbers are only the *preferred* starting orders.
const PREFERRED_PLOT_ORDERS: Record<ArrowPlotId, number> = {
	fineArrow: 3,
	assaultDirection: 4,
	attackArrow: 5,
	swallowtailAttackArrow: 6,
	curvedArrow: 7,
	largeFineArrow: 11,
	largeAssaultDirection: 12,
	largeAttackArrow: 13,
	largeSwallowtailAttackArrow: 14,
	largeCurvedArrow: 15,
};

// ── Per-arrow default factory options ──
// These mirror the constants in `src/lib/arrow/shapes/*.ts`. Exposing them
// here lets the GUI start at the same defaults the factories use, so a
// "reset" is simply: refresh the page.
const DEFAULT_FINE_ARROW_OPTIONS: Required<FineArrowOptions> = {
	tailWidthFactor: 0.10,
	neckWidthFactor: 0.20,
	headWidthFactor: 0.25,
	headAngleRadians: Math.PI / 8.5,
	neckAngleRadians: Math.PI / 13.0,
};

const DEFAULT_ASSAULT_DIRECTION_OPTIONS: Required<AssaultDirectionArrowOptions> = {
	lengthScale: 1.5,
	tailWidthFactor: 0.08,
	neckWidthFactor: 0.10,
	headWidthFactor: 0.13,
	headAngleRadians: Math.PI / 4.0,
	neckAngleRadians: Math.PI * 0.17741,
};

const DEFAULT_ATTACK_ARROW_OPTIONS: Required<AttackArrowOptions> = {
	headHeightFactor: 0.28,
	headWidthFactor: 0.55,
	neckHeightFactor: 0.85,
	neckWidthFactor: 0.22,
	headTailFactor: 1.25,
	minBodyHalfAngleRadians: Math.PI / 12.0,
	bodyWidthMargin: 1.05,
	bodySmoothingSegments: 12,
};

const DEFAULT_SWALLOWTAIL_OPTIONS: Required<SwallowtailAttackArrowOptions> = {
	headHeightFactor: 0.28,
	headWidthFactor: 0.55,
	neckHeightFactor: 0.85,
	neckWidthFactor: 0.22,
	headTailFactor: 1.25,
	minBodyHalfAngleRadians: Math.PI / 12.0,
	bodyWidthMargin: 1.05,
	bodySmoothingSegments: 12,
	swallowtailFactor: 0.70,
	tailWidthFactor: 0.08,
};

const DEFAULT_CURVED_ARROW_OPTIONS: Required<CurvedArrowOptions> = {
	bodyWidthFactor: 0.05,
	headWidthFactor: 0.16,
	headLengthFactor: 0.18,
	neckWidthRelativeToHead: 0.40,
	curveSmoothingSegments: 16,
	bodyTaperRatio: 0.0,
};

/**
 * Per-arrow demo entry — owns one CesiumGroundPolygonPrimitive plus all GUI
 * state. The discriminated union over `kind` lets `rebuildArrow` dispatch
 * to the correct factory without type assertions.
 */
interface BaseArrowEntry {
	readonly id: ArrowPlotId;
	readonly label: string;
	visible: boolean;
	plotOrder: number;
	pointsJson: string;
	points: LonLatPoint[];
	fillColor: string;
	fillOpacity: number;
	strokeColor: string;
	strokeOpacity: number;
	strokeWidth: number;
	primitive: CesiumGroundPolygonPrimitive | null;
}

interface FineArrowEntry extends BaseArrowEntry {
	readonly kind: 'fineArrow';
	options: Required<FineArrowOptions>;
}

interface AssaultDirectionEntry extends BaseArrowEntry {
	readonly kind: 'assaultDirection';
	options: Required<AssaultDirectionArrowOptions>;
}

interface AttackArrowEntry extends BaseArrowEntry {
	readonly kind: 'attackArrow';
	options: Required<AttackArrowOptions>;
}

interface SwallowtailAttackEntry extends BaseArrowEntry {
	readonly kind: 'swallowtailAttackArrow';
	options: Required<SwallowtailAttackArrowOptions>;
}

interface CurvedArrowEntry extends BaseArrowEntry {
	readonly kind: 'curvedArrow';
	options: Required<CurvedArrowOptions>;
}

type ArrowEntry =
	| FineArrowEntry
	| AssaultDirectionEntry
	| AttackArrowEntry
	| SwallowtailAttackEntry
	| CurvedArrowEntry;

interface ArrowEntryByKind {
	fineArrow: FineArrowEntry;
	assaultDirection: AssaultDirectionEntry;
	attackArrow: AttackArrowEntry;
	swallowtailAttackArrow: SwallowtailAttackEntry;
	curvedArrow: CurvedArrowEntry;
	largeFineArrow: FineArrowEntry;
	largeAssaultDirection: AssaultDirectionEntry;
	largeAttackArrow: AttackArrowEntry;
	largeSwallowtailAttackArrow: SwallowtailAttackEntry;
	largeCurvedArrow: CurvedArrowEntry;
}

/**
 * Builds the initial control-point set for every arrow type at a 1:1 test
 * scale: each arrow body spans ~10 m, and the 5 arrows are spawned at
 * distinct lon/lat slots around the host's rectangle centre so they don't
 * overlap one another or the rectangle/polygon/circle. The spread radius
 * is on the order of 40-60 m so a typical close-up camera (altitude
 * ~50-200 m) can fit the whole scene without zooming back out.
 *
 * Layout (at lat 28°, 1° lon ≈ 98 km, 1° lat ≈ 111 km):
 *
 *           curved (NW, S-shape spans ~30 m)
 *
 *               fineArrow (N, ~12 m pointer east)
 *
 *          [rectangle]  attackArrow (E, ~14 m wedge)
 *
 *               swallowtail (S, ~14 m wedge with V tail)
 *
 *           assaultDirection (SW, ~12 m pointer west)
 *
 * @param centerLon   Longitude of the host demo's rectangle centre.
 * @param centerLat   Latitude of the host demo's rectangle centre.
 * @returns Control-point set per arrow type. Each set already satisfies
 *          the arrow factory's minimum-point requirement.
 */
function buildInitialControlPoints(
	centerLon: number,
	centerLat: number,
): Record<ArrowPlotId, LonLatPoint[]> {
	// Convenience constants for "N metres in degrees" at lat 28°. lat is
	// independent (111 km/°), lon shrinks with cos(lat) ≈ cos(28°) ≈ 0.883
	// at this latitude (1 m ≈ 1.02e-5 deg lon, 1 m ≈ 9.01e-6 deg lat).
	const mLon = 1.02e-5;
	const mLat = 9.01e-6;

	const smallPoints: Record<ArrowKind, LonLatPoint[]> = {
		// 2-point fine arrow, ~12 m long, pointing east, 40 m north of centre
		fineArrow: [
			[ centerLon - 6.0 * mLon, centerLat + 40.0 * mLat ],
			[ centerLon + 6.0 * mLon, centerLat + 40.0 * mLat ],
		],
		// 2-point assault direction, ~12 m long, pointing west, 60 m SW of centre
		assaultDirection: [
			[ centerLon - 25.0 * mLon, centerLat - 55.0 * mLat ],
			[ centerLon - 37.0 * mLon, centerLat - 55.0 * mLat ],
		],
		// 4-point attack arrow, ~18 m total, pointing east, 50 m east of centre.
		// Keep the tail narrow at meter scale; otherwise the attack body
		// degenerates visually into a broad triangle.
		attackArrow: [
			[ centerLon + 40.0 * mLon, centerLat + 1.5 * mLat ],
			[ centerLon + 40.0 * mLon, centerLat - 1.5 * mLat ],
			[ centerLon + 50.0 * mLon, centerLat + 0.0 * mLat ],
			[ centerLon + 58.0 * mLon, centerLat + 0.0 * mLat ],
		],
		// 4-point swallowtail attack arrow, ~18 m total, pointing east,
		// 40 m south of centre
		swallowtailAttackArrow: [
			[ centerLon - 4.0 * mLon, centerLat - 38.5 * mLat ],
			[ centerLon - 4.0 * mLon, centerLat - 41.5 * mLat ],
			[ centerLon + 6.0 * mLon, centerLat - 40.0 * mLat ],
			[ centerLon + 14.0 * mLon, centerLat - 40.0 * mLat ],
		],
		// 4-point curved arrow, ~30 m S-curve, NW of centre
		curvedArrow: [
			[ centerLon - 55.0 * mLon, centerLat + 30.0 * mLat ],
			[ centerLon - 45.0 * mLon, centerLat + 38.0 * mLat ],
			[ centerLon - 32.0 * mLon, centerLat + 30.0 * mLat ],
			[ centerLon - 22.0 * mLon, centerLat + 38.0 * mLat ],
		],
	};

	const largeCenterLon = centerLon + 0.018;
	const largeCenterLat = centerLat + 0.13;
	const kmLon = 1000.0 * mLon;
	const kmLat = 1000.0 * mLat;
	const largePoints: Record<
		| 'largeFineArrow'
		| 'largeAssaultDirection'
		| 'largeAttackArrow'
		| 'largeSwallowtailAttackArrow'
		| 'largeCurvedArrow',
		LonLatPoint[]
	> = {
		largeFineArrow: [
			[ largeCenterLon - 5.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
			[ largeCenterLon + 5.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
		],
		largeAssaultDirection: [
			[ largeCenterLon - 3.0 * kmLon, largeCenterLat - 8.0 * kmLat ],
			[ largeCenterLon - 10.0 * kmLon, largeCenterLat - 8.0 * kmLat ],
		],
		largeAttackArrow: [
			[ largeCenterLon + 4.0 * kmLon, largeCenterLat + 1.8 * kmLat ],
			[ largeCenterLon + 4.0 * kmLon, largeCenterLat - 1.8 * kmLat ],
			[ largeCenterLon + 10.0 * kmLon, largeCenterLat + 0.0 * kmLat ],
			[ largeCenterLon + 14.0 * kmLon, largeCenterLat + 0.0 * kmLat ],
		],
		largeSwallowtailAttackArrow: [
			[ largeCenterLon - 2.5 * kmLon, largeCenterLat - 4.0 * kmLat ],
			[ largeCenterLon - 2.5 * kmLon, largeCenterLat - 7.5 * kmLat ],
			[ largeCenterLon + 3.5 * kmLon, largeCenterLat - 5.75 * kmLat ],
			[ largeCenterLon + 9.0 * kmLon, largeCenterLat - 5.75 * kmLat ],
		],
		largeCurvedArrow: [
			[ largeCenterLon - 12.0 * kmLon, largeCenterLat + 1.5 * kmLat ],
			[ largeCenterLon - 8.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
			[ largeCenterLon - 2.0 * kmLon, largeCenterLat + 1.5 * kmLat ],
			[ largeCenterLon + 2.0 * kmLon, largeCenterLat + 6.0 * kmLat ],
		],
	};

	return { ...smallPoints, ...largePoints };
}

/**
 * Validates and parses a JSON text field into an array of `[lon, lat]` pairs.
 * Mirrors the rectangle / polygon parse helpers in ground-demo.ts so error
 * messages stay consistent across the demo.
 *
 * @param value         JSON text typed in lil-gui.
 * @param label         Human-readable arrow name used in error messages.
 * @param minimumPoints Per-arrow minimum control-point count.
 * @returns Validated lon/lat array.
 * @throws Error if the input fails any structural / numeric check.
 */
function parseArrowPointsText(
	value: string,
	label: string,
	minimumPoints: number,
): LonLatPoint[] {
	const parsed = JSON.parse( value ) as unknown;
	if ( ! Array.isArray( parsed ) || parsed.length < minimumPoints ) {
		throw new Error(
			`${ label } points must be JSON with at least ${ minimumPoints } [lon, lat] pairs.`,
		);
	}

	return parsed.map( ( point ) => {
		if ( ! Array.isArray( point ) || point.length !== 2 ) {
			throw new Error( `Each ${ label } point must be a [lon, lat] pair.` );
		}
		const longitude = Number( point[ 0 ] );
		const latitude = Number( point[ 1 ] );
		if ( ! Number.isFinite( longitude ) || ! Number.isFinite( latitude ) ) {
			throw new Error( `${ label } point coordinates must be finite numbers.` );
		}
		return [ longitude, latitude ] as LonLatPoint;
	} );
}

/**
 * Per-arrow minimum control-point count, derived from each factory's
 * documented contract in `src/lib/arrow/README.md`.
 */
const ARROW_MINIMUM_POINTS: Record<ArrowPlotId, number> = {
	fineArrow: 2,
	assaultDirection: 2,
	attackArrow: 3,
	swallowtailAttackArrow: 3,
	curvedArrow: 2,
	largeFineArrow: 2,
	largeAssaultDirection: 2,
	largeAttackArrow: 3,
	largeSwallowtailAttackArrow: 3,
	largeCurvedArrow: 2,
};

/**
 * Calls the right arrow factory for the entry's `kind` discriminant.
 * Returns an empty array when the input is degenerate (so the caller can
 * skip primitive construction without throwing).
 *
 * @param entry Arrow entry containing parsed points + current options.
 * @returns Closed CCW polygon ring; empty when the input is degenerate.
 */
function computeArrowRing( entry: ArrowEntry ): ArrowPolygon {
	switch ( entry.kind ) {
		case 'fineArrow':
			if ( entry.points.length < 2 ) {
				return [];
			}
			return createFineArrow( entry.points[ 0 ], entry.points[ 1 ], entry.options );

		case 'assaultDirection':
			if ( entry.points.length < 2 ) {
				return [];
			}
			return createAssaultDirectionArrow(
				entry.points[ 0 ],
				entry.points[ 1 ],
				entry.options,
			);

		case 'attackArrow':
			return createAttackArrow( entry.points, entry.options );

		case 'swallowtailAttackArrow':
			return createSwallowtailAttackArrow( entry.points, entry.options );

		case 'curvedArrow':
			return createCurvedArrow( entry.points, entry.options );
	}
}

/**
 * Options consumed by the arrow subsystem constructor.
 */
export interface ArrowSubsystemOptions {
	/** Three.js scene to which classification groups are added / removed. */
	scene: Scene;
	/** Parent lil-gui where the per-arrow folders are appended. */
	parentGui: GUI;
	/**
	 * Plot order registry the host owns. The registry's PlotId union must
	 * include {@link ArrowPlotId}; in practice the host widens its own
	 * `DemoPlotId` to include arrow ids and passes the typed registry in.
	 *
	 * Typed as the minimal structural shape {@link ArrowPlotOrderRegistry}
	 * to side-step the host registry's invariant generic parameter (see the
	 * interface JSDoc above for the variance reasoning).
	 */
	plotOrderRegistry: ArrowPlotOrderRegistry;
	/** Longitude of the host rectangle centre — anchors initial control points. */
	centerLongitude: number;
	/** Latitude of the host rectangle centre — anchors initial control points. */
	centerLatitude: number;
	/** Initial value of the host's `fragmentCull` toggle. */
	fragmentCull: boolean;
	/** Initial state of the host's `Passes` toggle group. */
	passVisibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	};
}

/**
 * Self-contained arrow plotting subsystem. Construct once during demo boot,
 * call `update(frameState)` every frame from the host render loop, and
 * `dispose()` only on shutdown.
 */
export class ArrowSubsystem {
	private readonly scene: Scene;
	private readonly registry: ArrowPlotOrderRegistry;
	private readonly entries: ArrowEntryByKind;
	private readonly orderedEntries: ArrowEntry[];
	private fragmentCull: boolean;
	private passVisibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	};

	public constructor( options: ArrowSubsystemOptions ) {
		this.scene = options.scene;
		this.registry = options.plotOrderRegistry;
		this.fragmentCull = options.fragmentCull;
		this.passVisibility = { ...options.passVisibility };

		const initialPoints = buildInitialControlPoints(
			options.centerLongitude,
			options.centerLatitude,
		);

		// Reserve a plot order per arrow before any primitive is built so the
		// initial render order matches the documented PREFERRED_PLOT_ORDERS.
		const reservedPlotOrders: Record<ArrowPlotId, number> = {} as Record<
			ArrowPlotId,
			number
		>;
		for ( const id of ARROW_PLOT_IDS ) {
			reservedPlotOrders[ id ] = this.registry.register(
				id,
				PREFERRED_PLOT_ORDERS[ id ],
			);
		}

		this.entries = {
			fineArrow: this.createEntry(
				'fineArrow',
				'fineArrow',
				initialPoints.fineArrow,
				reservedPlotOrders.fineArrow,
				DEFAULT_FINE_ARROW_OPTIONS,
			) as FineArrowEntry,
			assaultDirection: this.createEntry(
				'assaultDirection',
				'assaultDirection',
				initialPoints.assaultDirection,
				reservedPlotOrders.assaultDirection,
				DEFAULT_ASSAULT_DIRECTION_OPTIONS,
			) as AssaultDirectionEntry,
			attackArrow: this.createEntry(
				'attackArrow',
				'attackArrow',
				initialPoints.attackArrow,
				reservedPlotOrders.attackArrow,
				DEFAULT_ATTACK_ARROW_OPTIONS,
			) as AttackArrowEntry,
			swallowtailAttackArrow: this.createEntry(
				'swallowtailAttackArrow',
				'swallowtailAttackArrow',
				initialPoints.swallowtailAttackArrow,
				reservedPlotOrders.swallowtailAttackArrow,
				DEFAULT_SWALLOWTAIL_OPTIONS,
			) as SwallowtailAttackEntry,
			curvedArrow: this.createEntry(
				'curvedArrow',
				'curvedArrow',
				initialPoints.curvedArrow,
				reservedPlotOrders.curvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
			) as CurvedArrowEntry,
			largeFineArrow: this.createEntry(
				'largeFineArrow',
				'fineArrow',
				initialPoints.largeFineArrow,
				reservedPlotOrders.largeFineArrow,
				DEFAULT_FINE_ARROW_OPTIONS,
				100.0,
			) as FineArrowEntry,
			largeAssaultDirection: this.createEntry(
				'largeAssaultDirection',
				'assaultDirection',
				initialPoints.largeAssaultDirection,
				reservedPlotOrders.largeAssaultDirection,
				DEFAULT_ASSAULT_DIRECTION_OPTIONS,
				100.0,
			) as AssaultDirectionEntry,
			largeAttackArrow: this.createEntry(
				'largeAttackArrow',
				'attackArrow',
				initialPoints.largeAttackArrow,
				reservedPlotOrders.largeAttackArrow,
				DEFAULT_ATTACK_ARROW_OPTIONS,
				100.0,
			) as AttackArrowEntry,
			largeSwallowtailAttackArrow: this.createEntry(
				'largeSwallowtailAttackArrow',
				'swallowtailAttackArrow',
				initialPoints.largeSwallowtailAttackArrow,
				reservedPlotOrders.largeSwallowtailAttackArrow,
				DEFAULT_SWALLOWTAIL_OPTIONS,
				100.0,
			) as SwallowtailAttackEntry,
			largeCurvedArrow: this.createEntry(
				'largeCurvedArrow',
				'curvedArrow',
				initialPoints.largeCurvedArrow,
				reservedPlotOrders.largeCurvedArrow,
				DEFAULT_CURVED_ARROW_OPTIONS,
				100.0,
			) as CurvedArrowEntry,
		};

		this.orderedEntries = ARROW_PLOT_IDS.map( ( id ) => this.entries[ id ] );

		// Build all primitives + add them to the scene.
		for ( const entry of this.orderedEntries ) {
			this.rebuildPrimitive( entry );
		}

		this.applyAllSettings();
		this.installGuiFolders( options.parentGui );
	}

	/**
	 * Forwards the host's per-frame frame state to every arrow primitive.
	 *
	 * @param frameState Depth texture + viewport / camera state from the host.
	 */
	public update( frameState: CesiumGroundFrameState ): void {
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.update( frameState );
		}
	}

	/**
	 * Pushes the host's current `fragmentCull` flag into every primitive.
	 * Called from the host's `applyGroundDebugSettings()` so the GUI knob
	 * stays a single source of truth.
	 *
	 * @param fragmentCull Whether the fragment-cull classification path runs.
	 */
	public applyFragmentCull( fragmentCull: boolean ): void {
		this.fragmentCull = fragmentCull;
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.classification.setFragmentCulling( fragmentCull );
		}
	}

	/**
	 * Pushes the host's `Passes` toggle state into every primitive.
	 *
	 * @param visibility Whether front-stencil / back-stencil / color passes run.
	 */
	public applyPassVisibility( visibility: {
		frontStencil: boolean;
		backStencil: boolean;
		color: boolean;
	} ): void {
		this.passVisibility = { ...visibility };
		for ( const entry of this.orderedEntries ) {
			entry.primitive?.classification.setCommandVisibility( {
				frontStencil: visibility.frontStencil,
				backStencil: visibility.backStencil,
				color: visibility.color,
			} );
		}
	}

	/**
	 * Reapplies fill / stroke / visibility / render-order to every primitive,
	 * without rebuilding geometry. Use after broad state changes.
	 */
	public applyAllSettings(): void {
		for ( const entry of this.orderedEntries ) {
			this.applyEntrySettings( entry );
		}
	}

	/**
	 * Returns one line of info text per arrow, used to enrich the host's
	 * fixed info-panel block.
	 *
	 * @returns Lines like `"Fine Arrow: on / order 3 / pts 2 / ring 8"`.
	 */
	public getInfoLines(): string[] {
		return this.orderedEntries.map( ( entry ) => {
			const state = entry.visible ? 'on' : 'off';
			const ringSize = entry.primitive
				? entry.primitive.polygonHierarchy.positions.length
				: 0;
			return (
				`${ entry.label }: ${ state } / order ${ entry.plotOrder } / ` +
				`pts ${ entry.points.length } / ring ${ ringSize }`
			);
		} );
	}

	/**
	 * Removes classification groups from the scene + disposes all primitives.
	 */
	public dispose(): void {
		for ( const entry of this.orderedEntries ) {
			if ( entry.primitive ) {
				this.scene.remove( entry.primitive.classification.group );
				entry.primitive.dispose();
				entry.primitive = null;
			}
		}
	}

	// ── Entry / primitive lifecycle ────────────────────────────────────

	/**
	 * Allocates one ArrowEntry with default shared state. The concrete
	 * `kind` + `options` types are upcast via the caller's `as` because the
	 * generic `BaseArrowEntry` shape doesn't carry the discriminant.
	 *
	 * @param id          Stable plot id used by render-order registration.
	 * @param kind        Arrow geometry kind (drives the factory dispatch).
	 * @param points      Initial control points (already validated to satisfy
	 *                    the per-kind minimum).
	 * @param plotOrder   Unique plot order pre-allocated from the registry.
	 * @param options     Default factory options snapshot for this kind.
	 * @param strokeWidth Default stroke width in meters.
	 * @returns A loosely-typed base entry to be downcast by the caller.
	 */
	private createEntry(
		id: ArrowPlotId,
		kind: ArrowKind,
		points: LonLatPoint[],
		plotOrder: number,
		options: Required<
			| FineArrowOptions
			| AssaultDirectionArrowOptions
			| AttackArrowOptions
			| SwallowtailAttackArrowOptions
			| CurvedArrowOptions
		>,
		strokeWidth = DEFAULT_STROKE_WIDTH_METERS,
	): ArrowEntry {
		const entry = {
			id,
			kind,
			label: ARROW_LABELS[ id ],
			visible: true,
			plotOrder,
			pointsJson: JSON.stringify( points ),
			points: points.map( ( p ) => [ p[ 0 ], p[ 1 ] ] as LonLatPoint ),
			fillColor: ARROW_FILL_COLORS[ id ],
			fillOpacity: DEFAULT_FILL_OPACITY,
			strokeColor: DEFAULT_STROKE_COLOR,
			strokeOpacity: DEFAULT_STROKE_OPACITY,
			strokeWidth,
			// Cast through unknown: the options shape varies by kind and the
			// caller does the final `as FineArrowEntry` style downcast.
			options: { ...options },
			primitive: null,
		} as unknown as ArrowEntry;
		return entry;
	}

	/**
	 * Disposes the entry's current primitive (if any), regenerates the arrow
	 * ring via the appropriate factory, and rebuilds the primitive. The
	 * scene graph is updated atomically so the screen never shows a
	 * half-constructed arrow.
	 *
	 * @param entry Arrow entry whose geometry or points changed.
	 */
	private rebuildPrimitive( entry: ArrowEntry ): void {
		// Tear down the previous primitive first.
		if ( entry.primitive ) {
			this.scene.remove( entry.primitive.classification.group );
			entry.primitive.dispose();
			entry.primitive = null;
		}

		const ring = computeArrowRing( entry );
		if ( ring.length < 3 ) {
			// Degenerate input → no primitive. The GUI text field still keeps
			// the user-entered JSON so they can fix it; the info panel will
			// report `ring 0`.
			console.warn(
				`[arrow-demo] ${ entry.label }: degenerate input, primitive skipped.`,
			);
			return;
		}

		entry.primitive = new CesiumGroundPolygonPrimitive( {
			points: ring,
			strokeColor: entry.strokeColor,
			strokeWidth: entry.strokeWidth,
			strokeOpacity: entry.strokeOpacity,
			fillColor: entry.fillColor,
			fillOpacity: entry.fillOpacity,
			visible: entry.visible,
			renderOrder: plotOrderToRenderOrder( entry.plotOrder ),
			fragmentCull: this.fragmentCull,
		} );
		this.scene.add( entry.primitive.classification.group );

		this.applyEntrySettings( entry );
	}

	/**
	 * Reapplies fill / stroke / visibility / render-order / pass visibility /
	 * fragment-cull for a single entry without rebuilding geometry.
	 *
	 * @param entry Arrow entry whose non-geometry state changed.
	 */
	private applyEntrySettings( entry: ArrowEntry ): void {
		const primitive = entry.primitive;
		if ( ! primitive ) {
			return;
		}

		primitive.classification.setColor(
			new Color( entry.fillColor ),
			entry.fillOpacity / 100.0,
		);
		primitive.classification.setFragmentCulling( this.fragmentCull );
		primitive.setRenderOrder( plotOrderToRenderOrder( entry.plotOrder ) );
		primitive.classification.group.visible = entry.visible;
		primitive.classification.setCommandVisibility( {
			frontStencil: this.passVisibility.frontStencil,
			backStencil: this.passVisibility.backStencil,
			color: this.passVisibility.color,
		} );
		primitive.classification.setBorderStyle(
			entry.strokeWidth > 0.0,
			new Color( entry.strokeColor ),
			entry.strokeOpacity / 100.0,
			entry.strokeWidth,
		);
	}

	// ── Plot order ─────────────────────────────────────────────────────

	/**
	 * Pushes an edited plot order back into the registry. The registry may
	 * reject a clash by returning the original order; this method writes
	 * the *registry's chosen* order back into the entry so the lil-gui
	 * `.listen()` field reflects reality.
	 *
	 * @param entry Arrow entry whose plot order GUI value changed.
	 */
	private applyEntryPlotOrder( entry: ArrowEntry ): void {
		entry.plotOrder = this.registry.update( entry.id, entry.plotOrder );
		this.applyEntrySettings( entry );
	}

	// ── GUI construction ───────────────────────────────────────────────

	/**
	 * Installs one collapsed lil-gui folder per arrow under the parent GUI.
	 * Each folder carries the shape's full option set as numeric sliders
	 * plus the shared fill / stroke / visibility controls. Folders start
	 * closed so the GUI stays manageable; users open them on demand.
	 *
	 * @param parentGui Host lil-gui instance from ground-demo.ts.
	 */
	private installGuiFolders( parentGui: GUI ): void {
		const arrowsRoot = parentGui.addFolder( 'Arrows' );
		const smallRoot = arrowsRoot.addFolder( '1:1' );
		const largeRoot = arrowsRoot.addFolder( 'Large Scale' );

		this.installFineArrowFolder( smallRoot, this.entries.fineArrow );
		this.installAssaultDirectionFolder( smallRoot, this.entries.assaultDirection );
		this.installAttackArrowFolder( smallRoot, this.entries.attackArrow );
		this.installSwallowtailFolder( smallRoot, this.entries.swallowtailAttackArrow );
		this.installCurvedArrowFolder( smallRoot, this.entries.curvedArrow );

		this.installFineArrowFolder( largeRoot, this.entries.largeFineArrow );
		this.installAssaultDirectionFolder( largeRoot, this.entries.largeAssaultDirection );
		this.installAttackArrowFolder( largeRoot, this.entries.largeAttackArrow );
		this.installSwallowtailFolder( largeRoot, this.entries.largeSwallowtailAttackArrow );
		this.installCurvedArrowFolder( largeRoot, this.entries.largeCurvedArrow );

		smallRoot.close();
		largeRoot.close();
		arrowsRoot.close();
	}

	/**
	 * Builds the common (shared) controls (visible / plot order / points
	 * JSON / fill / stroke) for one arrow entry. Returns a callback the
	 * shape-specific installer can call after wiring its own sliders.
	 *
	 * @param folder Folder created by the caller (one folder per arrow).
	 * @param entry  Arrow entry the folder edits.
	 */
	private installSharedControls( folder: GUI, entry: ArrowEntry ): void {
		folder
			.add( entry, 'visible' )
			.name( 'visible' )
			.onChange( () => this.applyEntrySettings( entry ) );

		folder
			.add( entry, 'plotOrder', 0, 100, 1 )
			.name( 'plot order' )
			.onChange( () => this.applyEntryPlotOrder( entry ) )
			.listen();

		folder
			.add( entry, 'pointsJson' )
			.name( 'points (JSON)' )
			.onFinishChange( ( value: string ) =>
				this.applyPointsJsonEdit( entry, value ),
			)
			.listen();

		folder
			.addColor( entry, 'fillColor' )
			.name( 'fillColor' )
			.onChange( () => this.applyEntrySettings( entry ) );
		folder
			.add( entry, 'fillOpacity', 0.0, 100.0, 1.0 )
			.name( 'fillOpacity' )
			.onChange( () => this.applyEntrySettings( entry ) );

		folder
			.addColor( entry, 'strokeColor' )
			.name( 'strokeColor' )
			.onChange( () => this.applyEntrySettings( entry ) );
		folder
			.add( entry, 'strokeWidth', 0.0, 20.0, 0.25 )
			.name( 'strokeWidth' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		folder
			.add( entry, 'strokeOpacity', 0.0, 100.0, 1.0 )
			.name( 'strokeOpacity' )
			.onChange( () => this.applyEntrySettings( entry ) );
	}

	/**
	 * Applies a JSON text edit to the entry's `points` field, with rollback
	 * on parse error (matches the host rectangle / polygon GUI behaviour).
	 *
	 * @param entry Arrow entry receiving new points.
	 * @param value Raw JSON text from the lil-gui field.
	 */
	private applyPointsJsonEdit( entry: ArrowEntry, value: string ): void {
		try {
			const parsed = parseArrowPointsText(
				value,
				entry.label,
				ARROW_MINIMUM_POINTS[ entry.kind ],
			);
			entry.points = parsed;
			entry.pointsJson = JSON.stringify( parsed );
			this.rebuildPrimitive( entry );
		} catch ( error ) {
			console.error( error );
			// Restore the previous valid JSON so the GUI field reverts.
			entry.pointsJson = JSON.stringify( entry.points );
		}
	}

	private installFineArrowFolder( parent: GUI, entry: FineArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		// Geometry-affecting options: rebuild on finishChange to keep the GUI
		// responsive during scrubbing (rebuild is only on release).
		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'tailWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'headWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'headAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'neckAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		folder.close();
	}

	private installAssaultDirectionFolder(
		parent: GUI,
		entry: AssaultDirectionEntry,
	): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'lengthScale', 0.25, 4.0, 0.05 )
			.name( 'lengthScale' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'tailWidthFactor', 0.01, 0.30, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'neckWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'headWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'headAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckAngleRadians', 0.0, Math.PI / 2.0, 0.005 )
			.name( 'neckAngle rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		folder.close();
	}

	private installAttackArrowFolder( parent: GUI, entry: AttackArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'headHeightFactor', 0.05, 0.60, 0.005 )
			.name( 'headHeight /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.10, 0.80, 0.01 )
			.name( 'headWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckHeightFactor', 0.20, 1.00, 0.01 )
			.name( 'neckHeight /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headTailFactor', 0.20, 1.50, 0.01 )
			.name( 'headTail clamp' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		const robust = folder.addFolder( 'Robustness' );
		robust
			.add(
				entry.options,
				'minBodyHalfAngleRadians',
				0.0,
				Math.PI / 4.0,
				0.005,
			)
			.name( 'minBodyHalf rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodyWidthMargin', 0.80, 2.00, 0.01 )
			.name( 'bodyWidth margin' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodySmoothingSegments', 2, 32, 1 )
			.name( 'body samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust.close();

		folder.close();
	}

	private installSwallowtailFolder(
		parent: GUI,
		entry: SwallowtailAttackEntry,
	): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'headHeightFactor', 0.05, 0.60, 0.005 )
			.name( 'headHeight /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.10, 0.80, 0.01 )
			.name( 'headWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckHeightFactor', 0.20, 1.00, 0.01 )
			.name( 'neckHeight /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthFactor', 0.05, 0.60, 0.005 )
			.name( 'neckWidth /H' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headTailFactor', 0.20, 1.50, 0.01 )
			.name( 'headTail clamp' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		const swallow = folder.addFolder( 'Swallowtail' );
		swallow
			.add( entry.options, 'swallowtailFactor', 0.0, 3.0, 0.01 )
			.name( 'depth factor' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		swallow
			.add( entry.options, 'tailWidthFactor', 0.02, 0.30, 0.005 )
			.name( 'tailWidth /L' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		swallow.close();

		const robust = folder.addFolder( 'Robustness' );
		robust
			.add(
				entry.options,
				'minBodyHalfAngleRadians',
				0.0,
				Math.PI / 4.0,
				0.005,
			)
			.name( 'minBodyHalf rad' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodyWidthMargin', 0.80, 2.00, 0.01 )
			.name( 'bodyWidth margin' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust
			.add( entry.options, 'bodySmoothingSegments', 2, 32, 1 )
			.name( 'body samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		robust.close();

		folder.close();
	}

	private installCurvedArrowFolder( parent: GUI, entry: CurvedArrowEntry ): void {
		const folder = parent.addFolder( entry.label );
		this.installSharedControls( folder, entry );

		const geom = folder.addFolder( 'Geometry' );
		geom
			.add( entry.options, 'bodyWidthFactor', 0.005, 0.20, 0.005 )
			.name( 'bodyWidth /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headWidthFactor', 0.02, 0.40, 0.005 )
			.name( 'headWidth /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'headLengthFactor', 0.02, 0.40, 0.005 )
			.name( 'headLength /arc' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'neckWidthRelativeToHead', 0.05, 0.95, 0.01 )
			.name( 'neck/head' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'bodyTaperRatio', 0.0, 1.0, 0.01 )
			.name( 'bodyTaper' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom
			.add( entry.options, 'curveSmoothingSegments', 2, 64, 1 )
			.name( 'curve samples' )
			.onFinishChange( () => this.rebuildPrimitive( entry ) );
		geom.close();

		folder.close();
	}
}
