// ============================================================
// webgl-capabilities.ts
// Purpose: prove that Playwright's deterministic browser can create the exact
//          WebGL2 renderer configuration required by the Ground shader ABI.
// This fixture intentionally renders real geometry. Merely asking the browser
// for a context would not catch shader compilation or a blank software canvas.
// ============================================================

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	Mesh,
	MeshBasicMaterial,
	OrthographicCamera,
	Scene,
	SRGBColorSpace,
	WebGLRenderer,
} from 'three';

export interface WebGlCapabilityReport {
	ready: boolean;
	isWebGL2: boolean;
	drawingBufferWidth: number;
	drawingBufferHeight: number;
	stencilBits: number;
	version: string;
	renderer: string;
	programCount: number;
	centerPixel: [ number, number, number, number ];
}

declare global {
	interface Window {
		/** Set only after the real render and pixel readback have completed. */
		__C23_WEBGL_CAPABILITIES__?: WebGlCapabilityReport;
	}
}

const WIDTH = 960;
const HEIGHT = 640;

/**
 * Creates a deliberately small but real render. The center of the triangle is
 * green and differs strongly from the blue-gray clear color, so one pixel is a
 * sufficient nonblank-canvas sentinel without involving screenshot tolerance.
 */
function renderCapabilityProbe(): WebGlCapabilityReport {
	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false,
		stencil: true,
		preserveDrawingBuffer: true,
		powerPreference: 'high-performance',
	} );
	renderer.setPixelRatio( 1 );
	renderer.setSize( WIDTH, HEIGHT, false );
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.setClearColor( new Color( '#102030' ), 1.0 );
	document.body.appendChild( renderer.domElement );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( [
		- 0.75, - 0.65, 0.0,
		0.75, - 0.65, 0.0,
		0.0, 0.75, 0.0,
	] ), 3 ) );

	const material = new MeshBasicMaterial( { color: '#20e080' } );
	const scene = new Scene();
	scene.add( new Mesh( geometry, material ) );

	const camera = new OrthographicCamera( - 1, 1, 1, - 1, 0.1, 10 );
	camera.position.z = 2;
	camera.lookAt( 0, 0, 0 );
	renderer.render( scene, camera );

	const gl = renderer.getContext();
	const centerPixel = new Uint8Array( 4 );
	// WebGL's origin is bottom-left. The exact center is invariant under the
	// DOM/WebGL origin difference, which keeps this probe independent of flips.
	gl.readPixels(
		WIDTH / 2,
		HEIGHT / 2,
		1,
		1,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		centerPixel,
	);

	const report: WebGlCapabilityReport = {
		ready: true,
		isWebGL2: gl instanceof WebGL2RenderingContext,
		drawingBufferWidth: gl.drawingBufferWidth,
		drawingBufferHeight: gl.drawingBufferHeight,
		stencilBits: Number( gl.getParameter( gl.STENCIL_BITS ) ),
		version: String( gl.getParameter( gl.VERSION ) ),
		renderer: String( gl.getParameter( gl.RENDERER ) ),
		programCount: renderer.info.programs?.length ?? 0,
		centerPixel: [
			centerPixel[ 0 ],
			centerPixel[ 1 ],
			centerPixel[ 2 ],
			centerPixel[ 3 ],
		],
	};

	// The page owns these resources until the report is consumed. Disposing now
	// validates the ordinary Three ownership path without clearing the preserved
	// drawing buffer used by the integration assertion.
	geometry.dispose();
	material.dispose();
	return report;
}

window.__C23_WEBGL_CAPABILITIES__ = renderCapabilityProbe();
