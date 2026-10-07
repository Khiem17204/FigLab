# FigLab

Build publication-ready scientific figures from your original images without ever altering them.

**Live:** https://figlab.netlify.app

## Features

- **Accounts** — sign up with email and password, verify your email, and keep a private workspace.
- **Projects** — create, rename, open, and delete figure projects.
- **Immutable originals** — upload PNG, JPEG, and 8/16-bit TIFF images; each file is
  checksum-verified and never modified.
- **Reproducible crops** — drag to crop panels from an original; every panel keeps an exact
  link back to its source ("Show in Original").
- **Non-destructive adjustments** — brightness, contrast, gamma, and invert, with move, resize,
  delete, and undo/redo.
- **Autosave with conflict protection** — every change is versioned; a second tab can't
  silently overwrite your work.
- **Faithful export** — PNG rendered from original pixels at the size you choose, with
  provenance recorded.

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
