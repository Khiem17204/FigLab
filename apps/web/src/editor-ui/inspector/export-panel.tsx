import type { FigureDocumentV1 } from "@figlab/figure-schema";
import { Button } from "@figlab/ui";
import { useState } from "react";

export function ExportControls({
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
