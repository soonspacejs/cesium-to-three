// ============================================================
// env.ts
// 层级:demo 配置辅助模块。
// 职责:按类型读取 Vite 环境变量，供贴地 demo 使用。
// 依赖:Vite import.meta.env。
// 被消费:ground-demo.ts 与 tiles.ts。
// ============================================================

/**
 * 读取一个数值型 Vite 环境变量。
 *
 * @param name Vite 环境变量名称。
 * @param fallback 变量缺失或非法时使用的回退值。
 * @returns 解析后的有限数值。
 */
export function readNumberEnv( name: string, fallback: number ): number {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	const value = raw === undefined ? Number.NaN : Number( raw );
	return Number.isFinite( value ) ? value : fallback;
}

/**
 * 读取一个字符串型 Vite 环境变量。
 *
 * @param name Vite 环境变量名称。
 * @param fallback 变量缺失时使用的回退值。
 * @returns 去掉首尾空白后的字符串值。
 */
export function readStringEnv( name: string, fallback = '' ): string {
	const raw = ( import.meta.env as Record<string, string | undefined> )[ name ];
	return ( raw ?? fallback ).trim();
}
