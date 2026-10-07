import type { AssetDescriptor } from "@figlab/api-contract";
import { upsertSourceCommand } from "@figlab/editor-core";
import {
  cropCornersPx,
  isImagePanel,
  type NormalizedRect,
  panelAssetIds,
} from "@figlab/figure-schema";
import { panelCrop } from "@figlab/image-processing";
import { Button } from "@figlab/ui";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { imageContainRect, normalizedPointInImage, type ScreenRect } from "../editor/geometry";
import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState, Point } from "../editor/session-store";

/** Common pre-stained ladders, largest band first (kDa, from the manufacturers' charts). */
export const LADDERS: { id: string; label: string; kDa: number[] }[] = [
  { id: "seeblue-plus2", label: "SeeBlue Plus2", kDa: [198, 98, 62, 49, 38, 28, 17, 14, 6, 3] },
  {
    id: "pageruler-prestained",
    label: "PageRuler Prestained",
    kDa: [180, 130, 100, 70, 55, 40, 35, 25, 15, 10],
  },
  {
    id: "precision-plus-dual",
    label: "Precision Plus Dual Color",
    kDa: [250, 150, 100, 75, 50, 37, 25, 20, 15, 10],
  },
];

type CropMode = "rect" | "line" | "markers";

/** One entry per page of a multi-page original, labelled from its metadata. */
export function planeOptions(count: number, labels: ReadonlyArray<string>) {
  const options: { plane: number; label: string }[] = [];
  for (let plane = 0; plane < count; plane += 1)
    options.push({ plane, label: labels[plane] ?? `Page ${plane + 1}` });
  return options;
}

/** Turns a dragged line (normalized image points) into a crop rotated to follow it. */
export function lineCrop(
  start: Point,
  end: Point,
  bandHeightPx: number,
  size: { widthPx: number; heightPx: number },
): { viewport: NormalizedRect; rotationDeg: number } | undefined {
  const x0 = start.x * size.widthPx;
  const y0 = start.y * size.heightPx;
  const x1 = end.x * size.widthPx;
  const y1 = end.y * size.heightPx;
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length < 2 || bandHeightPx < 1) return undefined;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const round = (value: number) => Number(value.toFixed(6));
  return {
    viewport: {
      x: round((cx - length / 2) / size.widthPx),
      y: round((cy - bandHeightPx / 2) / size.heightPx),
      width: round(length / size.widthPx),
      height: round(bandHeightPx / size.heightPx),
    },
    rotationDeg: Number(((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI).toFixed(3)),
  };
}

/** True when every corner of a (rotated) crop lies inside the original. */
export function cropFits(
  crop: { viewport: NormalizedRect; rotationDeg: number },
  size: { widthPx: number; heightPx: number },
): boolean {
  if (crop.viewport.width <= 0 || crop.viewport.height <= 0) return false;
  return cropCornersPx(crop, size).every(
    ([x, y]) => x >= -1e-6 && y >= -1e-6 && x <= size.widthPx + 1e-6 && y <= size.heightPx + 1e-6,
  );
}

type AssetCalibration = { umPerPxX: number; umPerPxY: number; source: string };

export function SourceInspector({
  asset,
  rasterSources,
  session,
  onCrop,
}: {
  asset: AssetDescriptor | undefined;
  rasterSources: BrowserRasterRepository;
  session: StoreApi<EditorSessionState>;
  /** Rectangle crops go through the caller (which owns the crop draft). */
  onCrop: (viewport: NormalizedRect, plane: number) => void;
}) {
  const state = useStore(session);
  const host = useRef<HTMLDivElement>(null);
  const [imageRect, setImageRect] = useState<ScreenRect>();
  const [mode, setMode] = useState<CropMode>("rect");
  const [plane, setPlane] = useState(0);
  const [bandHeight, setBandHeight] = useState(40);
  const [ladder, setLadder] = useState(LADDERS[0]?.id ?? "");
  const [draft, setDraft] = useState<{ start: Point; end: Point }>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [status, setStatus] = useState("");
  const [manualScale, setManualScale] = useState("");
  const planes = Number(asset?.metadata.planes ?? 1);
  const planeLabels = (asset?.metadata.planeLabels as string[] | undefined) ?? [];
  const fileCalibration = asset?.metadata.calibration as AssetCalibration | undefined;
  const size = asset ? { widthPx: asset.widthPx, heightPx: asset.heightPx } : undefined;
  const source = state.document.sources.find((entry) => entry.assetId === asset?.id);

  // Reset per-original state when another original is selected (during render, not in an effect).
  const [shownAssetId, setShownAssetId] = useState(asset?.id);
  if (shownAssetId !== asset?.id) {
    setShownAssetId(asset?.id);
    setPlane(0);
    setDraft(undefined);
    setStatus("");
  }
  useEffect(() => {
    let active = true;
    if (!asset) {
      setPreviewUrl(undefined);
      return;
    }
    void rasterSources.getPlanePreviewUrl(asset.id, plane).then((url) => {
      if (active) setPreviewUrl(url);
    });
    return () => {
      active = false;
    };
  }, [asset, plane, rasterSources]);
  const sourceWidth = asset?.widthPx;
  const sourceHeight = asset?.heightPx;
  useEffect(() => {
    const target = host.current;
    if (!target || !sourceWidth || !sourceHeight) return;
    const update = () =>
      setImageRect(
        imageContainRect(
          { width: target.clientWidth, height: target.clientHeight },
          { width: sourceWidth, height: sourceHeight },
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [sourceWidth, sourceHeight]);

  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!imageRect) return { x: 0, y: 0 };
    return normalizedPointInImage(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      imageRect,
    );
  };
  const recordSource = (patch: Parameters<typeof upsertSourceCommand>[0]) =>
    session.getState().apply(upsertSourceCommand(patch));

  const finish = (end: Point) => {
    const start = draft?.start;
    setDraft(undefined);
    if (!start || !asset || !size) return;
    if (mode === "rect") {
      const viewport = {
        x: Number(Math.min(start.x, end.x).toFixed(6)),
        y: Number(Math.min(start.y, end.y).toFixed(6)),
        width: Number(Math.abs(end.x - start.x).toFixed(6)),
        height: Number(Math.abs(end.y - start.y).toFixed(6)),
      };
      if (viewport.width > 0 && viewport.height > 0) onCrop(viewport, plane);
      return;
    }
    if (mode === "line") {
      const crop = lineCrop(start, end, bandHeight, size);
      if (!crop) return;
      if (!cropFits(crop, size)) {
        setStatus(
          "That band crop would extend outside the original. Draw a shorter line or lower the band height.",
        );
        return;
      }
      setStatus(`Band crop rotated ${crop.rotationDeg.toFixed(1)}°.`);
      session.getState().addPanel({
        assetId: asset.id,
        objectId: `view-${crypto.randomUUID()}`,
        viewport: crop.viewport,
        rotationDeg: crop.rotationDeg,
        plane,
        sourceSize: size,
      });
    }
  };

  const addMarker = (at: Point) => {
    if (!asset || !size) return;
    const markers = source?.markers ?? [];
    const values = LADDERS.find((entry) => entry.id === ladder)?.kDa ?? [];
    const kDa = values[markers.length] ?? Math.max(1, Math.round((markers.at(-1)?.kDa ?? 20) / 2));
    recordSource({
      ...size,
      assetId: asset.id,
      markers: [...markers, { yPx: Number((at.y * size.heightPx).toFixed(2)), kDa }].sort(
        (a, b) => a.yPx - b.yPx,
      ),
    });
  };

  const crops = state.document.objects
    .filter(isImagePanel)
    .filter((object) => asset && panelAssetIds(object).includes(asset.id));
  const toScreen = (x: number, y: number) =>
    imageRect && size
      ? `${imageRect.left + (x / size.widthPx) * imageRect.width},${imageRect.top + (y / size.heightPx) * imageRect.height}`
      : "0,0";
  const draftPolygon = (() => {
    if (!draft || !size || !imageRect) return undefined;
    if (mode === "line") {
      const crop = lineCrop(draft.start, draft.end, bandHeight, size);
      return crop ? cropCornersPx(crop, size) : undefined;
    }
    if (mode !== "rect") return undefined;
    const x = Math.min(draft.start.x, draft.end.x) * size.widthPx;
    const y = Math.min(draft.start.y, draft.end.y) * size.heightPx;
    const w = Math.abs(draft.end.x - draft.start.x) * size.widthPx;
    const h = Math.abs(draft.end.y - draft.start.y) * size.heightPx;
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ] as [number, number][];
  })();

  return (
    <div className="original-inspector">
      <div>
        <p className="eyebrow">Original inspector</p>
        <h2>{mode === "markers" ? "Click ladder bands" : "Drag to crop"}</h2>
      </div>
      <div className="figure-tools-panel source-tools">
        <fieldset>
          <legend>Crop</legend>
          {(
            [
              ["rect", "Rectangle crop"],
              ["line", "Band (line) crop"],
              ["markers", "Mark ladder"],
            ] as const
          ).map(([value, label]) => (
            <Button aria-pressed={mode === value} key={value} onClick={() => setMode(value)}>
              {label}
            </Button>
          ))}
          {mode === "line" && (
            <label className="inline">
              Band height (px)
              <input
                min="1"
                onChange={(event) => setBandHeight(Math.max(1, Number(event.target.value) || 1))}
                type="number"
                value={bandHeight}
              />
            </label>
          )}
          {planes > 1 && (
            <label className="inline">
              Page
              <select onChange={(event) => setPlane(Number(event.target.value))} value={plane}>
                {planeOptions(planes, planeLabels).map((option) => (
                  <option key={option.plane} value={option.plane}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {mode === "markers" && asset && size && (
          <fieldset>
            <legend>Molecular-weight ladder</legend>
            <label className="inline">
              Ladder
              <select onChange={(event) => setLadder(event.target.value)} value={ladder}>
                {LADDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <ol className="history-list" aria-label="Ladder markers">
              {(source?.markers ?? []).map((marker, index) => (
                <li key={`${marker.yPx}-${marker.kDa}`}>
                  <label className="inline">
                    {`Band at ${Math.round(marker.yPx)} px (kDa)`}
                    <input
                      defaultValue={marker.kDa}
                      min="0.1"
                      onBlur={(event) => {
                        const kDa = Number(event.currentTarget.value);
                        if (!(kDa > 0) || kDa === marker.kDa) return;
                        const markers = [...(source?.markers ?? [])];
                        markers[index] = { ...marker, kDa };
                        recordSource({ ...size, assetId: asset.id, markers });
                      }}
                      step="0.1"
                      type="number"
                    />
                  </label>
                  <Button
                    onClick={() =>
                      recordSource({
                        ...size,
                        assetId: asset.id,
                        markers: (source?.markers ?? []).filter((_, other) => other !== index),
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ol>
          </fieldset>
        )}
        {asset && size && (
          <fieldset>
            <legend>Pixel size</legend>
            <p>
              {source?.calibration
                ? `${source.calibration.umPerPxX} µm/px (${source.calibration.origin === "metadata" ? "from the file" : "entered manually"})`
                : "Not calibrated: scale bars are unavailable."}
            </p>
            {fileCalibration && source?.calibration?.origin !== "metadata" && (
              <Button
                onClick={() =>
                  recordSource({
                    ...size,
                    assetId: asset.id,
                    calibration: {
                      umPerPxX: fileCalibration.umPerPxX,
                      umPerPxY: fileCalibration.umPerPxY,
                      origin: "metadata",
                    },
                  })
                }
              >
                Use file calibration ({fileCalibration.umPerPxX.toPrecision(4)} µm/px)
              </Button>
            )}
            <label className="inline">
              Pixel size (µm/px)
              <input
                min="0"
                onChange={(event) => setManualScale(event.target.value)}
                step="any"
                type="number"
                value={manualScale}
              />
            </label>
            <Button
              disabled={!(Number(manualScale) > 0)}
              onClick={() => {
                const value = Number(manualScale);
                recordSource({
                  ...size,
                  assetId: asset.id,
                  calibration: { umPerPxX: value, umPerPxY: value, origin: "manual" },
                });
                setManualScale("");
              }}
            >
              Set pixel size
            </Button>
          </fieldset>
        )}
        {status && <p role="status">{status}</p>}
      </div>
      <div
        className="source-canvas"
        data-testid="source-canvas"
        onPointerDown={(event) => {
          if (!asset) return;
          const at = point(event);
          if (mode === "markers") {
            addMarker(at);
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft({ start: at, end: at });
        }}
        onPointerMove={(event) => {
          if (draft) setDraft({ ...draft, end: point(event) });
        }}
        onPointerUp={(event) => {
          if (draft) finish(point(event));
        }}
        ref={host}
      >
        {previewUrl && asset ? (
          <img alt={`Original ${asset.filename}`} src={previewUrl} />
        ) : (
          <span>Upload and select an original source raster</span>
        )}
        {imageRect && size && (
          <svg aria-hidden="true" className="source-overlay">
            {crops.map((object) => (
              <polygon
                className={
                  state.selectedIds.includes(object.id) ? "crop-outline selected" : "crop-outline"
                }
                key={object.id}
                points={cropCornersPx(panelCrop(object), size)
                  .map(([x, y]) => toScreen(x, y))
                  .join(" ")}
              />
            ))}
            {draftPolygon && (
              <polygon
                className="crop-outline draft"
                points={draftPolygon.map(([x, y]) => toScreen(x, y)).join(" ")}
              />
            )}
            {(source?.markers ?? []).map((marker) => (
              <g key={`${marker.yPx}-${marker.kDa}`}>
                <line
                  className="ladder-marker"
                  x1={imageRect.left}
                  x2={imageRect.left + imageRect.width}
                  y1={imageRect.top + (marker.yPx / size.heightPx) * imageRect.height}
                  y2={imageRect.top + (marker.yPx / size.heightPx) * imageRect.height}
                />
                <text
                  className="ladder-label"
                  x={imageRect.left + 4}
                  y={imageRect.top + (marker.yPx / size.heightPx) * imageRect.height - 3}
                >
                  {marker.kDa} kDa
                </text>
              </g>
            ))}
          </svg>
        )}
        {draft && mode === "rect" && (
          <div aria-label="Crop selection" className="crop-overlay" role="img" />
        )}
      </div>
    </div>
  );
}
