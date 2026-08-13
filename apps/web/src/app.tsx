import type { AssetDescriptor, Project, ProjectDocumentResponse } from "@figlab/api-contract";
import { type ResizeAnchor, selectImageProvenance } from "@figlab/editor-core";
import type { FigureDocumentV1, ImageViewObjectV1, NormalizedRect } from "@figlab/figure-schema";
import { Button, Panel } from "@figlab/ui";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "./api/client";
import { createArtboardPngExporter, downloadBlob, exportPng } from "./api/export";
import { AutosaveController, type SaveStatus } from "./editor/autosave";
import { bindAutosave } from "./editor/autosave-binding";
import {
  type ArtboardScreenTransform,
  artboardScreenTransform,
  imageContainRect,
  normalizedPointInImage,
  type ScreenRect,
} from "./editor/geometry";
import { BrowserRasterRepository, type SupportedRasterMime } from "./editor/raster-sources";
import { createEditorSession, type Point } from "./editor/session-store";
import { PixiArtboard } from "./pixi-artboard";
import "./styles.css";

const defaultClient = new FigLabClient();

export function FigLabApp({ client = defaultClient }: { client?: FigLabClient }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [project, setProject] = useState<Project>();
  return (
    <QueryClientProvider client={queryClient}>
      {project ? (
        <EditorLoader client={client} onBack={() => setProject(undefined)} project={project} />
      ) : (
        <Dashboard client={client} onOpen={setProject} />
      )}
    </QueryClientProvider>
  );
}

function Dashboard({
  client,
  onOpen,
}: {
  client: FigLabClient;
  onOpen: (project: Project) => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.listProjects() });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (projectName: string) => client.createProject(projectName),
    onSuccess: (created) => onOpen(created),
  });
  const rename = useMutation({
    mutationFn: ({ projectId, projectName }: { projectId: string; projectName: string }) =>
      client.renameProject(projectId, projectName),
    onSuccess: () => projects.refetch(),
  });
  const remove = useMutation({
    mutationFn: (projectId: string) => client.deleteProject(projectId),
    onSuccess: () => projects.refetch(),
  });
  return (
    <main className="app-shell">
      <header className="app-header">
        <strong>FigLab</strong>
        <span>Scientific figure workspace</span>
      </header>
      <div className="dashboard-layout">
        <nav aria-label="Project navigation" className="side-nav">
          <strong>Projects</strong>
        </nav>
        <section aria-labelledby="projects-heading" className="dashboard-content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1 id="projects-heading">Projects</h1>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate(name.trim());
              }}
            >
              <input
                aria-label="New project name"
                onChange={(event) => setName(event.target.value)}
                placeholder="New project name"
                value={name}
              />
              <Button disabled={create.isPending} type="submit">
                Create project
              </Button>
            </form>
          </div>
          {projects.isLoading && <p role="status">Loading projects…</p>}
          {projects.isError && (
            <p role="alert">Could not load projects. Retry when the server is available.</p>
          )}
          {projects.data?.length === 0 && (
            <p className="empty-state">No projects yet. Create one to begin a figure.</p>
          )}
          <div className="project-grid">
            {projects.data?.map((item) => (
              <Panel key={item.id}>
                <h2>{item.name}</h2>
                <p>Updated {new Date(item.updatedAt).toLocaleDateString()}</p>
                <Button aria-label={`Open ${item.name}`} onClick={() => onOpen(item)}>
                  Open
                </Button>
                <Button
                  aria-label={`Rename ${item.name}`}
                  onClick={() => {
                    const value = window.prompt("Rename project", item.name)?.trim();
                    if (value) rename.mutate({ projectId: item.id, projectName: value });
                  }}
                >
                  Rename
                </Button>
                <Button
                  aria-label={`Delete ${item.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete ${item.name}?`)) remove.mutate(item.id);
                  }}
                >
                  Delete
                </Button>
              </Panel>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function EditorLoader({
  client,
  project,
  onBack,
}: {
  client: FigLabClient;
  project: Project;
  onBack: () => void;
}) {
  const loaded = useQuery({
    queryKey: ["document", project.id],
    queryFn: () => client.getDocument(project.id),
  });
  if (loaded.isLoading)
    return (
      <main className="loading-page">
        <p role="status">Loading {project.name}…</p>
      </main>
    );
  if (loaded.isError || !loaded.data)
    return (
      <main className="loading-page">
        <p role="alert">Could not load this project.</p>
        <Button onClick={onBack}>Projects</Button>
      </main>
    );
  return (
    <FigLabEditor
      client={client}
      initial={loaded.data}
      onBack={onBack}
      project={project}
      reload={() => loaded.refetch()}
    />
  );
}

export function FigLabEditor({
  client = defaultClient,
  initial,
  onBack,
  project,
  reload,
}: {
  client?: FigLabClient;
  initial: ProjectDocumentResponse;
  onBack: () => void;
  project: Project;
  reload: () => Promise<{ data: ProjectDocumentResponse | undefined }>;
}) {
  const [session] = useState(() => createEditorSession(initial.document));
  const state = useStore(session);
  const [revision, setRevision] = useState(initial.revision);
  const [assets, setAssets] = useState<AssetDescriptor[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState(
    initial.document.objects[0]?.view.sourceAssetId,
  );
  const [uploadStatus, setUploadStatus] = useState(
    "Choose a PNG, JPEG, or TIFF original to upload.",
  );
  const [exportStatus, setExportStatus] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [rasterSources] = useState(() => new BrowserRasterRepository());
  const saveState = useRef({ document: initial.document, revision: initial.revision });
  saveState.current = { document: state.document, revision };
  const autosave = useMemo(
    () =>
      new AutosaveController(
        async (baseRevision, document) => {
          const response = await client.saveDocument(project.id, baseRevision, document);
          saveState.current = { ...saveState.current, revision: response.revision };
          setRevision(response.revision);
          return response.revision;
        },
        () => saveState.current.document,
        () => saveState.current.revision,
        setSaveStatus,
      ),
    [client, project.id],
  );
  useEffect(() => bindAutosave(session, autosave), [autosave, session]);
  useEffect(() => () => rasterSources.dispose(), [rasterSources]);

  const navigateBack = useCallback(async () => {
    const saved = await autosave.flushBeforeNavigation();
    if (saved) onBack();
  }, [autosave, onBack]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) session.getState().redo();
        else session.getState().undo();
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !isTextEntryTarget(event.target)
      ) {
        event.preventDefault();
        session.getState().deleteSelectedObject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);
  useEffect(() => {
    let cancelled = false;
    const referencedAssetIds = [
      ...new Set(initial.document.objects.map((object) => object.view.sourceAssetId)),
    ];
    void Promise.all(
      referencedAssetIds.map(async (assetId) => {
        if (rasterSources.has(assetId)) return;
        const asset = await client.getAsset(assetId);
        if (asset.status !== "ready") return;
        const download = await client.downloadAsset(assetId);
        await rasterSources.add(assetId, download.bytes, asset.mimeType as SupportedRasterMime);
        if (!cancelled)
          setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      }),
    ).catch((error: unknown) => {
      if (!cancelled)
        setUploadStatus(
          error instanceof Error
            ? `Could not load an original: ${error.message}`
            : "Could not load an original.",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [client, initial.document, rasterSources]);

  const selected = state.document.objects.find((object) => object.id === state.selectedObjectId);
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const selectedPreviewUrl = selectedAssetId
    ? rasterSources.getPreviewUrl(selectedAssetId)
    : undefined;
  const provenance = selected ? selectImageProvenance(state.document, selected.id) : undefined;
  const highlightedViewport = provenance?.viewport;

  const upload = async (file: File) => {
    setUploadStatus("Computing SHA-256 and reserving upload…");
    try {
      const asset = await client.prepareAndUpload(project.id, file, file.name, (stage) =>
        setUploadStatus(`Upload ${stage}`),
      );
      if (asset.status === "rejected") {
        setUploadStatus(
          `Upload rejected: ${asset.rejectionReason ?? "unsupported image"}. Choose the original again to retry.`,
        );
        return;
      }
      await rasterSources.add(
        asset.id,
        await file.arrayBuffer(),
        asset.mimeType as SupportedRasterMime,
      );
      setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      setSelectedAssetId(asset.id);
      setUploadStatus("Upload completed and verified.");
    } catch (error) {
      setUploadStatus(
        error instanceof Error
          ? `Upload failed: ${error.message}. Choose the original again to retry.`
          : "Upload failed. Retry.",
      );
    }
  };

  const recoverLatest = async () => {
    const result = await reload();
    if (!result.data) return;
    session.getState().replaceDocument(result.data.document);
    setRevision(result.data.revision);
    autosave.resetAfterReload();
  };

  return (
    <main className="editor-shell">
      <header className="app-header editor-header">
        <Button onClick={() => void navigateBack()}>Projects</Button>
        <h1>{project.name}</h1>
        <span role="status">
          {saveStatus === "conflict"
            ? "Save conflict"
            : saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "error"
                ? "Save error"
                : "Saved"}
        </span>
        <Button disabled={!state.history.length} onClick={() => session.getState().undo()}>
          Undo
        </Button>
        <Button disabled={!state.future.length} onClick={() => session.getState().redo()}>
          Redo
        </Button>
      </header>
      {(saveStatus === "conflict" || saveStatus === "error") && (
        <div className="conflict-banner" role="alert">
          {saveStatus === "conflict"
            ? "The project changed on the server. Your local work is retained."
            : "The project could not be saved. Your local work is retained."}
          <Button onClick={() => void recoverLatest()}>Reload latest</Button>
          <Button
            onClick={() => downloadBlob(autosave.downloadMyJson(), `${project.name}-local.json`)}
          >
            Download my JSON
          </Button>
        </div>
      )}
      <div className="editor-layout">
        <aside aria-label="Source library" className="source-library">
          <h2>Source library</h2>
          <label className="upload-control">
            Upload original
            <input
              aria-label="Upload original"
              accept="image/png,image/jpeg,image/tiff"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void upload(file);
              }}
              type="file"
            />
          </label>
          <p role="status">{uploadStatus}</p>
          {assets.map((asset) => (
            <button
              className="source-item"
              key={asset.id}
              onClick={() => setSelectedAssetId(asset.id)}
              type="button"
            >
              Original · {asset.filename}
            </button>
          ))}
        </aside>
        <section aria-label="Figure editor" className="workspace">
          <OriginalInspector
            {...(selectedAsset ? { asset: selectedAsset } : {})}
            {...(highlightedViewport ? { highlightedViewport } : {})}
            onCrop={(viewport) => {
              if (!selectedAssetId) return;
              session.getState().beginCrop({ x: viewport.x, y: viewport.y });
              session
                .getState()
                .previewCrop({ x: viewport.x + viewport.width, y: viewport.y + viewport.height });
              session.getState().commitCrop(selectedAssetId, `view-${crypto.randomUUID()}`);
            }}
            {...(selectedPreviewUrl ? { previewUrl: selectedPreviewUrl } : {})}
          />
          <ArtboardEditor
            document={state.document}
            {...(state.objectGesture ? { gesture: state.objectGesture } : {})}
            onCommit={() => session.getState().commitObjectTransform()}
            onMove={(id, delta) => {
              if (state.objectGesture?.objectId !== id) session.getState().beginObjectGesture(id);
              session.getState().previewObjectDelta(delta);
            }}
            onResize={(id, delta, anchor) => {
              if (state.objectGesture?.objectId !== id) session.getState().beginObjectGesture(id);
              session.getState().previewObjectResize(delta, anchor);
            }}
            onSelect={(id) => session.getState().selectObject(id)}
            rasterSources={rasterSources}
            {...(state.selectedObjectId ? { selectedId: state.selectedObjectId } : {})}
          />
        </section>
        <aside aria-label="Display inspector" className="display-inspector">
          <h2>Display inspector</h2>
          {selected ? (
            <>
              <TransformControls
                object={selected}
                onChange={(display) => session.getState().setDisplay(selected.id, display)}
              />
              <Button onClick={() => session.getState().deleteSelectedObject()}>
                Delete selected panel
              </Button>
            </>
          ) : (
            <p className="empty-state">Select or crop an image to adjust its display transform.</p>
          )}
          <ExportControls
            artboard={state.document.artboards[0]}
            onExport={async (widthPx, heightPx) => {
              setExportStatus("Saving the exact revision for export…");
              try {
                const saved = await autosave.saveNow();
                if (!saved) {
                  setExportStatus(
                    "Save the project before exporting. Recover your local work first.",
                  );
                  return;
                }
                const artboardId = saved.document.artboards[0]?.id;
                if (!artboardId) return;
                setExportStatus("Preparing original-source PNG…");
                await exportPng({
                  document: saved.document,
                  revision: saved.revision,
                  widthPx,
                  heightPx,
                  sourceExporter: createArtboardPngExporter(artboardId, rasterSources),
                  record: (metadata) => client.recordExport(project.id, metadata),
                  download: downloadBlob,
                });
                setExportStatus("PNG downloaded and provenance recorded.");
              } catch (error) {
                setExportStatus(error instanceof Error ? error.message : "PNG export failed.");
              }
            }}
            status={exportStatus}
          />
          <h3>Provenance</h3>
          {provenance ? (
            <>
              <Button onClick={() => setSelectedAssetId(provenance.assetId)}>
                Show in Original
              </Button>
              <p>
                Source crop x {provenance.viewport.x}, y {provenance.viewport.y}, width{" "}
                {provenance.viewport.width}, height {provenance.viewport.height}.
              </p>
              <p>
                Sibling panels:{" "}
                {provenance.siblingImageViewIds.length
                  ? provenance.siblingImageViewIds.join(", ")
                  : "none"}
              </p>
            </>
          ) : (
            <p>Source crop details appear here.</p>
          )}
        </aside>
      </div>
    </main>
  );
}

function OriginalInspector({
  asset,
  previewUrl,
  highlightedViewport,
  onCrop,
}: {
  asset?: AssetDescriptor;
  previewUrl?: string;
  highlightedViewport?: NormalizedRect;
  onCrop: (viewport: NormalizedRect) => void;
}) {
  const [draft, setDraft] = useState<{ start: Point; end: Point }>();
  const draftRef = useRef<{ start: Point; end: Point } | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const [imageRect, setImageRect] = useState<ScreenRect>();
  useEffect(() => {
    const target = host.current;
    if (!target || !asset) return;
    const update = () =>
      setImageRect(
        imageContainRect(
          { width: target.clientWidth, height: target.clientHeight },
          { width: asset.widthPx, height: asset.heightPx },
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [asset]);
  const updateDraft = (value: { start: Point; end: Point } | undefined) => {
    draftRef.current = value;
    setDraft(value);
  };
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!imageRect) return { x: 0, y: 0 };
    return normalizedPointInImage(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      imageRect,
    );
  };
  const viewport = draft ? rectFromPoints(draft.start, draft.end) : highlightedViewport;
  return (
    <div className="original-inspector">
      <div>
        <p className="eyebrow">Original inspector</p>
        <h2>Drag to crop</h2>
      </div>
      <div
        className="source-canvas"
        data-testid="source-canvas"
        ref={host}
        onPointerDown={(event) => {
          const start = point(event);
          updateDraft({ start, end: start });
        }}
        onPointerMove={(event) => {
          const active = draftRef.current;
          if (active) updateDraft({ ...active, end: point(event) });
        }}
        onPointerUp={(event) => {
          const active = draftRef.current;
          if (!active) return;
          const crop = rectFromPoints(active.start, point(event));
          updateDraft(undefined);
          if (crop.width > 0 && crop.height > 0) onCrop(crop);
        }}
      >
        {previewUrl && asset ? (
          <img alt={`Original ${asset.filename}`} src={previewUrl} />
        ) : (
          <span>Upload and select an original source raster</span>
        )}
        {viewport && (
          <div
            aria-label="Crop selection"
            className="crop-overlay"
            role="img"
            style={viewportStyle(viewport, imageRect)}
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
    </div>
  );
}

function ArtboardEditor({
  document,
  gesture,
  selectedId,
  rasterSources,
  onSelect,
  onMove,
  onResize,
  onCommit,
}: {
  document: FigureDocumentV1;
  gesture?: { objectId: string; transform: ImageViewObjectV1["transform"] };
  selectedId?: string;
  rasterSources: BrowserRasterRepository;
  onSelect: (id: string) => void;
  onMove: (id: string, delta: Point) => void;
  onResize: (id: string, delta: Point, anchor: ResizeAnchor) => void;
  onCommit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const board = document.artboards[0];
  const [screenTransform, setScreenTransform] = useState<ArtboardScreenTransform>();
  useEffect(() => {
    const target = host.current;
    if (!target || !board) return;
    const update = () =>
      setScreenTransform(
        artboardScreenTransform(
          target.clientWidth,
          target.clientHeight,
          board.widthPt,
          board.heightPt,
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [board]);
  const starts = useRef(
    new Map<number, { x: number; y: number; id: string; resize?: ResizeAnchor }>(),
  );
  return (
    <div className="artboard-wrap" ref={host}>
      <PixiArtboard
        document={document}
        {...(gesture ? { preview: gesture } : {})}
        rasterSources={rasterSources}
        {...(screenTransform ? { screenTransform } : {})}
      />
      <div className="selection-layer">
        {document.objects.map((object) => {
          const transform =
            object.id === selectedId && gesture ? gesture.transform : object.transform;
          const begin = (event: React.PointerEvent, resize?: ResizeAnchor) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            starts.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
              id: object.id,
              ...(resize ? { resize } : {}),
            });
            onSelect(object.id);
          };
          const move = (event: React.PointerEvent) => {
            const start = starts.current.get(event.pointerId);
            if (!start) return;
            const screenDelta = { x: event.clientX - start.x, y: event.clientY - start.y };
            const delta = screenTransform?.screenDeltaToPoints(screenDelta) ?? screenDelta;
            if (start.resize) onResize(start.id, delta, start.resize);
            else onMove(start.id, delta);
          };
          const end = (event: React.PointerEvent) => {
            if (!starts.current.delete(event.pointerId)) return;
            onCommit();
          };
          return (
            <div
              className={`artboard-selection ${object.id === selectedId ? "selected" : ""}`}
              key={object.id}
              style={transformStyle(transform, screenTransform)}
            >
              <button
                aria-label={`Move ${object.id}`}
                className="move-handle"
                onPointerDown={begin}
                onPointerMove={move}
                onPointerUp={end}
                type="button"
              />
              {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((anchor) => (
                <button
                  aria-label={`Resize ${object.id} from ${anchor.replace("-", " ")}`}
                  className={`resize-handle ${anchor}`}
                  key={anchor}
                  onPointerDown={(event) => begin(event, anchor)}
                  onPointerMove={move}
                  onPointerUp={end}
                  type="button"
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExportControls({
  artboard,
  onExport,
  status,
}: {
  artboard: FigureDocumentV1["artboards"][number] | undefined;
  onExport: (width: number, height: number) => Promise<void>;
  status: string;
}) {
  const [scale, setScale] = useState<"1" | "2" | "custom">("1");
  const [custom, setCustom] = useState("1200");
  const width =
    scale === "custom" ? Number(custom) : Math.round((artboard?.widthPt ?? 0) * Number(scale));
  const height = Math.round(width * ((artboard?.heightPt ?? 0) / (artboard?.widthPt ?? 1)));
  return (
    <section aria-labelledby="png-export" className="export-controls">
      <h3 id="png-export">PNG export</h3>
      <label>
        <input
          checked={scale === "1"}
          name="png-scale"
          onChange={() => setScale("1")}
          type="radio"
        />
        1×
      </label>
      <label>
        <input
          checked={scale === "2"}
          name="png-scale"
          onChange={() => setScale("2")}
          type="radio"
        />
        2×
      </label>
      <label>
        <input
          checked={scale === "custom"}
          name="png-scale"
          onChange={() => setScale("custom")}
          type="radio"
        />
        Custom width
      </label>
      <input
        aria-label="Custom width"
        disabled={scale !== "custom"}
        min="1"
        onChange={(event) => setCustom(event.target.value)}
        type="number"
        value={custom}
      />
      <Button
        disabled={!artboard || !Number.isFinite(width) || width < 1 || height < 1}
        onClick={() => void onExport(width, height)}
      >
        Export PNG
      </Button>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function TransformControls({
  object,
  onChange,
}: {
  object: ImageViewObjectV1;
  onChange: (display: ImageViewObjectV1["view"]["display"]) => void;
}) {
  const display = object.view.display;
  const range = (
    label: string,
    key: "brightness" | "contrast" | "gamma",
    min: number,
    max: number,
    step: number,
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange({ ...display, [key]: Number(event.target.value) })}
        step={step}
        type="range"
        value={display[key]}
      />
      <output>{display[key]}</output>
    </label>
  );
  return (
    <div className="transform-controls">
      {range("Brightness", "brightness", -1, 1, 0.01)}
      {range("Contrast", "contrast", 0, 4, 0.01)}
      {range("Gamma", "gamma", 0.1, 10, 0.1)}
      <label>
        <input
          aria-label="Invert"
          checked={display.invert}
          onChange={(event) => onChange({ ...display, invert: event.target.checked })}
          type="checkbox"
        />
        Invert
      </label>
    </div>
  );
}

function rectFromPoints(start: Point, end: Point): NormalizedRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    width: Number(Math.abs(end.x - start.x).toFixed(6)),
    height: Number(Math.abs(end.y - start.y).toFixed(6)),
  };
}
function viewportStyle(viewport: NormalizedRect, imageRect?: ScreenRect) {
  if (!imageRect) return { display: "none" };
  return {
    left: imageRect.left + viewport.x * imageRect.width,
    top: imageRect.top + viewport.y * imageRect.height,
    width: viewport.width * imageRect.width,
    height: viewport.height * imageRect.height,
  };
}
function transformStyle(
  transform: ImageViewObjectV1["transform"],
  screen?: ArtboardScreenTransform,
) {
  if (!screen) return { display: "none" };
  return {
    left: screen.leftPx + transform.xPt * screen.scale,
    top: screen.topPx + transform.yPt * screen.scale,
    width: transform.widthPt * screen.scale,
    height: transform.heightPt * screen.scale,
  };
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
