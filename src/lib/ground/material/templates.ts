// ============================================================
// material/templates.ts
// Purpose: copy-ready safe shader entry points. Applications can start from
//          these exports without reading compiler-owned default shader source.
// ============================================================

/**
 * Copy-ready no-op vertex hook.
 *
 * `vertexInput.positionEC` is the conservative Ground vertex in eye-coordinate
 * meters. Modify only `vertexOutput.positionClip`; the system applies the same
 * hook to every required pass and retains ownership of projection/depth state.
 */
export const C23_GROUND_VERTEX_SHADER_TEMPLATE = /* glsl */ `
void c23_vertexMain(
	c23_vertexInput vertexInput,
	inout c23_vertexOutput vertexOutput
) {
	// Example screen-space wave (uncomment and tune):
	// float wave = sin(vertexInput.positionEC.x * 0.01 + c23_time * 2.0);
	// vertexOutput.positionClip.y += wave * vertexOutput.positionClip.w * 0.01;
}
`;

/** Copy-ready pass-through fragment Material for effects that customize this stage. */
export const C23_GROUND_FRAGMENT_SHADER_TEMPLATE = /* glsl */ `
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material material;
	material.diffuse = materialInput.baseColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = materialInput.baseColor.a;
	return material;
}
`;

/** Wraps animation statements in the exact safe vertex entry signature. */
export function createGroundVertexShader( body: string, declarations = '' ): string {
	if ( typeof body !== 'string' ) {
		throw new TypeError( 'Ground vertex shader body must be a string.' );
	}
	if ( typeof declarations !== 'string' ) {
		throw new TypeError( 'Ground vertex shader declarations must be a string.' );
	}
	return /* glsl */ `
${ declarations }
void c23_vertexMain(
	c23_vertexInput vertexInput,
	inout c23_vertexOutput vertexOutput
) {
${ body }
}
`;
}

/**
 * Builds a valid fragment entry around animation-only statements. The local
 * `material` starts as a pass-through result; the body can override only the
 * fields relevant to the effect instead of recreating ABI boilerplate.
 */
export function createGroundFragmentShader( body: string, declarations = '' ): string {
	if ( typeof body !== 'string' ) {
		throw new TypeError( 'Ground fragment shader body must be a string.' );
	}
	if ( typeof declarations !== 'string' ) {
		throw new TypeError( 'Ground fragment shader declarations must be a string.' );
	}
	return /* glsl */ `
${ declarations }
c23_material c23_getMaterial(c23_materialInput materialInput) {
	c23_material material;
	material.diffuse = materialInput.baseColor.rgb;
	material.emission = vec3(0.0);
	material.alpha = materialInput.baseColor.a;
${ body }
	return material;
}
`;
}
