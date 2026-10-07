import type { AssetDescriptor } from "@figlab/api-contract";
import {
  addLaneTableCommand,
  addMwLabelsCommand,
  addScaleBarCommand,
  addZoomInsetCommand,
  formatLaneRow,
  mergeViewsCommand,
  parseLaneRow,
  setViewCommand,
  splitChannelsCommand,
  suggestedLut,
  updateObjectCommand,
  upsertSourceCommand,
} from "@figlab/editor-core";
import {
  cropCornersPx,
  type DisplayTransformV3,
  type FigureObject,
  type ImageViewObjectV3,
  type LutV3,
  type StrokeV2,
} from "@figlab/figure-schema";
import { cropSourceRect, sampleHistogram } from "@figlab/image-processing";
import { Button } from "@figlab/ui";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState } from "../editor/session-store";
import { planeOptions } from "./source-inspector";

const LUTS: LutV3[] = ["none", "gray", "red", "green", "blue", "cyan", "magenta", "yellow"];
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

function Histogram({
  counts,
  levels,
}: {
  counts: number[];
  levels: { black: number; white: number };
}) {
  const peak = Math.max(1, ...counts);
  const width = counts.length;
  return (
    <svg
      aria-label="Histogram of original samples"
      className="histogram"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${width} 100`}
    >
      <path
        d={counts
          .map((count, index) => {
            const height = (Math.log1p(count) / Math.log1p(peak)) * 100;
            return `M${index} 100V${100 - height}h0.9V100Z`;
          })
          .join("")}
      />
      <line x1={levels.black * width} x2={levels.black * width} y1={0} y2={100} />
      <line x1={levels.white * width} x2={levels.white * width} y1={0} y2={100} />
    </svg>
  );
}

/** Levels, LUT, and a histogram for one display transform. */
function DisplayFields({
  display,
  onChange,
  counts,
  label,
}: {
  display: DisplayTransformV3;
  onChange: (display: DisplayTransformV3) => void;
  counts?: number[] | undefined;
  label?: string;
}) {
  const prefix = label ? `${label} ` : "";
  return (
    <>
      {counts && <Histogram counts={counts} levels={display.levels} />}
      {(["black", "white"] as const).map((key) => (
        <label key={key}>
          {`${prefix}${key === "black" ? "Black level" : "White level"}`}
          <input
            aria-label={`${prefix}${key === "black" ? "Black level" : "White level"}`}
            max="1"
            min="0"
            onChange={(event) => {
              const value = Number(event.target.value);
              const levels = { ...display.levels, [key]: value };
              if (levels.black < levels.white) onChange({ ...display, levels });
            }}
            step="0.005"
            type="range"
            value={display.levels[key]}
          />
          <output>{display.levels[key].toFixed(3)}</output>
        </label>
      ))}
      <label>
        {`${prefix}Lookup table`}
        <select
          aria-label={`${prefix}Lookup table`}
          onChange={(event) => onChange({ ...display, lut: event.target.value as LutV3 })}
          value={display.lut}
        >
          {LUTS.map((lut) => (
            <option key={lut} value={lut}>
              {lut === "none" ? "Original colors" : lut}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function StrokeFields({
  stroke,
  onChange,
}: {
  stroke: StrokeV2;
  onChange: (stroke: StrokeV2) => void;
}) {
  return (
    <>
      <label>
        Outline color
        <input
          onChange={(event) => onChange({ ...stroke, colorHex: event.target.value.toUpperCase() })}
          type="color"
          value={stroke.colorHex.toLowerCase()}
        />
      </label>
      <label>
        Outline width (pt)
        <input
          min="0.1"
          max="20"
          onChange={(event) =>
            onChange({ ...stroke, widthPt: Math.max(0.1, Number(event.target.value) || 1) })
          }
          step="0.25"
          type="number"
          value={stroke.widthPt}
        />
      </label>
    </>
  );
}

/**
 * Inspector for image panels (reading, orientation, levels, LUT, and blot/microscopy actions)
 * and for the annotations attached to them.
 */
export function PanelInspector({
  session,
  assets,
  rasterSources,
}: {
  session: StoreApi<EditorSessionState>;
  assets: ReadonlyArray<AssetDescriptor>;
  rasterSources: BrowserRasterRepository;
}) {
  const state = useStore(session);
  const [status, setStatus] = useState("");
  const [counts, setCounts] = useState<number[]>();
  const [laneCount, setLaneCount] = useState(6);
  const selected = state.document.objects.filter((object) => state.selectedIds.includes(object.id));
  const object = selected.length === 1 ? selected[0] : undefined;
  const apply = (command: Parameters<EditorSessionState["apply"]>[0], selectedIds?: string[]) => {
    try {
      session.getState().apply(command, selectedIds ? { selectedIds } : {});
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That change is not possible.");
    }
  };
  const view = object?.type === "image-view" ? object : undefined;
  const asset = view
    ? assets.find((candidate) => candidate.id === view.view.sourceAssetId)
    : undefined;
  const source = view
    ? state.document.sources.find((entry) => entry.assetId === view.view.sourceAssetId)
    : undefined;
  const size = asset ? { widthPx: asset.widthPx, heightPx: asset.heightPx } : undefined;

  // Everything that changes which original samples the panel reads, as one dependency.
  const readingKey =
    view && size && rasterSources.has(view.view.sourceAssetId)
      ? JSON.stringify({
          assetId: view.view.sourceAssetId,
          plane: view.view.plane,
          channel: view.view.channel,
          rect: cropSourceRect(view.view, size),
        })
      : undefined;
  useEffect(() => {
    let active = true;
    setCounts(undefined);
    if (!readingKey) return;
    const reading = JSON.parse(readingKey) as {
      assetId: string;
      plane: number;
      channel: number | null;
      rect: { x: number; y: number; width: number; height: number };
    };
    void rasterSources
      .getRegion(reading.assetId, reading.rect, 0, reading.plane)
      .then((region) => {
        if (active) setCounts(sampleHistogram(region, reading.channel));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [readingKey, rasterSources]);

  const selectedViews = selected.filter(
    (candidate): candidate is ImageViewObjectV3 => candidate.type === "image-view",
  );
  if (selectedViews.length >= 2)
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>{selectedViews.length} image panels</h3>
        <Button
          onClick={() => {
            const mergeId = id("merge");
            apply(
              mergeViewsCommand({
                id: mergeId,
                viewIds: selectedViews.map((candidate) => candidate.id),
              }),
              [mergeId],
            );
          }}
        >
          Merge into composite
        </Button>
        {status && <p role="status">{status}</p>}
      </section>
    );
  if (!object) return null;

  const ensureSource = () => {
    if (!view || !size) return state.document;
    return source
      ? state.document
      : upsertSourceCommand({ assetId: view.view.sourceAssetId, ...size })(state.document);
  };
  const withSource = (command: (document: typeof state.document) => typeof state.document) => () =>
    command(ensureSource());

  if (view) {
    const planes = Number(asset?.metadata.planes ?? 1);
    const planeLabels = (asset?.metadata.planeLabels as string[] | undefined) ?? [];
    const channels = asset?.channelCount ?? 1;
    const setView = (patch: Parameters<typeof setViewCommand>[1]) =>
      apply(withSource(setViewCommand(view.id, patch)));
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>Image panel</h3>
        {planes > 1 && (
          <label>
            Page
            <select
              onChange={(event) => setView({ plane: Number(event.target.value) })}
              value={view.view.plane}
            >
              {planeOptions(planes, planeLabels).map((option) => (
                <option key={option.plane} value={option.plane}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {channels > 1 && (
          <label>
            Channel
            <select
              onChange={(event) =>
                setView({
                  channel: event.target.value === "all" ? null : Number(event.target.value),
                })
              }
              value={view.view.channel ?? "all"}
            >
              <option value="all">All channels</option>
              {(["Red", "Green", "Blue"] as const).slice(0, Math.min(3, channels)).map((name) => (
                <option key={name} value={["Red", "Green", "Blue"].indexOf(name)}>
                  {name} only
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Crop rotation (°)
          <input
            defaultValue={view.view.rotationDeg}
            key={`rotation-${view.id}-${view.view.rotationDeg}`}
            max="180"
            min="-180"
            onBlur={(event) => {
              const rotationDeg = Number(event.currentTarget.value);
              if (!Number.isFinite(rotationDeg) || rotationDeg === view.view.rotationDeg || !size)
                return;
              const fits = cropCornersPx({ viewport: view.view.viewport, rotationDeg }, size).every(
                ([x, y]) => x >= 0 && y >= 0 && x <= size.widthPx && y <= size.heightPx,
              );
              if (!fits) {
                setStatus(
                  "Rotating this crop would take it outside the original; make the crop smaller first.",
                );
                event.currentTarget.value = String(view.view.rotationDeg);
                return;
              }
              setView({ rotationDeg });
            }}
            step="0.1"
            type="number"
          />
        </label>
        {(["flipX", "flipY"] as const).map((key) => (
          <label className="inline" key={key}>
            <input
              checked={view.view[key]}
              onChange={(event) => setView({ [key]: event.target.checked })}
              type="checkbox"
            />
            {key === "flipX" ? "Flip horizontally" : "Flip vertically"}
          </label>
        ))}
        <DisplayFields
          counts={counts}
          display={view.view.display}
          onChange={(display) => setView({ display })}
        />
        <fieldset>
          <legend>Sample</legend>
          {(
            [
              ["target", "Target protein"],
              ["antibody", "Antibody"],
              ["dilution", "Dilution"],
              ["lot", "Lot"],
              ["supplier", "Supplier"],
              ["notes", "Notes"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                defaultValue={view.sampleInfo?.[key] ?? ""}
                key={`${view.id}-${key}-${view.sampleInfo?.[key] ?? ""}`}
                maxLength={key === "notes" ? 1000 : 200}
                onBlur={(event) => {
                  const value = event.currentTarget.value.trim();
                  if (value === (view.sampleInfo?.[key] ?? "")) return;
                  apply(
                    updateObjectCommand(view.id, (current) => {
                      if (current.type !== "image-view") return current;
                      const next = { ...current.sampleInfo, [key]: value || undefined };
                      const cleaned = Object.fromEntries(
                        Object.entries(next).filter(([, entry]) => entry),
                      );
                      const { sampleInfo: _old, ...rest } = current;
                      return Object.keys(cleaned).length > 0
                        ? { ...rest, sampleInfo: cleaned }
                        : rest;
                    }),
                  );
                }}
              />
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Add to this panel</legend>
          <Button
            disabled={!source?.calibration}
            onClick={() => {
              const barId = id("bar");
              apply(
                addScaleBarCommand({
                  id: barId,
                  targetId: view.id,
                  lengthUm: niceLength(view, source?.calibration?.umPerPxX, size),
                }),
                [barId],
              );
            }}
            title={
              source?.calibration
                ? undefined
                : "Set the original's pixel size in the original inspector first"
            }
          >
            Add scale bar
          </Button>
          <Button
            disabled={!source || source.markers.length === 0}
            onClick={() => {
              const mwId = id("mw");
              apply(addMwLabelsCommand({ id: mwId, targetId: view.id }), [mwId]);
            }}
            title={
              source?.markers.length
                ? undefined
                : "Mark ladder bands in the original inspector first"
            }
          >
            Add MW labels
          </Button>
          <label className="inline">
            Lanes
            <input
              max="48"
              min="1"
              onChange={(event) =>
                setLaneCount(Math.max(1, Math.min(48, Number(event.target.value) || 1)))
              }
              type="number"
              value={laneCount}
            />
          </label>
          <Button
            onClick={() => {
              const tableId = id("lanes");
              apply(addLaneTableCommand({ id: tableId, targetId: view.id, lanes: laneCount }), [
                tableId,
              ]);
            }}
          >
            Add lane labels
          </Button>
          <Button
            onClick={() => {
              const insetId = id("view");
              apply(
                withSource(addZoomInsetCommand({ insetId, linkId: id("zoom"), sourceId: view.id })),
                [insetId],
              );
            }}
          >
            Add zoom inset
          </Button>
          {(planes > 1 || channels >= 3) && (
            <Button
              onClick={() => {
                const entries =
                  planes > 1
                    ? Array.from({ length: Math.min(planes, 6) }, (_, plane) => ({
                        plane,
                        channel: null,
                        lut: suggestedLut(planeLabels[plane], plane),
                        id: id("view"),
                      }))
                    : [0, 1, 2].map((channel) => ({
                        plane: view.view.plane,
                        channel,
                        lut: suggestedLut(undefined, channel),
                        id: id("view"),
                      }));
                apply(
                  withSource(
                    splitChannelsCommand({
                      sourceId: view.id,
                      channels: entries,
                      mergeId: id("merge"),
                    }),
                  ),
                );
              }}
            >
              Split channels
            </Button>
          )}
        </fieldset>
        {status && <p role="status">{status}</p>}
      </section>
    );
  }

  const update = (replacement: (current: FigureObject) => FigureObject) =>
    apply(updateObjectCommand(object.id, replacement));

  if (object.type === "composite")
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>Merged channels</h3>
        {numbered(object.composite.channels).map(({ item: channel, position: index }) => (
          <fieldset key={`channel-${index}`}>
            <legend>{`Channel ${index + 1}`}</legend>
            <label className="inline">
              <input
                checked={channel.visible}
                onChange={(event) =>
                  update((current) =>
                    current.type === "composite"
                      ? {
                          ...current,
                          composite: {
                            ...current.composite,
                            channels: current.composite.channels.map((entry, other) =>
                              other === index ? { ...entry, visible: event.target.checked } : entry,
                            ),
                          },
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
              Show
            </label>
            <DisplayFields
              display={channel.display}
              label={`Channel ${index + 1}`}
              onChange={(display) =>
                update((current) =>
                  current.type === "composite"
                    ? {
                        ...current,
                        composite: {
                          ...current.composite,
                          channels: current.composite.channels.map((entry, other) =>
                            other === index ? { ...entry, display } : entry,
                          ),
                        },
                      }
                    : current,
                )
              }
            />
          </fieldset>
        ))}
        {status && <p role="status">{status}</p>}
      </section>
    );

  if (object.type === "scale-bar") {
    const bar = object.scaleBar;
    const set = (patch: Partial<typeof bar>) =>
      update((current) =>
        current.type === "scale-bar"
          ? { ...current, scaleBar: { ...current.scaleBar, ...patch } }
          : current,
      );
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>Scale bar</h3>
        <label>
          Length (µm)
          <input
            defaultValue={bar.lengthUm}
            key={`length-${bar.lengthUm}`}
            min="0.001"
            onBlur={(event) => {
              const lengthUm = Number(event.currentTarget.value);
              if (lengthUm > 0 && lengthUm !== bar.lengthUm) set({ lengthUm });
            }}
            step="any"
            type="number"
          />
        </label>
        <label>
          Label unit
          <select
            onChange={(event) => set({ displayUnit: event.target.value as typeof bar.displayUnit })}
            value={bar.displayUnit}
          >
            <option value="nm">nm</option>
            <option value="µm">µm</option>
            <option value="mm">mm</option>
          </select>
        </label>
        <label>
          Thickness (pt)
          <input
            min="0.25"
            max="20"
            onChange={(event) =>
              set({ thicknessPt: Math.max(0.25, Number(event.target.value) || 1) })
            }
            step="0.25"
            type="number"
            value={bar.thicknessPt}
          />
        </label>
        <label>
          Bar color
          <input
            onChange={(event) => set({ colorHex: event.target.value.toUpperCase() })}
            type="color"
            value={bar.colorHex.toLowerCase()}
          />
        </label>
        <label className="inline">
          <input
            checked={bar.showLabel}
            onChange={(event) => set({ showLabel: event.target.checked })}
            type="checkbox"
          />
          Show length label
        </label>
        {status && <p role="status">{status}</p>}
      </section>
    );
  }

  if (object.type === "lane-table") {
    const table = object.laneTable;
    const set = (patch: Partial<typeof table>) =>
      update((current) =>
        current.type === "lane-table"
          ? { ...current, laneTable: { ...current.laneTable, ...patch } }
          : current,
      );
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>Lane labels</h3>
        <label>
          Rows (one per line; cells separated by |, *2 spans two lanes, _ underlines)
          <textarea
            defaultValue={table.rows.map((row) => formatLaneRow(row.cells)).join("\n")}
            key={JSON.stringify(table.rows)}
            onBlur={(event) => {
              const rows = event.currentTarget.value
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => ({ cells: parseLaneRow(line) }));
              if (rows.length > 0) set({ rows });
            }}
            rows={4}
          />
        </label>
        <label>
          Lanes
          <input
            max="48"
            min="1"
            onChange={(event) => {
              const lanes = Math.max(1, Math.min(48, Number(event.target.value) || 1));
              set({ lanes, laneCenters: null });
            }}
            type="number"
            value={table.lanes}
          />
        </label>
        <label>
          Placement
          <select
            onChange={(event) => set({ placement: event.target.value as "above" | "below" })}
            value={table.placement}
          >
            <option value="above">Above the panel</option>
            <option value="below">Below the panel</option>
          </select>
        </label>
        <label>
          Font size (pt)
          <input
            min="2"
            max="72"
            onChange={(event) => set({ fontSizePt: Math.max(2, Number(event.target.value) || 7) })}
            step="0.5"
            type="number"
            value={table.fontSizePt}
          />
        </label>
        {status && <p role="status">{status}</p>}
      </section>
    );
  }

  if (object.type === "mw-labels") {
    const labels = object.mwLabels;
    const set = (patch: Partial<typeof labels>) =>
      update((current) =>
        current.type === "mw-labels"
          ? { ...current, mwLabels: { ...current.mwLabels, ...patch } }
          : current,
      );
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>MW labels</h3>
        <label>
          Side
          <select
            onChange={(event) => set({ side: event.target.value as "left" | "right" })}
            value={labels.side}
          >
            <option value="left">Left of the panel</option>
            <option value="right">Right of the panel</option>
          </select>
        </label>
        <label>
          Font size (pt)
          <input
            min="2"
            max="72"
            onChange={(event) => set({ fontSizePt: Math.max(2, Number(event.target.value) || 7) })}
            step="0.5"
            type="number"
            value={labels.fontSizePt}
          />
        </label>
        <label className="inline">
          <input
            checked={labels.showUnit}
            onChange={(event) => set({ showUnit: event.target.checked })}
            type="checkbox"
          />
          Show kDa
        </label>
        {status && <p role="status">{status}</p>}
      </section>
    );
  }

  if (object.type === "zoom-link") {
    const link = object.zoomLink;
    const set = (patch: Partial<typeof link>) =>
      update((current) =>
        current.type === "zoom-link"
          ? { ...current, zoomLink: { ...current.zoomLink, ...patch } }
          : current,
      );
    return (
      <section aria-label="Panel inspector" className="figure-tools-panel">
        <h3>Zoom outline</h3>
        <StrokeFields onChange={(stroke) => set({ stroke })} stroke={link.stroke} />
        <label className="inline">
          <input
            checked={link.connectors}
            onChange={(event) => set({ connectors: event.target.checked })}
            type="checkbox"
          />
          Connector lines
        </label>
        {status && <p role="status">{status}</p>}
      </section>
    );
  }
  return null;
}

/** Pairs items with their positions, for lists whose entries have no identity of their own. */
function numbered<T>(items: ReadonlyArray<T>): { item: T; position: number }[] {
  const result: { item: T; position: number }[] = [];
  for (const [position, item] of items.entries()) result.push({ item, position });
  return result;
}

/** A round scale-bar length near a fifth of the panel's width. */
function niceLength(
  view: ImageViewObjectV3,
  umPerPx: number | undefined,
  size: { widthPx: number; heightPx: number } | undefined,
): number {
  if (!umPerPx || !size) return 10;
  const panelUm = view.view.viewport.width * size.widthPx * umPerPx;
  const target = panelUm / 5;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((value) => value * magnitude >= target) ?? 10;
  return step * magnitude;
}
