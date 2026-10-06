# FigLab

FigLab is a self-hosted scientific figure workspace. Its first vertical slice creates projects,
uploads immutable PNG/JPEG and supported TIFF originals, draws reproducible crops, applies
non-destructive display adjustments, saves a versioned figure, shows each crop in its original,
and exports a PNG from source pixels. The repository is licensed AGPL-3.0-only.

It runs in two modes from the same code:

- **Local single-user** — Docker Compose with Caddy, Fastify, Graphile Worker, PostgreSQL, and
  MinIO; no sign-in, loopback only.
- **Hosted** — Supabase (Postgres, Auth, Storage) plus Netlify (static app and Functions), with
  email/password accounts that must verify their email. See
  [Hosted deployment](#hosted-deployment-supabase--netlify).

## Handoff snapshot (2026-10-05)

Hosted support is on branch `feat/supabase-netlify`. The Supabase project **FigLab**
(`fxfjsjxizojgtzzwputg`, us-west-2) is provisioned: the `figlab_app` role, FigLab and Graphile
schemas, the private `figlab` bucket, and one confirmed admin account. The full live test suite
(`tests/live`) passes against that project with the API and job runner served locally. The
packaged Netlify functions were built offline and smoke-tested (the job runner on Linux x64). A
Netlify site has **not** been created yet: it needs a Netlify login (see the deploy steps below).
Local hosted secrets live in the ignored `.env.hosted`.

The local single-user Compose milestone is unchanged: lint, typecheck, build, unit tests,
PostgreSQL integration tests, browser tests, the visual test, and the clean-volume Compose smoke
cover it.

## Run locally

Docker with Compose v2 is the supported deployment path:

```sh
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build -d --wait
```

Open <http://localhost>. Caddy serves the React app and proxies `/v1/*` and `/health` to Fastify.
The MinIO API and console bind to loopback ports 9000 and 9001. The example credentials are for
local development only. Do not expose this single-user stack on a public network.

Stop it without deleting projects or originals:

```sh
docker compose -f deploy/docker-compose.yml down
```

Do **not** add `-v` unless you deliberately want to delete the PostgreSQL and MinIO volumes.
To check a running stack, use `docker compose -f deploy/docker-compose.yml ps` and
`curl http://localhost/health`.

## Architecture and ownership

```text
Browser -- project/document/metadata HTTP --> Caddy --> Fastify --> PostgreSQL
Browser -- presigned original PUT/GET ----------------------------> MinIO
PostgreSQL -- durable jobs --> Graphile Worker -- verify/delete --> MinIO + PostgreSQL
```

Hosted mode keeps the same API, jobs, and storage contract on managed services:

```text
Browser -- sign-up/sign-in (supabase-js) -------------------------> Supabase Auth
Browser -- /v1/* with Bearer JWT --> Netlify Function "api" (Fastify) --> Supabase Postgres
Browser -- signed original PUT/GET -------------------------------> Supabase Storage (private)
api -- enqueue + trigger --> Netlify background function --> Graphile runOnce --> verify/delete
Netlify scheduled function (every 5 min) --> triggers the same drain as a backstop
```

| Component | Responsibility and source |
| --- | --- |
| `apps/web` | React 19/Vite 8 dashboard and editor; PixiJS 8 raster artboard, accessible DOM/SVG controls, Zustand editor session, browser raster resolver, autosave, and PNG download. In hosted builds, `src/auth` adds the Supabase sign-in/sign-up gate; `netlify.toml` defines the Netlify site. |
| `apps/api` | Fastify 5 HTTP boundary. TypeBox defines request/response schemas and validates requests; it handles projects, documents, upload reservations, asset status, signed URLs, and export metadata. It does not proxy image bytes. `src/auth.ts` resolves the caller per request (fixed single user, or a verified Supabase JWT); `src/fetch-adapter.ts` serves the app from fetch-style runtimes. |
| `apps/jobs` | Graphile Worker tasks `verify_asset` and `delete_project`. Verification reads MinIO originals, checks checksum and image metadata, then changes asset status. Runs as a long-lived worker (Compose) or as `drainJobsOnce` (Netlify). |
| `packages/figure-schema` | Strict persisted document v1, semantic validation, typed decode errors, and an explicit migration entry point. |
| `packages/editor-core` | Pure crop, transform, history, and provenance commands; no browser or database dependency. |
| `packages/image-processing` | Raster source interface, TIFF validation/window reads, shared display math, and CPU PNG composition. |
| `packages/database` | Drizzle table definitions and `pg`-based PostgreSQL repository, plus in-memory test repository and `Principal`/`Authorizer` interfaces. |
| `packages/storage` | `ObjectStore` interface, S3-compatible MinIO implementation, Supabase Storage implementation, env-based selection, and fake test store. |
| `packages/api-contract` | Shared HTTP routes, TypeBox DTOs, typed errors, and fixed limits. `openapi/openapi-v1.yaml` is the published contract snapshot. |
| `deploy` | Caddy, Dockerfiles, pinned images, local PostgreSQL/MinIO Compose stack, optional Supabase database override, and Supabase's root CA for verified TLS. |
| `netlify`, `scripts/build-netlify-functions.mjs` | Netlify function entry points (`api`, `jobs-background`, `jobs-sweep`) and the esbuild step that bundles the API and job runner for them. |
| `supabase/config.toml` | Supabase CLI project config (Auth, Data API) for `supabase config push`. |
| `tests/live` | Playwright suite that drives a real hosted deployment without mocks. |

Node 24, pnpm 10, strict TypeScript, Turborepo, Biome, Vitest, and Playwright are the repository
toolchain. Versions are locked in `pnpm-lock.yaml`; Compose images are digest-pinned. The MinIO
container is built from a pinned upstream source commit in `deploy/Dockerfile.minio`. The
default local database uses PostgreSQL 17. There is no Redis or separate message broker: Graphile
Worker uses PostgreSQL for durable jobs.

The key decisions and their reasons are:

| Decision | Why and consequence |
| --- | --- |
| Keep schema, editor commands, and image processing in pure packages. | The scientific crop and display rules can be tested independently and shared by preview and export. |
| Store immutable originals in MinIO; upload directly with signed URLs. | Image bytes avoid the API bottleneck, while each crop keeps an auditable link to one original. The API stores metadata, never source bytes. |
| Use PostgreSQL for documents **and** Graphile jobs. | Saves, audit events, and work enqueue can be durable without operating another queue service. Supabase can later supply the same database. |
| Save a versioned JSON document with optimistic revisions. | Crop state is portable and reproducible; a stale tab cannot silently overwrite a newer save. Conflicts require explicit recovery. |
| Export in the browser from original samples. | Preview quality cannot silently become export quality, and no rendered PNG needs server storage. The browser must download and decode originals again. |
| Keep `Principal`, `Authorizer`, and `ObjectStore` interfaces. | Authentication and storage backends change behind these boundaries: single-user + MinIO locally, Supabase Auth + Supabase Storage when hosted. |
| Hosted: verify Supabase JWTs in the API and give each user a personal workspace. | The API checks tokens locally against the project's published ES256 keys (no per-request Auth call), provisions `users`/`workspaces` rows on first sight, and keeps every existing ownership check. Admin is `app_metadata.role = "admin"`, which only the secret key can set. |
| Hosted: use Supabase's native signed upload URLs, not its S3 endpoint. | Supabase's S3 protocol ignores `If-None-Match` on PUT, so it cannot keep originals immutable; native signed uploads refuse to overwrite an existing object. |
| Hosted: drain the Postgres job queue from Netlify functions with Graphile `runOnce`. | Netlify cannot host a long-lived worker. Jobs stay durable in Postgres; the API triggers a 15-minute background function after enqueueing, and a scheduled function retriggers it every 5 minutes for retries and missed triggers. |
| Hosted: the app connects as a dedicated `figlab_app` role through the session pooler with verified TLS. | The role owns FigLab's tables (RLS stays on with no policies, so Supabase's `anon`/`authenticated` roles see nothing); session mode suits Graphile; `DATABASE_CA_CERT` pins Supabase's root CA. |
| Separate MinIO internal and public endpoints. | Containers use Docker networking, while presigned URLs must resolve in the user's browser. Caddy serves the app/API, not image bytes. |

### Scientific document and editing decisions

- `FigureDocumentV1` stores `schemaVersion: 1`, artboards, image-view objects, and empty
  `groups`, `constraints`, and `styles`. The default is a white US Letter portrait artboard,
  `612 × 792 pt`, with 72 points per inch.
- Every image view references an immutable `sourceAssetId`, a top-left-origin viewport normalized
  to `[0,1]`, and declarative brightness `[-1,1]`, contrast `[0,4]`, gamma `[0.1,10]`, and invert.
  Panel position and size are in artboard points. Rotation is represented as `0` but not editable
  in v1; resizing preserves the crop's aspect ratio.
- Crop conversion uses `floor` for source-pixel left/top and `ceil` for right/bottom. A crop at a
  source edge therefore includes its boundary pixels. Schema validation rejects malformed,
  out-of-bounds, duplicate-ID, and future-version documents.
- The document never contains raster bytes, storage keys, signed URLs, browser blobs, preview
  pixels, Pixi objects, selection, undo history, or pan/zoom. These remain transient client state.
  Pointer movement previews a change; pointer-up commits one editor command. Undo/redo retains at
  most 100 document snapshots.
- PostgreSQL stores the current JSON document in `project_documents` and saves revisions in
  `project_versions`. Saves use `baseRevision` compare-and-swap. A stale save returns
  `409 REVISION_CONFLICT` with `currentRevision`; the browser keeps local edits and offers reload
  or a JSON download. Autosave debounces for 1,000 ms.
- Audit events are derived on the server from document differences, not trusted as client claims.
  They cover crop creation/change, display changes, transforms/removal, upload, and export. Audit
  events are persisted but do not yet have a public read endpoint.

### Asset and storage decisions

- `AssetDescriptor` lives outside the figure JSON and records verified MIME type, SHA-256,
  dimensions, bit depth, channel count, and metadata. Asset states are `pending-verification`,
  `ready`, or `rejected`; only ready assets may be saved into a project document.
- The API allocates a fresh asset ID and immutable key
  `workspaces/{workspaceId}/projects/{projectId}/assets/{assetId}/original`. It returns a
  600-second presigned PUT with `If-None-Match: *`; the browser sends original bytes directly to
  MinIO. A separate public endpoint makes signed URLs browser-resolvable, while containers use
  the internal MinIO endpoint. The bucket remains private; CORS permits the configured app origin.
- The browser computes SHA-256 before reservation. Completion checks object length and is
  idempotent; a Graphile job independently reads the object, recomputes SHA-256, checks the image
  signature/metadata, and marks it ready or rejected. Invalid bytes are not made editable.
  The API limit is 100 MiB and the decoded-image limit is 100 million pixels by default.
- PNG/JPEG are decoded through browser image APIs for preview. TIFF uses a dedicated Web Worker
  and `geotiff.js` windowed raster reads, preserving unsigned 16-bit samples until final PNG
  rendering. TIFF v1 accepts one-plane, strip-based grayscale/RGB, 8- or 16-bit unsigned samples,
  with none/LZW/Deflate compression. It explicitly rejects tiled, multipage, OME, BigTIFF,
  palette/CMYK, signed/floating-point, and unsupported-compression inputs. Pyramids are not part
  of v1. The browser currently fetches the whole TIFF object before issuing in-worker windowed
  reads; remote range streaming is not implemented.
- Project deletion first marks the project `deleting`, then a retryable worker task removes
  source objects and database rows. The `ObjectStore` interface allows another adapter later,
  but MinIO is the only complete production adapter today.

### Preview, export, and provenance decisions

- Pixi renders preview textures on the artboard; DOM/SVG controls handle accessible selection,
  crop, move, resize, and inspector interactions. Preview caches are disposable.
- Display processing has one numeric contract: normalize an 8- or 16-bit sample, apply contrast
  around `0.5`, add brightness, clamp to `[0,1]`, raise to `1/gamma`, then invert if requested.
- Browser PNG export re-reads the original source regions through `RasterSourceResolver`, applies
  that processing, and CPU-composites visible panels in z-order at the chosen artboard pixel
  dimensions. It writes an 8-bit PNG; 16-bit TIFF values are retained until this final render.
  Export is limited to 16,384 pixels per edge and 100 million output pixels.
- The PNG is downloaded by the browser, not uploaded to Fastify. The API records only format,
  exact saved document revision, output dimensions, and SHA-256. Export flushes autosave first;
  a conflict or failed save keeps the local work recoverable and blocks a misleading export.
- “Show in Original” uses the selected image view's asset ID and normalized viewport. Other views
  with the same asset ID are its provenance siblings; crops never become new source assets.

### Database, security, and deployment decisions

- Local startup (`AUTH_MODE=single-user`, the default) creates one stable administrator, workspace,
  and membership in PostgreSQL. Hosted mode (`AUTH_MODE=supabase`) requires a Supabase access
  token on every `/v1/*` request (401 `UNAUTHORIZED` otherwise) and maps each verified user to
  their own personal workspace. Both go through `Principal` and `Authorizer`, so project services
  are unchanged. Collaboration (shared workspaces) is **not implemented**.
- SQL migrations live in `packages/database/migrations`; Drizzle defines the tables, while the
  current repository executes SQL via `pg`. Graphile Worker has its own migration step. FigLab's
  public tables have row-level security enabled, but there are no browser-facing RLS policies or
  Supabase Data API usage. Database access goes through the server's connection role.
- Single-user startup refuses a non-loopback `PUBLIC_APP_URL` unless
  `ALLOW_INSECURE_SINGLE_USER_REMOTE=true` is explicitly set. That override removes a safety
  guard; it does **not** add authentication. Keep the default deployment bound to `127.0.0.1`.
- Caddy serves the built SPA and proxies API paths. The default Compose stack has health checks
  for PostgreSQL, MinIO, Fastify, jobs, and Caddy. `down` preserves named volumes; `down -v`
  destroys them. Do not use the latter on data you need.

## HTTP contract

The canonical DTOs and error codes are in `packages/api-contract/src/index.ts`; the OpenAPI
snapshot is `openapi/openapi-v1.yaml`. Key routes:

| Method and path | Purpose |
| --- | --- |
| `GET /v1/me` | Signed-in email and role (`admin` or `member`). |
| `GET/POST /v1/projects` | List and create projects. |
| `GET/PUT/DELETE /v1/projects/:projectId` | Open, rename, or queue deletion. |
| `GET/PUT /v1/projects/:projectId/document` | Read or compare-and-swap save a figure document. |
| `POST /v1/projects/:projectId/uploads` | Reserve an immutable asset and obtain a presigned PUT. |
| `POST /v1/uploads/:uploadId/complete` | Finalize upload and enqueue verification. |
| `GET /v1/assets/:assetId` | Read verified asset status and descriptor. |
| `POST /v1/assets/:assetId/download-url` | Obtain an authorized, short-lived MinIO GET URL. |
| `POST /v1/projects/:projectId/exports` | Record browser-export metadata, not PNG bytes. |

Errors use typed envelopes such as `BAD_REQUEST`, `UNAUTHORIZED`, `UPLOAD_INVALID`, `UPLOAD_EXPIRED`,
`ASSET_NOT_READY`, `NOT_FOUND`, and `REVISION_CONFLICT`. The API checks that referenced assets
belong to the project and are ready before saving the document.

## Hosted deployment (Supabase + Netlify)

### What runs where

| Piece | Hosted on | Notes |
| --- | --- | --- |
| Web app | Netlify CDN (`apps/web/dist`) | Built with `VITE_AUTH_MODE=supabase`; `/*` falls back to `index.html`. |
| API | Netlify Function `api` at `/v1/*` and `/health` | Fastify via `handleFetchRequest`; one warm instance keeps a 3-connection pool. |
| Jobs | Netlify background function `jobs-background` (+ `jobs-sweep` every 5 min) | Requires `x-figlab-jobs-secret`; verification uses sharp's Linux x64 build staged in `netlify/node_modules`. |
| Database | Supabase Postgres, session pooler `:5432`, role `figlab_app` | Verified TLS with `deploy/supabase-root-2021-ca.crt`. Data API should be off. |
| Auth | Supabase Auth, email + password, email confirmation required | Admin = `app_metadata.role: "admin"`. |
| Originals | Supabase Storage, private bucket `figlab` | 50 MB per file (Free plan limit), PNG/JPEG/TIFF only. |

### Environment

Netlify site variables (functions unless noted):

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `supabase` |
| `PUBLIC_APP_URL` | The site URL, for example `https://<site>.netlify.app` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_…`); server-side only |
| `DATABASE_URL` | `postgresql://figlab_app.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| `DATABASE_CA_CERT` | Contents of `deploy/supabase-root-2021-ca.crt` |
| `STORAGE_DRIVER` / `OBJECT_STORE_BUCKET` | `supabase` / `figlab` |
| `MAX_UPLOAD_BYTES` | `52428800` on the Supabase Free plan |
| `JOBS_TRIGGER_SECRET` | Long random string shared by `api` and `jobs-background` |
| `VITE_AUTH_MODE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Build-time; the publishable key is safe in the browser |

### One-time provisioning (already done for project `fxfjsjxizojgtzzwputg`)

1. Create role `figlab_app` (LOGIN, random password) and grant it `CREATE, CONNECT` on the
   database and `USAGE, CREATE` on schema `public`, so it owns the tables it creates.
2. As `figlab_app`, run `MIGRATIONS_DIR=packages/database/migrations sh deploy/migrate.sh`, then
   `migrateJobsSchema()` from `apps/jobs` (Graphile's schema).
3. Create the private bucket `figlab` (`file_size_limit` 52428800, MIME types `image/png`,
   `image/jpeg`, `image/tiff`).
4. Create the admin:
   `SUPABASE_URL=… SUPABASE_SECRET_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.ts`
   (creates a confirmed user, or promotes an existing one).
5. Set Auth's **Site URL** and redirect allow-list to the Netlify URL and turn off the Data API:
   edit `supabase/config.toml` (`site_url`, `additional_redirect_urls`, `[api] enabled = false`),
   review `supabase config push`'s diff, and confirm it.

### Deploy

Create the Netlify site from this repository with **package directory `apps/web`** and the base
directory left at the repository root, set the variables above, then deploy. The build runs
`corepack pnpm --filter @figlab/web... build && node scripts/build-netlify-functions.mjs`. To
check a build without deploying: `npx netlify-cli build --offline --filter @figlab/web`.

### Verify a deployment

```sh
LIVE_BASE_URL=https://<site>.netlify.app SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… \
SUPABASE_SECRET_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… [SIGNUP_EMAIL=you+test@…] \
  npx playwright test -c tests/live/playwright.config.ts
```

It signs in, uploads PNG/JPEG/16-bit TIFF originals plus a corrupt file, crops, adjusts, exports,
reloads, forces a revision conflict, checks cross-user isolation, and deletes the project and its
stored originals. It creates and deletes its own throwaway users. To run the same suite locally
against Supabase, serve the API (`AUTH_MODE=supabase … tsx apps/api/src/index.ts`), call
`drainJobsOnce` in a loop, and start Vite with `FIGLAB_API_PROXY=http://127.0.0.1:3000`.

### Known limits

- Supabase's built-in email sender only delivers to the organization's team members and is
  heavily rate-limited. Configure custom SMTP (Auth → SMTP) before inviting other users, or their
  verification emails will not arrive.
- New accounts get a personal workspace only; there is no sharing between users yet.
- The admin role is recorded and shown, but no admin-only screens exist yet.
- A job interrupted by a function timeout stays locked until Graphile's 4-hour lock expiry.

## Optional Supabase development database (Compose)

Supabase can host the same PostgreSQL database; it does **not** replace this release's MinIO,
Graphile Worker, local-admin mode, or server API. Use a **dedicated** Supabase project, turn off
its **Integrations → Data API**, and place a direct or session-pooler `DATABASE_URL` from its
Connect panel in the ignored `.env` file, and set `DATABASE_CA_CERT` to the contents of
`deploy/supabase-root-2021-ca.crt` so TLS verification succeeds. Do not use the transaction pooler: Graphile Worker keeps
a database session open for job notifications. Use the session pooler on port 5432 if the Docker
host cannot reach the direct IPv6 endpoint.

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.supabase.yml up --build -d --wait
```

The override omits local PostgreSQL; MinIO stays local. Stop with the same two `-f` arguments and
`down` (without `-v`). This Compose override itself has not been live-tested; the hosted path
above uses the same database code against Supabase. Never point the destructive database integration tests at a production or shared
Supabase database. See Supabase's [connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
and [Data API security guide](https://supabase.com/docs/guides/api/securing-your-api).

## Development and verification

Install Node 24 and use the locked pnpm 10 version through Corepack:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit --coverage
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
corepack pnpm test:visual
corepack pnpm test:compose
```

`test:integration` skips the PostgreSQL-specific suite unless `TEST_DATABASE_URL` points to a
**disposable** PostgreSQL database. That suite drops FigLab tables and the Graphile schema before
recreating fixtures. Browser Playwright tests mock HTTP routes; `test:compose` separately verifies
the real API/jobs/MinIO path on isolated volumes and dynamic host ports, then removes its test
stack. The visual test covers the shell; numeric crop and display behavior has unit fixtures.
There is not yet a single browser-to-live-Compose Playwright test.

Runtime-configurable Compose values include `MAX_UPLOAD_BYTES`, `MAX_IMAGE_PIXELS`, and
`UPLOAD_URL_TTL_SECONDS`. The export/history/autosave values shown in `.env.example` currently
document fixed code constants rather than wired runtime settings; changing those environment
lines alone does not change behavior. The shared upload DTO also hard-caps requests at 100 MiB.

## Scope boundaries and next-agent reading order

Hosted mode adds email/password accounts, Supabase Storage, and Netlify hosting. Still out of
scope: shared workspaces and collaboration, admin screens, OAuth/SSO, generic text/shapes, blot-specific tools, TIFF/PDF export,
microscopy pyramids, offline projects, and densitometry. It targets desktop Chrome,
Firefox, Safari, and Edge; the editor is not mobile-optimized. The current browser test matrix is
narrower than that target.

For further work, read this README, then the [approved design](docs/superpowers/specs/2026-08-12-figlab-scientific-slice-design.md),
[implementation checklist](docs/superpowers/plans/2026-08-12-figlab-scientific-slice.md),
[API snapshot](openapi/openapi-v1.yaml), and the source files named in the ownership table.
Treat the code and shared contract as the current implementation; the older design describes
intent where it differs. Preserve the immutable-source, normalized-viewport, revision-conflict,
and original-pixel-export invariants when extending the system.
