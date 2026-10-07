import type { ImageViewObjectV3 } from "@figlab/figure-schema";
import {
  documentSourceSizes,
  isLoadingControl,
  normalizeToControl,
  type QuantificationResult,
  quantificationCsv,
  quantifyLanes,
  rawViewSamples,
} from "@figlab/image-processing";
import { Button, Section } from "@figlab/ui";
import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState } from "../editor/session-store";

const panelName = (view: ImageViewObjectV3, labels: ReadonlyMap<string, string>) =>
  view.sampleInfo?.target || (labels.get(view.id) ? `Panel ${labels.get(view.id)}` : "Image panel");

/**
 * Band densitometry for the selected blot panel: integrated density per lane from original
 * samples, optional normalization to a loading-control panel, and a CSV with the checks.
 */
export function QuantifyPanel({
  session,
  rasterSources,
  download,
}: {
  session: StoreApi<EditorSessionState>;
  rasterSources: BrowserRasterRepository;
  download: (blob: Blob, filename: string) => void;
}) {
  const state = useStore(session);
  const [darkBands, setDarkBands] = useState(true);
  const [controlId, setControlId] = useState("");
  const [referenceLane, setReferenceLane] = useState(1);
  const [result, setResult] = useState<QuantificationResult>();
  const [status, setStatus] = useState("");
  const views = state.document.objects.filter(
    (object): object is ImageViewObjectV3 => object.type === "image-view",
  );
  const target = views.find(
    (view) => state.selectedIds.length === 1 && state.selectedIds[0] === view.id,
  );
  if (!target) return null;
  const labels = new Map(
    state.document.objects.flatMap((object) =>
      object.type === "text" && object.panelLabel
        ? [[object.panelLabel.targetObjectId, object.text.content] as const]
        : [],
    ),
  );
  const tableFor = (view: ImageViewObjectV3) =>
    state.document.objects.find(
      (object): object is Extract<typeof object, { type: "lane-table" }> =>
        object.type === "lane-table" && object.laneTable.targetObjectId === view.id,
    );
  const table = tableFor(target);
  const lanes = table?.laneTable.lanes ?? 0;
  const laneLabels = (() => {
    const row = table?.laneTable.rows.at(-1);
    if (!row) return [];
    const labelsByLane: string[] = [];
    for (const cell of row.cells)
      for (let span = 0; span < cell.span; span += 1) labelsByLane.push(cell.text);
    return labelsByLane;
  })();
  // Default to the panel recorded as the loading control, when it has matching lanes.
  const control =
    views.find((view) => view.id === controlId) ??
    (controlId === ""
      ? views.find(
          (view) =>
            view.id !== target.id &&
            isLoadingControl(view.sampleInfo) &&
            tableFor(view)?.laneTable.lanes === lanes,
        )
      : undefined);

  return (
    <Section className="figure-tools-panel" label="Quantification" title="Band quantification">
      {lanes === 0 ? (
        <p>Add lane labels to this panel first; quantification measures the labelled lanes.</p>
      ) : (
        <>
          <p>{`${lanes} lanes from the lane labels; measured on original samples, ignoring display settings.`}</p>
          <label className="inline">
            <input
              checked={darkBands}
              onChange={(event) => setDarkBands(event.target.checked)}
              type="checkbox"
            />
            Dark bands on a light background
          </label>
          <label>
            Loading control
            <select
              onChange={(event) => setControlId(event.target.value)}
              value={control?.id ?? "none"}
            >
              <option value="none">None</option>
              {views
                .filter(
                  (view) => view.id !== target.id && tableFor(view)?.laneTable.lanes === lanes,
                )
                .map((view) => (
                  <option key={view.id} value={view.id}>
                    {panelName(view, labels)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Reference lane
            <input
              max={lanes}
              min="1"
              onChange={(event) =>
                setReferenceLane(Math.max(1, Math.min(lanes, Number(event.target.value) || 1)))
              }
              type="number"
              value={referenceLane}
            />
          </label>
          <Button
            onClick={async () => {
              setStatus("Measuring lanes on original samples…");
              try {
                const sizes = documentSourceSizes(state.document, rasterSources);
                const measure = async (view: ImageViewObjectV3) => {
                  const viewTable = tableFor(view);
                  return quantifyLanes(
                    await rawViewSamples(view, rasterSources, sizes),
                    {
                      lanes,
                      laneCenters: viewTable?.laneTable.laneCenters ?? null,
                      darkBands,
                    },
                    laneLabels,
                  );
                };
                setResult(
                  normalizeToControl(
                    await measure(target),
                    control ? await measure(control) : undefined,
                    referenceLane,
                  ),
                );
                setStatus("");
              } catch (error) {
                setStatus(error instanceof Error ? error.message : "Quantification failed.");
              }
            }}
          >
            Quantify bands
          </Button>
        </>
      )}
      {status && <p role="status">{status}</p>}
      {result && (
        <>
          <ul className="history-list" aria-label="Quantification warnings">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <table aria-label="Lane densities" className="quantification-table">
            <thead>
              <tr>
                <th>Lane</th>
                <th>Net density</th>
                <th>{control ? "Normalized" : "—"}</th>
                <th>Relative</th>
              </tr>
            </thead>
            <tbody>
              {result.lanes.map((lane) => (
                <tr key={lane.lane}>
                  <td>{lane.label}</td>
                  <td>{lane.net.toFixed(2)}</td>
                  <td>{lane.normalized === undefined ? "" : lane.normalized.toFixed(3)}</td>
                  <td>{lane.relative === undefined ? "" : lane.relative.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <svg
            aria-label="Relative density by lane"
            className="quantification-chart"
            role="img"
            viewBox={`0 0 ${result.lanes.length * 10} 50`}
          >
            <path
              d={(() => {
                const peak = Math.max(
                  1e-9,
                  ...result.lanes.map((lane) => lane.relative ?? lane.net),
                );
                return result.lanes
                  .map((lane, position) => {
                    const height = ((lane.relative ?? lane.net) / peak) * 48;
                    return `M${position * 10 + 2} 50V${50 - height}h6V50Z`;
                  })
                  .join("");
              })()}
            />
          </svg>
          <Button
            onClick={() =>
              download(
                new Blob(
                  [
                    quantificationCsv(result, {
                      target: panelName(target, labels),
                      ...(control ? { control: panelName(control, labels) } : {}),
                    }),
                  ],
                  { type: "text/csv" },
                ),
                "quantification.csv",
              )
            }
          >
            Download quantification CSV
          </Button>
        </>
      )}
    </Section>
  );
}
