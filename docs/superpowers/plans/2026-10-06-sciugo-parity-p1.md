# Sciugo Parity P1 — Implementation Plan

P1 covers blot, microscopy, and integrity work from the
[audit](../specs/2026-10-06-sciugo-parity-audit.md). P0 is done; see its plan. Each step lands as
its own commits with tests.

## Schema v3 (`packages/figure-schema/src/v3.ts`)

### Source registry

`sources[] = { assetId, widthPx, heightPx, calibration, markers }`

- `calibration` is `{ umPerPxX, umPerPxY, origin: "metadata" | "manual" } | null`.
- `markers` is `[{ yPx, kDa }]`, the molecular-weight ladder positions in the original's pixels.
- The registry holds geometry and measurement facts only: no raster bytes, no storage keys.
- The API checks every entry's size against the verified asset on save.
- Every rotated view, composite, scale bar, MW label, and zoom link needs an entry for its asset.

### Image views

New fields:

- `plane`: the page/IFD of a multi-page TIFF.
- `channel`: one sample of a multi-sample pixel, or null for all.
- `rotationDeg`: the crop rectangle's rotation about its center, in source pixel space.
- `flipX` and `flipY`.
- `display.levels {black, white}`: normalized input range.
- `display.lut`: `none`, gray, red, green, blue, cyan, magenta, or yellow.

Rotated corners must stay inside the source.

### New objects

- **`composite`**: an additive merge of 1–8 channels sharing one viewport. Every channel's source
  must have the same pixel size.
- **`scale-bar`**:
  - attached to a view;
  - stores a length in µm;
  - its width is derived from calibration and panel scale.
- **`zoom-link`**:
  - the source box on one panel is derived from another panel's viewport, plus optional connector
    lines;
  - both panels must show the same asset.
- **`lane-table`**:
  - rows of cells (`text`, `span`, `underline`) above or below a blot panel;
  - columns follow the lane centers (even spacing, or explicit normalized centers).
- **`mw-labels`**: ticks and kDa labels beside a panel, for the asset's markers that fall inside
  its crop.

### Derived objects and migration

- Derived objects keep `transform` in sync with their derived bounds through
  `syncDerivedObjects`. The renderer always derives geometry; it never trusts a stored width.
- Migration from v2 to v3:
  - every view gets `plane 0`, `channel null`, rotation 0, no flips, identity levels, and LUT
    `none`;
  - `sources` starts empty;
  - v2 renders identically after migration.

## Math (`packages/image-processing`)

- Sampling: normalize the sample, apply levels, then the v1 pipeline, then the LUT.
  - The channel selects one sample.
  - A LUT on a multi-sample pixel with no channel uses Rec. 709 luminance, which the integrity
    report flags.
- `renderViewRgba` is shared by preview and export.
  - Axis-aligned crops sample nearest-neighbour, so exact source values are kept.
  - Rotated crops sample bilinearly.
- Composites sum the channels' LUT colors and clamp.
- `viewMapping` maps source pixel coordinates to panel coordinates and back. Zoom links, MW
  labels, and the uncropped sheet use it.

## Ingestion

- TIFF accepts tiled layouts, BigTIFF, and multi-page files with consistent page geometry.
  Reduced-resolution pages are skipped.
- OME-TIFF is parsed for channel names, plane order, and `PhysicalSizeX/Y`.
- Calibration comes from:
  - an ImageJ `unit=` description with X/YResolution;
  - OME physical size;
  - a TIFF centimetre resolution unit.

  An inch resolution unit is print DPI and is ignored.
- Asset metadata gains `planes`, `planeLabels`, and `calibration`. The verifier and the browser
  worker share the parser.

## Integrity

- `buildIntegrityReport(document, revision, sources, resolver)` is pure, and the browser and a
  Graphile job share it. Per panel it records:
  - asset SHA-256 and the crop in source pixels;
  - rotation and resampling, flips, plane, and channel;
  - levels, gamma, LUT, and invert;
  - the share of crop pixels clipped by the display mapping;
  - source saturation;
  - linear or non-linear classification;
  - calibration origin;
  - overlapping crops and duplicate checksums.

  It also suggests text for the figure legend.
- The comparison view shows the original window next to the processed crop, with histograms.
- The provenance bundle is a zip of:
  - the figures;
  - `figure.json`;
  - the integrity report as JSON and HTML;
  - the uncropped-blot sheet as a PDF;
  - `crops.csv`.

## UI (new files in `apps/web/src/figure-tools`)

- Source inspector: rectangle or line crop, ladder marking with a catalog, and calibration.
- View inspector: rotation, flips, plane, channel, levels with a histogram, and LUT.
- Microscopy: channels to a row, and a merge.
- Blot: lane table and MW labels.
- Annotation: scale bar and zoom link.
- Integrity panel: report, comparison, and bundle.

## Database

Migration `0004` (applied only after approval):

- `integrity_reports`, with the report JSON per revision;
- `export_records.format` adds `zip`.
