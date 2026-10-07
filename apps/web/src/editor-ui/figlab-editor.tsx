import type { AssetDescriptor, Project, ProjectDocumentResponse } from "@figlab/api-contract";
import { selectImageProvenance } from "@figlab/editor-core";
import { isImageView } from "@figlab/figure-schema";
import { Badge, EmptyState, IconButton, InfoIcon, TrashIcon, useToast } from "@figlab/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "../api/client";
import { downloadBlob } from "../api/export";
import type { SignedInAccount } from "../auth/auth-gate";
import { AutosaveController, type SaveStatus } from "../editor/autosave";
import { bindAutosave } from "../editor/autosave-binding";
import { BrowserRasterRepository, type SupportedRasterMime } from "../editor/raster-sources";
import { createEditorSession } from "../editor/session-store";
import { ArrangePanel } from "../figure-tools/arrange-panel";
import { CommentsPanel, TemplatePanel } from "../figure-tools/comments-panel";
import { useDerivedSync } from "../figure-tools/derived-sync";
import { exportFigures } from "../figure-tools/export-figure";
import { ExportPanel } from "../figure-tools/export-panel";
import { FigureCanvas } from "../figure-tools/figure-canvas";
import { FiguresBar } from "../figure-tools/figures-bar";
import { FALLBACK_TEXT_METRICS, loadFigureFonts, useFigureFonts } from "../figure-tools/fonts";
import { HistoryPanel } from "../figure-tools/history-panel";
import { IntegrityPanel } from "../figure-tools/integrity-panel";
import { handleFigureShortcut } from "../figure-tools/keyboard";
import { ObjectInspector } from "../figure-tools/object-inspector";
import { PanelInspector } from "../figure-tools/panel-inspector";
import { QuantifyPanel } from "../figure-tools/quantify-panel";
import { rasterizeVectorItems } from "../figure-tools/rasterize";
import { SourceInspector } from "../figure-tools/source-inspector";
import { AccountArea } from "../shell/account-menu";
import { isTextEntryTarget } from "./dom-helpers";
import { EditorToolbar, SaveProblemBanner } from "./editor-toolbar";
import { DisplaySection } from "./inspector/display-section";
import { ProvenanceSection } from "./inspector/provenance-section";
import { useEditorLayout } from "./layout-preferences";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { SourceLibrary } from "./source-library";
import { type UploadItem, updateUpload } from "./uploads";
import type { ZoomLevel } from "./zoom";

const defaultClient = new FigLabClient();

export function FigLabEditor({
  access = { readOnly: false, canModerate: true },
  client = defaultClient,
  account,
  initial,
  onBack,
  project,
  reload,
}: {
  /** The caller's workspace role: viewers comment and export but never save. */
  access?: { readOnly: boolean; canModerate: boolean; currentUserId?: string };
  client?: FigLabClient;
  account?: SignedInAccount | undefined;
  initial: ProjectDocumentResponse;
  onBack: () => void;
  project: Project;
  reload: () => Promise<{ data: ProjectDocumentResponse | undefined }>;
}) {
  const [session] = useState(() => createEditorSession(initial.document));
  const state = useStore(session);
  const [revision, setRevision] = useState(initial.revision);
  const [assets, setAssets] = useState<AssetDescriptor[]>([]);
  // Originals still downloading; their derived previews show meanwhile.
  const [loadingAssets, setLoadingAssets] = useState<AssetDescriptor[]>([]);
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
  useEffect(
    () => (access.readOnly ? undefined : bindAutosave(session, autosave)),
    [access.readOnly, autosave, session],
  );
  // Viewers check and export the revision they loaded, never local edits.
  const loadedRevision = useRef({ document: initial.document, revision: initial.revision });
  const saveExact = useCallback(
    async () =>
      access.readOnly
        ? {
            document: structuredClone(loadedRevision.current.document),
            revision: loadedRevision.current.revision,
          }
        : autosave.saveNow(),
    [access.readOnly, autosave],
  );
  useEffect(() => () => rasterSources.dispose(), [rasterSources]);

  const navigateBack = useCallback(async () => {
    if (access.readOnly) return onBack();
    const saved = await autosave.flushBeforeNavigation();
    if (saved) onBack();
  }, [access.readOnly, autosave, onBack]);
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
        if (!cancelled) setLoadingAssets((current) => [...current, asset]);
        try {
          const download = await client.downloadAsset(assetId);
          await rasterSources.add(assetId, download.bytes, asset.mimeType as SupportedRasterMime);
          if (!cancelled)
            setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
        } finally {
          if (!cancelled)
            setLoadingAssets((current) => current.filter((item) => item.id !== asset.id));
        }
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

  const toast = useToast();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const [zoom, setZoom] = useState<ZoomLevel>("fit");
  const [layout, setLayout] = useEditorLayout();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTextEntryTarget(event.target)) return;
      if (event.key === "?") setShortcutsOpen(true);
      else if (event.key === "[") setLayout({ libraryOpen: !layout.libraryOpen });
      else if (event.key === "]") setLayout({ inspectorOpen: !layout.inspectorOpen });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, setLayout]);

  const selected = state.document.objects
    .filter(isImageView)
    .find((object) => object.id === state.selectedObjectId);
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const fonts = useFigureFonts();
  const metrics = fonts?.metrics ?? FALLBACK_TEXT_METRICS;
  useDerivedSync(session, metrics);
  const provenance = selected ? selectImageProvenance(state.document, selected.id) : undefined;

  const trackUpload = (key: string, patch: Partial<Omit<UploadItem, "key">>) =>
    setUploads((current) => updateUpload(current, key, patch));

  const upload = async (file: File, key: string) => {
    setUploadStatus("Computing SHA-256 and reserving upload…");
    try {
      const asset = await client.prepareAndUpload(project.id, file, file.name, (stage) => {
        setUploadStatus(`Upload ${stage}`);
        trackUpload(key, { stage });
      });
      if (asset.status === "rejected") {
        const reason = asset.rejectionReason ?? "unsupported image";
        setUploadStatus(`Upload rejected: ${reason}. Choose the original again to retry.`);
        trackUpload(key, { state: "error", message: `Rejected: ${reason}` });
        toast.show({ tone: "error", title: `${file.name} was rejected`, description: reason });
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
      trackUpload(key, { stage: "completed", state: "done" });
      setTimeout(() => setUploads((current) => current.filter((item) => item.key !== key)), 1600);
      toast.show({
        tone: "success",
        title: `${file.name} verified`,
        description: "Checksum and format confirmed. Ready to crop.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setUploadStatus(
        error instanceof Error
          ? `Upload failed: ${error.message}. Choose the original again to retry.`
          : "Upload failed. Retry.",
      );
      trackUpload(key, { state: "error", message });
      toast.show({ tone: "error", title: `Could not upload ${file.name}`, description: message });
    }
  };

  const enqueueUploads = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((current) => [
        ...current,
        { key, name: file.name, stage: "hashing", state: "active" },
      ]);
      uploadQueue.current = uploadQueue.current.then(() => upload(file, key));
    }
  };

  const recoverLatest = async () => {
    const result = await reload();
    if (!result.data) return;
    session.getState().replaceDocument(result.data.document);
    setRevision(result.data.revision);
    loadedRevision.current = { document: result.data.document, revision: result.data.revision };
    autosave.resetAfterReload();
  };

  const revealExport = () => {
    if (!layout.inspectorOpen) setLayout({ inspectorOpen: true });
    requestAnimationFrame(() => {
      const section = document.getElementById("figure-export")?.closest("section");
      section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      section?.querySelector<HTMLElement>("select, input")?.focus();
    });
  };

  return (
    <main className="editor-shell">
      <EditorToolbar
        account={account ? <AccountArea account={account} client={client} compact /> : undefined}
        canRedo={state.future.length > 0}
        canUndo={state.history.length > 0}
        inspectorOpen={layout.inspectorOpen}
        libraryOpen={layout.libraryOpen}
        onBack={() => void navigateBack()}
        onExport={revealExport}
        onRedo={() => session.getState().redo()}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onToggleInspector={() => setLayout({ inspectorOpen: !layout.inspectorOpen })}
        onToggleLibrary={() => setLayout({ libraryOpen: !layout.libraryOpen })}
        onUndo={() => session.getState().undo()}
        projectName={project.name}
        readOnly={access.readOnly}
        saveStatus={saveStatus}
      />
      {access.readOnly && (
        <p className="read-only-banner" role="note">
          <InfoIcon size={18} />
          View only: you can comment, check integrity, and export; edits here are not saved.
        </p>
      )}
      <SaveProblemBanner
        onDownloadJson={() => downloadBlob(autosave.downloadMyJson(), `${project.name}-local.json`)}
        onReload={() => void recoverLatest()}
        saveStatus={saveStatus}
      />
      <div
        className="editor-layout"
        data-inspector={layout.inspectorOpen ? "open" : "closed"}
        data-library={layout.libraryOpen ? "open" : "closed"}
      >
        {layout.libraryOpen && (
          <SourceLibrary
            assets={assets}
            client={client}
            loadingAssets={loadingAssets}
            onCollapse={() => setLayout({ libraryOpen: false })}
            onDismissUpload={(key) =>
              setUploads((current) => current.filter((item) => item.key !== key))
            }
            onRejectedFiles={(files) =>
              toast.show({
                tone: "error",
                title: `Skipped ${files.map((file) => file.name).join(", ")}`,
                description: "FigLab accepts PNG, JPEG and TIFF originals.",
              })
            }
            onSelect={setSelectedAssetId}
            previewUrl={(assetId) => rasterSources.getPreviewUrl(assetId)}
            selectedAssetId={selectedAssetId}
            uploadStatus={uploadStatus}
            uploads={uploads}
            {...(access.readOnly ? {} : { onUpload: enqueueUploads })}
          >
            <ArrangePanel metrics={metrics} session={session} />
          </SourceLibrary>
        )}
        <section aria-label="Figure editor" className="workspace">
          <SourceInspector
            asset={selectedAsset}
            collapsed={layout.originalCollapsed}
            onCollapsedChange={(originalCollapsed) => setLayout({ originalCollapsed })}
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
            <FigureCanvas
              metrics={metrics}
              onZoomChange={setZoom}
              rasterSources={rasterSources}
              session={session}
              zoom={zoom}
            />
          </div>
        </section>
        {layout.inspectorOpen && (
          <aside aria-label="Inspector" className="inspector">
            <div className="pane-header">
              {selected ? (
                <>
                  <h2>
                    Panel{" "}
                    <Badge mono title={selected.id} tone="primary">
                      {selected.id.slice(0, 13)}
                    </Badge>
                  </h2>
                  <IconButton
                    icon={<TrashIcon size={16} />}
                    label="Delete selected panel"
                    onClick={() => session.getState().deleteSelectedObject()}
                    shortcut="Delete"
                    size="sm"
                    tooltipAlign="end"
                    variant="danger"
                  />
                </>
              ) : (
                <h2>Inspector</h2>
              )}
            </div>
            {selected && (
              <DisplaySection
                object={selected}
                onChange={(display) => session.getState().setDisplay(selected.id, display)}
              />
            )}
            <ObjectInspector metrics={metrics} session={session} />
            <PanelInspector assets={assets} rasterSources={rasterSources} session={session} />
            {provenance && (
              <ProvenanceSection
                asset={assets.find((asset) => asset.id === provenance.assetId)}
                onShowInOriginal={(assetId) => {
                  setSelectedAssetId(assetId);
                  if (layout.originalCollapsed) setLayout({ originalCollapsed: false });
                }}
                provenance={provenance}
              />
            )}
            {state.selectedIds.length === 0 && (
              <EmptyState headingLevel={3} mood="sleepy" plain title="Nothing selected">
                Drag across the original to crop a panel, or click something on the figure to adjust
                it.
              </EmptyState>
            )}
            <QuantifyPanel
              download={downloadBlob}
              rasterSources={rasterSources}
              session={session}
            />
            <ExportPanel
              activeArtboardId={state.activeArtboardId}
              document={state.document}
              onExport={async (choice) => {
                setExportStatus("Saving the exact revision for export…");
                try {
                  const saved = await saveExact();
                  if (!saved) {
                    setExportStatus(
                      "Save the project before exporting. Recover your local work first.",
                    );
                    toast.show({
                      tone: "error",
                      title: "Export paused",
                      description:
                        "Resolve the save problem first, so the file matches a saved revision.",
                    });
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
                  toast.show({
                    tone: "success",
                    title: `${choice.format.toUpperCase()} exported`,
                    description: `Revision ${saved.revision}, rendered from the original pixels.`,
                  });
                } catch (error) {
                  setExportStatus(error instanceof Error ? error.message : "Export failed.");
                  toast.show({
                    tone: "error",
                    title: "Export failed",
                    description: error instanceof Error ? error.message : "Try again in a moment.",
                  });
                }
              }}
              status={exportStatus}
            />
            <IntegrityPanel
              assets={assets}
              client={client}
              download={downloadBlob}
              fonts={fonts}
              projectId={project.id}
              projectName={project.name}
              rasterSources={rasterSources}
              saveExact={saveExact}
              session={session}
            />
            <CommentsPanel
              canModerate={access.canModerate}
              canResolve={!access.readOnly}
              client={client}
              currentUserId={access.currentUserId}
              projectId={project.id}
              session={session}
            />
            {!access.readOnly && (
              <TemplatePanel client={client} project={project} saveExact={saveExact} />
            )}
            <HistoryPanel
              client={client}
              onRestore={(document) =>
                session.getState().apply(() => document, { selectedIds: [] })
              }
              projectId={project.id}
              refreshKey={exportCount}
              revision={revision}
            />
          </aside>
        )}
      </div>
      <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
    </main>
  );
}
