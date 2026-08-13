# FigLab Scientific Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and
> superpowers:test-driven-development. Parallel work is explicitly authorized only for the three
> collision-free worktrees in Task 2.

**Goal:** Build the first usable self-hosted immutable scientific-image crop workflow.

**Architecture:** A React/PixiJS browser uses pure schema/editor/processing packages, a Fastify API
persists structured state to PostgreSQL, direct browser uploads store immutable originals in MinIO,
and Graphile jobs verify assets. Docker Compose makes the complete slice self-hostable.

**Tech Stack:** Node 24, pnpm 10, React 19, Vite 8, PixiJS 8, Fastify 5, TypeBox, Drizzle,
PostgreSQL 17, Graphile Worker, MinIO, Biome, Vitest, Playwright.

## Global Constraints

- Product and package identity is FigLab; license is AGPL-3.0-only.
- Persisted crops always reference immutable originals by asset ID and normalized viewport.
- Persist no raster bytes, storage keys, signed URLs, blobs, renderer objects, or session state.
- Artboard units are points; normalized rectangles use top-left origin and stay inside `[0,1]`.
- Display order is normalize, contrast around 0.5, brightness, clamp, gamma, then invert.
- Upload limit is 100 MiB, decoded/export limit is 100 million pixels, export edge limit is 16,384.
- Presigned uploads live 600 seconds; autosave debounce is 1,000 ms; history holds 100 snapshots.
- TIFF v1 is one-plane, strip-based, unsigned grayscale/RGB, 8/16 bit, uncompressed/LZW/Deflate.
- Single-user and MinIO are the only production-complete auth/storage modes in this milestone.

---

### Task 0: Bootstrap and Freeze Shared Contracts

Create the workspace/tooling, design and plan documents, package skeletons, environment contract,
schema v1 and API contracts, deterministic fixtures, and a green check/typecheck/test/build baseline.
The root owns the lockfile, shared contracts, root configuration, Compose, CI, OpenAPI, and golden
screenshots.

### Task 1: Domain Core

Implement `figure-schema`, `editor-core`, and `image-processing` with TDD: validation and migration
dispatch, deterministic serialization, crop math, commands/history/provenance, raster abstractions,
PNG/JPEG/TIFF decoding validation, shared display transforms, and CPU PNG export.

### Task 2: Server Slice

Implement `database`, `storage`, `api`, and `jobs` with TDD: migrations, local-admin bootstrap,
authorization, project/document persistence, optimistic revision conflicts, MinIO presigning,
idempotent completion, asynchronous verification, audit derivation, export metadata, and deletion.

### Task 3: Web Slice

Implement `web` and `ui` with TDD: project dashboard, direct upload and verification states, source
inspector/crop tool, Pixi rendering and accessible overlays, transform inspector, undo/redo,
autosave recovery, provenance, and PNG export UI against frozen contracts.

### Task 4: Integration and Deployment

Integrate all workstreams, regenerate the lockfile and OpenAPI, wire real clients and raster access,
add Dockerfiles, Caddy, PostgreSQL, MinIO, Graphile jobs, health checks, CORS, Compose, CI, and the
Playwright/visual/clean-volume smoke workflows.

### Task 5: Review and Release Gate

Run task and whole-branch reviews, route findings to owning implementers, execute every final gate,
document exact supported formats and recovery behavior, and prepare the verified feature branch for
handoff.
