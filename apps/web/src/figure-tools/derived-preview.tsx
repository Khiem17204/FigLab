import type { AssetDescriptor } from "@figlab/api-contract";
import { useQuery } from "@tanstack/react-query";

import type { FigLabClient } from "../api/client";

type DerivedPreview = { maxEdge: number; widthPx: number; heightPx: number; stretched: boolean };

/** The smallest derived preview at least `minEdge` on its long side, if the worker made one. */
export function derivedPreviewFor(
  asset: AssetDescriptor,
  minEdge: number,
): DerivedPreview | undefined {
  const previews = Array.isArray(asset.metadata.previews)
    ? (asset.metadata.previews as DerivedPreview[])
    : [];
  return [...previews]
    .sort((left, right) => left.maxEdge - right.maxEdge)
    .find((preview) => preview.maxEdge >= minEdge);
}

/**
 * A derived, downsampled preview shown while the original downloads. Display only: crops,
 * checks, quantification, and export always use the original.
 */
export function DerivedThumbnail({
  client,
  asset,
  minEdge = 256,
}: {
  client: FigLabClient;
  asset: AssetDescriptor;
  minEdge?: number;
}) {
  const preview = derivedPreviewFor(asset, minEdge);
  const url = useQuery({
    queryKey: ["preview-url", asset.id, preview?.maxEdge],
    queryFn: () => client.previewUrl(asset.id, preview?.maxEdge ?? minEdge),
    enabled: Boolean(preview),
    staleTime: 5 * 60_000,
  });
  if (!preview || !url.data) return null;
  return (
    <figure className="derived-preview">
      <img
        alt={`Derived preview of ${asset.filename}`}
        height={preview.heightPx}
        src={url.data}
        width={preview.widthPx}
      />
      <figcaption>
        {preview.stretched ? "Derived preview (contrast-stretched)" : "Derived preview"}
      </figcaption>
    </figure>
  );
}
