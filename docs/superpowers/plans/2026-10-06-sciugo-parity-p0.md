# Sciugo Parity P0 — Implementation Plan

Scope: [audit](../specs/2026-10-06-sciugo-parity-audit.md) roadmap P0. Each step lands as its own
commits with tests. UI goes in new component files; existing screens are only touched to mount
them (see the ui-refresh note in `CLAUDE.md`).

## 1. Figure schema v2 (`packages/figure-schema`)

- `FigureDocumentV2`: `schemaVersion: 2`, `artboards[]`, `objects[]` (discriminated union),
  `groups[]`, and empty `constraints`/`styles`.
- Object kinds share `id`, `artboardId`, `transform`, `zIndex`, `locked`, and `hidden`.
  - `image-view`: unchanged from v1. Rotation stays 0 until P1.
  - `text`:
    - `content` holds plain text; Unicode is allowed and `\n` breaks lines.
    - Style: `fontSizePt`, `bold`, `italic`, `underline`, `colorHex`, `align`, and
      `backgroundHex | null`.
    - Optional `panelLabel { targetObjectId, auto }`.
    - It can rotate about its center.
  - `shape`: `line` (direction `down|up`, heads `none|start|end|both`), `rect`, `ellipse`
    (`fillHex | null`), and `bracket` (opening `down|up|left|right`). All share stroke color,
    width, and `dashed`. Lines may have one zero-size dimension, but not both.
- `groups[] = { id, objectIds (≥ 2) }`. Each object is in at most one group, and a group stays on
  one artboard.
- `migrateFigureDocument(input)` dispatches on `schemaVersion`. It turns v1 into v2 (copy
  everything and set `schemaVersion: 2`), validates v2, and rejects future versions. `decode*`
  stays strict per version.
- `JOURNAL_SIZE_PRESETS` are data, each with a source URL. Widths are in mm, converted to points
  at 72/25.4.

## 2. Editor commands (`packages/editor-core`)

Pure `(doc) => doc` commands, each re-validated:

- `createObjectCommand`, `updateObjectCommand`, and `duplicateObjectsCommand`.
- `reorderObjectsCommand` (front, back, forward, backward).
- `setLockedCommand`, `alignObjectsCommand`, and `distributeObjectsCommand`.
- `groupObjectsCommand` and `ungroupCommand`.
- Artboards: `add`, `rename`, `resize`, `duplicate`, `remove`, and `reorder`.
- `addPanelLabelsCommand` and `relabelPanelsCommand` (reading order, A/a/1 style).

Helpers:

- `snapTransform`, which returns a snapped transform plus guides;
- `selectionBounds`;
- `expandSelectionToGroups`;
- `moveObjectsCommand`, which also moves attached panel labels.

## 3. Scene builder and exports (`packages/image-processing`)

- `buildArtboardScene(doc, artboardId, measure)` produces an ordered draw list. Raster panels
  come from originals. Vector primitives (paths, ellipses, positioned text lines, and underline
  paths) carry an optional rotation. Text layout uses an injected `measureText` that reads one
  bundled font, Arimo.
- Renderers:
  - Canvas 2D: preview textures and raster export of vector runs.
  - An SVG string.
  - PDF, through pdf-lib with an embedded Arimo subset.
- Raster composition stays CPU-based from original samples. Vector runs are rasterized by an
  injected browser rasterizer and composited in z-order.
- Encoders: PNG (adds `pHYs` for DPI) and baseline TIFF (RGB 8-bit, Deflate, X/YResolution,
  read back through geotiff in tests).
- Pixel size is `round(sizePt / 72 × dpi)`. The existing edge and pixel limits still apply.
- Batch export packs every artboard into one zip (fflate) in the browser.

## 4. Database and API

- Migration `0003_audit_exports_history.sql`, additive:
  - nullable `audit_events.actor_user_id`;
  - an audit paging index;
  - widen `export_records.format` to png/tiff/pdf/svg;
  - nullable `export_records.artboard_id` and `dpi`;
  - `projects.status` adds `deleted` and gets a `deleted_at` column;
  - a `project_versions(project_id, revision)` index.
- Tombstoned deletion (D4): remove documents, versions, uploads, and assets; keep the project row
  (`deleted`), audit events, and export records.
- New routes:
  - `GET /v1/projects/:id/audit-events` (cursor, newest first, with actor);
  - `GET /v1/projects/:id/versions` and `GET /v1/projects/:id/versions/:revision` (migrated
    document);
  - `GET /v1/projects/:id/exports`.
- Changed routes:
  - The document request accepts v1 or v2. Responses always migrate to v2.
  - The export request takes `format`, `artboardId`, and `dpi`.
- `scripts/generate-openapi.ts` regenerates `openapi/openapi-v1.yaml` (Ruby YAML style).

## 5. Web (new component files)

- Figures list and size presets.
- Tool palette: select, text, line, arrow, rect, ellipse, bracket.
- Multi-select and marquee; snapping guides.
- Arrange menu: align, distribute, order, group, duplicate, lock.
- Panel labels.
- Text and shape inspector.
- Export dialog: format, DPI, preset, all figures as zip.
- History panel: audit trail, versions, restore.

## Verification

Run, in order:

1. `check`
2. `typecheck`
3. `test:unit`
4. `test:integration`, with a disposable `TEST_DATABASE_URL`
5. `build`
6. `test:e2e`
7. `test:visual`
8. `tests/live/hosted.spec.ts`, extended against a draft deploy (no `--prod`), after asking
   before migration 0003 is applied to Supabase
