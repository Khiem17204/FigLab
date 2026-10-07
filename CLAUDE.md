# FigLab — engineering guide

FigLab is a scientific figure editor: upload immutable originals, crop reproducible panels,
adjust display non-destructively, save versioned figures, and export from source pixels.
Production: https://figlab.netlify.app (Netlify site `figlab`) on Supabase project **FigLab**
(`fxfjsjxizojgtzzwputg`, us-west-2). License: AGPL-3.0-only.

## Rules

**Scientific invariants (never break):**
- Originals are immutable. Storage keys are written once; crops never become new assets.
- A crop is a normalized `[0,1]` viewport into exactly one original (`sourceAssetId`).
- Saves are revision compare-and-swap. A stale save gets `409 REVISION_CONFLICT`; local work is
  kept, never silently overwritten.
- Export renders from original samples with the same display math as preview; preview
  quality must never become export quality.
- The figure document never contains raster bytes, storage keys, signed URLs, blobs, Pixi
  objects, selection, history, or pan/zoom.

**Safety:**
- Never deploy to production (`--prod`), push, change Supabase settings, or apply migrations to
  the Supabase project without the user's approval. Use draft deploys
  (`npx netlify-cli deploy --filter @figlab/web`) for previews.
- Never commit secrets. Hosted secrets live in the gitignored `.env.hosted`
  (`FIGLAB_APP_DB_PASSWORD`, `JOBS_TRIGGER_SECRET`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SECRET_KEY`).
- Never point `test:integration` at Supabase; it drops tables. Use a disposable Postgres in
  `TEST_DATABASE_URL`.
- Database migrations must be additive and backward compatible: production is shared and the
  previous deploy may still be running.
- Single-user mode is loopback-only. `ALLOW_INSECURE_SINGLE_USER_REMOTE=true` removes a guard;
  it adds no authentication.

**Code:**
- Strict TypeScript, Biome formatting (100 columns), exact pinned dependency versions,
  `pnpm-lock.yaml` committed. Match the surrounding style and comment density.
- Domain logic stays in pure packages (`figure-schema`, `editor-core`, `image-processing`)
  with no browser or database dependencies.
- HTTP changes go in `packages/api-contract` first. Then regenerate `openapi/openapi-v1.yaml`
  with `corepack pnpm openapi` (`apps/api/scripts/generate-openapi.ts`, piped through Ruby's YAML
  dumper to keep the existing format).
- Document changes need a new schema version plus the migration entry point in
  `packages/figure-schema`; old documents must still open.
- Tests rely on accessible names ("Upload original", "Create project", "Export PNG",
  "Brightness", "Invert", "Move view-…", "Show in Original", …). If one changes, update
  `apps/web/e2e`, `tests/e2e`, and `tests/live` together.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | React 19 + Vite 8 app: dashboard, editor (PixiJS 8 artboard, accessible DOM/SVG controls), Zustand session, autosave, browser raster resolver, PNG export. `src/auth` is the Supabase sign-in gate; `netlify.toml` defines the Netlify site. |
| `apps/api` | Fastify 5 + TypeBox HTTP boundary. Handles projects, documents, upload reservations, asset status, signed URLs, and export records; never proxies image bytes. `src/auth.ts` resolves the caller per request; `src/fetch-adapter.ts` runs Fastify behind fetch-style runtimes. |
| `apps/jobs` | Graphile Worker tasks `verify_asset` and `delete_project`. Runs as a long-lived worker (Compose) or `drainJobsOnce` (Netlify). |
| `packages/figure-schema` | Strict v1 and v2 documents, semantic validation, typed decode errors, `migrateFigureDocument`, journal size presets. |
| `packages/editor-core` | Pure crop, transform, history, and provenance commands. |
| `packages/image-processing` | Raster sources, TIFF validation and window reads, display math, CPU PNG composition. |
| `packages/database` | Drizzle tables, `pg` repository, in-memory repository, `Principal`/`Authorizer`, SQL migrations. |
| `packages/storage` | `ObjectStore` interface; S3/MinIO and Supabase Storage adapters, picked by `STORAGE_DRIVER`; fake store. |
| `packages/api-contract` | Routes, DTOs, error codes, limits. Snapshot: `openapi/openapi-v1.yaml`. |
| `packages/ui` | Shared React primitives. |
| `netlify/`, `scripts/build-netlify-functions.mjs` | Function entries (`api`, `jobs-background`, `jobs-sweep`) and the esbuild bundling step. |
| `deploy/` | Compose stack, Dockerfiles, Caddy, `migrate.sh`, Supabase root CA. |
| `supabase/config.toml` | Supabase Auth/API settings for `supabase config push`. |
| `tests/e2e`, `tests/live` | Visual shell test; live suite against a real deployment. |
| `docs/superpowers` | Original design spec and implementation plan (intent; code wins where they differ). |

## Architecture

Hosted (production):

```text
Browser -- sign-up/sign-in (supabase-js) ------------------------------> Supabase Auth
Browser -- /v1/* + Bearer JWT --> Netlify Function "api" (Fastify) --> Supabase Postgres
Browser -- signed original PUT/GET -----------------------------------> Supabase Storage (private)
api -- enqueue + trigger --> Netlify background function --> Graphile runOnce --> verify/delete
Netlify scheduled function (every 5 min) --> retriggers the drain (retries, missed triggers)
```

Local single-user (Docker Compose):

```text
Browser -- HTTP --> Caddy --> Fastify --> PostgreSQL 17
Browser -- presigned original PUT/GET --> MinIO
PostgreSQL -- durable jobs --> Graphile Worker -- verify/delete --> MinIO + PostgreSQL
```

There is no Redis or separate queue. Graphile Worker keeps jobs in Postgres in both modes.

## Decisions

| Decision | Why / consequence |
| --- | --- |
| Pure packages for schema, editor commands, and image processing | Crop and display rules are testable alone and shared by preview and export. |
| Immutable originals uploaded directly with signed URLs | Bytes bypass the API, and every crop links to one auditable original. The API stores metadata only. |
| Postgres for documents **and** jobs | Saves, audit events, and enqueueing are durable without another service. |
| Versioned JSON document with optimistic revisions | Portable, reproducible state; stale tabs cannot overwrite newer saves. |
| Export in the browser from original samples | Preview cannot leak into export, and no server stores rendered PNGs. The browser re-decodes originals. |
| `Principal`/`Authorizer`/`ObjectStore` interfaces | Single-user + MinIO locally; Supabase Auth + Storage hosted; project services unchanged. |
| Verify Supabase JWTs in the API (ES256 JWKS) | No per-request Auth call. Users and personal workspaces are provisioned on first sight. Admin = `app_metadata.role = "admin"`, settable only with the secret key. |
| Supabase native signed uploads, not its S3 endpoint | The S3 endpoint ignores `If-None-Match` on PUT; native signed uploads refuse overwrites. |
| Drain jobs with Graphile `runOnce` in Netlify functions | Netlify can't host a long-lived worker. The API triggers a 15-minute background function, with a scheduled sweep every 5 minutes. |
| App connects as role `figlab_app` via session pooler with verified TLS | The role owns FigLab's tables. RLS is on with no policies, so `anon`/`authenticated` see nothing. Session mode suits Graphile. `DATABASE_CA_CERT` pins Supabase's root CA. |
| Supabase Data API off | All data access goes through FigLab's API. |
| Pre-bundle functions with esbuild; stage sharp's Linux build in `netlify/node_modules` | pnpm keeps app dependencies out of the root `node_modules`, so Netlify's tracer can't package them. Netlify re-bundles and injects `require`/`__filename`, so add no banner. |
| Separate MinIO internal and public endpoints (Compose) | Containers use Docker DNS; signed URLs must resolve in the browser. |

## Domain details

**Document.** The current schema is v2 (`packages/figure-schema/src/v2.ts`); v1 is frozen in
`v1.ts`. Every read and every received save goes through `migrateFigureDocument`, which
validates the stored version and upgrades it; saves always store the current version.
- A document has one or more artboards (each a "figure"), objects, and `groups`
  (`constraints`/`styles` stay empty). The default artboard is white US Letter, 612×792 pt.
- Object kinds: `image-view`, `text` (optionally a panel label linked to a target), `line`
  (arrowheads; one zero-size dimension allowed), and `shape` (rect, ellipse, bracket).
- Each image view has a `sourceAssetId`, a top-left normalized viewport, and display settings:
  brightness [-1,1], contrast [0,4], gamma [0.1,10], invert. Position and size are in points.
  Image rotation is fixed at 0; resizing keeps the crop's aspect ratio, and a new crop's panel
  takes the crop's aspect ratio in source pixels. Text and shapes may rotate about their center.
- Crop → source pixels: `floor` left/top, `ceil` right/bottom. Validation rejects malformed,
  out-of-bounds, duplicate-ID, and future-version documents.
- Editing: pointer-move previews, pointer-up commits one command. Undo keeps at most 100
  snapshots. Autosave debounce is 1000 ms.
- Storage: `project_documents` holds the current document, `project_versions` the history.
- Audit events are derived on the server from document diffs. Image views report crop, display,
  and transform changes; other objects report create/change/transform/remove; artboards and
  groups report their own changes; uploads, exports, renames, and deletion are recorded too.
  Each event records its actor (`actor_user_id`) and a monotonic `seq`. Deleting a project
  tombstones it (`status = 'deleted'`): content goes, the audit trail and export records stay.

**Assets.** `AssetDescriptor` lives outside the document: verified MIME type, SHA-256,
dimensions, bit depth, channels. States are `pending-verification` → `ready` | `rejected`, and
only `ready` assets may be saved into a document.
- Key format: `workspaces/{ws}/projects/{project}/assets/{asset}/original`.
- Upload: the browser hashes the file, reserves an upload, PUTs to the signed URL, then calls
  `/complete`, which checks the object length and is idempotent. The `verify_asset` job
  recomputes SHA-256 and checks the signature and metadata (sharp; geotiff for TIFF).
- Limits: the API caps uploads at 100 MiB (50 MB hosted on Supabase Free) and decoded images
  at 100 Mpx.
- TIFF v1 accepts single-plane, strip-based grayscale/RGB, 8/16-bit unsigned, with
  none/LZW/Deflate compression. It rejects tiled, multipage, OME, BigTIFF, palette/CMYK,
  float/signed, and other compressions. The browser fetches the whole TIFF, then does
  in-worker windowed reads.
- Delete: the project is marked `deleting`, then a retryable job removes objects, then rows.

**Preview and export.**
- Pixi draws the preview textures; DOM/SVG handles interaction and accessibility.
- Display math: normalize the sample, apply contrast around 0.5, add brightness, clamp to
  [0,1], raise to 1/gamma, then invert.
- `buildArtboardScene` (`packages/image-processing/src/scene.ts`) resolves an artboard to an
  ordered draw list; the preview and every export format draw from it. Text is laid out with
  the bundled Arimo font (`packages/image-processing/fonts`, SIL OFL 1.1) without kerning or
  ligatures.
- Raster export (PNG with pHYs, TIFF with resolution tags) re-reads source regions, applies the
  same math, and composites in z-order; text and shapes are rasterized by the browser and
  composited between panels. 16-bit values are kept until this step. Limits are 16,384 px per
  edge and 100 Mpx. Pixel size is the figure's physical size × DPI (300 by default).
- SVG and PDF stay vector and embed each panel as a lossless PNG rendered from originals at the
  export DPI. fontkit and pdf-lib load from `@figlab/image-processing/vector` on demand.
- Export flushes autosave first. The API records the format, figure, DPI, exact revision, size,
  and SHA-256 of every exported figure, never the bytes.
- "Show in Original" uses the view's asset and viewport. Views sharing an asset are
  provenance siblings.

**Auth.** `AUTH_MODE=single-user` (the default) bootstraps one admin. `AUTH_MODE=supabase`
requires a Bearer token on every `/v1/*` request (401 `UNAUTHORIZED`) and maps each user to a
personal workspace. Shared workspaces are not built yet.

## HTTP contract

| Route | Purpose |
| --- | --- |
| `GET /v1/me` | Email and role (`admin` / `member`). |
| `GET/POST /v1/projects` | List / create. |
| `GET/PUT/DELETE /v1/projects/:id` | Open / rename / queue deletion. |
| `GET/PUT /v1/projects/:id/document` | Read / compare-and-swap save. |
| `POST /v1/projects/:id/uploads` | Reserve an asset and get a signed PUT. |
| `POST /v1/uploads/:id/complete` | Finalize and enqueue verification. |
| `GET /v1/assets/:id` | Asset status and descriptor. |
| `POST /v1/assets/:id/download-url` | Short-lived signed GET. |
| `GET/POST /v1/projects/:id/exports` | List / record export metadata (format, figure, DPI). |
| `GET /v1/projects/:id/audit-events` | Audit trail, newest first (`limit`, `beforeSequence`). |
| `GET /v1/projects/:id/versions[/:revision]` | Saved revisions; a revision's document is migrated to current. |

Error codes: `BAD_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `UPLOAD_INVALID`, `UPLOAD_EXPIRED`,
`ASSET_NOT_READY`, `UNSUPPORTED_IMAGE`, `REVISION_CONFLICT`, `INTERNAL_ERROR`.

## Hosted operations

**Netlify** (package directory `apps/web`, base = repo root; the site isn't git-connected):
- Build command: `corepack pnpm --filter @figlab/web... build && node scripts/build-netlify-functions.mjs`.
- Deploy: `npx netlify-cli deploy [--prod] --filter @figlab/web`.
- Check offline: `npx netlify-cli build --offline --filter @figlab/web`.
- Logs: `npx netlify-cli logs --filter @figlab/web --source functions --since 1h`.
- Env vars are plain site variables; scoped/secret variables need a paid plan.
- `netlify env:set --filter` silently does nothing in this monorepo, so use
  `netlify api createEnvVars` with the account ID.

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `supabase` |
| `PUBLIC_APP_URL` | `https://figlab.netlify.app` |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Project URL / `sb_secret_…` (server only) |
| `DATABASE_URL` | `postgresql://figlab_app.<ref>:<pw>@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require` |
| `DATABASE_CA_CERT` | Contents of `deploy/supabase-root-2021-ca.crt` |
| `STORAGE_DRIVER` / `OBJECT_STORE_BUCKET` / `MAX_UPLOAD_BYTES` | `supabase` / `figlab` / `52428800` |
| `JOBS_TRIGGER_SECRET` | Shared by `api` and `jobs-background` |
| `VITE_AUTH_MODE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Build-time, public |

**Supabase** (already provisioned):
- Role `figlab_app` owns the FigLab and `graphile_worker` schemas. Private bucket `figlab`
  (50 MB, png/jpeg/tiff). Email confirmation is required. Site URL and redirects point at
  figlab.netlify.app. The Data API is off.
- Migrations: `MIGRATIONS_DIR=packages/database/migrations sh deploy/migrate.sh` as
  `figlab_app`, then `migrateJobsSchema()` from `apps/jobs`. Get approval before running them.
- Auth settings: edit `supabase/config.toml`, review `supabase config push`'s diff, and get
  approval before confirming.
- Admin: `SUPABASE_URL=… SUPABASE_SECRET_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.ts`.
- The Supabase MCP's SQL role can't modify `figlab_app`-owned tables; use `psql` as
  `figlab_app` with `sslmode=verify-full&sslrootcert=deploy/supabase-root-2021-ca.crt`.

**Live verification:**
`LIVE_BASE_URL=… SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SECRET_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… [SIGNUP_EMAIL=…] npx playwright test -c tests/live/playwright.config.ts`.
- It covers sign-in, uploads (PNG, JPEG, 16-bit TIFF, corrupt), crop, adjust, export, reload,
  conflict, isolation, and delete. It creates and removes its own users.
- To run it locally against Supabase: run `tsx apps/api/src/index.ts` with hosted env, loop
  `drainJobsOnce`, and start Vite with `FIGLAB_API_PROXY=http://127.0.0.1:3000`.

**Known limits:**
- Supabase's built-in SMTP only reaches team members and is rate-limited; configure custom
  SMTP before inviting users.
- No shared workspaces or admin screens yet.
- A job killed by a function timeout stays locked for up to 4 hours (Graphile lock expiry).

## Local operations

- Start: `cp .env.example .env && docker compose -f deploy/docker-compose.yml up --build -d --wait`,
  then open http://localhost.
- Stop: `docker compose … down`. **Never `down -v`** unless you mean to delete data.
- Optional Supabase-backed Compose (not live-tested): add `-f deploy/docker-compose.supabase.yml`,
  use a session-pooler `DATABASE_URL` and `DATABASE_CA_CERT`. MinIO stays local. Never use the
  transaction pooler: Graphile needs a session.
- `.env.example` lists export, history, and autosave values that are fixed code constants, so
  changing them has no effect. Runtime settings are `MAX_UPLOAD_BYTES`, `MAX_IMAGE_PIXELS`, and
  `UPLOAD_URL_TTL_SECONDS`.

## Development and verification

```sh
corepack enable && corepack pnpm install --frozen-lockfile
corepack pnpm check && corepack pnpm typecheck && corepack pnpm test:unit --coverage
TEST_DATABASE_URL=<disposable pg> corepack pnpm test:integration
corepack pnpm build && corepack pnpm test:e2e && corepack pnpm test:visual && corepack pnpm test:compose
```

- Turbo needs a `pnpm` binary on PATH: `corepack enable --install-directory <dir on PATH> pnpm`.
- Only one Vite server may use port 4173. Playwright reuses an existing server, so a
  hosted-mode server breaks the mocked e2e tests.
- Visual baselines: CI runs `test:visual` inside `mcr.microsoft.com/playwright:v1.62.1-noble`.
  Regenerate the Linux baseline in that image (`--platform linux/amd64`, fresh `pnpm install`,
  `playwright test --grep @visual --update-snapshots`). The macOS baseline is for local runs.
- Browser e2e tests mock HTTP. `test:compose` exercises the real Compose stack, and
  `tests/live` the real hosted stack.

## Current state (2026-10-06)

- `main` is deployed to production. The live suite passes against it (7 tests, including a real
  sign-up and email verification).
- Worktrees: `.worktrees/ui-refresh` (`feat/ui-refresh`, visual redesign; owns `apps/web` look
  and `packages/ui`) and `.worktrees/sciugo-parity` (`feat/sciugo-parity`, feature parity with
  Sciugo; owns schema, editor-core, API, jobs, export). The UI branch lands first.
- `feat/sciugo-parity` P0 (see `docs/superpowers/plans/2026-10-06-sciugo-parity-p0.md`): schema
  v2, figures and journal presets, text/lines/arrows/shapes/brackets, panel lettering, arrange
  tools, PNG/TIFF/SVG/PDF export with DPI, and audit/version/export history. It needs migration
  `0003` on Supabase before it is deployed.
- Out of scope so far: shared workspaces, admin screens, OAuth/SSO, blot tools, microscopy
  channels, pyramids, offline use, densitometry, and mobile layout.
