# FigLab

FigLab is a self-hosted scientific figure workspace for creating reproducible crops from immutable
PNG, JPEG, and supported single-plane TIFF originals. This vertical slice includes project and
document persistence, direct-to-MinIO uploads, asynchronous verification, normalized cropping,
non-destructive display adjustments, undo/redo, provenance navigation, and original-pixel PNG
export.

## Run locally with Docker

Requirements: Docker with Compose v2.

```sh
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build -d --wait
```

Open <http://localhost>. MinIO's administrative console is available only on
<http://127.0.0.1:9001>. The default credentials in `.env.example` are intended for local use and
must be changed before using FigLab on a trusted private network.

Single-user mode deliberately refuses a non-loopback `PUBLIC_APP_URL` unless
`ALLOW_INSECURE_SINGLE_USER_REMOTE=true` is explicitly set. Authentication and multi-user
collaboration are outside this milestone.

Stop the stack without deleting projects:

```sh
docker compose -f deploy/docker-compose.yml down
```

## Use Supabase for development

FigLab stores projects in PostgreSQL through Drizzle and runs background jobs with Graphile Worker.
You can use a dedicated Supabase project as that PostgreSQL database; FigLab still uses its local
MinIO container for immutable image originals. Supabase Auth, Storage, and Data API are not part of
this single-user release.

1. Create a dedicated Supabase project. In its Dashboard, turn off **Integrations → Data API**.
   FigLab migrations also enable row-level security on its tables without browser-facing policies.
2. Copy `.env.example` to `.env`. Replace `DATABASE_URL` with the connection string from the
   Supabase **Connect** panel. Use a **direct connection** when available, or the **session pooler**
   on port 5432 if your Docker host only has IPv4. Do not use the transaction pooler on port 6543:
   Graphile Worker keeps a database session open for job notifications.
3. Start the stack without its local PostgreSQL service:

   ```sh
   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.supabase.yml up --build -d --wait
   ```

Open <http://localhost>. Stop it with the same two `-f` arguments and `down` (without `-v` to keep
MinIO data). Keep `DATABASE_URL` in the ignored `.env` file, and use a separate disposable local
database for integration tests: those tests reset FigLab tables.

Supabase's [connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
explains direct and session URLs. Its [Data API security guide](https://supabase.com/docs/guides/api/securing-your-api)
explains why the Data API should be disabled for apps that do not use it.

## Development

Requirements: Node.js 24 and pnpm 10 through Corepack.

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

The Compose smoke test uses isolated volumes and dynamically allocated host ports, verifies the
complete API/jobs/storage path, and removes its temporary stack afterward.

## Scientific data model

Figure documents store normalized source viewports and display transforms, never source bytes,
signed URLs, previews, or editor runtime state. Originals use one immutable key per asset. Browser
exports re-read the original source, map crop edges with floor/ceil source-pixel rules, preserve
supported 16-bit TIFF samples through processing, and record export metadata without uploading the
rendered PNG.

The versioned design and implementation checklist are in
[`docs/superpowers/`](docs/superpowers/). FigLab is licensed under AGPL-3.0-only.
