# FigLab Scientific Vertical Slice Design

## Goal

Deliver a self-hosted workflow that creates projects, uploads immutable scientific images directly
to MinIO, creates normalized source-linked crops, applies declarative display transforms, persists
the versioned figure document, shows crop provenance, and exports the artboard as PNG from original
source samples.

## Architecture

The monorepo contains React/PixiJS web, Fastify API, and Graphile jobs applications. Pure figure
schema, editor commands, and raster processing live in dependency-light packages. PostgreSQL stores
structured project, document, asset, revision, and audit data. MinIO stores immutable originals.
The browser uploads directly to MinIO, while the jobs service verifies each object before use.

The persisted v1 document stores publication-point geometry and normalized source viewports. It
never stores raster bytes, storage keys, signed URLs, preview state, or renderer objects. Browser
preview and CPU export share a fixed numeric transformation contract.

## First-Slice Behavior

Single-user mode provisions one stable local administrator and workspace. Users can manage projects,
upload PNG/JPEG or supported single-plane TIFF, draw multiple crops, move and proportionally resize
panels, change brightness/contrast/gamma/invert, undo/redo, autosave, reopen, inspect provenance, and
export PNG. Optimistic revision conflicts preserve unsaved work and offer reload or JSON download.

The first slice excludes password/OAuth authentication, alternate storage providers, generic figure
tools, blot-specific layout, TIFF/PDF export, microscopy pyramids, offline projects, public cloud,
analysis, and collaboration.

## Safety and Verification

Upload keys are server-generated and never reused. The verifier independently checks bytes, digest,
signature, dimensions, bit depth, channel count, and supported TIFF structure. Single-user mode
rejects unsafe public origins unless explicitly overridden. Unit, integration, browser, visual, and
clean-volume Compose tests cover the end-to-end invariant that every crop resolves to its immutable
source and every export uses original samples.
