import { createDefaultFigureDocument, type ImageViewObjectV1 } from "@figlab/figure-schema";
import { Button, Panel } from "@figlab/ui";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useStore } from "zustand";

import { FigLabClient } from "./api/client";
import { downloadBlob, exportPng } from "./api/export";
import { cropFromPointer } from "./editor/crop";
import { createEditorSession, type Point } from "./editor/session-store";
import { PixiArtboard } from "./pixi-artboard";
import "./styles.css";

const client = new FigLabClient();
const DEFAULT_PROJECT = { id: "local-project", name: "Untitled Figure" };

export function FigLabApp() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [screen, setScreen] = useState<"dashboard" | "editor">("dashboard");
  return (
    <QueryClientProvider client={queryClient}>
      {screen === "dashboard" ? (
        <Dashboard onOpen={() => setScreen("editor")} />
      ) : (
        <FigLabEditor onBack={() => setScreen("dashboard")} />
      )}
    </QueryClientProvider>
  );
}

function Dashboard({ onOpen }: { onOpen: () => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.listProjects() });
  const create = useMutation({
    mutationFn: (name: string) => client.createProject(name),
    onSuccess: onOpen,
  });
  const [name, setName] = useState("");
  return (
    <main className="app-shell">
      <header className="app-header">
        <strong>FigLab</strong>
        <span>Scientific figure workspace</span>
      </header>
      <div className="dashboard-layout">
        <nav aria-label="Project navigation" className="side-nav">
          <strong>Projects</strong>
          <Button onClick={onOpen}>Open local workspace</Button>
          <label className="upload-control">
            Upload original
            <input type="file" accept="image/png,image/jpeg,image/tiff" onChange={onOpen} />
          </label>
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
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New project name"
              />
              <Button disabled={create.isPending}>Create project</Button>
            </form>
          </div>
          {projects.isLoading && <p role="status">Loading projects…</p>}
          {projects.isError && (
            <p role="alert">Could not load projects. You can still open a local workspace.</p>
          )}
          {projects.data?.length === 0 && (
            <p className="empty-state">No projects yet. Create one to begin a figure.</p>
          )}
          <div className="project-grid">
            {projects.data?.map((project) => (
              <Panel key={project.id}>
                <h2>{project.name}</h2>
                <p>Updated {new Date(project.updatedAt).toLocaleDateString()}</p>
                <Button onClick={onOpen}>Open</Button>
              </Panel>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

export function FigLabEditor({ onBack }: { onBack: () => void }) {
  const [session] = useState(() => createEditorSession(createDefaultFigureDocument("artboard-1")));
  const state = useStore(session);
  const [uploadStatus, setUploadStatus] = useState(
    "Choose a PNG, JPEG, or TIFF original to upload.",
  );
  const [exportStatus, setExportStatus] = useState("");
  const selected = state.document.objects.find((object) => object.id === state.selectedObjectId);
  const pointer = (event: React.PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  const sourceCrop =
    state.cropDraft &&
    cropFromPointer(state.cropDraft.start, state.cropDraft.end, { width: 1, height: 1 });
  const siblings = selected
    ? state.document.objects.filter(
        (object) => object.view.sourceAssetId === selected.view.sourceAssetId,
      )
    : [];
  return (
    <main className="editor-shell">
      <header className="app-header editor-header">
        <Button onClick={onBack}>Projects</Button>
        <strong>{DEFAULT_PROJECT.name}</strong>
        <span role="status">Saved locally</span>
        <Button onClick={() => session.getState().undo()} disabled={!state.history.length}>
          Undo
        </Button>
        <Button onClick={() => session.getState().redo()} disabled={!state.future.length}>
          Redo
        </Button>
        <Button onClick={() => document.getElementById("png-export")?.scrollIntoView()}>
          Export PNG
        </Button>
      </header>
      <div className="editor-layout">
        <aside className="source-library" aria-label="Source library">
          <h2>Source library</h2>
          <label className="upload-control">
            Upload original
            <input
              type="file"
              accept="image/png,image/jpeg,image/tiff"
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                setUploadStatus("Computing SHA-256 and reserving upload…");
                try {
                  await client.prepareAndUpload(DEFAULT_PROJECT.id, file, file.name, (stage) =>
                    setUploadStatus(`Upload ${stage}`),
                  );
                } catch {
                  setUploadStatus("Upload failed. Retry with the original file.");
                }
              }}
            />
          </label>
          <p role="status">{uploadStatus}</p>
          <button type="button" className="source-item">
            Original · local preview
          </button>
        </aside>
        <section className="workspace" aria-label="Figure editor">
          <div className="original-inspector">
            <div>
              <p className="eyebrow">Original inspector</p>
              <h2>Drag to crop</h2>
            </div>
            <div
              className="source-canvas"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                session.getState().beginCrop(pointer(event));
              }}
              onPointerMove={(event) => {
                if (state.cropDraft) session.getState().previewCrop(pointer(event));
              }}
              onPointerUp={(event) => {
                session.getState().previewCrop(pointer(event));
                session.getState().commitCrop("local-source", `view-${crypto.randomUUID()}`);
              }}
            >
              <span>Original source raster</span>
              {sourceCrop && (
                <div
                  aria-label="Crop selection"
                  className="crop-overlay"
                  role="img"
                  style={{
                    left: `${sourceCrop.x * 100}%`,
                    top: `${sourceCrop.y * 100}%`,
                    width: `${sourceCrop.width * 100}%`,
                    height: `${sourceCrop.height * 100}%`,
                  }}
                >
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              )}
            </div>
          </div>
          <div className="artboard-wrap">
            <PixiArtboard document={state.document} />
            <div className="selection-layer" aria-hidden="true">
              {state.document.objects.map((object) => (
                <button
                  key={object.id}
                  type="button"
                  className={`artboard-selection ${object.id === selected?.id ? "selected" : ""}`}
                  style={{
                    left: `${object.transform.xPt / 6.12}%`,
                    top: `${object.transform.yPt / 7.92}%`,
                    width: `${object.transform.widthPt / 6.12}%`,
                    height: `${object.transform.heightPt / 7.92}%`,
                  }}
                  onPointerDown={() => session.getState().beginObjectGesture(object.id)}
                  onPointerMove={(event) => {
                    if (event.buttons === 1) {
                      session
                        .getState()
                        .previewObjectTransform(
                          moveObject(object, event.movementX, event.movementY),
                        );
                    }
                  }}
                  onPointerUp={() => session.getState().commitObjectTransform()}
                />
              ))}
            </div>
          </div>
        </section>
        <aside className="display-inspector" aria-label="Display inspector">
          <h2>Display inspector</h2>
          {selected ? (
            <TransformControls
              object={selected}
              onChange={(display) => session.getState().setDisplay(selected.id, display)}
            />
          ) : (
            <p className="empty-state">Select or crop an image to adjust its display transform.</p>
          )}
          <ExportControls
            onExport={async (widthPx, heightPx) => {
              setExportStatus("Preparing original-source PNG…");
              try {
                await exportPng({
                  document: state.document,
                  revision: 0,
                  widthPx,
                  heightPx,
                  sourceExporter: unavailableOriginalSourceExporter,
                  record: (metadata) => client.recordExport(DEFAULT_PROJECT.id, metadata),
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
          {selected ? (
            <>
              <Button onClick={() => session.getState().beginObjectGesture(selected.id)}>
                Show in Original
              </Button>
              <p>
                {siblings.length} panel{siblings.length === 1 ? "" : "s"} uses this source.
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

function ExportControls({
  onExport,
  status,
}: {
  onExport: (widthPx: number, heightPx: number) => Promise<void>;
  status: string;
}) {
  const [scale, setScale] = useState<"1" | "2" | "custom">("1");
  const [customWidth, setCustomWidth] = useState("1200");
  const widthPx = scale === "custom" ? Number(customWidth) : 600 * Number(scale);
  const heightPx = Math.round(widthPx * (792 / 612));
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
        Custom width
        <input
          aria-label="Custom width"
          disabled={scale !== "custom"}
          min="1"
          onChange={(event) => setCustomWidth(event.target.value)}
          type="number"
          value={customWidth}
        />
      </label>
      <Button onClick={() => setScale("custom")}>Use custom width</Button>
      <Button
        disabled={!Number.isFinite(widthPx) || widthPx < 1}
        onClick={() => void onExport(widthPx, heightPx)}
      >
        Export PNG
      </Button>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

async function unavailableOriginalSourceExporter(): Promise<Blob> {
  throw new Error("Original-source PNG export is waiting for the frozen image-processing adapter.");
}

function moveObject(object: ImageViewObjectV1, movementX: number, movementY: number) {
  return {
    xPt: object.transform.xPt + movementX,
    yPt: object.transform.yPt + movementY,
    widthPt: object.transform.widthPt,
    heightPt: object.transform.heightPt,
  };
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
        type="range"
        min={min}
        max={max}
        step={step}
        value={display[key]}
        onChange={(event) => onChange({ ...display, [key]: Number(event.target.value) })}
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
          type="checkbox"
          checked={display.invert}
          onChange={(event) => onChange({ ...display, invert: event.target.checked })}
        />
        Invert
      </label>
    </div>
  );
}
