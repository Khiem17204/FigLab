import type { AssetDescriptor } from "@figlab/api-contract";
import type { NormalizedRect } from "@figlab/figure-schema";
import { useEffect, useRef, useState } from "react";

import { imageContainRect, normalizedPointInImage, type ScreenRect } from "../editor/geometry";
import type { Point } from "../editor/session-store";
import { rectFromPoints, viewportStyle } from "./dom-helpers";

export function OriginalInspector({
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
