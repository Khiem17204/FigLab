# Deterministic fixtures

- `api/prepare-upload-request.json` is the canonical 1 KiB upload reservation payload.
- `figure-document-v1.json` is the smallest non-empty persisted v1 figure document.
- `raster/checkerboard-2x2.pgm` is a four-pixel, 8-bit grayscale source fixture. Its pixels are
  encoded in portable ASCII form: black, white, white, black.

These files contain no timestamps, randomized IDs, or environment-specific paths.
