# Ground Material test matrix

This directory is the executable acceptance suite for
`docs/animation-material`. Tests are split by what they prove:

- `unit/` verifies value semantics, validation, versioning, logical cache keys,
  cloning and ownership without a browser.
- `integration/` compiles and renders the real GLSL3 programs in Chromium
  WebGL2, including classification and Raw Appearance failure cases.
- `visual/` compares deterministic keyframes and legacy default rendering.
- `perf/` checks program-object stability, compiled-material allocation and GPU
  resource counts after warm-up.
- `fixtures/` contains browser scenes and their immutable baseline metadata.

The baseline was recorded before Material runtime code was changed. A visual
golden update must be committed separately and explain why the expected pixels
changed; implementation commits must not silently re-record images.
