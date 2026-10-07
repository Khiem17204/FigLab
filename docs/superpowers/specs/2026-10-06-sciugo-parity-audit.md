# Sciugo Parity Capability Audit

Status: **approved 2026-10-06** with decisions D1–D6 below. P0 is in progress.

## How Sciugo was verified

Sciugo's public site (sciugo.com, formerly LabFigures) is a React SPA with four short sections
(Home, Tutorial, About, Overview) and no public docs, pricing page, or help center. Evidence comes
from:

- **[R] Rendered site.** Headless Chromium (Playwright 1.62) loaded sciugo.com and clicked each
  section. Tutorial topics are "Blot / Gel Figure Creation", "Microscopy Figure Creation", "Capture
  bands and MWs", "Creating Figures", and "Greek letters", plus one YouTube tutorial
  (`nDq93d59Pog`).
- **[O] Overview graphic** (`/static/media/NewOverview.svg`, rendered). It shows four screens:
  - a file browser of blot images;
  - band capture on a raw blot with **Quantify / Download CSV** and per-lane **peak bar plots**;
  - a blot figure built as a **table** of strips under a condition header;
  - a microscopy figure: a channel grid (red / GFP / DAPI / Merged) with nested zoom boxes on the
    source, a zoomed second row, contrast/brightness sliders, a channel picker, and
    "Export Figure" / "Cite Sciugo".
- **[B] The shipped app bundle** (`/static/js/main.f714dd72.chunk.js`, 1.2 MB). The editor ships
  in the same bundle as the landing page, so its UI strings, routes, and action names are direct
  evidence of shipped code. Strings inside a "What's coming in the near future" list are counted
  as **roadmap, not shipped**.
- **[W] Third-party sources:**
  - the sciugo.com `<title>` and meta description ("quantify blots and gels … faster than ImageJ");
  - the University of Utah LabFigures pilot announcement (Nov 2025):
    https://www.research.utah.edu/resources-opportunities/we-need-you-to-pilot-test-labfigures/;
  - @LabFigures YouTube titles and descriptions: blot labeling `nDq93d59Pog`, microscopy figures
    2025 `vdLK96HnzMs`, western blot figures `4AwqxgJOAds`, experiment planning `R5o5Qk7PaD0`,
    automated blot analysis `-ucbwBkPJEo`;
  - https://docs.labfigures.com/SecurityInfo.pdf (AWS, AES-256, daily backups, Stripe).

  Could not access: pricing (the API is gated), image.sc threads (403), Wayback captures
  (endpoint-only, then rate-limited), and the video contents. labfig.com is an unrelated product.

Not verified: anything behind login (pricing amounts, plan limits, the real look of lab admin).
A logged-in session would confirm the **[B]-only** rows. No login was used.

**Main finding.** Sciugo's figure model is a **table/grid**. Rows of blot strips sit under a
mergeable condition-header table, and microscopy uses channel columns with zoom rows. Sciugo also
captures blot bands with a "Line Crop" drawn across the bands. Its lead is the western-blot
workflow: rotated line crops, the MW-ladder workflow, lane and condition grids, densitometry
with loading-control and replicate checks, and raw-versus-figure adjustment disclosure. It is weak
on layout tools (no free canvas, presets, alignment, snapping, or auto lettering), file formats
(JPEG/PNG/TIF only, Chrome only), and export (PNG and SVG only, no DPI). Collaboration is thin:
groups and Member/Admin roles exist, but the sharing and license tabs are stubs and there are no
comments. Panel types are `westernBlot`, `microscopy`, and `sampleLayout` (a 96/384-well
plate designer). FigLab is a **free-form artboard of
source-linked crops**. The proposal keeps FigLab's artboard. It adds structured, source-anchored
objects (lane tables, MW markers, linked insets, calibrated scale bars, channel composites) whose
geometry is *derived* from viewports and asset calibration, so labels cannot drift from the pixels
they describe. Derived geometry is the integrity advantage over Sciugo's hand-placed cells.

Effort key, in agent-days including tests: **S** ≤ 1, **M** 1–3, **L** 3–6, **XL** > 6.

## 1. Figure assembly

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Several figures/panels per workspace: "Figure Panels", "New Panel", "My Figures" **[B]** | **Partial.** The schema allows `artboards[]`, but the UI, Pixi, and export use only `artboards[0]`. | An artboard list (add, rename, reorder, delete, duplicate) as editor-core commands, with per-artboard export. No DB change. | M |
| Size presets: free Width/Height, cell width, row spacing **[B]**. No journal presets found. | **Missing.** Fixed 612×792 pt. | Presets for journal single/1.5/double column plus custom, with mm/in/pt input. The preset table is data in `figure-schema`, citing each journal's author guide (verify every number before shipping). Artboard height stays free; max height is a soft warning. | S |
| Templates: "Figure Panels Templates", "New template from panel", "Based on previous figure", "Duplicate (without images)" **[B]** | **Missing.** | (a) **Grid layout command:** rows × cols, gutter, and margins position the selected views into cells. (b) **Templates** are saved documents with image references stripped. Templates are workspace-scoped (§7). | M (a), M (b) |
| Panel lettering: **manual** figure numbering per panel ("Click to set figure number": Number / Letter / Numerals, e.g. 2.B.ii) **[B][W]**. No automatic A, B, C. | **Missing.** | A `panel-label` object kind with style options: case, A/a/1, bold, font size, offset. A pure `relabelPanels` command letters in reading order (row-major by top-left) or keeps manual order. | S |
| Align/distribute | **Missing.** Implicit in Sciugo's grid: "Horizontal/Vertical Alignment" within cells, "Rapid band alignment" **[B]**. | Pure `alignObjects` (left/center/right/top/middle/bottom, to selection or artboard) and `distributeObjects` (h/v, equal gaps), plus multi-select (shift-click, marquee). | M |
| Snapping/guides | **Missing.** Not found in Sciugo **[B]**; its "guideline" code is a lane-drawing aid. | Pure `snapTransform(candidate, others, artboard, thresholdPt)` returns the snapped transform and guide lines for preview; the UI draws transient guides. Never persisted. | M |
| Grouping | **Missing.** Sciugo groups *images in the file browser*, not figure objects **[B]**. | Use the reserved `groups` array: `{id, memberIds}`. Selecting or moving one member moves the group; group/ungroup commands. | M |
| Layers/z-order: "Drop layer down." **[B]** | **Partial.** `zIndex` is rendered but has no commands. | Bring forward/back/front/back commands, plus a minimal layer list with hide and lock. Enforce `locked`, which is stored today but ignored. | S |
| Duplicate: "Duplicate", "Duplicate (without images)" **[B]** | **Missing.** | `duplicateObjectsCommand` with fresh IDs and offset. Duplicated views keep `sourceAssetId`, so they stay provenance siblings. | S |

## 2. Annotations

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Text: bold, italic, underline, color, background, angled text, multi-line, Greek-letter shortcuts (`\alpha`→α) **[B][R]** | **Missing.** | A `text` object with runs (bold, italic, underline, sub/superscript), font size, color, rotation, and alignment. Greek and `\symbol` replacement is a pure input helper. One bundled Arial-metric font (Arimo, Apache-2.0) so preview, PNG, PDF, and SVG measure the same. | L |
| Brackets and underlines on label cells ("put brackets above/below the line"), MW pointer lines **[B][W]**. Free arrows and shapes were **not found**. | **Missing.** | A `shape` object for line, arrow, rectangle, ellipse, and bracket, with stroke width, color, dash, and head style. | M |
| Insets/zoom: "Choose region", "Edit subregion", a region outline drawn as Box or Lines with a color **[O][B]** | **Partial.** Two crops of the same asset are already provenance siblings, but nothing draws the link. | A `zoom-link` object `{sourceViewId, insetViewId, style}`. The box on the source panel is *computed* from the inset's viewport, with optional connector lines. It cannot be drawn in the wrong place, and moving the inset crop moves the box. | M |
| Scale bars: "Set Image Resolution", units nm…m, "Can't handle anisotropic resolution yet" **[B]**. Calibration is manual. | **Missing.** The jobs only keep sharp's `density` for PNG/JPEG. | **Calibration** per asset in the document: `assetCalibrations[assetId] = {umPerPxX, umPerPxY, source: "tiff-tags" \| "imagej" \| "ome" \| "manual"}`. The verifier pre-fills it from TIFF tags, ImageJ `unit=` descriptions, and OME `PhysicalSize*`. A `scale-bar` object bound to a view stores the length in physical units, and the bar width is derived from calibration, viewport, and panel size. The integrity report flags manual calibration. | M |

## 3. Western blot / gel

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Band capture: "Line Crop", "2-Line Rect", and "Rectangle" tools; "Capture bands and MWs"; "Edit crop height"; "How many sample bands will be in each crop?" **[B][R]** | **Partial.** Axis-aligned rectangle crops only. | Add an angled "line crop" tool: drag along the bands and set a height. It produces a **rotated viewport**: center, size, and angle in source-pixel space. The original stays untouched; the crop stays one viewport into one original. | M |
| Rotate/straighten: rotation handles on crop boxes, with the angle taken from the dragged line crop, plus "Rapid band alignment" **[B][W]**. Its ImageJ macro export also includes `run("Straighten...")`. | **Missing.** `rotationDeg` is locked to 0. | Rotation lives in the viewport (above), with arbitrary angles and bilinear resampling recorded in the export and report. Panel rotation (`transform.rotationDeg`) unlocks for 90° steps. Curved-band straightening is out of scope. | L |
| Flip: **not found** in Sciugo **[B]** (FigLab-only) | **Missing.** | `view.flipX/flipY`. The integrity report always discloses it. | S |
| Lane labels and condition matrix: an editable header table with merged cells, underline borders, "Add Row/Column", "Merge/Split cells", and "Copy values" **[O][B]** | **Missing.** | A `lane-table` object attached to a view: `lanes: n`, lane centers (even, or per-lane normalized x along the crop), and `rows[]` of cells with `span`, text, `+/−`, and an underline flag. Its geometry is derived from the bound view, so lane columns track the crop. Commands cover add/remove row, merge/split, set cell, and fill-pattern helpers (`+ − + −`, doses). | L |
| MW markers: "Click on a protein ladder band and label", "Molecular Weight Layout", "Marker Formatting", pointer width and spacing, a ladder catalog (SeeBlue Plus2…), transfer from the ladder image to another exposure ("The annotations will apply to both images") **[B][W]** | **Missing.** | MW calibration per asset in the document: `assetMarkers[assetId] = [{yPx, kDa}]`, clicked on the uncropped original. Every crop of that asset renders the marker ticks and labels that fall inside its viewport, honoring rotation. A small built-in ladder catalog pre-fills kDa values. "Copy markers to asset" handles a second exposure of the same membrane and is recorded as copied in the report. | M |
| Uncropped-original linkage **[B]** ("Image with ladder", raw images) | **Has.** "Show in Original", siblings, and immutable originals. | Add an **uncropped-blot sheet** export: each source original with its crop rectangles (rotated), labels, and MW markers drawn on it. Journals ask for this in supplementary data. It also goes into the provenance bundle (§6). | M |
| Densitometry: "Quantify", "Peaks", "Peak bounds", "Plot Lanes", "Download CSV", "Export Quantifications", loading-control normalization, "Quantify with ImageJ Macro" **[O][B]** | **Missing.** | Pure `image-processing` functions run on **original samples, 16-bit preserved**: lane profile, then baseline (min-line or rolling-ball, selectable), then peak integration. A saturation check flags any lane with ≥ 0.1% max-value pixels. Normalization to a chosen loading-control row. The quantification spec lives in the document; results are recomputed in a worker and downloaded as CSV with the asset SHA-256. Results are not stored server-side in P1. | L |
| Integrity Screener checks: oversaturated or uneven loading control, insufficient replicates, missing loading control, unexpected MW **[B]** (sales-gated: "To get started, contact …") | **Missing.** | Fold the automatable checks (saturation, missing loading control, unexpected MW versus the marker fit) into the integrity report (§5). Replicates need experiment metadata. Proposed for **P2**. | M |
| Auto band/MW detection **[B]** (roadmap, not shipped) | n/a | Not planned. | — |

## 4. Microscopy

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Channel merge: "Assign Channels", "Set channel image", "Image Sets", "Merged", channel templates such as `"0 1 2 012"` **[O][B]**. Each channel is a separate uploaded image. | **Missing.** | A `channel-composite` view: `channels[] = {sourceAssetId, plane, lut, levels, visible}` with additive blending and clamping, in shared math used by preview and export. Single-channel panels are ordinary views with a LUT. A "split to panels" command creates one view per channel plus the merge, as a row. | L |
| Pseudocolor from a fixed palette (grey, blue, green, red, magenta, cyan, yellow), "View Color and Greyscale Versions". No LUTs or levels were found **[B][W]**. | **Missing.** Grayscale is replicated to RGB. | `display.lut`: gray, red, green, blue, cyan, magenta, yellow, or a custom hex, linear only. Linear-versus-not is explicit for the integrity report. | M |
| Per-channel adjustments: "Adjust Channels", "Channel Adjustment", contrast and brightness per channel **[O][B]** | **Partial.** One brightness/contrast/gamma per view. | Add `display.levels {black, white}` in source units (so 16-bit is exact), plus the existing gamma, applied per channel. A histogram (computed client-side from the original window) sits in the inspector. | M |
| Multi-page, tiled, or OME TIFF | **Missing.** All are rejected explicitly. Sciugo supports only JPEG/PNG/TIF **[B]** ("Supported formats include: JPEG, PNG, TIF."). | Accept tiled TIFF, BigTIFF, multi-page TIFF, and OME-TIFF (geotiff handles tiles and IFDs). Each asset gets `planes[]` (index, channel name, physical size, from OME-XML). Views reference `{assetId, plane}`. The verifier records planes and calibration. Vendor formats (CZI, ND2, LIF) stay out of scope; users convert them with Fiji/Bio-Formats. | L |
| Large images | **Partial.** 100 MP cap. Supabase Free caps uploads at **50 MB per file**, a hard limit on hosted large-image work. | Keep the cap hosted. Add a P2 job that writes a **derived preview pyramid**, marked derived and never used for export; export keeps reading original windows. Raise the cap only on paid storage. | XL |

## 5. Integrity

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Adjustment history: undo/redo only; no version history found **[B][W]** | **Has (stronger).** Revisioned saves (`project_versions`) and server-derived audit events with before/after values. | Add version history: `GET /versions`, `GET /versions/:rev`, and restore as a new revision through compare-and-swap, never a rewrite. | M |
| Audit-trail view: not found in Sciugo | **Partial.** Events are stored but there is no read endpoint, they have no actor, and project deletion **hard-deletes** them. | `GET /v1/projects/:id/audit-events` (cursor paging, action filter), plus an audit panel. Migration: add a nullable `actor_user_id` (filled for new events) and stop deleting audit rows when a project is deleted. Retention policy is decision **D4**. | M |
| Integrity report: "LabFigures Integrity Screener" checks that "Raw images are truly raw", controls, and "Figures will pass journal integrity checks". The modal only says "contact support", so it may not be self-serve **[B][W]**. | **Missing.** | A Graphile job `integrity_report` reads the originals server-side (sharp or geotiff). Per panel it records: asset SHA-256, crop rectangle in source px, rotation, flip, resampling, display parameters, the share of crop pixels clipped by the adjustment, saturation in the source, and linear versus non-linear flags. It also suggests figure-legend disclosure text. Output is stored as JSON (`integrity_reports` table) and shown in an HTML view the browser can print to PDF. The report is bound to an exact document revision. | L |
| Non-linear flagging | **Missing.** | Pure classifier in `image-processing`. Gamma ≠ 1, non-linear LUT, clipping above a threshold, and non-uniform per-panel adjustment of panels compared side by side get **flagged**. Invert, flips, and rotation get **disclosed**. | S |
| Original-versus-figure comparison: "As Shown In Figure" next to "Raw Upload", with each adjustment listed as a percentage ("Brightness +12.0%") or "No image adjustments detected." **[B][W]** | **Partial.** "Show in Original" highlights the crop. | A comparison view: the raw original window next to the processed crop, with a difference toggle and both histograms. | M |
| Duplicate/reuse detection: not found | **Partial.** SHA-256 per asset. | Warn when the same SHA-256 is uploaded twice in a project, and in the report when two panels' viewports of one asset overlap. Perceptual duplicate detection is not planned. | S |

## 6. Export

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| PNG **[B]** | **Has.** Browser CPU composition from originals. | Add DPI: pixel size = physical size × DPI (300/600/custom), written as PNG `pHYs`. | S |
| SVG ("To SVG") **[B]** | **Missing.** | SVG with vector annotations. Each panel is embedded as its own PNG rendered from original samples at panel size × DPI. | M |
| TIFF | **Missing.** Not found in Sciugo. | Baseline TIFF encoder in `image-processing` (RGB 8-bit, LZW or Deflate, resolution tags). Vector layer rasterized from the same scene description. | M |
| PDF | **Missing.** Not found in Sciugo. | PDF (pdf-lib, MIT) with vector text, shapes, and embedded font. Panels are embedded as lossless images at target DPI. | M |
| Journal presets | **Missing.** Not found in Sciugo. | Export presets = artboard preset + DPI + format, e.g. "Nature double column, 600 dpi TIFF". | S |
| Batch export | **Missing.** Not found in Sciugo. | Export all artboards in one format to a zip (fflate, MIT), in the browser. Each file gets its own `export_records` row. | S |
| Source data / provenance bundle: FAIR claim, "Auto-generated supplemental info" **[B]** (roadmap), "Cite Sciugo" **[O][B]** | **Partial.** Each export records revision, size, and SHA-256. | **Provenance bundle** zip containing: `figure.json` (exact revision), export files and hashes, `integrity-report.json`, the uncropped-blot sheet, a crops CSV (asset, SHA-256, px rectangle, angle, display), optional original files, and densitometry CSV. The browser assembles it. Its hash is recorded with format `bundle`. | M |

Shared mechanism: a single pure **scene builder** (`document → ordered draw list of raster panels
and vector items`). The Pixi preview, SVG/PDF writers, and the raster rasterizer all read it. The
raster rasterizer CPU-composites panels from originals as today, then composites vector items
rasterized by the browser from the same SVG. One builder keeps every format consistent.

## 7. Organization and collaboration

| Sciugo feature (evidence) | FigLab today | Proposed design | Effort |
| --- | --- | --- | --- |
| Lab workspaces: "Workspaces", "Personal Workspace", "Lab Management". "PIs may add lab members to their accounts" (University of Utah pilot). The "Lab License Management" tab is a placeholder: its statuses come from `Math.random()` **[B][W]**. | **Partial.** The tables allow many members per workspace; code gives each user exactly one personal workspace, and `Principal.workspaceId` holds a single workspace. | `Principal` gets memberships; requests name the workspace in the route (`/v1/workspaces/:wid/projects`), and the old routes keep resolving to the personal workspace. `Authorizer` checks membership role per project. A minimal workspace switcher and create-lab screen. | L |
| PI invites members: "Send Invites", "Pending Invites", "Members (Accepted)", "inviteResponse"; institutional email verification **[B]** | **Missing.** | `workspace_invites` table (hashed token, email, role, expiry). The PI gets a **copyable invite link**, which works without SMTP. Optional email needs custom SMTP on Supabase (decision **D2**). Accept requires a signed-in, verified user whose email matches the invite. | M |
| Roles: the group role picker offers **Member / Admin**; OWNER/WRITE/READ constants exist internally; "Insufficient edit permissions." **[B][W]** | **Partial.** A role column exists, always `owner`; global `admin` lives in a JWT claim. | Workspace roles `owner`, `admin`, `editor`, `viewer`, enforced in `Authorizer` and covered by integration tests per route. Viewers can read and export but not save. | M |
| Sharing: groups exist ("createGroup"), but the **Sharing tab is a placeholder** ("Configure shared data and projects here.") **[B][W]** | **Missing.** | Sharing is workspace membership. Per-project grants to individuals are deferred (decision **D3**). | — |
| Comments: Sciugo has only a feedback form and a "Live Help" *support* chat **[B]**; no figure comments found | **Missing.** | Anchored comment threads: `comments(project_id, artboard_id, object_id?, x/y pt?, body, author, resolved_at)`, plus a side panel. Polling, not realtime. | M |
| Folders: file-system tree, Home Folder, rename, move, archive, sort by name/created/edited/last used, list view **[B]** | **Missing.** | `folders` table (tree per workspace), nullable `projects.folder_id`, and move/rename/archive. | M |
| Search: only antibody/protein search in the inventory **[B]** | **Missing.** | Project search by name, plus filter by folder and owner (`ILIKE`, indexed). Asset filename search within a project. | S |
| Admin screens: "Admin" string only **[B]** | **Partial.** Admin role, no UI. | `/v1/admin/*` (admin-only): users, workspaces, storage use per workspace, recent jobs and failures, confirm or disable users through the Supabase secret key. | M |
| Subscriptions **[B]**: individual or lab plans, Academic or Industry, monthly or yearly through Stripe. Lab plans are sales-led. Trial-then-read-only, referrals, institutional email required with 1–2 week validation, and "All figures must be cited with … sciugo.com". | n/a | Out of scope (FigLab is AGPL and self-hostable). | — |

## 8. Sciugo modules outside figure-making (decision D1)

The bundle also ships an ELN-lite. None of this is figure capability:

- an inventory of antibodies (supplier, dilution, lot, and "Usages" linked to images), compounds,
  and cell lines;
- well **Plates** (wells, liquids, plate image download);
- Protocols, Publications, Experiments, and Notes.

Recommendation: leave these out. The one exception is free-text **sample/antibody metadata** on a
blot panel (target, antibody, dilution, lot), which feeds the integrity report and legend (P2, S).

## Data, contract, and migration impact

- **Figure schema v2** in `packages/figure-schema`. `migrateFigureDocument` gets a real dispatch:
  v1 → v2 adds `schemaVersion: 2`, `display.levels/lut` defaults, `view.flip`, `view.rotationDeg = 0`,
  empty `assetCalibrations/assetMarkers`, and keeps everything else.
  - The API's load and save paths call `migrateFigureDocument` in place of `decodeFigureDocument`.
    Saving always writes v2.
  - `objects` becomes a discriminated union: `image-view`, `channel-composite`, `text`, `shape`,
    `panel-label`, `scale-bar`, `zoom-link`, and `lane-table`.
  - **Rollback risk:** once production stores v2 documents, redeploying the old build makes those
    projects fail with `UNSUPPORTED_SCHEMA_VERSION`. The data is not lost, but they won't open.
    Mitigation: ship the v2 reader before any v2 writer.
- **Additive SQL migrations**, `0003+`:
  - `audit_events.actor_user_id` (nullable);
  - widen the `export_records.format` check to png/tiff/pdf/svg/zip/bundle;
  - add `export_records.artboard_id` and `export_records.dpi` (nullable);
  - new tables: `integrity_reports`, `workspace_invites`, `folders`, `comments`, and
    `project_templates` (or `projects.is_template`);
  - a nullable `projects.folder_id`;
  - indexes for project search.

  Every new table gets RLS enabled with no policies, matching `0001`.
- **API contract**: the new routes above, added to `packages/api-contract`. Then regenerate
  `openapi/openapi-v1.yaml`. The repo records no generator command; the file's style matches
  `@fastify/swagger` output dumped through Ruby's YAML. P0 will add
  `scripts/generate-openapi.mjs` so the regeneration is repeatable.
- **Jobs**: `integrity_report`, extended `verify_asset` (planes, calibration, OME), later
  `build_preview_pyramid`. All run under `drainJobsOnce`'s 15-minute window.

## Proposed roadmap

**P0: editor foundation, export, audit visibility.** Everything later builds on these.

1. Schema v2, real migration, and API switched to migrate-on-read. Version history read endpoints.
2. Editor-core: multi-select, duplicate, z-order, lock, align/distribute, snap helper, grouping, and
   artboard commands (several figures, journal size presets, mm/in units).
3. Annotations: text (bundled font), shapes (line, arrow, rectangle, ellipse, bracket), and auto
   panel labels.
4. Scene builder, then export PNG/TIFF/SVG/PDF with DPI 300/600/custom, journal export presets,
   and batch zip.
5. Audit-events read endpoint with actor, audit panel, version list, and an OpenAPI generator script.

**P1: blot, microscopy, integrity** (Sciugo's core scientific workflows):

1. Rotated "line crop" viewports, flip, 90° panel rotation, and bilinear resampling.
2. Lane/condition tables, MW markers with ladder catalog, and the uncropped-blot sheet.
3. Calibration from metadata or manual, scale bars, and linked zoom insets.
4. LUTs, levels, histogram, channel-composite views, and split-to-row.
5. Multi-page, tiled, BigTIFF, and OME-TIFF ingestion with planes.
6. Integrity report job, non-linear classifier, comparison view, and provenance bundle.

**P2: labs and collaboration, quantification, scale:**

1. Lab workspaces, invite links, roles, and workspace-scoped templates.
2. Folders, search, comments, and admin screens.
3. Densitometry with CSV, loading-control normalization, and the screener checks.
4. Sample/antibody panel metadata, and the large-image preview pyramid job.

Rough size: P0 ≈ 12–16 agent-days, P1 ≈ 18–24, P2 ≈ 16–22. Each numbered item ships as its own
commit series with unit, integration, e2e, and live tests.

## Decisions (approved 2026-10-06)

- **D1** Sciugo's ELN-lite modules (inventory, plates, protocols): **left out**.
- **D2** Lab invites: **copyable link only**; no SMTP or email sending.
- **D3** Sharing: **workspace membership only**; no per-project grants.
- **D4** Audit retention: **keep** audit rows after a project is deleted (tombstone the project).
- **D5** Lab workspaces: **stay in P2**, so P0 and P1 do not touch production authorization.
- **D6** Fonts: **bundle Arimo** (Apache-2.0, Arial-metric) for consistent export text.
