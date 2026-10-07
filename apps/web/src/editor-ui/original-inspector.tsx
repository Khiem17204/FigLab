import type { AssetDescriptor } from "@figlab/api-contract";
import type { NormalizedRect } from "@figlab/figure-schema";
import { ChevronDownIcon, IconButton, Mascot } from "@figlab/ui";
import { useEffect, useRef, useState } from "react";

import { imageContainRect, normalizedPointInImage, type ScreenRect } from "../editor/geometry";
import type { Point } from "../editor/session-store";
import { rectFromPoints, viewportStyle } from "./dom-helpers";

export function OriginalInspector({
  asset,
  previewUrl,
  highlightedViewport,
  onCrop,
  collapsed = false,
  onCollapsedChange,
}: {
  asset?: AssetDescriptor;
  previewUrl?: string;
  highlightedViewport?: NormalizedRect;
  onCrop: (viewport: NormalizedRect) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [draft, setDraft] = useState<{ start: Point; end: Point }>();
  const draftRef = useRef<{ start: Point; end: Point } | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const [imageRect, setImageRect] = useState<ScreenRect>();
  useEffect(() => {
    const target = host.current;
    if (!target || !asset || collapsed) return;
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
  }, [asset, collapsed]);
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
    <section
      aria-label="Original"
      className="original-inspector"
      data-collapsed={collapsed ? "" : undefined}
    >
      <header className="original-header">
        <p className="eyebrow">Original</p>
        {asset ? (
          <>
            <strong className="original-name">{asset.filename}</strong>
            <span className="original-facts">
              {asset.widthPx} × {asset.heightPx} px · {asset.bitDepth}-bit{" "}
              {asset.channelCount === 1
                ? "grey"
                : asset.channelCount === 3
                  ? "RGB"
                  : `${asset.channelCount} ch`}
            </span>
          </>
        ) : (
          <strong className="original-name muted">No original selected</strong>
        )}
        <span className="original-hint">{asset ? "Drag to crop a new panel" : ""}</span>
        <IconButton
          aria-expanded={!collapsed}
          className="original-toggle"
          icon={<ChevronDownIcon size={16} />}
          label={collapsed ? "Show original" : "Hide original"}
          onClick={() => onCollapsedChange?.(!collapsed)}
          size="sm"
          tooltipAlign="end"
        />
      </header>
      {!collapsed && (
        <div
          className="source-canvas"
          data-empty={previewUrl && asset ? undefined : ""}
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
            <span className="source-empty">
              <Mascot mood="sleepy" size={44} />
              Upload an original, or pick one from the library, to start cropping.
            </span>
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
      )}
    </section>
  );
}
