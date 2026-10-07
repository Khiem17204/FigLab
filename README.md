# FigLab

Build publication-ready scientific figures from your original images without ever altering them.

**Live:** https://figlab.netlify.app

## Features

- **Accounts** — sign up with email and password, verify your email, and keep a private
  workspace.
- **Projects** — create, rename, open, and delete figure projects.
- **Immutable originals** — upload PNG, JPEG, and 8/16-bit TIFF images; each file is
  checksum-verified and never modified (derived previews are stored beside it).
- **Reproducible crops** — drag to crop panels from an original; every panel keeps an exact
  link back to its source ("Show in Original").
- **Non-destructive adjustments** — brightness, contrast, gamma, and invert, with move, resize,
  delete, and undo/redo.
- **Autosave with conflict protection** — every change is versioned; a second tab can't
  silently overwrite your work.
- **Figures and annotations** — several figures per project sized to journal columns (Nature,
  Cell Press, PNAS, PLOS) or custom; text with symbol shortcuts, lines, arrows, rectangles,
  ellipses, and brackets; automatic panel letters.
- **Arrange** — multi-select, align, distribute, snapping guides, grouping, layers, lock, and
  duplicate.
- **Faithful export** — PNG, TIFF, SVG, or PDF at 300/600 dpi or custom, rendered from original
  pixels, one figure or all at once, with provenance recorded for every file.
- **History** — an audit trail of who changed what, saved versions you can restore, and export
  records.
- **Blots** — band crops along tilted lanes, ladder marking with kDa labels, lane label tables,
  densitometry normalized to a loading control, with CSV export.
- **Microscopy** — multi-page, tiled, OME and BigTIFF; levels, lookup tables, channel split and
  merge; calibrated scale bars; linked zoom insets.
- **Integrity evidence** — per-panel reports of crops, adjustments, saturation, and checks such
  as missing loading controls; a provenance bundle with uncropped originals for reviewers.
- **Labs** — shared workspaces with owner/admin/editor/viewer roles and copyable invite links,
  folders, search, templates, comment threads, and an admin overview.

## Tech stack

| Layer | Technology |
| --- | --- |
| Web app | React 19, Vite 8, PixiJS 8, Zustand, TanStack Query |
| API | Fastify 5, TypeBox, OpenAPI |
| Background jobs | Graphile Worker on PostgreSQL, sharp, geotiff |
| Auth, database, storage | Supabase (Auth, Postgres 17, Storage) |
| Hosting | Netlify (static site, Functions, background and scheduled functions) |
| Self-hosted option | Docker Compose with Caddy, PostgreSQL, MinIO |
| Tooling | TypeScript, pnpm workspaces, Turborepo, Biome, Vitest, Playwright |

Licensed AGPL-3.0-only. Engineering guide: [CLAUDE.md](CLAUDE.md).
