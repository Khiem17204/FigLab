import type { AssetDescriptor, Project, ProjectDocumentResponse } from "@figlab/api-contract";
import { selectImageProvenance } from "@figlab/editor-core";
import { Button } from "@figlab/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "../api/client";
import { createArtboardPngExporter, downloadBlob, exportPng } from "../api/export";
import { AutosaveController, type SaveStatus } from "../editor/autosave";
import { bindAutosave } from "../editor/autosave-binding";
import { BrowserRasterRepository, type SupportedRasterMime } from "../editor/raster-sources";
import { createEditorSession } from "../editor/session-store";
import { ArtboardEditor } from "./artboard-editor";
import { isTextEntryTarget } from "./dom-helpers";
import { EditorToolbar, SaveProblemBanner } from "./editor-toolbar";
import { TransformControls } from "./inspector/display-section";
import { ExportControls } from "./inspector/export-panel";
import { ProvenanceSection } from "./inspector/provenance-section";
import { OriginalInspector } from "./original-inspector";
import { SourceLibrary } from "./source-library";

const defaultClient = new FigLabClient();

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

  const exportArtboard = async (widthPx: number, heightPx: number) => {
    setExportStatus("Saving the exact revision for export…");
    try {
      const saved = await autosave.saveNow();
      if (!saved) {
        setExportStatus("Save the project before exporting. Recover your local work first.");
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
  };

  return (
    <main className="editor-shell">
      <EditorToolbar
        canRedo={state.future.length > 0}
        canUndo={state.history.length > 0}
        onBack={() => void navigateBack()}
        onRedo={() => session.getState().redo()}
        onUndo={() => session.getState().undo()}
        projectName={project.name}
        saveStatus={saveStatus}
      />
      <SaveProblemBanner
        onDownloadJson={() => downloadBlob(autosave.downloadMyJson(), `${project.name}-local.json`)}
        onReload={() => void recoverLatest()}
        saveStatus={saveStatus}
      />
      <div className="editor-layout">
        <SourceLibrary
          assets={assets}
          onSelect={setSelectedAssetId}
          onUpload={(file) => void upload(file)}
          uploadStatus={uploadStatus}
        />
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
            onExport={exportArtboard}
            status={exportStatus}
          />
          <ProvenanceSection onShowInOriginal={setSelectedAssetId} provenance={provenance} />
        </aside>
      </div>
    </main>
  );
}
