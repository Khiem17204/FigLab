import type { AssetDescriptor, Project, ProjectDocumentResponse } from "@figlab/api-contract";
import { selectImageProvenance } from "@figlab/editor-core";
import { Badge, EmptyState, IconButton, TrashIcon, useToast } from "@figlab/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "../api/client";
import { createArtboardPngExporter, downloadBlob, exportPng } from "../api/export";
import type { SignedInAccount } from "../auth/auth-gate";
import { AutosaveController, type SaveStatus } from "../editor/autosave";
import { bindAutosave } from "../editor/autosave-binding";
import { BrowserRasterRepository, type SupportedRasterMime } from "../editor/raster-sources";
import { createEditorSession } from "../editor/session-store";
import { AccountArea } from "../shell/account-menu";
import { ArtboardEditor } from "./artboard-editor";
import { isTextEntryTarget } from "./dom-helpers";
import { EditorToolbar, SaveProblemBanner } from "./editor-toolbar";
import { DisplaySection } from "./inspector/display-section";
import { type ExportScale, ExportSection, exportDimensions } from "./inspector/export-panel";
import { ProvenanceSection } from "./inspector/provenance-section";
import { useEditorLayout } from "./layout-preferences";
import { OriginalInspector } from "./original-inspector";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { SourceLibrary } from "./source-library";
import { type UploadItem, updateUpload } from "./uploads";
import type { ZoomLevel } from "./zoom";

const defaultClient = new FigLabClient();

export function FigLabEditor({
  client = defaultClient,
  account,
  initial,
  onBack,
  project,
  reload,
}: {
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

  const toast = useToast();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const [zoom, setZoom] = useState<ZoomLevel>("fit");
  const [layout, setLayout] = useEditorLayout();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportScale, setExportScale] = useState<ExportScale>("1");
  const [customWidth, setCustomWidth] = useState("1200");
  const [exporting, setExporting] = useState(false);
  const [exportTone, setExportTone] = useState<"info" | "success" | "error">("info");
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

  const selected = state.document.objects.find((object) => object.id === state.selectedObjectId);
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const selectedPreviewUrl = selectedAssetId
    ? rasterSources.getPreviewUrl(selectedAssetId)
    : undefined;
  const provenance = selected ? selectImageProvenance(state.document, selected.id) : undefined;
  // Only outline the selected panel's crop when its own original is the one on screen.
  const highlightedViewport =
    provenance && provenance.assetId === selectedAssetId ? provenance.viewport : undefined;
  const artboard = state.document.artboards[0];
  const dimensions = exportDimensions(artboard, exportScale, customWidth);

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
    autosave.resetAfterReload();
  };

  const exportArtboard = async (widthPx: number, heightPx: number) => {
    setExportStatus("Saving the exact revision for export…");
    setExportTone("info");
    setExporting(true);
    try {
      const saved = await autosave.saveNow();
      if (!saved) {
        setExportStatus("Save the project before exporting. Recover your local work first.");
        setExportTone("error");
        toast.show({
          tone: "error",
          title: "Export paused",
          description: "Resolve the save problem first, so the PNG matches a saved revision.",
        });
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
      setExportTone("success");
      toast.show({
        tone: "success",
        title: "PNG exported",
        description: `${widthPx} × ${heightPx} px from revision ${saved.revision}, rendered from the originals.`,
      });
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : "PNG export failed.");
      setExportTone("error");
      toast.show({
        tone: "error",
        title: "Export failed",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="editor-shell">
      <EditorToolbar
        account={account ? <AccountArea account={account} client={client} compact /> : undefined}
        canExport={dimensions.valid}
        canRedo={state.future.length > 0}
        canUndo={state.history.length > 0}
        exporting={exporting}
        inspectorOpen={layout.inspectorOpen}
        libraryOpen={layout.libraryOpen}
        onBack={() => void navigateBack()}
        onExport={() => void exportArtboard(dimensions.width, dimensions.height)}
        onRedo={() => session.getState().redo()}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onToggleInspector={() => setLayout({ inspectorOpen: !layout.inspectorOpen })}
        onToggleLibrary={() => setLayout({ libraryOpen: !layout.libraryOpen })}
        onUndo={() => session.getState().undo()}
        projectName={project.name}
        saveStatus={saveStatus}
      />
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
            onUpload={enqueueUploads}
            previewUrl={(assetId) => rasterSources.getPreviewUrl(assetId)}
            selectedAssetId={selectedAssetId}
            uploadStatus={uploadStatus}
            uploads={uploads}
          />
        )}
        <section aria-label="Figure editor" className="workspace">
          <OriginalInspector
            {...(selectedAsset ? { asset: selectedAsset } : {})}
            collapsed={layout.originalCollapsed}
            {...(highlightedViewport ? { highlightedViewport } : {})}
            onCollapsedChange={(originalCollapsed) => setLayout({ originalCollapsed })}
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
            onZoomChange={setZoom}
            rasterSources={rasterSources}
            {...(state.selectedObjectId ? { selectedId: state.selectedObjectId } : {})}
            zoom={zoom}
          />
        </section>
        {layout.inspectorOpen && (
          <aside aria-label="Inspector" className="inspector">
            {selected ? (
              <div className="pane-header">
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
              </div>
            ) : (
              <div className="pane-header">
                <h2>Inspector</h2>
              </div>
            )}
            {selected ? (
              <>
                <DisplaySection
                  object={selected}
                  onChange={(display) => session.getState().setDisplay(selected.id, display)}
                />
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
              </>
            ) : (
              <EmptyState headingLevel={3} mood="sleepy" plain title="No panel selected">
                Drag across the original to crop a panel, or click a panel on the artboard to adjust
                it.
              </EmptyState>
            )}
            <ExportSection
              customWidth={customWidth}
              height={dimensions.height}
              onCustomWidthChange={setCustomWidth}
              onScaleChange={setExportScale}
              scale={exportScale}
              status={exportStatus}
              statusTone={exportTone}
              valid={dimensions.valid}
              width={dimensions.width}
            />
          </aside>
        )}
      </div>
      <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
    </main>
  );
}
