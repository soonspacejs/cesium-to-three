// ============================================================
// env.ts
// Layer: demo configuration helpers.
// Role: read typed Vite environment variables for the ground demo.
// Dependencies: Vite import.meta.env.
// Consumed by: ground-demo.ts and tiles.ts.
// ============================================================

/**
 * Reads one numeric Vite environment variable.
 *
 * @param name Vite environment variable name.
 * @param fallback Value used when the variable is absent or invalid.
 * @returns Parsed finite number.
 */
export function readNumberEnv( name: string, fallback: number ): number {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	const value = raw === undefined ? Number.NaN : Number( raw );
	return Number.isFinite( value ) ? value : fallback;
}

/**
 * Reads one string Vite environment variable.
 *
 * @param name Vite environment variable name.
 * @param fallback Value used when the variable is absent.
 * @returns Trimmed string value.
 */
export function readStringEnv( name: string, fallback = '' ): string {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	return ( raw ?? fallback ).trim();
}
