import type { AssetDescriptor, Project, ProjectDocumentResponse } from "@figlab/api-contract";
import { selectImageProvenance } from "@figlab/editor-core";
import { type ImageViewObjectV3, isImageView } from "@figlab/figure-schema";
import { Button, Panel } from "@figlab/ui";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "./api/client";
import { downloadBlob } from "./api/export";
import type { SignedInAccount } from "./auth/auth-gate";
import { AutosaveController, type SaveStatus } from "./editor/autosave";
import { bindAutosave } from "./editor/autosave-binding";
import { BrowserRasterRepository, type SupportedRasterMime } from "./editor/raster-sources";
import { createEditorSession } from "./editor/session-store";
import { ArrangePanel } from "./figure-tools/arrange-panel";
import { useDerivedSync } from "./figure-tools/derived-sync";
import { exportFigures } from "./figure-tools/export-figure";
import { ExportPanel } from "./figure-tools/export-panel";
import { FigureCanvas } from "./figure-tools/figure-canvas";
import { FiguresBar } from "./figure-tools/figures-bar";
import { FALLBACK_TEXT_METRICS, loadFigureFonts, useFigureFonts } from "./figure-tools/fonts";
import { HistoryPanel } from "./figure-tools/history-panel";
import { IntegrityPanel } from "./figure-tools/integrity-panel";
import { handleFigureShortcut } from "./figure-tools/keyboard";
import { ObjectInspector } from "./figure-tools/object-inspector";
import { PanelInspector } from "./figure-tools/panel-inspector";
import { rasterizeVectorItems } from "./figure-tools/rasterize";
import { SourceInspector } from "./figure-tools/source-inspector";
import "./styles.css";

const defaultClient = new FigLabClient();

export function FigLabApp({
  client = defaultClient,
  account,
}: {
  client?: FigLabClient;
  account?: SignedInAccount;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [project, setProject] = useState<Project>();
  return (
    <QueryClientProvider client={queryClient}>
      {project ? (
        <EditorLoader client={client} onBack={() => setProject(undefined)} project={project} />
      ) : (
        <Dashboard account={account} client={client} onOpen={setProject} />
      )}
    </QueryClientProvider>
  );
}

function AccountMenu({ account, client }: { account: SignedInAccount; client: FigLabClient }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.me() });
  return (
    <div className="account-menu">
      <span className="account-email">{account.email}</span>
      {me.data?.role === "admin" && <span className="role-badge">Admin</span>}
      <Button onClick={() => void account.signOut()}>Sign out</Button>
    </div>
  );
}

function Dashboard({
  account,
  client,
  onOpen,
}: {
  account: SignedInAccount | undefined;
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
        {account && <AccountMenu account={account} client={client} />}
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
    initial.document.objects.find(isImageView)?.view.sourceAssetId,
  );
  const [uploadStatus, setUploadStatus] = useState(
    "Choose a PNG, JPEG, or TIFF original to upload.",
  );
  const [exportStatus, setExportStatus] = useState("");
  const [exportCount, setExportCount] = useState(0);
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
        return;
      }
      if (!isTextEntryTarget(event.target) && handleFigureShortcut(event, session))
        event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);
  useEffect(() => {
    let cancelled = false;
    const referencedAssetIds = [
      ...new Set(
        initial.document.objects.filter(isImageView).map((object) => object.view.sourceAssetId),
      ),
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

  const selected = state.document.objects
    .filter(isImageView)
    .find((object) => object.id === state.selectedObjectId);
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const fonts = useFigureFonts();
  const metrics = fonts?.metrics ?? FALLBACK_TEXT_METRICS;
  useDerivedSync(session, metrics);
  const provenance = selected ? selectImageProvenance(state.document, selected.id) : undefined;

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
          <ArrangePanel metrics={metrics} session={session} />
        </aside>
        <section aria-label="Figure editor" className="workspace">
          <SourceInspector
            asset={selectedAsset}
            onCrop={(viewport, plane) => {
              if (!selectedAssetId) return;
              session.getState().beginCrop({ x: viewport.x, y: viewport.y });
              session
                .getState()
                .previewCrop({ x: viewport.x + viewport.width, y: viewport.y + viewport.height });
              session
                .getState()
                .commitCrop(
                  selectedAssetId,
                  `view-${crypto.randomUUID()}`,
                  selectedAsset
                    ? { widthPx: selectedAsset.widthPx, heightPx: selectedAsset.heightPx }
                    : undefined,
                  plane,
                );
            }}
            rasterSources={rasterSources}
            session={session}
          />
          <div className="figure-stage">
            <FiguresBar session={session} />
            <FigureCanvas metrics={metrics} rasterSources={rasterSources} session={session} />
          </div>
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
          <ObjectInspector metrics={metrics} session={session} />
          <PanelInspector assets={assets} rasterSources={rasterSources} session={session} />
          <ExportPanel
            activeArtboardId={state.activeArtboardId}
            document={state.document}
            onExport={async (choice) => {
              setExportStatus("Saving the exact revision for export…");
              try {
                const saved = await autosave.saveNow();
                if (!saved) {
                  setExportStatus(
                    "Save the project before exporting. Recover your local work first.",
                  );
                  return;
                }
                setExportStatus(`Preparing ${choice.format.toUpperCase()} from original pixels…`);
                const result = await exportFigures(
                  {
                    ...choice,
                    document: saved.document,
                    revision: saved.revision,
                    activeArtboardId: state.activeArtboardId,
                    projectName: project.name,
                  },
                  {
                    resolver: rasterSources,
                    fonts: fonts ?? (await loadFigureFonts()),
                    rasterize: rasterizeVectorItems,
                    record: (metadata) => client.recordExport(project.id, metadata),
                    download: downloadBlob,
                  },
                );
                setExportCount((count) => count + 1);
                setExportStatus(
                  `${result.filename} downloaded and provenance recorded for ${result.figures} figure${result.figures === 1 ? "" : "s"}.`,
                );
              } catch (error) {
                setExportStatus(error instanceof Error ? error.message : "Export failed.");
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
          <IntegrityPanel
            assets={assets}
            client={client}
            download={downloadBlob}
            fonts={fonts}
            projectId={project.id}
            projectName={project.name}
            rasterSources={rasterSources}
            saveExact={() => autosave.saveNow()}
            session={session}
          />
          <HistoryPanel
            client={client}
            onRestore={(document) => session.getState().apply(() => document, { selectedIds: [] })}
            projectId={project.id}
            refreshKey={exportCount}
            revision={revision}
          />
        </aside>
      </div>
    </main>
  );
}

function TransformControls({
  object,
  onChange,
}: {
  object: ImageViewObjectV3;
  onChange: (display: ImageViewObjectV3["view"]["display"]) => void;
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

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
